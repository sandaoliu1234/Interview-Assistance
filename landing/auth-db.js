'use strict';

/**
 * landing/auth-db.js —— SQLite 版 AuthService 替代模块
 *
 * 职责：
 *   完全替代 services/authService.js，将账号数据从 accounts.json 迁移到 SQLite。
 *   保持与 AuthService 相同的方法签名，使 shared.js 无缝切换。
 *
 * 实现的方法：
 *   - createAccount({ email, password, displayName, avatar, isAdmin })
 *   - verifyPassword(email, password)
 *   - _hashPassword(password, saltB64)
 *   - _verifyPassword(password, stored)
 *   - _readAccounts()          → 兼容旧格式 { version, accounts, accountsByEmail }
 *   - hasAnyAccount()
 *   - getAccount(accountId)
 *   - updateProfile(accountId, patch)
 *   - changePassword(accountId, oldPassword, newPassword)
 *   - forgotStep1GenerateResetCode(email)
 *   - forgotStep2ResetByCode(email, resetCode, newPassword)
 *
 * 不实现的方法（Electron 专用，Web 端不需要）：
 *   - issueSession / getCurrentUser / logoutCurrent / resolveAccountPath
 *   - safeStorage 加密（Web 端用 Cookie+web_sessions 表管理会话）
 *
 * 密码哈希：PBKDF2-SHA256，10 万次迭代，与原 AuthService 完全兼容
 */

const crypto = require('crypto');
const { db } = require('./db.js');

// ============================================================
// 密码哈希常量（与 authService.js 完全一致）
// ============================================================
const PBKDF2_ITER = 100000;
const PBKDF2_ALGO = 'sha256';
const SALT_BYTES = 16;
const HASH_BYTES = 64;

/** 重置码 TTL：15 分钟 */
const RESET_TTL_MS = 15 * 60 * 1000;

/** 游客账号 ID */
const GUEST_ACCOUNT_ID = '__guest__';

/** 邮箱格式（宽松版 RFC 5322） */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** 重置码字符集（排除 0/O/1/I 等易混字符） */
const RESET_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * 生成 8 位"人眼友好"的重置码
 * @param {number} len 长度，默认 8
 * @returns {string} 重置码
 */
function _genResetCode(len = 8) {
  let s = '';
  const arr = new Uint8Array(len);
  crypto.randomFillSync(arr);
  for (let i = 0; i < len; i++) s += RESET_CHARS[arr[i] % RESET_CHARS.length];
  return s;
}

// ============================================================
// 预编译 SQL 语句
// ============================================================

// 按 ID 查询账号
const stmtGetAccountById = db.prepare(`
  SELECT account_id, normalized_email, display_email, display_name, avatar, is_admin,
         pwd_algo, pwd_iter, pwd_salt, pwd_hash, reset_code, reset_expire_at, ext_id,
         created_at, last_login_ts
  FROM accounts WHERE account_id = ?
`);

// 按邮箱查询（normalized_email 已有 UNIQUE 索引）
const stmtGetAccountByEmail = db.prepare(`
  SELECT account_id, normalized_email, display_email, display_name, avatar, is_admin,
         pwd_algo, pwd_iter, pwd_salt, pwd_hash, reset_code, reset_expire_at, ext_id,
         created_at, last_login_ts
  FROM accounts WHERE normalized_email = ?
`);

// 查询所有账号（按创建时间倒序）
const stmtAllAccounts = db.prepare(`
  SELECT account_id, normalized_email, display_email, display_name, avatar, is_admin,
         pwd_algo, pwd_iter, pwd_salt, pwd_hash, reset_code, reset_expire_at, ext_id,
         created_at, last_login_ts
  FROM accounts ORDER BY created_at DESC
`);

// 插入新账号（INSERT OR IGNORE 保证邮箱唯一性）
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

// 更新最近登录时间
const stmtUpdateLastLogin = db.prepare(`
  UPDATE accounts SET last_login_ts = ? WHERE account_id = ?
`);

// 更新个人资料
const stmtUpdateProfile = db.prepare(`
  UPDATE accounts SET display_name = ?, avatar = ? WHERE account_id = ?
`);

// 更新密码
const stmtUpdatePassword = db.prepare(`
  UPDATE accounts SET pwd_salt = ?, pwd_hash = ?, reset_code = NULL, reset_expire_at = NULL
  WHERE account_id = ?
`);

// 设置重置码
const stmtSetResetCode = db.prepare(`
  UPDATE accounts SET reset_code = ?, reset_expire_at = ? WHERE account_id = ?
`);

// 清除重置码
const stmtClearResetCode = db.prepare(`
  UPDATE accounts SET reset_code = NULL, reset_expire_at = NULL WHERE account_id = ?
`);

// 统计账号数
const stmtCountAccounts = db.prepare(`SELECT COUNT(*) AS cnt FROM accounts`);

// ============================================================
// 工具函数：数据库行 → 兼容旧格式的账号对象
// ============================================================

/**
 * 将 SQLite 行映射为 AuthService 兼容格式的账号对象
 * @param {Object} r 数据库行
 * @returns {Object} 兼容旧格式的账号对象
 */
function mapAccountRow(r) {
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
}

// ============================================================
// AuthDB 类（替代 AuthService）
// ============================================================

class AuthDB {
  /**
   * 构造函数（参数与 AuthService 兼容，但 dataRoot 被忽略——数据在 SQLite）
   * @param {string} _dataRoot  忽略（保留参数兼容性）
   * @param {*} _electronSafeStorage  忽略（Web 端不需要）
   * @param {Object} opts { stateChangeListener }
   */
  constructor(_dataRoot, _electronSafeStorage, opts = {}) {
    this._onState = typeof (opts && opts.stateChangeListener) === 'function'
      ? opts.stateChangeListener : null;
    console.log('[auth-db] 账号数据已迁移至 SQLite');
  }

  /**
   * 密码哈希 → { algo, iter, salt(b64), hash(b64) }
   * @param {string} password 明文密码
   * @param {string} [saltB64] 可选 base64 编码的 salt（用于复验）
   * @returns {Object} 哈希结果
   */
  _hashPassword(password, saltB64) {
    const salt = saltB64 ? Buffer.from(saltB64, 'base64') : crypto.randomBytes(SALT_BYTES);
    const hash = crypto.pbkdf2Sync(String(password || ''), salt, PBKDF2_ITER, HASH_BYTES, PBKDF2_ALGO);
    return {
      algo: PBKDF2_ALGO,
      iter: PBKDF2_ITER,
      salt: salt.toString('base64'),
      hash: hash.toString('base64'),
    };
  }

  /**
   * 校验密码是否匹配
   * @param {string} password 待验证的明文密码
   * @param {Object} stored 存储的哈希 { algo, iter, salt, hash }
   * @returns {boolean} 是否匹配
   */
  _verifyPassword(password, stored) {
    if (!stored || typeof stored !== 'object') return false;
    const got = this._hashPassword(password, stored.salt);
    return (got.hash === stored.hash && got.algo === stored.algo && got.iter === stored.iter);
  }

  /**
   * 兼容旧接口：读取所有账号（返回 { version, accounts, accountsByEmail } 格式）
   * 供 shared.js 的 _readAccountsRawSafe() 调用
   * @returns {Object} 兼容旧格式的账号字典
   */
  _readAccounts() {
    const rows = stmtAllAccounts.all();
    const accounts = {};
    const accountsByEmail = {};
    for (const r of rows) {
      const acc = mapAccountRow(r);
      accounts[r.account_id] = acc;
      accountsByEmail[r.normalized_email] = r.account_id;
    }
    // 兼容旧代码的 _accountsCache 引用
    this._accountsCache = { version: 1, accounts, accountsByEmail, isLocked: {} };
    return this._accountsCache;
  }

  /**
   * 触发状态变更回调
   * @param {Object|null} user 用户信息
   */
  _emitStateChange(user) {
    if (this._onState) {
      try { this._onState(user || null); } catch (_) {}
    }
  }

  /**
   * 是否已有任何账号
   * @returns {boolean}
   */
  hasAnyAccount() {
    return stmtCountAccounts.get().cnt > 0;
  }

  /**
   * 创建新账号
   * @param {Object} p { email, password, displayName, avatar, isAdmin }
   * @returns {Object} { ok, accountId?, error? }
   */
  createAccount({ email, password, displayName, avatar, isAdmin }) {
    const em = String(email || '').trim();
    if (!EMAIL_RE.test(em)) return { ok: false, error: 'INVALID_EMAIL' };
    const pw = String(password || '');
    if (pw.length < 6) return { ok: false, error: 'WEAK_PASSWORD' };

    const normalizedEmail = em.toLowerCase();
    const displayEmail = em;

    // 检查邮箱是否已存在（SQLite UNIQUE 约束 + 预检查双重保障）
    const existing = stmtGetAccountByEmail.get(normalizedEmail);
    if (existing) return { ok: false, error: 'DUPLICATE_EMAIL' };

    const id = 'acc_' + crypto.randomBytes(6).toString('hex');
    const now = Date.now();
    const pwd = this._hashPassword(pw);

    const info = stmtInsertAccount.run({
      accountId: id,
      normalizedEmail,
      displayEmail,
      displayName: String(displayName || '').trim() || displayEmail.split('@')[0],
      avatar: String(avatar || '').trim() || '',
      isAdmin: isAdmin ? 1 : 0,
      pwdAlgo: pwd.algo,
      pwdIter: pwd.iter,
      pwdSalt: pwd.salt,
      pwdHash: pwd.hash,
      resetCode: null,
      resetExpireAt: null,
      extId: null,
      createdAt: now,
      lastLoginTs: 0,
    });

    if (info.changes === 0) return { ok: false, error: 'DUPLICATE_EMAIL' };

    this._emitStateChange();
    return { ok: true, accountId: id };
  }

  /**
   * 密码校验 + 更新最近登录时间
   * @param {string} email 邮箱
   * @param {string} password 明文密码
   * @returns {Object} { ok, accountId?, email?, displayName?, avatar?, error? }
   */
  verifyPassword(email, password) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!normalizedEmail) return { ok: false, error: 'USER_NOT_FOUND' };

    const row = stmtGetAccountByEmail.get(normalizedEmail);
    if (!row) return { ok: false, error: 'USER_NOT_FOUND' };

    const account = mapAccountRow(row);
    if (!this._verifyPassword(password, account.pwd)) {
      return { ok: false, error: 'BAD_PASSWORD' };
    }

    // 更新最近登录时间（原子操作）
    const now = Date.now();
    stmtUpdateLastLogin.run(now, row.account_id);

    return {
      ok: true,
      accountId: account.accountId,
      email: account.displayEmail,
      displayName: account.displayName,
      avatar: account.avatar || '',
      createdAt: account.createdAt,
      lastLoginTs: now,
      isAdmin: account.isAdmin,
    };
  }

  /**
   * 按邮箱查询账号（仅用于存在性检查，返回完整行数据）
   * @param {string} normalizedEmail 已规范化的邮箱（小写）
   * @returns {Object|null} 数据库行或 null
   */
  getAccountByEmail(normalizedEmail) {
    const email = String(normalizedEmail || '').trim().toLowerCase();
    if (!email) return null;
    return stmtGetAccountByEmail.get(email) || null;
  }

  /**
   * 获取指定账号完整资料（不含密码哈希和重置码）
   * @param {string} accountId 账号ID
   * @returns {Object|null} 账号信息
   */
  getAccount(accountId) {
    const row = stmtGetAccountById.get(String(accountId || '').trim());
    if (!row) return null;
    const acc = mapAccountRow(row);
    // 不返回 pwd / reset
    const { pwd, reset, ...safe } = acc;
    return safe;
  }

  /**
   * 修改个人资料（昵称/头像）
   * @param {string} accountId 账号ID
   * @param {Object} patch { displayName?, avatar? }
   * @returns {Object} { ok, user? }
   */
  updateProfile(accountId, patch = {}) {
    const id = String(accountId || '').trim();
    if (!id) return { ok: false, error: 'BAD_ACCOUNT_ID' };

    const row = stmtGetAccountById.get(id);
    if (!row) return { ok: false, error: 'USER_NOT_FOUND' };

    const newName = ('displayName' in patch)
      ? (String(patch.displayName || '').trim() || row.display_name) : row.display_name;
    const newAvatar = ('avatar' in patch)
      ? String(patch.avatar || '').trim() : row.avatar;

    stmtUpdateProfile.run(newName, newAvatar, id);
    this._emitStateChange();
    return { ok: true };
  }

  /**
   * 修改密码（需提供旧密码）
   * @param {string} accountId 账号ID
   * @param {string} oldPassword 旧密码
   * @param {string} newPassword 新密码
   * @returns {Object} { ok, error? }
   */
  changePassword(accountId, oldPassword, newPassword) {
    const id = String(accountId || '').trim();
    if (!id) return { ok: false, error: 'BAD_ACCOUNT_ID' };
    const npw = String(newPassword || '');
    if (npw.length < 6) return { ok: false, error: 'WEAK_PASSWORD' };

    const row = stmtGetAccountById.get(id);
    if (!row) return { ok: false, error: 'USER_NOT_FOUND' };

    const stored = { algo: row.pwd_algo, iter: row.pwd_iter, salt: row.pwd_salt, hash: row.pwd_hash };
    if (!this._verifyPassword(oldPassword, stored)) {
      return { ok: false, error: 'BAD_OLD_PASSWORD' };
    }

    const newPwd = this._hashPassword(npw);
    stmtUpdatePassword.run(newPwd.salt, newPwd.hash, id);
    this._emitStateChange();
    return { ok: true };
  }

  /**
   * 忘记密码 步骤1：生成 8 位重置码
   * @param {string} email 邮箱
   * @returns {Object} { ok, resetCode?, expireAt?, error? }
   */
  forgotStep1GenerateResetCode(email) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!normalizedEmail) return { ok: false, error: 'USER_NOT_FOUND' };

    const row = stmtGetAccountByEmail.get(normalizedEmail);
    if (!row) return { ok: false, error: 'USER_NOT_FOUND' };

    const code = _genResetCode(8);
    const expireAt = Date.now() + RESET_TTL_MS;
    stmtSetResetCode.run(code, expireAt, row.account_id);

    return { ok: true, resetCode: code, expireAt };
  }

  /**
   * 忘记密码 步骤2：重置码 + 新密码 → 更新密码
   * @param {string} email 邮箱
   * @param {string} resetCode 重置码
   * @param {string} newPassword 新密码
   * @returns {Object} { ok, error? }
   */
  forgotStep2ResetByCode(email, resetCode, newPassword) {
    const npw = String(newPassword || '');
    if (npw.length < 6) return { ok: false, error: 'WEAK_PASSWORD' };
    const code = String(resetCode || '').trim().toUpperCase();
    if (!code) return { ok: false, error: 'BAD_CODE' };

    const normalizedEmail = String(email || '').trim().toLowerCase();
    const row = stmtGetAccountByEmail.get(normalizedEmail);
    if (!row) return { ok: false, error: 'USER_NOT_FOUND' };

    if (!row.reset_code) return { ok: false, error: 'BAD_CODE' };
    if (row.reset_code.toUpperCase() !== code) return { ok: false, error: 'BAD_CODE' };
    if ((row.reset_expire_at || 0) < Date.now()) return { ok: false, error: 'CODE_EXPIRED' };

    const newPwd = this._hashPassword(npw);
    stmtUpdatePassword.run(newPwd.salt, newPwd.hash, row.account_id);
    this._emitStateChange();
    return { ok: true };
  }
}

// 导出（与 authService.js 的导出格式一致）
AuthDB.GUEST_ACCOUNT_ID = GUEST_ACCOUNT_ID;

module.exports = { AuthDB, GUEST_ACCOUNT_ID };
