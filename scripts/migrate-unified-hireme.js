/**
 * scripts/migrate-unified-hireme.js
 * ------------------------------------------------------------------
 * 🔴 三端统一数据源一次性（幂等）迁移脚本：把所有历史碎片数据归并到
 *    项目根/data/hireme.db（= 目标库），保证账号/积分/面试/配置/简历
 *    三端都能从同一份 SQLite 读写。
 *
 * 【5 个迁移源，按执行顺序】
 *   1. landing/data/hireme.db   → 目标 hireme.db（账号/积分/订单/流水/套餐/兑换码/新闻/邀请/签到）
 *   2. data/interview.db        → 目标 hireme.db ia_sessions/ia_rounds（25 场历史面试 + 20 轮）
 *   3. AppData/.../accounts.json / auth-session.json / config.json / accounts/{id}/resume.md + resume_meta.json
 *                                 → 目标 hireme.db accounts / desktop_sessions / desktop_configs / resumes
 *   4. logs/sessions/{accId}/*.json + ses_xxx-review.md + ses_xxx.wav 路径
 *                                 → ia_sessions 扩字段 review_md / wav_path / config_json（对齐 interview.db 迁移进来的行）
 *   5. logs/ia-history-*.jsonl → 目标 hireme.db ia_dialog_messages（每条对话一行）
 *
 * 【幂等性设计】（重复执行 N 次都安全）
 *   - 按"天然主键"INSERT OR IGNORE：
 *       accounts 按 normalized_email（先读已有，冲突则保留目标库现有 = Landing 权威）
 *       ia_sessions / ia_rounds 按 id
 *       ia_dialog_messages 按 message_id
 *       desktop_sessions 按 account_id
 *   - 扩字段（review_md / wav_path / config_json）用 UPDATE ... WHERE 列 IS NULL，
 *     避免重复执行把用户后续手动修改过的值覆盖掉。
 *
 * 【运行方式】
 *   - 在项目根目录下（D:\java_workspace\Interview Assistance\）执行：
 *       node scripts/migrate-unified-hireme.js
 *   - 三端都启动时 main.js 也会自动 require 本脚本做一次幂等迁移（Phase: migrate 阶段）。
 *
 * 【输出】
 *   - 每次迁移后把摘要打印到控制台 + 写 logs/crashes/migrate-unified-summary-YYYYMMDD-HHMMSS.json
 *   - 返回 { ok, summary, sourceSummary } 对象
 * ------------------------------------------------------------------
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

// 1) 先定位 common-paths：目标 hireme.db 在项目根/data
const {
  PROJECT_ROOT,
  DATA_ROOT,
  LOGS_ROOT,
  HIREME_DB_PATH,
  openUnifiedDatabase,
} = require('../services/common-paths.js');

// 2.5) 加载 ABI 匹配的 better-sqlite3：优先 landing/node_modules 下已编译的版本
//     （项目根 node_modules 是给 Electron 用的，ABI 版本可能和 Node CLI 不一致）
function requireBetterSqlite3() {
  const candidates = [
    path.join(PROJECT_ROOT, 'landing', 'node_modules', 'better-sqlite3'),
    path.join(PROJECT_ROOT, 'node_modules', 'better-sqlite3'),
  ];
  let lastErr = null;
  for (const p of candidates) {
    try { return require(p); } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('找不到可用的 better-sqlite3（尝试了 landing/ 和项目根）');
}

// 2) Electron userDataPath（AppData 下的桌面端旧文件根目录）—— 只在迁移源 #3 用
//    与 main.js 保持一致：app.getPath('userData') + '/interview-assistant'
//    Node 脚本里没有 Electron API，所以手动拼接 Windows 的标准路径：
function resolveDesktopUserDataRoot() {
  const appData = process.env.APPDATA
    || path.join(process.env.USERPROFILE || 'C:\\Users\\Public', 'AppData', 'Roaming');
  const p = path.join(appData, '@hireme', 'desktop', 'interview-assistant');
  return fs.existsSync(p) ? p : null;
}
const DESKTOP_USERDATA_ROOT = resolveDesktopUserDataRoot();

/** 密码哈希常量（必须与 AuthService 一致） */
const PBKDF2_ITER = 100000;
const PBKDF2_ALGO = 'sha256';
const SALT_BYTES = 16;
const HASH_BYTES = 64;
function hashPassword(password, saltB64) {
  const salt = saltB64 ? Buffer.from(saltB64, 'base64') : crypto.randomBytes(SALT_BYTES);
  const hash = crypto.pbkdf2Sync(String(password || ''), salt, PBKDF2_ITER, HASH_BYTES, PBKDF2_ALGO);
  return { algo: PBKDF2_ALGO, iter: PBKDF2_ITER, salt: salt.toString('base64'), hash: hash.toString('base64') };
}

/** 安全 JSON.parse */
function safeParse(s, fallback) {
  try { return JSON.parse(s); } catch (_) { return fallback; }
}
/** 日期转 YYYYMMDD（day_key） */
function dayKeyOf(ts) {
  const d = new Date(Number(ts) || Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  return String(d.getFullYear()) + pad(d.getMonth() + 1) + pad(d.getDate());
}

// ------------------------------------------------------------------
// 打开目标库（data/hireme.db）：通过 landing/db.js 建立表（因为那里的 CREATE_TABLES
// 包含所有 16 张表），然后再在本脚本里拿 db 句柄写迁移数据
// ------------------------------------------------------------------
function openTargetDb() {
  // require landing/db.js 会执行所有建表 + PRAGMA（幂等），把 db 句柄导出
  // 注意：landing/db.js 内部 require('../services/common-paths.js') 正确定位到 data/hireme.db
  const landingDb = require('../landing/db.js');
  return landingDb.db;
}

// ==================================================================
// Migration 1：landing/data/hireme.db → 目标 hireme.db
//   表：accounts / credit_balances / orders / credit_flows / web_sessions
//       / packages / redeem_codes / news / invite_records / checkin_records
// ==================================================================
function migrateLandingDbInto(db, summary) {
  const src = path.join(PROJECT_ROOT, 'landing', 'data', 'hireme.db');
  if (!fs.existsSync(src)) {
    summary.m1_status = 'SKIP: landing/data/hireme.db 不存在（已无旧文件）';
    return;
  }
  let Database = null;
  try { Database = requireBetterSqlite3(); } catch (e) {
    summary.m1_status = 'SKIP: better-sqlite3 不可用';
    return;
  }
  const sdb = new Database(src, { readonly: true, fileMustExist: true });
  // 所有表清单（只迁移 Landing 拥有的 10 张，ia_ 系列从 data/interview.db 迁）
  const TABLES = [
    'accounts', 'credit_balances', 'orders', 'credit_flows', 'web_sessions',
    'packages', 'redeem_codes', 'news', 'invite_records', 'checkin_records',
  ];
  let rowsTotal = 0;
  for (const t of TABLES) {
    try {
      const cols = sdb.prepare(`PRAGMA table_info(${t})`).all().map(r => r.name);
      if (!cols.length) continue;
      const rows = sdb.prepare(`SELECT * FROM "${t}"`).all();
      if (!rows.length) { summary[`m1_${t}`] = 0; continue; }
      const colList = cols.map(c => `"${c}"`).join(',');
      const phList  = cols.map(c => `@${c}`).join(',');
      const stmt = db.prepare(`INSERT OR IGNORE INTO "${t}" (${colList}) VALUES (${phList})`);
      const ins = db.transaction((list) => {
        let n = 0;
        for (const r of list) { const info = stmt.run(r); if (info.changes > 0) n++; }
        return n;
      });
      const inserted = ins(rows);
      rowsTotal += inserted;
      summary[`m1_${t}`] = `src=${rows.length} inserted=${inserted} skipped=${rows.length - inserted}`;
    } catch (e) {
      summary[`m1_${t}_ERROR`] = e.message;
    }
  }
  try { sdb.close(); } catch (_) {}
  summary.m1_status = `OK: 共 ${rowsTotal} 行从 landing/data/hireme.db → 目标库（INSERT OR IGNORE，冲突保留目标库）`;
}

// ==================================================================
// Migration 2：data/interview.db（旧独立面试库）→ 目标 hireme.db ia_sessions/ia_rounds
// ==================================================================
function migrateInterviewDbInto(db, summary) {
  const src = path.join(PROJECT_ROOT, 'data', 'interview.db');
  if (!fs.existsSync(src)) {
    summary.m2_status = 'SKIP: data/interview.db 不存在（首次无历史面试）';
    return;
  }
  let Database = null;
  try { Database = requireBetterSqlite3(); } catch (e) {
    summary.m2_status = 'SKIP: better-sqlite3 不可用';
    return;
  }
  const sdb = new Database(src, { readonly: true, fileMustExist: true });
  // ia_sessions：旧表列可能比目标表少（没有 review_md/config_json），SELECT * 按实际列名映射；
  //              INSERT OR IGNORE 按主键 id 去重
  for (const t of ['ia_sessions', 'ia_rounds']) {
    try {
      const cols = sdb.prepare(`PRAGMA table_info(${t})`).all().map(r => r.name);
      if (!cols.length) continue;
      const rows = sdb.prepare(`SELECT * FROM ${t}`).all();
      if (!rows.length) { summary[`m2_${t}`] = 0; continue; }
      const colList = cols.map(c => `"${c}"`).join(',');
      const phList  = cols.map(c => `@${c}`).join(',');
      const stmt = db.prepare(`INSERT OR IGNORE INTO ${t} (${colList}) VALUES (${phList})`);
      const run = db.transaction((list) => {
        let n = 0;
        for (const r of list) { const info = stmt.run(r); if (info.changes > 0) n++; }
        return n;
      });
      const inserted = run(rows);
      summary[`m2_${t}`] = `src=${rows.length} inserted=${inserted}`;
    } catch (e) {
      summary[`m2_${t}_ERROR`] = e.message;
    }
  }
  try { sdb.close(); } catch (_) {}
  summary.m2_status = 'OK: interview.db 历史面试已合并进目标 hireme.db';
}

// ==================================================================
// Migration 3：AppData 下的桌面端旧 JSON 文件 → hireme.db
//   accounts.json          → accounts（邮箱冲突保留目标库现有 = Landing 优先）
//   auth-session.json     → desktop_sessions
//   config.json           → desktop_configs（按 currentAccountId，没有则 __guest__）
//   accounts/{id}/resume.md + resume_meta.json → resumes
// ==================================================================
function migrateDesktopJsonInto(db, summary) {
  if (!DESKTOP_USERDATA_ROOT) {
    summary.m3_status = `SKIP: 未找到桌面端 userData 目录（${process.env.APPDATA ? '但目录不存在' : '无 APPDATA 环境变量'}）`;
    return;
  }
  const readJson = (p, fallback) => {
    if (!fs.existsSync(p)) return fallback;
    return safeParse(fs.readFileSync(p, 'utf8'), fallback);
  };
  const now = Date.now();

  // ---------- 3a. accounts.json 账号行 ----------
  const accountsPath = path.join(DESKTOP_USERDATA_ROOT, 'accounts.json');
  const accountsRoot = readJson(accountsPath, null);
  let accIns = 0, accSkip = 0;
  const insAccStmt = db.prepare(`
    INSERT OR IGNORE INTO accounts
      (account_id, normalized_email, display_email, display_name, avatar, is_admin,
       pwd_algo, pwd_iter, pwd_salt, pwd_hash, reset_code, reset_expire_at, ext_id,
       created_at, last_login_ts)
    VALUES
      (@accountId, @normalizedEmail, @displayEmail, @displayName, @avatar, @isAdmin,
       @pwdAlgo, @pwdIter, @pwdSalt, @pwdHash, @resetCode, @resetExpireAt, @extId,
       @createdAt, @lastLoginTs)
  `);
  const getAccByEmail = db.prepare('SELECT account_id FROM accounts WHERE normalized_email = ?');
  if (accountsRoot && accountsRoot.accounts && typeof accountsRoot.accounts === 'object') {
    for (const id of Object.keys(accountsRoot.accounts)) {
      const a = accountsRoot.accounts[id];
      if (!a || !a.normalizedEmail) continue;
      // 邮箱唯一：如果目标库已存在同名邮箱 → 跳过（Landing 数据更权威）
      const already = getAccByEmail.get(String(a.normalizedEmail || '').toLowerCase());
      if (already) { accSkip++; continue; }
      const pwd = a.pwd || { algo: PBKDF2_ALGO, iter: PBKDF2_ITER, salt: '', hash: '' };
      const reset = a.reset || null;
      const info = insAccStmt.run({
        accountId: id,
        normalizedEmail: String(a.normalizedEmail || '').toLowerCase(),
        displayEmail: a.displayEmail || a.email || '',
        displayName: a.displayName || '',
        avatar: a.avatar || '',
        isAdmin: a.isAdmin ? 1 : 0,
        pwdAlgo: pwd.algo || PBKDF2_ALGO,
        pwdIter: Number(pwd.iter) || PBKDF2_ITER,
        pwdSalt: pwd.salt || '',
        pwdHash: pwd.hash || '',
        resetCode: reset ? reset.code : null,
        resetExpireAt: reset ? Number(reset.expireAt) || 0 : null,
        extId: a.extId || null,
        createdAt: Number(a.createdAt) || now,
        lastLoginTs: Number(a.lastLoginTs) || 0,
      });
      if (info.changes > 0) accIns++;
    }
  }
  summary.m3_accounts = `插入 ${accIns} 个新账号，跳过 ${accSkip} 个已存在邮箱（Landing 侧权威）`;

  // ---------- 3b. auth-session.json → desktop_sessions ----------
  const authSessPath = path.join(DESKTOP_USERDATA_ROOT, 'auth-session.json');
  const authSess = readJson(authSessPath, null);
  if (authSess && authSess.session && authSess.session.accountId) {
    const s = authSess.session;
    const encToken = JSON.stringify(s.encToken || {});
    const tokenHash = s.tokenHash || crypto.createHash('sha256').update('').digest('base64');
    try {
      db.prepare(`
        INSERT OR REPLACE INTO desktop_sessions
          (account_id, enc_token, token_hash, created_at, expire_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        String(s.accountId),
        encToken,
        tokenHash,
        Number(s.createdAt) || now,
        Number(s.expireAt) || (now + 7 * 24 * 3600 * 1000),
      );
      summary.m3_desktopSession = `OK: 迁移会话（accountId=${s.accountId}）`;
    } catch (e) { summary.m3_desktopSession = 'ERROR: ' + e.message; }
  } else {
    summary.m3_desktopSession = 'SKIP: auth-session.json 不存在或无有效会话';
  }

  // ---------- 3c. config.json → desktop_configs ----------
  //   先从 auth-session.session.accountId 知道当前登录账号；
  //   若未登录 → __guest__
  const configPath = path.join(DESKTOP_USERDATA_ROOT, 'config.json');
  if (fs.existsSync(configPath)) {
    const cfgRaw = fs.readFileSync(configPath, 'utf8');
    const cfgObj = safeParse(cfgRaw, null);
    if (cfgObj && typeof cfgObj === 'object') {
      const owner = (authSess && authSess.session && authSess.session.accountId)
        ? authSess.session.accountId : '__guest__';
      try {
        db.prepare(`
          INSERT OR IGNORE INTO desktop_configs (account_id, config_json, updated_at) VALUES (?, ?, ?)
        `).run(String(owner), JSON.stringify(cfgObj), now);
        summary.m3_config = `OK: config.json → desktop_configs（account_id=${owner}，IGNORE 语义：已存在则不覆盖）`;
      } catch (e) { summary.m3_config = 'ERROR: ' + e.message; }
    } else {
      summary.m3_config = 'SKIP: config.json 解析失败';
    }
  } else {
    summary.m3_config = 'SKIP: 无 config.json';
  }

  // ---------- 3d. accounts/{id}/resume.md + resume_meta.json → resumes ----------
  const accountsDir = path.join(DESKTOP_USERDATA_ROOT, 'accounts');
  let resumeMigrated = 0;
  if (fs.existsSync(accountsDir)) {
    const list = fs.readdirSync(accountsDir, { withFileTypes: true });
    for (const entry of list) {
      if (!entry.isDirectory()) continue;
      const accId = entry.name; // '__guest__' 或 'acc_xxx'
      const resumeP    = path.join(accountsDir, accId, 'resume.md');
      const resumeMeta = path.join(accountsDir, accId, 'resume_meta.json');
      if (!fs.existsSync(resumeP)) continue;
      const content = fs.readFileSync(resumeP, 'utf8');
      const meta = fs.existsSync(resumeMeta)
        ? safeParse(fs.readFileSync(resumeMeta, 'utf8'), null) : null;
      try {
        db.prepare(`
          INSERT OR IGNORE INTO resumes (account_id, content, meta_json, updated_at) VALUES (?, ?, ?, ?)
        `).run(accId, content || '', meta ? JSON.stringify(meta) : null, now);
        resumeMigrated++;
      } catch (e) { summary[`m3_resume_${accId}_ERROR`] = e.message; }
    }
  }
  summary.m3_resumes = `OK: 迁移 ${resumeMigrated} 份简历（accounts/{id}/resume.md → resumes 表）`;

  summary.m3_status = 'OK: 桌面端 AppData 旧文件迁移完成';
}

// ==================================================================
// Migration 4：logs/sessions/*/*.json 里的 config/review/wav → ia_sessions 扩字段
//             （只在 ia_sessions.review_md/wav_path/config_json 为空时 UPDATE，避免覆盖）
// ==================================================================
function migrateSessionExtrasInto(db, summary) {
  const sessionsRoot = path.join(LOGS_ROOT, 'sessions');
  if (!fs.existsSync(sessionsRoot)) {
    summary.m4_status = 'SKIP: 无 logs/sessions 目录';
    return;
  }
  const updReview = db.prepare('UPDATE ia_sessions SET review_md   = ? WHERE id = ? AND (review_md   IS NULL OR review_md   = \'\')');
  const updWav    = db.prepare('UPDATE ia_sessions SET wav_path    = ? WHERE id = ? AND (wav_path    IS NULL OR wav_path    = \'\')');
  const updConfig = db.prepare('UPDATE ia_sessions SET config_json = ? WHERE id = ? AND (config_json IS NULL OR config_json = \'\')');
  const updResume = db.prepare(`
    UPDATE ia_sessions SET resume_snapshot = ?
     WHERE id = ? AND (resume_snapshot IS NULL OR resume_snapshot = '')
  `);
  const updJd = db.prepare(`
    UPDATE ia_sessions SET jd_snapshot = ?
     WHERE id = ? AND (jd_snapshot IS NULL OR jd_snapshot = '')
  `);
  let filled = 0;
  const accDirs = fs.readdirSync(sessionsRoot, { withFileTypes: true });
  for (const ad of accDirs) {
    if (!ad.isDirectory()) continue;
    const accId = ad.name;
    const files = fs.readdirSync(path.join(sessionsRoot, accId));
    // 按 .json 文件聚合（按 session id）
    const bySession = new Map();
    for (const f of files) {
      if (f.startsWith('_index')) continue;
      if (f.startsWith('.') || f.endsWith('.tmp')) continue;
      // 去掉 .json / .wav / .review.md 后缀，拿到 session id
      let sid = f;
      if (sid.endsWith('.review.md')) sid = sid.slice(0, -'.review.md'.length);
      else if (sid.endsWith('.json'))  sid = sid.slice(0, -5);
      else if (sid.endsWith('.wav'))   sid = sid.slice(0, -4);
      else continue;
      if (!bySession.has(sid)) bySession.set(sid, { json: null, wav: null, reviewMd: null });
      const rec = bySession.get(sid);
      const abs = path.join(sessionsRoot, accId, f);
      if (f.endsWith('.json')) rec.json = abs;
      else if (f.endsWith('.wav')) rec.wav = abs;
      else if (f.endsWith('.review.md')) rec.reviewMd = abs;
    }
    const doIt = db.transaction((rows) => {
      let local = 0;
      for (const { id, review, wav, cfg, resume, jd } of rows) {
        if (review)   { const n = updReview.run(review, id).changes;   if (n > 0) local++; }
        if (wav)      { const n = updWav.run(wav, id).changes;        if (n > 0) local++; }
        if (cfg)      { const n = updConfig.run(cfg, id).changes;     if (n > 0) local++; }
        if (resume)   { const n = updResume.run(resume, id).changes;   if (n > 0) local++; }
        if (jd)       { const n = updJd.run(jd, id).changes;           if (n > 0) local++; }
      }
      return local;
    });
    const batch = [];
    for (const [sid, rec] of bySession.entries()) {
      const cfg = (rec.json && fs.existsSync(rec.json))
        ? safeParse(fs.readFileSync(rec.json, 'utf8'), null) : null;
      // 构造 UPDATE 用 5 个字段的值
      let reviewStr = null, wavStr = null, cfgStr = null, resumeStr = null, jdStr = null;
      if (rec.reviewMd && fs.existsSync(rec.reviewMd)) {
        reviewStr = fs.readFileSync(rec.reviewMd, 'utf8');
      }
      if (rec.wav && fs.existsSync(rec.wav)) {
        // 存相对 PROJECT_ROOT 的路径，便于三端都能引用（LOGS_ROOT=项目根/logs）
        wavStr = path.relative(PROJECT_ROOT, rec.wav).split(path.sep).join('/');
      }
      if (cfg && typeof cfg === 'object') {
        // 从 ses_xxx.json 里抽取"配置顶层字段"做快照（不把 rounds 数组这种冗余大字段存进去）
        const { rounds, _cache, history, ...clean } = cfg;
        cfgStr = JSON.stringify(clean);
        // resume/jd 快照也顺便补齐（如果 interview.db 迁移进来的行为空）
        if (cfg.config) {
          const c = cfg.config;
          if (!resumeStr) resumeStr = String(c.resumeContent || c.resumeText || '').slice(0, 40000) || null;
          if (!jdStr)     jdStr     = String(c.jobDescription || c.jdText || '').slice(0, 20000) || null;
        } else {
          if (!resumeStr) resumeStr = String(cfg.resumeContent || cfg.resumeText || cfg.resume || '').slice(0, 40000) || null;
          if (!jdStr)     jdStr     = String(cfg.jobDescription || cfg.jd || '').slice(0, 20000) || null;
        }
      }
      batch.push({ id: sid, review: reviewStr, wav: wavStr, cfg: cfgStr, resume: resumeStr, jd: jdStr });
    }
    filled += doIt(batch);
  }
  summary.m4_status = `OK: 为 ${filled} 行 ia_sessions 补充了扩字段（review_md / wav_path / config_json / resume_snapshot / jd_snapshot），仅对原值为空的行 UPDATE，不会覆盖后续用户手动修改`;
}

// ==================================================================
// Migration 5：logs/ia-history-YYYYMMDD.jsonl → ia_dialog_messages
// ==================================================================
function migrateDialogJsonlInto(db, summary) {
  const historyDir = LOGS_ROOT;
  if (!fs.existsSync(historyDir)) {
    summary.m5_status = 'SKIP: 无 logs 目录';
    return;
  }
  const files = fs.readdirSync(historyDir).filter(f => f.startsWith('ia-history-') && f.endsWith('.jsonl'));
  if (!files.length) { summary.m5_status = 'SKIP: 无 ia-history-*.jsonl 文件'; return; }

  const accountIdFromFilename = () => {
    // 旧版没有按账号分，都进全局账户；这里取 current desktop 账号（若从 AppData 迁移时能知道就填，否则 __guest__）
    if (!DESKTOP_USERDATA_ROOT) return '__guest__';
    const authSessPath = path.join(DESKTOP_USERDATA_ROOT, 'auth-session.json');
    if (!fs.existsSync(authSessPath)) return '__guest__';
    try {
      const s = safeParse(fs.readFileSync(authSessPath, 'utf8'), null);
      return (s && s.session && s.session.accountId) || '__guest__';
    } catch (_) { return '__guest__'; }
  };
  const globalAcc = accountIdFromFilename();

  const ins = db.prepare(`
    INSERT OR IGNORE INTO ia_dialog_messages
      (message_id, account_id, session_id, day_key, role, content, status, created_at)
    VALUES
      (@message_id, @account_id, @session_id, @day_key, @role, @content, @status, @created_at)
  `);
  const runBatch = db.transaction((rows) => {
    let n = 0;
    for (const r of rows) { if (ins.run(r).changes > 0) n++; }
    return n;
  });

  let inserted = 0, lines = 0;
  for (const f of files) {
    const fp = path.join(historyDir, f);
    const text = fs.readFileSync(fp, 'utf8').split(/\r?\n/);
    const batch = [];
    for (const raw of text) {
      if (!raw.trim()) continue;
      lines++;
      const obj = safeParse(raw, null);
      if (!obj) continue;
      const createdAt = Number(obj.createdAt) || Date.now();
      const mid = String(obj.id || (`h_${f}_${lines}`));
      // 归档字段映射：questionText → assistant=之前问题？旧 JSONL 其实是"每一轮问答"一行，我们按
      //   assistant 两条消息合成 user / assistant，避免行太少
      const qText = String(obj.questionText || '').trim();
      const aText = String(obj.answerText || '').trim();
      const eMsg  = String(obj.errorMsg || '').trim();
      const day   = dayKeyOf(createdAt);
      const sess  = String(obj.sessionId || obj.session_id || '');
      const status = (obj.status === 'error' || eMsg) ? 'error' : 'ok';
      if (qText) {
        batch.push({
          message_id: mid + '_q',
          account_id: globalAcc,
          session_id: sess,
          day_key: day,
          role: 'user',
          content: qText,
          status,
          created_at: createdAt,
        });
      }
      if (aText) {
        batch.push({
          message_id: mid + '_a',
          account_id: globalAcc,
          session_id: sess,
          day_key: day,
          role: 'assistant',
          content: aText,
          status,
          created_at: Number(obj.answeredAt) || createdAt + 1,
        });
      }
      if (eMsg && !aText) {
        batch.push({
          message_id: mid + '_e',
          account_id: globalAcc,
          session_id: sess,
          day_key: day,
          role: 'assistant',
          content: eMsg,
          status: 'error',
          created_at: createdAt,
        });
      }
      if (batch.length > 1000) { inserted += runBatch(batch); batch.length = 0; }
    }
    inserted += runBatch(batch);
  }
  summary.m5_status = `OK: ${files.length} 个 JSONL 文件共 ${lines} 行 → ia_dialog_messages 插入 ${inserted} 条（q/a 拆成 2 行消息，IGNORE 去重）`;
}

// ==================================================================
// 迁移主入口：runUnifiedMigration()
// ==================================================================
function runUnifiedMigration() {
  const startedAt = Date.now();
  let db = null;
  const summary = {
    startedAt,
    PROJECT_ROOT,
    DATA_ROOT,
    LOGS_ROOT,
    TARGET_HIREME_DB_PATH: HIREME_DB_PATH,
    DESKTOP_USERDATA_ROOT,
  };
  try {
    // Step 0：建表（通过 landing/db.js 的 require 执行所有 CREATE TABLE IF NOT EXISTS）
    db = openTargetDb();
    summary.schema = 'OK: 16 张表已存在或刚创建';

    migrateLandingDbInto(db, summary);
    migrateInterviewDbInto(db, summary);
    migrateDesktopJsonInto(db, summary);
    migrateSessionExtrasInto(db, summary);
    migrateDialogJsonlInto(db, summary);

    summary.ok = true;
    summary.finishedAt = Date.now();
    summary.durationMs = summary.finishedAt - startedAt;
    // 把汇总打日志文件
    try {
      const crashDir = path.join(LOGS_ROOT, 'crashes');
      if (!fs.existsSync(crashDir)) fs.mkdirSync(crashDir, { recursive: true });
      const tag = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      const out = path.join(crashDir, `migrate-unified-summary-${tag}.json`);
      fs.writeFileSync(out, JSON.stringify(summary, null, 2), 'utf8');
      summary.summaryFile = out;
    } catch (_) {}
    console.log(
      `[migrate-unified] ✅ 完成（耗时 ${summary.durationMs}ms）\n`
      + `  m1: ${summary.m1_status}\n`
      + `  m2: ${summary.m2_status}\n`
      + `  m3: ${summary.m3_status}（${summary.m3_accounts} / ${summary.m3_desktopSession} / ${summary.m3_config} / ${summary.m3_resumes}）\n`
      + `  m4: ${summary.m4_status}\n`
      + `  m5: ${summary.m5_status}\n`
      + `  汇总 JSON: ${summary.summaryFile || '(未写)'}`
    );
    return { ok: true, summary };
  } catch (e) {
    summary.ok = false;
    summary.fatalError = String(e && e.message || e);
    summary.stack = String(e && e.stack || '');
    console.error('[migrate-unified] ❌ 迁移失败：', e && e.stack || e);
    return { ok: false, summary };
  }
}

// ==================================================================
// 支持 CLI：node scripts/migrate-unified-hireme.js 直接跑；
// 也支持被 main.js require 时作为模块导出主函数
// ==================================================================
if (require.main === module) {
  // 注意：CLI 下 better-sqlite3 的路径，用项目根的那个（避免用 landing 子目录的）
  // （node 解析 require('better-sqlite3') 自动会先查项目根 node_modules）
  runUnifiedMigration();
}

module.exports = {
  runUnifiedMigration,
  HIREME_DB_PATH,
};
