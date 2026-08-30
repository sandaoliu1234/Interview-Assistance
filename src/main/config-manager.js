/**
 * 🔴 三端统一架构版：配置与本地持久化管理器。
 *
 * 【数据源变更】：
 *    旧版：所有数据都落 AppData 下的多个文件 —— config.json / history.json / resume.md /
 *          sessions/*.json / sessions/*.wav / sessions/*.review.md
 *    新版：核心数据（用户配置、简历、面试会话）统一落 hireme.db（三端共享），
 *          同时保留「双写文件」的兜底，保证迁移期不丢数据：
 *            1) 用户配置   → desktop_configs (account_id + 'main_config' 复合主键)
 *            2) 简历       → resumes (account_id + 'default' 主键)
 *            3) 面试会话   → ia_sessions / ia_rounds（与 Landing 端共用）
 *            4) 历史列表   → 从 ia_sessions 读（不再依赖 history.json），回退文件兜底
 *            5) *.wav 音频 → 仍写入 sessions/<id>.wav（二进制体积大，不塞进 BLOB），
 *                            但同时把路径写入 ia_sessions.recording_wav
 *
 * 【兼容性承诺】：
 *    所有 public 原型方法：loadConfig / saveConfig / loadHistory / saveHistory /
 *      saveResume / loadResume / deleteResume / saveSession / saveRecording /
 *      saveReview / listSessions 的签名、返回类型 100% 与旧版一致，main.js /
 *      preload / 渲染层调用 「零改动」。
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const {
  defaultInterviewConfig,
  migrateLegacyConfig
} = require('../shared/interview-config');

// ============================================================
// 三端统一数据源：hireme.db（desktop_configs + resumes + ia_sessions）
// ============================================================
const { openUnifiedDatabase, HIREME_DB_PATH, DATA_ROOT } = require('../../services/common-paths.js');

let _sharedDb = null;

/**
 * 惰性获取 hireme.db 句柄。优先 main.js 注入的单例；其次若存在 global.__HIREME_BETTER_SQLITE3_PATH__
 *（main.js 主进程探测通过的那一份 better-sqlite3，只走它，避免 native ABI 加载异常绕过 JS try/catch）；
 * 否则按运行环境自适应加载顺序：Electron 主进程先项目根（Electron ABI），Node 环境先 landing。
 * @param {object} [externalDb] main.js 统一注入的 Database 实例（可选）
 */
function _acquireDb(externalDb) {
  if (externalDb) return externalDb;
  if (_sharedDb) return _sharedDb;
  let Database = null;
  const preferPath = (typeof global !== 'undefined' && global && typeof global.__HIREME_BETTER_SQLITE3_PATH__ === 'string')
    ? global.__HIREME_BETTER_SQLITE3_PATH__
    : '';
  const isElectronRuntime = !!(process && process.versions && process.versions.electron);
  const nodeFirst = [
    path.join(__dirname, '..', '..', 'landing', 'node_modules', 'better-sqlite3'),
    path.join(__dirname, '..', '..', 'node_modules', 'better-sqlite3'),
  ];
  const electronFirst = [
    path.join(__dirname, '..', '..', 'node_modules', 'better-sqlite3'),
    path.join(__dirname, '..', '..', 'landing', 'node_modules', 'better-sqlite3'),
  ];
  const candidates = (preferPath ? [preferPath] : []).concat(isElectronRuntime ? electronFirst : nodeFirst);
  let lastErr = null;
  for (const p of candidates) {
    try { delete require.cache[require.resolve(p)]; } catch (_) {}
    try { Database = require(p); break; } catch (e) { lastErr = e; }
  }
  if (!Database) {
    console.error('[ConfigManager] ❌ 无法加载 better-sqlite3：', lastErr && lastErr.message);
    throw lastErr || new Error('better-sqlite3 not found');
  }
  const { db, ready, error } = openUnifiedDatabase(Database);
  if (!ready) throw error || new Error('openUnifiedDatabase failed');
  _sharedDb = db;
  return _sharedDb;
}

/* ============================================================
 * Windows Defender 安全写（保留；过渡期仍然写文件时继续用它）
 * ============================================================ */
function _safeWriteFileSync(fpath, data, maxRetry = 3) {
  const dir = path.dirname(fpath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  let lastErr = null;
  for (let attempt = 1; attempt <= maxRetry; attempt++) {
    try {
      const tmp = fpath + '.tmp.' + process.pid + '.' + Date.now() + '.' + attempt;
      fs.writeFileSync(tmp, data, 'utf8');
      try { fs.renameSync(tmp, fpath); } catch (renameErr) {
        try { fs.unlinkSync(tmp); } catch (_) {}
        throw renameErr;
      }
      return;
    } catch (e) {
      lastErr = e;
      const code = (e && e.code) || '';
      const shouldRetry = (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES' || code === 'ENOTEMPTY');
      if (!shouldRetry || attempt >= maxRetry) break;
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * attempt); } catch (_) {}
    }
  }
  try { fs.writeFileSync(fpath, data, 'utf8'); } catch (directErr) {
    const code = (directErr && directErr.code) || '';
    if (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY') {
      try { fs.unlinkSync(fpath); } catch (_) {}
      fs.writeFileSync(fpath, data, 'utf8');
    } else { throw directErr; }
  }
}

/**
 * 构造函数（保留 1 参 userDataPath；新增可选第 2 参 opts，向后兼容）
 * @param {string} userDataPath 应用 userData 目录（过渡期仍存放 sessions/*.wav 等二进制大文件）
 * @param {object} [opts]
 * @param {object} [opts.externalDb]      main.js 统一注入的 hireme.db 句柄
 * @param {()=>string} [opts.accountProvider] 返回当前账号ID 的回调（= () => authService.currentAccountId）；
 *                                             未传时退为 '__guest__'，保证单测也能跑
 */
function ConfigManager(userDataPath, opts = {}) {
  this.userDataPath = userDataPath;
  this.configPath   = path.join(userDataPath, 'config.json');
  this.historyPath  = path.join(userDataPath, 'history.json');
  this.resumePath   = path.join(userDataPath, 'resume.md');
  this.sessionPath  = path.join(userDataPath, 'interview-sessions');
  this.config       = defaultInterviewConfig();

  this._externalDb      = opts.externalDb || null;
  this._accountProvider = typeof opts.accountProvider === 'function' ? opts.accountProvider : () => '__guest__';
}

/** 取 hireme.db 句柄（内部快捷） */
ConfigManager.prototype._db = function () { return _acquireDb(this._externalDb); };
/** 取当前 active account_id（多账号隔离的依据） */
ConfigManager.prototype._accountId = function () {
  try { return String(this._accountProvider() || '__guest__'); } catch (_) { return '__guest__'; }
};

/* ============================================================
 * 环境变量注入（loadConfig 内使用，与旧版 100% 一致 —— 未改动
 *   唯一区别：注入完毕后会把 config 对象「再写回 desktop_configs」）
 * ============================================================ */
function _applyEnvAndClean(config) {
  const env = process.env || {};
  const envCopy = Object.assign({}, env);
  try {
    const _dotenvPath = path.join(process.cwd(), '.env');
    if (fs.existsSync(_dotenvPath)) {
      const _raw = fs.readFileSync(_dotenvPath, 'utf8');
      const _lines = String(_raw || '').split(/\r?\n/);
      const _STRIP_CHARS = new Set(['`', '"', "'", ' ', '\t', '\r', '\n', '\u3000', '\u201C', '\u201D', '\u2018', '\u2019']);
      const _stripWraps = (raw) => {
        let s = String(raw || '');
        for (let i = 0; i < 8; i++) {
          const before = s;
          s = s.trim();
          while (s.length > 0 && _STRIP_CHARS.has(s.charAt(0))) s = s.slice(1);
          while (s.length > 0 && _STRIP_CHARS.has(s.charAt(s.length - 1))) s = s.slice(0, -1);
          if (s === before) break;
        }
        return s;
      };
      for (const _line of _lines) {
        const _trimmed = String(_line || '').trim();
        if (!_trimmed || _trimmed.startsWith('#')) continue;
        const _eq = _trimmed.indexOf('=');
        if (_eq < 0) continue;
        let _k = _trimmed.substring(0, _eq).trim();
        let _v = _trimmed.substring(_eq + 1);
        _v = String(_v || '').trim();
        if ((_v.startsWith('"') && _v.endsWith('"')) || (_v.startsWith("'") && _v.endsWith("'"))) _v = _v.slice(1, -1);
        _v = _stripWraps(_v);
        if (_k) envCopy[_k] = _v;
      }
    }
  } catch (_e) { /* ignore */ }

  const _aggressiveClean = (raw, kind) => {
    if (typeof raw !== 'string') return '';
    let s = raw;
    const wraps = /[\x60\uFF40\u201C\u201D\u2018\u2019\u300C\u300D\u300E\u300F\u3010\u3011\uFF08\uFF09\u300A\u300B\u201E\u201F\u201A\u201B\u00AB\u00BB\u2039\u203A]/g;
    s = s.replace(wraps, '');
    const ctrls = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
    s = s.replace(ctrls, '');
    const allowed = kind === 'url'
      ? /[^A-Za-z0-9\-._~:\/?#\[\]@!$&'()*+,;=%]/g
      : /[^A-Za-z0-9\-._~:\/!$&'()*+,;=%@#]/g;
    return s.replace(allowed, '');
  };
  const _WRAP_CHARS = '\\s\\u3000\\x60\\uFF40\'"\\u201C\\u201D\\u2018\\u2019\\u300C\\u300D\\u300E\\u300F\\u3010\\u3011\\uFF08\\uFF09\\u300A\\u300B';
  const _reCleanHead = new RegExp('^[' + _WRAP_CHARS + ']+');
  const _reCleanTail = new RegExp('[' + _WRAP_CHARS + ']+$');
  const _cleanStr = (s) => {
    if (typeof s !== 'string') return '';
    let x = s;
    for (let i = 0; i < 12; i++) {
      const before = x;
      x = x.replace(_reCleanHead, '').replace(_reCleanTail, '');
      if (x === before) break;
    }
    return _aggressiveClean(x, 'str');
  };
  const _cleanUrl = (s) => {
    if (typeof s !== 'string') return '';
    let x = s;
    for (let i = 0; i < 12; i++) {
      const before = x;
      x = x.replace(_reCleanHead, '').replace(_reCleanTail, '').replace(/\/+$/, '');
      if (x === before) break;
    }
    return _aggressiveClean(x, 'url').replace(/\/+$/, '');
  };
  const _hasEnv = (k) => (typeof envCopy[k] === 'string' && _cleanStr(envCopy[k]).length > 0);
  if (_hasEnv('IA_BAIDU_APP_ID'))      config.baiduAppId     = _cleanStr(envCopy.IA_BAIDU_APP_ID);
  if (_hasEnv('IA_BAIDU_API_KEY'))    config.baiduApiKey    = _cleanStr(envCopy.IA_BAIDU_API_KEY);
  if (_hasEnv('IA_BAIDU_SECRET_KEY')) config.baiduSecretKey = _cleanStr(envCopy.IA_BAIDU_SECRET_KEY);
  if (_hasEnv('IA_WENXIN_API_KEY'))   config.wenxinApiKey   = _cleanStr(envCopy.IA_WENXIN_API_KEY);
  if (_hasEnv('IA_ZHIPU_API_KEY'))    config.zhipuApiKey    = _cleanStr(envCopy.IA_ZHIPU_API_KEY);
  if (_hasEnv('IA_TONGYI_API_KEY'))   config.tongyiApiKey   = _cleanStr(envCopy.IA_TONGYI_API_KEY);
  if (_hasEnv('IA_TONGYI_BASE_URL'))  config.tongyiBaseUrl  = _cleanUrl(envCopy.IA_TONGYI_BASE_URL);
  if (_hasEnv('IA_TONGYI_VISION_MODEL')) config.tongyiVisionModel = _cleanStr(envCopy.IA_TONGYI_VISION_MODEL);
  if (_hasEnv('IA_ZHIPU_VISION_MODEL'))  config.zhipuVisionModel  = _cleanStr(envCopy.IA_ZHIPU_VISION_MODEL);
  if (_hasEnv('IA_DEFAULT_SERVICE')) {
    const svc = _cleanStr(envCopy.IA_DEFAULT_SERVICE).toLowerCase();
    if (svc === 'wenxin' || svc === 'zhipu' || svc === 'tongyi') config.selectedService = svc;
  }
  return config;
}

/* ============================================================
 * 对外 API：配置 / 历史 / 简历 / 会话 四大类
 *   - 读：优先 DB；无则读文件并「写回 DB」做升级迁移
 *   - 写：DB + 文件双写；过渡期不删旧文件
 * ============================================================ */

/**
 * 加载配置：先读 desktop_configs.main_config；未命中 → 回退 config.json 并迁移回写 → 环境变量注入
 */
ConfigManager.prototype.loadConfig = function () {
  const aid = this._accountId();
  try {
    const db = this._db();
    const row = db.prepare(`
      SELECT config_json FROM desktop_configs WHERE account_id = ? AND config_key = ?
    `).get(aid, 'main_config');
    if (row && row.config_json) {
      try {
        this.config = migrateLegacyConfig(JSON.parse(row.config_json));
      } catch (_) {
        this.config = defaultInterviewConfig();
      }
    } else if (fs.existsSync(this.configPath)) {
      // 🔴 升级迁移：首次从 JSON 迁到 DB（迁移脚本 m3 已做过，但 DB 里可能无该 account 的 main_config 行）
      try {
        const saved = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
        this.config = migrateLegacyConfig(saved);
        // 回写 DB（INSERT OR REPLACE）
        try {
          db.prepare(`
            INSERT OR REPLACE INTO desktop_configs (account_id, config_key, config_json, updated_at)
            VALUES (?, ?, ?, ?)
          `).run(aid, 'main_config', JSON.stringify(this.config), Date.now());
          console.log(`[ConfigManager] 🔄 配置已从 JSON 升级迁移到 desktop_configs（account=${aid}）`);
        } catch (_w) { /* 忽略：DB 写入失败不阻塞使用 JSON 配置 */ }
      } catch (_e) { this.config = defaultInterviewConfig(); }
    } else {
      this.config = defaultInterviewConfig();
    }
  } catch (e) {
    console.error('[ConfigManager] 加载配置(DB)失败，回退默认配置:', e.message);
    this.config = defaultInterviewConfig();
  }

  // 最后一层：环境变量注入（最高优先级；含 .env 手动解析+清包裹+对比诊断，代码未改）
  this.config = _applyEnvAndClean(this.config);
  return this.config;
};

/**
 * 保存配置：DB upsert + 双写 config.json（过渡期兜底）
 */
ConfigManager.prototype.saveConfig = function (config) {
  try {
    if (config && typeof config === 'object') this.config = config;
    const aid = this._accountId();
    const now = Date.now();
    // 1) 写 hireme.db desktop_configs
    try {
      this._db().prepare(`
        INSERT OR REPLACE INTO desktop_configs (account_id, config_key, config_json, updated_at)
        VALUES (?, ?, ?, ?)
      `).run(aid, 'main_config', JSON.stringify(this.config), now);
    } catch (dbe) { console.warn('[ConfigManager] DB 写配置失败：', dbe.message); }
    // 2) 双写 userData/config.json（兜底）
    _safeWriteFileSync(this.configPath, JSON.stringify(this.config, null, 2));
    return true;
  } catch (e) {
    console.error('[ConfigManager] 保存配置失败:', e.message);
    return false;
  }
};

ConfigManager.prototype.getConfig = function () { return this.config; };

/**
 * 加载历史记录：优先从 hireme.db.ia_sessions 读（与 Landing 端共享），回退 history.json
 *   - 返回格式兼容旧版：数组，每条包含 id/createdAt/title 等旧 history.json 字段
 *   - Landing 端新写入的面试能立刻在桌面端历史列表里看到（实现"三端互通"）
 */
ConfigManager.prototype.loadHistory = function () {
  const aid = this._accountId();
  try {
    const db = this._db();
    // 🟢 严格账号隔离：只显示当前 account_id 自己的历史记录，
    //    不再额外带 OR account_id = '__guest__' —— 避免把游客数据串到已登录用户下
    const rows = db.prepare(`
      SELECT id AS session_id, title, job_title, total_score,
             created_at, finished_at, resume_id, interviewer_mode
        FROM ia_sessions
       WHERE account_id = ?
       ORDER BY created_at DESC
       LIMIT 500
    `).all(aid);
    if (rows && rows.length) {
      // 格式兼容旧版 history.json：旧版每条 { id, title, createdAt, lastScore, mode } 等
      return rows.map(r => ({
        id: r.session_id,
        sessionId: r.session_id,
        title: r.title || (r.job_title ? (r.job_title + ' 面试') : '未命名面试'),
        createdAt: Number(r.created_at) || 0,
        finishedAt: Number(r.finished_at) || 0,
        lastScore: r.total_score != null ? Number(r.total_score) : null,
        resumeId: r.resume_id || null,
        mode: r.interviewer_mode || 'standard',
        // 字段来源标识：桌面端渲染层可选使用；旧字段名保持兼容
        source: 'hireme.db',
      }));
    }
  } catch (e) {
    console.warn('[ConfigManager] 从 hireme.db 加载历史失败，回退 history.json：', e.message);
  }
  // fallback：旧 history.json
  try {
    if (fs.existsSync(this.historyPath)) {
      const arr = JSON.parse(fs.readFileSync(this.historyPath, 'utf8'));
      return Array.isArray(arr) ? arr : [];
    }
  } catch (e) { console.error('[ConfigManager] 加载历史记录失败:', e.message); }
  return [];
};

/**
 * 保存历史记录（保留双写：过渡期仍写 history.json；同时把每条 {sessionId, title, score}
 *   若 ia_sessions 里存在对应行，就 UPDATE 该 session 的 title/total_score —— 不做全量同步）
 */
ConfigManager.prototype.saveHistory = function (history) {
  try {
    const arr = Array.isArray(history) ? history : [];
    _safeWriteFileSync(this.historyPath, JSON.stringify(arr, null, 2));
    // 异步式同步：逐条尝试 upsert ia_sessions 的几个展示列（不阻塞主流程）
    try {
      const db = this._db();
      const up = db.prepare(`
        UPDATE ia_sessions SET title = COALESCE(?, title),
                               total_score = COALESCE(?, total_score)
        WHERE id = ?
      `);
      for (const h of arr) {
        if (!h || !h.id) continue;
        up.run(h.title || null, h.lastScore != null ? h.lastScore : null, h.id);
      }
    } catch (_) { /* ignore */ }
    return true;
  } catch (e) {
    console.error('[ConfigManager] 保存历史记录失败:', e.message);
    return false;
  }
};

/**
 * 保存简历文本：先写 hireme.db resumes（默认 key='default'），再双写 resume.md
 */
ConfigManager.prototype.saveResume = function (content) {
  try {
    const aid = this._accountId();
    const md = String(content || '');
    const now = Date.now();
    const resumeId = 'res_' + aid + '_default';
    const db = this._db();
    db.prepare(`
      INSERT OR REPLACE INTO resumes
        (resume_id, account_id, resume_key, resume_name, resume_md,
         resume_text, source_file, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      resumeId, aid, 'default',
      '默认简历',   // resume_name（默认值；用户未设时写"默认简历"）
      md, md,       // resume_md / resume_text：暂都放纯文本（旧 resume.md 是纯文本/markdown）
      this.resumePath, now
    );
    // 双写文件兜底
    _safeWriteFileSync(this.resumePath, md);
    return true;
  } catch (e) {
    console.error('[ConfigManager] 保存简历失败:', e.message);
    return false;
  }
};

/**
 * 读取简历文本：先读 resumes.default；未命中 → 读 resume.md 并回写 DB（升级迁移）
 */
ConfigManager.prototype.loadResume = function () {
  const aid = this._accountId();
  try {
    const db = this._db();
    const row = db.prepare(`
      SELECT resume_md, resume_text FROM resumes WHERE account_id = ? AND resume_key = ?
    `).get(aid, 'default');
    if (row && (row.resume_md || row.resume_text)) {
      return row.resume_md || row.resume_text;
    }
  } catch (e) {
    console.warn('[ConfigManager] DB 读简历失败，回退 resume.md：', e.message);
  }
  // fallback：resume.md，并回写 DB（升级迁移）
  try {
    if (fs.existsSync(this.resumePath)) {
      const md = fs.readFileSync(this.resumePath, 'utf8');
      try {
        const db = this._db();
        const now = Date.now();
        const resumeId = 'res_' + aid + '_default';
        db.prepare(`
          INSERT OR REPLACE INTO resumes
            (resume_id, account_id, resume_key, resume_name, resume_md,
             resume_text, source_file, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(resumeId, aid, 'default', '默认简历', md, md, this.resumePath, now);
        console.log(`[ConfigManager] 🔄 简历已从 resume.md 升级迁移到 resumes 表（account=${aid}）`);
      } catch (_w) { /* ignore */ }
      return md;
    }
  } catch (e) { console.error('[ConfigManager] 读取简历失败:', e.message); }
  return null;
};

/** 删除简历：DB 行 DELETE + 文件 unlink */
ConfigManager.prototype.deleteResume = function () {
  try {
    const aid = this._accountId();
    try {
      this._db().prepare('DELETE FROM resumes WHERE account_id = ? AND resume_key = ?').run(aid, 'default');
    } catch (_) { /* ignore */ }
    if (fs.existsSync(this.resumePath)) fs.unlinkSync(this.resumePath);
    return true;
  } catch (e) {
    console.error('[ConfigManager] 删除简历失败:', e.message);
    return false;
  }
};

/* ============================================================
 * 会话三件套（saveSession / saveRecording / saveReview / listSessions）
 *   策略：文件系统三件套不删（.json / .wav / .review.md 仍是用户可见的备份）
 *        同时写 ia_sessions / ia_rounds 对应列 → 让 Landing / Admin 端立即可见
 * ============================================================ */

/**
 * 保存会话档案：三件套之一 <id>.json（文件）+ ia_sessions 同步
 * @param {string} sessionId 会话 ID
 * @param {Object} sessionData {transcript, meta: {title, jobTitle, ...}, totalScore, rounds, ...}
 */
ConfigManager.prototype.saveSession = function (sessionId, sessionData) {
  try {
    if (!fs.existsSync(this.sessionPath)) fs.mkdirSync(this.sessionPath, { recursive: true });
    const filePath = path.join(this.sessionPath, `${sessionId}.json`);
    _safeWriteFileSync(filePath, JSON.stringify(sessionData, null, 2));

    // —— 同步写入 hireme.db.ia_sessions（与 Landing 端共表）——
    try {
      const aid = this._accountId();
      const sd = sessionData || {};
      const meta = sd.meta || {};
      const now = Date.now();
      const created = Number(sd.createdAt || meta.createdAt || now);
      const finished = Number(sd.finishedAt || meta.finishedAt || 0);
      const resumeId = sd.resumeId || meta.resumeId || ('res_' + aid + '_default');
      const db = this._db();
      db.prepare(`
        INSERT OR REPLACE INTO ia_sessions
          (id, account_id, title, job_title, resume_id, interviewer_mode,
           total_score, total_rounds, created_at, updated_at, finished_at,
           config_json, transcript_json, review_md, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'desktop.json')
      `).run(
        sessionId, aid,
        sd.title || meta.title || (meta.jobTitle ? (meta.jobTitle + ' 面试') : '未命名面试'),
        meta.jobTitle || sd.jobTitle || '',
        resumeId,
        meta.interviewerMode || 'standard',
        sd.totalScore != null ? sd.totalScore : null,
        Array.isArray(sd.rounds) ? sd.rounds.length : (meta.totalRounds || 0),
        created, now, finished,
        JSON.stringify({ interview_config: meta.interviewConfig || this.config || {} }),
        JSON.stringify({ transcript: sd.transcript || [], rounds: sd.rounds || [] }),
        sd.review || ''
      );
      // 如果有 rounds：逐行 UPSERT ia_rounds
      if (Array.isArray(sd.rounds) && sd.rounds.length > 0) {
        const stmtR = db.prepare(`
          INSERT OR REPLACE INTO ia_rounds
            (session_id, round_no, round_id, question, answer_markdown,
             audio_wav_path, score, score_breakdown_json, created_at, duration_ms)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        sd.rounds.forEach((r, idx) => {
          if (!r) return;
          stmtR.run(
            sessionId, idx + 1,
            r.roundId || (sessionId + '-r' + (idx + 1)),
            r.question || '',
            r.answerMarkdown || r.answer || '',
            r.wavPath || r.audioWavPath || null,
            r.score != null ? r.score : null,
            r.scoreBreakdown ? JSON.stringify(r.scoreBreakdown) : null,
            Number(r.createdAt || r.startAt || created + idx * 60000),
            Number(r.durationMs || r.duration || 0)
          );
        });
      }
    } catch (dbe) {
      console.warn('[ConfigManager] ia_sessions 同步写入失败（文件已保存）：', dbe.message);
    }
    return true;
  } catch (e) {
    console.error('[ConfigManager] 保存会话失败:', e.message);
    return false;
  }
};

/** 保存录音：文件落 sessions/<id>.wav；同时把绝对路径写进 ia_sessions.recording_wav */
ConfigManager.prototype.saveRecording = function (sessionId, wavBuffer) {
  try {
    if (!fs.existsSync(this.sessionPath)) fs.mkdirSync(this.sessionPath, { recursive: true });
    const filePath = path.join(this.sessionPath, `${sessionId}.wav`);
    const buf = Buffer.isBuffer(wavBuffer) ? wavBuffer : Buffer.from(wavBuffer);
    fs.writeFileSync(filePath, buf);
    // 同步 ia_sessions.recording_wav（让 Landing 端能跳转播放同一份音频）
    try {
      this._db().prepare('UPDATE ia_sessions SET recording_wav = ? WHERE id = ?').run(filePath, sessionId);
    } catch (_) { /* ignore */ }
    return filePath;
  } catch (e) {
    console.error('[ConfigManager] 保存音频存档失败:', e.message);
    return null;
  }
};

/** 保存复盘：文件落 sessions/<id>.review.md；同步 ia_sessions.review_md */
ConfigManager.prototype.saveReview = function (sessionId, review) {
  try {
    if (!fs.existsSync(this.sessionPath)) fs.mkdirSync(this.sessionPath, { recursive: true });
    const filePath = path.join(this.sessionPath, `${sessionId}.review.md`);
    _safeWriteFileSync(filePath, review || '');
    try {
      this._db().prepare('UPDATE ia_sessions SET review_md = ? WHERE id = ?').run(String(review || ''), sessionId);
    } catch (_) { /* ignore */ }
    return filePath;
  } catch (e) {
    console.error('[ConfigManager] 保存复盘失败:', e.message);
    return null;
  }
};

/**
 * 列出所有会话档案：DB 优先（ia_sessions 按 created_at DESC），缺 wav/review 的再拼文件路径
 *   - 返回格式完全兼容旧版：[{id, jsonPath, wavPath, reviewPath}]，并按 ID 倒序
 *   - 桌面端用户在 Landing 端创建的面试会话同样可见（实现三端互通）
 */
ConfigManager.prototype.listSessions = function () {
  const aid = this._accountId();
  try {
    const db = this._db();
    // 🟢 严格账号隔离：只列出当前 account_id 名下的会话档案，
    //    不再额外带 OR account_id = '__guest__' —— 游客数据保持独立，不串到已登录用户
    const rows = db.prepare(`
      SELECT id, recording_wav, review_md, created_at
        FROM ia_sessions
       WHERE account_id = ?
       ORDER BY created_at DESC
       LIMIT 500
    `).all(aid);
    if (rows && rows.length) {
      return rows.map(r => {
        const info = { id: r.id };
        // json：若 sessions/<id>.json 存在就挂路径；Landing 端生成的可能没有，但历史列表 loadHistory 也能看
        const jsonF = path.join(this.sessionPath, `${r.id}.json`);
        if (fs.existsSync(jsonF)) info.jsonPath = jsonF;
        // wav：先看 DB 列（recording_wav），再 fallback sessions/<id>.wav
        if (r.recording_wav && fs.existsSync(r.recording_wav)) {
          info.wavPath = r.recording_wav;
        } else {
          const wavF = path.join(this.sessionPath, `${r.id}.wav`);
          if (fs.existsSync(wavF)) info.wavPath = wavF;
        }
        // review：若 review_md 非空，直接把内容塞 reviewMarkdown；路径则优先 sessions/<id>.review.md
        const revF = path.join(this.sessionPath, `${r.id}.review.md`);
        if (fs.existsSync(revF)) {
          info.reviewPath = revF;
        } else if (r.review_md) {
          // DB 有值但没文件 → 写出（让旧 UI 仍能按 path 读取）
          try { _safeWriteFileSync(revF, r.review_md); info.reviewPath = revF; } catch (_) {}
        }
        return info;
      });
    }
  } catch (e) {
    console.warn('[ConfigManager] DB 列表会话失败，回退文件扫描：', e.message);
  }
  // fallback：旧版文件扫描
  try {
    if (!fs.existsSync(this.sessionPath)) return [];
    const files = fs.readdirSync(this.sessionPath);
    const ids = Array.from(new Set(files.map((f) => f.replace(/\.(json|wav|review\.md)$/, ''))));
    return ids.map((id) => {
      const info = { id };
      if (files.includes(`${id}.json`)) info.jsonPath = path.join(this.sessionPath, `${id}.json`);
      if (files.includes(`${id}.wav`)) info.wavPath = path.join(this.sessionPath, `${id}.wav`);
      if (files.includes(`${id}.review.md`)) info.reviewPath = path.join(this.sessionPath, `${id}.review.md`);
      return info;
    }).sort((a, b) => String(b.id).localeCompare(String(a.id)));
  } catch (e) {
    console.error('[ConfigManager] 列出会话失败:', e.message);
    return [];
  }
};

module.exports = ConfigManager;
