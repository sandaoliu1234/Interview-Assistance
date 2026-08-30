'use strict';

/**
 * landing/db-layer.js —— SQLite 数据访问层（DAL）
 *
 * 职责：
 *   封装所有数据库 CRUD 操作，对外提供与原 JSON 函数签名一致的接口，
 *   使 shared.js 可以无缝切换到 SQLite 后端。
 *
 * 设计原则：
 *   - 函数名与 shared.js 原有函数保持一致，降低调用方改动
 *   - 写操作使用 better-sqlite3 事务（db.transaction），保证原子性
 *   - 读操作使用预编译语句（db.prepare），提高性能
 *   - 时间戳统一用毫秒 INTEGER，与原 JSON 数据兼容
 *
 * 使用方式：
 *   const DAL = require('./db-layer.js');
 *   const balance = DAL.readBalance(accountId);
 *   await DAL.rechargeCredits({ accountId, credits, ... });
 */

const { db } = require('./db.js');
const crypto = require('crypto');

// ============================================================
// 预编译 SQL 语句（提升性能：一次编译多次执行）
// ============================================================

// ---- accounts 表 ----
const stmtGetAccountById = db.prepare(`
  SELECT account_id, normalized_email, display_email, display_name, avatar, is_admin,
         is_disabled, disabled_reason,
         pwd_algo, pwd_iter, pwd_salt, pwd_hash, reset_code, reset_expire_at, ext_id,
         created_at, last_login_ts
  FROM accounts WHERE account_id = ?
`);

const stmtGetAccountByEmail = db.prepare(`
  SELECT account_id, normalized_email, display_email, display_name, avatar, is_admin,
         pwd_algo, pwd_iter, pwd_salt, pwd_hash, reset_code, reset_expire_at, ext_id,
         created_at, last_login_ts
  FROM accounts WHERE normalized_email = ?
`);

const stmtAllAccounts = db.prepare(`
  SELECT account_id, normalized_email, display_email, display_name, avatar, is_admin,
         pwd_algo, pwd_iter, pwd_salt, pwd_hash, reset_code, reset_expire_at, ext_id,
         created_at, last_login_ts
  FROM accounts ORDER BY created_at DESC
`);

const stmtInsertAccount = db.prepare(`
  INSERT OR IGNORE INTO accounts
    (account_id, normalized_email, display_email, display_name, avatar, is_admin,
     pwd_algo, pwd_iter, pwd_salt, pwd_hash, reset_code, reset_expire_at, ext_id,
     created_at, last_login_ts)
  VALUES
    (@accountId, @normalizedEmail, @displayEmail, @displayName, @avatar, @isAdmin,
     @pwdAlgo, @pwdIter, @pwdSalt, @pwdHash, @resetCode, @resetExpireAt, @extId,
     @createdAt, @lastLoginTs)
`);

const stmtUpdateLastLogin = db.prepare(`
  UPDATE accounts SET last_login_ts = ? WHERE account_id = ?
`);

// ---- credit_balances 表 ----
const stmtGetBalance = db.prepare(`
  SELECT account_id, balance, total_recharged, total_consumed, updated_at
  FROM credit_balances WHERE account_id = ?
`);

const stmtGetAllBalances = db.prepare(`
  SELECT account_id, balance, total_recharged, total_consumed, updated_at
  FROM credit_balances
`);

const stmtUpsertBalance = db.prepare(`
  INSERT INTO credit_balances (account_id, balance, total_recharged, total_consumed, updated_at)
  VALUES (@accountId, @balance, @totalRecharged, @totalConsumed, @updatedAt)
  ON CONFLICT(account_id) DO UPDATE SET
    balance = excluded.balance,
    total_recharged = excluded.total_recharged,
    total_consumed = excluded.total_consumed,
    updated_at = excluded.updated_at
`);

// 原子扣减余额（WHERE balance >= ? 防止并发超扣）
const stmtDeductBalance = db.prepare(`
  UPDATE credit_balances
  SET balance = balance - ?,
      total_consumed = total_consumed + ?,
      updated_at = ?
  WHERE account_id = ? AND balance >= ?
`);

// 原子增加余额
const stmtAddBalance = db.prepare(`
  UPDATE credit_balances
  SET balance = balance + ?,
      total_recharged = total_recharged + ?,
      updated_at = ?
  WHERE account_id = ?
`);

const stmtInsertBalance = db.prepare(`
  INSERT OR IGNORE INTO credit_balances (account_id, balance, total_recharged, total_consumed, updated_at)
  VALUES (?, 0, 0, 0, 0)
`);

// ---- orders 表 ----
const stmtGetOrder = db.prepare(`
  SELECT order_id, account_id, package_id, package_name, credits, bonus,
         price_cents, status, channel, created_at, paid_at, cancelled_at, meta
  FROM orders WHERE order_id = ?
`);

const stmtUpsertOrder = db.prepare(`
  INSERT INTO orders
    (order_id, account_id, package_id, package_name, credits, bonus,
     price_cents, status, channel, created_at, paid_at, cancelled_at, meta)
  VALUES
    (@orderId, @accountId, @packageId, @packageName, @credits, @bonus,
     @priceCents, @status, @channel, @createdAt, @paidAt, @cancelledAt, @meta)
  ON CONFLICT(order_id) DO UPDATE SET
    package_id = excluded.package_id,
    package_name = excluded.package_name,
    credits = excluded.credits,
    bonus = excluded.bonus,
    price_cents = excluded.price_cents,
    status = excluded.status,
    channel = excluded.channel,
    paid_at = excluded.paid_at,
    cancelled_at = excluded.cancelled_at,
    meta = excluded.meta
`);

const stmtOrdersByAccount = db.prepare(`
  SELECT order_id, account_id, package_id, package_name, credits, bonus,
         price_cents, status, channel, created_at, paid_at, cancelled_at, meta
  FROM orders WHERE account_id = ?
  ORDER BY created_at DESC
  LIMIT ?
`);

const stmtAllOrders = db.prepare(`
  SELECT order_id, account_id, package_id, package_name, credits, bonus,
         price_cents, status, channel, created_at, paid_at, cancelled_at, meta
  FROM orders
`);

// 支付时原子更新订单状态（WHERE status='pending' 防止并发重复支付）
const stmtPayOrder = db.prepare(`
  UPDATE orders SET status = 'paid', channel = ?, paid_at = ?
  WHERE order_id = ? AND status = 'pending'
`);

// ---- credit_flows 表 ----
const stmtInsertFlow = db.prepare(`
  INSERT OR IGNORE INTO credit_flows
    (flow_id, account_id, type, biz_type, biz_id, amount, delta,
     balance_after, description, meta, month_key,
     operator_account_id, operator_email, created_at)
  VALUES
    (@flowId, @accountId, @type, @bizType, @bizId, @amount, @delta,
     @balanceAfter, @desc, @meta, @monthKey,
     @operatorAccountId, @operatorEmail, @createdAt)
`);

const stmtFlowsByAccount = db.prepare(`
  SELECT flow_id, account_id, type, biz_type, biz_id, amount, delta,
         balance_after, description, meta, month_key,
         operator_account_id, operator_email, created_at
  FROM credit_flows WHERE account_id = ?
  ORDER BY created_at DESC
  LIMIT ?
`);

const stmtFlowsByMonth = db.prepare(`
  SELECT flow_id, account_id, type, biz_type, biz_id, amount, delta,
         balance_after, description, meta, month_key,
         operator_account_id, operator_email, created_at
  FROM credit_flows WHERE month_key = ?
  ORDER BY created_at ASC
`);

/** 统计自指定时间戳以来的流水总数（用于总览看板最近30天流水计数） */
const stmtCountFlowsSince = db.prepare(`
  SELECT COUNT(*) AS cnt FROM credit_flows WHERE created_at >= ?
`);

// ---- checkin_records 表 ----

/** 查询某账号今日是否已签到（按日期精确匹配） */
const stmtGetTodayCheckin = db.prepare(`
  SELECT record_id, checkin_date, checkin_day_index, reward_credits, flow_id, created_at
  FROM checkin_records WHERE account_id = ? AND checkin_date = ?
`);

/** 查询某账号最近一次签到记录（按日期倒序，用于计算连续天数） */
const stmtGetLatestCheckin = db.prepare(`
  SELECT record_id, checkin_date, checkin_day_index, reward_credits, flow_id, created_at
  FROM checkin_records WHERE account_id = ?
  ORDER BY checkin_date DESC LIMIT 1
`);

/** 查询某账号最近 7 次签到记录（用于展示连续签到进度） */
const stmtGetRecentCheckins = db.prepare(`
  SELECT record_id, checkin_date, checkin_day_index, reward_credits, created_at
  FROM checkin_records WHERE account_id = ?
  ORDER BY checkin_date DESC LIMIT 7
`);

/** 插入签到记录（UNIQUE 约束保证每天只能签到一次） */
const stmtInsertCheckin = db.prepare(`
  INSERT INTO checkin_records
    (record_id, account_id, checkin_date, checkin_day_index, reward_credits, flow_id, created_at)
  VALUES
    (@recordId, @accountId, @checkinDate, @dayIndex, @reward, @flowId, @createdAt)
`);

/** 更新签到记录关联的流水ID（签到事务内先插入记录，写完流水后回填 flow_id） */
const stmtUpdateCheckinFlow = db.prepare(`
  UPDATE checkin_records SET flow_id = ? WHERE record_id = ?
`);

/** 签到奖励：只增加 balance，不增加 total_recharged（区别于充值） */
const stmtAddRewardBalance = db.prepare(`
  UPDATE credit_balances SET balance = balance + ?, updated_at = ? WHERE account_id = ?
`);

// ---- invite_records 表 + accounts.ext_id（邀请码） ----

/** 查询账号的邀请码（存储在 accounts.ext_id 字段） */
const stmtGetInviteCode = db.prepare(`
  SELECT ext_id AS invite_code FROM accounts WHERE account_id = ?
`);

/** 设置账号的邀请码（首次生成时写入 ext_id） */
const stmtSetInviteCode = db.prepare(`
  UPDATE accounts SET ext_id = ? WHERE account_id = ? AND (ext_id IS NULL OR ext_id = '')
`);

/** 按邀请码查询邀请人账号（注册时校验邀请码有效性） */
const stmtGetAccountByInviteCode = db.prepare(`
  SELECT account_id, display_email, display_name FROM accounts WHERE ext_id = ?
`);

/** 查询被邀请人是否已有邀请记录（一个人只能被邀请一次） */
const stmtGetInviteByInvitee = db.prepare(`
  SELECT record_id, inviter_account_id, invitee_reward, created_at
  FROM invite_records WHERE invitee_account_id = ?
`);

/** 插入邀请记录（UNIQUE(invitee_account_id) 保证一个人只能被邀请一次） */
const stmtInsertInviteRecord = db.prepare(`
  INSERT INTO invite_records
    (record_id, inviter_account_id, invitee_account_id, invite_code,
     inviter_reward, invitee_reward, inviter_flow_id, invitee_flow_id, created_at)
  VALUES
    (@recordId, @inviterId, @inviteeId, @inviteCode,
     @inviterReward, @inviteeReward, @inviterFlowId, @inviteeFlowId, @createdAt)
`);

/** 查询邀请人的所有邀请记录（按时间倒序，用于控制台展示） */
const stmtListInvitesByInviter = db.prepare(`
  SELECT ir.record_id, ir.invitee_account_id, ir.invite_code,
         ir.inviter_reward, ir.invitee_reward, ir.created_at,
         a.display_email AS invitee_email, a.display_name AS invitee_name
  FROM invite_records ir
  LEFT JOIN accounts a ON a.account_id = ir.invitee_account_id
  WHERE ir.inviter_account_id = ?
  ORDER BY ir.created_at DESC
  LIMIT ? OFFSET ?
`);

/** 统计邀请人已邀请总人数 + 总奖励积分 */
const stmtInviteStats = db.prepare(`
  SELECT COUNT(*) AS total_invited, COALESCE(SUM(inviter_reward), 0) AS total_reward
  FROM invite_records WHERE inviter_account_id = ?
`);

// ---- 管理端查询：账号列表、订单列表、套餐 CRUD ----

/** 管理端：查询所有账号（支持关键词搜索 + 分页） */
const stmtListAllAccounts = db.prepare(`
  SELECT a.account_id, a.display_email, a.display_name, a.avatar, a.is_admin,
         a.is_disabled, a.disabled_reason, a.created_at, a.last_login_ts,
         a.ext_id AS invite_code,
         COALESCE(b.balance, 0) AS balance,
         COALESCE(b.total_recharged, 0) AS total_recharged,
         COALESCE(b.total_consumed, 0) AS total_consumed
  FROM accounts a
  LEFT JOIN credit_balances b ON b.account_id = a.account_id
  WHERE a.normalized_email LIKE ? OR a.display_name LIKE ? OR a.account_id LIKE ?
  ORDER BY a.created_at DESC
  LIMIT ? OFFSET ?
`);

/** 管理端：统计账号总数（支持关键词搜索） */
const stmtCountAllAccounts = db.prepare(`
  SELECT COUNT(*) AS cnt FROM accounts
  WHERE normalized_email LIKE ? OR display_name LIKE ? OR account_id LIKE ?
`);

/** 管理端：查询所有订单（支持分页，按时间倒序）
 *  注：orders 表没有 paid_credits 列，已付积分 = 套餐基础积分(credits) + 赠送积分(bonus)，
 *  用 (o.credits + o.bonus) AS paid_credits 计算出来，保持与前端字段名一致
 */
const stmtListAllOrders = db.prepare(`
  SELECT o.order_id, o.account_id, o.package_id, o.package_name,
         o.price_cents, (o.credits + o.bonus) AS paid_credits,
         o.status, o.created_at, o.paid_at,
         a.display_email, a.display_name
  FROM orders o
  LEFT JOIN accounts a ON a.account_id = o.account_id
  ORDER BY o.created_at DESC
  LIMIT ? OFFSET ?
`);

/** 管理端：统计订单总数 */
const stmtCountAllOrders = db.prepare(`SELECT COUNT(*) AS cnt FROM orders`);

/** 管理端：查询所有套餐（含下架的，按 sort_order 排序） */
const stmtListAllPackages = db.prepare(`
  SELECT * FROM packages ORDER BY sort_order ASC, created_at ASC
`);

/** 管理端：新增套餐 */
const stmtInsertPackage = db.prepare(`
  INSERT INTO packages (package_id, title, credits, bonus_credits, price_cents,
                         tag, description, is_active, sort_order, created_at, updated_at)
  VALUES (@packageId, @title, @credits, @bonusCredits, @priceCents,
          @tag, @description, @isActive, @sortOrder, @createdAt, @updatedAt)
`);

/** 管理端：更新套餐 */
const stmtUpdatePackage = db.prepare(`
  UPDATE packages SET
    title = @title, credits = @credits, bonus_credits = @bonusCredits,
    price_cents = @priceCents, tag = @tag, description = @description,
    is_active = @isActive, sort_order = @sortOrder, updated_at = @updatedAt
  WHERE package_id = @packageId
`);

/** 管理端：删除套餐 */
const stmtDeletePackage = db.prepare(`DELETE FROM packages WHERE package_id = ?`);

// ---- redeem_codes 表 ----
/** 按兑换码查询（兑换时使用，带行锁语义：UPDATE 时再校验 status） */
const stmtGetRedeemCode = db.prepare(`
  SELECT code, credits, batch_id, status, created_by, created_at,
         used_by, used_at, expire_at, note
  FROM redeem_codes WHERE code = ?
`);

/** 用户兑换：原子地将 unused 改为 used（WHERE status='unused' 防并发重复兑换） */
const stmtUseRedeemCode = db.prepare(`
  UPDATE redeem_codes
  SET status = 'used', used_by = ?, used_at = ?
  WHERE code = ? AND status = 'unused'
`);

/** 批量插入兑换码（INSERT OR IGNORE 防止主键冲突） */
const stmtInsertRedeemCode = db.prepare(`
  INSERT OR IGNORE INTO redeem_codes
    (code, credits, batch_id, status, created_by, created_at, expire_at, note)
  VALUES
    (@code, @credits, @batchId, 'unused', @createdBy, @createdAt, @expireAt, @note)
`);

/** 管理端：查询所有兑换码（支持状态/批次筛选 + 分页） */
const stmtListAllRedeemCodes = db.prepare(`
  SELECT r.code, r.credits, r.batch_id, r.status, r.created_by, r.created_at,
         r.used_by, r.used_at, r.expire_at, r.note,
         a.display_email AS used_by_email
  FROM redeem_codes r
  LEFT JOIN accounts a ON a.account_id = r.used_by
  WHERE (:status = '' OR r.status = :status)
    AND (:batchId = '' OR r.batch_id = :batchId)
  ORDER BY r.created_at DESC
  LIMIT :limit OFFSET :offset
`);

/** 管理端：统计兑换码数量（支持状态/批次筛选） */
const stmtCountAllRedeemCodes = db.prepare(`
  SELECT COUNT(*) AS cnt FROM redeem_codes
  WHERE (:status = '' OR status = :status)
    AND (:batchId = '' OR batch_id = :batchId)
`);

/** 管理端：删除兑换码（仅允许删除未使用的） */
const stmtDeleteRedeemCode = db.prepare(`
  DELETE FROM redeem_codes WHERE code = ? AND status = 'unused'
`);

/** 用户端：查询我已兑换的记录 */
const stmtListMyRedeemedCodes = db.prepare(`
  SELECT code, credits, batch_id, used_at, note
  FROM redeem_codes
  WHERE used_by = ?
  ORDER BY used_at DESC
  LIMIT ? OFFSET ?
`);

/** 用户端：统计我已兑换的数量 */
const stmtCountMyRedeemedCodes = db.prepare(`
  SELECT COUNT(*) AS cnt FROM redeem_codes WHERE used_by = ?
`);

/** 管理端：兑换码状态统计（unused/used/expired 数量） */
const stmtRedeemStatusStats = db.prepare(`
  SELECT status, COUNT(*) AS cnt, COALESCE(SUM(credits), 0) AS total_credits
  FROM redeem_codes GROUP BY status
`);

// ---- news 表 ----
/** 管理端：新增公告 */
const stmtInsertNews = db.prepare(`
  INSERT INTO news (news_id, title, content, category, is_pinned, is_published,
                    view_count, created_by, created_at, updated_at, published_at)
  VALUES
    (@newsId, @title, @content, @category, @isPinned, @isPublished,
     0, @createdBy, @createdAt, @updatedAt, @publishedAt)
`);

/** 管理端：更新公告 */
const stmtUpdateNews = db.prepare(`
  UPDATE news SET
    title = @title, content = @content, category = @category,
    is_pinned = @isPinned, is_published = @isPublished,
    updated_at = @updatedAt, published_at = @publishedAt
  WHERE news_id = @newsId
`);

/** 管理端：删除公告 */
const stmtDeleteNews = db.prepare(`DELETE FROM news WHERE news_id = ?`);

/** 管理端：查询所有公告（含草稿，支持分页） */
const stmtListAllNews = db.prepare(`
  SELECT n.news_id, n.title, n.content, n.category, n.is_pinned, n.is_published,
         n.view_count, n.created_by, n.created_at, n.updated_at, n.published_at,
         a.display_email AS created_by_email
  FROM news n
  LEFT JOIN accounts a ON a.account_id = n.created_by
  ORDER BY n.is_pinned DESC, n.created_at DESC
  LIMIT ? OFFSET ?
`);

/** 管理端：统计公告总数 */
const stmtCountAllNews = db.prepare(`SELECT COUNT(*) AS cnt FROM news`);

/** 用户端：查询已发布公告（置顶优先 + 按发布时间倒序） */
const stmtListPublishedNews = db.prepare(`
  SELECT news_id, title, content, category, is_pinned, view_count, published_at
  FROM news
  WHERE is_published = 1
  ORDER BY is_pinned DESC, published_at DESC
  LIMIT ? OFFSET ?
`);

/** 用户端：统计已发布公告总数 */
const stmtCountPublishedNews = db.prepare(`
  SELECT COUNT(*) AS cnt FROM news WHERE is_published = 1
`);

/** 用户端：查询单条公告详情（同时用于浏览详情） */
const stmtGetNewsById = db.prepare(`
  SELECT news_id, title, content, category, is_pinned, is_published,
         view_count, created_at, published_at
  FROM news WHERE news_id = ?
`);

/** 用户端：浏览数 +1（仅在已发布时） */
const stmtIncrNewsView = db.prepare(`
  UPDATE news SET view_count = view_count + 1
  WHERE news_id = ? AND is_published = 1
`);

/** 管理端：禁用/启用账号 */
const stmtToggleAccountDisabled = db.prepare(`
  UPDATE accounts SET is_disabled = ?, disabled_reason = ? WHERE account_id = ?
`);

/** 管理端：设置管理员 */
const stmtSetAdmin = db.prepare(`
  UPDATE accounts SET is_admin = ? WHERE account_id = ?
`);

/** 管理端：重置密码（直接设置新密码哈希） */
const stmtResetPassword = db.prepare(`
  UPDATE accounts SET pwd_salt = ?, pwd_hash = ? WHERE account_id = ?
`);

// ---- web_sessions 表 ----
const stmtGetSession = db.prepare(`
  SELECT sid, account_id, email, display_name, avatar, is_admin,
         created_at, expire_at
  FROM web_sessions WHERE sid = ?
`);

const stmtInsertSession = db.prepare(`
  INSERT OR REPLACE INTO web_sessions
    (sid, account_id, email, display_name, avatar, is_admin,
     created_at, expire_at)
  VALUES
    (@sid, @accountId, @email, @displayName, @avatar, @isAdmin,
     @createdAt, @expireAt)
`);

const stmtDeleteSession = db.prepare(`DELETE FROM web_sessions WHERE sid = ?`);

const stmtDeleteExpiredSessions = db.prepare(
  `DELETE FROM web_sessions WHERE expire_at < ?`
);

const stmtCountActiveSessions = db.prepare(
  `SELECT COUNT(*) AS cnt FROM web_sessions WHERE expire_at >= ?`
);

// ---- packages 表 ----
const stmtAllPackages = db.prepare(`
  SELECT package_id, title, credits, bonus_credits, price_cents,
         tag, description, is_active, sort_order, created_at, updated_at
  FROM packages WHERE is_active = 1
  ORDER BY sort_order ASC
`);

// ============================================================
// 工具函数
// ============================================================

/**
 * 根据时间戳返回所属月份 key（YYYY-MM）
 * @param {number} ts 毫秒时间戳
 * @returns {string} 月份标识，如 '2026-08'
 */
function _monthKey(ts) {
  const d = new Date(ts || Date.now());
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/**
 * 计算月份闭区间内所有月份 key
 * @param {string} fromMonth 起始月 'YYYY-MM'
 * @param {string} toMonth 结束月 'YYYY-MM'
 * @returns {string[]} 月份 key 数组
 */
function _monthRangeKeys(fromMonth, toMonth) {
  const to = toMonth || _monthKey();
  if (!fromMonth) return [to];
  const keys = [];
  const [fy, fm] = fromMonth.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  let y = fy, m = fm;
  while ((y < ty) || (y === ty && m <= tm)) {
    keys.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) { m = 1; y++; }
    if (keys.length > 120) break;
  }
  return keys;
}

// ============================================================
// 账号相关操作
// ============================================================

/**
 * 读取所有账号（替代 _readAccountsRawSafe）
 * 返回格式与原 JSON 结构兼容：{ accounts: {acc_xxx: {...}}, accountsByEmail: {...} }
 * @returns {Object} 兼容旧格式的账号字典
 */
function _readAccountsRawSafe() {
  const rows = stmtAllAccounts.all();
  const accounts = {};
  const accountsByEmail = {};
  for (const r of rows) {
    const acc = {
      accountId: r.account_id,
      normalizedEmail: r.normalized_email,
      displayEmail: r.display_email,
      displayName: r.display_name,
      email: r.display_email,
      emailHash: r.normalized_email,
      avatar: r.avatar,
      isAdmin: r.is_admin === 1,
      pwd: {
        algo: r.pwd_algo,
        iter: r.pwd_iter,
        salt: r.pwd_salt,
        hash: r.pwd_hash,
      },
      reset: r.reset_code ? { code: r.reset_code, expireAt: r.reset_expire_at } : null,
      extId: r.ext_id,
      createdAt: r.created_at,
      lastLoginTs: r.last_login_ts,
    };
    accounts[r.account_id] = acc;
    accountsByEmail[r.normalized_email] = r.account_id;
  }
  return { version: 1, accounts, accountsByEmail, isLocked: {} };
}

/**
 * 按 accountId 查询单个账号
 * @param {string} accountId 账号ID
 * @returns {Object|null} 账号信息（兼容旧格式）
 */
function getAccountById(accountId) {
  const r = stmtGetAccountById.get(accountId);
  if (!r) return null;
  return {
    accountId: r.account_id,
    normalizedEmail: r.normalized_email,
    displayEmail: r.display_email,
    email: r.display_email,
    emailHash: r.normalized_email,
    displayName: r.display_name,
    avatar: r.avatar,
    isAdmin: r.is_admin === 1,
    isDisabled: r.is_disabled === 1,
    disabledReason: r.disabled_reason || '',
    pwd: { algo: r.pwd_algo, iter: r.pwd_iter, salt: r.pwd_salt, hash: r.pwd_hash },
    reset: r.reset_code ? { code: r.reset_code, expireAt: r.reset_expire_at } : null,
    extId: r.ext_id,
    createdAt: r.created_at,
    lastLoginTs: r.last_login_ts,
  };
}

/**
 * 按 normalized_email 查询单个账号
 * @param {string} email 邮箱
 * @returns {Object|null} 账号信息（兼容旧格式）
 */
function getAccountByEmail(email) {
  const r = stmtGetAccountByEmail.get(String(email || '').toLowerCase());
  if (!r) return null;
  return getAccountById(r.account_id);
}

/**
 * 更新账号最近登录时间
 * @param {string} accountId 账号ID
 * @param {number} ts 登录时间戳
 */
function updateLastLogin(accountId, ts) {
  stmtUpdateLastLogin.run(ts || Date.now(), accountId);
}

// ============================================================
// 积分余额操作
// ============================================================

/**
 * 读取某账号积分余额（替代 readBalance）
 * @param {string} accountId 账号ID
 * @returns {Object} 余额对象 { balance, totalRecharged, totalConsumed, updatedAt }
 */
function readBalance(accountId) {
  if (!accountId) return { balance: 0, totalRecharged: 0, totalConsumed: 0, updatedAt: 0 };
  // 确保余额记录存在（首次查询自动创建零值行）
  stmtInsertBalance.run(accountId);
  const r = stmtGetBalance.get(accountId);
  if (!r) return { balance: 0, totalRecharged: 0, totalConsumed: 0, updatedAt: 0 };
  return {
    balance: r.balance,
    totalRecharged: r.total_recharged,
    totalConsumed: r.total_consumed,
    updatedAt: r.updated_at,
  };
}

/**
 * 读取所有账号余额（替代 _readCreditsFileRaw）
 * 返回格式与原 JSON 兼容：{ version:1, balances: {acc_xxx: {...}} }
 * @returns {Object} 兼容旧格式的余额字典
 */
function _readCreditsFileRaw() {
  const rows = stmtGetAllBalances.all();
  const balances = {};
  for (const r of rows) {
    balances[r.account_id] = {
      balance: r.balance,
      totalRecharged: r.total_recharged,
      totalConsumed: r.total_consumed,
      updatedAt: r.updated_at,
    };
  }
  return { version: 1, balances };
}

/**
 * 充值积分（替代 rechargeCredits）
 * 使用事务保证：余额更新 + 流水记录 原子性
 * @param {Object} p { accountId, credits, orderId, desc, meta }
 * @returns {Object} { balance, flow }
 */
function rechargeCredits(p) {
  if (!p || !p.accountId) throw new Error('rechargeCredits: accountId 必传');
  const credits = Math.max(0, Math.floor(Number(p.credits) || 0));
  if (credits <= 0) throw new Error('rechargeCredits: credits 必须 > 0');

  // 确保余额记录存在
  stmtInsertBalance.run(p.accountId);

  const mk = _monthKey(Date.now());
  const now = Date.now();
  const flowId = 'fl_' + crypto.randomBytes(12).toString('hex');

  const runRecharge = db.transaction(() => {
    // 原子增加余额
    stmtAddBalance.run(credits, credits, now, p.accountId);

    // 读取更新后的余额（用于流水记录的 balanceAfter）
    const cur = stmtGetBalance.get(p.accountId);
    const newBalance = cur ? cur.balance : 0;

    // 写入流水
    stmtInsertFlow.run({
      flowId,
      accountId: p.accountId,
      type: 'charge',
      bizType: 'package',
      bizId: p.orderId || '',
      amount: credits,
      delta: credits,
      balanceAfter: newBalance,
      desc: p.desc || `充值 +${credits} 积分`,
      meta: p.meta ? JSON.stringify(p.meta) : null,
      monthKey: mk,
      operatorAccountId: null,
      operatorEmail: null,
      createdAt: now,
    });

    return { balance: newBalance, flowId };
  });

  const result = runRecharge();
  return {
    balance: result.balance,
    flow: {
      flowId: result.flowId,
      accountId: p.accountId,
      type: 'charge',
      bizType: 'package',
      bizId: p.orderId || '',
      amount: credits,
      delta: credits,
      balanceAfter: result.balance,
      desc: p.desc || `充值 +${credits} 积分`,
      meta: p.meta || {},
      month: mk,
      createdAt: now,
    },
  };
}

/**
 * 扣减积分（替代 consume 逻辑）
 * 使用事务保证：余额检查 + 扣减 + 流水 原子性
 * WHERE balance >= ? 防止并发超扣
 * @param {Object} p { accountId, credits, bizType, bizId, desc }
 * @returns {Object} { insufficient, balance, flow, totalConsumed, updatedAt }
 */
function consumeCredits(p) {
  if (!p || !p.accountId) throw new Error('consumeCredits: accountId 必传');
  const credits = Math.max(0, Math.floor(Number(p.credits) || 0));
  if (credits <= 0) throw new Error('consumeCredits: credits 必须 > 0');

  // 确保余额记录存在
  stmtInsertBalance.run(p.accountId);

  const mk = _monthKey(Date.now());
  const now = Date.now();
  const flowId = 'FL' + now + crypto.randomBytes(2).toString('hex').toUpperCase();

  const runConsume = db.transaction(() => {
    // 原子检查并扣减：WHERE balance >= ? 保证不会超扣
    const info = stmtDeductBalance.run(credits, credits, now, p.accountId, credits);
    if (info.changes === 0) {
      // 余额不足
      const cur = stmtGetBalance.get(p.accountId);
      return { insufficient: true, balance: cur ? cur.balance : 0 };
    }

    // 读取扣减后的余额
    const cur = stmtGetBalance.get(p.accountId);

    // 写入流水
    stmtInsertFlow.run({
      flowId,
      accountId: p.accountId,
      type: 'consume',
      bizType: p.bizType || 'consume',
      bizId: p.bizId || '',
      amount: credits,
      delta: -credits,
      balanceAfter: cur.balance,
      desc: p.desc || `消耗 ${credits} 积分`,
      meta: null,
      monthKey: mk,
      operatorAccountId: null,
      operatorEmail: null,
      createdAt: now,
    });

    return {
      insufficient: false,
      balance: cur.balance,
      totalConsumed: cur.total_consumed,
      updatedAt: cur.updated_at,
      flowId,
    };
  });

  const result = runConsume();
  if (result.insufficient) {
    return { insufficient: true, balance: result.balance };
  }

  return {
    insufficient: false,
    balance: result.balance,
    totalConsumed: result.totalConsumed,
    updatedAt: result.updatedAt,
    flow: {
      flowId: result.flowId,
      accountId: p.accountId,
      type: 'consume',
      delta: -credits,
      balanceAfter: result.balance,
      bizType: p.bizType || 'consume',
      bizId: p.bizId || undefined,
      desc: p.desc || undefined,
      createdAt: now,
      month: mk,
    },
  };
}

/**
 * 管理员手工调账（替代 admin adjust 逻辑）
 * @param {Object} p { targetAccountId, delta, reason, operatorAccountId, operatorEmail }
 * @returns {Object} { insufficient, balance, flow, totalRecharged, totalConsumed, updatedAt }
 */
function adminAdjust(p) {
  if (!p || !p.targetAccountId) throw new Error('adminAdjust: targetAccountId 必传');
  const delta = Math.floor(Number(p.delta) || 0);
  if (delta === 0) throw new Error('adminAdjust: delta 必须非零');

  // 确保余额记录存在
  stmtInsertBalance.run(p.targetAccountId);

  const mk = _monthKey(Date.now());
  const now = Date.now();
  const flowId = 'FL' + now + crypto.randomBytes(2).toString('hex').toUpperCase();

  const runAdjust = db.transaction(() => {
    if (delta < 0) {
      // 扣减时检查余额
      const cur = stmtGetBalance.get(p.targetAccountId);
      if (!cur || cur.balance + delta < 0) {
        return { insufficient: true, balance: cur ? cur.balance : 0 };
      }
      // 手动扣减（不用 stmtDeductBalance，因为 delta 可能是负数）
      stmtUpsertBalance.run({
        accountId: p.targetAccountId,
        balance: cur.balance + delta,
        totalRecharged: cur.total_recharged,
        totalConsumed: cur.total_consumed + (-delta),
        updatedAt: now,
      });
    } else {
      // 增加
      stmtAddBalance.run(delta, delta, now, p.targetAccountId);
    }

    const cur = stmtGetBalance.get(p.targetAccountId);

    stmtInsertFlow.run({
      flowId,
      accountId: p.targetAccountId,
      type: 'adjust',
      bizType: 'admin_manual',
      bizId: '',
      amount: Math.abs(delta),
      delta,
      balanceAfter: cur.balance,
      desc: p.reason || '管理员调账',
      meta: null,
      monthKey: mk,
      operatorAccountId: p.operatorAccountId || null,
      operatorEmail: p.operatorEmail || null,
      createdAt: now,
    });

    return {
      insufficient: false,
      balance: cur.balance,
      totalRecharged: cur.total_recharged,
      totalConsumed: cur.total_consumed,
      updatedAt: cur.updated_at,
      flowId,
    };
  });

  return runAdjust();
}

// ============================================================
// 订单操作
// ============================================================

/**
 * 写入/更新订单（替代 upsertOrder）
 * @param {Object} order 订单对象
 * @returns {Object} 写入的订单
 */
function upsertOrder(order) {
  if (!order || !order.orderId) throw new Error('upsertOrder: orderId 必传');
  stmtUpsertOrder.run({
    orderId: order.orderId,
    accountId: order.accountId || '',
    packageId: order.packageId || '',
    packageName: order.packageName || '',
    credits: Number(order.credits) || 0,
    bonus: Number(order.bonus) || 0,
    priceCents: Number(order.priceCents) || 0,
    status: order.status || 'pending',
    channel: order.channel || '',
    createdAt: Number(order.createdAt) || Date.now(),
    paidAt: Number(order.paidAt) || 0,
    cancelledAt: Number(order.cancelledAt) || 0,
    meta: order.meta ? JSON.stringify(order.meta) : null,
  });
  return order;
}

/**
 * 按账号查询订单列表（替代 listOrdersByAccount）
 * @param {string} accountId 账号ID
 * @param {number} limit 最大返回数
 * @returns {Array} 订单数组
 */
function listOrdersByAccount(accountId, limit) {
  if (!accountId) return [];
  const rows = stmtOrdersByAccount.all(accountId, Math.min(limit || 50, 500));
  return rows.map(r => ({
    orderId: r.order_id,
    accountId: r.account_id,
    packageId: r.package_id,
    packageName: r.package_name,
    credits: r.credits,
    bonus: r.bonus,
    priceCents: r.price_cents,
    status: r.status,
    channel: r.channel,
    createdAt: r.created_at,
    paidAt: r.paid_at,
    cancelledAt: r.cancelled_at,
    meta: r.meta ? JSON.parse(r.meta) : {},
  }));
}

/**
 * 读取所有订单（替代 _readOrdersFileRaw）
 * @returns {Object} 兼容旧格式 { version:1, orders: {ORxxx: {...}} }
 */
function _readOrdersFileRaw() {
  const rows = stmtAllOrders.all();
  const orders = {};
  for (const r of rows) {
    orders[r.order_id] = {
      orderId: r.order_id,
      accountId: r.account_id,
      packageId: r.package_id,
      packageName: r.package_name,
      credits: r.credits,
      bonus: r.bonus,
      priceCents: r.price_cents,
      status: r.status,
      channel: r.channel,
      createdAt: r.created_at,
      paidAt: r.paid_at,
      cancelledAt: r.cancelled_at,
      meta: r.meta ? JSON.parse(r.meta) : {},
    };
  }
  return { version: 1, orders };
}

/**
 * 按订单号查询订单
 * @param {string} orderId 订单ID
 * @returns {Object|null} 订单对象
 */
function getOrder(orderId) {
  const r = stmtGetOrder.get(orderId);
  if (!r) return null;
  return {
    orderId: r.order_id,
    accountId: r.account_id,
    packageId: r.package_id,
    packageName: r.package_name,
    credits: r.credits,
    bonus: r.bonus,
    priceCents: r.price_cents,
    status: r.status,
    channel: r.channel,
    createdAt: r.created_at,
    paidAt: r.paid_at,
    cancelledAt: r.cancelled_at,
    meta: r.meta ? JSON.parse(r.meta) : {},
  };
}

/**
 * 支付订单（原子操作：更新订单状态 + 增加余额 + 写流水）
 * WHERE status='pending' 防止并发重复支付
 * @param {Object} p { orderId, accountId, channel, totalCredits, pkg }
 * @returns {Object} { alreadyPaid, balance, flowId }
 */
function payOrder(p) {
  const now = Date.now();
  const mk = _monthKey(now);
  const flowId = 'fl_' + crypto.randomBytes(12).toString('hex');

  const runPay = db.transaction(() => {
    // 原子更新订单状态：只有 pending 状态才能变为 paid
    const info = stmtPayOrder.run(p.channel || 'mock', now, p.orderId);
    if (info.changes === 0) {
      // 订单不存在或不是 pending 状态
      const existing = stmtGetOrder.get(p.orderId);
      if (existing && existing.status === 'paid') {
        return { alreadyPaid: true, balance: null, flowId: null };
      }
      throw new Error('ORDER_LOST');
    }

    // 确保余额记录存在
    stmtInsertBalance.run(p.accountId);

    // 原子增加余额
    stmtAddBalance.run(p.totalCredits, p.totalCredits, now, p.accountId);

    // 读取更新后余额
    const cur = stmtGetBalance.get(p.accountId);
    const newBalance = cur ? cur.balance : 0;

    // 写入流水
    stmtInsertFlow.run({
      flowId,
      accountId: p.accountId,
      type: 'charge',
      bizType: 'package',
      bizId: p.orderId,
      amount: p.totalCredits,
      delta: p.totalCredits,
      balanceAfter: newBalance,
      desc: p.desc || `购买套餐 +${p.totalCredits} 积分`,
      meta: p.meta ? JSON.stringify(p.meta) : null,
      monthKey: mk,
      operatorAccountId: null,
      operatorEmail: null,
      createdAt: now,
    });

    return { alreadyPaid: false, balance: newBalance, flowId };
  });

  return runPay();
}

// ============================================================
// 积分流水操作
// ============================================================

/**
 * 读取某月所有流水（替代 readCreditFlowsByMonth）
 * @param {string} monthKey 月份 'YYYY-MM'
 * @returns {Array} 流水数组
 */
function readCreditFlowsByMonth(monthKey) {
  const rows = stmtFlowsByMonth.all(monthKey);
  return rows.map(mapFlowRow);
}

/**
 * 追加一条积分流水（替代 appendCreditFlow）
 * @param {Object} flow 流水对象
 * @returns {Object} 写入后的完整流水对象
 */
function appendCreditFlow(flow) {
  if (!flow || !flow.accountId) {
    throw new Error('appendCreditFlow: flow.accountId 必传');
  }
  const mk = _monthKey(flow.createdAt || Date.now());
  const now = flow.createdAt || Date.now();
  const flowId = flow.flowId || ('fl_' + crypto.randomBytes(12).toString('hex'));

  stmtInsertFlow.run({
    flowId,
    accountId: flow.accountId,
    type: flow.type || 'adjust',
    bizType: flow.bizType || '',
    bizId: flow.bizId || '',
    amount: Number(flow.amount ?? flow.delta) || 0,
    delta: Number(flow.delta) || 0,
    balanceAfter: Number(flow.balanceAfter) || 0,
    desc: flow.desc || '',
    meta: flow.meta ? JSON.stringify(flow.meta) : null,
    monthKey: mk,
    operatorAccountId: flow.operatorAccountId || null,
    operatorEmail: flow.operatorEmail || null,
    createdAt: now,
  });

  return { ...flow, flowId, month: mk, createdAt: now };
}

/**
 * 查询某账号在指定月份区间内的所有流水（替代 listCreditFlows）
 * 现在用 SQL 索引查询，不再需要扫描所有月份文件
 * @param {string} accountId 账号ID
 * @param {string} fromMonth 起始月 'YYYY-MM'（可选）
 * @param {string} toMonth 结束月 'YYYY-MM'（可选）
 * @param {Object} opts { type, bizType, limit, desc }
 * @returns {Array} 流水数组
 */
function listCreditFlows(accountId, fromMonth, toMonth, opts) {
  opts = opts || {};

  // 构建动态 SQL：根据过滤条件拼接 WHERE 子句
  const conditions = ['account_id = ?'];
  const params = [accountId];

  if (fromMonth) {
    conditions.push('month_key >= ?');
    params.push(fromMonth);
  }
  if (toMonth) {
    conditions.push('month_key <= ?');
    params.push(toMonth);
  }
  if (opts.type) {
    conditions.push('type = ?');
    params.push(opts.type);
  }
  if (opts.bizType) {
    conditions.push('biz_type = ?');
    params.push(opts.bizType);
  }

  const orderBy = opts.desc === false ? 'ASC' : 'DESC';
  const limit = (typeof opts.limit === 'number' && opts.limit > 0) ? opts.limit : 100;
  const offset = (typeof opts.offset === 'number' && opts.offset >= 0) ? opts.offset : 0;

  const sql = `
    SELECT flow_id, account_id, type, biz_type, biz_id, amount, delta,
           balance_after, description, meta, month_key,
           operator_account_id, operator_email, created_at
    FROM credit_flows
    WHERE ${conditions.join(' AND ')}
    ORDER BY created_at ${orderBy}
    LIMIT ? OFFSET ?
  `;
  params.push(limit, offset);

  const rows = db.prepare(sql).all(...params);
  return rows.map(mapFlowRow);
}

/**
 * 统计流水总数（用于分页显示总条数）
 * @param {string} accountId 账号ID
 * @param {string} [fromMonth] 起始月份
 * @param {string} [toMonth] 结束月份
 * @param {Object} [opts] 过滤条件 { type, bizType }
 * @returns {number} 总条数
 */
function countCreditFlows(accountId, fromMonth, toMonth, opts) {
  opts = opts || {};
  const conditions = ['account_id = ?'];
  const params = [accountId];
  if (fromMonth) { conditions.push('month_key >= ?'); params.push(fromMonth); }
  if (toMonth)   { conditions.push('month_key <= ?'); params.push(toMonth); }
  if (opts.type)    { conditions.push('type = ?');    params.push(opts.type); }
  if (opts.bizType) { conditions.push('biz_type = ?'); params.push(opts.bizType); }

  const sql = `SELECT COUNT(*) AS cnt FROM credit_flows WHERE ${conditions.join(' AND ')}`;
  const row = db.prepare(sql).get(...params);
  return row ? row.cnt : 0;
}

/**
 * 统计自指定时间戳以来的流水总数（供总览看板"最近30天流水数"使用）
 * @param {number} sinceTs 起始时间戳（毫秒）
 * @returns {number} 流水条数
 */
function countFlowsSince(sinceTs) {
  return stmtCountFlowsSince.get(Number(sinceTs) || 0).cnt;
}

// ============================================================
// 签到功能（checkin_records + credit_balances + credit_flows 联动）
// ============================================================

/** 签到奖励配置：7 天一个周期，day 1-7 对应奖励积分（与前端 CHECKIN_CONFIG 一致） */
const CHECKIN_REWARDS = [50, 10, 15, 20, 30, 50, 100];

/**
 * 将时间戳格式化为 'YYYY-MM-DD'（本地时区，用于签到日期键）
 * @param {number} ts 毫秒时间戳
 * @returns {string} 日期字符串
 */
function _dateKey(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 计算两个日期字符串相差的天数（b - a，均为 'YYYY-MM-DD'）
 * @param {string} dateA 较早日期
 * @param {string} dateB 较晚日期
 * @returns {number} 相差天数（正数表示 b 在 a 之后）
 */
function _dateDiffDays(dateA, dateB) {
  const ta = new Date(dateA + 'T00:00:00').getTime();
  const tb = new Date(dateB + 'T00:00:00').getTime();
  return Math.round((tb - ta) / (24 * 3600 * 1000));
}

/**
 * 查询签到状态：今日是否已签到、当前连续天数、今日可获奖励
 * @param {string} accountId 账号ID
 * @returns {Object} { alreadyCheckedIn, currentDay, todayReward, continuousDays, history }
 */
function getCheckinStatus(accountId) {
  if (!accountId) return { alreadyCheckedIn: false, currentDay: 1, todayReward: 50, continuousDays: 0, history: [] };

  const today = _dateKey(Date.now());
  const todayRecord = stmtGetTodayCheckin.get(accountId, today);

  // 今日已签到
  if (todayRecord) {
    // 查最近 7 次记录用于展示进度
    const recent = stmtGetRecentCheckins.all(accountId);
    return {
      alreadyCheckedIn: true,
      currentDay: todayRecord.checkin_day_index,
      todayReward: todayRecord.reward_credits,
      continuousDays: todayRecord.checkin_day_index,
      history: recent.map(r => ({
        date: r.checkin_date,
        dayIndex: r.checkin_day_index,
        reward: r.reward_credits,
        createdAt: r.created_at,
      })),
    };
  }

  // 今日未签到：根据最近一次签到记录计算本次应该是第几天
  const latest = stmtGetLatestCheckin.get(accountId);
  let nextDay = 1;
  if (latest) {
    const diff = _dateDiffDays(latest.checkin_date, today);
    if (diff === 1) {
      // 昨天签过 → 连续 +1（满 7 则回 1）
      nextDay = (latest.checkin_day_index >= 7) ? 1 : latest.checkin_day_index + 1;
    } else {
      // 断签（diff > 1）或未来日期（diff < 0，极少见）→ 回到第 1 天
      nextDay = 1;
    }
  }

  const todayReward = CHECKIN_REWARDS[nextDay - 1] || 50;
  const recent = stmtGetRecentCheckins.all(accountId);

  return {
    alreadyCheckedIn: false,
    currentDay: nextDay,
    todayReward,
    continuousDays: nextDay - 1,  // 今日未签到，已连续天数 = nextDay - 1
    history: recent.map(r => ({
      date: r.checkin_date,
      dayIndex: r.checkin_day_index,
      reward: r.reward_credits,
      createdAt: r.created_at,
    })),
  };
}

/**
 * 执行今日签到（事务保证：签到记录 + 余额增加 + 流水写入 原子完成）
 * @param {string} accountId 账号ID
 * @returns {Object} { ok, alreadyCheckedIn?, currentDay, reward, balance, continuousDays? }
 */
function doCheckin(accountId) {
  if (!accountId) throw new Error('doCheckin: accountId 必传');

  const today = _dateKey(Date.now());
  const now = Date.now();
  const mk = _monthKey(now);

  // 前置检查：今日是否已签到
  const todayRecord = stmtGetTodayCheckin.get(accountId, today);
  if (todayRecord) {
    return {
      ok: false,
      alreadyCheckedIn: true,
      currentDay: todayRecord.checkin_day_index,
      reward: todayRecord.reward_credits,
      balance: (stmtGetBalance.get(accountId) || {}).balance || 0,
    };
  }

  // 计算本次签到的周期天数（连续签到第几天）
  const latest = stmtGetLatestCheckin.get(accountId);
  let nextDay = 1;
  if (latest) {
    const diff = _dateDiffDays(latest.checkin_date, today);
    if (diff === 1) {
      nextDay = (latest.checkin_day_index >= 7) ? 1 : latest.checkin_day_index + 1;
    }
  }
  const reward = CHECKIN_REWARDS[nextDay - 1] || 50;

  // 生成 ID
  const recordId = 'ck_' + crypto.randomBytes(6).toString('hex');
  const flowId = 'fl_' + crypto.randomBytes(12).toString('hex');

  // 事务：签到记录 + 余额增加 + 流水写入 + 回填 flow_id
  const runCheckin = db.transaction(() => {
    // 确保余额记录存在
    stmtInsertBalance.run(accountId);

    // 先插入签到记录（flowId 先留空，写完流水后回填）
    try {
      stmtInsertCheckin.run({
        recordId, accountId, checkinDate: today,
        dayIndex: nextDay, reward, flowId: null, createdAt: now,
      });
    } catch (e) {
      // UNIQUE 约束冲突 = 今日已签到（并发场景）
      if (String(e.message || '').includes('UNIQUE')) {
        return { concurrentConflict: true };
      }
      throw e;
    }

    // 增加余额（只加 balance，不累加 total_recharged）
    stmtAddRewardBalance.run(reward, now, accountId);

    // 读取新余额（用于流水 balanceAfter）
    const cur = stmtGetBalance.get(accountId);
    const newBalance = cur ? cur.balance : 0;

    // 写入积分流水（type=reward, bizType=checkin）
    stmtInsertFlow.run({
      flowId,
      accountId,
      type: 'reward',
      bizType: 'checkin',
      bizId: recordId,
      amount: reward,
      delta: reward,
      balanceAfter: newBalance,
      desc: `连续签到第 ${nextDay} 天，奖励 +${reward} 积分`,
      meta: JSON.stringify({ checkinDate: today, dayIndex: nextDay }),
      monthKey: mk,
      operatorAccountId: null,
      operatorEmail: null,
      createdAt: now,
    });

    // 回填签到记录的 flow_id
    stmtUpdateCheckinFlow.run(flowId, recordId);

    return { balance: newBalance };
  });

  const result = runCheckin();

  // 并发冲突：今日已被其他请求签到
  if (result.concurrentConflict) {
    const r = stmtGetTodayCheckin.get(accountId, today);
    return {
      ok: false,
      alreadyCheckedIn: true,
      currentDay: r ? r.checkin_day_index : 1,
      reward: r ? r.reward_credits : 0,
      balance: (stmtGetBalance.get(accountId) || {}).balance || 0,
    };
  }

  return {
    ok: true,
    alreadyCheckedIn: false,
    currentDay: nextDay,
    reward,
    balance: result.balance,
    continuousDays: nextDay,
  };
}

// ============================================================
// 邀请好友功能（invite_records + accounts.ext_id + credit_balances + credit_flows 联动）
// ============================================================

/** 邀请奖励配置：邀请人和被邀请人各得 50 积分 */
const INVITE_REWARD_INVITER = 50;
const INVITE_REWARD_INVITEE = 50;

/** 邀请码字符集：排除 0/O/1/I 等易混字符（与重置码字符集一致） */
const INVITE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * 生成 8 位邀请码（IA 前缀 + 6 位随机字符）
 * @returns {string} 邀请码，如 'IA3K7QP'
 */
function _genInviteCode() {
  const arr = new Uint8Array(6);
  crypto.randomFillSync(arr);
  let s = 'IA';
  for (let i = 0; i < 6; i++) s += INVITE_CHARS[arr[i] % INVITE_CHARS.length];
  return s;
}

/**
 * 获取或生成账号的专属邀请码（首次调用时自动生成并写入 accounts.ext_id）
 * @param {string} accountId 账号ID
 * @returns {string} 邀请码（如 'IA3K7QP'），出错返回空字符串
 */
function getOrGenerateInviteCode(accountId) {
  if (!accountId) return '';
  // 先查是否已有邀请码
  const row = stmtGetInviteCode.get(accountId);
  if (row && row.invite_code) return row.invite_code;

  // 生成新邀请码，确保不重复（极小概率冲突，重试 3 次）
  for (let i = 0; i < 3; i++) {
    const code = _genInviteCode();
    // 检查是否已被其他账号占用
    const existing = stmtGetAccountByInviteCode.get(code);
    if (existing) continue;
    // 写入 accounts.ext_id（仅在 ext_id 为空时写入，避免覆盖）
    const info = stmtSetInviteCode.run(code, accountId);
    if (info.changes > 0) return code;
    // 如果 changes=0，说明 ext_id 已被其他请求写入，重新查询
    const row2 = stmtGetInviteCode.get(accountId);
    if (row2 && row2.invite_code) return row2.invite_code;
  }
  // 兜底：直接返回 accountId 的后 8 位作为邀请码（极不可能走到这里）
  return 'IA' + accountId.replace(/[^a-zA-Z0-9]/g, '').slice(-6).toUpperCase();
}

/**
 * 按邀请码查询邀请人账号（注册时校验邀请码是否有效）
 * @param {string} inviteCode 邀请码
 * @returns {Object|null} 邀请人信息 { account_id, display_email, display_name }
 */
function getInviterByCode(inviteCode) {
  if (!inviteCode) return null;
  return stmtGetAccountByInviteCode.get(String(inviteCode).trim().toUpperCase()) || null;
}

/**
 * 处理邀请奖励（事务保证：插入邀请记录 + 双方加积分 + 双方流水 原子完成）
 * 调用时机：被邀请人注册成功后
 * @param {string} inviterAccountId 邀请人账号ID
 * @param {string} inviteeAccountId 被邀请人账号ID
 * @param {string} inviteCode 使用的邀请码
 * @returns {Object} { ok, reason?, inviterReward?, inviteeReward? }
 */
function processInviteReward(inviterAccountId, inviteeAccountId, inviteCode) {
  if (!inviterAccountId || !inviteeAccountId || !inviteCode) {
    return { ok: false, reason: 'INVALID_PARAMS' };
  }
  // 不能邀请自己
  if (inviterAccountId === inviteeAccountId) {
    return { ok: false, reason: 'SELF_INVITE' };
  }
  // 检查被邀请人是否已有邀请记录（一个人只能被邀请一次）
  const existing = stmtGetInviteByInvitee.get(inviteeAccountId);
  if (existing) {
    return { ok: false, reason: 'ALREADY_INVITED' };
  }

  const now = Date.now();
  const mk = _monthKey(now);
  const recordId = 'inv_' + crypto.randomBytes(6).toString('hex');
  const inviterFlowId = 'fl_' + crypto.randomBytes(12).toString('hex');
  const inviteeFlowId = 'fl_' + crypto.randomBytes(12).toString('hex');

  // 事务：插入邀请记录 + 邀请人加积分 + 被邀请人加积分 + 双方流水
  const runInvite = db.transaction(() => {
    // 确保双方余额记录存在
    stmtInsertBalance.run(inviterAccountId);
    stmtInsertBalance.run(inviteeAccountId);

    // 插入邀请记录（UNIQUE 约束防并发）
    try {
      stmtInsertInviteRecord.run({
        recordId, inviterId: inviterAccountId, inviteeId: inviteeAccountId,
        inviteCode: String(inviteCode).trim().toUpperCase(),
        inviterReward: INVITE_REWARD_INVITER,
        inviteeReward: INVITE_REWARD_INVITEE,
        inviterFlowId: null, inviteeFlowId: null,
        createdAt: now,
      });
    } catch (e) {
      if (String(e.message || '').includes('UNIQUE')) {
        return { concurrentConflict: true };
      }
      throw e;
    }

    // 邀请人加积分
    stmtAddRewardBalance.run(INVITE_REWARD_INVITER, now, inviterAccountId);
    const inviterBal = stmtGetBalance.get(inviterAccountId);
    const inviterBalance = inviterBal ? inviterBal.balance : 0;
    stmtInsertFlow.run({
      flowId: inviterFlowId, accountId: inviterAccountId,
      type: 'reward', bizType: 'invite_inviter', bizId: recordId,
      amount: INVITE_REWARD_INVITER, delta: INVITE_REWARD_INVITER,
      balanceAfter: inviterBalance,
      desc: `邀请好友注册奖励 +${INVITE_REWARD_INVITER} 积分`,
      meta: JSON.stringify({ inviteeAccountId, inviteCode }),
      monthKey: mk, operatorAccountId: null, operatorEmail: null, createdAt: now,
    });

    // 被邀请人加积分
    stmtAddRewardBalance.run(INVITE_REWARD_INVITEE, now, inviteeAccountId);
    const inviteeBal = stmtGetBalance.get(inviteeAccountId);
    const inviteeBalance = inviteeBal ? inviteeBal.balance : 0;
    stmtInsertFlow.run({
      flowId: inviteeFlowId, accountId: inviteeAccountId,
      type: 'reward', bizType: 'invite_invitee', bizId: recordId,
      amount: INVITE_REWARD_INVITEE, delta: INVITE_REWARD_INVITEE,
      balanceAfter: inviteeBalance,
      desc: `受邀注册奖励 +${INVITE_REWARD_INVITEE} 积分`,
      meta: JSON.stringify({ inviterAccountId, inviteCode }),
      monthKey: mk, operatorAccountId: null, operatorEmail: null, createdAt: now,
    });

    return { inviterBalance, inviteeBalance };
  });

  const result = runInvite();
  if (result.concurrentConflict) {
    return { ok: false, reason: 'ALREADY_INVITED' };
  }

  return {
    ok: true,
    inviterReward: INVITE_REWARD_INVITER,
    inviteeReward: INVITE_REWARD_INVITEE,
    inviterBalance: result.inviterBalance,
    inviteeBalance: result.inviteeBalance,
  };
}

/**
 * 查询邀请人的邀请记录列表（控制台展示用）
 * @param {string} inviterAccountId 邀请人账号ID
 * @param {number} limit 每页条数（默认 20）
 * @param {number} offset 偏移量（默认 0）
 * @returns {Array} 邀请记录数组
 */
function listInviteRecords(inviterAccountId, limit = 20, offset = 0) {
  if (!inviterAccountId) return [];
  return stmtListInvitesByInviter.all(inviterAccountId, Number(limit) || 20, Number(offset) || 0)
    .map(r => ({
      recordId: r.record_id,
      inviteeEmail: r.invitee_email || '',
      inviteeName: r.invitee_name || '',
      inviteCode: r.invite_code,
      inviterReward: r.inviter_reward,
      inviteeReward: r.invitee_reward,
      createdAt: r.created_at,
    }));
}

/**
 * 统计邀请人已邀请总人数和总奖励积分
 * @param {string} inviterAccountId 邀请人账号ID
 * @returns {Object} { totalInvited, totalReward }
 */
function getInviteStats(inviterAccountId) {
  if (!inviterAccountId) return { totalInvited: 0, totalReward: 0 };
  const row = stmtInviteStats.get(inviterAccountId);
  return {
    totalInvited: row ? row.total_invited : 0,
    totalReward: row ? row.total_reward : 0,
  };
}

// ============================================================
// 管理端方法：账号列表、订单列表、套餐 CRUD、用户管理
// ============================================================

/**
 * 管理端：查询所有账号（支持关键词搜索 + 分页）
 * @param {string} keyword 搜索关键词（邮箱/昵称/账号ID）
 * @param {number} limit 每页条数
 * @param {number} offset 偏移量
 * @returns {Array} 账号列表
 */
function listAllAccounts(keyword, limit, offset) {
  const kw = '%' + String(keyword || '').toLowerCase() + '%';
  return stmtListAllAccounts.all(kw, kw, kw, Number(limit) || 200, Number(offset) || 0)
    .map(r => ({
      accountId: r.account_id,
      email: r.display_email,
      displayName: r.display_name,
      avatar: r.avatar || '',
      isAdmin: !!r.is_admin,
      isDisabled: !!r.is_disabled,
      disabledReason: r.disabled_reason || '',
      inviteCode: r.invite_code || '',
      createdAt: r.created_at,
      lastLoginTs: r.last_login_ts,
      credits: {
        balance: r.balance,
        totalRecharged: r.total_recharged,
        totalConsumed: r.total_consumed,
      },
    }));
}

/**
 * 管理端：统计账号总数（支持关键词搜索）
 * @param {string} keyword 搜索关键词
 * @returns {number} 总数
 */
function countAllAccounts(keyword) {
  const kw = '%' + String(keyword || '').toLowerCase() + '%';
  const row = stmtCountAllAccounts.get(kw, kw, kw);
  return row ? row.cnt : 0;
}

/**
 * 管理端：查询所有订单（支持分页）
 * @param {number} limit 每页条数
 * @param {number} offset 偏移量
 * @returns {Array} 订单列表
 */
function listAllOrders(limit, offset) {
  return stmtListAllOrders.all(Number(limit) || 50, Number(offset) || 0)
    .map(r => ({
      orderId: r.order_id,
      accountId: r.account_id,
      packageId: r.package_id,
      packageName: r.package_name,
      priceCents: r.price_cents,
      paidCredits: r.paid_credits,
      status: r.status,
      createdAt: r.created_at,
      paidAt: r.paid_at,
      email: r.display_email || '',
      displayName: r.display_name || '',
    }));
}

/**
 * 管理端：统计订单总数
 * @returns {number} 总数
 */
function countAllOrders() {
  const row = stmtCountAllOrders.get();
  return row ? row.cnt : 0;
}

/**
 * 管理端：查询所有套餐（含下架的）
 * @returns {Array} 套餐列表
 */
function listAllPackages() {
  return stmtListAllPackages.all().map(r => ({
    packageId: r.package_id,
    title: r.title,
    credits: r.credits,
    bonusCredits: r.bonus_credits,
    priceCents: r.price_cents,
    tag: r.tag,
    description: r.description,
    isActive: !!r.is_active,
    sortOrder: r.sort_order,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

/**
 * 管理端：新增套餐
 * @param {Object} data 套餐数据
 * @returns {Object} { ok, error? }
 */
function insertPackage(data) {
  const now = Date.now();
  const packageId = data.packageId || ('pkg_' + crypto.randomBytes(4).toString('hex'));
  try {
    stmtInsertPackage.run({
      packageId,
      title: String(data.title || ''),
      credits: Number(data.credits) || 0,
      bonusCredits: Number(data.bonusCredits) || 0,
      priceCents: Number(data.priceCents) || 0,
      tag: String(data.tag || ''),
      description: String(data.description || ''),
      isActive: data.isActive === false ? 0 : 1,
      sortOrder: Number(data.sortOrder) || 0,
      createdAt: now,
      updatedAt: now,
    });
    return { ok: true, packageId };
  } catch (e) {
    if (String(e.message || '').includes('UNIQUE')) return { ok: false, error: 'DUPLICATE_ID' };
    throw e;
  }
}

/**
 * 管理端：更新套餐
 * @param {string} packageId 套餐ID
 * @param {Object} data 套餐数据
 * @returns {Object} { ok, changes? }
 */
function updatePackage(packageId, data) {
  const info = stmtUpdatePackage.run({
    packageId,
    title: String(data.title || ''),
    credits: Number(data.credits) || 0,
    bonusCredits: Number(data.bonusCredits) || 0,
    priceCents: Number(data.priceCents) || 0,
    tag: String(data.tag || ''),
    description: String(data.description || ''),
    isActive: data.isActive === false ? 0 : 1,
    sortOrder: Number(data.sortOrder) || 0,
    updatedAt: Date.now(),
  });
  return { ok: info.changes > 0, changes: info.changes };
}

/**
 * 管理端：删除套餐
 * @param {string} packageId 套餐ID
 * @returns {Object} { ok, changes? }
 */
function deletePackage(packageId) {
  const info = stmtDeletePackage.run(packageId);
  return { ok: info.changes > 0, changes: info.changes };
}

/**
 * 管理端：禁用/启用账号
 * @param {string} accountId 账号ID
 * @param {boolean} disabled 是否禁用
 * @param {string} reason 禁用原因
 * @returns {Object} { ok, changes? }
 */
function toggleAccountDisabled(accountId, disabled, reason) {
  const info = stmtToggleAccountDisabled.run(
    disabled ? 1 : 0,
    disabled ? String(reason || '').slice(0, 200) : '',
    accountId
  );
  return { ok: info.changes > 0, changes: info.changes };
}

/**
 * 管理端：设置/取消管理员
 * @param {string} accountId 账号ID
 * @param {boolean} isAdmin 是否管理员
 * @returns {Object} { ok, changes? }
 */
function setAdmin(accountId, isAdmin) {
  const info = stmtSetAdmin.run(isAdmin ? 1 : 0, accountId);
  return { ok: info.changes > 0, changes: info.changes };
}

/**
 * 管理端：重置用户密码（管理员直接设置新密码，不需要旧密码）
 * @param {string} accountId 账号ID
 * @param {string} newPassword 新密码
 * @returns {Object} { ok, changes? }
 */
function adminResetPassword(accountId, newPassword) {
  const crypto = require('crypto');
  const SALT_BYTES = 16, PBKDF2_ITER = 100000, HASH_BYTES = 64, PBKDF2_ALGO = 'sha256';
  const salt = crypto.randomBytes(SALT_BYTES);
  const hash = crypto.pbkdf2Sync(String(newPassword || ''), salt, PBKDF2_ITER, HASH_BYTES, PBKDF2_ALGO);
  const info = stmtResetPassword.run(
    salt.toString('base64'),
    hash.toString('base64'),
    accountId
  );
  return { ok: info.changes > 0, changes: info.changes };
}

// ============================================================
// 兑换码相关方法
// ============================================================

/** 生成一个兑换码：前缀 RC + 6 位大写字母数字（共 8 位，排除易混淆字符 0/O/I/1） */
function _genRedeemCode() {
  const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';  // 排除 0/O/I/1
  let s = '';
  const buf = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) s += CHARS[buf[i] % CHARS.length];
  return 'RC' + s;
}

/**
 * 批量生成兑换码
 * @param {Object} p { count, credits, expireDays, note, createdBy }
 * @returns {Object} { ok, batchId, codes: [...] }
 */
function generateRedeemCodes(p) {
  const count = Math.min(1000, Math.max(1, Math.floor(Number(p && p.count) || 1)));
  const credits = Math.max(1, Math.floor(Number(p && p.credits) || 0));
  if (credits <= 0) throw new Error('generateRedeemCodes: credits 必须 > 0');
  const expireDays = Math.max(0, Math.floor(Number(p && p.expireDays) || 0));
  const note = String((p && p.note) || '').slice(0, 200);
  const createdBy = String((p && p.createdBy) || '');
  const now = Date.now();
  const expireAt = expireDays > 0 ? now + expireDays * 86400000 : 0;
  const batchId = 'batch_' + crypto.randomBytes(6).toString('hex') + '_' + now.toString(36);

  const codes = [];
  const seen = new Set();
  let attempts = 0;
  while (codes.length < count && attempts < count * 5 + 20) {
    attempts++;
    const code = _genRedeemCode();
    if (seen.has(code)) continue;
    seen.add(code);
    stmtInsertRedeemCode.run({
      code, credits, batchId, createdBy, createdAt: now, expireAt, note,
    });
    // INSERT OR IGNORE 可能因主键冲突未插入，检查 lastInsertRowid 或直接信任 seen
    codes.push(code);
  }
  return { ok: true, batchId, codes, count: codes.length };
}

/**
 * 管理端：查询兑换码列表（支持状态/批次筛选 + 分页）
 * @param {Object} q { status, batchId, limit, offset }
 */
function listAllRedeemCodes(q) {
  const status = String((q && q.status) || '').trim();
  const batchId = String((q && q.batchId) || '').trim();
  const limit = Math.min(500, Math.max(1, Number(q && q.limit) || 50));
  const offset = Math.max(0, Number(q && q.offset) || 0);
  return stmtListAllRedeemCodes.all({ status, batchId, limit, offset }).map(r => ({
    code: r.code,
    credits: r.credits,
    batchId: r.batch_id,
    status: r.status,
    createdBy: r.created_by,
    createdAt: r.created_at,
    usedBy: r.used_by || '',
    usedByEmail: r.used_by_email || '',
    usedAt: r.used_at,
    expireAt: r.expire_at,
    note: r.note || '',
  }));
}

/** 管理端：统计兑换码数量（支持状态/批次筛选） */
function countAllRedeemCodes(q) {
  const status = String((q && q.status) || '').trim();
  const batchId = String((q && q.batchId) || '').trim();
  const r = stmtCountAllRedeemCodes.get({ status, batchId });
  return r ? r.cnt : 0;
}

/** 管理端：删除兑换码（仅允许删除未使用的） */
function deleteRedeemCode(code) {
  const info = stmtDeleteRedeemCode.run(String(code || ''));
  return { ok: info.changes > 0, changes: info.changes };
}

/** 管理端：兑换码状态统计（unused/used/expired 数量及总积分） */
function getRedeemStats() {
  const rows = stmtRedeemStatusStats.all();
  const stats = { unused: { count: 0, credits: 0 }, used: { count: 0, credits: 0 }, expired: { count: 0, credits: 0 } };
  for (const r of rows) {
    if (stats[r.status]) {
      stats[r.status].count = r.cnt;
      stats[r.status].credits = r.total_credits;
    }
  }
  return stats;
}

/**
 * 用户端：查询我已兑换的记录
 * @param {string} accountId 账号ID
 * @param {number} limit 每页数量
 * @param {number} offset 偏移量
 */
function listMyRedeemedCodes(accountId, limit, offset) {
  return stmtListMyRedeemedCodes.all(
    accountId,
    Math.min(100, Math.max(1, Number(limit) || 20)),
    Math.max(0, Number(offset) || 0)
  ).map(r => ({
    code: r.code,
    credits: r.credits,
    batchId: r.batch_id,
    usedAt: r.used_at,
    note: r.note || '',
  }));
}

/** 用户端：统计我已兑换的数量 */
function countMyRedeemedCodes(accountId) {
  const r = stmtCountMyRedeemedCodes.get(accountId);
  return r ? r.cnt : 0;
}

/**
 * 用户端：兑换码兑换积分（核心方法）
 * 事务内完成：占用兑换码 + 增加余额 + 记录流水
 * @param {Object} p { code, accountId }
 * @returns {Object} { ok, error?, credits?, balance?, flowId?, code? }
 */
function useRedeemCode(p) {
  const code = String((p && p.code) || '').trim().toUpperCase();
  const accountId = String((p && p.accountId) || '');
  if (!code) return { ok: false, error: 'EMPTY_CODE' };
  if (!accountId) return { ok: false, error: 'NO_ACCOUNT' };

  // 1. 查询兑换码（不做行锁，依靠 UPDATE 的 WHERE status='unused' 防并发）
  const row = stmtGetRedeemCode.get(code);
  if (!row) return { ok: false, error: 'NOT_FOUND' };
  if (row.status === 'used') return { ok: false, error: 'ALREADY_USED' };
  if (row.expire_at > 0 && row.expire_at < Date.now()) return { ok: false, error: 'EXPIRED' };

  // 2. 事务内：占用 + 加余额 + 写流水
  const mk = _monthKey(Date.now());
  const now = Date.now();
  const flowId = 'fl_' + crypto.randomBytes(12).toString('hex');

  const run = db.transaction(() => {
    // 原子占用：WHERE status='unused' 防止并发重复兑换
    const info = stmtUseRedeemCode.run(accountId, now, code);
    if (info.changes !== 1) return { conflict: true };

    // 确保余额记录存在
    stmtInsertBalance.run(accountId);
    // 增加余额（兑换不计入累计充值 total_recharged，只增 balance）
    stmtAddBalance.run(row.credits, 0, now, accountId);
    // 读取新余额
    const cur = stmtGetBalance.get(accountId);
    const newBalance = cur ? cur.balance : 0;
    // 写入积分流水
    stmtInsertFlow.run({
      flowId,
      accountId,
      type: 'charge',
      bizType: 'redeem',
      bizId: code,
      amount: row.credits,
      delta: row.credits,
      balanceAfter: newBalance,
      desc: `兑换码 ${code} 兑换 +${row.credits} 积分`,
      meta: JSON.stringify({ code, batchId: row.batch_id }),
      monthKey: mk,
      operatorAccountId: null,
      operatorEmail: null,
      createdAt: now,
    });
    return { balance: newBalance, flowId };
  });

  const r = run();
  // 并发冲突：被其他请求抢先兑换
  if (r.conflict) return { ok: false, error: 'ALREADY_USED' };

  return {
    ok: true,
    credits: row.credits,
    balance: r.balance,
    flowId: r.flowId,
    code,
  };
}

// ============================================================
// 公告相关方法
// ============================================================

/**
 * 管理端：新增公告
 * @param {Object} p { title, content, category, isPinned, isPublished, createdBy }
 */
function createNews(p) {
  const title = String((p && p.title) || '').trim();
  const content = String((p && p.content) || '');
  if (!title) throw new Error('createNews: title 必填');
  if (!content) throw new Error('createNews: content 必填');
  const category = ['system', 'activity', 'update'].includes(p && p.category)
    ? p.category : 'system';
  const isPinned = (p && p.isPinned) ? 1 : 0;
  const isPublished = (p && p.isPublished === false) ? 0 : 1;
  const createdBy = String((p && p.createdBy) || '');
  const now = Date.now();
  const newsId = 'news_' + crypto.randomBytes(8).toString('hex');
  stmtInsertNews.run({
    newsId, title, content, category, isPinned, isPublished,
    createdBy, createdAt: now, updatedAt: now,
    publishedAt: isPublished ? now : 0,
  });
  return { ok: true, newsId };
}

/**
 * 管理端：更新公告
 * @param {string} newsId 公告ID
 * @param {Object} data { title, content, category, isPinned, isPublished }
 */
function updateNews(newsId, data) {
  const title = String((data && data.title) || '').trim();
  const content = String((data && data.content) || '');
  if (!title) throw new Error('updateNews: title 必填');
  if (!content) throw new Error('updateNews: content 必填');
  const category = ['system', 'activity', 'update'].includes(data && data.category)
    ? data.category : 'system';
  const isPinned = (data && data.isPinned) ? 1 : 0;
  const isPublished = (data && data.isPublished === false) ? 0 : 1;
  const now = Date.now();
  // 若从草稿转为发布，published_at 设为当前时间；否则保持原值（用 COALESCE 语义）
  const publishedAt = isPublished ? now : 0;
  const info = stmtUpdateNews.run({
    newsId, title, content, category, isPinned, isPublished,
    updatedAt: now, publishedAt,
  });
  return { ok: info.changes > 0, changes: info.changes };
}

/** 管理端：删除公告 */
function deleteNews(newsId) {
  const info = stmtDeleteNews.run(String(newsId || ''));
  return { ok: info.changes > 0, changes: info.changes };
}

/** 管理端：查询所有公告（含草稿） */
function listAllNews(limit, offset) {
  return stmtListAllNews.all(
    Math.min(200, Math.max(1, Number(limit) || 50)),
    Math.max(0, Number(offset) || 0)
  ).map(r => ({
    newsId: r.news_id,
    title: r.title,
    content: r.content,
    category: r.category,
    isPinned: !!r.is_pinned,
    isPublished: !!r.is_published,
    viewCount: r.view_count,
    createdBy: r.created_by,
    createdByEmail: r.created_by_email || '',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    publishedAt: r.published_at,
  }));
}

/** 管理端：统计公告总数 */
function countAllNews() {
  const r = stmtCountAllNews.get();
  return r ? r.cnt : 0;
}

/** 用户端：查询已发布公告列表 */
function listPublishedNews(limit, offset) {
  return stmtListPublishedNews.all(
    Math.min(100, Math.max(1, Number(limit) || 20)),
    Math.max(0, Number(offset) || 0)
  ).map(r => ({
    newsId: r.news_id,
    title: r.title,
    content: r.content,
    category: r.category,
    isPinned: !!r.is_pinned,
    viewCount: r.view_count,
    publishedAt: r.published_at,
  }));
}

/** 用户端：统计已发布公告总数 */
function countPublishedNews() {
  const r = stmtCountPublishedNews.get();
  return r ? r.cnt : 0;
}

/** 用户端/管理端：查询单条公告详情 */
function getNewsById(newsId) {
  const r = stmtGetNewsById.get(String(newsId || ''));
  if (!r) return null;
  return {
    newsId: r.news_id,
    title: r.title,
    content: r.content,
    category: r.category,
    isPinned: !!r.is_pinned,
    isPublished: !!r.is_published,
    viewCount: r.view_count,
    createdAt: r.created_at,
    publishedAt: r.published_at,
  };
}

/** 用户端：浏览数 +1（仅在已发布时） */
function incrNewsView(newsId) {
  stmtIncrNewsView.run(String(newsId || ''));
}

/**
 * 将数据库行映射为兼容旧格式的流水对象
 * @param {Object} r 数据库行
 * @returns {Object} 兼容旧格式的流水对象
 */
function mapFlowRow(r) {
  return {
    flowId: r.flow_id,
    accountId: r.account_id,
    type: r.type,
    bizType: r.biz_type,
    bizId: r.biz_id,
    amount: r.amount,
    delta: r.delta,
    balanceAfter: r.balance_after,
    desc: r.description,
    meta: r.meta ? JSON.parse(r.meta) : {},
    month: r.month_key,
    monthKey: r.month_key,
    operatorAccountId: r.operator_account_id,
    operatorEmail: r.operator_email,
    createdAt: r.created_at,
  };
}

// ============================================================
// Web 会话操作
// ============================================================

/**
 * 签发新会话（替代 createWebSession）
 * @param {Object} account 账号信息
 * @returns {Object} { sid, expireAt }
 */
function createWebSession(account, sessionTtlMs) {
  const sid = 'sess_' + crypto.randomBytes(24).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  const now = Date.now();
  const ttl = sessionTtlMs || (7 * 24 * 60 * 60 * 1000);
  const expireAt = now + ttl;

  stmtInsertSession.run({
    sid,
    accountId: account.accountId,
    email: account.displayEmail || account.email || '',
    displayName: account.displayName || '',
    avatar: account.avatar || '',
    isAdmin: account.isAdmin ? 1 : 0,
    createdAt: now,
    expireAt,
  });

  return { sid, expireAt };
}

/**
 * 校验会话（替代 verifyWebSession，只读不删除）
 * @param {string} sid 会话ID
 * @returns {Object|null} 会话信息或 null（无效/过期）
 */
function verifyWebSession(sid) {
  if (!sid) return null;
  const r = stmtGetSession.get(sid);
  if (!r) return null;
  if (r.expire_at < Date.now()) return null; // 过期返回 null
  return {
    sid: r.sid,
    accountId: r.account_id,
    email: r.email,
    displayName: r.display_name,
    avatar: r.avatar,
    isAdmin: r.is_admin === 1,
    createdAt: r.created_at,
    expireAt: r.expire_at,
  };
}

/**
 * 销毁会话（替代 destroyWebSession）
 * @param {string} sid 会话ID
 */
function destroyWebSession(sid) {
  if (!sid) return;
  stmtDeleteSession.run(sid);
}

/**
 * 清理过期会话（替代定时清理任务中的逻辑）
 * @returns {number} 删除的会话数
 */
function cleanExpiredSessions() {
  const info = stmtDeleteExpiredSessions.run(Date.now());
  return info.changes;
}

// ============================================================
// 套餐操作
// ============================================================

/**
 * 读取所有上架套餐（替代 CREDIT_PACKAGES 硬编码常量）
 * @returns {Array} 套餐数组
 */
function getActivePackages() {
  const rows = stmtAllPackages.all();
  return rows.map(r => ({
    id: r.package_id,
    title: r.title,
    credits: r.credits,
    bonus: r.bonus_credits,
    bonusCredits: r.bonus_credits,
    priceCents: r.price_cents,
    tag: r.tag,
    desc: r.description,
  }));
}

// ============================================================
// 导出模块
// ============================================================
module.exports = {
  // 数据库实例（供 shared.js 直接使用）
  db,

  // 账号
  _readAccountsRawSafe,
  getAccountById,
  getAccountByEmail,
  updateLastLogin,

  // 积分余额
  readBalance,
  _readCreditsFileRaw,
  rechargeCredits,
  consumeCredits,
  adminAdjust,

  // 订单
  upsertOrder,
  listOrdersByAccount,
  _readOrdersFileRaw,
  getOrder,
  payOrder,

  // 积分流水
  _monthKey,
  _monthRangeKeys,
  readCreditFlowsByMonth,
  appendCreditFlow,
  listCreditFlows,
  countCreditFlows,
  countFlowsSince,

  // 签到
  getCheckinStatus,
  doCheckin,

  // 邀请好友
  getOrGenerateInviteCode,
  getInviterByCode,
  processInviteReward,
  listInviteRecords,
  getInviteStats,

  // 管理端
  listAllAccounts,
  countAllAccounts,
  listAllOrders,
  countAllOrders,
  listAllPackages,
  insertPackage,
  updatePackage,
  deletePackage,
  toggleAccountDisabled,
  setAdmin,
  adminResetPassword,

  // Web 会话
  createWebSession,
  verifyWebSession,
  destroyWebSession,
  cleanExpiredSessions,

  // 套餐
  getActivePackages,

  // 兑换码
  generateRedeemCodes,
  listAllRedeemCodes,
  countAllRedeemCodes,
  deleteRedeemCode,
  getRedeemStats,
  listMyRedeemedCodes,
  countMyRedeemedCodes,
  useRedeemCode,

  // 公告
  createNews,
  updateNews,
  deleteNews,
  listAllNews,
  countAllNews,
  listPublishedNews,
  countPublishedNews,
  getNewsById,
  incrNewsView,
};
