/**
 * services/common-paths.js
 * ------------------------------------------------------------------
 * 🔴 三端共享的统一数据路径解析器（桌面端 Electron / 用户端 :3000 / 管理员端 :3001）。
 *
 * 【设计目标】：
 *   三端所有 better-sqlite3 初始化都通过本模块拿到同一份 hireme.db 物理路径，
 *   保证大家打开的是 D:\java_workspace\Interview Assistance\data\hireme.db 这同一个
 *   文件，不再各端自己拼路径造成多份数据库。
 *
 * 【优先级】（从高到低，命中即返回）：
 *   1. 环境变量 HIREME_DB_PATH（用户显式 override，例如打包后把数据放 C:\ProgramData）
 *   2. 环境变量 IA_DATA_ROOT + 'hireme.db'（整个 data 目录重定向）
 *   3. process.cwd() / 'data' / 'hireme.db'
 *        - 桌面端 npm start：cwd = 项目根，正确
 *        - Landing 端 node landing/index.js：cwd = 项目根，正确
 *   4. __dirname / 上两级 / 'data' / 'hireme.db'
 *        - 本文件在 services/common-paths.js（一级）→ 项目根
 *        - 如果被 landing 端 require（复制一份）→ 也能兜底
 *
 * 【其它暴露常量】：
 *   - PROJECT_ROOT          ：项目根绝对路径（cwd 优先，否则靠 __dirname 推断）
 *   - DATA_ROOT             ：项目根/data
 *   - LOGS_ROOT             ：项目根/logs（WAV / 崩溃日志继续放文件系统，不入库）
 *   - HIREME_DB_PATH        ：统一 SQLite 文件绝对路径
 *   - resolveLogsDir(accountId) ：返回 logs/sessions/{accountId}/ 绝对路径（兼容 localHttpServer 会话目录）
 *   - openUnifiedDatabase(betterSqlite3ModuleInstance) ：一次性 new Database + PRAGMA（三端复用）
 * ------------------------------------------------------------------
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ============================================================
// 1. 推断项目根（cwd 优先，兜底 __dirname 两级上溯）
// ============================================================
function _inferProjectRoot() {
  // 优先 cwd
  const cwd = process.cwd();
  // 判断 cwd 是否是项目根（存在 package.json，且 name=@hireme/desktop 或包含 landing/ 子目录）
  const looksLikeProjectRoot = (p) => {
    if (!p || !fs.existsSync(p)) return false;
    const hasPkg = fs.existsSync(path.join(p, 'package.json'));
    const hasLanding = fs.existsSync(path.join(p, 'landing', 'index.js'));
    const hasMain = fs.existsSync(path.join(p, 'main.js'));
    return hasPkg && (hasLanding || hasMain);
  };
  if (looksLikeProjectRoot(cwd)) return cwd;
  // 兜底：本文件在 {项目根}/services/common-paths.js，向上一级 = 项目根
  const byDirname = path.resolve(__dirname, '..');
  if (looksLikeProjectRoot(byDirname)) return byDirname;
  // 再兜底：__dirname 往上两级（landing 下如果复制了本文件就是 landing/services/common-paths.js）
  const byParent = path.resolve(__dirname, '..', '..');
  if (looksLikeProjectRoot(byParent)) return byParent;
  // 实在不行用 cwd
  return cwd;
}

const PROJECT_ROOT = _inferProjectRoot();

// ============================================================
// 2. DATA_ROOT（data/ 目录）
// ============================================================
function _resolveDataRoot() {
  // 显式指定：IA_DATA_ROOT
  if (process.env.IA_DATA_ROOT && fs.existsSync(process.env.IA_DATA_ROOT)) {
    return process.env.IA_DATA_ROOT;
  }
  return path.join(PROJECT_ROOT, 'data');
}
const DATA_ROOT = _resolveDataRoot();
// logs/ 目录继续放在项目根（体积大：.wav / 崩溃日志，不想跟 data 混在一起）
const LOGS_ROOT = path.join(PROJECT_ROOT, 'logs');

// 保证 data / logs 目录存在（同步，启动时必须先就绪）
for (const d of [DATA_ROOT, LOGS_ROOT]) {
  try { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); } catch (_) { /* ignore */ }
}

// ============================================================
// 3. HIREME_DB_PATH 统一数据库路径
// ============================================================
function resolveHiremeDbPath() {
  // 1) 显式环境变量 HIREME_DB_PATH（最高优先级）
  if (process.env.HIREME_DB_PATH) {
    const p = path.resolve(process.cwd(), process.env.HIREME_DB_PATH);
    // 允许父目录不存在（首次运行，better-sqlite3 会自动创建文件，但父目录必须存在）
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) { try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* ignore */ } }
    return p;
  }
  // 2) 标准：DATA_ROOT/hireme.db
  return path.join(DATA_ROOT, 'hireme.db');
}
const HIREME_DB_PATH = resolveHiremeDbPath();

// ============================================================
// 4. 会话 / 音频文件 目录（继续存文件系统）
// ============================================================
function resolveSessionsDir(accountId) {
  const safeId = String(accountId || '__guest__');
  const dir = path.join(LOGS_ROOT, 'sessions', safeId);
  if (!fs.existsSync(dir)) { try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* ignore */ } }
  return dir;
}
// 崩溃日志目录
function resolveCrashesDir() {
  const dir = path.join(LOGS_ROOT, 'crashes');
  if (!fs.existsSync(dir)) { try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* ignore */ } }
  return dir;
}

// ============================================================
// 5. 三端统一打开数据库 + 关键 PRAGMA（不要每个模块自己开一遍）
//    返回 { db, ready, error }
// ============================================================
function openUnifiedDatabase(Database) {
  if (!Database) {
    const msg = 'common-paths.openUnifiedDatabase：传入的 Database 为 null（better-sqlite3 未安装）';
    console.error('[common-paths] ❌ ' + msg);
    return { db: null, ready: false, error: new Error(msg) };
  }
  try {
    // better-sqlite3 要求父目录存在（上面 mkdirSync 保证了）
    const db = new Database(HIREME_DB_PATH);
    // 🔴 三端并发读写必须的 PRAGMA（全部一致）
    // journal_mode=WAL ：允许多进程并行读写（桌面端 + Landing + 管理员 3 个进程同时写）
    // busy_timeout=5000 ：遇到 SQLITE_BUSY 最多等 5 秒，而不是立刻报错
    // foreign_keys=ON   ：ia_rounds.session_id → ia_sessions.id ON DELETE CASCADE 生效
    // synchronous=NORMAL ：WAL 模式下 NORMAL 足够安全且写入快；如果对 durability 有极高要求可改成 FULL
    // cache_size=-8000    ：页缓存 8000 页 ≈ 64MB（默认 2000，面试记录翻页更丝滑）
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = ON');
    db.pragma('synchronous = NORMAL');
    db.pragma('cache_size = -8000');
    return { db, ready: true, error: null };
  } catch (e) {
    console.error(
      '[common-paths] ❌ 打开统一数据库 hireme.db 失败：' + e.message
      + ` | path=${HIREME_DB_PATH}`
    );
    return { db: null, ready: false, error: e };
  }
}

// ============================================================
// 6. 启动早期快速诊断（任何端 require 本文件时立刻打一条快照日志，
//    便于三端各自启动日志里肉眼确认"大家打开的是不是同一个文件"）
// ============================================================
try {
  const tag = (typeof process !== 'undefined' && process && process.argv && Array.isArray(process.argv))
    ? String(process.argv[1] || process.argv0 || 'unknown')
    : 'unknown';
  const who = (() => {
    // 根据 argv 推断当前是哪个端（只打日志，不影响逻辑）
    if (tag.includes('landing') || tag.includes('user-server') || tag.includes('admin-server')) return 'LANDING';
    if (tag.includes('electron') || tag.endsWith('.exe')) return 'ELECTRON';
    return 'NODE';
  })();
  console.log(
    `[common-paths] ✅ [${who}] 三端统一路径已解析：`
    + ` PROJECT_ROOT=${PROJECT_ROOT}`
    + ` | DATA_ROOT=${DATA_ROOT}`
    + ` | LOGS_ROOT=${LOGS_ROOT}`
    + ` | HIREME_DB_PATH=${HIREME_DB_PATH}`
    + ` | 文件是否已存在=${fs.existsSync(HIREME_DB_PATH) ? 'YES' : 'NO（首次启动自动创建）'}`
  );
} catch (_) { /* 诊断失败不阻塞启动 */ }

module.exports = {
  PROJECT_ROOT,
  DATA_ROOT,
  LOGS_ROOT,
  HIREME_DB_PATH,
  resolveHiremeDbPath,
  resolveSessionsDir,
  resolveCrashesDir,
  openUnifiedDatabase,
};
