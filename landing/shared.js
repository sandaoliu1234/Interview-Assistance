/**
 * landing/shared.js —— 用户端 / 管理员端 双服务共享模块
 *
 * 职责：
 *   提取 user-server.js 和 admin-server.js 共同使用的所有：
 *     - 路径常量、数据存储初始化
 *     - AuthDB 实例（账号密码哈希/验证，数据存 SQLite）
 *     - SQLite 数据访问层（积分余额/流水/订单/会话）
 *     - Web 会话管理
 *     - 积分余额/流水/订单的全部业务逻辑
 *     - HTTP 工具（解析、Cookie、响应、静态文件）
 *     - 鉴权辅助（_requireLogin、_requireAdmin）
 *     - 默认管理员账号初始化
 *
 * 数据存储：全部使用 SQLite（通过 db-layer.js + auth-db.js），
 * 不再使用任何 JSON 文件存储业务数据。
 */
'use strict';

// ===== Node 原生模块 =====
const http   = require('http');
const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');
const urlLib = require('url');

// ============================================================
// 简易 .env 解析器（替代 dotenv，支持 KEY=VALUE / # 注释 / 引号）
// ============================================================
(function loadDotEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  try {
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const idx = line.indexOf('='); if (idx < 0) continue;
      let k = line.substring(0, idx).trim();
      let v = line.substring(idx + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (typeof process.env[k] === 'undefined') process.env[k] = v;
    }
    console.log('[shared] 已读取 .env');
  } catch (e) { console.warn('[shared] .env 读取失败：', e.message); }
})();

// ============================================================
// 加载 SQLite 版 AuthDB（替代原 authService.js）
// ============================================================
const { AuthDB } = require('./auth-db.js');

// ============================================================
// SQLite 数据访问层（替代 JSON 文件存储）
// ============================================================
const DAL = require('./db-layer.js');

// ============================================================
// 路径常量（三端统一：从 services/common-paths.js 获取，确保数据都落到项目根/data）
//   - Landing 端用户/管理员服务：所有 SQLite/音频/日志文件路径统一从此模块拿
//   - LANDING_ROOT = __dirname（只用于定位 public/ 静态资源目录，不再拼接数据路径）
// ============================================================
const LANDING_ROOT = __dirname;
const PUBLIC_DIR   = path.join(LANDING_ROOT, 'public');
// 🟢 三端统一数据根：项目根/data（不再是 landing/data）
const {
  DATA_ROOT,
  LOGS_ROOT,
  HIREME_DB_PATH,
} = require('../services/common-paths.js');
const ADMIN_PORT   = Number(process.env.ADMIN_PORT) || 3001;
const USER_PORT    = Number(process.env.LANDING_PORT) || 3000;
const SESSION_TTL  = (Number(process.env.LANDING_SESSION_TTL) || 7 * 24 * 60 * 60) * 1000;

// ============================================================
// 初始化目录（PUBLIC_DIR 仍需创建；data/ 与 logs/ 已由 common-paths.js 管理）
// ============================================================
for (const d of [PUBLIC_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// ============================================================
// AuthDB 实例（账号数据存储在 SQLite，hireme.db accounts 表）
//   - 构造函数的第一个参数 dataRoot 在 auth-db.js 中已被忽略（兼容保留）
//   - 真正的 SQLite 句柄来自 auth-db.js → require('./db.js') → hireme.db
// ============================================================
const auth = new AuthDB(DATA_ROOT, null, { stateChangeListener: null });
console.log(`[shared] ✅ 三端统一数据目录：DATA_ROOT=${DATA_ROOT}`);
console.log(`[shared] ✅ 统一数据库：HIREME_DB_PATH=${HIREME_DB_PATH}`);
console.log('[shared] 账号/积分/订单/流水/会话/面试记录 已全部迁移至 hireme.db');

// ============================================================
// 【积分流水】工具集 —— 委托给 DAL（SQLite）
// ============================================================

/** 根据时间戳返回所属月份 key（YYYY-MM） */
function _monthKey(ts) { return DAL._monthKey(ts); }

/** 计算月份闭区间内所有月份 key */
function _monthRangeKeys(fromMonth, toMonth) { return DAL._monthRangeKeys(fromMonth, toMonth); }

/** 读某个月份的所有流水（委托给 DAL） */
function readCreditFlowsByMonth(monthKey) {
  return DAL.readCreditFlowsByMonth(monthKey);
}

/** 追加一条积分流水（委托给 DAL，SQLite 事务保证原子性） */
function appendCreditFlow(flow) {
  return Promise.resolve(DAL.appendCreditFlow(flow));
}

/** 查询某账号在指定月份区间内的所有流水（委托给 DAL，SQL 索引查询） */
function listCreditFlows(accountId, fromMonth, toMonth, opts) {
  return DAL.listCreditFlows(accountId, fromMonth, toMonth, opts);
}

/** 统计流水总数（用于分页） */
function countCreditFlows(accountId, fromMonth, toMonth, opts) {
  return DAL.countCreditFlows(accountId, fromMonth, toMonth, opts);
}

// ============================================================
// 套餐 & 价目表
// ============================================================

/** 从 SQLite packages 表读取上架套餐（首次调用缓存） */
let _packagesCache = null;
function getCreditPackages() {
  if (!_packagesCache) _packagesCache = DAL.getActivePackages();
  return _packagesCache;
}
const CREDIT_PACKAGES = getCreditPackages();

const CREDIT_PRICE_LIST = {
  COPILOT_PER_SESSION: 5,
  MOCK_PER_ROUND:     3,
  RESUME_OPTIMIZE:    10,
};

// ============================================================
// 积分余额读写 —— 委托给 DAL（SQLite 事务保证原子性）
// ============================================================

/** 读某个账号当前积分余额 */
function readBalance(accountId) {
  return DAL.readBalance(accountId);
}

/** 充值（SQLite 事务：余额更新 + 流水记录原子完成） */
function rechargeCredits(p) {
  return Promise.resolve(DAL.rechargeCredits(p));
}

/** 写订单 */
function upsertOrder(order) {
  return Promise.resolve(DAL.upsertOrder(order));
}

/** 读订单列表 */
function listOrdersByAccount(accountId, limit) {
  return DAL.listOrdersByAccount(accountId, limit);
}

// ============================================================
// 新增：扣费 / 管理员调账 / 支付订单（DAL 事务版）
// ============================================================

/** 扣减积分（WHERE balance >= ? 防止并发超扣） */
function consumeCredits(p) {
  return DAL.consumeCredits(p);
}

/** 管理员手工调账 */
function adminAdjust(p) {
  return DAL.adminAdjust(p);
}

/** 支付订单（事务：更新订单状态 + 增加余额 + 写流水） */
function payOrder(p) {
  return DAL.payOrder(p);
}

/** 按订单号查询订单 */
function getOrder(orderId) {
  return DAL.getOrder(orderId);
}

// ============================================================
// 读取原始数据辅助
// ============================================================

/**
 * 读取所有账号（从 SQLite 读取，兼容旧格式返回）
 * 替代原来的 accounts.json 读取逻辑
 */
function _readAccountsRawSafe() {
  // auth._readAccounts() 返回 { version, accounts, accountsByEmail, isLocked }
  // 并更新 auth._accountsCache
  return auth._readAccounts();
}

/** 读取积分余额（委托给 DAL） */
function _readCreditsFileRaw() {
  return DAL._readCreditsFileRaw();
}

/** 读取订单（委托给 DAL） */
function _readOrdersFileRaw() {
  return DAL._readOrdersFileRaw();
}

// ============================================================
// Web 会话管理 —— 委托给 DAL（SQLite）
// ============================================================

/** 签发新会话（委托给 DAL） */
function createWebSession(account) {
  return Promise.resolve(DAL.createWebSession(account, SESSION_TTL));
}

/** 校验 sid（只读模式，不删除会话，委托给 DAL） */
function verifyWebSession(sid) {
  return Promise.resolve(DAL.verifyWebSession(sid));
}

/** 销毁会话（委托给 DAL） */
function destroyWebSession(sid) {
  return Promise.resolve(DAL.destroyWebSession(sid));
}

/** 定时清理过期会话（每 10 分钟，委托给 DAL 的 DELETE 语句） */
const _cleanupTimer = setInterval(() => {
  try {
    const deleted = DAL.cleanExpiredSessions();
    if (deleted > 0) console.log(`[shared] 清理了 ${deleted} 条过期会话`);
  } catch (e) {
    console.error('[shared] 清理会话失败：', e.message);
  }
}, 10 * 60 * 1000);
_cleanupTimer.unref();

// ============================================================
// HTTP 工具
// ============================================================

/** MIME 类型映射 */
const MIME_MAP = {
  '.html':  'text/html; charset=utf-8',
  '.htm':   'text/html; charset=utf-8',
  '.js':    'application/javascript; charset=utf-8',
  '.mjs':   'application/javascript; charset=utf-8',
  '.css':   'text/css; charset=utf-8',
  '.json':  'application/json; charset=utf-8',
  '.png':   'image/png',
  '.jpg':   'image/jpeg',
  '.jpeg':  'image/jpeg',
  '.gif':   'image/gif',
  '.svg':   'image/svg+xml',
  '.ico':   'image/x-icon',
  '.woff':  'font/woff',
  '.woff2': 'font/woff2',
  '.ttf':   'font/ttf',
  '.txt':   'text/plain; charset=utf-8',
};

/** 从 Readable 中读取完整 body */
function readRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const MAX = maxBytes || 200 * 1024;
    const chunks = []; let total = 0;
    let done = false;
    req.on('data', (chunk) => {
      if (done) return;
      total += chunk.length;
      if (total > MAX) {
        done = true;
        const err = new Error('请求体过大 (max ' + Math.round(MAX/1024) + 'KB)');
        err.code = 'BODY_TOO_BIG';
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (e) => { if (!done) { done = true; reject(e); } });
  });
}

/** 解析 application/json 与 application/x-www-form-urlencoded */
async function parseBody(req) {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const buf  = await readRawBody(req);
  if (!buf || buf.length === 0) return {};
  try {
    if (type === 'application/json') {
      return JSON.parse(buf.toString('utf8'));
    }
    if (type === 'application/x-www-form-urlencoded') {
      const out = {};
      for (const pair of buf.toString('utf8').split('&')) {
        if (!pair) continue;
        const eq = pair.indexOf('=');
        const k = decodeURIComponent(eq < 0 ? pair : pair.substring(0, eq));
        const v = decodeURIComponent(eq < 0 ? '' : pair.substring(eq + 1).replace(/\+/g, ' '));
        if (k) out[k] = v;
      }
      return out;
    }
  } catch (e) {
    const err = new Error('Body 解析失败：' + e.message);
    err.code = 'BAD_BODY';
    throw err;
  }
  return {};
}

/** Cookie 解析 */
function parseCookies(req) {
  const out = {};
  const raw = String(req.headers && req.headers.cookie || '');
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const idx = part.indexOf('='); if (idx < 0) continue;
    const k = decodeURIComponent(part.substring(0, idx).trim());
    const v = decodeURIComponent(part.substring(idx + 1).trim());
    if (k) out[k] = v;
  }
  return out;
}

/** 从请求中取出 sid */
function extractSid(req) {
  const cookies = parseCookies(req);
  if (cookies && cookies.hireme_sid) return String(cookies.hireme_sid);
  const auth = String(req.headers && req.headers.authorization || '');
  const m = auth.match(/^Bearer\s+([A-Za-z0-9\-_]+)$/i);
  return m ? m[1] : '';
}

/** 发送 JSON 响应 */
function sendJSON(res, status, obj, extraHeaders) {
  const body = Buffer.from(JSON.stringify(obj || {}), 'utf8');
  const heads = Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'X-Content-Type-Options': 'nosniff',
  }, extraHeaders || {});
  res.writeHead(status, heads);
  res.end(body);
}

/** 构建 HttpOnly Cookie */
function buildSetCookie(name, value, opts) {
  const parts = [
    encodeURIComponent(name) + '=' + encodeURIComponent(value || ''),
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (opts && typeof opts.maxAgeSec === 'number') parts.push('Max-Age=' + Math.max(0, opts.maxAgeSec));
  return parts.join('; ');
}

/** 设置会话 Cookie */
function setSessionCookie(res, sid, expireAtMs) {
  const sec = Math.max(0, Math.round((expireAtMs - Date.now()) / 1000));
  const existing = res.getHeader ? res.getHeader('Set-Cookie') : null;
  const cookie = buildSetCookie('hireme_sid', sid, { maxAgeSec: sec });
  if (existing) {
    const arr = Array.isArray(existing) ? existing.slice() : [existing];
    arr.push(cookie);
    res.setHeader('Set-Cookie', arr);
  } else {
    res.setHeader('Set-Cookie', cookie);
  }
}

/** 清除会话 Cookie */
function clearSessionCookie(res) {
  const existing = res.getHeader ? res.getHeader('Set-Cookie') : null;
  const cookie = buildSetCookie('hireme_sid', '', { maxAgeSec: 0 });
  if (existing) {
    const arr = Array.isArray(existing) ? existing.slice() : [existing];
    arr.push(cookie);
    res.setHeader('Set-Cookie', arr);
  } else {
    res.setHeader('Set-Cookie', cookie);
  }
}

// ============================================================
// 错误码
// ============================================================
const ERROR_TEXT = {
  INVALID_EMAIL:    ['邮箱格式不正确', 400],
  WEAK_PASSWORD:    ['密码太弱，至少需要 6 个字符', 400],
  DUPLICATE_EMAIL:  ['该邮箱已被注册，请直接登录或换一个邮箱', 409],
  USER_NOT_FOUND:   ['邮箱不存在，请先注册', 401],
  BAD_PASSWORD:     ['密码错误，请重试', 401],
  BAD_CODE:         ['重置码无效', 400],
  CODE_EXPIRED:     ['重置码已过期，请重新获取', 400],
  SESSION_FAILED:   ['会话创建失败，请稍后重试', 500],
};

// ============================================================
// 默认管理员账号初始化（通过 AuthDB 写入 SQLite，替代原 accounts.json 写入）
// ============================================================
(function ensureDefaultAdminAccountSync() {
  try {
    const ADMIN_EMAIL = '15376110673@163.com';
    const ADMIN_PASS  = '123456';
    const ADMIN_NAME  = '超级管理员';

    // 通过 AuthDB 直接查询是否已存在该邮箱，避免重复创建
    const normalizedEmail = ADMIN_EMAIL.toLowerCase();
    const existing = auth.getAccountByEmail ? auth.getAccountByEmail(normalizedEmail) : null;
    if (existing) {
      // 已存在则跳过
      return;
    }

    // 通过 AuthDB 创建账号（密码哈希、唯一性约束均由 AuthDB 内部处理）
    const r = auth.createAccount({
      email: ADMIN_EMAIL,
      password: ADMIN_PASS,
      displayName: ADMIN_NAME,
      avatar: '',
      isAdmin: true,
    });
    if (r.ok) {
      console.log(`[shared] ✅ 已预置默认管理员账号：${ADMIN_EMAIL} / ${ADMIN_PASS}（accountId=${r.accountId}）`);
    } else if (r.error === 'DUPLICATE_EMAIL') {
      // 并发情况下已被创建，忽略
    } else {
      console.error('[shared] 预置默认管理员账号失败：', r.error);
    }
  } catch (e) {
    console.error('[shared] 预置默认管理员账号失败：', e.message || e);
  }
})();

// ============================================================
// 鉴权辅助
// ============================================================

/** 统一登录校验 */
async function _requireLogin(req, res) {
  const sid = extractSid(req);
  const sess = await verifyWebSession(sid);
  if (!sess || !sess.accountId) {
    clearSessionCookie(res);
    sendJSON(res, 401, { ok: false, msg: '未登录或登录已过期，请先登录', code: 'NOT_LOGGED_IN' });
    return null;
  }
  return { sess, accountId: sess.accountId };
}

/** 管理员鉴权（通过 AuthDB 从 SQLite 读取账号） */
async function _requireAdmin(req, res) {
  const userAuth = await _requireLogin(req, res);
  if (!userAuth) return null;
  let account = null;
  try {
    // 通过 AuthDB 从 SQLite 查询账号（替代原 accounts.json 读取）
    account = auth.getAccount(userAuth.accountId) || null;
  } catch (_) { account = null; }
  if (!account || account.isAdmin !== true) {
    sendJSON(res, 403, { ok: false, msg: '无权访问：仅管理员可使用此接口', code: 'FORBIDDEN' });
    return null;
  }
  return { ...userAuth, account };
}

// ============================================================
// 静态文件服务
// ============================================================

/** 解析安全静态路径 */
function safeResolveStatic(urlPathname, publicDir) {
  let rel = decodeURIComponent((urlPathname || '/').replace(/^\/+/, ''));
  if (!rel) rel = 'index.html';
  if (rel.endsWith('/')) rel += 'index.html';
  const abs = path.normalize(path.join(publicDir, rel));
  if (abs.indexOf(publicDir) !== 0) return null;
  return abs;
}

/** 发送静态文件 */
function sendStatic(res, filePath, publicDir) {
  fs.stat(filePath, (err, st) => {
    if (!err && st.isDirectory()) {
      return sendStatic(res, path.join(filePath, 'index.html'), publicDir);
    }
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
      const fallback = path.join(publicDir, 'index.html');
      fs.readFile(fallback, (e2, data) => {
        if (e2) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('404 - 页面不存在');
          return;
        }
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': data.length });
        res.end(data);
      });
      return;
    }
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('500 - 读取文件失败');
      return;
    }
    const ext  = path.extname(filePath).toLowerCase();
    const mime = MIME_MAP[ext] || 'application/octet-stream';
    fs.readFile(filePath, (e2, data) => {
      if (e2) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('500 - 读取文件失败');
        return;
      }
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': data.length,
        'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=0',
      });
      res.end(data);
    });
  });
}

// ============================================================
// 导出所有共享模块
// ============================================================
module.exports = {
  // 路径常量（三端统一版）
  LANDING_ROOT, PUBLIC_DIR, DATA_ROOT, LOGS_ROOT, HIREME_DB_PATH,
  USER_PORT, ADMIN_PORT, SESSION_TTL,

  // 实例
  auth,
  DAL,  // 暴露 DAL 供 user-server.js / admin-server.js 直接使用

  // 积分流水（委托 DAL）
  _monthKey, _monthRangeKeys,
  readCreditFlowsByMonth, appendCreditFlow, listCreditFlows, countCreditFlows,

  // 套餐
  CREDIT_PACKAGES, CREDIT_PRICE_LIST, getCreditPackages,

  // 余额/订单（委托 DAL）
  readBalance, rechargeCredits, upsertOrder, listOrdersByAccount,
  // 新增：事务版操作
  consumeCredits, adminAdjust, payOrder, getOrder,

  // 原始数据读取
  _readAccountsRawSafe, _readCreditsFileRaw, _readOrdersFileRaw,

  // 会话（委托 DAL）
  createWebSession, verifyWebSession, destroyWebSession,

  // HTTP 工具
  MIME_MAP, readRawBody, parseBody, parseCookies, extractSid,
  sendJSON, buildSetCookie, setSessionCookie, clearSessionCookie,

  // 错误码
  ERROR_TEXT,

  // 鉴权
  _requireLogin, _requireAdmin,

  // 静态文件
  safeResolveStatic, sendStatic,
};