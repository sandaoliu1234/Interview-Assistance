/**
 * session-repo.js
 * ----------------------------------------------------------------
 * 🔴 三端统一架构版：面试记录 + 对话消息 SQLite 仓储层。
 *
 * 【数据源变更】：
 *    旧版：构造函数传入独立 interview.db 路径，自行建 ia_sessions/ia_rounds 表
 *    新版：统一打开项目根/data/hireme.db（通过 services/common-paths.js 定位）
 *      - 面试会话：ia_sessions 表（含 20+ 扩展列，与桌面端 config-manager 对齐）
 *      - 面试轮次：ia_rounds 表（含 8 个扩展列，含 round_no/answer_markdown/score 等）
 *      - 对话消息：ia_dialog_messages 表（替代 logs/ia-history-YYYYMMDD.jsonl 归档）
 *
 * 【建表职责】：
 *    本仓储层**不再**执行 CREATE TABLE（避免三端各写一份 DDL 不一致）。
 *    hireme.db 的 16 张表由 landing/db.js 在 Landing 启动时一次性创建 + _safeAddColumn
 *    补齐所有扩展列；桌面端 require 本文件时，若表不存在，所有写操作会因表不存在
 *    而走 _failback() 兜底（返回 false，不阻断原 JSON 主流程）。
 *
 * 【better-sqlite3 ABI 双加载】：
 *    与 authService.js / config-manager.js 完全一致：
 *      - Node v24 (Landing 直跑)：先命中 landing/node_modules/better-sqlite3 (ABI=137)
 *      - Electron 主进程：命中项目根 node_modules/better-sqlite3 (ABI=128，electron-rebuild)
 *    双 try 都走完仍失败 → ready=false，所有方法安全兜底。
 *
 * 【线程/进程安全】（与 common-paths.openUnifiedDatabase 完全一致）：
 *   - journal_mode = WAL（支持三进程并发读写）
 *   - busy_timeout  = 5000ms
 *   - foreign_keys  = ON（session 删除级联 rounds）
 *   - synchronous   = NORMAL
 *   - cache_size    = -8000（~64MB 页缓存）
 *
 * 【所有方法均为同步（better-sqlite3 原生同步 API）】
 * ----------------------------------------------------------------
 */

'use strict';

// ===== 原生 & 三方依赖 =====
const fs   = require('fs');
const path = require('path');

// ============================================================
// 🔴 三端统一数据源：hireme.db（ia_sessions + ia_rounds + ia_dialog_messages）
//    数据库路径 + 打开 PRAGMA 全部复用 common-paths.js
// ============================================================
const {
  HIREME_DB_PATH,
  openUnifiedDatabase,
} = require('./common-paths.js');

/** 面试类型白名单（与 _inferSessionCategory 的输出严格对齐） */
const VALID_CATEGORY = new Set(['copilot', 'mock']);
/** 会话状态白名单 */
const VALID_STATUS = new Set(['active', 'ended']);
/** 轮次状态白名单 */
const VALID_ROUND_STATUS = new Set(['asked', 'answered', 'error']);
/** 对话消息角色白名单（ia_dialog_messages.role） */
const VALID_MSG_ROLE = new Set(['user', 'assistant', 'system']);
/** 对话消息状态白名单 */
const VALID_MSG_STATUS = new Set(['ok', 'error']);

/**
 * 🔴 共享单例 DB 句柄（进程内 session-repo / authService / config-manager
 *    三个模块共用同一个 better-sqlite3 连接，避免多连接争抢 WAL 文件锁）。
 *    由第一个被 require 的模块负责实际打开，后续模块直接复用。
 */
let _sharedDb = null;
let _sharedReady = false;
let _sharedError = null;

/**
 * 惰性获取 hireme.db 共享句柄（与 authService.js/_acquireDb 语义完全对齐）。
 *   - 优先使用调用方传入的 externalDb（Step 7 main.js 统一注入单例时使用）
 *   - 否则走双 ABI 加载 better-sqlite3，并调 openUnifiedDatabase 打开 hireme.db
 *   - 成功后缓存到 _sharedDb，进程内后续 require 全部复用同一条连接
 *
 * @returns {{db: object|null, ready: boolean, error: Error|null}}
 */
function _acquireSharedDb(externalDb) {
  // 1) 外部注入优先（main.js 统一打开后注入，三模块共享同一条连接）
  //    🔴 类型保护：只有"对象 + 有 prepare 方法"才认为是合法 better-sqlite3 句柄；
  //       字符串（老 API 误传 dbPath）、null/undefined、数字等全部跳过，走自打开逻辑。
  if (externalDb && typeof externalDb === 'object' && typeof externalDb.prepare === 'function') {
    _sharedDb = externalDb;
    _sharedReady = true;
    _sharedError = null;
    return { db: _sharedDb, ready: true, error: null };
  }
  // 2) 已缓存直接返回
  if (_sharedDb && _sharedReady) {
    return { db: _sharedDb, ready: true, error: null };
  }
  // 3) 双 ABI 尝试加载 better-sqlite3
  //    · 若 global.__HIREME_BETTER_SQLITE3_PATH__ 存在（main.js 主进程探测通过的路径），只走这一份，
  //      防止 native ABI 加载异常绕过 JS try/catch。
  //    · 否则按运行环境自适应：Electron 主进程 → 先根（Electron ABI）后 landing；Node 环境 → 先 landing 后根。
  let Database = null;
  const preferPath = (typeof global !== 'undefined' && global && typeof global.__HIREME_BETTER_SQLITE3_PATH__ === 'string')
    ? global.__HIREME_BETTER_SQLITE3_PATH__
    : '';
  const isElectronRuntime = !!(process && process.versions && process.versions.electron);
  const nodeFirst = [
    path.join(__dirname, '..', 'landing', 'node_modules', 'better-sqlite3'), // Node v24 ABI=131/137（landing/index.js / 迁移脚本）
    path.join(__dirname, '..', 'node_modules', 'better-sqlite3'),            // Electron ABI=128（兜底）
  ];
  const electronFirst = [
    path.join(__dirname, '..', 'node_modules', 'better-sqlite3'),            // Electron ABI=128（electron-rebuild 过）
    path.join(__dirname, '..', 'landing', 'node_modules', 'better-sqlite3'), // Node ABI（兜底）
  ];
  const candidates = (preferPath ? [preferPath] : []).concat(isElectronRuntime ? electronFirst : nodeFirst);
  let lastErr = null;
  for (const p of candidates) {
    try { delete require.cache[require.resolve(p)]; } catch (_) {}
    try { Database = require(p); break; } catch (e) { lastErr = e; }
  }
  if (!Database) {
    _sharedDb = null;
    _sharedReady = false;
    _sharedError = lastErr || new Error('better-sqlite3 not found');
    console.warn('[session-repo] ⚠️ 无法加载 better-sqlite3：', _sharedError.message, '（仓储层退化为空实现，原 JSON 流程不受影响）');
    return { db: null, ready: false, error: _sharedError };
  }
  // 4) 统一 PRAGMA 打开 hireme.db（含 WAL + busy_timeout + foreign_keys）
  const { db, ready, error } = openUnifiedDatabase(Database);
  _sharedDb = db || null;
  _sharedReady = !!ready;
  _sharedError = error || null;
  if (ready) {
    console.log(`[session-repo] ✅ SQLite 初始化成功（共享单例模式）：DB=${path.relative(process.cwd(), HIREME_DB_PATH)}`);
  } else {
    console.error('[session-repo] ❌ 打开 hireme.db 失败：', error && error.message);
  }
  return { db: _sharedDb, ready: _sharedReady, error: _sharedError };
}

/**
 * 面试记录仓储（桌面端 & Web 端共用同一份）。
 * 🔴 【构造变更】：不再接受 dbPath 参数，统一使用 HIREME_DB_PATH。
 *    可选参数 externalDb：若 main.js 已提前打开 hireme.db 单例，可传入实现三模块共享。
 */
class SessionRepository {
  /**
   * 构造函数。
   * 🔴 【向后兼容】：旧代码可能仍传 `new SessionRepository('/some/interview.db')` 字符串路径，
   *    统一架构下一律改用 HIREME_DB_PATH，所以遇到 string 参数直接忽略（不走外部注入分支），
   *    等价于 `new SessionRepository()` 自打开。这样 main.js 即使没改也不会崩。
   */
  constructor(externalDb = null) {
    // 向后兼容：传入 string（老版 dbPath）→ 忽略，强制走自打开 HIREME_DB_PATH
    if (typeof externalDb === 'string') externalDb = null;

    this.ready = false;         // 可用标记（任何环节失败置 false，所有方法走空兜底）
    this.lastError = null;      // 最近一次错误
    this.db = null;
    this.dbPath = HIREME_DB_PATH; // 与 common-paths 一致，只读暴露给外部打日志

    const { db, ready, error } = _acquireSharedDb(externalDb);
    if (!ready || !db) {
      this.lastError = error || new Error('shared db not ready');
      this.ready = false;
      return;
    }
    this.db = db;
    this.ready = true;
    // 🔴 不再调用 _initTables()：hireme.db 的 16 张表由 landing/db.js 在进程启动时创建
    //    若表仍不存在（例如只启动桌面端、未经过 Landing 初始化），写操作会走 SQLite "no such table"
    //    → _failback() 兜底返回 false，不阻断 JSON 主流程。
  }

  // =============================================================
  // 内部：统一错误兜底（任何方法 try/catch 后调用）
  //   返回 defaultValue 并打印日志；保证 JSON 主流程不被打断
  // =============================================================
  _failback(methodName, err, defaultValue) {
    this.lastError = err || new Error('unknown');
    console.warn(`[session-repo] ⚠️ ${methodName} 失败（已跳过，不影响 JSON 主流程）：`, err && err.message);
    return defaultValue;
  }

  // =============================================================
  // 内部：归一化枚举值（脏值 → 合法兜底，避免 CHECK 约束报错）
  // =============================================================
  _normCategory(c)        { return VALID_CATEGORY.has(c) ? c : 'copilot'; }
  _normStatus(s)          { return VALID_STATUS.has(s)   ? s : 'active'; }
  _normRoundStatus(s)     { return VALID_ROUND_STATUS.has(s) ? s : 'asked'; }
  _normMsgRole(r)         { return VALID_MSG_ROLE.has(r) ? r : 'user'; }
  _normMsgStatus(s)       { return VALID_MSG_STATUS.has(s) ? s : 'ok'; }

  // =============================================================
  // 【写入 1】Upsert 会话主表（session 完整对象传入，字段自动映射）
  //   🔴 兼容 30+ 列：基础列 + 桌面端扩展列（job_title/resume_id/interviewer_mode/total_score...）
  // =============================================================
  upsertSession(session) {
    if (!this.ready || !this.db || !session || !session.id) return false;
    try {
      const now = Date.now();
      const s = session || {};

      // ---- 统计字段：优先用传入值；否则从 rounds.length / stats 推算 ----
      const roundsArray = Array.isArray(s.rounds) ? s.rounds : [];
      const statsObj    = (s.stats && typeof s.stats === 'object') ? s.stats : {};
      const rCount      = Number.isFinite(s.roundCount) ? s.roundCount
                        : (Number.isFinite(statsObj.roundCount) ? statsObj.roundCount : roundsArray.length);
      const aCount      = Number.isFinite(s.answeredCount) ? s.answeredCount
                        : (Number.isFinite(statsObj.answeredCount) ? statsObj.answeredCount : 0);
      const eCount      = Number.isFinite(s.errorCount) ? s.errorCount
                        : (Number.isFinite(statsObj.errorCount) ? statsObj.errorCount : 0);
      const durMs       = Number.isFinite(s.durationMs) ? s.durationMs
                        : (Number.isFinite(statsObj.totalDurationMs) ? statsObj.totalDurationMs
                           : Math.max(0, Number(s.endedAt || 0) - Number(s.startedAt || 0)));
      const qCount      = Number.isFinite(s.questionCount) ? s.questionCount : rCount;
      // total_rounds 与 round_count 语义略有差异：total_rounds 是实际完成轮次
      const totalRounds = Number.isFinite(s.totalRounds || s.total_rounds) ? (s.totalRounds || s.total_rounds) : rCount;

      const stmt = this.db.prepare(`
        INSERT INTO ia_sessions
          (id, account_id, category, title, target_company, target_position, interview_type,
           status, started_at, ended_at, last_active_at, round_count, question_count,
           answered_count, error_count, duration_ms, jd_snapshot, resume_snapshot, snippet,
           wav_path, review_md, config_json, updated_at, synced_at,
           job_title, resume_id, interviewer_mode, total_score, total_rounds, finished_at,
           recording_wav, transcript_json, source, resume_snapshot_md, job_desc_snapshot)
        VALUES
          (@id, @account_id, @category, @title, @target_company, @target_position, @interview_type,
           @status, @started_at, @ended_at, @last_active_at, @round_count, @question_count,
           @answered_count, @error_count, @duration_ms, @jd_snapshot, @resume_snapshot, @snippet,
           @wav_path, @review_md, @config_json, @updated_at, @synced_at,
           @job_title, @resume_id, @interviewer_mode, @total_score, @total_rounds, @finished_at,
           @recording_wav, @transcript_json, @source, @resume_snapshot_md, @job_desc_snapshot)
        ON CONFLICT(id) DO UPDATE SET
          account_id      = excluded.account_id,
          category        = excluded.category,
          title           = excluded.title,
          target_company  = excluded.target_company,
          target_position = excluded.target_position,
          interview_type  = excluded.interview_type,
          status          = excluded.status,
          ended_at        = excluded.ended_at,
          last_active_at  = excluded.last_active_at,
          round_count     = excluded.round_count,
          question_count  = excluded.question_count,
          answered_count  = excluded.answered_count,
          error_count     = excluded.error_count,
          duration_ms     = excluded.duration_ms,
          jd_snapshot     = excluded.jd_snapshot,
          resume_snapshot = excluded.resume_snapshot,
          snippet         = excluded.snippet,
          wav_path        = COALESCE(excluded.wav_path, ia_sessions.wav_path),
          review_md       = COALESCE(excluded.review_md, ia_sessions.review_md),
          config_json     = COALESCE(excluded.config_json, ia_sessions.config_json),
          updated_at      = excluded.updated_at,
          synced_at       = CASE WHEN excluded.synced_at > 0 THEN excluded.synced_at ELSE ia_sessions.synced_at END,
          -- 🔴 桌面端扩展列：只有传了非空/非默认才覆盖，避免 Landing 侧写空值覆盖桌面端的评分
          job_title           = COALESCE(NULLIF(excluded.job_title, ''),           ia_sessions.job_title),
          resume_id           = COALESCE(NULLIF(excluded.resume_id, ''),           ia_sessions.resume_id),
          interviewer_mode    = COALESCE(NULLIF(excluded.interviewer_mode, ''),    ia_sessions.interviewer_mode),
          total_score         = COALESCE(excluded.total_score,                     ia_sessions.total_score),
          total_rounds        = excluded.total_rounds,
          finished_at         = CASE WHEN excluded.finished_at > 0 THEN excluded.finished_at ELSE ia_sessions.finished_at END,
          recording_wav       = COALESCE(excluded.recording_wav,                   ia_sessions.recording_wav),
          transcript_json     = COALESCE(excluded.transcript_json,                 ia_sessions.transcript_json),
          source              = COALESCE(NULLIF(excluded.source, 'unknown'),       ia_sessions.source),
          resume_snapshot_md  = COALESCE(excluded.resume_snapshot_md,              ia_sessions.resume_snapshot_md),
          job_desc_snapshot   = COALESCE(excluded.job_desc_snapshot,               ia_sessions.job_desc_snapshot)
      `);

      const row = {
        // ---- 基础列 ----
        id:                 String(s.id),
        account_id:         String(s.accountId || s.account_id || '__guest__'),
        category:           this._normCategory(s.category),
        title:              String(s.title || '').slice(0, 200),
        target_company:     String(s.targetCompany || s.target_company || '').slice(0, 200),
        target_position:    String(s.targetPosition || s.target_position || '').slice(0, 200),
        interview_type:     String(s.interviewType || s.interview_type || '').slice(0, 100),
        status:             this._normStatus(s.status),
        started_at:         Number(s.startedAt || s.started_at || now),
        ended_at:           Number(s.endedAt || s.ended_at || 0),
        last_active_at:     Number(s.lastActiveAt || s.last_active_at || now),
        round_count:        rCount | 0,
        question_count:     qCount | 0,
        answered_count:     aCount | 0,
        error_count:        eCount | 0,
        duration_ms:        durMs | 0,
        jd_snapshot:        String(s.jdSnapshot || s.jd_snapshot || '').slice(0, 20000),
        resume_snapshot:    String(s.resumeSnapshot || s.resume_snapshot || '').slice(0, 40000),
        snippet:            String(s.snippet || '').slice(0, 500),
        wav_path:           (typeof s.wavPath === 'string' && s.wavPath) ? s.wavPath : null,
        review_md:          (typeof s.reviewMd === 'string' && s.reviewMd)  ? s.reviewMd : null,
        config_json:        (s.configJson || s.config_json)
                              ? (typeof s.configJson === 'string' ? s.configJson : JSON.stringify(s.configJson || s.config_json))
                              : null,
        updated_at:         now,
        synced_at:          Number(s.syncedAt || s.synced_at || 0),
        // ---- 桌面端扩展列 ----
        job_title:          String(s.jobTitle || s.job_title || '').slice(0, 200),
        resume_id:          String(s.resumeId || s.resume_id || '').slice(0, 100),
        interviewer_mode:   String(s.interviewerMode || s.interviewer_mode || 'standard').slice(0, 50),
        total_score:        (typeof s.totalScore === 'number' || typeof s.total_score === 'number')
                              ? Number(s.totalScore ?? s.total_score) : null,
        total_rounds:       totalRounds | 0,
        finished_at:        Number(s.finishedAt || s.finished_at || 0),
        recording_wav:      (typeof s.recordingWav === 'string' && s.recordingWav) ? s.recordingWav
                            : (typeof s.recording_wav === 'string' && s.recording_wav) ? s.recording_wav : null,
        transcript_json:    (s.transcriptJson || s.transcript_json)
                              ? (typeof s.transcriptJson === 'string' ? s.transcriptJson : JSON.stringify(s.transcriptJson || s.transcript_json))
                              : null,
        source:             String(s.source || 'localHttp').slice(0, 50),
        resume_snapshot_md: (typeof s.resumeSnapshotMd === 'string' && s.resumeSnapshotMd) ? s.resumeSnapshotMd
                            : (typeof s.resume_snapshot_md === 'string' && s.resume_snapshot_md) ? s.resume_snapshot_md : null,
        job_desc_snapshot:  (typeof s.jobDescSnapshot === 'string' && s.jobDescSnapshot) ? s.jobDescSnapshot
                            : (typeof s.job_desc_snapshot === 'string' && s.job_desc_snapshot) ? s.job_desc_snapshot : null,
      };

      const info = stmt.run(row);
      return !!(info && info.changes && info.changes > 0);
    } catch (e) {
      return this._failback('upsertSession', e, false);
    }
  }

  // =============================================================
  // 【写入 2】Upsert 一轮（创建新 round 或对已有 round 更新 answer）
  //   🔴 兼容 8 个扩展列：round_no/round_id/question/answer_markdown/
  //                         audio_wav_path/score/score_breakdown_json/duration_ms
  // =============================================================
  upsertRound(round) {
    if (!this.ready || !this.db || !round || !round.id || !round.sessionId) return false;
    try {
      const r = round;
      const stmt = this.db.prepare(`
        INSERT INTO ia_rounds
          (id, session_id, seq, status, source, question_text, question_image,
           answer_text, error_msg, created_at, answered_at,
           round_no, round_id, question, answer_markdown,
           audio_wav_path, score, score_breakdown_json, duration_ms)
        VALUES
          (@id, @session_id, @seq, @status, @source, @question_text, @question_image,
           @answer_text, @error_msg, @created_at, @answered_at,
           @round_no, @round_id, @question, @answer_markdown,
           @audio_wav_path, @score, @score_breakdown_json, @duration_ms)
        ON CONFLICT(id) DO UPDATE SET
          seq                 = excluded.seq,
          status              = excluded.status,
          source              = excluded.source,
          question_text       = excluded.question_text,
          question_image      = COALESCE(excluded.question_image, ia_rounds.question_image),
          answer_text         = excluded.answer_text,
          error_msg           = excluded.error_msg,
          answered_at         = excluded.answered_at,
          -- 🔴 桌面端扩展列：round_no/round_id/question 冗余对齐列，answer_markdown/score 评分等
          round_no            = excluded.round_no,
          round_id            = COALESCE(NULLIF(excluded.round_id, ''), ia_rounds.round_id),
          question            = COALESCE(NULLIF(excluded.question, ''), ia_rounds.question),
          answer_markdown     = COALESCE(excluded.answer_markdown, ia_rounds.answer_markdown),
          audio_wav_path      = COALESCE(excluded.audio_wav_path, ia_rounds.audio_wav_path),
          score               = COALESCE(excluded.score, ia_rounds.score),
          score_breakdown_json= COALESCE(excluded.score_breakdown_json, ia_rounds.score_breakdown_json),
          duration_ms         = excluded.duration_ms
      `);

      const qTxtRaw = String(r.questionText || r.question_text || r.question || '');
      const seqVal = Number.isFinite(r.seq) ? r.seq | 0 : 0;
      const info = stmt.run({
        // ---- 基础列 ----
        id:                 String(r.id),
        session_id:         String(r.sessionId),
        seq:                seqVal,
        status:             this._normRoundStatus(r.status),
        source:             String(r.source || 'unknown').slice(0, 50),
        question_text:      qTxtRaw,
        question_image:     (r.questionImage && typeof r.questionImage === 'string' && r.questionImage.length > 0)
                              ? r.questionImage
                              : (r.question_image && typeof r.question_image === 'string' && r.question_image.length > 0)
                                ? r.question_image : null,
        answer_text:        String(r.answerText || r.answer_text || ''),
        error_msg:          String(r.errorMsg || r.error_msg || ''),
        created_at:         Number(r.createdAt || r.created_at || 0),
        answered_at:        Number(r.answeredAt || r.answered_at || 0),
        // ---- 桌面端扩展列 ----
        round_no:           Number.isFinite(r.roundNo || r.round_no) ? (r.roundNo || r.round_no) | 0 : seqVal,
        round_id:           String(r.roundId || r.round_id || r.id || '').slice(0, 100),
        question:           qTxtRaw,
        answer_markdown:    (typeof r.answerMarkdown === 'string' && r.answerMarkdown) ? r.answerMarkdown
                            : (typeof r.answer_markdown === 'string' && r.answer_markdown) ? r.answer_markdown : null,
        audio_wav_path:     (typeof r.audioWavPath === 'string' && r.audioWavPath) ? r.audioWavPath
                            : (typeof r.audio_wav_path === 'string' && r.audio_wav_path) ? r.audio_wav_path : null,
        score:              (typeof r.score === 'number') ? Number(r.score)
                            : (typeof r.scoreValue === 'number') ? Number(r.scoreValue) : null,
        score_breakdown_json: (r.scoreBreakdown || r.score_breakdown_json)
                                ? (typeof r.scoreBreakdown === 'string' ? r.scoreBreakdown : JSON.stringify(r.scoreBreakdown || r.score_breakdown_json))
                                : null,
        duration_ms:        Number.isFinite(r.durationMs || r.duration_ms) ? (r.durationMs || r.duration_ms) | 0 : 0,
      });
      return !!(info && info.changes && info.changes > 0);
    } catch (e) {
      return this._failback('upsertRound', e, false);
    }
  }

  // =============================================================
  // 【写入 3】批量 upsert 某个 session 的完整 rounds[]（事务）
  // =============================================================
  upsertRoundsForSession(sessionId, rounds) {
    if (!this.ready || !this.db || !sessionId || !Array.isArray(rounds)) return false;
    try {
      const doInsert = this.db.transaction((list) => {
        for (let i = 0; i < list.length; i++) {
          const r = list[i];
          if (!r || !r.id) continue;
          this.upsertRound(Object.assign({}, r, { sessionId: sessionId, seq: i }));
        }
      });
      doInsert(rounds);
      return true;
    } catch (e) {
      return this._failback('upsertRoundsForSession', e, false);
    }
  }

  // =============================================================
  // 【写入 4】结束会话（status=ended + 写 endedAt/finishedAt）
  // =============================================================
  endSession(id, endedAtMs) {
    if (!this.ready || !this.db || !id) return false;
    try {
      const t = Number(endedAtMs) || Date.now();
      const info = this.db.prepare(
        `UPDATE ia_sessions
            SET status='ended', ended_at=?, finished_at=?,
                last_active_at=MAX(last_active_at,?), updated_at=?
          WHERE id=? AND status!='ended'`
      ).run(t, t, t, t, String(id));
      return !!(info && info.changes && info.changes > 0);
    } catch (e) {
      return this._failback('endSession', e, false);
    }
  }

  // =============================================================
  // 【写入 5】可选：写 wav 路径 / review 报告 / 整场 WAV / 全文 transcript
  // =============================================================
  setWavPath(id, wavPath) {
    if (!this.ready || !this.db || !id) return false;
    try {
      const info = this.db.prepare('UPDATE ia_sessions SET wav_path=?, updated_at=? WHERE id=?')
        .run(String(wavPath || ''), Date.now(), String(id));
      return !!(info && info.changes);
    } catch (e) { return this._failback('setWavPath', e, false); }
  }
  setReviewMd(id, reviewMd) {
    if (!this.ready || !this.db || !id) return false;
    try {
      const info = this.db.prepare('UPDATE ia_sessions SET review_md=?, updated_at=? WHERE id=?')
        .run(String(reviewMd || ''), Date.now(), String(id));
      return !!(info && info.changes);
    } catch (e) { return this._failback('setReviewMd', e, false); }
  }
  setRecordingWav(id, recordingWav) {
    if (!this.ready || !this.db || !id) return false;
    try {
      const info = this.db.prepare('UPDATE ia_sessions SET recording_wav=?, updated_at=? WHERE id=?')
        .run(String(recordingWav || ''), Date.now(), String(id));
      return !!(info && info.changes);
    } catch (e) { return this._failback('setRecordingWav', e, false); }
  }
  setTranscriptJson(id, transcriptObjOrJson) {
    if (!this.ready || !this.db || !id) return false;
    try {
      const json = (typeof transcriptObjOrJson === 'string')
        ? transcriptObjOrJson
        : JSON.stringify(transcriptObjOrJson || {});
      const info = this.db.prepare('UPDATE ia_sessions SET transcript_json=?, updated_at=? WHERE id=?')
        .run(json, Date.now(), String(id));
      return !!(info && info.changes);
    } catch (e) { return this._failback('setTranscriptJson', e, false); }
  }

  // =============================================================
  // 【写入 6】删除某场面试（先删 rounds 再删 session，双保险）
  // =============================================================
  deleteSession(id) {
    if (!this.ready || !this.db || !id) return false;
    try {
      const delRounds = this.db.prepare('DELETE FROM ia_rounds          WHERE session_id=?');
      const delMsgs   = this.db.prepare('DELETE FROM ia_dialog_messages WHERE session_id=?');
      const delSess   = this.db.prepare('DELETE FROM ia_sessions        WHERE id=?');
      const tx = this.db.transaction((sid) => {
        delRounds.run(sid);
        delMsgs.run(sid);  // 🔴 同时清理该场绑定的对话消息
        const info = delSess.run(sid);
        return !!(info && info.changes && info.changes > 0);
      });
      return tx(String(id));
    } catch (e) { return this._failback('deleteSession', e, false); }
  }

  // =============================================================
  // 【写入 7】🔴 新增：追加一条对话消息（替代 localHttpServer._evictHistoryIfOverflow 写 JSONL）
  //    Copilot 实时对话里溢出的每条历史消息，写入 ia_dialog_messages 表，便于以后检索
  // =============================================================
  appendDialogMessage(msg) {
    if (!this.ready || !this.db || !msg) return false;
    try {
      const now = Date.now();
      const m = msg || {};
      // day_key = YYYYMMDD（取消息创建时间，与原 JSONL 按天归档对齐）
      const ts = Number(m.createdAt || m.created_at || now);
      const d = new Date(ts);
      const pad = (n) => String(n).padStart(2, '0');
      const dayKey = String(d.getFullYear()) + pad(d.getMonth() + 1) + pad(d.getDate());

      const stmt = this.db.prepare(`
        INSERT OR IGNORE INTO ia_dialog_messages
          (message_id, account_id, session_id, day_key, role, content, status, created_at)
        VALUES
          (@message_id, @account_id, @session_id, @day_key, @role, @content, @status, @created_at)
      `);
      const row = {
        message_id: String(m.messageId || m.id || ('msg-' + now.toString(36) + '-' + Math.random().toString(36).slice(2, 6))),
        account_id: String(m.accountId || m.account_id || '__guest__'),
        session_id: String(m.sessionId || m.session_id || ''),
        day_key:    dayKey,
        role:       this._normMsgRole(m.role),
        content:    String(m.content || '').slice(0, 500000), // 单条上限 500k，与 JSONL 归档容忍度一致
        status:     this._normMsgStatus(m.status),
        created_at: ts,
      };
      const info = stmt.run(row);
      return !!(info && info.changes && info.changes > 0);
    } catch (e) { return this._failback('appendDialogMessage', e, false); }
  }

  // =============================================================
  // 【写入 8】🔴 新增：批量追加对话消息（事务，迁移脚本/一次性对齐用）
  // =============================================================
  appendDialogMessages(msgs) {
    if (!this.ready || !this.db || !Array.isArray(msgs)) return false;
    try {
      const tx = this.db.transaction((list) => {
        for (let i = 0; i < list.length; i++) this.appendDialogMessage(list[i]);
      });
      tx(msgs);
      return true;
    } catch (e) { return this._failback('appendDialogMessages', e, false); }
  }

  // =============================================================
  // 【查询 1】列表（兼容原 localHttpServer.listSessions 返回结构）
  //   🟢 严格按账号隔离：只返回 ia_sessions.account_id === 当前 accountId 的数据
  //      不再做"账号过滤=0 就降级显示全局"的兜底 —— 避免把 GUEST/其他账号的数据
  //      串到已登录用户下，违反"用户登录后只能看到自己 SQLite 中相关数据"的需求。
  // =============================================================
  listSessions(opts = {}) {
    if (!this.ready || !this.db) {
      return { ok: false, total: 0, sessions: [], keyword: '', category: '', limit: 50, offset: 0, page: 1, pageSize: 9, error: 'session_repo_not_ready' };
    }
    try {
      // 兼容两种调用风格：
      //   ① 桌面端传统： { accountId, keyword, category, limit, offset }
      //   ② Landing 风格：{ accountId, keyword, category, page, pageSize }   —— 自动换算成 limit/offset
      //
      // 🔴 注意：opts.accountId == null 时不写死 '__guest__'，因为调用方如果没传
      //    通常是"外部直连"场景（如 Landing 的 /api/sessions/list 不带 aid），
      //    此时应返回空（即显式"必须登录才能看到自己的数据"）；若调用方明确想要
      //    看 GUEST，就显式传 accountId='__guest__'。
      const accountIdRaw = (opts && opts.accountId != null) ? String(opts.accountId) : '';
      const kw = String((opts && opts.keyword) || '').trim();
      const cat = String((opts && opts.category) || '').trim().toLowerCase();
      let lim = Number(opts && (opts.limit != null) ? opts.limit : (opts && opts.pageSize ? opts.pageSize : 50));
      let off = Number(opts && (opts.offset != null) ? opts.offset : NaN);
      const pn  = Number(opts && opts.page);
      const psz = Number(opts && opts.pageSize);
      if (!Number.isFinite(off) && Number.isFinite(pn) && Number.isFinite(psz) && pn >= 1 && psz >= 1) {
        // 有 page/pageSize 没 offset → 自动算
        off = (pn - 1) * psz;
        lim = psz;
      }
      lim = Math.max(1, Math.min(200, Number(lim) || 50));
      off = Math.max(0, Number(off) || 0);

      // 🟢 严格隔离：直接用 accountIdRaw 过滤，不再做任何"账号=0 → 放宽全局"的降级
      const result = this._listSessionsInternal({ accountId: accountIdRaw, keyword: kw, category: cat, limit: lim, offset: off });
      // 回传 page / pageSize 便于前端渲染（Landing sessions-db.js 会用到）
      result.page     = Number.isFinite(pn) && pn >= 1 ? pn : Math.floor(off / lim) + 1;
      result.pageSize = lim;
      result.accountFallback = false; // 明确告知前端：没降级，显示的就是当前账号名下的
      return result;
    } catch (e) {
      return this._failback('listSessions', e, {
        ok: false, total: 0, sessions: [],
        keyword: (opts && opts.keyword) || '', category: (opts && opts.category) || '',
        limit: 50, offset: 0, page: 1, pageSize: 9, error: e && e.message,
      });
    }
  }

  /** 内部：真正执行 WHERE + COUNT + 分页查询的纯函数（无降级逻辑，便于 listSessions 调两次） */
  _listSessionsInternal({ accountId, keyword, category, limit, offset }) {
    const where = [];
    const params = [];
    if (accountId) {
      where.push('account_id = ?');
      params.push(String(accountId));
    }
    if (category === 'copilot' || category === 'mock') {
      where.push('category = ?');
      params.push(category);
    }
    if (keyword) {
      const like = `%${keyword}%`;
      where.push('(target_company LIKE ? OR target_position LIKE ? OR title LIKE ? OR snippet LIKE ?)');
      params.push(like, like, like, like);
    }
    const whereClause = where.length ? where.join(' AND ') : '1=1';

    const totalRow = this.db.prepare(`SELECT COUNT(*) AS c FROM ia_sessions WHERE ${whereClause}`).get(...params);
    const total = Number(totalRow && totalRow.c) || 0;

    const rows = this.db.prepare(`
      SELECT * FROM ia_sessions
       WHERE ${whereClause}
       ORDER BY COALESCE(last_active_at, ended_at, started_at, created_at) DESC, id DESC
       LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    const getLast2 = this.db.prepare(
      `SELECT question_text, answer_text, status, created_at
         FROM ia_rounds WHERE session_id=? ORDER BY seq DESC LIMIT 2`
    );
    const sessions = rows.map((row) => {
      const last2 = getLast2.all(row.id);
      return {
        // ID & 分类
        id: row.id, sessionId: row.id,
        category: row.category, status: row.status, interviewType: row.interview_type,
        // 文本
        title: row.title, targetCompany: row.target_company, targetPosition: row.target_position,
        target_company: row.target_company, target_position: row.target_position,
        snippet: row.snippet,
        // 时间
        startedAt: row.started_at, started_at: row.started_at,
        endedAt: row.ended_at, ended_at: row.ended_at,
        lastActiveAt: row.last_active_at, last_active_at: row.last_active_at,
        createdAt: Number(row.created_at) || 0, created_at: Number(row.created_at) || 0,
        updatedAt: Number(row.updated_at) || 0, updated_at: Number(row.updated_at) || 0,
        // 统计
        roundCount: row.round_count, roundsCount: row.round_count, round_count: row.round_count,
        questionCount: row.question_count, question_count: row.question_count,
        answeredCount: row.answered_count, answered_count: row.answered_count,
        errorCount: row.error_count, error_count: row.error_count,
        durationMs: row.duration_ms, duration_ms: row.duration_ms,
        totalScore: row.total_score, total_rounds: row.total_rounds,
        // 最近两轮
        lastRounds: last2.map((r) => ({
          questionText: r.question_text, answerText: r.answer_text,
          status: r.status, createdAt: r.created_at,
        })),
      };
    });
    return { ok: true, total, sessions, keyword, category, limit, offset };
  }

  // =============================================================
  // 【查询 2】单条详情（含 rounds[]，与原 {id}.json 100% 兼容 + 扩展字段）
  // =============================================================
  getSessionDetail(id) {
    if (!this.ready || !this.db || !id) return null;
    try {
      const row = this.db.prepare('SELECT * FROM ia_sessions WHERE id=?').get(String(id));
      if (!row) return null;
      const roundRows = this.db.prepare('SELECT * FROM ia_rounds WHERE session_id=? ORDER BY seq ASC').all(String(id));
      return {
        // 基础字段：驼峰（与原 JSON 结构一致）
        id: row.id, category: row.category, title: row.title,
        targetCompany: row.target_company, targetPosition: row.target_position,
        interviewType: row.interview_type,
        jdSnapshot: row.jd_snapshot, resumeSnapshot: row.resume_snapshot,
        startedAt: row.started_at, endedAt: row.ended_at, status: row.status,
        lastActiveAt: row.last_active_at, accountId: row.account_id,
        // 统计
        stats: {
          roundCount: row.round_count, answeredCount: row.answered_count,
          errorCount: row.error_count, totalDurationMs: row.duration_ms,
          totalScore: row.total_score, totalRounds: row.total_rounds,
        },
        roundCount: row.round_count, roundsCount: row.round_count,
        questionCount: row.question_count, answeredCount: row.answered_count,
        errorCount: row.error_count, durationMs: row.duration_ms,
        totalScore: row.total_score, totalRounds: row.total_rounds,
        // 扩展
        snippet: row.snippet, wavPath: row.wav_path, reviewMd: row.review_md,
        syncedAt: row.synced_at, jobTitle: row.job_title, resumeId: row.resume_id,
        interviewerMode: row.interviewer_mode, finishedAt: row.finished_at,
        recordingWav: row.recording_wav, source: row.source,
        // rounds：驼峰 + 扩展列
        rounds: roundRows.map((r) => ({
          id: r.id, sessionId: r.session_id, seq: r.seq,
          status: r.status, source: r.source,
          questionText: r.question_text,
          questionImage: r.question_image || '',
          answerText: r.answer_text,
          errorMsg: r.error_msg,
          createdAt: r.created_at, answeredAt: r.answered_at,
          // 扩展
          roundNo: r.round_no, roundId: r.round_id,
          question: r.question,
          answerMarkdown: r.answer_markdown,
          audioWavPath: r.audio_wav_path,
          score: r.score,
          scoreBreakdown: r.score_breakdown_json,
          durationMs: r.duration_ms,
        })),
      };
    } catch (e) { return this._failback('getSessionDetail', e, null); }
  }

  // =============================================================
  // 【查询 3】🔴 新增：查询对话消息（按账号 + 可选 sessionId + 时间范围）
  //    用于替代读 logs/ia-history-YYYYMMDD.jsonl 做"历史消息回溯"
  // =============================================================
  listDialogMessages({ accountId = '__guest__', sessionId = '', dayKey = '', role = '', limit = 200, offset = 0 } = {}) {
    if (!this.ready || !this.db) {
      return { ok: false, total: 0, messages: [], error: 'session_repo_not_ready' };
    }
    try {
      const where = ['account_id = ?'];
      const params = [String(accountId || '__guest__')];
      if (sessionId) { where.push('session_id = ?'); params.push(String(sessionId)); }
      if (dayKey)    { where.push('day_key = ?');    params.push(String(dayKey)); }
      if (VALID_MSG_ROLE.has(role)) { where.push('role = ?'); params.push(role); }
      const whereClause = where.join(' AND ');

      const totalRow = this.db.prepare(`SELECT COUNT(*) AS c FROM ia_dialog_messages WHERE ${whereClause}`).get(...params);
      const total = Number(totalRow && totalRow.c) || 0;

      const lim = Math.max(1, Math.min(2000, Number(limit) || 200));
      const off = Math.max(0, Number(offset) || 0);
      const rows = this.db.prepare(`
        SELECT * FROM ia_dialog_messages
         WHERE ${whereClause}
         ORDER BY created_at ASC, message_id ASC
         LIMIT ? OFFSET ?
      `).all(...params, lim, off);

      const messages = rows.map((r) => ({
        messageId: r.message_id, id: r.message_id,
        accountId: r.account_id, sessionId: r.session_id,
        dayKey: r.day_key, role: r.role,
        content: r.content, status: r.status,
        createdAt: r.created_at,
      }));
      return { ok: true, total, messages };
    } catch (e) { return this._failback('listDialogMessages', e, { ok: false, total: 0, messages: [], error: e && e.message }); }
  }

  // =============================================================
  // 【工具】按 ID 判断 session 是否已存在
  // =============================================================
  exists(id) {
    if (!this.ready || !this.db || !id) return false;
    try {
      const r = this.db.prepare('SELECT 1 AS x FROM ia_sessions WHERE id=?').get(String(id));
      return !!(r && r.x);
    } catch (e) { return this._failback('exists', e, false); }
  }

  // =============================================================
  // 【工具】DB 健康检查（main.js 启动日志用，新增 ia_dialog_messages 计数）
  // =============================================================
  health() {
    if (!this.ready || !this.db) {
      return { ok: false, msg: (this.lastError && this.lastError.message) || 'not_ready' };
    }
    try {
      const counts = this.db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM ia_sessions)         AS sessions,
          (SELECT COUNT(*) FROM ia_rounds)            AS rounds,
          (SELECT COUNT(*) FROM ia_dialog_messages)   AS messages
      `).get();
      // ★ 【三端同步对齐】按 category 分组统计（与 sessions-db.js GET /health 字段完全一致）
      const catRows = this.db.prepare(
        `SELECT category AS c, COUNT(*) AS n FROM ia_sessions GROUP BY category ORDER BY category`
      ).all();
      const categories = {};
      for (const r of catRows) {
        categories[String(r.c || '')] = Number(r.n || 0);
      }
      return {
        ok: true,
        sessionCount: counts.sessions,
        roundCount: counts.rounds,
        messageCount: counts.messages,
        categories: categories,
        dbPath: this.dbPath,
      };
    } catch (e) { return { ok: false, msg: e && e.message }; }
  }

  // =============================================================
  // 【工具】关闭 DB（进程退出前清理，可选）
  //   🔴 进程内三模块共享同一条连接（_sharedDb 单例），close() 必须保证：
  //      1) 只在 this.db === _sharedDb（仍是共享句柄）时才真正清理共享状态；
  //      2) 若外部曾注入 externalDb（非共享路径），不要碰 _sharedDb 单例。
  //      实际生产中很少主动调 close()，进程退出时 SQLite 会自动清理。
  // =============================================================
  close() {
    try {
      // 只有"实例句柄 === 共享单例句柄"时才真正 close + 清共享缓存
      if (this.db && this.db === _sharedDb) {
        try { this.db.close(); } catch (_) { /* ignore */ }
        _sharedDb = null;
        _sharedReady = false;
        _sharedError = null;
      } else if (this.db) {
        // 外部注入的独立 externalDb：只关自己的，不影响共享单例（极端场景）
        try { this.db.close(); } catch (_) { /* ignore */ }
      }
    } catch (_) { /* ignore */ }
    this.db = null;
    this.ready = false;
  }
}

module.exports = SessionRepository;
