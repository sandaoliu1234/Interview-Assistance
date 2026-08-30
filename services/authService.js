/**
 * services/authService.js —— 🔴 三端统一架构版本（读写 hireme.db 的 accounts + desktop_sessions 表）
 * ------------------------------------------------------------------
 * 本地账号鉴权核心（Electron 主进程内使用，不暴露给渲染层）。
 *
 * 🔴 【数据源变更】：
 *    旧版：读写 AppData 下两个 JSON 文件 accounts.json + auth-session.json
 *    新版：统一读写项目根/data/hireme.db（通过 services/common-paths.js 定位）
 *      - 账号：accounts 表（与 Landing 端共用同一张表，邮箱唯一性全局约束）
 *      - 会话：desktop_sessions 表（enc_token 仍经 Electron safeStorage 加密，每账号一行）
 *
 * 设计目标（兼容旧 public API，调用方 0 改动）：
 *   ① 本地账号注册表：accounts 表（pbkdf2 哈希密码，normalized_email 唯一索引）
 *   ② 登录会话：desktop_sessions 表（enc_token 加密存储，token_hash 做登出快速比对）
 *   ③ 多账号数据隔离：currentAccountId getter，供 session/resume/kb 模块拼路径
 *   ④ 忘记密码（本地无 SMTP 版）：8 位重置码（15 分钟 TTL）直接返回用户弹窗
 *   ⑤ 零新依赖：crypto/fs + Electron safeStorage + better-sqlite3（已通过 common-paths 打开）
 *
 * 说明：
 *   宣传网站尚未上线，因此桌面端继续允许用户"本地创建管理员账号"。
 *   账号与 Landing 端共享同一套：Landing 端先注册过的邮箱（例如默认管理员 15376110673@163.com）
 *   在桌面端同样可登录，反之亦然（INSERT OR IGNORE 语义保证"谁先创建谁权威"）。
 * ------------------------------------------------------------------
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

// ============================================================
// 🔴 三端统一数据源：hireme.db（accounts + desktop_sessions 两张表）
//    - 数据库句柄通过 common-paths.openUnifiedDatabase() 统一建立
//    - better-sqlite3 ABI 可能因 Electron/Node 运行时而不同，先从 landing 兜底再用项目根
// ============================================================
const {
  HIREME_DB_PATH,
  DATA_ROOT,
  LOGS_ROOT,
  openUnifiedDatabase,
} = require('./common-paths.js');

// Electron 主进程启动时，better-sqlite3 在项目根 node_modules（已为 Electron 重新编译过）
// Landing 模式下从 landing/node_modules 加载；构造函数中做一次"惰性初始化 db"。
let _sharedDb = null;

/**
 * 惰性获取 hireme.db 句柄（供 AuthService 内部同步方法使用）
 *   - 优先使用传入的 externalDb（main.js 统一注入的单例，Step 7 会做）
 *   - 其次命中 global.__HIREME_BETTER_SQLITE3_PATH__（main.js 主进程探测通过的那一份：避免 native 级 ABI 加载异常绕过 try/catch）
 *   - 否则按"运行环境自适应"顺序尝试两个候选：
 *       · Electron 主进程（process.versions.electron 存在）：先项目根 node_modules（Electron ABI 编译，ABI=128），再 landing（Node ABI 编译）
 *       · Node 运行时（landing 服务/脚本）：先 landing/node_modules（Node ABI 编译，如 131/137），再项目根
 */
function _acquireDb(externalDb) {
  if (externalDb) return externalDb;
  if (_sharedDb) return _sharedDb;
  let Database = null;
  // 1) 优先 global（main.js 主进程内联 ABI 探测通过的路径）
  const preferPath = (typeof global !== 'undefined' && global && typeof global.__HIREME_BETTER_SQLITE3_PATH__ === 'string')
    ? global.__HIREME_BETTER_SQLITE3_PATH__
    : '';
  const isElectronRuntime = !!(process && process.versions && process.versions.electron);
  const nodeFirst = [
    path.join(__dirname, '..', 'landing', 'node_modules', 'better-sqlite3'), // Node v24 ABI=131/137
    path.join(__dirname, '..', 'node_modules', 'better-sqlite3'),            // Electron ABI=128
  ];
  const electronFirst = [
    path.join(__dirname, '..', 'node_modules', 'better-sqlite3'),            // Electron ABI=128（electron-rebuild 过的）
    path.join(__dirname, '..', 'landing', 'node_modules', 'better-sqlite3'), // Node ABI（兜底）
  ];
  const candidates = (preferPath ? [preferPath] : []).concat(isElectronRuntime ? electronFirst : nodeFirst);
  let lastErr = null;
  for (const p of candidates) {
    try { delete require.cache[require.resolve(p)]; } catch (_) {}
    try { Database = require(p); break; } catch (e) { lastErr = e; }
  }
  if (!Database) {
    console.error('[AuthService] ❌ 无法加载 better-sqlite3：', lastErr && lastErr.message);
    throw lastErr || new Error('better-sqlite3 not found');
  }
  const { db, ready, error } = openUnifiedDatabase(Database);
  if (!ready) throw error || new Error('openUnifiedDatabase failed');
  _sharedDb = db;
  return _sharedDb;
}

/** 密码哈希：迭代次数 / 算法 / salt 长度 / hash 长度（PBKDF2 —— 与 Landing auth-db.js 完全一致） */
const PBKDF2_ITER = 100000;
const PBKDF2_ALGO = 'sha256';
const SALT_BYTES = 16;
const HASH_BYTES = 64;

/** 会话 TTL（毫秒）：7 天（与 Landing 端 SESSION_TTL 一致） */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 重置码 TTL：15 分钟 */
const RESET_TTL_MS = 15 * 60 * 1000;

/** 游客账号 ID：未登录时所有数据落此命名空间（与 accounts 表 DEFAULT '__guest__' 对应） */
const GUEST_ACCOUNT_ID = '__guest__';

/** 重置码字符集：排除 0/O/1/I 等易混字符 */
const RESET_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function _genResetCode(len = 8) {
  let s = '';
  const arr = new Uint8Array(len);
  crypto.randomFillSync(arr);
  for (let i = 0; i < len; i++) s += RESET_CHARS[arr[i] % RESET_CHARS.length];
  return s;
}

/** 邮箱格式（宽松版 RFC 5322） */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class AuthService {
  /**
   * 构造函数（参数 100% 与旧版兼容，可直接 drop-in 替换）
   * @param {string}  userDataRoot          userData/interview-assistant 目录（仅用于 accounts/ 子目录、不再存 JSON）
   * @param {object}  electronSafeStorage   Electron.safeStorage（主进程）
   * @param {object}  [opts]
   * @param {(user:object)=>void} [opts.stateChangeListener] 登录/登出/创建时触发
   * @param {object} [opts.externalDb]        main.js 统一注入的 hireme.db 句柄（Step 7 启用后可减少 1 次 new Database）
   * @param {object} [opts.accountsDir]      可选：自定义 accounts 子目录（兼容旧调用）
   */
  constructor(userDataRoot, electronSafeStorage, opts = {}) {
    if (!userDataRoot) throw new Error('[AuthService] userDataRoot 不能为空');
    this._root = userDataRoot;
    /** Electron safeStorage（可能不可用，内部兜底 AES-256-GCM 派生密钥） */
    this._ss = electronSafeStorage || null;

    // —— 兼容旧参数：不再使用 accounts.json / auth-session.json，但仍保留目录创建（
    //    桌面端 resume.md 仍在 userData/accounts/{id}/ 下，故不删除 _accountsDir）
    this._accountsDir = opts.accountsDir || path.join(this._root, 'accounts');
    for (const d of [this._root, this._accountsDir]) {
      if (!fs.existsSync(d)) { try { fs.mkdirSync(d, { recursive: true }); } catch (_) {} }
    }

    /** 外部注入的 hireme.db 句柄（main.js 统一建立） */
    this._externalDb = opts.externalDb || null;

    /** 状态变更回调（供主进程广播到渲染层） */
    this._onState = typeof opts.stateChangeListener === 'function' ? opts.stateChangeListener : null;
    /** 内存态缓存：{ user, ts }；每 2s 失效，避免每次 getCurrentUser 都查 2 条 SQL */
    this._memCache = { user: null, ts: 0, ttl: 2000 };

    // safeStorage 不可用时的本地派生密钥 fallback（至少不是明文）
    // 派生密钥只在内存里，不写磁盘；重启后会变（会话因此失效，用户需重新登录）
    this._fallbackKey = null;
    if (!this._isSafeStorageAvailable()) {
      const seed = (process.platform + ':' + process.env.COMPUTERNAME + ':' + process.env.USERPROFILE + ':hireme-auth-v1');
      this._fallbackKey = crypto.scryptSync(seed, 'hireme-salt-v1', 32);
    }

    // 保证 __guest__ 账号存在于 accounts 表（桌面端游客模式使用）—— INSERT OR IGNORE
    try {
      const db = this._db();
      db.prepare(`
        INSERT OR IGNORE INTO accounts
          (account_id, normalized_email, display_email, display_name, avatar, is_admin,
           pwd_algo, pwd_iter, pwd_salt, pwd_hash, created_at, last_login_ts)
        VALUES (?, '', '', '游客', '', 0, 'sha256', 100000, '', '', 0, 0)
      `).run(GUEST_ACCOUNT_ID);
    } catch (e) {
      console.warn('[AuthService] 预置 __guest__ 账号失败（通常是缺列，会被 db.js _safeAddColumn 修复）：', e.message);
    }
  }

  /* ====================================================================
   * 基础工具：密码哈希 / safeStorage 兜底 / SQLite 句柄获取
   * ==================================================================== */

  /** 获取 hireme.db 句柄（优先 main.js 注入的单例） */
  _db() { return _acquireDb(this._externalDb); }

  /** safeStorage 是否可用（极少数用户禁用 DPAPI/Keychain 时为 false） */
  _isSafeStorageAvailable() {
    if (!this._ss || typeof this._ss.isEncryptionAvailable !== 'function') return false;
    try { return !!this._ss.isEncryptionAvailable(); } catch (_) { return false; }
  }

  /** 加密字符串：优先 safeStorage，否则 fallback 到 aes-256-gcm。结果 JSON 序列化后存 desktop_sessions.enc_token */
  _encryptStr(plain) {
    const p = String(plain || '');
    if (this._isSafeStorageAvailable()) {
      const buf = this._ss.encryptString(p);
      return { v: 1, b64: Buffer.isBuffer(buf) ? buf.toString('base64') : String(buf) };
    }
    // fallback：aes-256-gcm
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this._fallbackKey, iv);
    const ct = Buffer.concat([cipher.update(p, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return { v: 2, iv: iv.toString('base64'), tag: tag.toString('base64'), ct: ct.toString('base64') };
  }

  /** 解密字符串：对应 _encryptStr */
  _decryptStr(box) {
    if (!box) return null;
    // 字段可能来自 JSON（desktop_sessions.enc_token TEXT → 先 parse 成对象）
    const obj = (typeof box === 'string') ? (() => { try { return JSON.parse(box); } catch (_) { return null; } })() : box;
    if (!obj || typeof obj !== 'object') return null;
    try {
      if (obj.v === 1) {
        if (!this._isSafeStorageAvailable()) return null;
        return this._ss.decryptString(Buffer.from(obj.b64, 'base64'));
      }
      if (obj.v === 2 && this._fallbackKey) {
        const iv = Buffer.from(obj.iv, 'base64');
        const tag = Buffer.from(obj.tag, 'base64');
        const ct = Buffer.from(obj.ct, 'base64');
        const d = crypto.createDecipheriv('aes-256-gcm', this._fallbackKey, iv);
        d.setAuthTag(tag);
        return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
      }
    } catch (_) { /* ignore */ }
    return null;
  }

  /** 密码哈希 → { algo, iter, salt(b64), hash(b64) }（与 landing/auth-db.js 100% 同算法同参数） */
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

  /** 校验密码是否匹配（传入旧 JSON 版 {pwd} 或 新版 accounts 行 4 列 pwd_* 拆分字段都 OK） */
  _verifyPassword(password, stored) {
    if (!stored) return false;
    // 旧 JSON 版：stored = { algo, iter, salt, hash }
    if (stored.salt && stored.hash) {
      const got = this._hashPassword(password, stored.salt);
      return (got.hash === stored.hash && got.algo === stored.algo && got.iter === stored.iter);
    }
    // 新版 DB 版：stored = { pwd_algo, pwd_iter, pwd_salt, pwd_hash }
    if (stored.pwd_salt && stored.pwd_hash) {
      const got = this._hashPassword(password, stored.pwd_salt);
      return (got.hash === stored.pwd_hash
        &&   (got.algo === stored.pwd_algo)
        &&   (got.iter === Number(stored.pwd_iter)));
    }
    return false;
  }

  /** 内存缓存失效（登录/登出/创建/改资料都会清） */
  _invalidateCache() {
    this._memCache.user = null;
    this._memCache.ts = 0;
  }

  /** 触发状态变更监听（主进程 → broadcastToAllViews） */
  _emitStateChange(user) {
    this._invalidateCache();
    if (this._onState) {
      try { this._onState(user || this.getCurrentUser()); } catch (_) {}
    }
  }

  /* ====================================================================
   * 账号表 CRUD（替代旧版 _readAccounts / _writeAccounts + 内存遍历）
   * ==================================================================== */

  /** 从 accounts 表按 normalized_email（小写邮箱）查；返回整行或 null */
  _findByEmail(email) {
    const e = String(email || '').toLowerCase();
    if (!e) return null;
    const db = this._db();
    const row = db.prepare(`
      SELECT account_id, normalized_email, display_email, display_name, avatar, is_admin,
             pwd_algo, pwd_iter, pwd_salt, pwd_hash,
             reset_code, reset_expire_at, ext_id, created_at, last_login_ts,
             is_disabled, disabled_reason
        FROM accounts WHERE normalized_email = ?
    `).get(e);
    return row || null;
  }

  /** 从 accounts 表按 account_id 查；返回整行或 null */
  _findById(accountId) {
    const id = String(accountId || '');
    if (!id) return null;
    const db = this._db();
    const row = db.prepare(`
      SELECT account_id, normalized_email, display_email, display_name, avatar, is_admin,
             pwd_algo, pwd_iter, pwd_salt, pwd_hash,
             reset_code, reset_expire_at, ext_id, created_at, last_login_ts,
             is_disabled, disabled_reason
        FROM accounts WHERE account_id = ?
    `).get(id);
    return row || null;
  }

  /** SQLite 行 → 旧版兼容 account 对象（用于 verifyPassword 返回、getCurrentUser 返回等） */
  _rowToAccount(r) {
    if (!r) return null;
    return {
      accountId:     r.account_id,
      normalizedEmail: r.normalized_email,
      displayEmail:  r.display_email,
      email:         r.display_email,
      displayName:   r.display_name || r.display_email.split('@')[0],
      avatar:        r.avatar || '',
      isAdmin:       Number(r.is_admin) === 1,
      isDisabled:    Number(r.is_disabled) === 1,
      disabledReason:r.disabled_reason || '',
      // 新版 4 列拆分哈希（_verifyPassword 新分支专门处理）
      pwd: { algo: r.pwd_algo, iter: Number(r.pwd_iter), salt: r.pwd_salt, hash: r.pwd_hash },
      reset: r.reset_code ? { code: r.reset_code, expireAt: r.reset_expire_at, used: false } : null,
      extId: r.ext_id || null,
      createdAt:     Number(r.created_at) || 0,
      lastLoginTs:   Number(r.last_login_ts) || 0,
    };
  }

  /* ====================================================================
   * 对外 API（方法签名 100% 兼容旧 JSON 版 —— main.js 不用改任何调用代码）
   * ==================================================================== */

  /**
   * 是否已经有任何管理员/普通账号（游客 __guest__ 不计入，用于判断是否是首次启动）
   * @returns {boolean}
   */
  hasAnyAccount() {
    const db = this._db();
    try {
      const r = db.prepare("SELECT COUNT(*) AS cnt FROM accounts WHERE account_id != ?").get(GUEST_ACCOUNT_ID);
      return (Number(r && r.cnt) || 0) > 0;
    } catch (e) {
      console.warn('[AuthService][hasAnyAccount] SQL 失败：', e.message);
      return false;
    }
  }

  /**
   * 创建一个本地账号（管理员引导 / 宣传网站导入都走这里）
   *   - INSERT OR IGNORE 语义：若邮箱已在 Landing 端注册过（normalized_email 唯一），返回 DUPLICATE_EMAIL
   *   - 与 Landing 端共用同一 accounts 表：谁先创建谁权威
   * @param {{email:string,password:string,displayName?:string,avatar?:string,isAdmin?:boolean}} p
   * @returns {{ok:boolean, accountId?:string, error?:string}}
   *          error: INVALID_EMAIL / WEAK_PASSWORD / DUPLICATE_EMAIL
   */
  createAccount({ email, password, displayName, avatar, isAdmin }) {
    const em = String(email || '').trim();
    if (!EMAIL_RE.test(em)) return { ok: false, error: 'INVALID_EMAIL' };
    const pw = String(password || '');
    if (pw.length < 6) return { ok: false, error: 'WEAK_PASSWORD' };

    const normalizedEmail = em.toLowerCase();
    const displayEmail = em;
    const id = 'acc_' + crypto.randomBytes(6).toString('hex');
    const now = Date.now();
    const pwd = this._hashPassword(pw);

    const db = this._db();
    try {
      const info = db.prepare(`
        INSERT OR IGNORE INTO accounts
          (account_id, normalized_email, display_email, display_name, avatar, is_admin,
           pwd_algo, pwd_iter, pwd_salt, pwd_hash, created_at, last_login_ts)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      `).run(
        id, normalizedEmail, displayEmail,
        String(displayName || '').trim() || displayEmail.split('@')[0],
        String(avatar || '').trim() || '',
        isAdmin ? 1 : 0,
        pwd.algo, pwd.iter, pwd.salt, pwd.hash, now
      );
      if (!info || info.changes === 0) {
        // 冲突 → normalized_email 已存在（桌面端本地或 Landing 端先注册）
        return { ok: false, error: 'DUPLICATE_EMAIL' };
      }
    } catch (e) {
      // UNIQUE 约束失败也走这里（兼容旧 better-sqlite3）
      if (String(e.message || '').includes('UNIQUE')) return { ok: false, error: 'DUPLICATE_EMAIL' };
      return { ok: false, error: 'EXCEPTION:' + e.message };
    }

    // 为账号创建 userData/accounts/{id} 目录（resume.md / 知识库附件继续存文件系统）
    try {
      const d = path.join(this._accountsDir, id);
      if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    } catch (_) { /* ignore */ }

    this._emitStateChange();
    return { ok: true, accountId: id };
  }

  /**
   * 账号密码校验 + 更新最近登录时间（写 accounts.last_login_ts）
   * @param {string} email
   * @param {string} password
   * @returns {{ok:boolean, accountId?:string, email?:string, displayName?:string, avatar?:string, error?:'USER_NOT_FOUND'|'BAD_PASSWORD'}}
   */
  verifyPassword(email, password) {
    const row = this._findByEmail(email);
    if (!row) return { ok: false, error: 'USER_NOT_FOUND' };
    if (!this._verifyPassword(password, row)) return { ok: false, error: 'BAD_PASSWORD' };
    // 更新 lastLoginTs
    const now = Date.now();
    try {
      this._db().prepare('UPDATE accounts SET last_login_ts = ? WHERE account_id = ?').run(now, row.account_id);
    } catch (_) { /* 忽略失败，不影响登录 */ }
    const acc = this._rowToAccount(row);
    return {
      ok: true,
      accountId:     acc.accountId,
      email:         acc.displayEmail,
      displayName:   acc.displayName,
      avatar:        acc.avatar,
      createdAt:     acc.createdAt,
      lastLoginTs:   now,
    };
  }

  /**
   * 登录：密码校验通过后签发会话（写 desktop_sessions 表）
   * @param {string} email
   * @param {string} password
   */
  login(email, password) {
    const v = this.verifyPassword(email, password);
    if (!v.ok) return v;
    const issued = this.issueSession(v.accountId);
    if (!issued.ok) return { ok: false, error: issued.error || 'SESSION_FAILED' };
    const user = this.getCurrentUser();
    this._emitStateChange(user);
    return { ok: true, user };
  }

  /**
   * 为指定账号签发一个登录会话（UPSERT 到 desktop_sessions 表，每账号最多一行有效会话）
   */
  issueSession(accountId) {
    try {
      const id = String(accountId || '').trim();
      if (!id) return { ok: false, error: 'BAD_ACCOUNT_ID' };
      const token = crypto.randomBytes(32).toString('base64');
      const now = Date.now();
      const expireAt = now + SESSION_TTL_MS;
      const encTokenObj = this._encryptStr(token);
      const encToken = JSON.stringify(encTokenObj);
      const tokenHash = crypto.createHash('sha256').update(token).digest('base64');

      const db = this._db();
      // INSERT OR REPLACE：每账号只有一行（主键 account_id），重新登录会立即覆盖旧会话
      db.prepare(`
        INSERT OR REPLACE INTO desktop_sessions
          (account_id, enc_token, token_hash, created_at, expire_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(id, encToken, tokenHash, now, expireAt);

      this._invalidateCache();
      return { ok: true, expireAt };
    } catch (e) {
      console.error('[AuthService][issueSession] 异常：', e.message);
      return { ok: false, error: 'EXCEPTION:' + e.message };
    }
  }

  /**
   * 当前登录用户信息（无登录态时仍返回 { loggedIn:false, accountId:'__guest__' }）
   *   - 1) 从 desktop_sessions 按 accountId 找唯一有效会话（若当前是某账号，可多账号场景下先查当前缓存的账号）
   *   - 2) 由于 desktop_sessions 主键是 account_id，直接 SELECT * 取行 WHERE expire_at >= now，
   *        然后按 enc_token 解密验证通过再返回账号信息
   *   - 3) 若桌面端存在多个账号会话：取"到期最晚"的那个作为当前活跃会话（兼容旧 auth-session.json 单会话语义）
   */
  getCurrentUser() {
    const now = Date.now();
    if (this._memCache.user && (now - this._memCache.ts) < this._memCache.ttl) {
      return this._memCache.user;
    }
    const guestUser = { loggedIn: false, accountId: GUEST_ACCOUNT_ID };
    try {
      const db = this._db();
      // 取"最新过期的"一条有效会话（最多一行，兼容旧版单一会话语义）
      const sessRow = db.prepare(`
        SELECT account_id, enc_token, token_hash, created_at, expire_at
          FROM desktop_sessions
         WHERE expire_at >= ?
         ORDER BY expire_at DESC
         LIMIT 1
      `).get(now);
      if (!sessRow) {
        this._memCache.user = guestUser;
        this._memCache.ts = now;
        return guestUser;
      }
      // 解密 enc_token：失败 → 会话损坏 → 清掉
      const decrypted = this._decryptStr(sessRow.enc_token);
      if (!decrypted) {
        try { db.prepare('DELETE FROM desktop_sessions WHERE account_id = ?').run(sessRow.account_id); } catch (_) {}
        this._memCache.user = guestUser;
        this._memCache.ts = now;
        return guestUser;
      }
      // token_hash 校验（防御性：确保 enc_token 解密后仍与插入时的 token 一致；不一致则当会话损坏处理）
      const gotHash = crypto.createHash('sha256').update(decrypted).digest('base64');
      if (gotHash !== sessRow.token_hash) {
        try { db.prepare('DELETE FROM desktop_sessions WHERE account_id = ?').run(sessRow.account_id); } catch (_) {}
        this._memCache.user = guestUser;
        this._memCache.ts = now;
        return guestUser;
      }
      // 查账号信息
      const accRow = this._findById(sessRow.account_id);
      if (!accRow) {
        this._memCache.user = guestUser;
        this._memCache.ts = now;
        return guestUser;
      }
      const acc = this._rowToAccount(accRow);
      const user = {
        loggedIn: true,
        accountId:     acc.accountId,
        email:         acc.displayEmail,
        displayName:   acc.displayName,
        avatar:        acc.avatar,
        isAdmin:       !!acc.isAdmin,
        createdAt:     acc.createdAt,
        lastLoginTs:   acc.lastLoginTs,
        sessionExpireAt: Number(sessRow.expire_at) || 0,
      };
      this._memCache.user = user;
      this._memCache.ts = now;
      return user;
    } catch (e) {
      console.warn('[AuthService][getCurrentUser] 读会话失败：', e.message);
      return guestUser;
    }
  }

  /** 当前"路径使用"的账号 ID：已登录=accountId；未登录=__guest__ */
  get currentAccountId() {
    const u = this.getCurrentUser();
    return u.accountId || GUEST_ACCOUNT_ID;
  }

  /** 退出登录（清 desktop_sessions 当前活跃行；若多账号则全部清，避免遗留） */
  logoutCurrent() {
    try {
      const db = this._db();
      // 安全起见：清所有过期行 + 如果当前有活跃会话也一并清
      db.prepare('DELETE FROM desktop_sessions WHERE expire_at < ?').run(Date.now());
      // 再清一行最新有效的（如果有）—— 对应"当前用户"
      const s = db.prepare(`
        SELECT account_id FROM desktop_sessions ORDER BY expire_at DESC LIMIT 1
      `).get();
      if (s) db.prepare('DELETE FROM desktop_sessions WHERE account_id = ?').run(s.account_id);
      const user = this.getCurrentUser(); // { loggedIn:false, accountId:'__guest__' }
      this._emitStateChange(user);
      return true;
    } catch (e) {
      console.error('[AuthService][logoutCurrent] 异常：', e.message);
      return false;
    }
  }

  /* ======================== 忘记密码（两步本地版） ======================== */

  /**
   * 忘记密码 步骤1：输入邮箱 → 生成 8 位一次性重置码并返回（桌面端弹窗显示）
   *   - 写入 accounts.reset_code / reset_expire_at（不用再写 accounts.json）
   */
  forgotStep1GenerateResetCode(email) {
    const row = this._findByEmail(email);
    if (!row) return { ok: false, error: 'USER_NOT_FOUND' };
    const code = _genResetCode(8);
    const expireAt = Date.now() + RESET_TTL_MS;
    try {
      this._db().prepare(
        'UPDATE accounts SET reset_code = ?, reset_expire_at = ? WHERE account_id = ?'
      ).run(code, expireAt, row.account_id);
    } catch (e) {
      return { ok: false, error: 'EXCEPTION:' + e.message };
    }
    this._invalidateCache();
    return { ok: true, resetCode: code, expireAt };
  }

  /**
   * 忘记密码 步骤2：邮箱+重置码+新密码 → 更新密码哈希 & 清重置码 & 踢会话
   */
  forgotStep2ResetByCode(email, resetCode, newPassword) {
    const pw = String(newPassword || '');
    if (pw.length < 6) return { ok: false, error: 'WEAK_PASSWORD' };
    const code = String(resetCode || '').trim().toUpperCase();
    if (!code) return { ok: false, error: 'BAD_CODE' };
    const row = this._findByEmail(email);
    if (!row) return { ok: false, error: 'USER_NOT_FOUND' };
    if (!row.reset_code) return { ok: false, error: 'BAD_CODE' };
    if (String(row.reset_code).toUpperCase() !== code) return { ok: false, error: 'BAD_CODE' };
    if ((Number(row.reset_expire_at) || 0) < Date.now()) return { ok: false, error: 'CODE_EXPIRED' };

    // 通过 → 更新 4 列 pwd_*；清 reset_code / reset_expire_at
    const pwd = this._hashPassword(pw);
    try {
      this._db().prepare(`
        UPDATE accounts SET
          pwd_algo = ?, pwd_iter = ?, pwd_salt = ?, pwd_hash = ?,
          reset_code = NULL, reset_expire_at = NULL
        WHERE account_id = ?
      `).run(pwd.algo, pwd.iter, pwd.salt, pwd.hash, row.account_id);
      // 踢会话：清该账号在 desktop_sessions 中的行
      this._db().prepare('DELETE FROM desktop_sessions WHERE account_id = ?').run(row.account_id);
    } catch (e) {
      return { ok: false, error: 'EXCEPTION:' + e.message };
    }
    this._emitStateChange();
    return { ok: true };
  }

  /* ======================== 账号设置（改密码 / 改资料） ======================== */

  /**
   * 已登录用户修改密码（需提供旧密码）
   */
  changePassword(accountId, oldPassword, newPassword) {
    const id = String(accountId || '').trim();
    if (!id) return { ok: false, error: 'BAD_ACCOUNT_ID' };
    const npw = String(newPassword || '');
    if (npw.length < 6) return { ok: false, error: 'WEAK_PASSWORD' };
    const row = this._findById(id);
    if (!row) return { ok: false, error: 'USER_NOT_FOUND' };
    if (!this._verifyPassword(oldPassword, row)) return { ok: false, error: 'BAD_OLD_PASSWORD' };

    const pwd = this._hashPassword(npw);
    try {
      this._db().prepare(`
        UPDATE accounts SET pwd_algo = ?, pwd_iter = ?, pwd_salt = ?, pwd_hash = ? WHERE account_id = ?
      `).run(pwd.algo, pwd.iter, pwd.salt, pwd.hash, id);
      // 踢会话：清该账号行
      this._db().prepare('DELETE FROM desktop_sessions WHERE account_id = ?').run(id);
    } catch (e) {
      return { ok: false, error: 'EXCEPTION:' + e.message };
    }
    this._emitStateChange();
    return { ok: true };
  }

  /**
   * 修改个人资料（昵称/头像）
   */
  updateProfile(accountId, patch = {}) {
    const id = String(accountId || '').trim();
    if (!id) return { ok: false, error: 'BAD_ACCOUNT_ID' };
    const row = this._findById(id);
    if (!row) return { ok: false, error: 'USER_NOT_FOUND' };
    const newDisplayName = 'displayName' in patch
      ? (String(patch.displayName || '').trim() || row.display_name)
      : row.display_name;
    const newAvatar = 'avatar' in patch ? String(patch.avatar || '').trim() : (row.avatar || '');
    try {
      this._db().prepare(
        'UPDATE accounts SET display_name = ?, avatar = ? WHERE account_id = ?'
      ).run(newDisplayName, newAvatar, id);
    } catch (e) {
      return { ok: false, error: 'EXCEPTION:' + e.message };
    }
    const user = this.getCurrentUser();
    this._emitStateChange(user);
    return { ok: true, user };
  }

  /**
   * 获取指定账号完整资料（用于个人中心只读展示）
   * @returns {null|object}
   */
  getAccount(accountId) {
    const row = this._findById(accountId);
    if (!row) return null;
    const a = this._rowToAccount(row);
    // 不返回 pwd / reset 敏感字段（_rowToAccount 里 pwd 保留是为了 _verifyPassword，此处再剥掉）
    const { pwd, reset, ...safe } = a;
    return safe;
  }

  /**
   * 给账号拼子路径（userData/accounts/{accountId}/xxx）—— 保留旧方法签名，兼容 resume.md / 知识库等仍存文件系统的模块
   * 如果账号目录不存在会创建；不传 accountId 自动用当前登录账号
   */
  resolveAccountPath(accountIdOrNull, ...sub) {
    const id = String(accountIdOrNull || this.currentAccountId || GUEST_ACCOUNT_ID);
    const base = path.join(this._accountsDir, id, ...sub);
    const dir = sub.length ? path.dirname(base) : base;
    if (!fs.existsSync(dir)) { try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {} }
    return base;
  }
}

/** 游客账号 ID 常量导出（供其它模块复用） */
AuthService.GUEST_ACCOUNT_ID = GUEST_ACCOUNT_ID;

module.exports = { AuthService, GUEST_ACCOUNT_ID };
