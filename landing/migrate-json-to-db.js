'use strict';

/**
 * landing/migrate-json-to-db.js —— JSON 数据迁移到 SQLite 脚本
 *
 * 职责：
 *   读取现有 JSON 文件（accounts.json / credits.json / orders.json /
 *   web-sessions.json / credit-flows/*.json），将数据导入 SQLite 表。
 *
 * 用法：
 *   node migrate-json-to-db.js           # 执行迁移
 *   node migrate-json-to-db.js --dry-run # 只打印不写入
 *
 * 安全特性：
 *   - 幂等：重复运行不会产生重复数据（使用 INSERT OR IGNORE）
 *   - 事务：每类数据在单独事务中导入，部分失败不影响已成功部分
 *   - 预检：迁移前检查 db.js 是否已初始化所有表
 */

const path = require('path');
const fs = require('fs');

// 引入 db.js（会自动建表+初始化套餐）
const { db, DB_PATH, DATA_ROOT } = require('./db.js');

// ============================================================
// 路径常量（与 shared.js 保持一致）
// ============================================================
const CREDIT_FLOWS_DIR  = path.join(DATA_ROOT, 'credit-flows');
const CREDITS_PATH      = path.join(DATA_ROOT, 'credits.json');
const ORDERS_PATH       = path.join(DATA_ROOT, 'orders.json');
const ACCOUNTS_PATH     = path.join(DATA_ROOT, 'accounts.json');
const WEB_SESSIONS_PATH = path.join(DATA_ROOT, 'web-sessions.json');

// 命令行参数：--dry-run 只预览不写入
const DRY_RUN = process.argv.includes('--dry-run');

// ============================================================
// 工具函数
// ============================================================

/**
 * 安全读取 JSON 文件
 * @param {string} fpath 文件路径
 * @param {*} fallback 不存在或解析失败时的默认值
 * @returns {*} 解析后的对象或 fallback
 */
function readJsonSafe(fpath, fallback) {
  if (!fs.existsSync(fpath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(fpath, 'utf8'));
  } catch (e) {
    console.warn(`  ⚠️  解析失败：${fpath} — ${e.message}`);
    return fallback;
  }
}

/** 统计对象/数组元素数量 */
function countKeys(obj) { return obj && typeof obj === 'object' ? Object.keys(obj).length : 0; }
function countArr(arr) { return Array.isArray(arr) ? arr.length : 0; }

// ============================================================
// 迁移统计
// ============================================================
const stats = {
  accounts:      { total: 0, imported: 0, skipped: 0 },
  creditBalances:{ total: 0, imported: 0, skipped: 0 },
  orders:        { total: 0, imported: 0, skipped: 0 },
  creditFlows:   { total: 0, imported: 0, skipped: 0 },
  webSessions:   { total: 0, imported: 0, skipped: 0 },
};

// ============================================================
// 1. 迁移 accounts.json → accounts 表
// ============================================================
function migrateAccounts() {
  console.log('\n📋 [1/5] 迁移账号数据 (accounts.json → accounts) ...');
  const doc = readJsonSafe(ACCOUNTS_PATH, { version: 1, accounts: {} });
  const accounts = (doc.accounts || doc.accountsById || {});
  const ids = Object.keys(accounts);
  stats.accounts.total = ids.length;
  if (ids.length === 0) { console.log('  (空)'); return; }

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO accounts
      (account_id, normalized_email, display_email, display_name, avatar, is_admin,
       pwd_algo, pwd_iter, pwd_salt, pwd_hash, reset_code, reset_expire_at, ext_id,
       created_at, last_login_ts)
    VALUES
      (@accountId, @normalizedEmail, @displayEmail, @displayName, @avatar, @isAdmin,
       @pwdAlgo, @pwdIter, @pwdSalt, @pwdHash, @resetCode, @resetExpireAt, @extId,
       @createdAt, @lastLoginTs)
  `);

  const insertAll = db.transaction((rows) => {
    for (const r of rows) {
      const info = stmt.run(r);
      if (info.changes > 0) stats.accounts.imported++;
      else stats.accounts.skipped++;
    }
  });

  const rows = ids.map((id) => {
    const a = accounts[id];
    const pwd = a.pwd || {};
    const reset = a.reset || null;
    return {
      accountId:       a.accountId || id,
      normalizedEmail: a.normalizedEmail || String(a.displayEmail || a.email || '').toLowerCase(),
      displayEmail:    a.displayEmail || a.email || '',
      displayName:     a.displayName || '',
      avatar:          a.avatar || '',
      isAdmin:         a.isAdmin ? 1 : 0,
      pwdAlgo:         pwd.algo || 'sha256',
      pwdIter:         pwd.iter || 100000,
      pwdSalt:         pwd.salt || '',
      pwdHash:         pwd.hash || '',
      resetCode:       reset ? (reset.code || null) : null,
      resetExpireAt:   reset ? (Number(reset.expireAt) || null) : null,
      extId:           a.extId || null,
      createdAt:       Number(a.createdAt) || Date.now(),
      lastLoginTs:     Number(a.lastLoginTs) || 0,
    };
  });

  if (!DRY_RUN) insertAll(rows);
  else stats.accounts.imported = rows.length; // dry-run 模式只计数

  console.log(`  共 ${stats.accounts.total} 条，导入 ${stats.accounts.imported}，跳过 ${stats.accounts.skipped}`);
}

// ============================================================
// 2. 迁移 credits.json → credit_balances 表
// ============================================================
function migrateCreditBalances() {
  console.log('\n💰 [2/5] 迁移积分余额 (credits.json → credit_balances) ...');
  const doc = readJsonSafe(CREDITS_PATH, { version: 1, balances: {} });
  const balances = doc.balances || {};
  const ids = Object.keys(balances);
  stats.creditBalances.total = ids.length;
  if (ids.length === 0) { console.log('  (空)'); return; }

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO credit_balances
      (account_id, balance, total_recharged, total_consumed, updated_at)
    VALUES
      (@accountId, @balance, @totalRecharged, @totalConsumed, @updatedAt)
  `);

  const insertAll = db.transaction((rows) => {
    for (const r of rows) {
      const info = stmt.run(r);
      if (info.changes > 0) stats.creditBalances.imported++;
      else stats.creditBalances.skipped++;
    }
  });

  const rows = ids.map((id) => {
    const b = balances[id];
    return {
      accountId:      id,
      balance:        Number(b.balance) || 0,
      totalRecharged: Number(b.totalRecharged) || 0,
      totalConsumed:  Number(b.totalConsumed) || 0,
      updatedAt:      Number(b.updatedAt) || 0,
    };
  });

  if (!DRY_RUN) insertAll(rows);
  else stats.creditBalances.imported = rows.length;

  console.log(`  共 ${stats.creditBalances.total} 条，导入 ${stats.creditBalances.imported}，跳过 ${stats.creditBalances.skipped}`);
}

// ============================================================
// 3. 迁移 orders.json → orders 表
// ============================================================
function migrateOrders() {
  console.log('\n📦 [3/5] 迁移订单数据 (orders.json → orders) ...');
  const doc = readJsonSafe(ORDERS_PATH, { version: 1, orders: {} });
  const orders = doc.orders || {};
  const ids = Object.keys(orders);
  stats.orders.total = ids.length;
  if (ids.length === 0) { console.log('  (空)'); return; }

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO orders
      (order_id, account_id, package_id, package_name, credits, bonus,
       price_cents, status, channel, created_at, paid_at, cancelled_at, meta)
    VALUES
      (@orderId, @accountId, @packageId, @packageName, @credits, @bonus,
       @priceCents, @status, @channel, @createdAt, @paidAt, @cancelledAt, @meta)
  `);

  const insertAll = db.transaction((rows) => {
    for (const r of rows) {
      const info = stmt.run(r);
      if (info.changes > 0) stats.orders.imported++;
      else stats.orders.skipped++;
    }
  });

  const rows = ids.map((id) => {
    const o = orders[id];
    return {
      orderId:     o.orderId || id,
      accountId:   o.accountId || '',
      packageId:   o.packageId || '',
      packageName: o.packageName || '',
      credits:     Number(o.credits) || 0,
      bonus:       Number(o.bonus) || 0,
      priceCents:  Number(o.priceCents) || 0,
      status:      o.status || 'pending',
      channel:     o.channel || '',
      createdAt:   Number(o.createdAt) || 0,
      paidAt:      Number(o.paidAt) || 0,
      cancelledAt: Number(o.cancelledAt) || 0,
      meta:        o.meta ? JSON.stringify(o.meta) : null,
    };
  });

  if (!DRY_RUN) insertAll(rows);
  else stats.orders.imported = rows.length;

  console.log(`  共 ${stats.orders.total} 条，导入 ${stats.orders.imported}，跳过 ${stats.orders.skipped}`);
}

// ============================================================
// 4. 迁移 credit-flows/*.json → credit_flows 表
// ============================================================
function migrateCreditFlows() {
  console.log('\n📊 [4/5] 迁移积分流水 (credit-flows/*.json → credit_flows) ...');

  // 扫描所有月份文件
  let files = [];
  try {
    files = fs.readdirSync(CREDIT_FLOWS_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();
  } catch (_) {}
  if (files.length === 0) { console.log('  (无月份文件)'); return; }

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO credit_flows
      (flow_id, account_id, type, biz_type, biz_id, amount, delta,
       balance_after, description, meta, month_key,
       operator_account_id, operator_email, created_at)
    VALUES
      (@flowId, @accountId, @type, @bizType, @bizId, @amount, @delta,
       @balanceAfter, @desc, @meta, @monthKey,
       @operatorAccountId, @operatorEmail, @createdAt)
  `);

  // 每个月份文件单独事务
  for (const fn of files) {
    const monthKey = fn.replace(/\.json$/, '');
    const fpath = path.join(CREDIT_FLOWS_DIR, fn);
    const doc = readJsonSafe(fpath, { version: 1, flows: [] });
    const flows = Array.isArray(doc.flows) ? doc.flows : [];
    stats.creditFlows.total += flows.length;

    if (flows.length === 0) continue;

    const rows = flows.map((f) => ({
      flowId:            f.flowId || ('fl_' + (f.createdAt || Date.now()) + Math.random().toString(36).slice(2, 6)),
      accountId:         f.accountId || '',
      type:              f.type || 'adjust',
      bizType:           f.bizType || '',
      bizId:             f.bizId || '',
      amount:            Number(f.amount ?? f.delta) || 0,
      delta:             Number(f.delta) || 0,
      balanceAfter:      Number(f.balanceAfter) || 0,
      desc:              f.desc || '',
      meta:              f.meta ? JSON.stringify(f.meta) : null,
      monthKey:          f.month || monthKey,
      operatorAccountId: f.operatorAccountId || null,
      operatorEmail:     f.operatorEmail || null,
      createdAt:         Number(f.createdAt) || 0,
    }));

    const insertBatch = db.transaction((batch) => {
      for (const r of batch) {
        const info = stmt.run(r);
        if (info.changes > 0) stats.creditFlows.imported++;
        else stats.creditFlows.skipped++;
      }
    });

    if (!DRY_RUN) insertBatch(rows);
    else stats.creditFlows.imported += rows.length;

    console.log(`  ${fn}: ${rows.length} 条`);
  }

  console.log(`  合计：共 ${stats.creditFlows.total} 条，导入 ${stats.creditFlows.imported}，跳过 ${stats.creditFlows.skipped}`);
}

// ============================================================
// 5. 迁移 web-sessions.json → web_sessions 表
// ============================================================
function migrateWebSessions() {
  console.log('\n🔑 [5/5] 迁移 Web 会话 (web-sessions.json → web_sessions) ...');
  const doc = readJsonSafe(WEB_SESSIONS_PATH, { version: 1, sessions: {} });
  const sessions = doc.sessions || {};
  const sids = Object.keys(sessions);
  stats.webSessions.total = sids.length;
  if (sids.length === 0) { console.log('  (空)'); return; }

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO web_sessions
      (sid, account_id, email, display_name, avatar, is_admin,
       created_at, expire_at)
    VALUES
      (@sid, @accountId, @email, @displayName, @avatar, @isAdmin,
       @createdAt, @expireAt)
  `);

  const insertAll = db.transaction((rows) => {
    for (const r of rows) {
      const info = stmt.run(r);
      if (info.changes > 0) stats.webSessions.imported++;
      else stats.webSessions.skipped++;
    }
  });

  const now = Date.now();
  const rows = sids.map((sid) => {
    const s = sessions[sid];
    return {
      sid:        s.sid || sid,
      accountId:  s.accountId || '',
      email:      s.email || '',
      displayName:s.displayName || '',
      avatar:     s.avatar || '',
      isAdmin:    s.isAdmin ? 1 : 0,
      createdAt:  Number(s.createdAt) || 0,
      expireAt:   Number(s.expireAt) || 0,
    };
  }).filter(r => r.expireAt > now); // 跳过已过期会话

  if (!DRY_RUN) insertAll(rows);
  else stats.webSessions.imported = rows.length;

  const expiredCount = sids.length - rows.length;
  console.log(`  共 ${stats.webSessions.total} 条，导入 ${stats.webSessions.imported}（跳过 ${expiredCount} 条已过期），重复跳过 ${stats.webSessions.skipped}`);
}

// ============================================================
// 主流程
// ============================================================
console.log('==============================================');
console.log('   JSON → SQLite 数据迁移工具');
console.log('==============================================');
console.log(`  数据库：${DB_PATH}`);
console.log(`  数据源：${DATA_ROOT}`);
console.log(`  模式：${DRY_RUN ? '🔍 预览（--dry-run，不写入）' : '✅ 实际写入'}`);
console.log('');

try {
  // 执行迁移（顺序：账号 → 余额 → 订单 → 流水 → 会话）
  migrateAccounts();
  migrateCreditBalances();
  migrateOrders();
  migrateCreditFlows();
  migrateWebSessions();

  // 打印汇总
  console.log('\n==============================================');
  console.log('   迁移完成汇总');
  console.log('==============================================');
  console.log(`  账号      : ${stats.accounts.imported}/${stats.accounts.total} 导入，${stats.accounts.skipped} 跳过`);
  console.log(`  积分余额  : ${stats.creditBalances.imported}/${stats.creditBalances.total} 导入，${stats.creditBalances.skipped} 跳过`);
  console.log(`  订单      : ${stats.orders.imported}/${stats.orders.total} 导入，${stats.orders.skipped} 跳过`);
  console.log(`  积分流水  : ${stats.creditFlows.imported}/${stats.creditFlows.total} 导入，${stats.creditFlows.skipped} 跳过`);
  console.log(`  Web会话   : ${stats.webSessions.imported}/${stats.webSessions.total} 导入，${stats.webSessions.skipped} 跳过`);
  console.log('==============================================\n');

  // 迁移后验证：查询各表行数
  const tableCount = db.prepare(`
    SELECT 'accounts' AS tbl, COUNT(*) AS cnt FROM accounts
    UNION ALL SELECT 'credit_balances', COUNT(*) FROM credit_balances
    UNION ALL SELECT 'orders', COUNT(*) FROM orders
    UNION ALL SELECT 'credit_flows', COUNT(*) FROM credit_flows
    UNION ALL SELECT 'web_sessions', COUNT(*) FROM web_sessions
    UNION ALL SELECT 'packages', COUNT(*) FROM packages
  `).all();

  console.log('  数据库表行数验证：');
  for (const row of tableCount) {
    console.log(`    ${row.tbl.padEnd(20)} ${row.cnt} 行`);
  }
  console.log('');

} catch (e) {
  console.error('\n❌ 迁移失败：', e.message);
  console.error(e.stack);
  process.exit(1);
}
