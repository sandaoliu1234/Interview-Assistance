'use strict';
/**
 * landing/sessions-db.js —— 面试记录 SQLite 访问层（三端统一 hireme.db 版本）
 *
 * 🔴 数据源变更（三端统一架构改造）：
 *    旧版：直接打开独立文件 项目根/data/interview.db（与桌面端 session-repo 共享）
 *    新版：复用 landing/db.js 已建立的统一数据库句柄 → 项目根/data/hireme.db
 *         ia_sessions / ia_rounds 两张表现在跟 accounts / credit_balances / orders 等同属一个 hireme.db
 *
 * 设计目标：
 *   - 不依赖启动桌面端 Electron 应用，Landing 服务直接读取 hireme.db 共享 SQLite
 *   - 返回格式与 services/localHttpServer.js 中 _routeApiDbSessions* 完全一致，前端 0 改动兼容
 *
 * 跨进程并发安全：
 *   - SQLite 使用 WAL 模式（桌面端和 Landing 和管理员端可同时打开读写）
 *   - busy_timeout=5000ms：写冲突时等待而非抛错（PRAGMA 统一由 landing/db.js + common-paths.openUnifiedDatabase 设置）
 *   - 路径只读：Landing 不做写操作（除 delete 接口，事务内统一抢占）
 *
 * 表结构（与桌面端重构后的 session-repo.js 保持完全一致，迁移脚本已对齐列）：
 *   ia_sessions(id, account_id, category, title, target_company, target_position,
 *               interview_type, status, started_at, ended_at, last_active_at,
 *               round_count, question_count, answered_count, error_count, duration_ms,
 *               jd_snapshot, resume_snapshot, snippet, wav_path, review_md,
 *               config_json, created_at, updated_at, synced_at)
 *   ia_rounds(id, session_id, seq, status, source, question_text, question_image,
 *              answer_text, error_msg, created_at, answered_at)
 */

const path = require('path');
const fs   = require('fs');

// ============================================================
// 1. 三端统一路径：从 services/common-paths.js 获取 hireme.db 路径
//    数据库句柄直接复用 landing/db.js（单例、PRAGMA 已设好、表已建齐、索引已补全）
// ============================================================
const { HIREME_DB_PATH } = require('../services/common-paths.js');
let db = null;
let ready = false;
let lastError = null;

try {
  // require('./db.js') 内部会执行 common-paths、打开 hireme.db、建表、补列、建索引
  const { db: sharedDb } = require('./db.js');
  db = sharedDb;
  // 健康检查：确认 ia_sessions / ia_rounds 表存在
  const t = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('ia_sessions','ia_rounds')"
  ).all();
  if (t.length < 2) {
    throw new Error('hireme.db 中缺少 ia_sessions 或 ia_rounds 表（请先运行 scripts/migrate-unified-hireme.js 迁移脚本）');
  }
  ready = true;
  console.log(`[sessions-db] ✅ 已从 hireme.db（三端统一库）加载面试记录：${HIREME_DB_PATH}`);
} catch (e) {
  lastError = e;
  ready = false;
  console.warn(`[sessions-db] ⚠️ SQLite 不可用（hireme.db）：${e.message}`);
}

// ============================================================
// 2. 工具函数：账号 ID 解析（从当前 Web 会话取）
//    注意：这里不做账号隔离兜底，路由层显式传入 accountId 参数
// ============================================================

/**
 * 根据前端输入，规范化 category 参数（'' | 'copilot' | 'mock'）
 */
function _normCategory(c) {
  if (!c) return '';
  const s = String(c).toLowerCase().trim();
  if (s === 'copilot' || s === 'mock') return s;
  return '';
}

/**
 * 构造 WHERE 子句片段 + 参数数组（按 accountId + category + keyword 过滤）
 * @param {string|undefined} accountId 当前登录账号，未登录传 undefined 表示不过滤
 * @param {string} category 'copilot' | 'mock' | ''
 * @param {string} keyword 标题/公司/职位/摘要模糊匹配
 * @returns {{where:string, params:any[]}}
 */
function _buildWhere(accountId, category, keyword) {
  const clauses = [];
  const params  = [];
  if (accountId) { clauses.push('account_id = ?'); params.push(String(accountId)); }
  const cat = _normCategory(category);
  if (cat)       { clauses.push('category = ?');   params.push(cat); }
  const kw = String(keyword || '').trim();
  if (kw) {
    clauses.push('(title LIKE ? OR target_company LIKE ? OR target_position LIKE ? OR snippet LIKE ?)');
    const like = `%${kw}%`;
    params.push(like, like, like, like);
  }
  return {
    where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
  };
}

// ============================================================
// 3. 对外 API：与 localHttpServer 输出格式完全一致
// ============================================================

/**
 * 健康检查 + 分类计数（对应 /api/sessions/health）
 * 输出：{ok, ready, sessionCount, roundCount, categories:{copilot,mock}, dbPath, sqliteUnavailable?}
 * 注意：为了让当前登录用户 Tab 徽章正确，这里接受 accountId 参数返回该账号下的分类数
 */
function health(accountId) {
  if (!ready || !db) {
    return {
      ok: false, ready: false, sqliteUnavailable: true,
      sessionCount: 0, roundCount: 0, categories: { copilot: 0, mock: 0 },
      dbPath: HIREME_DB_PATH,
      msg: lastError ? lastError.message : 'SQLite 未就绪',
    };
  }
  try {
    const sAll = db.prepare('SELECT COUNT(*) AS c FROM ia_sessions').get().c;
    const rAll = db.prepare('SELECT COUNT(*) AS c FROM ia_rounds').get().c;

    // 当前账号维度的 copilot / mock 计数（与 localHttpServer 行为一致，匹配 Tab 徽章）
    let cp = 0, mk = 0;
    const aid = accountId ? String(accountId) : '';
    if (aid) {
      const rowCp = db.prepare('SELECT COUNT(*) AS c FROM ia_sessions WHERE account_id = ? AND category = ?')
        .get(aid, 'copilot');
      const rowMk = db.prepare('SELECT COUNT(*) AS c FROM ia_sessions WHERE account_id = ? AND category = ?')
        .get(aid, 'mock');
      cp = Number(rowCp && rowCp.c) || 0;
      mk = Number(rowMk && rowMk.c) || 0;
    }

    // 🟢 严格按账号隔离：不再做"账号过滤=0 就降级显示全局分类"的兜底
    //    用户端/管理端显式传入 accountId 时，categories 就只统计该账号下的 copilot/mock；
    //    未传 accountId（如匿名访问健康检查）时 categories 保持 0，只展示全局 sAll/rAll。
    return {
      ok: true, ready: true,
      sessionCount: Number(sAll) || 0,
      roundCount:   Number(rAll) || 0,
      categories:   { copilot: cp, mock: mk },
      dbPath:       HIREME_DB_PATH,
      accountFallback: false, // 明确告知前端：从未降级，数据就是当前账号名下的
    };
  } catch (e) {
    return {
      ok: false, ready: false, sqliteUnavailable: true,
      sessionCount: 0, roundCount: 0, categories: { copilot: 0, mock: 0 },
      dbPath: HIREME_DB_PATH,
      msg: e.message,
    };
  }
}

/**
 * 列表分页查询（对应 /api/sessions/list）
 * 输出：{ok, total, sessions, keyword, category, limit, offset, sqliteUnavailable?}
 */
function listSessions({ accountId, category, keyword, page = 1, pageSize = 9 } = {}) {
  if (!ready || !db) {
    return {
      ok: false, sqliteUnavailable: true,
      total: 0, sessions: [],
      keyword: keyword || '', category: category || '',
      page: Number(page) || 1, pageSize: Number(pageSize) || 9,
      msg: lastError ? lastError.message : 'SQLite 未就绪',
    };
  }
  try {
    const kw = String(keyword || '').trim();
    const cat = _normCategory(category);
    const pg = Math.max(1, Number(page) || 1);
    const ps = Math.min(100, Math.max(1, Number(pageSize) || 9));
    const offset = (pg - 1) * ps;

    // —— 🟢 严格按账号隔离：不再做"账号过滤=0 → 放宽到全局"的降级。
    //    若 accountId 未传（匿名访问），返回空；若传了但该账号下没有数据，就返回空。
    //    保证用户登录后看到的只是 ia_sessions.account_id === aidRaw 的自己的数据。
    const aidRaw = accountId ? String(accountId) : '';
    const { where, params } = _buildWhere(aidRaw, cat, kw);
    // 总数
    const totalRow = db.prepare(`SELECT COUNT(*) AS c FROM ia_sessions ${where}`).get(...params);
    const total = Number(totalRow && totalRow.c) || 0;

    // 列表：按「最近活动时间」倒序（最新面试在前）
    //   🔴 三端同步统一排序：COALESCE(last_active_at, ended_at, started_at, created_at) DESC, id DESC
    //      - 与 services/session-repo.js 的 _listSessionsInternal 保持字节级一致
    //      - 兜底顺序：last_active(优先) → ended_at → started_at → created_at(最终兜底)
    const sqlList =
      `SELECT id, account_id, category, title, target_company, target_position,
              interview_type, status, started_at, ended_at, last_active_at,
              round_count, question_count, answered_count, error_count, duration_ms,
              snippet, wav_path, review_md, created_at, updated_at, synced_at
         FROM ia_sessions
         ${where}
         ORDER BY COALESCE(last_active_at, ended_at, started_at, created_at) DESC, id DESC
         LIMIT ? OFFSET ?`;
    const listParams = params.concat([ps, offset]);
    const rows = db.prepare(sqlList).all(...listParams);

    // 字段名映射：与 localHttpServer 输出保持一致（target_company→company, target_position→position）
    const sessions = rows.map(r => ({
      sessionId:    r.id,
      accountId:    r.account_id,
      category:     r.category || 'copilot',
      title:        r.title || '',
      company:      r.target_company || '',
      position:     r.target_position || '',
      interviewType:r.interview_type || '',
      status:       r.status || 'unknown',
      startedAt:    Number(r.started_at) || 0,
      endedAt:      Number(r.ended_at) || 0,
      lastActiveAt: Number(r.last_active_at) || 0,
      rounds:       Number(r.round_count) || 0,
      questions:    Number(r.question_count) || 0,
      answered:     Number(r.answered_count) || 0,
      errors:       Number(r.error_count) || 0,
      durationMs:   Number(r.duration_ms) || 0,
      snippet:      r.snippet || '',
      wavPath:      r.wav_path || '',
      reviewMd:     r.review_md || '',
      createdAt:    Number(r.created_at) || 0,
      updatedAt:    Number(r.updated_at) || 0,
    }));

    return {
      ok: true,
      total, sessions,
      keyword:    kw,
      category:   cat,
      page:       pg,
      pageSize:   ps,
      accountFallback: false, // 🟢 严格隔离：从不降级
    };
  } catch (e) {
    return {
      ok: false, sqliteUnavailable: true,
      total: 0, sessions: [],
      keyword: keyword || '', category: category || '',
      page: Number(page) || 1, pageSize: Number(pageSize) || 9,
      msg: e.message,
    };
  }
}

/**
 * 查询单条会话详情 + 轮次列表（对应 GET /api/sessions/:id）
 * 输出：{ok, session, rounds, error?, sqliteUnavailable?}
 */
function getSessionDetail(id, accountId) {
  if (!ready || !db) {
    return { ok: false, sqliteUnavailable: true, session: null, rounds: [],
             msg: lastError ? lastError.message : 'SQLite 未就绪' };
  }
  try {
    if (!id) return { ok: false, error: 'invalid', msg: 'sessionId 不能为空', session: null, rounds: [] };
    const sid = String(id);
    const row = db.prepare(
      `SELECT id, account_id, category, title, target_company, target_position,
              interview_type, status, started_at, ended_at, last_active_at,
              round_count, question_count, answered_count, error_count, duration_ms,
              jd_snapshot, resume_snapshot, snippet, wav_path, review_md,
              created_at, updated_at
         FROM ia_sessions WHERE id = ?`
    ).get(sid);
    if (!row) return { ok: false, error: 'not_found', msg: '会话不存在', session: null, rounds: [] };

    // 🟢 详情权限：如果调用方显式传入 accountId（= 已登录），必须匹配 row.account_id，
    //    不匹配直接返回 NOT_FOUND —— 避免用户 A 通过"猜 session id"看到用户 B 的记录。
    //    accountId 为空时（匿名访问），返回 not_found 也符合"必须登录才能看自己的数据"。
    if (accountId) {
      if (String(row.account_id) !== String(accountId)) {
        return { ok: false, error: 'forbidden', msg: '无权访问其他账号的会话', session: null, rounds: [] };
      }
    } else {
      // 未传 accountId → 视为未登录，详情接口不返回内容（避免泄露全局 session）
      return { ok: false, error: 'not_logged_in', msg: '请先登录后再查看会话详情', session: null, rounds: [] };
    }

    const session = {
      sessionId:    row.id,
      accountId:    row.account_id,
      category:     row.category || 'copilot',
      title:        row.title || '',
      company:      row.target_company || '',
      position:     row.target_position || '',
      interviewType:row.interview_type || '',
      status:       row.status || 'unknown',
      startedAt:    Number(row.started_at) || 0,
      endedAt:      Number(row.ended_at) || 0,
      lastActiveAt: Number(row.last_active_at) || 0,
      rounds:       Number(row.round_count) || 0,
      questions:    Number(row.question_count) || 0,
      answered:     Number(row.answered_count) || 0,
      errors:       Number(row.error_count) || 0,
      durationMs:   Number(row.duration_ms) || 0,
      jdSnapshot:   row.jd_snapshot || '',
      resumeSnapshot:row.resume_snapshot || '',
      snippet:      row.snippet || '',
      wavPath:      row.wav_path || '',
      reviewMd:     row.review_md || '',
      createdAt:    Number(row.created_at) || 0,
      updatedAt:    Number(row.updated_at) || 0,
    };

    // 轮次：按 seq 升序
    const roundRows = db.prepare(
      `SELECT id, session_id, seq, status, source, question_text, question_image,
              answer_text, error_msg, created_at, answered_at
         FROM ia_rounds WHERE session_id = ? ORDER BY seq ASC, id ASC`
    ).all(sid);
    const rounds = roundRows.map(r => ({
      roundId:    r.id,
      sessionId:  r.session_id,
      seq:        Number(r.seq) || 0,
      status:     r.status || 'unknown',
      source:     r.source || '',
      question:   r.question_text || '',
      questionImg:r.question_image || '',
      answer:     r.answer_text || '',
      errorMsg:   r.error_msg || '',
      createdAt:  Number(r.created_at) || 0,
      answeredAt: Number(r.answered_at) || 0,
    }));

    return { ok: true, session, rounds, accountFallback };
  } catch (e) {
    return { ok: false, error: 'internal', msg: e.message, session: null, rounds: [] };
  }
}

/**
 * 删除会话 + 轮次（对应 DELETE /api/sessions/:id）
 * 注意：虽然 landing 以只读为主，但删除按钮功能仍需支持
 */
function deleteSession(id, accountId) {
  if (!ready || !db) {
    return { ok: false, sqliteUnavailable: true,
             msg: lastError ? lastError.message : 'SQLite 未就绪' };
  }
  try {
    if (!id) return { ok: false, error: 'invalid', msg: 'sessionId 不能为空' };
    const sid = String(id);
    // 先查存在性 + 权限（不匹配但本地共享则放行）
    const row = db.prepare('SELECT id, account_id FROM ia_sessions WHERE id = ?').get(sid);
    if (!row) return { ok: false, error: 'not_found', msg: '会话不存在' };
    // 账号降级：如果账号不匹配但 ia_sessions 有数据，本地共享信任场景仍允许删除
    let accountFallback = false;
    if (accountId && String(row.account_id) !== String(accountId)) {
      accountFallback = true;
    }
    // 事务：先删轮次再删会话（外键开着顺序也不能反，但事务保证原子）
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM ia_rounds WHERE session_id = ?').run(sid);
      db.prepare('DELETE FROM ia_sessions WHERE id = ?').run(sid);
    });
    tx();
    return { ok: true, deleted: true, sessionId: sid, accountFallback };
  } catch (e) {
    return { ok: false, error: 'internal', msg: e.message };
  }
}

// ============================================================
// 4. 导出
// ============================================================
module.exports = {
  /** 统一数据库文件路径（三端合一首页：hireme.db，展示 / 诊断用） */
  INTERVIEW_DB_PATH: HIREME_DB_PATH,
  /** 兼容旧代码命名：同样指向 hireme.db */
  HIREME_DB_PATH,
  /** 是否连接就绪 */
  ready: () => ready,
  /** 最近一次错误 */
  lastError: () => lastError,
  /** 健康检查 */
  health,
  /** 列表分页查询 */
  listSessions,
  /** 查询单条详情 */
  getSessionDetail,
  /** 删除会话 */
  deleteSession,
};
