/**
 * migrate-sessions-to-sqlite.js
 * ---------------------------------------------------------------
 * 一次性迁移脚本：把 logs/sessions/{accountId} 目录下的
 *   现有 *.json 会话详情 + _index.jsonl 摘要
 * 导入到 SQLite（data/interview.db 的 ia_sessions / ia_rounds 表）。
 *
 * 【幂等】：通过 repo.exists(sessionId) 先查是否已存在，
 *          已存在 → skip（避免重复导入）。所以本脚本可反复执行。
 *
 * 【用法】（在项目根目录）：
 *   node scripts/migrate-sessions-to-sqlite.js
 *   # 或带 --dry-run 只预览不写入：
 *   node scripts/migrate-sessions-to-sqlite.js --dry-run
 *
 * 【迁移策略】（与 localHttpServer 账号隔离逻辑对齐）：
 *   - 顶层 sessions 目录下每个子文件夹 = 一个 accountId
 *   - 特殊目录名 "__guest__" = 游客账号（与 _migrateTopLevelSessionsToGuest 语义一致）
 *   - 顶层直接散放的 *.json（老版本遗留）：如果存在，默认挂到 __guest__
 *
 * 【错误处理】：单个 session 解析失败 → 记到 fails[]，继续迁下一个，不中断整体。
 * ---------------------------------------------------------------
 */

'use strict';

// ===== 内部依赖 =====
const fs = require('fs');
const path = require('path');
const SessionRepository = require('../services/session-repo.js');

// ===== 路径常量（与 localHttpServer 的 SESSION_DIR_NAME 一致）=====
const PROJECT_ROOT = path.join(__dirname, '..');
const SESSION_ROOT_DIR = path.join(PROJECT_ROOT, 'logs', 'sessions');
const DB_PATH = path.join(PROJECT_ROOT, 'data', 'interview.db');

// ===== 命令行参数：--dry-run 表示只预览，不写入 DB =====
const ARGS = process.argv.slice(2);
const DRY_RUN = ARGS.includes('--dry-run');

/**
 * 推断 session 面试类型（与 localHttpServer._inferSessionCategory 完全对齐）。
 * @param {Object} s 从 JSON 读出的原始 session 对象
 * @returns {'copilot'|'mock'}
 */
function inferCategory(s) {
  if (!s || typeof s !== 'object') return 'copilot';
  if (s.category === 'copilot' || s.category === 'mock') return s.category;
  if (s.meta && s.meta.mockInterview) return 'mock';
  if (s.config && s.config._mockInterview) return 'mock';
  if (s._cfg && s._cfg._mockInterview) return 'mock';
  return 'copilot';
}

/**
 * 从一个 session JSON 计算 snippet（摘要前 80 字）。
 * 与 _normalizeSessionSummaryForUI 语义一致：优先拿最后一轮的问题或答案。
 */
function buildSnippet(s) {
  if (s.snippet && typeof s.snippet === 'string' && s.snippet.trim()) return s.snippet.slice(0, 500);
  const lastRounds = Array.isArray(s.lastRounds) && s.lastRounds.length ? s.lastRounds : null;
  if (lastRounds) {
    const lr = lastRounds[lastRounds.length - 1] || {};
    const txt = String(lr.questionText || lr.answerText || '').trim();
    if (txt) return txt.slice(0, 500);
  }
  const rounds = Array.isArray(s.rounds) && s.rounds.length ? s.rounds : null;
  if (rounds) {
    const lr = rounds[rounds.length - 1] || {};
    const txt = String(lr.questionText || lr.answerText || '').trim();
    if (txt) return txt.slice(0, 500);
  }
  return '';
}

/**
 * 迁移单个账号目录下的所有 session json 文件。
 * @param {SessionRepository} repo 仓储实例（dry-run 模式下传 null，仅统计）
 * @param {string} accountDir 账号目录
 * @param {string} accountId  账号 ID（__guest__ 或数字 ID）
 * @returns {{ok:number, skipped:number, failed:number, fails:Array<{file:string,msg:string}>}}
 */
function migrateAccountDir(repo, accountDir, accountId) {
  const result = { ok: 0, skipped: 0, failed: 0, fails: [] };
  if (!fs.existsSync(accountDir)) return result;

  let entries;
  try { entries = fs.readdirSync(accountDir); } catch (e) { return result; }

  // 顶层直接散放：session 详情 = xxx.json；索引文件 _index.jsonl（跳过）
  const sessionFiles = entries.filter((f) => f.endsWith('.json') && !f.startsWith('_index'));

  for (const filename of sessionFiles) {
    const filePath = path.join(accountDir, filename);
    let raw;
    try {
      const buf = fs.readFileSync(filePath, 'utf-8');
      raw = JSON.parse(buf);
    } catch (e) {
      result.failed++;
      result.fails.push({ file: filePath, msg: 'JSON 解析失败: ' + (e && e.message) });
      continue;
    }
    if (!raw || !raw.id) {
      result.failed++;
      result.fails.push({ file: filePath, msg: '缺少 id 字段' });
      continue;
    }

    // 幂等：已存在就跳过
    if (!DRY_RUN && repo && repo.exists(raw.id)) {
      result.skipped++;
      continue;
    }

    // ---- 组装 summary 行（upsertSession）----
    const rounds = Array.isArray(raw.rounds) ? raw.rounds : [];
    const stats = (raw.stats && typeof raw.stats === 'object') ? raw.stats : {};
    let answeredCount = 0, errorCount = 0;
    for (const r of rounds) {
      if (r && r.status === 'answered') answeredCount++;
      else if (r && r.status === 'error') errorCount++;
    }
    const startedAt = Number(raw.startedAt) || Number(raw.started_at) || Date.now();
    const endedAt   = Number(raw.endedAt)   || Number(raw.ended_at)   || 0;
    const lastActiveAt = Number(raw.lastActiveAt) || endedAt || startedAt;
    const status    = (raw.status === 'ended' || endedAt > 0) ? 'ended' : 'active';
    const category  = inferCategory(raw);
    const durationMs = Number(stats.totalDurationMs || raw.durationMs)
                    || Math.max(0, endedAt - startedAt);
    const rCount = rounds.length || Number(stats.roundCount || raw.roundCount || 0);

    const sessionRow = {
      id: String(raw.id),
      accountId: String(accountId),
      category,
      title: String(raw.title || '').slice(0, 200) || buildDefaultTitle(raw, startedAt),
      targetCompany:  String(raw.targetCompany  || raw.target_company  || '').slice(0, 200),
      targetPosition: String(raw.targetPosition || raw.target_position || '').slice(0, 200),
      interviewType:  String(raw.interviewType  || raw.interview_type  || '').slice(0, 100),
      status,
      startedAt, endedAt, lastActiveAt,
      roundCount:    rCount,
      questionCount: Number(raw.questionCount || rounds.length),
      answeredCount: Number.isFinite(raw.answeredCount) ? raw.answeredCount
                    : (Number.isFinite(stats.answeredCount) ? stats.answeredCount : answeredCount),
      errorCount:    Number.isFinite(raw.errorCount) ? raw.errorCount
                    : (Number.isFinite(stats.errorCount) ? stats.errorCount : errorCount),
      durationMs,
      jdSnapshot:     String(raw.jdSnapshot     || raw.jd_snapshot     || '').slice(0, 20000),
      resumeSnapshot: String(raw.resumeSnapshot || raw.resume_snapshot || (raw.config && (raw.config.resumeContent || raw.config.resumeText)) || '').slice(0, 40000),
      snippet: buildSnippet(raw),
    };

    if (DRY_RUN) {
      // dry-run 不写 DB，只累加统计
      result.ok++;
      continue;
    }

    try {
      // 1) 写 session 主表
      const ok1 = repo.upsertSession(sessionRow);
      // 2) 写所有 rounds
      const ok2 = rounds.length === 0 ? true : repo.upsertRoundsForSession(String(raw.id), rounds);
      // 3) 状态：ended 的 session 再补一次 endedAt 兜底（防止 JSON 里缺 endedAt 但 status=ended）
      if (status === 'ended') repo.endSession(String(raw.id), endedAt || lastActiveAt);

      if (ok1 && ok2 !== false) result.ok++;
      else {
        result.failed++;
        result.fails.push({ file: filePath, msg: 'upsert 返回 false（DB 写失败）' });
      }
    } catch (e) {
      result.failed++;
      result.fails.push({ file: filePath, msg: '写入异常: ' + (e && e.message) });
    }
  }
  return result;
}

/** 兜底：title 为空时按公司+职位+时间拼一个（与 _buildSessionTitle 结果类似） */
function buildDefaultTitle(raw, startedAt) {
  const co = String(raw.targetCompany || raw.target_company || '').trim();
  const po = String(raw.targetPosition || raw.target_position || '').trim();
  const stamp = new Date(startedAt);
  const hh = String(stamp.getHours()).padStart(2, '0');
  const mm = String(stamp.getMinutes()).padStart(2, '0');
  const parts = [co, po].filter(Boolean);
  return (parts.length ? parts.join(' · ') : '未命名面试') + ` · ${hh}:${mm}`;
}

// ================================================================
// 主流程
// ================================================================
(function main() {
  console.log('==============================================================');
  console.log(`面试记录迁移：JSON → SQLite`);
  console.log(`  Session 目录 : ${SESSION_ROOT_DIR}`);
  console.log(`  SQLite 路径 : ${DB_PATH}`);
  console.log(`  模式        : ${DRY_RUN ? '⚠️ DRY-RUN（只预览，不写入）' : '✅ 正式写入'}`);
  console.log('==============================================================');

  if (!fs.existsSync(SESSION_ROOT_DIR)) {
    console.log('ℹ️ logs/sessions 目录不存在，没有可迁移的数据。直接退出。');
    return;
  }

  // 1) 打开 / 创建 SQLite
  let repo = null;
  if (!DRY_RUN) {
    repo = new SessionRepository(DB_PATH);
    if (!repo.ready) {
      console.error('❌ SQLite 仓库初始化失败：', repo && repo.lastError && repo.lastError.message);
      process.exitCode = 1;
      return;
    }
    const h = repo.health();
    console.log(`ℹ️ 迁移前 DB 健康：sessions=${h.sessionCount}, rounds=${h.roundCount}`);
  }

  // 2) 先迁顶层直接散放 → __guest__（老版本遗留，兼容 _migrateTopLevelSessionsToGuest 的语义）
  //    与 _getSessionDir 逻辑一致：顶层除子目录外，只有 *.json 文件时才是遗留
  let grandTotal = { ok: 0, skipped: 0, failed: 0, fails: [] };
  const topEntries = fs.readdirSync(SESSION_ROOT_DIR, { withFileTypes: true });
  const topLevelJsons = topEntries
    .filter((e) => e.isFile() && e.name.endsWith('.json') && !e.name.startsWith('_index'))
    .map((e) => e.name);
  if (topLevelJsons.length > 0) {
    console.log(`\n🔀 发现顶层遗留 session JSON ${topLevelJsons.length} 个 → 迁入 account=__guest__`);
    // 顶层的 accountDir 就等于 SESSION_ROOT_DIR 本身
    const r = migrateAccountDir(repo, SESSION_ROOT_DIR, '__guest__');
    console.log(`   结果：新迁 ${r.ok}，跳过 ${r.skipped}，失败 ${r.failed}`);
    grandTotal.ok += r.ok; grandTotal.skipped += r.skipped;
    grandTotal.failed += r.failed; grandTotal.fails.push(...r.fails);
  }

  // 3) 迁每个账号子目录
  const accountDirs = topEntries.filter((e) => e.isDirectory()).map((e) => e.name);
  if (accountDirs.length === 0) {
    console.log('\nℹ️ 未发现账号子目录。');
  } else {
    console.log(`\n📂 发现 ${accountDirs.length} 个账号子目录：${accountDirs.join(', ')}`);
    for (const dirName of accountDirs) {
      const accountDir = path.join(SESSION_ROOT_DIR, dirName);
      const r = migrateAccountDir(repo, accountDir, dirName);
      console.log(`   - ${dirName}：新迁 ${r.ok}，跳过 ${r.skipped}，失败 ${r.failed}`);
      grandTotal.ok += r.ok; grandTotal.skipped += r.skipped;
      grandTotal.failed += r.failed; grandTotal.fails.push(...r.fails);
    }
  }

  // 4) 汇总
  console.log('\n==============================================================');
  console.log(DRY_RUN ? '📋 DRY-RUN 结果（模拟迁移）：' : '✅ 迁移完成汇总：');
  console.log(`  新迁记录数 : ${grandTotal.ok}`);
  console.log(`  跳过(已存在): ${grandTotal.skipped}`);
  console.log(`  失败数    : ${grandTotal.failed}`);
  if (grandTotal.fails.length > 0) {
    console.log('  失败明细：');
    for (const f of grandTotal.fails.slice(0, 20)) {
      console.log(`    · ${path.relative(PROJECT_ROOT, f.file)} → ${f.msg}`);
    }
    if (grandTotal.fails.length > 20) {
      console.log(`    ... 另外还有 ${grandTotal.fails.length - 20} 条，完整明细见日志。`);
    }
  }
  if (!DRY_RUN && repo) {
    const h = repo.health();
    console.log(`ℹ️ 迁移后 DB 健康：sessions=${h.sessionCount}, rounds=${h.roundCount}`);
  }
  console.log('==============================================================');
})();
