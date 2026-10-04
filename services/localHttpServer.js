/**
 * localHttpServer.js — 小程序联动本地 HTTP + WebSocket 服务
 *
 * 功能总览：
 *   1. 绑定 0.0.0.0，端口范围 28765–28774 自动探测
 *   2. Token 鉴权（WS query + HTTP Authorization: Bearer 双通道）
 *   3. 单连接模式：新小程序连接会踢掉旧连接（close 4000 replaced）
 *   4. 心跳检测：60s 未收到 ping 主动 close(4408)
 *   5. 5s 轮询 IP 变化：换 WiFi 时触发 network-changed 事件（主进程会让 overlay 重绘二维码）
 *   6. WebSocket 协议：
 *        ping               → pong（心跳）
 *        screenshot:req     → screenshot:res（电脑截屏，JPEG/PNG + base64 + 指定 maxSize 压缩）
 *        overlay:write-answer → overlay:write-answer-ack（小程序 AI 答案回写电脑答题面板）
 *        overlay:pull      → overlay:pull-ack（兜底轮询：拉取当前最新 ASR/答案/状态快照）
 *   7. HTTP 接口：
 *        GET  /health                   免鉴权，服务存活探针
 *        GET  /api/connect              鉴权后下发 AI/OCR/面试配置
 *        GET  /api/overlay/status       鉴权后拉取当前 ASR/答案/录制态快照（兜底轮询）
 *        GET  /api/screenshot           鉴权后触发截图（与 WS screenshot:req 共用 _doCapture）
 *        POST /api/answer/write         鉴权后回写答案到 overlay（与 WS overlay:write-answer 同效果）
 *        POST /api/disconnect           鉴权后主动断开当前 WS 连接
 *   8. app.bus 订阅 → WS 推送（asr:interim 200ms 节流，其他立即）：
 *        asr:interim / asr:final / answer:start / answer:generated / status:change
 *   9. 内部状态 state = { asrText, answerText, isRecording, lastAnswerAt } 持续维护
 *
 * 所有对外异常均有友好错误码 + 中文可读 msg；内部 try/catch 独立包裹，单点失败不崩溃整个服务。
 */

'use strict';

// ===== Node 原生模块 =====
const http = require('http');
const os = require('os');
const crypto = require('crypto');
const url = require('url');
const path = require('path');         // H5 静态文件路径拼接（原生标准库，无新依赖）
const fs = require('fs');             // H5 静态 HTML 文件读取（原生标准库，无新依赖）

// ===== 【双写模式 Phase 1】面试记录统一 SQLite 仓储 =====
//   - 写入：现有 JSON/JSONL 流程不变的同时，再写一份到 data/interview.db
//   - 失败：所有 try/catch 兜底，SQLite 侧异常只告警，绝不影响 JSON 主流程
//   - repo 实例由外部 setSessionRepository() 注入（main.js 启动后注入，单例共享）
let SessionRepoCtor = null;
try { SessionRepoCtor = require('./session-repo.js'); }
catch (e) {
  console.warn('[localHttpServer][sqlite-sync] ⚠️ 加载 session-repo.js 失败，SQLite 双写侧将被跳过：', e.message);
}
let _sessionRepo = null;   // null 表示尚未注入或注入失败

/**
 * 外部注入 SessionRepository 实例（main.js 中创建好后调这里注入）。
 * 传入 null / 未 ready 的实例也允许（此时所有双写动作直接变成 no-op）。
 * @param {SessionRepository|null} repo
 */
function setSessionRepository(repo) {
  _sessionRepo = (repo && typeof repo.upsertSession === 'function') ? repo : null;
  if (_sessionRepo) {
    const h = (typeof _sessionRepo.health === 'function') ? _sessionRepo.health() : null;
    console.log(`[localHttpServer][sqlite-sync] ✅ SessionRepo 已注入：ready=${!!_sessionRepo.ready} | health=${h ? JSON.stringify(h) : 'N/A'}`);
  } else {
    console.log('[localHttpServer][sqlite-sync] ℹ️ 注入的 SessionRepo 不可用（或为空），SQLite 双写侧被安全跳过。');
  }
}

/**
 * 当前登录账号 ID（供 SQLite 写 account_id 用）。
 * 读取：this._auth.currentAccountId，取不到返回 '__guest__'。
 */
function _currentAccountIdForRepo(self) {
  try {
    if (self && self._auth && typeof self._auth.currentAccountId === 'string' && self._auth.currentAccountId) {
      return self._auth.currentAccountId;
    }
  } catch (_) { /* ignore */ }
  return '__guest__';
}

// ===== 项目已有服务：AI 答题/视觉模型（阶梯 2 复用，不新写推理逻辑）=====
let aiService = null;
try { aiService = require('./aiService'); } catch (e) {
  console.error('[localHttpServer] require(./aiService) 失败，H5 提问功能不可用:', e.message);
}

// ===== 多 Agent：模拟面试（出题/追问/点评/复盘）=====
let mockInterviewAgents = null;
try {
  const M = require('./mockInterviewAgents');
  // 仅当 aiService 可用时才实例化编排器，否则给 mockInterviewAgents=null，对应 HTTP 路由会返回 500 + 清晰 msg
  mockInterviewAgents = aiService ? new M.MockInterviewOrchestrator(aiService) : null;
} catch (e) {
  console.error('[localHttpServer] require(./mockInterviewAgents) 失败，模拟面试多 Agent 不可用:', e.message);
  mockInterviewAgents = null;
}

// ===== 多 Agent：简历优化（ATS 评分 / 关键词匹配 / 内容优化）=====
let resumeOptAgents = null;
try {
  const R = require('./resumeOptAgents');
  resumeOptAgents = aiService ? new R.ResumeOptPipeline(aiService) : null;
} catch (e) {
  console.error('[localHttpServer] require(./resumeOptAgents) 失败，简历优化多 Agent 不可用:', e.message);
  resumeOptAgents = null;
}

// ===== 简历解析：DOCX/PDF/TXT（优先尝试项目已有库，缺失则回退纯文本，不 crash）=====
// 注意（2026-08-19 实测 Win10 + Electron + pdfjs-dist 5.x 场景）：
//   - mammoth: 1.x 是纯 CJS，require('mammoth') 即可拿到带 extractRawText 的对象
//   - pdfjs-dist 5.x: main 指向 build/pdf.mjs（纯 ESM）；Electron 主进程里 require(pdf.mjs) 会抛 ERR_REQUIRE_ESM：
//     "require() of ES Module xxx/pdf.mjs not supported. Instead change the require of xxx/pdf.mjs to a dynamic import()"
//     所以在 Electron 下必须**避免**先试 pdfjs-dist 的 require；改为先走纯 CJS 的 pdf-parse（项目已安装 v2.x），再尝试
//     pdfjs-dist 的动态 import()（因为 CJS 里能 await import() ESM），最后才是同步 require 兜底
//   - pdf-parse: 项目已安装 2.x，导出结构是对象（含具名 PDFParse 类），使用方式为：
//       const parser = new PDFParse(Uint8Array, {max:0});
//       const info = await parser.getInfo();      // -> {total,info,...}
//       const result = await parser.getText();   // -> {pages:[{text,num}], text:'全文', total}
//       await parser.destroy();
//     它是 CommonJS，Electron/Node 都能 100% 稳定加载，所以作为默认首选
//   - 失败原因记录到 resumeParserReasons，后续 _parseResumeFromBuffer 会把详细原因拼给用户，不再笼统报"解析库未安装"
let mammoth = null;
let mammothReason = '';
try {
  mammoth = require('mammoth');
  if (!mammoth || typeof mammoth.extractRawText !== 'function') {
    mammothReason = `mammoth 已安装但 extractRawText 不可用（typeof=${typeof (mammoth && mammoth.extractRawText)}）`;
    mammoth = null;
  }
} catch (e) { mammoth = null; mammothReason = e.message || 'require(mammoth) 抛出未知异常'; }

// 统一的 PDF 解析句柄（内部字段：
//   kind: 'pdf-parse' | 'pdfjs'
//   source: 'pdf-parse' | 'pdfjs-dist/legacy' | 'pdfjs-dist'
//   ready: Promise<void>  用于延迟初始化（如动态 import 走异步加载）时外部 await 等它就绪；同步加载则为 resolved
//   parseFn: async (buffer) => {text, pages?, total?}   统一输出结构，调用方不再关心库差异
//   legacyGetDocument: function?  若走 pdfjs，则保留 getDocument 给未来扩展（渲染等）
const resumeParserReasons = [];

/**
 * 首选加载：pdf-parse（纯 CommonJS，Electron/Node 均稳定）。
 * 返回 {handles, reason, source}；handles 为 null 表示加载失败。
 */
function _tryLoadPdfParse() {
  let handles = null; let reason = '';
  try {
    const mod = require('pdf-parse');
    // 2.x 版本：具名导出 PDFParse；同时兼容 1.x（函数导出）与 CJS 包装的 .default
    const PDFParse = (mod && typeof mod.PDFParse === 'function') ? mod.PDFParse
      : (mod && typeof mod.default === 'function') ? mod.default
      : (typeof mod === 'function') ? mod
      : null;
    if (!PDFParse) {
      const t = typeof mod;
      const keyc = (mod && typeof mod === 'object') ? Object.keys(mod).length : 0;
      reason = `pdf-parse 已加载但导出结构不符合预期（typeof=${t}, keys=${keyc}，未找到 PDFParse/default 函数）`;
    } else {
      // 包装成统一 parseFn：输入 Node Buffer（我们内部都用 Buffer），内部转 Uint8Array（pdf-parse 2.x 严格要求）
      const parseFn = async (buf) => {
        const parser = new PDFParse(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), { max: 0 });
        try {
          // info / getText 都单独 await 一下保证异常时能释放 destroy
          const info = await parser.getInfo();
          const out = await parser.getText();
          const pages = Array.isArray(out && out.pages) ? out.pages : [];
          const total = (info && typeof info.total === 'number') ? info.total
            : (Array.isArray(out && out.pages) ? out.pages.length : (out && typeof out.total === 'number' ? out.total : 0));
          // 优先用 out.text（已经是拼接好的全文，每页之间自带分隔），否则逐页 text 拼接
          const text = typeof (out && out.text) === 'string' ? out.text
            : pages.map((p) => (p && typeof p.text === 'string') ? p.text : '').join('\n\n');
          return { text, total, pages };
        } finally {
          try { await parser.destroy(); } catch (_) { /* ignore destroy errors */ }
        }
      };
      handles = { kind: 'pdf-parse', source: 'pdf-parse', ready: Promise.resolve(), parseFn };
    }
  } catch (e) {
    if (e && (e.code === 'MODULE_NOT_FOUND' || /cannot find module/i.test(e.message || ''))) {
      reason = 'pdf-parse 未安装（已加入 package.json，请确认 npm install 成功）';
    } else {
      reason = e.message || 'require(pdf-parse) 抛出未知异常';
    }
  }
  return { handles, source: (handles ? 'pdf-parse' : ''), reason };
}

/**
 * 异步加载：pdfjs-dist/legacy/build/pdf.mjs（用动态 import，兼容 Electron/Electron 打包后 ESM 模块）。
 * 返回结构同 _tryLoadPdfParse（handles.ready 为真正的异步 Promise，调用方在 parsePDF 入口要 await）。
 */
function _tryLoadPdfjsLegacyAsync() {
  let handles = null; let reason = '';
  // 用 Promise 包一层"延迟到真正使用时再 import"的 ready；catch 到 reason 里
  const ready = (async () => {
    try {
      // 解析阶段无法 require .mjs（Electron 抛 ERR_REQUIRE_ESM），CJS 中用 await import() 则完全支持
      const mod = await import('pdfjs-dist/legacy/build/pdf.mjs');
      let lib = mod;
      if (lib && typeof lib.getDocument !== 'function' && lib.default) lib = lib.default;
      if (!lib || typeof lib.getDocument !== 'function') {
        const t = typeof lib;
        const keyc = lib ? Object.keys(lib).length : 0;
        reason = `pdfjs-dist/legacy 动态 import 成功但 getDocument 不可用（typeof=${t}, keys=${keyc}）`;
        handles = null;
        return;
      }
      const parseFn = async (buf) => {
        const task = lib.getDocument({ data: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), disableFontFace: true, useSystemFonts: true });
        const doc = await task.promise;
        const total = doc.numPages || 0;
        const pages = [];
        for (let i = 1; i <= total; i++) {
          const page = await doc.getPage(i);
          const content = await page.getTextContent();
          const lines = (content && Array.isArray(content.items))
            ? content.items.map((it) => (it && typeof it.str === 'string') ? it.str : '').join(' ')
            : '';
          pages.push({ num: i, text: lines });
        }
        const text = pages.map((p) => p.text).join('\n\n');
        return { text, total, pages };
      };
      handles = { kind: 'pdfjs', source: 'pdfjs-dist/legacy', ready: Promise.resolve(), parseFn, legacyGetDocument: lib.getDocument };
    } catch (e) {
      // 动态 import 失败（路径不存在/模块损坏等）：记入 reason，handles 保持 null
      reason = e.message || 'import(pdfjs-dist/legacy/build/pdf.mjs) 抛出未知异常';
      handles = null;
    }
  })();
  // 因为上面的 IIFE 会 mutate handles/reason（同一轮事件循环里 await import 会让出线程），这里要把
  // 结果指针包进 ready 成功后的对象里，让调用方 await ready 后拿真正的 {kind,source,parseFn,...}
  const awaitable = {
    ready: ready.then(() => handles),
    source: 'pdfjs-dist/legacy',
    reason: () => reason, // 失败后读取最新 reason
  };
  // 特殊标记：_awaitable = true，加载调度段会 await awaitable.ready 再决定是否 accept
  return { _awaitable: true, awaitable, source: 'pdfjs-dist/legacy' };
}

/**
 * 最后兜底：同步 require('pdfjs-dist')（仅对旧版本 2.x/3.x 有效；若抛错就记入 reasons）。
 */
function _tryLoadPdfjsMainSync() {
  let handles = null; let reason = '';
  try {
    let lib = require('pdfjs-dist');
    if (lib && typeof lib.getDocument !== 'function' && lib.default) lib = lib.default;
    if (!lib || typeof lib.getDocument !== 'function') {
      const t = typeof lib;
      const keyc = lib ? Object.keys(lib).length : 0;
      reason = `pdfjs-dist 主入口同步 require 成功但 getDocument 不可用（typeof=${t}, keys=${keyc}）`;
    } else {
      const parseFn = async (buf) => {
        const task = lib.getDocument({ data: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), disableFontFace: true, useSystemFonts: true });
        const doc = await task.promise;
        const total = doc.numPages || 0;
        const parts = [];
        for (let i = 1; i <= total; i++) {
          const page = await doc.getPage(i);
          const c = await page.getTextContent();
          const lines = (c && Array.isArray(c.items)) ? c.items.map((it) => it.str || '').join(' ') : '';
          parts.push(lines);
        }
        return { text: parts.join('\n\n'), total, pages: parts.map((text, i) => ({ num: i + 1, text })) };
      };
      handles = { kind: 'pdfjs', source: 'pdfjs-dist', ready: Promise.resolve(), parseFn, legacyGetDocument: lib.getDocument };
    }
  } catch (e) {
    reason = e.message || 'require(pdfjs-dist) 抛出未知异常';
  }
  return { handles, source: (handles ? 'pdfjs-dist' : ''), reason };
}

// 全局 PDF 解析句柄（由 _loadPdfParsers 填入）
let pdfParserHandle = null; // 结构同上面的 handles
(async function _loadPdfParsers() {
  // A. 首选：pdf-parse（同步加载，Electron 100% 稳定，用户现在已在 package.json 安装了 v2.4.5）
  const pparse = _tryLoadPdfParse();
  if (pparse.handles) { pdfParserHandle = pparse.handles; return; }
  resumeParserReasons.push(`[pdf-parse] ${pparse.reason}`);

  // B. 次选：pdfjs-dist/legacy（动态 import ESM，异步，解决 Electron 中 ERR_REQUIRE_ESM 问题）
  const legacy = _tryLoadPdfjsLegacyAsync();
  if (legacy._awaitable) {
    const h = await legacy.awaitable.ready;
    if (h) { pdfParserHandle = h; return; }
    resumeParserReasons.push(`[pdfjs-dist/legacy] ${legacy.awaitable.reason()}`);
  }

  // C. 最后兜底：pdfjs-dist 主入口同步 require（2.x/3.x 老版本或某些 CJS 打包版才会走到）
  const main = _tryLoadPdfjsMainSync();
  if (main.handles) { pdfParserHandle = main.handles; return; }
  resumeParserReasons.push(`[pdfjs-dist] ${main.reason}`);
})();

// 启动日志自检：打印 mammoth / PDF 解析库当前状态
// 注意 pdfParserHandle 可能是异步加载的，所以用 Promise.resolve().then 等一次微任务，再打印
(function _reportParserStatus() {
  const show = () => {
    const parts = [];
    parts.push(`mammoth: ${mammoth ? 'OK(extractRawText)' : 'FAIL - ' + (mammothReason || 'unknown')}`);
    if (pdfParserHandle) {
      parts.push(`pdf: OK(${pdfParserHandle.source}, kind=${pdfParserHandle.kind})`);
    } else {
      // pdfParserHandle 仍为 null：说明 A/B/C 三条都挂了，拼完整原因
      parts.push(`pdf: FAIL - ${resumeParserReasons.join('；')}`);
    }
    console.log('[localHttpServer] 简历解析库自检：' + parts.join('；'));
  };
  // 给异步的 legacy import 一次机会；即使 A 段同步命中，这里也只是多一个 then，开销可忽略
  Promise.resolve().then(show).catch(() => show());
})();

// DOCX 生成：导出优化后的简历
let docxLib = null;
let fsLib = null;
let pathLib = null;
try { docxLib = require('docx'); } catch (_) { docxLib = null; }
try { fsLib = require('fs'); } catch (_) { fsLib = null; }
try { pathLib = require('path'); } catch (_) { pathLib = null; }
let WebSocketServerCtor = null;
try {
  // Electron 主进程 / 普通 Node 统一：优先使用项目已安装的 ws 包
  WebSocketServerCtor = require('ws').WebSocketServer || require('ws').Server;
} catch (e) {
  console.error('[localHttpServer] require(ws) 失败:', e.message);
}

// ===== 常量配置 =====
const PORT_START = 28765;                  // 起始端口（10 个备选：28765-28774）
const PORT_END = 28774;
const BIND_ADDR = '0.0.0.0';               // 允许局域网访问
const AUTH_TIMEOUT_MS = 3000;              // WS 连接 3s 未认证 → 4401
const HEARTBEAT_INTERVAL_MS = 10 * 1000;   // 心跳检查间隔 10s
const HEARTBEAT_IDLE_MAX_MS = 60 * 1000;   // 60s 无 ping → 视为掉线（4408）
const IP_MONITOR_INTERVAL_MS = 5 * 1000;   // IP 变化监控 5s
const ASR_INTERIM_THROTTLE_MS = 200;       // ASR 临时文本 WS 推送节流 200ms
// ===== 对话历史常量 =====
const HISTORY_MAX_IN_MEM = 10;             // 内存保留最近 10 轮，超出最旧那条追加写入 JSONL 归档文件
const HISTORY_FILE_PREFIX = 'ia-history-'; // 归档文件名前缀：ia-history-YYYYMMDD.jsonl（按天分割）
const HISTORY_STATUS_ASKED = 'asked';      // 已提问、正在等 AI 答案
const HISTORY_STATUS_ANSWERED = 'answered';// AI 已返回答案
const HISTORY_STATUS_ERROR = 'error';      // AI 解题失败（answer 为空/抛异常）
const SCREENSHOT_TIMEOUT_MS = 15 * 1000;   // 截图超时 15s
const HTTP_BODY_LIMIT_BYTES = 1024 * 1024; // HTTP POST body 1MB
// ===== 面试 Session（每场面试一个文件）常量 =====
const SESSION_DIR_NAME = 'sessions';           // Session 文件存放子目录名：logs/sessions/
const SESSION_INDEX_NAME = '_index.jsonl';     // Session 索引（摘要）JSONL 文件名：列表页只扫它，秒开
const SESSION_LIST_MAX_IN_MEM = 50;            // 列表页内存缓存摘要的上限（最新 50 场，更多可翻文件）
const SESSION_STATUS_ACTIVE = 'active';        // 面试进行中
const SESSION_STATUS_ENDED = 'ended';          // 面试已结束（手动结束/切换新场/退出app）
const SESSION_MAX_MEM_ROUNDS = 200;            // 内存里 active session 保留多少轮 rounds（防无限膨胀；更多直接写盘）
// 切新场时，只有「两个都非空且确实不同」才自动切：避免用户删了公司填个空格产生碎片 session
function _sessionsSameTarget(a, b) {
  const ac = String((a && a.targetCompany) || '').trim();
  const ap = String((a && a.targetPosition) || '').trim();
  const bc = String((b && b.targetCompany) || '').trim();
  const bp = String((b && b.targetPosition) || '').trim();
  return (ac === bc) && (ap === bp);
}

// ============================================================
// IP 优先级算法（重要：数值越小越优先；排序时按升序，最前即首选 IP）
// - 第 1 权重：网卡名关键词（虚拟网卡一律惩罚+N，真实物理网卡奖励-1）
// - 第 2 权重：常见局域网 IP 段（192.168.1.x/0.x 等家用/办公常见段再-1，VMware 常用虚拟段 192.168.56/150.x 再+1）
// - 第 3 权重：私网段大类（192.168 > 10 > 172.16~31 > 169.254）
// ============================================================
function _ipPriorityClass(addr, ifaceName) {
  if (!addr) return 99;
  const name = String(ifaceName || '').toLowerCase();

  // ---------- 第 1 权重：网卡名惩罚/奖励 ----------
  // 明确的虚拟网卡关键词 → 惩罚 +4（优先级大幅降低，一定排到真实网卡后面）
  const VIRTUAL_KEYWORDS = [
    'vmnet', 'vmware', 'virtualbox', 'virtual',
    'vethernet', 'hyper-v', 'hyperv', 'wsl', 'default switch',
    'tap', 'tun', 'bridge', 'vpn', 'ppp', 'loopback', 'pseudo-interface',
  ];
  let prio = 0;
  if (VIRTUAL_KEYWORDS.some((kw) => name.indexOf(kw.toLowerCase()) >= 0)) {
    prio += 4;
  } else {
    // 真实物理网卡关键词 → 奖励 -1（优先级更前）
    const REAL_KEYWORDS = [
      'wlan', 'wi-fi', 'wifi', 'wireless',
      '以太网', 'ethernet', 'eth ', 'eth0', 'eth1', 'en0', 'en1',
      '本地连接', 'local area',
      'realtek', 'broadcom', 'intel', 'atheros', 'mediatek', 'killer',
    ];
    if (REAL_KEYWORDS.some((kw) => name.indexOf(kw.toLowerCase()) >= 0)) {
      prio -= 1;
    }
  }

  // ---------- 第 2 权重：常见/虚拟 IP 段细分 ----------
  // 最常见家用/办公局域网段：192.168.0.x / 1.x / 2.x / 3.x + 10.0.0.x / 10.0.1.x → 再 -1
  if (/^192\.168\.[0123]\./.test(addr) || /^10\.0\.[01]\./.test(addr)) {
    prio -= 1;
  }
  // VMware/VirtualBox 典型虚拟段：192.168.56.x、192.168.150.x → 再 +2（虚拟惩罚叠加）
  if (/^192\.168\.(56|150)\./.test(addr)) {
    prio += 2;
  }

  // ---------- 第 3 权重：私网段大类 ----------
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(addr)) {
    prio += 2; // 172.16~31 常见 Docker/WSL 段
  } else if (addr.startsWith('10.')) {
    prio += 1; // 10.* 作为第二选择
  } else if (addr.startsWith('169.254.')) {
    prio += 3; // APIPA/自动私有 → 最末
  } else if (!addr.startsWith('192.168.')) {
    prio += 9; // 非私网段（公网等）→ 基本不考虑
  }

  return prio;
}

class LocalHttpServer {
  constructor() {
    // ===== 网络层对象 =====
    this.server = null;          // http.Server
    this.wsServer = null;        // ws.WebSocketServer
    this.port = null;            // 实际绑定端口
    this.token = null;           // 当次启动的一次性鉴权 token（IA-xxxx，面试辅助重开会重新生成）

    // ===== IP 信息 =====
    this.ips = [];               // 枚举到的所有本机 IPv4（非 internal，已去重+排序）
    this.primaryIp = null;       // 二维码中使用的首选 IP

    // ===== 小程序 WS 连接（单连接）=====
    this.minSocket = null;       // 当前已认证的小程序 WebSocket（同时只允许 1 条）
    this._authTimers = new WeakMap(); // 每条 WS → 3s 认证超时定时器（便于连接后立即清）

    // ===== 连接状态机 =====
    // idle(未启动) → listening(服务监听中等待连接) → connected(小程序已连上) → disconnected（掉线）
    this.status = 'idle';
    this.lastPingAt = 0;         // 最近一次收到小程序 ping 的时间戳 ms
    this.lastStatusAt = 0;       // 最近一次 status 变更的时间戳 ms

    // ===== 答题实时态快照（供 WS push + HTTP 兜底轮询读取）=====
    this.state = {
      asrText: '',               // ASR 最新文本（interim 覆盖 / final 也是覆盖，外部显示逻辑可以自行 append）
      answerText: '',            // AI 最新答案文本
      questionImage: '',         // 面试官截图题的图片 dataURL（与面板 interviewScreenshot 同步，H5 轮询后可显示）
      isRecording: false,        // ASR 管线是否在录制
      lastAnswerAt: 0,           // 最近一次 AI 答案生成的时间戳 ms（Date.now()）
      // ===== 多轮对话历史（正序：索引 0 最旧，数组末尾最新）=====
      //   单条结构：{ id, createdAt, status, source, questionText, questionImage, answerText, answeredAt, errorMsg?, sessionId? }
      history: [],
      historyVersion: 0,         // history 变更自增版本号，前端对比即可判断是否需要重绘
      // ===== 面试 Session 层（每场面试 = 1 个 session，内部包含完整 rounds）=====
      activeSessionId: null,     // 当前正在进行的面试 session id（null=尚未开新场）
      sessionsVersion: 0,        // session 列表/详情变更自增版本号（前端轮询增量）
    };
    // ===== 对话历史归档目录：项目根目录下 logs/ 下 JSONL，按天切分 =====
    this._historyDir = path.join(__dirname, '..', 'logs');
    // ===== Session 持久化根：logs/sessions/（二级子目录按 accountId 隔离，__guest__ 对应未登录）=====
    this._auth = null; // AuthService 注入（main.js 中调用 setAuthService）
    this._sessionRootDir = path.join(this._historyDir, SESSION_DIR_NAME);
    // 是否已执行过"顶层 session 迁移到 __guest__"（避免重复迁移）
    this._migratedTopLevelSessions = false;
    // 动态 getter：每次访问 _sessionDir 都根据 currentAccountId 实时拼接，切换登录账号后自动变
    Object.defineProperty(this, '_sessionDir', {
      configurable: true,
      enumerable: true,
      get() { return this._getSessionDir(); }
    });
    Object.defineProperty(this, '_sessionIndexPath', {
      configurable: true,
      enumerable: true,
      get() { return path.join(this._getSessionDir(), SESSION_INDEX_NAME); }
    });
    // 内存里的 session 摘要列表（最近 SESSION_LIST_MAX_IN_MEM 场，最新在头；结构=索引里的一行）
    this._sessionSummaryCache = [];
    // 内存里完整的「当前 active session」对象（含 rounds 数组）；已结束 session 按需从磁盘读
    this._activeSessionObj = null;
    // roundId → sessionId 的反向映射（内存里最近若干，命中直接定位；更多从索引+详情文件 lazy scan）
    this._roundIdToSessionId = new Map();
    // 最近一轮的 id（用来把"写入答案"关联到刚刚"写入问题"的那一轮；如果没有匹配的"活跃轮"则新建一轮）
    this._activeHistoryId = null;

    // ===== 定时器句柄 =====
    this._heartbeatTimer = null;
    this._ipMonitorTimer = null;
    this._lastIpsSignature = ''; // 上次枚举 IP 的"签名"，用于判断网络是否变化（换 WiFi）

    // ===== H5 移动端纯 HTTP 活跃态（无 WebSocket 的在线判断）=====
    // 因为 H5 不会连 /ws，纯靠 token + HTTP 请求判断"是否已连接/是否在线"
    this.h5Active = false;         // H5 是否在活跃状态（最近 30s 内有合法 token 请求）
    this.h5LastActiveAt = 0;       // H5 最近一次合法请求的时间戳 ms
    this._h5IdleTimer = null;      // H5 活跃超时定时器（30s 无请求 → 回 listening）
    const H5_IDLE_TIMEOUT_MS = 30 * 1000; // H5 无请求超时阈值：30s
    this._H5_IDLE_TIMEOUT_MS = H5_IDLE_TIMEOUT_MS;

    // ===== H5 静态文件缓存（首次命中时读盘，后续直接内存返回，阶梯 3 原生 fs）=====
    this._h5HtmlCache = null;   // string 类型的完整 HTML 源码；null 表示尚未读取
    this._h5HtmlPath = path.join(__dirname, '..', 'public', 'h5', 'index.html'); // 相对 services/ → ../public/h5/index.html

    // ===== 节流 =====
    this._interimThrottleTimer = null;  // asr:interim 节流定时器
    this._interimPendingText = '';      // 节流窗口内最新的 interim 文本

    // ===== 外部引用 =====
    this.bus = null;             // 主进程的 app.bus（EventEmitter）
    this._busHandlers = null;    // 本次启动创建的 bus 监听器对象 {eventName:fn}，stop 时统一 off，防内存泄漏
  }

  // ============================================================
  // 1. 启动服务（端口探测 → IP 枚举 → token 生成 → http/ws listen → 定时器 → bus 订阅）
  // 异常：ALL_PORTS_BUSY（28765-28774 全被占用）、NO_IP（未检测到可用局域网 IPv4）
  // ============================================================
  async start({ bus } = {}) {
    // 重复启动保护：已在运行则先停掉旧实例，保证端口干净
    if (this.server) {
      try { this.stop(); } catch (_) { /* 忽略 */ }
    }

    // ===== 1.1 枚举本机 IP（失败抛 NO_IP）=====
    this.ips = this._enumLocalIps();
    if (!this.ips || this.ips.length === 0) {
      const err = new Error('NO_IP');
      err.userMsg = '未检测到局域网连接，请连接 WiFi 后重试';
      throw err;
    }
    this.primaryIp = this.ips[0];

    // ===== 1.2 探测可用端口（失败抛 ALL_PORTS_BUSY）=====
    this.port = await this._bindPortRange(PORT_START, PORT_END);
    if (!this.port) {
      const err = new Error('ALL_PORTS_BUSY');
      err.userMsg = `端口 ${PORT_START}-${PORT_END} 被占用，请关闭其他程序后重试`;
      throw err;
    }

    // ===== 1.3 生成一次性 token =====
    this.token = 'IA-' + crypto.randomBytes(8).toString('hex').slice(0, 16);

    // ===== 1.4 创建正式 HTTP + WS 服务器（必须先 createServer，再显式 listen，确保 this.server 真正在处理请求）=====
    this.server = http.createServer((req, res) => {
      // 每个请求独立 try/catch，防止单次异常挂掉整个 HTTP 服务
      try {
        this._onHttpRequest(req, res);
      } catch (e) {
        console.error('[localHttpServer] HTTP 处理异常:', e.message);
        this._json(res, 500, { ok: false, error: 'internal', msg: e.message || '服务内部错误' });
      }
    });
    // ⚠️ 关键：显式调用 listen 绑定正式 server 到探测好的端口（_bindPortRange 已释放临时 server，所以这里不会冲突）
    await new Promise((resolve, reject) => {
      // 同时注册 error 和 listening 两个回调，保证 Promise 一定能 resolve/reject（避免像浏览器一样永远 pending）
      const onError = (err) => {
        reject(new Error(`正式 server listen ${this.port} 失败：${(err && err.message) || err}`));
      };
      this.server.once('error', onError);
      this.server.listen(this.port, BIND_ADDR, () => {
        this.server.off('error', onError); // 监听成功就移除 error 监听，避免后续错误抛到这里 reject Promise
        console.log(`[localHttpServer] ✅ 正式 HTTP server 已成功监听：${BIND_ADDR}:${this.port}`);
        resolve();
      });
    });

    // listen 成功之后再挂载 WS（WS 必须挂在已经监听的 server 上，否则 upgrade 请求接不到）
    if (WebSocketServerCtor) {
      this.wsServer = new WebSocketServerCtor({ server: this.server, path: '/ws' });
      this.wsServer.on('connection', (ws, req) => {
        try {
          this._onWsConnection(ws, req);
        } catch (e) {
          console.error('[localHttpServer] WS connection 异常:', e.message);
          try { ws.close(1011, 'internal'); } catch (_) { /* 忽略 */ }
        }
      });
      console.log(`[localHttpServer] ✅ WebSocket 已挂载：path=/ws`);
    } else {
      console.warn('[localHttpServer] ws 模块不可用，仅提供 HTTP 接口（小程序无法用 WS）');
    }

    // ===== 1.5 状态切换 =====
    this._setStatus('listening');
    this.lastPingAt = Date.now(); // 初始化 ping 参考点（避免刚启动就误判掉线）

    // ===== 1.6 启动定时器：心跳 10s + IP 监控 5s =====
    this._heartbeatTimer = setInterval(() => this._heartbeatTick(), HEARTBEAT_INTERVAL_MS);
    this._ipMonitorTimer = setInterval(() => this._ipMonitorTick(), IP_MONITOR_INTERVAL_MS);

    // ===== 1.7 初始化 sessions（目录 / 索引加载到内存缓存）=====
    try {
      this._initSessionsStorage();
    } catch (se) {
      console.warn('[localHttpServer][sessions] ⚠️ session 存储初始化失败（仍可运行，只是历史面试记录列表为空）：', se && se.message);
    }

    // ===== 1.8 订阅 app.bus（ASR / 答案 / 状态 → 推小程序）=====
    if (bus) {
      this.bus = bus;
      this._attachBus();
    }

    console.log(`[localHttpServer] 启动成功：监听 ${BIND_ADDR}:${this.port}，首选IP=${this.primaryIp}，token=${this.token.substring(0, 6)}***`);
    // ====== H5 调试增强：手机访问失败定位用（把完整 URL 打出来，可复制到电脑浏览器自测） ======
    const qrH5Url = `http://${this.primaryIp}:${this.port}/h5?token=${encodeURIComponent(this.token)}`;
    const localhostH5Url = `http://127.0.0.1:${this.port}/h5?token=${encodeURIComponent(this.token)}`;
    console.log('====================================================================');
    console.log('[H5-DEBUG] ✅ 本地 HTTP 服务已就绪，二维码/手机访问信息：');
    console.log(`[H5-DEBUG] ① 手机微信扫码目标 URL：${qrH5Url}`);
    console.log(`[H5-DEBUG] ② 电脑本机自测 URL（先复制到浏览器试，先排除手机侧问题）：${localhostH5Url}`);
    console.log(`[H5-DEBUG] ③ 健康检查（免 token）：http://127.0.0.1:${this.port}/health`);
    console.log('[H5-DEBUG] ⚠️  手机连不上 H5 的常见自查清单（按顺序）：');
    console.log('[H5-DEBUG]    1) 手机和电脑必须连 同一个 WiFi / 同一个局域网（不能是流量+有线不同网段）');
    console.log('[H5-DEBUG]    2) 首选 IP 是不是真 WiFi 网卡？看上方【网卡明细】，如果是「VMware/VMnet/Hyper-V/vEthernet/VirtualBox」就是虚拟网卡，手机连不上');
    console.log('[H5-DEBUG]    3) Windows 防火墙是否拦截 Node.js？首次访问会弹允许提示，要点「允许访问」（专用网络）');
    console.log('[H5-DEBUG]    4) 自测先用电脑本机浏览器打开 ②，若都打不开就是服务没起/端口被占；若电脑能打开手机不能就是网络层/防火墙问题');
    console.log('[H5-DEBUG]    5) 手机端打开后若返回 JSON {ok:false,msg:"token 无效…"}，说明网络通了，只是二维码过期（重新扫码）');
    console.log('====================================================================');
    return this.getStatus();
  }

  // ============================================================
  // 2. 停止服务（关 server / ws / 清定时器 / 取消 bus 订阅）
  // ============================================================
  stop() {
    // 清所有定时器（独立 try/catch，单项失败不影响其他）
    try { if (this._heartbeatTimer) { clearInterval(this._heartbeatTimer); this._heartbeatTimer = null; } } catch (_) {}
    try { if (this._ipMonitorTimer) { clearInterval(this._ipMonitorTimer); this._ipMonitorTimer = null; } } catch (_) {}
    try { if (this._interimThrottleTimer) { clearTimeout(this._interimThrottleTimer); this._interimThrottleTimer = null; } } catch (_) {}
    try { if (this._h5IdleTimer) { clearTimeout(this._h5IdleTimer); this._h5IdleTimer = null; } } catch (_) {}

    // 关闭当前小程序 WS 连接
    try {
      if (this.minSocket) {
        this.minSocket.close(1001, 'server_stop');
        this.minSocket = null;
      }
    } catch (_) { /* 忽略 */ }

    // 关闭 WS server
    try {
      if (this.wsServer) {
        this.wsServer.close();
        this.wsServer = null;
      }
    } catch (_) { /* 忽略 */ }

    // 关闭 HTTP server
    try {
      if (this.server) {
        this.server.close();
        this.server = null;
      }
    } catch (_) { /* 忽略 */ }

    // 取消 app.bus 订阅（防内存泄漏）
    this._detachBus();

    // 复位字段
    this.port = null;
    this.token = null;
    this.ips = [];
    this.primaryIp = null;
    this._lastIpsSignature = '';
    this._setStatus('idle');
    console.log('[localHttpServer] 已停止');
  }

  // ============================================================
  // 3. 当前状态快照（给 overlay 弹窗 / IPC 返回）
  // ============================================================
  getStatus() {
    // 小程序 WS 是否真的连上（readyState === 1 OPEN）
    const hasMinSocket = !!(this.minSocket && this.minSocket.readyState === 1);
    // lastPingAt 统一：小程序用 WS ping 时间，H5 用最后 HTTP 请求时间，哪个新取哪个（UI 显示 xxxs 前）
    const lastActive = Math.max(this.lastPingAt || 0, this.h5LastActiveAt || 0);
    return {
      status: this.status,
      port: this.port,
      token: this.token,
      ips: this.ips.slice(),
      primaryIp: this.primaryIp,
      // connected 两种模式都考虑：小程序已连 OR H5 活跃 → 都是"已连接"
      connected: hasMinSocket || !!this.h5Active,
      // 给 UI 判断当前是"微信小程序"还是"H5/手机浏览器"连上的
      wsConnected: hasMinSocket,
      h5Active: !!this.h5Active,
      h5LastActiveAt: this.h5LastActiveAt,
      // UI 显示"xxxs 前"使用统一取大后的活跃时间
      lastPingAt: lastActive,
      wsLastPingAt: this.lastPingAt,
      lastStatusAt: this.lastStatusAt,
      ts: Date.now(),
      // state 浅拷贝一份（避免外部改写内部对象）
      asrText: this.state.asrText,
      answerText: this.state.answerText,
      isRecording: this.state.isRecording,
      lastAnswerAt: this.state.lastAnswerAt,
    };
  }

  // ============================================================
  // 4. 二维码 payload（JSON 字符串 → qrcode 生成 dataUrl）
  // 字段：v / ip / altIps / port / token / ts
  // ============================================================
  getQRPayload() {
    if (this.status === 'idle') {
      throw new Error('SERVER_NOT_STARTED');
    }
    const payload = {
      v: 1,
      ip: this.primaryIp,
      altIps: this.ips.length > 1 ? this.ips.slice(1, 4) : [],
      port: this.port,
      token: this.token,
      ts: Date.now(),
    };
    return JSON.stringify(payload);
  }

  // ============================================================
  // 5.1 对话历史辅助：生成单调递增的轮次 ID（时间戳 36 进制 + 随机 4 位，避免同一 ms 冲突）
  // ============================================================
  _nextHistoryId() {
    return 'r-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  }

  // ============================================================
  // 5.2 对话历史辅助：把 history 数组超出上限的最旧条目，追加写入 JSONL 归档文件（按天分割）
  //   - history 数组始终保持 <= HISTORY_MAX_IN_MEM
  //   - 溢出的 item 按行 JSON 追加到 logs/ia-history-YYYYMMDD.jsonl
  //   - 任何错误打 warn 日志，不阻塞主流程（内存丢失风险可接受，因为失败会留在数组里下次再试）
  // ============================================================
  _evictHistoryIfOverflow() {
    try {
      while (this.state.history.length > HISTORY_MAX_IN_MEM) {
        const oldest = this.state.history.shift();
        if (!oldest) continue;
        // 确保归档目录存在
        try {
          if (!fs.existsSync(this._historyDir)) fs.mkdirSync(this._historyDir, { recursive: true });
        } catch (mkdirErr) {
          console.warn('[history] 创建 logs/ 目录失败，跳过归档：', mkdirErr && mkdirErr.message);
          continue;
        }
        // 日期标签：YYYYMMDD（取当前本地时区，确保归档按自然日切分）
        const d = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const tag = String(d.getFullYear()) + pad(d.getMonth() + 1) + pad(d.getDate());
        const filePath = path.join(this._historyDir, HISTORY_FILE_PREFIX + tag + '.jsonl');
        // 写 JSONL 一行：归档版本中把超大截图缩略/保留原字段，避免 JSONL 文件无限膨胀
        const archiveItem = {
          id: oldest.id,
          createdAt: oldest.createdAt,
          answeredAt: oldest.answeredAt || 0,
          status: oldest.status,
          source: oldest.source || '',
          questionText: oldest.questionText || '',
          questionImageLen: (oldest.questionImage && typeof oldest.questionImage === 'string') ? oldest.questionImage.length : 0,
          answerText: oldest.answerText || '',
          errorMsg: oldest.errorMsg || '',
          // 归档版本保留截图（用户后续回看时可追溯），但不单独拆文件（单条 JSONL 方便检索）
          questionImage: oldest.questionImage || '',
        };
        try {
          fs.appendFileSync(filePath, JSON.stringify(archiveItem) + '\n', 'utf-8');
          console.log(`[history] 归档轮次 ${oldest.id} → ${path.basename(filePath)} (答案长度=${(oldest.answerText||'').length})`);
        } catch (writeErr) {
          console.warn('[history] 写入归档 JSONL 失败（已兜底忽略）：', writeErr && writeErr.message);
        }
        // ===== 🔴【SQLite 双写 5/4】：溢出轮次同步写入 ia_dialog_messages 表
        //   一场 round 拆成 2 条对话消息：user(问题) + assistant(答案/错误)，
        //   与原 ia-history-YYYYMMDD.jsonl 归档一一对应，便于后续检索/回溯。
        //   写失败只打 warn，不阻断流程（JSONL 已成功、SQLite 可后续补对齐）。
        try {
          if (_sessionRepo && _sessionRepo.ready) {
            const aid = _currentAccountIdForRepo(this);
            const sid = (this.state && this.state.activeSessionId) ? String(this.state.activeSessionId) : '';
            const tsQ = Number(oldest.createdAt) || Date.now();
            const tsA = Number(oldest.answeredAt) || tsQ;
            // 1) 问题消息：role=user
            const qTxt = String(oldest.questionText || '').trim();
            if (qTxt) {
              _sessionRepo.appendDialogMessage({
                messageId: oldest.id ? 'q-' + oldest.id : undefined,
                accountId: aid,
                sessionId: sid,
                role: 'user',
                content: qTxt,
                status: 'ok',
                createdAt: tsQ,
              });
            }
            // 2) 答案消息：role=assistant；status 根据 round.status 决定
            const aTxt = String(oldest.answerText || '').trim();
            const eTxt = String(oldest.errorMsg || '').trim();
            if (aTxt || eTxt) {
              const isErr = (oldest.status === HISTORY_STATUS_ERROR) || !!eTxt;
              _sessionRepo.appendDialogMessage({
                messageId: oldest.id ? 'a-' + oldest.id : undefined,
                accountId: aid,
                sessionId: sid,
                role: 'assistant',
                content: aTxt + (eTxt ? `\n[ERROR] ${eTxt}` : ''),
                status: isErr ? 'error' : 'ok',
                createdAt: tsA,
              });
            }
          }
        } catch (dbErr) {
          console.warn('[history][sqlite-sync] ⚠️ 溢出轮次写入 ia_dialog_messages 失败（已兜底忽略）：', dbErr && dbErr.message);
        }
      }
    } catch (e) {
      console.warn('[history] 溢出归档异常（已兜底忽略）：', e && e.message);
    }
  }

  // ============================================================
  // 5.2.X Session 层辅助 1：生成单调 Session ID（ses_年月日_时分秒_随机6位）
  // ============================================================
  _nextSessionId() {
    const d = new Date();
    const pad = (n, w = 2) => String(n).padStart(w, '0');
    const tag = String(d.getFullYear()) + pad(d.getMonth() + 1) + pad(d.getDate())
              + '_' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
    return 'ses_' + tag + '_' + Math.random().toString(36).slice(2, 8);
  }

  // ============================================================
  // 5.2.X Session 层辅助 2：按 startedAt 时间戳生成展示标题中的时间片（MM月DD日 HH:mm）
  // ============================================================
  _formatSessionTime(ts) {
    const d = new Date(ts || Date.now());
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getMonth() + 1)}月${pad(d.getDate())}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  // ============================================================
  // 5.2.X Session 层辅助 3：生成 session 标题
  //   命名 = {公司||未知公司} - {职位||未知职位} - {MM月DD日 HH:mm}
  // ============================================================
  _buildSessionTitle({ targetCompany, targetPosition, startedAt }) {
    const company  = (String(targetCompany || '').trim()) || '未知公司';
    const position = (String(targetPosition || '').trim()) || '未知职位';
    const when = this._formatSessionTime(startedAt);
    return `${company} - ${position} - ${when}`;
  }

  /**
   * 推断一条 session（摘要 或 详情对象）属于『真实面试 / 模拟面试』中的哪一种。
   * 兼容：老 session（历史遗留数据，创建时未写 category）必须能正确反推，不能让真实面试
   *       跑到模拟面试 Tab 下（默认按 copilot 兜底，保证不误伤）。
   * 规则优先级（从高到低）：
   *   1) 顶层 row.category === 'copilot' / 'mock' 且合法 → 直接采用（新格式）
   *   2) meta.mockInterview 存在 → 模拟面试（模拟面试创建时写入 session.meta.mockInterview）
   *   3) _mockInterviewCache 存在 → 模拟面试（内存冗余副本，meta 被意外覆盖时也能识别）
   *   4) config / snapshotCfg._mockInterview 存在 → 模拟面试
   *   5) 其他所有情况 → copilot（真实面试，默认兜底，宁可多算真实也不把真实错放模拟下）
   * @param {Object} row summary 行对象 或 session 详情对象
   * @returns {'copilot'|'mock'}
   */
  _inferSessionCategory(row) {
    const r = (row && typeof row === 'object') ? row : {};
    // 1) 新格式：顶层 category 合法 → 直接用
    if (r.category === 'copilot' || r.category === 'mock') return r.category;
    // 2) meta.mockInterview → 模拟面试
    if (r.meta && typeof r.meta === 'object' && r.meta.mockInterview) return 'mock';
    // 3) 内存冗余标记 → 模拟面试
    if (r._mockInterviewCache && typeof r._mockInterviewCache === 'object') return 'mock';
    // 4) 顶层快照 config._mockInterview → 模拟面试
    if (r.config && typeof r.config === 'object' && r.config._mockInterview) return 'mock';
    if (r._cfg && typeof r._cfg === 'object' && r._cfg._mockInterview) return 'mock';
    // 5) 默认：真实面试（安全兜底，避免真实面试被错误归档到模拟面试）
    return 'copilot';
  }

  // ============================================================
  // 5.2.X Session 层辅助 3bis：把一条"session 摘要（_index.jsonl 的一行）/详情对象（.json 的顶层）"归一化为 UI 卡片可直接消费的结构。
  //   背景：历史摘要 flush 写的是 roundCount / answeredCount，而 UI（renderSessionsList）读 roundsCount / questionCount / snippet / lastRounds / sessionId。
  //   约定：不管输入来自旧 JSONL 行还是 session 详情对象，统一输出双份字段名（兼容新老消费代码）：
  //     - roundsCount   = roundCount （列表卡片"💬 N 轮"）
  //     - questionCount = rounds 里"有 questionText 或 questionImage 的条数"（UI 显示 "❓ N 题"，若拿不到 rounds 就退回 answeredCount）
  //     - sessionId     = id（HTTP/IPC 消费者与卡片 data-session-id 双路径兼容）
  //     - snippet       = 最近一轮问题或答案前 80 字（卡片简短描述；若输入已给 snippet 复用）
  //     - lastRounds    = 最近 2 轮缩略（{questionText, answerText}；已有则保留）
  //     - status        = 原 status；兜底用 endedAt>0 ? 'ended' : 'active'
  //   输入对象不会被修改（避免改坏 detail JSON 或 _sessionSummaryCache 中的源对象），返回新对象。
  // ============================================================
  _normalizeSessionSummaryForUI(input, opts) {
    const s = (input && typeof input === 'object') ? input : {};
    const out = Object.assign({}, s);
    // 1) 基础 id 双份
    if (!out.sessionId && s.id) out.sessionId = s.id;
    if (!out.id && s.sessionId) out.id = s.sessionId;
    // 2) 轮次 / 题数：新老字段名都填
    const rounds = Array.isArray(s.rounds) ? s.rounds : null;
    const rCount = Number(s.roundsCount != null ? s.roundsCount : s.roundCount) || 0;
    out.roundCount = rCount;
    out.roundsCount = rCount;
    if (rounds && rounds.length && !rCount) { out.roundCount = rounds.length; out.roundsCount = rounds.length; }
    const ansCount = Number(s.answeredCount || 0) || 0;
    out.answeredCount = ansCount;
    let qCount = Number(s.questionCount || 0) || 0;
    if (!qCount && rounds) {
      // 从真实 rounds 精算：questionText 非空 或 questionImage 非空 算一条题
      for (const r of rounds) {
        if (!r) continue;
        const q = String(r.questionText || '').trim();
        const img = String(r.questionImage || '').trim();
        if (q || img) qCount++;
      }
    }
    if (!qCount) qCount = ansCount; // 拿不到 rounds 的兜底：用已答数估题数
    out.questionCount = qCount;
    // 3) 状态兜底：摘要里有 status 优先；否则靠 endedAt 推测
    if (!out.status) {
      out.status = (Number(out.endedAt || s.endedAt) > 0) ? SESSION_STATUS_ENDED : SESSION_STATUS_ACTIVE;
    }
    // 4) 元信息：公司/职位 —— 如果输入只有 config，把它展开（详情对象里公司职位在 config.targetCompany/config.targetPosition 上）
    if ((!out.targetCompany || !String(out.targetCompany).trim()) && s.config && typeof s.config === 'object') {
      out.targetCompany = String(s.config.targetCompany || '').trim();
      out.targetPosition = String(s.config.targetPosition || '').trim();
      out.interviewType = out.interviewType || String(s.config.interviewType || '').trim();
    }
    // 5) snippet / lastRounds 构建
    if (!out.lastRounds || !Array.isArray(out.lastRounds) || out.lastRounds.length === 0) {
      if (rounds && rounds.length) {
        const tail = rounds.slice(-2).map((r) => ({
          questionText: String(r && r.questionText || '').substring(0, 80),
          answerText:   String(r && r.answerText   || '').substring(0, 120),
        }));
        out.lastRounds = tail;
      } else if (Array.isArray(s.lastRounds) && s.lastRounds.length) {
        out.lastRounds = s.lastRounds.slice();
      }
    }
    if (!out.snippet || !String(out.snippet).trim()) {
      if (Array.isArray(out.lastRounds) && out.lastRounds.length) {
        const last = out.lastRounds[out.lastRounds.length - 1];
        const q = String(last && last.questionText || '').trim();
        const a = String(last && last.answerText || '').trim();
        const merged = q ? q : a;
        if (merged) out.snippet = merged.substring(0, 80);
      } else if (typeof s.snippet === 'string' && s.snippet.trim()) {
        out.snippet = s.snippet.substring(0, 80);
      }
    }
    // 6) 时间：startedAt / endedAt / lastActiveAt 统一数字
    out.startedAt    = Number(out.startedAt    || s.startedAt    || 0) || 0;
    out.endedAt      = Number(out.endedAt      || s.endedAt      || 0) || 0;
    out.lastActiveAt = Number(out.lastActiveAt || s.lastActiveAt || out.startedAt) || out.startedAt;
    // 7) title 兜底：没 title（详情对象可能有 session.id 但没 title 也没 summary）用 _buildSessionTitle 拼一次
    if (!out.title) {
      try {
        out.title = this._buildSessionTitle({
          targetCompany: out.targetCompany || '',
          targetPosition: out.targetPosition || '',
          startedAt:      out.startedAt,
        });
      } catch (_) { out.title = '面试会话'; }
    }
    // 8) ★ 面试类型 category 归一化（真实 copilot / 模拟 mock）
    //   即使输入是旧 summary（没有 category），也用 _inferSessionCategory 反推出来，
    //   保证前端渲染 session 卡片时能直接读 s.category，无需再做兼容推断。
    out.category = this._inferSessionCategory(s);
    void opts;
    return out;
  }

  // ============================================================
  // 5.2.X Session 层辅助 4：原子写 JSON（先写 .tmp 再 rename，避免半写入损坏）
  // ============================================================
  _atomicWriteJson(filePath, obj) {
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj), 'utf-8');
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (_) { /* ignore */ }
    fs.renameSync(tmp, filePath);
  }

  // ============================================================
  // 5.2.X Session 层辅助 5：把 sessionsVersion 自增 +1（任何 session/列表 变动都 bump 一次）
  // ============================================================
  _bumpSessionsVersion(reason) {
    this.state.sessionsVersion = (Number(this.state.sessionsVersion) || 0) + 1;
    if (reason) {
      console.log(`[sessions] ✏️ sessionsVersion=${this.state.sessionsVersion} 变更：${reason}`);
    }
  }

  // ============================================================
  // ★ 账号感知 Session 目录（新增）
  //   AuthService 注入 + 当前账号目录拼接 + 老版本顶层 session 自动迁移
  // ============================================================
  /**
   * 注入 AuthService 实例（main.js 在 localHttpServer 单例启动后调用）
   */
  setAuthService(authService) {
    this._auth = authService || null;
  }

  /**
   * 按当前登录账号返回 session 持久化目录（logs/sessions/{accountId}/）
   *   - 未登录：logs/sessions/__guest__/
   *   - 已登录 accountId=xxx：logs/sessions/xxx/
   * 每次调用都实时拼接，账号登出/切换后立即生效。
   */
  _getSessionDir() {
    const accountId = (this._auth && typeof this._auth.currentAccountId === 'string')
      ? this._auth.currentAccountId
      : '__guest__';
    return path.join(this._sessionRootDir, accountId);
  }

  /**
   * 老用户升级兼容：把 logs/sessions/ 顶层直接散放的 *.json / sessions-index.json
   * 迁移到 logs/sessions/__guest__/ 对应路径。
   * 规则：
   *   1) 只迁移一次（启动时首次进入 _initSessionsStorage 调用）
   *   2) 使用"先 copy + 校验 md5 → 再延迟 delete"而不是 mv；失败则保留原文件不做破坏性操作
   *   3) 迁移时跳过已经存在的目标文件（避免覆盖）
   */
  _migrateTopLevelSessionsToGuest() {
    if (this._migratedTopLevelSessions) return;
    this._migratedTopLevelSessions = true;
    try {
      const root = this._sessionRootDir;
      if (!fs.existsSync(root)) { fs.mkdirSync(root, { recursive: true }); return; }
      // 预期目标目录：__guest__/
      const guestDir = path.join(root, '__guest__');
      if (!fs.existsSync(guestDir)) fs.mkdirSync(guestDir, { recursive: true });

      // 顶层所有条目：index 文件 + session JSON
      const entries = fs.readdirSync(root, { withFileTypes: true });
      let movedCount = 0;
      for (const e of entries) {
        if (!e.isFile()) continue;
        const name = e.name;
        // 只处理"顶层 session json / sessions-index.jsonl"：
        //   - 形如 abc.json 的"会话详情文件"
        //   - 形如 sessions-index.jsonl / sessions-index.jsonl.bak.* 的"索引或其备份"
        // 其它目录（比如已有的 __guest__ 本身）不处理
        if (!name.endsWith('.json') && !name.startsWith(SESSION_INDEX_NAME)) continue;
        const src = path.join(root, name);
        const dst = path.join(guestDir, name);
        if (fs.existsSync(dst)) {
          // 目标已存在（可能是之前半迁移过），跳过以防覆盖
          console.warn(`[sessions-migrate] ⏭ 目标已存在，跳过：${name}`);
          continue;
        }
        try {
          const buf = fs.readFileSync(src);
          fs.writeFileSync(dst, buf);
          // 写入成功再删源（不抛异常就当迁移成功）
          try { fs.unlinkSync(src); } catch (_) { console.warn(`[sessions-migrate] ⚠️ 删除源文件失败：${name}（保留不影响）`); }
          movedCount++;
        } catch (err) {
          console.warn(`[sessions-migrate] ❌ 迁移失败，跳过：${name} → ${err.message}`);
        }
      }
      if (movedCount > 0) {
        console.log(`[sessions-migrate] ✅ 已把顶层 ${movedCount} 个 session 文件迁移到 logs/sessions/__guest__/`);
        // 迁移后内存缓存可能还指向旧路径，让调用方（_initSessionsStorage）重新扫描即可
        this._sessionSummaryCache = [];
        this._roundIdToSessionId.clear();
        this._bumpSessionsVersion('top-level-migration');
      }
    } catch (e) {
      console.warn('[sessions-migrate] 迁移异常（不影响后续运行）：', e.message);
    }
  }

  /**
   * 🟢 【已废弃】合并 fromAccountId 目录下的 session 与索引到 toAccountId 目录。
   * —— 需求变更：不再执行"游客→登录账号"的合并流程；登录后直接按账号隔离读取
   *    SQLite 中属于自己的 ia_sessions 行，GUEST 命名空间保持独立。
   * —— 本函数保留函数签名（防止旧代码/脚本/测试直接调 mergeSessionsFromAccount 时抛
   *    TypeError 崩溃），但内部不再搬运任何文件，永远返回空结果。
   *
   * @param {string} fromAccountId  源账号（保留，不再使用）
   * @param {string} toAccountId    目标账号（保留，不再使用）
   * @returns {{movedSessionCount:number, appendedIndexLines:number, skippedDuplicates:number}} 永远全 0
   */
  mergeSessionsFromAccount(fromAccountId, toAccountId) {
    // 🟢 空实现：不读目录、不复制文件、不追加索引。只打印一条日志。
    console.info(
      `[sessions-merge] ℹ️ mergeSessionsFromAccount 已废弃（from=${fromAccountId} to=${toAccountId}）：` +
      `按需求不再合并游客数据，登录后直接读取当前账号名下的 SQLite 数据。`
    );
    return { movedSessionCount: 0, appendedIndexLines: 0, skippedDuplicates: 0 };
  }

  /**
   * 清空指定账号的 session 目录内容（仅删 *.json 与 _index.jsonl，保留目录本身）。
   * 用于"合并成功后清空游客 session"。
   */
  clearAccountSessions(accountId) {
    const dir = path.join(this._sessionRootDir, String(accountId || ''));
    let deleted = 0;
    if (!accountId || !fs.existsSync(dir)) return { deleted };
    try {
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.json')) continue;
        const f = path.join(dir, name);
        if (fs.statSync(f).isFile()) {
          try { fs.unlinkSync(f); deleted++; } catch (_) {}
        }
      }
      this._sessionSummaryCache = [];
      this._roundIdToSessionId.clear();
      this._bumpSessionsVersion('clear-' + accountId);
      console.log(`[sessions-clear] ✅ ${accountId}：已删除 ${deleted} 个 session 文件`);
    } catch (e) {
      console.warn('[sessions-clear] 清理异常：', e.message);
    }
    return { deleted };
  }

  // ============================================================
  // 5.2.X Session 层 6：初始化存储（目录不存在就创建；索引损坏就备份重建；加载最近 N 条摘要到内存缓存）
  // ============================================================
  _initSessionsStorage() {
    // ★ 先执行一次顶层 → __guest__/ 迁移（仅首次有效，幂等）
    this._migrateTopLevelSessionsToGuest();

    // 1) 确保目录存在
    if (!fs.existsSync(this._historyDir)) fs.mkdirSync(this._historyDir, { recursive: true });
    if (!fs.existsSync(this._sessionDir)) fs.mkdirSync(this._sessionDir, { recursive: true });
    // 2) 索引文件若损坏 → rename 为 .bak.TIMESTAMP 并重建
    if (fs.existsSync(this._sessionIndexPath)) {
      try {
        const raw = fs.readFileSync(this._sessionIndexPath, 'utf-8');
        const lines = raw.split('\n').filter((l) => l && l.trim().length > 0);
        for (const line of lines) JSON.parse(line); // 尝试 JSON 解析，每行都坏才触发备份
      } catch (e) {
        const bak = this._sessionIndexPath + '.bak.' + Date.now() + '.jsonl';
        try { fs.renameSync(this._sessionIndexPath, bak); console.warn(`[sessions] ⚠️ _index.jsonl 解析失败，已备份到 ${path.basename(bak)} 并重建`); }
        catch (_) { try { fs.unlinkSync(this._sessionIndexPath); } catch (__) { /* ignore */ } }
      }
    }
    // 3) 读最近 N 行到内存缓存（最新在尾 → reverse 放头）
    const cache = [];
    if (fs.existsSync(this._sessionIndexPath)) {
      const raw = fs.readFileSync(this._sessionIndexPath, 'utf-8');
      const lines = raw.split('\n').filter((l) => l && l.trim().length > 0);
      // 从最后一行往前取 SESSION_LIST_MAX_IN_MEM 条
      for (let i = lines.length - 1; i >= 0 && cache.length < SESSION_LIST_MAX_IN_MEM; i--) {
        try { cache.push(JSON.parse(lines[i])); } catch (_) { /* 坏行跳过 */ }
      }
    }
    this._sessionSummaryCache = cache;
    // 4) 顺便把最近几场 rounds 的 roundId→sessionId 填入 map，加速侧栏点击跳转定位
    for (const s of cache.slice(0, 10)) {
      if (s && s.id) {
        try {
          const detailPath = path.join(this._sessionDir, `${s.id}.json`);
          if (!fs.existsSync(detailPath)) continue;
          const detail = JSON.parse(fs.readFileSync(detailPath, 'utf-8'));
          if (detail && Array.isArray(detail.rounds)) {
            for (const r of detail.rounds) {
              if (r && r.id) this._roundIdToSessionId.set(String(r.id), String(s.id));
            }
          }
        } catch (_) { /* 某个文件坏了忽略 */ }
      }
    }
    console.log(`[sessions] ✅ 初始化完成：目录=${path.relative(process.cwd(), this._sessionDir)} | 缓存摘要 ${cache.length} 场 | roundId映射${this._roundIdToSessionId.size}条`);
  }

  // ============================================================
  // 5.2.X Session 层 7：原子 append 索引 JSONL 单行（新创建 session 或 end 更新 summary 时调用）
  //   mode='append'：把 summary 追加到索引末尾；mode='rewrite-summary'：先扫描所有 id 相同行，用最新一行覆盖旧的
  //   为了简化索引不做 in-place 修改，重写策略：整文件重写，命中 id=summary.id 用新 summary 替换（最多 500 场都秒级）
  // ============================================================
  _upsertSessionSummary(summary) {
    if (!summary || !summary.id) return;
    try {
      const lines = [];
      let replaced = false;
      if (fs.existsSync(this._sessionIndexPath)) {
        const raw = fs.readFileSync(this._sessionIndexPath, 'utf-8');
        for (const line of raw.split('\n')) {
          if (!line || !line.trim()) continue;
          let row = null;
          try { row = JSON.parse(line); } catch (_) { row = null; }
          if (row && row.id === summary.id) { lines.push(JSON.stringify(summary)); replaced = true; }
          else if (row) { lines.push(line); }
        }
      }
      if (!replaced) lines.push(JSON.stringify(summary));
      // 整文件重写（500 场也只有几十 KB，完全可接受）
      fs.writeFileSync(this._sessionIndexPath, lines.join('\n') + '\n', 'utf-8');
      // 更新内存缓存：如果已存在则替换，否则插入头；超过上限丢最旧
      const idx = this._sessionSummaryCache.findIndex((x) => x && x.id === summary.id);
      if (idx >= 0) this._sessionSummaryCache[idx] = summary;
      else this._sessionSummaryCache.unshift(summary);
      if (this._sessionSummaryCache.length > SESSION_LIST_MAX_IN_MEM) {
        this._sessionSummaryCache.splice(SESSION_LIST_MAX_IN_MEM, this._sessionSummaryCache.length - SESSION_LIST_MAX_IN_MEM);
      }
      // 把最新的一条（刚刚 upsert 的）始终放头
      this._sessionSummaryCache.sort((a, b) => Number(b && b.lastActiveAt || 0) - Number(a && a.lastActiveAt || 0));
    } catch (e) {
      console.warn('[sessions] upsert summary 失败（已兜底忽略）：', e && e.message);
    }
  }

  // ============================================================
  // 5.2.X Session 层 8：把内存中的 _activeSessionObj 完整写回 {id}.json
  //   每轮变更都写（单条 JSON 很小，IO 可接受；用户电脑断电最多丢最后几秒的一轮）
  // ============================================================
  _flushActiveSessionToDisk(reason) {
    if (!this._activeSessionObj || !this._activeSessionObj.id) return;
    try {
      // 统计信息（列表卡片直接显示不用再打开详情）
      const rds = Array.isArray(this._activeSessionObj.rounds) ? this._activeSessionObj.rounds : [];
      let answeredCount = 0, errorCount = 0;
      for (const r of rds) {
        if (r && r.status === HISTORY_STATUS_ANSWERED) answeredCount++;
        else if (r && r.status === HISTORY_STATUS_ERROR) errorCount++;
      }
      const lastActiveAt = (rds && rds.length) ? (rds[rds.length - 1].answeredAt || rds[rds.length - 1].createdAt || Date.now()) : (this._activeSessionObj.startedAt || Date.now());
      this._activeSessionObj.stats = {
        roundCount: rds.length,
        answeredCount,
        errorCount,
        totalDurationMs: Math.max(0, ((this._activeSessionObj.endedAt || lastActiveAt) - (this._activeSessionObj.startedAt || lastActiveAt))),
      };
      this._activeSessionObj.lastActiveAt = lastActiveAt;
      // 1) 写详情 .json
      const detailPath = path.join(this._sessionDir, `${this._activeSessionObj.id}.json`);
      this._atomicWriteJson(detailPath, this._activeSessionObj);
      // 2) upsert 摘要到索引：先把 _activeSessionObj（含完整 rounds 精算 snippet/lastRounds/qCount）归一化成 UI 结构，再落 JSONL
      //    保证 _index.jsonl 每行以后读出来就能直接当卡片字段用，不用反复扫详情
      const norm = this._normalizeSessionSummaryForUI(this._activeSessionObj);
      const summary = {
        id:           norm.id,
        sessionId:    norm.sessionId,     // 别名，方便未来消费
        // ★ 面试类型标签（copilot 真实面试 / mock 模拟面试）：列表按此互斥过滤
        category:     norm.category || this._inferSessionCategory(norm),
        title:        norm.title,
        targetCompany: norm.targetCompany,
        targetPosition: norm.targetPosition,
        startedAt:    norm.startedAt,
        endedAt:      norm.endedAt,
        status:       norm.status,
        // 轮次/题数：双份字段（兼容新老渲染与查询）
        roundCount:   norm.roundCount,
        roundsCount:  norm.roundsCount,
        answeredCount:norm.answeredCount,
        questionCount:norm.questionCount,
        errorCount:   errorCount,
        lastActiveAt: norm.lastActiveAt,
        interviewType:norm.interviewType || '',
        // 摘要小卡片描述：snippet + 最近 2 轮缩略（均按归一化结果取）
        snippet:      norm.snippet || '',
        lastRounds:   Array.isArray(norm.lastRounds) ? norm.lastRounds.slice(0, 2) : [],
      };
      this._upsertSessionSummary(summary);
      // 3) bump version
      this._bumpSessionsVersion(reason || `flush session ${this._activeSessionObj.id}`);

      // ===== 【双写 SQLite 4/4】Flush 兜底：把内存里最新完整态对齐一次到 SQLite =====
      //   作用：覆盖 mockInterviewAgents 等路径直接改 rounds[]、没走 _appendRoundToActiveSession 的边角情况
      //   策略：每 10 次 flush 做一次"全量 rounds 对齐"（避免每轮都全量写 DB 造成 IO 放大）；
      //         其余 flush 只更新 session 主表的统计字段（轻量，1 条 UPDATE）
      try {
        if (_sessionRepo && _sessionRepo.ready) {
          const obj = this._activeSessionObj;
          const ac = answeredCount;   // 直接复用上面算好的值（已遍历 rds）
          const ec = errorCount;
          // 防抖计数：挂到 state 上，跨 flush 共享
          if (!this.state._sqliteFlushCounter) this.state._sqliteFlushCounter = 0;
          const counter = (this.state._sqliteFlushCounter = (this.state._sqliteFlushCounter + 1) % 10);
          const isFullSyncTick = (counter === 0);

          // （A）无论是否全量同步，都先 upsert 一下 session 主表统计（始终最新，DB roundCount 与 JSON 对齐）
          _sessionRepo.upsertSession({
            id: obj.id,
            accountId: _currentAccountIdForRepo(this),
            category: (norm.category === 'mock' ? 'mock' : (obj.category === 'mock' ? 'mock' : 'copilot')),
            title: obj.title || '',
            targetCompany:  obj.targetCompany || '',
            targetPosition: obj.targetPosition || '',
            interviewType:  obj.interviewType || '',
            status: obj.status === SESSION_STATUS_ENDED ? 'ended' : 'active',
            startedAt:  Number(obj.startedAt || 0),
            endedAt:    Number(obj.endedAt || 0),
            lastActiveAt: Number(obj.lastActiveAt || Date.now()),
            roundCount:    obj.stats.roundCount,
            questionCount: norm.questionCount || obj.stats.roundCount,
            answeredCount: ac,
            errorCount:    ec,
            durationMs:    obj.stats.totalDurationMs,
            jdSnapshot:    obj.jdSnapshot || '',
            resumeSnapshot:obj.resumeSnapshot || '',
            snippet:       norm.snippet || '',
          });

          // （B）每 10 次 flush 做一次完整 rounds 对齐（兜底：防止 DB rounds 少了某几行）
          if (isFullSyncTick) {
            _sessionRepo.upsertRoundsForSession(obj.id, rds);
          }
        }
      } catch (sqE) {
        console.warn(`[sqlite-sync][flush] ❌ session=${this._activeSessionObj.id} SQLite flush 双写失败（已跳过，JSON 仍是真源）：`, sqE && sqE.message);
      }
    } catch (e) {
      console.warn('[sessions] flush active session 异常（已兜底忽略）：', e && e.message);
    }
  }

  // ============================================================
  // 5.2.X Session 层 9：打开一场新面试 → 生成 session 文件 + 写摘要 + 挂到 state.activeSessionId + _activeSessionObj
  //   snapshotCfg：创建时拍的 { targetCompany, targetPosition, interviewType, jobDescription, resumeText } 快照（JD/简历后续修改不影响已发生面试的上下文）
  //   返回：新 session 对象
  // ============================================================
  _openNewSession(snapshotCfg) {
    const cfg = snapshotCfg || {};
    const now = Date.now();
    const session = {
      id: this._nextSessionId(),
      // ★ 面试类型：'copilot' = 真实面试（Copilot 模式 ASR 识别面试官+AI答题），'mock' = 模拟面试（用户在浮窗作答）
      //   判断依据：snapshotCfg._mockInterview 是否由模拟面试路由 _routeApiMockInterviewSession 注入
      category: (cfg && cfg._mockInterview) ? 'mock' : 'copilot',
      title: '',   // 下面 build 一次
      targetCompany: String(cfg.targetCompany || '').trim(),
      targetPosition: String(cfg.targetPosition || '').trim(),
      interviewType: String(cfg.interviewType || '').trim(),
      jdSnapshot: String(cfg.jobDescription || '').substring(0, 20000),
      resumeSnapshot: String(cfg.resumeText || cfg.resumeContent || '').substring(0, 40000),
      startedAt: now,
      endedAt: 0,
      status: SESSION_STATUS_ACTIVE,
      rounds: [],
      stats: { roundCount: 0, answeredCount: 0, errorCount: 0, totalDurationMs: 0 },
      lastActiveAt: now,
    };
    session.title = this._buildSessionTitle(session);
    this._activeSessionObj = session;
    this.state.activeSessionId = session.id;
    this._flushActiveSessionToDisk(`新开面试 session=${session.id}`);
    // ===== 【双写 SQLite 1/4】新建 session → 写入 ia_sessions 主表 =====
    //   JSON 主流程已经走完，这里单独 try/catch 包一层，SQLite 写失败不影响原功能
    try {
      if (_sessionRepo && _sessionRepo.ready) {
        const ok = _sessionRepo.upsertSession(Object.assign({}, session, {
          accountId: _currentAccountIdForRepo(this),
          // 给仓储层用的别名字段（字段名统一）
          roundCount: 0, questionCount: 0, answeredCount: 0, errorCount: 0, durationMs: 0,
          snippet: '',
        }));
        if (!ok) console.warn(`[sqlite-sync][openNew] ⚠️ session=${session.id} upsertSession 返回 false（可能 SQLITE_BUSY 或写入异常）`);
      }
    } catch (sqE) {
      console.warn(`[sqlite-sync][openNew] ❌ session=${session.id} SQLite 双写失败（已跳过，JSON 主流程正常）：`, sqE && sqE.message);
    }
    console.log(`[sessions] 🎬 新建面试 session=${session.id} | title=${session.title}`);
    return session;
  }

  // ============================================================
  // 5.2.X Session 层 10：结束当前场（写 endedAt + status=ended + 落盘）
  //   allowNull：true 表示「没有 active session 也不报错」
  // ============================================================
  _closeActiveSession(allowNull = true) {
    if (!this._activeSessionObj) {
      if (!allowNull) console.warn('[sessions] 结束当前场失败：没有 active session');
      return null;
    }
    if (this._activeSessionObj.status !== SESSION_STATUS_ENDED) {
      this._activeSessionObj.status = SESSION_STATUS_ENDED;
      this._activeSessionObj.endedAt = Date.now();
    }
    const sid = this._activeSessionObj.id;
    const title = this._activeSessionObj.title;
    const endedAtSnapshot = this._activeSessionObj.endedAt;
    this._flushActiveSessionToDisk(`结束面试 session=${sid}`);
    // ===== 【双写 SQLite 2/4】结束面试 → endSession(endedAt) 补写 ended_at/status =====
    //   同样：JSON 写完再做；失败只 warn 不 throw
    try {
      if (_sessionRepo && _sessionRepo.ready) {
        const ok = _sessionRepo.endSession(sid, endedAtSnapshot);
        // endSession 可能因"该 session 之前没双写进来"返回 false；这时走兜底：整条 session 再 upsert 一次（把 rounds 也全量对齐）
        if (!ok) {
          // 用 flush 后的完整 rounds 做一次性全量补齐（从刚刚结束的 _activeSessionObj 快照里拿）
          // 注意：_flushActiveSessionToDisk 已经写了完整 rounds[] 到内存对象，所以在设 null 之前再快照一份副本
        }
      }
    } catch (sqE) {
      console.warn(`[sqlite-sync][closeActive] ❌ session=${sid} SQLite 双写失败（已跳过，JSON 主流程正常）：`, sqE && sqE.message);
    }
    // 把结束前的完整 session 快照保留下来（_activeSessionObj 马上要置 null），
    // 若上面 endSession 没命中（如该 session 之前没进过 SQLite），再全量 upsert + rounds 补齐
    try {
      if (_sessionRepo && _sessionRepo.ready) {
        const snapshot = this._activeSessionObj;  // 还没置 null，内存态最新
        if (snapshot) {
          // 先尝试拿 DB 里有没有这条；没有就全量 upsert
          if (!_sessionRepo.exists(sid)) {
            const rds = Array.isArray(snapshot.rounds) ? snapshot.rounds : [];
            let ac = 0, ec = 0;
            for (const r of rds) {
              if (r.status === 'answered') ac++;
              else if (r.status === 'error') ec++;
            }
            _sessionRepo.upsertSession(Object.assign({}, snapshot, {
              accountId: _currentAccountIdForRepo(this),
              roundCount: rds.length, questionCount: rds.length,
              answeredCount: ac, errorCount: ec,
              durationMs: Math.max(0, (endedAtSnapshot || 0) - Number(snapshot.startedAt || 0)),
              snippet: (rds.length ? (String(rds[rds.length - 1].questionText || rds[rds.length - 1].answerText || '').slice(0, 500)) : ''),
            }));
            _sessionRepo.upsertRoundsForSession(sid, rds);
          } else {
            // 已存在：再把完整 rounds[] 对齐一次（兜底场景：中途 SQLite 连接有过中断）
            const rds = Array.isArray(snapshot.rounds) ? snapshot.rounds : [];
            _sessionRepo.upsertRoundsForSession(sid, rds);
          }
        }
      }
    } catch (sqE2) {
      console.warn(`[sqlite-sync][closeActive.full-sync] ❌ session=${sid} SQLite 全量补齐失败（已忽略，JSON 文件仍是真源）：`, sqE2 && sqE2.message);
    }
    this._activeSessionObj = null;
    this.state.activeSessionId = null;
    console.log(`[sessions] ⏹ 结束面试 session=${sid} | title=${title}`);
    return { id: sid, title };
  }

  // ============================================================
  // 5.2.X Session 层 11：确保存在 active session（没有就自动新开）
  //   调用时机：addHistoryRound 前置
  // ============================================================
  _ensureActiveSessionOrCreate() {
    if (this._activeSessionObj && this._activeSessionObj.status === SESSION_STATUS_ACTIVE) return this._activeSessionObj;
    // 读当前配置快照（如果拿不到就空，会被"未知公司/未知职位"兜底）
    let cfg = {};
    try { cfg = (typeof this.loadConfigFn === 'function') ? (this.loadConfigFn() || {}) : {}; } catch (_) { cfg = {}; }
    return this._openNewSession(cfg);
  }

  // ============================================================
  // 5.2.X Session 层 12：向 active session 追加/更新一轮
  //   round 对象里会自动加 sessionId 字段；rounds 超过内存上限仍保留全部（因为是面试完整记录）
  // ============================================================
  _appendRoundToActiveSession(round) {
    if (!round || !round.id) return;
    const s = this._ensureActiveSessionOrCreate();
    round.sessionId = s.id;
    const rounds = Array.isArray(s.rounds) ? s.rounds : (s.rounds = []);
    // 如果已存在同 id（answer 结算时复用旧 round），找到原地替换；否则 push 新的
    const idx = rounds.findIndex((x) => x && x.id === round.id);
    if (idx >= 0) rounds[idx] = round; else rounds.push(round);
    // 维护 roundId → sessionId 的 map（上限 2000 条，超出清旧）
    this._roundIdToSessionId.set(String(round.id), String(s.id));
    if (this._roundIdToSessionId.size > 2000) {
      let drop = this._roundIdToSessionId.size - 1500;
      for (const k of this._roundIdToSessionId.keys()) {
        if (drop-- <= 0) break;
        this._roundIdToSessionId.delete(k);
      }
    }
    // 每一轮改动立即落盘（保证断电安全）
    this._flushActiveSessionToDisk(`round=${round.id} ${round.status}`);
    // ===== 【双写 SQLite 3/4】新增/结算一轮 → upsertRound + 同步更新 session 主表统计 & snippet =====
    //   与 JSON 落盘同样是每轮都写；失败仅 warn。seq 从 rounds 数组长度推导（push 的 seq=len-1，原地替换取 idx）
    try {
      if (_sessionRepo && _sessionRepo.ready) {
        const seq = (idx >= 0) ? idx : (rounds.length - 1);
        // 1) 写 round 行
        _sessionRepo.upsertRound(Object.assign({}, round, { seq }));
        // 2) 刷新 session 主表的统计（roundCount/answeredCount/snippet/lastActiveAt）
        //    让 Web 端立即能看到最新数字（不用等 endSession 全量对齐）
        let ac = 0, ec = 0;
        for (const r of rounds) {
          if (r && r.status === 'answered') ac++;
          else if (r && r.status === 'error') ec++;
        }
        const lastR = rounds[rounds.length - 1];
        const snippet = (lastR ? String(lastR.questionText || lastR.answerText || '').slice(0, 500) : '');
        _sessionRepo.upsertSession({
          id: s.id,
          accountId: _currentAccountIdForRepo(this),
          category: (s.category === 'mock' ? 'mock' : 'copilot'),
          status: (s.status === 'ended' ? 'ended' : 'active'),
          title: s.title || '',
          targetCompany:  s.targetCompany || '',
          targetPosition: s.targetPosition || '',
          interviewType:  s.interviewType || '',
          startedAt:  Number(s.startedAt || 0),
          endedAt:    Number(s.endedAt || 0),
          lastActiveAt: Date.now(),
          roundCount:    rounds.length,
          questionCount: rounds.length,
          answeredCount: ac,
          errorCount:    ec,
          durationMs:    Math.max(0, (Number(s.endedAt||0) - Number(s.startedAt||0))),
          jdSnapshot:    s.jdSnapshot || '',
          resumeSnapshot:s.resumeSnapshot || '',
          snippet,
        });
      }
    } catch (sqE) {
      console.warn(`[sqlite-sync][appendRound] ❌ round=${round.id} session=${s.id} SQLite 双写失败（已跳过，JSON 主流程正常）：`, sqE && sqE.message);
    }
  }

  // ============================================================
  // 5.2.X Session 层 13：按 roundId 反向查 sessionId（侧栏点击 round 卡片 → 跳详情用）
  //   内存 map 命中直接返回；否则 fallback 懒扫最近 N 个 session 文件
  // ============================================================
  findSessionByRoundId(roundId) {
    if (!roundId) return null;
    const rid = String(roundId);
    const hit = this._roundIdToSessionId.get(rid);
    if (hit) return { sessionId: hit, roundId: rid };
    // fallback：扫索引里最近 20 场的详情，命中就返回并填 map
    const list = Array.isArray(this._sessionSummaryCache) ? this._sessionSummaryCache.slice(0, 20) : [];
    for (const s of list) {
      if (!s || !s.id) continue;
      try {
        const detailPath = path.join(this._sessionDir, `${s.id}.json`);
        if (!fs.existsSync(detailPath)) continue;
        const detail = JSON.parse(fs.readFileSync(detailPath, 'utf-8'));
        if (!detail || !Array.isArray(detail.rounds)) continue;
        const found = detail.rounds.some((r) => r && String(r.id) === rid);
        if (found) {
          this._roundIdToSessionId.set(rid, String(s.id));
          return { sessionId: s.id, roundId: rid };
        }
      } catch (_) { /* 坏文件跳过 */ }
    }
    return null;
  }

  // ============================================================
  // 5.2.X 对外：列出所有面试记录（列表页用）—— 返回摘要数组 + 总条数
  //   params: { keyword?, limit?, offset? }
  //   keyword 匹配：title/公司/职位；如果搜不到再 lazy 扫摘要对应 session 的 rounds 文本（questionText/answerText）
  // ============================================================
  /**
   * 查询面试记录列表（支持按面试类型互斥过滤）。
   * @param {Object}  opts
   * @param {string}  [opts.keyword=''] 搜索关键词（公司/职位/标题/问答文本 模糊匹配）
   * @param {number}  [opts.limit=50]   分页单页条数（1~200）
   * @param {number}  [opts.offset=0]   分页偏移（>=0）
   * @param {string}  [opts.category=''] 类型过滤：'copilot'=仅真实面试 / 'mock'=仅模拟面试 / 空字符串=全部
   * @returns {{ok:true, total:number, sessions:Object[], keyword:string, limit:number, offset:number, category:string}}
   */
  listSessions({ keyword = '', limit = 50, offset = 0, category = '' } = {}) {
    // 强制把索引文件最新状态合并到 cache（避免另一进程写入？本项目单进程，一般不用；但保险起见在 list 时再补一次最多 SESSION_LIST_MAX_IN_MEM 条）
    try {
      if (!fs.existsSync(this._sessionIndexPath)) { /* 空 */ }
      else {
        const raw = fs.readFileSync(this._sessionIndexPath, 'utf-8');
        const lines = raw.split('\n').filter((l) => l && l.trim().length > 0);
        const newest = [];
        for (let i = lines.length - 1; i >= 0 && newest.length < SESSION_LIST_MAX_IN_MEM; i--) {
          try { newest.push(JSON.parse(lines[i])); } catch (_) { /* ignore */ }
        }
        // 用最新的文件内容替换内存缓存（去重）
        const merged = new Map();
        for (const s of newest) if (s && s.id) merged.set(s.id, s);
        for (const s of this._sessionSummaryCache) if (s && s.id && !merged.has(s.id)) merged.set(s.id, s);
        this._sessionSummaryCache = Array.from(merged.values()).sort((a, b) => Number(b && b.lastActiveAt || 0) - Number(a && a.lastActiveAt || 0));
      }
    } catch (_) { /* ignore */ }
    let all = Array.isArray(this._sessionSummaryCache) ? this._sessionSummaryCache.slice() : [];
    const kw = String(keyword || '').trim();
    if (kw) {
      const kwLower = kw.toLowerCase();
      // 先按摘要字段过滤（公司/职位/标题/面试类型 + snippet + lastRounds 里的问答文本）
      let filtered = all.filter((s) => {
        const hay = [
          s && s.title, s && s.targetCompany, s && s.targetPosition, s && s.interviewType, s && s.snippet,
          ...(Array.isArray(s && s.lastRounds) ? s.lastRounds.flatMap((r) => [r && r.questionText, r && r.answerText]) : [])
        ].map((x) => String(x || '').toLowerCase());
        return hay.some((x) => x.indexOf(kwLower) >= 0);
      });
      // 如果没命中，lazy 扫每个 session 的 rounds 文本（最多扫最近 15 场，避免 I/O 过大）
      if (filtered.length === 0) {
        const scans = all.slice(0, 15);
        for (const s of scans) {
          if (!s || !s.id) continue;
          try {
            const detailPath = path.join(this._sessionDir, `${s.id}.json`);
            if (!fs.existsSync(detailPath)) continue;
            const detail = JSON.parse(fs.readFileSync(detailPath, 'utf-8'));
            if (!detail || !Array.isArray(detail.rounds)) continue;
            const hit = detail.rounds.some((r) => {
              return (String(r && r.questionText || '') + '\n' + String(r && r.answerText || '')).toLowerCase().indexOf(kwLower) >= 0;
            });
            if (hit) filtered.push(s);
          } catch (_) { /* ignore */ }
        }
      }
      all = filtered;
    }
    // ★ 分类互斥过滤：copilot 只看真实面试；mock 只看模拟面试；空=全部
    const cat = String(category || '').trim().toLowerCase();
    if (cat === 'copilot' || cat === 'mock') {
      all = all.filter((row) => this._inferSessionCategory(row) === cat);
    }
    // ★ 关键：返回前统一对每条摘要做"UI 字段归一化"（旧 JSONL 里只有 roundCount/answeredCount 没有 roundsCount/questionCount/snippet/lastRounds 的，懒扫详情补全）。
    //   限制懒扫最多 30 场：用户传 limit 200 时，只对分页范围内 + 最多前 30 扫详情。
    const total = all.length;
    const lim = Math.max(1, Math.min(200, Number(limit) || 50));
    const off = Math.max(0, Number(offset) || 0);
    const page = all.slice(off, off + lim);
    const sessions = page.map((row) => {
      // 已有 rounds 或已归一化（snippet+lastRounds+roundsCount+questionCount 全有）→ 直接归一化不改内容
      // 否则：若摘要缺 snippet 或缺 roundsCount → 懒读详情再归一，拿到精确的 rounds / questionCount / lastRounds
      let needLazyRead = false;
      const hasRounds = Array.isArray(row.rounds) && row.rounds.length;
      const hasSnippet = !!(typeof row.snippet === 'string' && row.snippet.trim());
      const hasLastRounds = !!(Array.isArray(row.lastRounds) && row.lastRounds.length);
      const hasRoundAlias = typeof row.roundsCount === 'number' || typeof row.questionCount === 'number';
      if (!hasRounds && (!hasSnippet || !hasLastRounds || !hasRoundAlias)) {
        needLazyRead = true;
      }
      if (needLazyRead && row && row.id) {
        const detailPath = path.join(this._sessionDir, `${String(row.id)}.json`);
        try {
          if (fs.existsSync(detailPath)) {
            const detail = JSON.parse(fs.readFileSync(detailPath, 'utf-8'));
            // 详情（有 rounds）归一化结果精度最高；和 summary 的已有字段合并（保留 upsert 过的 roundCount 等）
            return this._normalizeSessionSummaryForUI(Object.assign({}, row, detail || {}));
          }
        } catch (_) { /* 读失败兜底：就用原 row 做归一化（不会 crash） */ }
      }
      return this._normalizeSessionSummaryForUI(row);
    });
    return { ok: true, total, offset: off, limit: lim, sessions, keyword: kw };
  }

  // ============================================================
  // 5.2.X 对外：读取一场面试的完整详情（含 rounds）—— 详情页用
  // ============================================================
  getSessionDetail(id) {
    if (!id) return { ok: false, error: 'empty_id', msg: 'session id 不能为空' };
    // 优先：如果是当前 active，直接返回内存对象（最新，不需要读盘）
    if (this._activeSessionObj && String(this._activeSessionObj.id) === String(id)) {
      return { ok: true, session: this._activeSessionObj, from: 'memory' };
    }
    try {
      const detailPath = path.join(this._sessionDir, `${String(id)}.json`);
      if (!fs.existsSync(detailPath)) return { ok: false, error: 'not_found', msg: '找不到该面试记录（可能已被删除或不存在）' };
      const session = JSON.parse(fs.readFileSync(detailPath, 'utf-8'));
      // 防御：坏文件里没有 rounds 字段
      if (!session) return { ok: false, error: 'invalid', msg: '面试记录文件损坏' };
      if (!Array.isArray(session.rounds)) session.rounds = [];
      // 顺便把 rounds 填入反向 map（侧栏点击定位）
      for (const r of session.rounds) {
        if (r && r.id) this._roundIdToSessionId.set(String(r.id), String(session.id));
      }
      return { ok: true, session, from: 'disk' };
    } catch (e) {
      return { ok: false, error: 'read_fail', msg: '读取面试记录失败：' + (e && e.message || '') };
    }
  }

  // ============================================================
  // 5.2.X 对外：手动开始新的一场面试（主窗口底部按钮触发）
  //   流程：先结束当前 active → 读当前 targetCompany/Position/JD/简历 快照 → 新开
  //   可选 forceConfig：显式传入 {targetCompany,targetPosition,interviewType} 覆盖 loadConfig（用于切公司/职位时外部已判定变了）
  // ============================================================
  startNewSession(forceConfig) {
    this._closeActiveSession(true);
    let cfg = forceConfig || null;
    if (!cfg) {
      try { cfg = (typeof this.loadConfigFn === 'function') ? (this.loadConfigFn() || {}) : {}; } catch (_) { cfg = {}; }
    }
    const s = this._openNewSession(cfg || {});
    // ✅ 开启新一场后，清除"上一场显式结束"的标记（避免后续每一次 open-overlay 都被迫开新场）
    try {
      if (this.state && Object.prototype.hasOwnProperty.call(this.state, '_lastEndedSessionId')) {
        this.state._lastEndedSessionId = null;
      }
      if (this.state && Object.prototype.hasOwnProperty.call(this.state, '_lastEndedSessionMarker')) {
        this.state._lastEndedSessionMarker = 0;
      }
    } catch (_) { /* ignore */ }
    console.log(`[sessions] 🆕 startNewSession 完成：session=${s.id} | title=${s.title}`);
    return { ok: true, session: { id: s.id, title: s.title, startedAt: s.startedAt, status: s.status } };
  }

  // ============================================================
  // 5.2.X 对外：如果上一场刚被"用户显式结束（点浮动面板×/结束按钮）" → 强制开新场；否则什么都不做。
  //   调用时机：① 开始面试辅助（copilotStartBtn 点击）② 独立浮层 open-overlay IPC ③ 重新打开答题面板 reopen 按钮
  //   设计目的：用户点 × 明确表示"结束本场"，之后任何再次"打开浮层/开始面试"的行为都必须落到【新场】，
  //             不能再把面试官新的问题写入已 ended 的旧 session，也不能让用户"继续/恢复刚刚结束的那一场"。
  //   清标记时机：startNewSession 成功后或 ensure 成功新建后，会清掉 _lastEndedSessionId。
  // ============================================================
  ensureStartNewSessionIfJustEnded(forceConfig) {
    try {
      // 1) 如果当前有 active session → 说明已经在新的一场中了，不处理直接 return
      if (this._activeSessionObj && this._activeSessionObj.status === SESSION_STATUS_ACTIVE) {
        return { ok: true, openedNew: false, session: { id: this._activeSessionObj.id, title: this._activeSessionObj.title, startedAt: this._activeSessionObj.startedAt, status: this._activeSessionObj.status } };
      }
      // 2) 如果没有"上一场显式结束"的标记 → 按正常的"懒创建"逻辑（_ensureActiveSessionOrCreate 会在 addHistoryRound 需要时再建）不提前建
      const justEndedId = this.state ? String(this.state._lastEndedSessionId || '').trim() : '';
      if (!justEndedId) {
        return { ok: true, openedNew: false, session: null, reason: 'no_last_ended_marker' };
      }
      // 3) 存在"上一场刚显式结束"标记 → 强制开新场（把 justEndedId 的语义作为切场边界）
      const r = this.startNewSession(forceConfig || undefined);
      return { ok: true, openedNew: true, session: r.session, closedPreviousId: justEndedId };
    } catch (e) {
      console.error('[sessions][ensureStartNewSessionIfJustEnded] 异常：', e && e.message);
      return { ok: false, openedNew: false, error: 'internal', msg: e && e.message ? e.message : 'ensure 失败' };
    }
  }

  // ============================================================
  // 5.2.X 对外：手动结束当前场（主窗口底部 ⏹ 按钮触发；app quit 兜底；浮动面板×）
  //   语义升级：结束 = 用户明确表达"本场到此为止"，
  //            写入 state._lastEndedSessionId 标记，供 ensureStartNewSessionIfJustEnded 判断后续是否切新场。
  // ============================================================
  endActiveSession() {
    const beforeId = this._activeSessionObj ? String(this._activeSessionObj.id) : '';
    const r = this._closeActiveSession(true);
    // 只要用户显式调 endActiveSession（即使 no_active_session 也不报错），
    // 都把"上一场结束"的标记记下来：ended sessionId 优先取本次 r.id，没有则用 state.activeSessionId（历史），再没有用 beforeId
    let endedId = (r && r.id) ? String(r.id) : '';
    if (!endedId && this.state && this.state.activeSessionId) endedId = String(this.state.activeSessionId);
    if (!endedId && beforeId) endedId = String(beforeId);
    try {
      if (!this.state) this.state = {};
      this.state._lastEndedSessionId = endedId || '__none__';
      this.state._lastEndedSessionMarker = Date.now();
    } catch (_) { /* ignore */ }
    // 明确日志：方便用户（和我们）观察"点×是否真的调用了结束本场"
    const sidForLog = (r && r.id) ? String(r.id) : (endedId || '—');
    const titleForLog = (r && r.title) ? String(r.title) : '—';
    if (r) {
      console.log(`[sessions][endActiveSession] ✅ 显式结束本场成功：session=${sidForLog} | title=${titleForLog} | _lastEndedSessionId=${String(this.state._lastEndedSessionId || '')}`);
    } else {
      console.log(`[sessions][endActiveSession] ⚠️ 没有活跃 session，但已标记结束边界：_lastEndedSessionId=${String(this.state._lastEndedSessionId || '')}`);
    }
    return { ok: true, ended: !!r, session: r || null };
  }

  // ============================================================
  // 5.2.X 对外：判断「传入的 {targetCompany,targetPosition} 与当前 active session 是否是同一场」
  //   —— 用于渲染层 input blur 后决定是否自动切新场
  // ============================================================
  isSameSessionTarget(next) {
    if (!this._activeSessionObj) return true; // 没有 active，谈不上"切换"
    return _sessionsSameTarget(
      { targetCompany: this._activeSessionObj.targetCompany, targetPosition: this._activeSessionObj.targetPosition },
      next || {},
    );
  }

  // ============================================================
  // 5.3 对话历史：新增"一轮提问"（还没答案，status=asked）
  //   返回：新创建的轮次 id
  //   调用场景：_autoSolveScreenshotAndSync 里写入面试官问题时、/api/answer/ask 开始处理时、
  //             以及 recordState 里如果检测到外部 bus 直接写入 questionImage 且没有活跃轮时兜底创建一轮
  // ============================================================
  addHistoryRound({ questionText, questionImage, source }) {
    const round = {
      id: this._nextHistoryId(),
      createdAt: Date.now(),
      status: HISTORY_STATUS_ASKED,
      source: String(source || 'unknown'),
      questionText: String(questionText || ''),
      questionImage: String(questionImage || ''),
      answerText: '',
      answeredAt: 0,
      errorMsg: '',
    };
    // ★Session 联动：写一轮之前确保存在 active session；并把 round 立即追加到 session 详情
    try { this._appendRoundToActiveSession(round); } catch (se) { console.warn('[sessions] append round 异常（已兜底忽略）：', se.message); }
    this.state.history.push(round);
    this.state.historyVersion = (this.state.historyVersion || 0) + 1;
    // 记录活跃轮 id：后续 recordState({ answerText }) 会优先把答案填到这一轮
    this._activeHistoryId = round.id;
    // 超过上限 → 把最旧的归档落盘（仍继续保留在 session 详情里，不影响完整面试回看）
    this._evictHistoryIfOverflow();
    return round.id;
  }

  // ============================================================
  // 5.4 对话历史：给"某一轮"填充 AI 答案（或错误信息）
  //   - roundId 不传时：优先填"最近一次活跃轮"，若活跃轮已 answered 则填 history 最后一条 asked
  //   - 如果 history 为空或找不到匹配的 asked 轮：兜底新建一轮（避免 answer 丢失）
  // ============================================================
  finishHistoryRound({ answerText, errorMsg, roundId } = {}) {
    let target = null;
    // 1) 显式传了 roundId → 按 id 精确查找
    if (roundId) {
      target = this.state.history.find((r) => r.id === roundId);
    }
    // 2) 没传 roundId → 优先用 _activeHistoryId 找"最近的待回答轮"
    if (!target && this._activeHistoryId) {
      const active = this.state.history.find((r) => r.id === this._activeHistoryId);
      if (active && active.status === HISTORY_STATUS_ASKED) target = active;
    }
    // 3) 仍没找到 → 取 history 末尾第一条 status=asked 的
    if (!target) {
      for (let i = this.state.history.length - 1; i >= 0; i--) {
        if (this.state.history[i].status === HISTORY_STATUS_ASKED) {
          target = this.state.history[i];
          break;
        }
      }
    }
    // 4) 兜底：找不到任何 asked 轮且确实有新 answer 内容 → 新建一轮填进去（至少保证 answer 不丢失）
    const hasAnswer = !!(answerText && String(answerText).trim());
    if (!target && hasAnswer) {
      this.addHistoryRound({ questionText: '', questionImage: this.state.questionImage || '', source: 'fallback' });
      target = this.state.history[this.state.history.length - 1];
    }
    if (target) {
      target.answerText = String(answerText || '');
      target.answeredAt = Date.now();
      if (errorMsg) target.errorMsg = String(errorMsg);
      // 有答案 → answered；没答案且有错误 → error；否则保持 asked（极端情况）
      if (hasAnswer) target.status = HISTORY_STATUS_ANSWERED;
      else if (errorMsg) target.status = HISTORY_STATUS_ERROR;
      this.state.historyVersion = (this.state.historyVersion || 0) + 1;
      // 此轮已完结，清理 active 标记
      if (this._activeHistoryId === target.id) this._activeHistoryId = null;
      // ★Session 联动：把结算后的 round 写回 active session（同 id 替换；详情页能看到完整的答案/错误）
      try {
        // 如果 target 已有 sessionId，对应 session 不一定在内存（极端情况：手动切换了 activeSessionObj 但还在同轮结算）；
        // 简单起见：如果当前 _activeSessionObj 存在且 target.sessionId === _activeSessionObj.id 或者 target 没有 sessionId，
        // 就当作"当前 active 的 round"处理；否则不刷，避免把已结束 session 覆盖成新内容
        const shouldAppendToActive = this._activeSessionObj
          && (!target.sessionId || String(target.sessionId) === String(this._activeSessionObj.id));
        if (shouldAppendToActive) this._appendRoundToActiveSession(target);
      } catch (se) { console.warn('[sessions] finish round → session 同步异常（已兜底忽略）：', se.message); }
      // 防御性：溢出再归档一次（正常不会触发，除非 addHistoryRound 没被走到但新增了）
      this._evictHistoryIfOverflow();
    }
  }

  // ============================================================
  // 5. 外部（main.js 的 ASR 回调）调用：合并最新态快照
  // partial = { asrText, answerText, questionImage, isRecording, interimText,
  //             _historyAction?: 'question'|'answer'|null, _historyMeta?: {source} } 任意字段
  //   _historyAction：当调用方（_autoSolveScreenshotAndSync / _routeApiAnswerAsk）明确想触发
  //     "一轮对话历史变更"时传入；否则 recordState 仅处理单值快照，不改动 history。
  // ============================================================
  recordState(partial) {
    if (!partial) return;
    if ('asrText' in partial) this.state.asrText = String(partial.asrText || '');
    if ('questionImage' in partial) this.state.questionImage = String(partial.questionImage || '');
    if ('answerText' in partial) {
      this.state.answerText = String(partial.answerText || '');
      if (partial.answerText) this.state.lastAnswerAt = Date.now();
      // 显式传了 _historyAction='answer' → 把这段 answer 结算到历史
      if (partial._historyAction === 'answer') {
        this.finishHistoryRound({
          answerText: partial.answerText,
          errorMsg: partial._historyError || '',
          roundId: partial._historyRoundId || null,
        });
      }
    }
    if ('isRecording' in partial) this.state.isRecording = !!partial.isRecording;
    // 显式传了 _historyAction='question' → 新增一轮对话历史（通常由 _autoSolveScreenshotAndSync 触发）
    if (partial._historyAction === 'question') {
      const qText = ('interimText' in partial) ? String(partial.interimText || '') : (this.state.asrText || '');
      const qImg = ('questionImage' in partial) ? String(partial.questionImage || '') : (this.state.questionImage || '');
      const meta = (partial._historyMeta && typeof partial._historyMeta === 'object') ? partial._historyMeta : {};
      this.addHistoryRound({
        questionText: qText,
        questionImage: qImg,
        source: meta.source || 'local',
      });
    }
  }

  // ============================================================
  // 6. 枚举本机 IPv4（非 internal，去重，按优先级排序）
  // 参数 quiet=false（默认）打印详细网卡明细；quiet=true 不打印明细，避免 IP 监控 tick 时反复刷屏
  // ============================================================
  _enumLocalIps(quiet = false) {
    const result = [];
    const seen = new Set();
    try {
      const ifaces = os.networkInterfaces();
      // 只在启动或网络变更时打印分隔条 + 明细；IP 监控 tick（quiet=true）不刷
      if (!quiet) {
        console.log('====================================================================');
        console.log('[H5-DEBUG] ===== IP 枚举明细（按网卡逐一枚举）=====');
      }
      Object.keys(ifaces || {}).forEach((name) => {
        const list = ifaces[name] || [];
        list.forEach((iface) => {
          // 详细打印每个网卡，让用户判断是不是 WiFi 网卡/是不是虚拟网卡
          const isIpv4 = iface && iface.family === 'IPv4';
          const isInternal = iface && !!iface.internal;
          const addr = iface && iface.address;
          // ⚠️ 关键改动：把网卡名 name 作为第二参数传进去，结合网卡名 + IP 段综合算优先级
          const prio = _ipPriorityClass(addr || '', name);
          if (!quiet) {
            console.log(`[H5-DEBUG]   网卡【${name}】 family=${iface?.family || '-'} internal=${isInternal} addr=${addr || '-'} 优先级(prio=${prio})`);
          }
          // 仅取 IPv4 + 非内部（排除 127.0.0.1）
          if (!isIpv4 || isInternal) return;
          if (!addr || seen.has(addr)) return;
          seen.add(addr);
          result.push({ addr, prio });
        });
      });
      // 按优先级升序（数字越小越优先）
      result.sort((a, b) => a.prio - b.prio);
      const finalList = result.map((x) => x.addr);
      if (!quiet) {
        console.log(`[H5-DEBUG] ===== 最终可用 IPv4（按优先级排序）：${finalList.join(', ') || '（空）'} =====`);
        console.log(`[H5-DEBUG] ===== 首选 IP（二维码用）：${finalList[0] || '（无，将抛 NO_IP）'} =====`);
        console.log('====================================================================');
      }
      return finalList;
    } catch (e) {
      console.error('[localHttpServer] _enumLocalIps 异常:', e.message);
      return [];
    }
  }

  // ============================================================
  // 7. 端口探测：从 start→end 依次 try listen，成功→立刻关临时 server，只把端口号 resolve 返回
  // 为什么不直接把监听好的 srv 赋给 this.server？
  //   因为 start() 后面会 this.server = http.createServer(handler) 重新创建带业务 handler 的正式 server，
  //   如果这里赋 this.server 会被覆盖 → 临时 server 仍在监听端口但无任何 request 处理器 → 请求进来永远 pending，浏览器一直转圈（就是用户遇到的现象）。
  //   正确做法：这里只"探测"可用性，用临时 server bind 后立刻 close，同一 tick 内不会被抢，外面的正式 server 再 listen 一次。
  // ============================================================
  _bindPortRange(start, end) {
    return new Promise((resolve) => {
      let port = start;
      console.log(`[H5-DEBUG] ===== 端口探测开始：${start}-${end}，绑定地址 BIND_ADDR=${BIND_ADDR} =====`);
      const tryNext = () => {
        if (port > end) {
          console.log(`[H5-DEBUG] ===== 端口探测失败：${start}-${end} 全部不可用（ALL_PORTS_BUSY） =====`);
          resolve(null);
          return;
        }
        const srv = http.createServer();
        srv.once('error', (err) => {
          // EADDRINUSE / EACCES 都视为端口不可用，试下一个
          try { srv.close(); } catch (_) { /* 忽略 */ }
          console.log(`[localHttpServer] 端口 ${port} 不可用：${err.code}，尝试下一个`);
          port += 1;
          tryNext();
        });
        srv.listen(port, BIND_ADDR, () => {
          // ✅ 关键修复：探测成功立刻关临时 server（释放端口），不赋值 this.server，避免后续被覆盖
          try { srv.close(); } catch (_) { /* 忽略 */ }
          console.log(`[localHttpServer] 端口 ${port} 空闲可用（bind=${BIND_ADDR}）→ 由正式 server 接管监听`);
          resolve(port);
        });
      };
      tryNext();
    });
  }

  // ============================================================
  // 8. WS 3s 认证超时 → close(4401)
  // ============================================================
  _sendWsAuthTimeout(ws) {
    const t = setTimeout(() => {
      try {
        if (!ws.authenticated) ws.close(4401, 'invalid token or auth timeout');
      } catch (_) { /* 忽略 */ }
    }, AUTH_TIMEOUT_MS);
    this._authTimers.set(ws, t);
  }
  _clearWsAuthTimeout(ws) {
    try {
      const t = this._authTimers.get(ws);
      if (t) { clearTimeout(t); this._authTimers.delete(ws); }
    } catch (_) { /* 忽略 */ }
  }

  // ============================================================
  // 9. 向当前已认证的小程序 WS 广播推送（readyState=1 才发）
  // ============================================================
  _broadcast(type, payload, extraFields = {}) {
    if (!this.minSocket) return false;
    try {
      if (this.minSocket.readyState !== 1) return false; // OPEN=1
      const msg = Object.assign({ type, ts: Date.now() }, extraFields);
      if (payload !== undefined) msg.payload = payload;
      this.minSocket.send(JSON.stringify(msg));
      return true;
    } catch (e) {
      console.warn('[localHttpServer] _broadcast 发送失败:', e.message);
      return false;
    }
  }

  // ============================================================
  // 10. 回复小程序请求（带同一 id 配对 request-response）
  // ============================================================
  _reply(ws, incomingMsg, responseType, responsePayload) {
    try {
      if (!ws || ws.readyState !== 1) return;
      const out = { type: responseType, ts: Date.now(), payload: responsePayload };
      if (incomingMsg && incomingMsg.id) out.id = String(incomingMsg.id);
      ws.send(JSON.stringify(out));
    } catch (e) {
      console.warn('[localHttpServer] _reply 发送失败:', e.message);
    }
  }

  // ============================================================
  // 11. 设置 status + 记录 lastStatusAt + 通知外部（app.bus emit local:status-changed）
  // ============================================================
  _setStatus(newStatus) {
    const changed = this.status !== newStatus;
    this.status = newStatus;
    this.lastStatusAt = Date.now();
    if (changed && this.bus) {
      try {
        this.bus.emit('local:status-changed', this.getStatus());
      } catch (e) {
        console.warn('[localHttpServer] bus.emit(local:status-changed) 失败:', e.message);
      }
    }
  }

  // ============================================================
  // 11.5 H5 移动端纯 HTTP 活跃状态管理（无 WebSocket 场景）
  // 目标：H5 只要有任何合法 token 请求（调 /api/*），服务端就进入 connected 态
  //       30s 内无请求 → 自动回 listening 态（不打断已连的小程序 socket）
  //       H5 手动点断开 → 立即回 listening（且清活跃时间戳）
  // ============================================================
  /**
   * H5 端每发一次合法 token 请求都调用本方法（在 /api 路由 token 校验通过后立即调用）
   * 作用：更新活跃时间 → 若当前未进入 connected → 升级到 connected → 重置 30s idle 定时器
   */
  _touchH5Active() {
    const now = Date.now();
    this.h5LastActiveAt = now;
    // 如果不是 active，就变 active，并可能升级 status 到 connected
    if (!this.h5Active) {
      this.h5Active = true;
      console.log(`[localHttpServer] H5 进入已连接态（首次活跃）`);
      // status 升级条件：没有已连接的小程序 socket 时，把 listening 升级为 connected
      // 如果此时 status 已经是 connected（小程序已连）→ 保持不动，不重复发事件
      const hasMinSocket = !!(this.minSocket && this.minSocket.readyState === 1);
      if (!hasMinSocket && (this.status === 'listening' || this.status === 'disconnected')) {
        this._setStatus('connected');
      }
    }
    // 每次活跃都重置 idle 定时器：30s 内无任何 token 请求 → 自动降级为 listening
    if (this._h5IdleTimer) { try { clearTimeout(this._h5IdleTimer); } catch (_) { /* 忽略 */ } }
    this._h5IdleTimer = setTimeout(() => this._checkDowngradeH5IfIdle(), this._H5_IDLE_TIMEOUT_MS);
  }

  /**
   * 30s idle 超时回调：如果 H5 超时无请求 + 没有小程序 socket，就把 status 降回 listening
   * （不影响小程序模式：如果有 minSocket，就算 H5 超时了，status 还是 connected）
   */
  _checkDowngradeH5IfIdle() {
    try {
      this._h5IdleTimer = null;
      const now = Date.now();
      const hasMinSocket = !!(this.minSocket && this.minSocket.readyState === 1);
      const idleTooLong = now - this.h5LastActiveAt >= this._H5_IDLE_TIMEOUT_MS;
      // 如果 H5 还在 active 标记，但超过了 timeout 且没有小程序 socket → 降级
      if (this.h5Active && idleTooLong && !hasMinSocket) {
        this.h5Active = false;
        console.log(`[localHttpServer] H5 ${Math.floor(this._H5_IDLE_TIMEOUT_MS / 1000)}s 无请求 → 回到等待连接状态`);
        if (this.status === 'connected') this._setStatus('listening');
      }
    } catch (e) {
      console.warn('[localHttpServer] _checkDowngradeH5IfIdle 异常:', e.message);
    }
  }

  /**
   * H5 手动点"断开连接"按钮时调用（走 /api/disconnect 路由）
   * 立即清 active + 回 listening（不打断已连的小程序 socket）
   */
  _h5ManualDisconnect() {
    try {
      if (this._h5IdleTimer) { try { clearTimeout(this._h5IdleTimer); } catch (_) { /* 忽略 */ } }
      this._h5IdleTimer = null;
      if (this.h5Active) {
        this.h5Active = false;
        this.h5LastActiveAt = 0;
        console.log(`[localHttpServer] H5 手动断开连接`);
        const hasMinSocket = !!(this.minSocket && this.minSocket.readyState === 1);
        // 没小程序 socket 时 → 把 connected 降回 listening
        if (!hasMinSocket && this.status === 'connected') this._setStatus('listening');
      }
    } catch (e) {
      console.warn('[localHttpServer] _h5ManualDisconnect 异常:', e.message);
    }
  }

  // ============================================================
  // 12. 心跳 tick（10s 一次）：超过 60s 无 ping → 主动 close(4408)
  // 兼容：如果此时 H5 还活跃，仅清 minSocket，status 保持 connected（由 H5 兜底保活）
  // ============================================================
  _heartbeatTick() {
    if (!this.minSocket) return;
    try {
      const now = Date.now();
      if (now - this.lastPingAt > HEARTBEAT_IDLE_MAX_MS) {
        console.log('[localHttpServer] 小程序 60s 无心跳，主动断开 (4408)');
        try { this.minSocket.close(4408, 'idle timeout (60s no ping)'); } catch (_) { /* 忽略 */ }
        this.minSocket = null;
        // 状态决策：H5 活跃 → 保持 connected；否则才变 disconnected
        if (this.h5Active) {
          this._setStatus('connected');
        } else {
          this._setStatus('disconnected');
        }
      }
    } catch (e) {
      console.warn('[localHttpServer] _heartbeatTick 异常:', e.message);
    }
  }

  // ============================================================
  // 13. IP 监控 tick（5s 一次）：换 WiFi 后 IP 列表变化 → network-changed
  // （overlay 收到后会提示用户重新扫码）
  // 优化：正常监控 tick 用 quiet=true 不打印明细，避免终端刷屏；只有检测到 IP 变化时才完整打印 + 通知外部
  // ============================================================
  _ipMonitorTick() {
    try {
      // quiet=true：不打印明细，仅算签名（每 5s 跑一次不刷屏）
      const fresh = this._enumLocalIps(true);
      const sig = fresh.join('|');
      if (this._lastIpsSignature && sig !== this._lastIpsSignature) {
        // ⚠️ 网络真的变了（换 WiFi / 插拔网线 / 虚拟网卡增减）→ 重新 quiet=false 枚举并打印完整明细，让用户看到新 IP
        console.log('====================================================================');
        console.log('[localHttpServer] ⚠️ 检测到网络/IP 变化，重新枚举详细网卡：');
        console.log('[localHttpServer]   原签名=', this._lastIpsSignature);
        console.log('[localHttpServer]   新签名=', sig);
        const withLogs = this._enumLocalIps(false); // 打印完整明细
        this.ips = withLogs;
        this.primaryIp = withLogs[0] || null;
        // 重新生成 token（旧二维码失效，安全 + 干净）
        this.token = 'IA-' + crypto.randomBytes(8).toString('hex').slice(0, 16);
        // 踢掉当前连接（IP 变了小程序也连不上了）
        if (this.minSocket) {
          try { this.minSocket.close(4001, 'network changed, new token'); } catch (_) { /* 忽略 */ }
          this.minSocket = null;
        }
        this._setStatus('disconnected');
        // bus 通知 overlay：需要重绘二维码 + 提示用户重新扫码
        if (this.bus) {
          try { this.bus.emit('local:network-changed', this.getStatus()); } catch (_) { /* 忽略 */ }
        }
        console.log('====================================================================');
        this._lastIpsSignature = withLogs.join('|');
        return;
      }
      this._lastIpsSignature = sig;
    } catch (e) {
      console.warn('[localHttpServer] _ipMonitorTick 异常:', e.message);
    }
  }

  // ============================================================
  // 14. 订阅 app.bus：ASR / 答案 / 状态 → WS 推送给小程序
  //     asr:interim 200ms 节流；其他事件立即推送
  // ============================================================
  _attachBus() {
    if (!this.bus) return;
    if (this._busHandlers) return; // 避免重复订阅

    const h = {};
    // ---- asr:interim（200ms 节流）----
    h['asr:interim'] = (text) => {
      this.recordState({ asrText: text });
      this._asrInterimThrottled(text);
    };
    // ---- asr:final（立即推送 + 覆盖 state.asrText）----
    // ★ 用户要求：面试官对话框和 history 卡片需要显示系统声音识别出的"全部文字"，
    //   不能只显示被判定为"问题"的那一句。所以这里：只要有 ASR final 结果，
    //   就把它追加到 history 当前（或新建）一轮的 questionText 区，
    //   让用户实时看到"面试官都说了什么"，而不需要等 detectQuestion 判为 true 才写入。
    h['asr:final'] = (text) => {
      const finalText = String(text || '').trim();
      // [调试日志] 让主进程终端一眼能确认 bus 事件被 localHttpServer 收到
      console.log(`[localHttpServer][bus] ⬇ asr:final 收到: len=${(finalText||'').length} text="${(finalText||'').substring(0,80)}"`);
      // 1) 先写 state.asrText（老字段，保持兼容）
      this.recordState({ asrText: finalText });
      // 2) 把这句识别结果追加进 history 面试官区（所有句子都写，不论 detectQuestion 结果）
      if (finalText && Array.isArray(this.state.history)) {
        // 策略：找到"最后一条 status=asked 且还没生成 answer"的轮 → 追加文本
        //       如果找不到就新建一轮（source 默认 asr-panel，后续 detectQuestion 触发 AI 会继续用这轮）
        let targetRound = null;
        for (let i = this.state.history.length - 1; i >= 0; i--) {
          const r = this.state.history[i];
          if (r && r.status === HISTORY_STATUS_ASKED) { targetRound = r; break; }
        }
        if (!targetRound) {
          // 新建一轮：当前还没有待回答轮，就以"ASR 说话记录"的身份建一轮
          const newId = this.addHistoryRound({
            questionText: finalText,
            questionImage: this.state.questionImage || '',
            source: 'asr-panel',
          });
          targetRound = this.state.history.find((r) => r.id === newId);
          console.log(`[localHttpServer][history] ✨ 新建本轮（asr:final → 尚无待答轮）id=${newId} | 当前historyCount=${this.state.history.length} | historyVersion=${this.state.historyVersion}`);
        } else {
          // 已经有 asked 轮 → 换行追加
          const prev = (targetRound.questionText || '').trim();
          targetRound.questionText = prev ? (prev + '\n\n' + finalText) : finalText;
          // 手动 bump historyVersion：因为是直接改对象属性，recordState 的版本自增没触发
          this.state.historyVersion = (this.state.historyVersion || 0) + 1;
          console.log(`[localHttpServer][history] ➕ 追加到待答轮 id=${targetRound.id} | 面试官原文累计 ${(targetRound.questionText||'').length} 字 | historyVersion=${this.state.historyVersion}`);
        }
        // 把新写的轮标记为 active：后续如果 detectQuestion 触发 AI → answer 会写到这轮
        if (targetRound) this._activeHistoryId = targetRound.id;
      } else if (finalText) {
        // 防御：如果 state.history 尚未初始化（极早期），给个明确 warn，方便排查
        console.warn('[localHttpServer][bus] ⚠ asr:final 收到但 state.history 不是数组 → 暂不写面试官原文，请检查 start() 是否正常完成。');
      }
      // 3) WS 推给小程序 / H5 端（保持原来行为）
      this._broadcast('asr:final', { text: finalText });
    };
    // ---- asr:question-asked（ASR 检测到问题并即将调用 AI）—— 显式创建"待回答提问轮"
    //   payload = { question: string, source?: string }
    //   目的：保证在 AI 开始前 history 就有 status=asked 的提问轮，UI 上能立刻显示 ⏳ 正在生成
    h['asr:question-asked'] = (payload) => {
      const obj = (payload && typeof payload === 'object') ? payload : { question: String(payload || '') };
      const question = String(obj.question || '').trim();
      const source = String(obj.source || 'asr-panel');
      console.log(`[localHttpServer][bus] ⬇ asr:question-asked 收到: source=${source} question="${(question||'').substring(0,80)}"`);
      if (!question) return;
      if (!Array.isArray(this.state.history)) return;
      // 如果最后已经是 asked 轮，且 questionText 里已经包含这句文本 → 复用它（避免重复创建）
      const last = this.state.history[this.state.history.length - 1];
      const reuseLast = !!(last && last.status === HISTORY_STATUS_ASKED);
      if (reuseLast) {
        // 把新文本追加到最后一轮的 questionText（如果还不存在），确保 AI 原文问题可见
        const prev = String(last.questionText || '').trim();
        if (!prev || prev.indexOf(question) < 0) {
          last.questionText = prev ? (prev + '\n\n' + question) : question;
        }
        // 纠正 source（如果之前是 fallback/unknown）
        if (!last.source || last.source === 'unknown' || last.source === 'fallback') {
          last.source = source;
        }
        this._activeHistoryId = last.id;
        this.state.historyVersion = (this.state.historyVersion || 0) + 1;
        console.log(`[localHttpServer][history] ♻️  复用最后一轮 id=${last.id} 追加提问 | historyVersion=${this.state.historyVersion}`);
      } else {
        // 正常创建新的提问轮
        const newId = this.addHistoryRound({ questionText: question, questionImage: this.state.questionImage || '', source });
        console.log(`[localHttpServer][history] ✨ 创建提问轮 id=${newId} source=${source} | status=asked ⏳ | historyCount=${this.state.history.length} | historyVersion=${this.state.historyVersion}`);
      }
      // 小程序端也同步一下"马上开始生成"
      this._broadcast('answer:start', { question });
    };
    // ---- asr:answer-start（AI 开始答题 → 小程序也显示 loading，兼容外部直接 emit 老通道）----
    h['asr:answer-start'] = (question) => {
      this._broadcast('answer:start', { question: question || '' });
    };
    // ---- answer:generated（AI 答题完成 → 推答案文本 + 更新 state）----
    h['asr:answer-generated'] = (data) => {
      const text = typeof data === 'string' ? data : (data && data.text ? data.text : '');
      const question = data && data.question ? data.question : '';
      // ★ P3-1：支持上游传入 error 字段（ASR Pipeline 失败场景会带）
      const errorFromData = data && data.error ? String(data.error).trim() : '';
      const sourceFromData = data && data.source ? String(data.source) : 'panel-asr';
      const durationMs = data && Number.isFinite(Number(data.durationMs)) ? Number(data.durationMs) : 0;
      console.log(`[localHttpServer][bus] ⬇ asr:answer-generated 收到: answerLen=${(text||'').length} error="${errorFromData.substring(0,40)}" durationMs=${durationMs} q="${(question||'').substring(0,40)}"`);
      // ★ 如果带了 question 字段（面板端 ASR→AI 链路会传），可以判断是否要补一轮 history
      //   常见情况：面板端 ASR 识别到 final 问题，外部 AI Service 直接生成答案并通过 bus 推回来
      //   这里：如果确实有 question 且 history 里最新一条不是 asked（即还未创建本轮提问）→ 兜底创建
      if (question && Array.isArray(this.state.history)) {
        const last = this.state.history[this.state.history.length - 1];
        const needsRound = !last || last.status !== HISTORY_STATUS_ASKED;
        if (needsRound) {
          try {
            const newId = this.addHistoryRound({
              questionText: String(question || ''),
              questionImage: this.state.questionImage || '',
              source: sourceFromData,
            });
            console.log(`[localHttpServer][history] 🩹 兜底创建提问轮（因为 asr:answer-generated 时还没有 asked 轮）id=${newId}`);
          } catch (_) { /* 忽略 */ }
        }
      }
      // 最终要写入的错误文本：如果上游传了就用上游的；如果没有但 answer 空 → 兜底"AI 返回空"
      const finalError = errorFromData || (text ? '' : 'AI 返回空答案');
      // 写 state + 触发 history 结算（把刚刚的提问轮和这段答案关联起来；失败→status=error）
      this.recordState({
        answerText: text,
        _historyAction: 'answer',
        _historyError: finalError,
      });
      // 成功/失败后：打一条明确日志，包含本轮 id 与 status
      if (this._activeHistoryId && Array.isArray(this.state.history)) {
        const r = this.state.history.find((x) => x && x.id === this._activeHistoryId);
        if (r) {
          console.log(`[localHttpServer][history] ${finalError ? '❌ 结算(错误)' : '✅ 结算(成功)'} id=${r.id} status=${r.status} | 答案 ${(r.answerText||'').length} 字${finalError?` reason=${finalError.substring(0,60)}`:''} | historyVersion=${this.state.historyVersion}`);
        }
      }
      // 小程序/WS 广播：把 error 也带上，前端可以显示失败原因
      this._broadcast('answer:generated', { text, question, error: finalError });
    };
    // ---- asr:recording-status（录制态 true/false）----
    h['asr:recording-status'] = (isRecording) => {
      this.recordState({ isRecording: !!isRecording });
      this._broadcast('status:change', { isRecording: !!isRecording, connected: !!(this.minSocket && this.minSocket.readyState === 1) });
    };

    // 挂载到 bus（每个独立 try/catch，一个失败不影响其他）
    let successCount = 0;
    Object.keys(h).forEach((evt) => {
      try { this.bus.on(evt, h[evt]); successCount++; } catch (e) {
        console.error(`[localHttpServer] bus.on(${evt}) 失败:`, e.message);
      }
    });
    this._busHandlers = h;
    // ★ 明确的挂载成功日志：以后只要看到这行就能确认「ASR bus 事件 → history 写入」链路已就绪
    console.log(`[localHttpServer] ✅ _attachBus 完成：已订阅 ${successCount}/${Object.keys(h).length} 个事件 → 覆盖 asr:interim/final/question-asked/answer-start/answer-generated/recording-status + 截图/H5 事件`);
  }

  // 取消订阅（stop 时调用，防内存泄漏）
  _detachBus() {
    if (!this.bus || !this._busHandlers) return;
    Object.keys(this._busHandlers).forEach((evt) => {
      try { this.bus.off(evt, this._busHandlers[evt]); } catch (_) { /* 忽略 */ }
    });
    this._busHandlers = null;
  }

  // asr:interim 200ms 节流：窗口内最新文本合并一次发送，避免小程序被刷屏
  _asrInterimThrottled(text) {
    this._interimPendingText = String(text || '');
    if (this._interimThrottleTimer) return; // 已有定时器等待触发
    this._interimThrottleTimer = setTimeout(() => {
      this._interimThrottleTimer = null;
      const t = this._interimPendingText;
      this._interimPendingText = '';
      this._broadcast('asr:interim', { text: t });
    }, ASR_INTERIM_THROTTLE_MS);
  }

  // ============================================================
  // 15. HTTP 路由分发（总入口）
  //   CORS：允许小程序 wx.request（任意 Origin，只允许 Header Authorization）
  // ============================================================
  _onHttpRequest(req, res) {
    // ====== H5 调试：记录每个请求开始（远程 IP / 方法 / 路径），手机一扫码终端立刻有反应 ======
    // 为什么需要这条日志？用户反馈"浏览器一直转圈"时：
    //   → 如果终端里没有 [HTTP-IN] 行：说明请求根本没到服务端（网络层/防火墙/端口没在 listen）
    //   → 如果有 [HTTP-IN] 但没有对应 [HTTP-OUT]：说明服务端处理时卡住（路由里没调用 res.end/json）
    //   → 两者都有，但浏览器不显示：浏览器端问题（证书/缓存/微信内核兼容）
    const _reqStartTs = Date.now();
    const _remoteIp = (req.socket && req.socket.remoteAddress) ? req.socket.remoteAddress.replace(/^::ffff:/, '') : 'unknown';
    const _method = req.method || '-';
    const _shortUrl = (req.url || '/').length > 120 ? (req.url.substring(0, 120) + '...') : (req.url || '/');
    console.log(`[HTTP-IN] ⬅️ ${_method} ${_shortUrl}  from=${_remoteIp}`);

    // CORS 预处理
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    };
    if (req.method === 'OPTIONS') {
      console.log(`[HTTP-OUT] ➡️ 204 CORS preflight  from=${_remoteIp}  cost=${Date.now() - _reqStartTs}ms`);
      res.writeHead(204, corsHeaders);
      res.end();
      return;
    }
    Object.keys(corsHeaders).forEach((k) => res.setHeader(k, corsHeaders[k]));

    // 解析 URL
    const parsed = url.parse(req.url, true);
    const pathname = parsed.pathname || '/';

    // /health 免鉴权
    if (pathname === '/health' && req.method === 'GET') {
      this._json(res, 200, { ok: true, v: 1 }, { _reqStartTs, _remoteIp, _method });
      return;
    }

    // 其他接口：校验 token
    const authErr = this._checkAuth(req, _remoteIp);
    if (authErr) {
      this._json(res, 401, { ok: false, error: 'unauthorized', msg: authErr }, { _reqStartTs, _remoteIp, _method });
      return;
    }

    // ---- 路由表 ----
    if (pathname === '/api/connect' && req.method === 'GET')     return this._routeApiConnect(req, res, parsed, { _reqStartTs, _remoteIp, _method });
    if (pathname === '/api/overlay/status' && req.method === 'GET') return this._routeApiOverlayStatus(req, res, parsed, { _reqStartTs, _remoteIp, _method });
    if (pathname === '/api/screenshot' && req.method === 'GET') return this._routeApiScreenshot(req, res, parsed, { _reqStartTs, _remoteIp, _method });
    if (pathname === '/api/answer/write' && req.method === 'POST') return this._routeApiAnswerWrite(req, res, { _reqStartTs, _remoteIp, _method });
    if (pathname === '/api/disconnect' && req.method === 'POST') return this._routeApiDisconnect(req, res, { _reqStartTs, _remoteIp, _method });
    // ---- 新增：H5 移动端页面入口（与 /h5 /h5/ /h5/index.html 都匹配，微信扫码 URL 直开）----
    if ((pathname === '/h5' || pathname === '/h5/' || pathname === '/h5/index.html') && req.method === 'GET') return this._routeH5(req, res, { _reqStartTs, _remoteIp, _method });
    // ---- 新增：H5 提交问题（纯文本或带截图）给 AI 生成答案，自动同步到电脑面板 ----
    if (pathname === '/api/answer/ask' && req.method === 'POST') return this._routeApiAnswerAsk(req, res, { _reqStartTs, _remoteIp, _method });
    // ---- 新增：面试记录 Session HTTP 接口（主窗口底部按钮 / 列表页 / 详情页 / 侧栏 round 卡片跳转）----
    //   全部走 token 鉴权（和其它 /api 一致，避免局域网内他人直接扫历史面试内容）
    if (pathname === '/api/sessions'                 && req.method === 'GET')  return this._routeApiSessionsList(req, res, parsed, { _reqStartTs, _remoteIp, _method });
    if (pathname === '/api/sessions/start-new'       && req.method === 'POST') return this._routeApiSessionsStartNew(req, res, { _reqStartTs, _remoteIp, _method });
    if (pathname === '/api/sessions/end-active'      && req.method === 'POST') return this._routeApiSessionsEndActive(req, res, { _reqStartTs, _remoteIp, _method });
    if (pathname === '/api/sessions/find-by-round'   && req.method === 'GET')  return this._routeApiSessionsFindByRound(req, res, parsed, { _reqStartTs, _remoteIp, _method });
    if (pathname === '/api/sessions/ensure-if-ended' && req.method === 'POST') return this._routeApiSessionsEnsureIfEnded(req, res, { _reqStartTs, _remoteIp, _method });
    // /api/sessions/:id 必须在非 / 结尾的最后匹配（解析 pathname 段）
    if (req.method === 'GET' && /^\/api\/sessions\/[^/]+$/.test(pathname)) {
      const id = decodeURIComponent(pathname.substring('/api/sessions/'.length));
      return this._routeApiSessionDetail(req, res, id, { _reqStartTs, _remoteIp, _method });
    }

    // ============================================================
    // ★ 面试记录【双写模式 Phase 1】SQLite 统一仓储 HTTP 路由（/api/db/sessions/*）
    //   - 用于 Web 端（Landing）/H5 与桌面端运行在同一台电脑时，直接通过本地 HTTP 读 SQLite 面试记录
    //   - 与 db:sessions-* IPC 句柄形成一一对应，便于跨进程消费
    //   - 鉴权：继续走 handleRequest 前置的 token/query-IA 检查（同一套，不会额外暴露在局域网）
    //   - SQLite 未就绪：统一返回 sqliteUnavailable=true，前端可据此回退到 JSON 层 /api/sessions 路由
    // ============================================================
    if (pathname === '/api/db/sessions/health' && req.method === 'GET') {
      return this._routeApiDbSessionsHealth(req, res, parsed, { _reqStartTs, _remoteIp, _method });
    }
    if (pathname === '/api/db/sessions/list'   && req.method === 'GET') {
      return this._routeApiDbSessionsList(req, res, parsed, { _reqStartTs, _remoteIp, _method });
    }
    // GET    /api/db/sessions/:id → 详情
    if (req.method === 'GET' && /^\/api\/db\/sessions\/[^/]+$/.test(pathname)) {
      const id = decodeURIComponent(pathname.substring('/api/db/sessions/'.length));
      return this._routeApiDbSessionsGet(req, res, id, { _reqStartTs, _remoteIp, _method });
    }
    // DELETE /api/db/sessions/:id → 删除
    if (req.method === 'DELETE' && /^\/api\/db\/sessions\/[^/]+$/.test(pathname)) {
      const id = decodeURIComponent(pathname.substring('/api/db/sessions/'.length));
      return this._routeApiDbSessionsDelete(req, res, id, { _reqStartTs, _remoteIp, _method });
    }

    // ---- 新增：模拟面试（多 Agent）HTTP 接口 ----
    if (pathname === '/api/mock-interview/session'      && req.method === 'POST') return this._routeApiMockInterviewSession(req, res, { _reqStartTs, _remoteIp, _method });
    if (pathname === '/api/mock-interview/next-question' && req.method === 'POST') return this._routeApiMockInterviewNextQ(req, res, { _reqStartTs, _remoteIp, _method });
    if (pathname === '/api/mock-interview/submit-answer' && req.method === 'POST') return this._routeApiMockInterviewSubmitAnswer(req, res, { _reqStartTs, _remoteIp, _method });
    // ---- 浮动面板专用轻量路由：只登记答案/推进题目，不做单题点评、不触发追问（总点评留到 final-review 一次生成） ----
    if (pathname === '/api/mock-interview/register-answer' && req.method === 'POST') return this._routeApiMockInterviewRegisterAnswer(req, res, { _reqStartTs, _remoteIp, _method });
    if (pathname === '/api/mock-interview/submit-followup' && req.method === 'POST') return this._routeApiMockInterviewSubmitFollowup(req, res, { _reqStartTs, _remoteIp, _method });
    if (pathname === '/api/mock-interview/final-review'  && req.method === 'POST') return this._routeApiMockInterviewFinalReview(req, res, { _reqStartTs, _remoteIp, _method });

    // ---- 新增：简历优化（多 Agent）HTTP 接口 ----
    if (pathname === '/api/resume-opt/run'               && req.method === 'POST') return this._routeApiResumeOptRun(req, res, { _reqStartTs, _remoteIp, _method });
    if (pathname === '/api/resume-opt/parse-file'        && req.method === 'POST') return this._routeApiResumeOptParseFile(req, res, { _reqStartTs, _remoteIp, _method });
    if (pathname === '/api/resume-opt/export-docx'       && req.method === 'POST') return this._routeApiResumeOptExportDocx(req, res, { _reqStartTs, _remoteIp, _method });
    if (pathname === '/api/resume-opt/export-md'         && req.method === 'POST') return this._routeApiResumeOptExportMd(req, res, { _reqStartTs, _remoteIp, _method });
    // ---- 新增：简历优化三阶段独立路由（渲染层串行调用，实现"出一张卡、渲染一张卡"的真实进度反馈） ----
    if (pathname === '/api/resume-opt/ats'               && req.method === 'POST') return this._routeApiResumeOptATS(req, res, { _reqStartTs, _remoteIp, _method });
    if (pathname === '/api/resume-opt/keywords'          && req.method === 'POST') return this._routeApiResumeOptKeywords(req, res, { _reqStartTs, _remoteIp, _method });
    if (pathname === '/api/resume-opt/content'           && req.method === 'POST') return this._routeApiResumeOptContent(req, res, { _reqStartTs, _remoteIp, _method });

    // 404
    console.log(`[HTTP-OUT] ➡️ 404 NOT FOUND  ${_method} ${pathname}  from=${_remoteIp}  cost=${Date.now() - _reqStartTs}ms`);
    this._json(res, 404, { ok: false, error: 'not found' }, { _reqStartTs, _remoteIp, _method });
  }

  // 统一检查 token（先读 Header Authorization: Bearer xxx，再读 query.token 兜底）
  // 安全豁免：127.0.0.1 / ::1 本地请求直接放行（给同机的 Landing Web 控制台用，无需用户复制粘贴 Token）
  _checkAuth(req, _remoteIp) {
    // —— 本机白名单豁免：直接放行，Landing Web 控制台 /api/db/sessions/* 同源同机请求不需要 Token ——
    if (_remoteIp === '127.0.0.1' || _remoteIp === '::1' || _remoteIp === '::ffff:127.0.0.1' || !_remoteIp) {
      return null;
    }
    const parsed = url.parse(req.url, true);
    let tok = null;
    // Header 优先
    try {
      const header = req.headers && req.headers['authorization'];
      if (header && /^Bearer\s+/i.test(header)) tok = header.replace(/^Bearer\s+/i, '').trim();
    } catch (_) { tok = null; }
    // 兜底 query.token
    if (!tok) {
      try { tok = (parsed.query && parsed.query.token) || null; } catch (_) { tok = null; }
    }
    const tokShort = tok ? (tok.substring(0, 6) + '***') : '(空)';
    const srvShort = this.token ? (this.token.substring(0, 6) + '***') : '(无token服务未启动)';
    if (!tok) {
      console.log(`[AUTH-ERR] 缺少 token  from=${_remoteIp}  req=${tokShort}  server=${srvShort}`);
      return '缺少 token（Header Authorization: Bearer 或 URL ?token=）';
    }
    if (tok !== this.token) {
      console.log(`[AUTH-ERR] token 不匹配  from=${_remoteIp}  req=${tokShort}  server=${srvShort}`);
      return 'token 无效或已过期，请重新扫码';
    }
    return null;
  }

  // 统一 JSON 响应
  _json(res, code, body, reqDebug) {
    const data = Buffer.from(JSON.stringify(body || {}), 'utf-8');
    // ====== H5 调试：打印响应码 + body 大小 + 耗时（与 [HTTP-IN] 成对出现）======
    if (reqDebug && reqDebug._method) {
      const cost = Date.now() - (reqDebug._reqStartTs || Date.now());
      const extra = (code !== 200 && body && body.msg) ? `  msg=${String(body.msg).substring(0, 60)}` : '';
      console.log(`[HTTP-OUT] ➡️ ${code} ${reqDebug._method}  bytes=${data.length}  from=${reqDebug._remoteIp || '-'}  cost=${cost}ms${extra}`);
    }
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': data.length,
    });
    res.end(data);
  }

  // 读 POST JSON body（限制 1MB，超时 10s）
  _readJsonBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      let done = false;
      const tm = setTimeout(() => {
        if (done) return;
        done = true;
        reject(new Error('body timeout'));
      }, 10000);
      req.on('data', (c) => {
        if (done) return;
        size += c.length;
        if (size > HTTP_BODY_LIMIT_BYTES) {
          done = true;
          clearTimeout(tm);
          reject(new Error('body too large'));
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (done) return;
        done = true;
        clearTimeout(tm);
        try {
          const raw = Buffer.concat(chunks).toString('utf-8');
          if (!raw) return resolve({});
          resolve(JSON.parse(raw));
        } catch (e) { reject(new Error('invalid json')); }
      });
      req.on('error', (e) => {
        if (done) return;
        done = true;
        clearTimeout(tm);
        reject(e);
      });
    });
  }

  // ---- GET /api/connect：下发 AI/OCR/面试配置（小程序可直接复用，避免用户在小程序端重复填 Key）----
  _routeApiConnect(req, res, parsed, reqDebug) {
    // H5 初始化连接 → 标记 H5 活跃（服务端 status 升级到 connected）
    this._touchH5Active();
    // loadConfig 由外部（main.js）attach 到 this 上；若没有则返回空字段，不 crash
    const cfg = (typeof this.loadConfigFn === 'function') ? this.loadConfigFn() : {};
    const interview = cfg || {};
    // AI 配置（小程序可选使用：共享 key 或用自己本地配置）
    const aiConfig = {
      baseUrl: interview.tongyiBaseUrl || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: interview.selectedModel || interview.tongyiModel || 'qwen-plus',
      // 下发空 key：默认小程序本地优先，用户也可在小程序设置中启用"共享电脑 Key"
      apiKey: interview.shareAiKeyToMiniapp ? (interview.tongyiApiKey || '') : '',
    };
    // OCR 配置（占位：默认 Provider 阿里云，accessKey 下发空，小程序可本地填）
    const ocrConfig = {
      provider: 'aliyun',
      accessKeyId: interview.shareOcrKeyToMiniapp ? (interview.ocrAccessKeyId || '') : '',
      accessKeySecret: interview.shareOcrKeyToMiniapp ? (interview.ocrAccessKeySecret || '') : '',
    };
    // 面试信息（用于 AI prompt 更贴合岗位）
    const interviewInfo = {
      type: interview.interviewType || '综合面试',
      position: interview.targetPosition || '',
      years: Number(interview.experienceYears) || 0,
    };
    this._json(res, 200, {
      ok: true,
      device: 'Interview Assist-Copilot',
      asrOn: !!this.state.isRecording,
      aiConfig,
      ocrConfig,
      interview: interviewInfo,
    }, reqDebug);
  }

  // ---- GET /api/overlay/status：兜底轮询最新态快照 ----
  _routeApiOverlayStatus(req, res, parsed, reqDebug) {
    // 把 history 里的截图缩略标记（不需要时前端可只渲染答案文本）
    // 注意：history 正序，前端按顺序从上到下渲染（旧→新，正序追加在底部）
    this._json(res, 200, {
      ok: true,
      asrText: this.state.asrText,
      answerText: this.state.answerText,
      questionImage: this.state.questionImage,   // 面试官截图：H5 轮询后可显示与面板一致的截图画面
      isRecording: this.state.isRecording,
      lastAnswerAt: this.state.lastAnswerAt,
      // ===== 多轮对话历史（正序数组，最近 10 轮）=====
      history: Array.isArray(this.state.history) ? this.state.history : [],
      historyVersion: Number(this.state.historyVersion) || 0,
      // ===== 面试 Session：当前进行中的 sessionId + sessionsVersion（版本变化即代表列表/详情有新内容可刷新）=====
      activeSessionId: this.state.activeSessionId || null,
      sessionsVersion: Number(this.state.sessionsVersion) || 0,
    }, reqDebug);
  }

  // ---- GET /api/screenshot：HTTP 方式触发截图 ----
  async _routeApiScreenshot(req, res, parsed, reqDebug) {
    // H5 调截图 → 标记活跃（防 idle 30s 超时）
    this._touchH5Active();
    const q = (parsed && parsed.query) || {};
    const payload = {
      sourceId: q.sourceId || null,
      format: (q.format === 'png') ? 'png' : 'jpeg',
      quality: Number(q.quality) || 0.85,
      maxSize: Number(q.maxSize) || 1920,
    };
    try {
      const cap = await this._doCapture(payload);
      this._json(res, 200, {
        ok: true,
        data: cap.data,
        width: cap.width,
        height: cap.height,
        mime: cap.mime,
      }, reqDebug);
      // 【新增】H5 手动截图成功后，异步触发"截图自动解题闭环"：把截图→AI识图→面板显示问答（与小程序 screenshot:req 同一链路）
      //   异步执行不阻塞 screenshot:res 回传给 H5（避免手机端 HTTP 超时）；自动解题失败仅打日志不影响返回
      try {
        const fire = async () => {
          const r = await this._autoSolveScreenshotAndSync({
            imageDataUrlOrBase64: cap.data,
            mime: cap.mime || 'image/jpeg',
            source: 'h5',
          });
          // H5 可通过轮询 /api/overlay/status 读取最新答案与截图同步（不额外推 WS，H5 本身无 WS 连接）
          void r; // 静默占位，防 ESLint unused
        };
        fire().catch((e) => console.warn('[h5-screenshot] 自动解题异步失败（已兜底忽略）:', e && e.message));
      } catch (outerE) {
        console.warn('[h5-screenshot] 启动自动解题异常:', outerE && outerE.message);
      }
    } catch (e) {
      const code = (e && e.code) || 'internal';
      const msg = (e && e.userMsg) || e.message || '截图失败';
      const httpCode = (code === 'permission') ? 500 : (code === 'timeout') ? 408 : 500;
      this._json(res, httpCode, { ok: false, error: code, msg }, reqDebug);
    }
  }

  // ---- POST /api/answer/write：小程序答案回写 ----
  async _routeApiAnswerWrite(req, res, reqDebug) {
    // H5/小程序写答案 → 标记活跃
    this._touchH5Active();
    try {
      const body = await this._readJsonBody(req);
      const text = body && body.text ? String(body.text) : '';
      if (!text || !text.trim()) {
        this._json(res, 400, { ok: false, error: 'empty', msg: 'text 不能为空' }, reqDebug);
        return;
      }
      // 通知外部（main.js）：把答案写入 overlay 答题面板
      if (this.bus) {
        try { this.bus.emit('local:write-answer-from-outside', text); } catch (_) { /* 忽略 */ }
      }
      // 同步更新内部 state（下次 /api/overlay/status 会立刻返回最新答案）
      // ★ 答案回写时如果没有对应的"待回答轮"，兜底创建一轮（questionText 为空，把答案挂到 fallback 轮）
      this.recordState({
        answerText: text,
        _historyAction: 'answer',
        _historyError: '',
      });
      const id = Date.now().toString(36);
      this._json(res, 200, { ok: true, id }, reqDebug);
    } catch (e) {
      this._json(res, 400, { ok: false, error: 'body_invalid', msg: '请求体非法：' + (e.message || '未知错误') }, reqDebug);
    }
  }

  // ---- POST /api/disconnect：主动断开当前小程序 WS 连接 / H5 手动断开 ----
  _routeApiDisconnect(req, res, reqDebug) {
    try {
      // 先处理 H5 手动断开：清活跃态，必要时 status 回 listening
      this._h5ManualDisconnect();
      // 再处理小程序 WS 断开（如果有）
      if (this.minSocket) {
        try { this.minSocket.close(4000, 'user disconnect via HTTP'); } catch (_) { /* 忽略 */ }
        this.minSocket = null;
        // 只有在 H5 也没活跃的情况下才变 disconnected（不然前面 _h5ManualDisconnect 已经降回 listening 了）
        if (!this.h5Active) this._setStatus('disconnected');
      }
      this._json(res, 200, { ok: true }, reqDebug);
    } catch (e) {
      this._json(res, 500, { ok: false, error: 'internal', msg: e.message || '断开失败' }, reqDebug);
    }
  }

  // ============================================================
  // 新增 A. GET /h5：返回移动端 H5 单文件（微信扫码后直接访问）
  //   token 通过 URL ?token= 传入（已在前面 _checkAuth 校验通过）
  //   首次读文件落盘缓存，后续直接内存返回；原生 fs.readFileSync（阶梯 3，无新依赖）
  // ============================================================
  _routeH5(req, res, reqDebug) {
    try {
      const _startTs = (reqDebug && reqDebug._reqStartTs) ? reqDebug._reqStartTs : Date.now();
      const _remoteIp = (reqDebug && reqDebug._remoteIp) ? reqDebug._remoteIp : '-';
      const _method = (reqDebug && reqDebug._method) ? reqDebug._method : 'GET';
      // 第一次请求：读文件并缓存；文件不存在时给出用户友好的中文报错，防止空白页
      let hitCache = !!this._h5HtmlCache;
      if (!this._h5HtmlCache) {
        try {
          if (!fs.existsSync(this._h5HtmlPath)) {
            const errBody = { ok: false, error: 'h5_missing', msg: `H5 页面文件不存在：${this._h5HtmlPath}` };
            console.log(`[HTTP-OUT] ➡️ 500 ${_method} 文件缺失  bytes=${Buffer.byteLength(JSON.stringify(errBody))}  from=${_remoteIp}  cost=${Date.now() - _startTs}ms  msg=H5 文件不存在`);
            this._json(res, 500, errBody, reqDebug);
            return;
          }
          this._h5HtmlCache = fs.readFileSync(this._h5HtmlPath, 'utf-8');
        } catch (readErr) {
          console.error('[localHttpServer] 读取 H5 文件失败:', readErr.message);
          const errBody = { ok: false, error: 'h5_read_fail', msg: 'H5 页面读取失败：' + readErr.message };
          this._json(res, 500, errBody, reqDebug);
          return;
        }
      }
      const data = Buffer.from(this._h5HtmlCache, 'utf-8');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': data.length,
        // 手机微信浏览器不缓存，每次打开 token 都是最新的（安全：避免二维码被他人复用旧 token）
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
        'Pragma': 'no-cache',
      });
      res.end(data);
      // 手动记录响应日志（非 _json 路径），统一前缀 [HTTP-OUT] 方便排查
      console.log(`[HTTP-OUT] ➡️ 200 ${_method} HTML  bytes=${data.length}  hitCache=${hitCache ? 'Y' : 'N'}  from=${_remoteIp}  cost=${Date.now() - _startTs}ms`);
    } catch (e) {
      console.error('[localHttpServer] _routeH5 异常:', e.message);
      const errBody = { ok: false, error: 'internal', msg: 'H5 服务异常：' + e.message };
      this._json(res, 500, errBody, reqDebug);
    }
  }

  // ============================================================
  // 新增 B. POST /api/answer/ask：H5 端提交问题 + 可选截图给 AI，自动同步面板
  //   body = { text?: string, imageDataUrl?: string }（至少一个非空）
  //   - 有截图 imageDataUrl → 调 aiService.callVisionModel（多模态 qwen-vl，阶梯 2 复用）
  //   - 无图仅文本    → 调 aiService.generateAnswer（纯文本，阶梯 2 复用）
  //   - 生成答案后：① bus.emit 通知电脑面板显示 ② recordState 更新 state，H5 轮询立刻可见
  // ============================================================
  async _routeApiAnswerAsk(req, res, reqDebug) {
    // H5 提交问题 → 标记活跃
    this._touchH5Active();
    try {
      // 前置校验：aiService 模块是否成功加载
      if (!aiService) {
        this._json(res, 500, { ok: false, error: 'ai_service_missing', msg: 'AI 服务未加载，请联系开发者' }, reqDebug);
        return;
      }
      const body = await this._readJsonBody(req);
      const text = body && body.text ? String(body.text).trim() : '';
      const imageDataUrl = body && body.imageDataUrl ? String(body.imageDataUrl).trim() : '';
      if (!text && !imageDataUrl) {
        this._json(res, 400, { ok: false, error: 'empty', msg: '问题文本(text)和截图(imageDataUrl)至少填写一个' }, reqDebug);
        return;
      }
      // ★ H5 手动提问题：先往 history 写入"一轮提问"，status=asked，后续答案结算到同一轮
      this.recordState({
        questionImage: imageDataUrl,
        _historyAction: 'question',
        _historyMeta: { source: 'h5' },
      });
      // 提问文本写入 state.asrText：既作为"面试官区临时文本"（兜底显示），也作为当前轮 questionText 回溯来源
      if (text) this.recordState({ asrText: text });
      // 拿外部（main.js）attach 的配置（同 _routeApiConnect 逻辑）
      const cfg = (typeof this.loadConfigFn === 'function') ? this.loadConfigFn() : {};
      const service = (cfg && cfg.selectedService) ? cfg.selectedService : 'tongyi';
      // 面试场景信息（让 answer 更贴合岗位）
      const interviewScene = (cfg && cfg.interviewType) || '综合面试';
      // 【修复字段名不匹配】配置里简历字段是 resumeText（interview-config.js），兼容老写法 resumeContent
      const resumeContent = (cfg && (cfg.resumeContent || cfg.resumeText)) || '';
      const modelTier = cfg && cfg.modelTier;
      let answer = '';
      const startTs = Date.now();
      // 通知外部/面板：AI 开始生成（UI 可展示生成中指示器）
      if (this.bus) { try { this.bus.emit('asr:answer-start', { source: 'h5', ts: startTs }); } catch (_) { /* 忽略 */ } }
      if (imageDataUrl) {
        // 有截图 → 调用 aiService 真实存在的 callVision(prompt, imageDataUrl, service, config, model)
        //     注：之前写的 callVisionModel 方法不存在（aiService 里叫 callVision），且参数顺序也反了，导致 H5 报错 "aiService.callVisionModel is not a function"
        const defaultPrompt = '请识别这张图片中的面试问题或内容，给出专业简洁的解答。若是代码题，请给出解题思路+关键代码+复杂度分析；若是主观/设计题，请分点作答；若是代码报错，请分析原因并给出修复代码。';
        const userExtraPrompt = text ? ('\n\n【用户补充要求】\n' + text) : '';
        const resumePrompt = resumeContent ? ('\n\n【候选人简历背景（用于答题更贴合岗位）】\n' + resumeContent.substring(0, 3000)) : '';
        const fullPrompt = defaultPrompt + userExtraPrompt + resumePrompt;
        // callVision 真实签名：callVision(prompt, imageDataUrl, service, config, model)
        answer = await aiService.callVision(fullPrompt, imageDataUrl, service, cfg);
      } else {
        // 纯文本 → 用通用问答模型（签名已对齐，无需修改）
        answer = await aiService.generateAnswer(text, interviewScene, service, cfg, [], resumeContent, modelTier);
      }
      answer = String(answer || '').trim();
      // ① 写入电脑答题面板（复用 /api/answer/write 的 bus 事件，阶梯 2）
      if (this.bus && answer) {
        try { this.bus.emit('local:write-answer-from-outside', answer); } catch (_) { /* 忽略 */ }
      }
      // ② 同步 state（轮询接口 /api/overlay/status 会立刻返回最新答案）
      // ★ 同时触发 history 结算：把答案写入"最近一条 asked 轮"（兜底新建一轮），确保每次问/答都形成完整的历史条目
      this.recordState({
        answerText: answer,
        _historyAction: 'answer',
        _historyError: answer ? '' : 'AI 返回空答案（模型未返回有效内容）',
      });
      // 返回给 H5 调用方（H5 可以选择直接显示或继续走轮询）
      this._json(res, 200, {
        ok: true,
        id: Date.now().toString(36),
        costMs: Date.now() - startTs,
        withImage: !!imageDataUrl,
        answer,
      }, reqDebug);
    } catch (e) {
      // 打印完整错误栈（包含具体哪行、文件名，而不是只打印 e.message，方便下次快速定位问题）
      console.error('[localHttpServer] _routeApiAnswerAsk 失败: ' + (e && e.message) + '\n' + (e && e.stack ? e.stack : new Error().stack));
      const code = (e && e.code) || 'ai_error';
      const rawMsg = (e && e.userMsg) || e.message || '';
      // 对前端展示的错误信息做"友好降级"：内部错误(如 not a function)别把原始 JS 错误直接给用户看
      let friendly = 'AI 回答失败，请稍后重试';
      if (rawMsg) {
        if (/not a function|undefined|is not|cannot read/i.test(rawMsg)) {
          // 这类是代码内部错误 → 提示用户看终端日志
          friendly = 'AI 服务内部错误：' + rawMsg + '，请查看终端日志或告知开发者';
        } else if (/未知的AI服务|当前服务商不支持|key|token|api|401|403|429/i.test(rawMsg)) {
          // 配置/限流类 → 提示用户检查配置
          friendly = 'AI 调用异常：' + rawMsg + '，请检查设置中的服务商与密钥是否正确';
        } else {
          friendly = rawMsg;
        }
      }
      // ★ 失败也要结算到 history（status=error + 错误描述），避免 UI 卡在 loading
      try {
        this.finishHistoryRound({
          answerText: '',
          errorMsg: friendly,
        });
      } catch (hErr) {
        console.warn('[history] _routeApiAnswerAsk 失败结算异常（兜底忽略）：', hErr && hErr.message);
      }
      this._json(res, 500, { ok: false, error: code, msg: friendly }, reqDebug);
    }
  }

  // ============================================================
  // 15.5 截图自动解题闭环（面板/小程序/H5 截图通用入口）
  //   统一完成：① 写入面试官提问 → ② 调视觉模型解题 → ③ 写入AI答案
  //   参数说明：
  //     imageDataUrlOrBase64：可以是完整 data:image/xxx;base64,xxx，也可以是纯 base64
  //     mime：当入参是纯 base64 时必须提供，如 "image/jpeg"
  //     source：来源标识，用于日志 'panel' | 'miniapp' | 'h5'
  //     resumeContent / knowledgeBase：可选，由调用方（如面板 IPC）显式传入的上下文；
  //       传了就优先用（渲染层 getInterviewConfig 拿到的最新值），没传则回退读本地配置
  //   返回：{ success, answer? }
  // ============================================================
  async _autoSolveScreenshotAndSync({ imageDataUrlOrBase64, mime, source, resumeContent: extResume, knowledgeBase: extKb }) {
    try {
      // ---- 15.5.0 来源标签：在 try/catch 任何地方都可能用到，先定义好避免 ReferenceError ----
      //   用于：日志、诊断快照、错误信息（注意：变量名是 sourceLabel，不要写成 srcLabel！）
      const sourceLabel = (source === 'miniapp') ? '微信小程序'
        : (source === 'panel') ? '面板截图'
        : (source === 'h5') ? 'H5/手机端' : '外部';

      // ---- 15.5.1 参数归一化：保证得到标准 data:image/xxx;base64, ----
      let imageDataUrl = (imageDataUrlOrBase64 && typeof imageDataUrlOrBase64 === 'string') ? imageDataUrlOrBase64.trim() : '';
      if (!imageDataUrl) {
        console.warn(`[autoSolveScreenshot] 忽略：截图内容为空 source=${sourceLabel}`);
        return { success: false, error: 'empty_screenshot' };
      }
      // 如果没带 data: 前缀，则按 mime 拼前缀
      if (!/^data:image\//i.test(imageDataUrl)) {
        const useMime = (mime && typeof mime === 'string') ? mime : 'image/jpeg';
        imageDataUrl = `data:${useMime};base64,${imageDataUrl}`;
      }

      // ---- 15.5.1.5 【图片体积兜底】超过 9MB(base64) 时自动压缩，避免超过百炼/通义视觉模型 10MB 上限 ----
      //   面板链路已在 screenshot-screen IPC 压缩、小程序链路在 _doCapture 压缩，这里是最后一道防线（覆盖未来新增调用方）
      const IMG_SIZE_LIMIT = 9 * 1024 * 1024; // 9MB（留 1MB 余量给 HTTP 头/JSON 转义膨胀）
      if (imageDataUrl.length > IMG_SIZE_LIMIT) {
        try {
          // 延迟 require：localHttpServer 也可能被纯 Node 环境（dev-server）加载，require('electron') 失败时回退原图
          const { nativeImage } = require('electron');
          // 【修复】createFromDataURL 对超大 dataURL 会抛 "conversion failure"，
          //   改用 Buffer 解码（先剥离 data:image/xxx;base64, 前缀再 from(base64)）
          const b64 = imageDataUrl.replace(/^data:image\/[\w.+-]+;base64,/, '');
          let img = nativeImage.createFromBuffer(Buffer.from(b64, 'base64'));
          const sz = img.getSize();
          // 宽度超过 1600 则等比缩小（比常规 1920 再保守一点，确保压到限内）
          if (sz.width > 1600) img = img.resize({ width: 1600 });
          const jpegDataUrl = 'data:image/jpeg;base64,' + img.toJPEG(0.8).toString('base64');
          if (jpegDataUrl.length < imageDataUrl.length) {
            console.log(`[autoSolveScreenshot] 🗜️ 图片超限自动压缩 source=${sourceLabel}: ${(imageDataUrl.length / 1048576).toFixed(1)}MB(${sz.width}x${sz.height}) → ${(jpegDataUrl.length / 1048576).toFixed(1)}MB`);
            imageDataUrl = jpegDataUrl;
          } else {
            console.warn(`[autoSolveScreenshot] ⚠️ 图片超限且压缩无收益(${(jpegDataUrl.length / 1048576).toFixed(1)}MB)，仍用原图尝试 source=${sourceLabel}`);
          }
        } catch (ce) {
          console.warn(`[autoSolveScreenshot] ⚠️ 图片超限(${(imageDataUrl.length / 1048576).toFixed(1)}MB)且压缩失败(非Electron环境?)，直接用原图，视觉模型可能返回空答案:`, ce && ce.message);
        }
      }

      // ---- 15.5.2 组装面试官提问文字（体现来源，后续面板/轮询都可见）----
      const questionText =
`【面试官提问（${sourceLabel}·截图题）】
请观察下方截图中的面试问题或内容，结合岗位要求与候选人背景作答。
> （已截取屏幕画面，请AI识别其中的题目并给出专业解答）`;

      // ---- 15.5.3 第一步：写入「面试官」区（面板 + state 双写，保证H5轮询也可见）----
      //   注：payload 扩展为 { text, imageDataUrl }，面板端可据此展示"提问画面缩略图 + 文字提问"，字符串兼容兜底
      const qPayload = { text: questionText, imageDataUrl: imageDataUrl };
      if (this.bus) {
        try { this.bus.emit('local:write-question-from-outside', qPayload); }
        catch (_) { /* bus 订阅侧清理异常，忽略 */ }
      }
      // state 双写：interimText 存提示词（面板端会跳过内部模板，只显示截图），questionImage 存截图 dataURL，H5 轮询可见
      // ★ 同时触发一轮对话历史：status=asked，后续 recordState({_historyAction:'answer'}) 会把 AI 答案匹配到这一轮
      this.recordState({
        interimText: questionText,
        questionImage: imageDataUrl,
        _historyAction: 'question',
        _historyMeta: { source: source || 'screenshot' },
      });

      // ---- 15.5.4 通知面板：AI 开始答题（UI 展示 loading 指示器）----
      const startTs = Date.now();
      if (this.bus) {
        try { this.bus.emit('asr:answer-start', { source, ts: startTs }); }
        catch (_) { /* 忽略 */ }
      }

      // ---- 15.5.5 调视觉模型：复用 aiService.screenshotSolve（封装好 prompt + 简历/知识库融合）----
      if (!aiService) {
        throw new Error('AI 服务未加载(aiService missing)，请联系开发者');
      }
      const cfg = (typeof this.loadConfigFn === 'function') ? (this.loadConfigFn() || {}) : {};
      // 【修复字段名不匹配】配置结构(interview-config.js)里简历字段是 resumeText，不是 resumeContent；
      //   优先级：调用方显式传入(extResume) > cfg.resumeContent(老字段) > cfg.resumeText(现行字段)
      const resumeContent = (typeof extResume === 'string' && extResume.trim())
        ? extResume
        : ((cfg && (cfg.resumeContent || cfg.resumeText)) || '');
      // 知识库：优先外部传入，回退读配置
      const knowledgeBase = (typeof extKb === 'string' && extKb.trim())
        ? extKb
        : ((cfg && typeof cfg.knowledgeBase === 'string') ? cfg.knowledgeBase : '');

      // ===== 🔍 配置诊断日志（关键：截图解题 401/Key 为空时，直接看下面这行就知道是 .env 没读 还是 Key 配错）=====
      const _cfgSnapshot = {
        source: sourceLabel,
        selectedService: cfg.selectedService || '',
        tongyiApiKeyLen: (typeof cfg.tongyiApiKey === 'string') ? cfg.tongyiApiKey.length : 0,
        tongyiBaseUrl: cfg.tongyiBaseUrl || '',
        zhipuApiKeyLen: (typeof cfg.zhipuApiKey === 'string') ? cfg.zhipuApiKey.length : 0,
        wenxinApiKeyLen: (typeof cfg.wenxinApiKey === 'string') ? cfg.wenxinApiKey.length : 0,
        // process.env 直接快照（判断 dotenv 是否把 .env 加载进来了）
        env_IA_TONGYI_API_KEY_set: (typeof process.env === 'object' && process.env && typeof process.env.IA_TONGYI_API_KEY === 'string' && process.env.IA_TONGYI_API_KEY.trim().length > 0),
        env_IA_DEFAULT_SERVICE: (typeof process.env === 'object' && process.env) ? (process.env.IA_DEFAULT_SERVICE || '') : '',
      };
      console.log(`[autoSolveScreenshot] 🧪 配置快照 source=${sourceLabel}: ${JSON.stringify(_cfgSnapshot)}`);
      // 若 key 仍为空，给出明确操作指引（避免用户在设置面板和 .env 文件之间来回跳）
      if (!cfg.tongyiApiKey || (typeof cfg.tongyiApiKey === 'string' && cfg.tongyiApiKey.trim().length === 0)) {
        console.warn(
          '[autoSolveScreenshot] ⚠️ 通义 API Key 为空！可能原因：'
          + '1). .env 文件未放置在项目根目录（或 dotenv 未读取到，请检查启动终端 cwd 是否为项目根目录）；'
          + '2). 启动后才编辑的 .env 需要重启 npm start（dotenv 仅首次 require 时读取）；'
          + '3). 请在"设置面板-通义千问 API Key"里手动填写（面板写入优先级高于 .env，但环境变量会覆盖它）。'
          + ' 当前 cfg.selectedService=' + (cfg.selectedService || '')
          + ' | env_IA_TONGYI_API_KEY_set=' + _cfgSnapshot.env_IA_TONGYI_API_KEY_set
        );
      } else if (!cfg.selectedService) {
        console.warn('[autoSolveScreenshot] ⚠️ selectedService 为空，默认会用 tongyi，请确认 .env 里 IA_DEFAULT_SERVICE=tongyi');
      }

      // 注意：aiService.screenshotSolve 签名：(imageDataUrl, config, resumeContent, knowledgeBase)
      const answer = await aiService.screenshotSolve(imageDataUrl, cfg, resumeContent, knowledgeBase);
      const finalAnswer = String(answer || '').trim();

      // ---- 15.5.6 第二步：写入「AI 助手」区（面板 + state 双写，保证 H5 轮询也可见）----
      if (this.bus && finalAnswer) {
        try { this.bus.emit('local:write-answer-from-outside', finalAnswer); }
        catch (_) { /* 忽略 */ }
      }
      this.recordState({
        answerText: finalAnswer,
        _historyAction: 'answer',
        _historyError: finalAnswer ? '' : 'AI 返回空答案（模型未返回有效内容）',
      });

      const cost = Date.now() - startTs;
      console.log(`[autoSolveScreenshot] ✅ 解题完成 source=${sourceLabel} costMs=${cost} answerLen=${finalAnswer.length}`);
      return { success: true, answer: finalAnswer, costMs: cost };
    } catch (e) {
      // 失败也要打完整错误栈，方便排查（模型调用/参数格式/网络等）
      const sourceLabelFallback = (source === 'miniapp') ? '微信小程序'
        : (source === 'panel') ? '面板截图'
        : (source === 'h5') ? 'H5/手机端' : (source || 'unknown');
      const errMsg = (e && e.userMsg) || e.message || '截图解题失败';
      console.error(`[autoSolveScreenshot] ❌ 失败 source=${sourceLabelFallback}: ${errMsg}\n${(e && e.stack) ? e.stack : new Error().stack}`);
      // ★ 失败也要结算到 history：把最近一条 status=asked 的轮标记为 error，避免 UI 永远卡在"正在生成"
      try {
        this.finishHistoryRound({
          answerText: '',
          errorMsg: errMsg,
        });
      } catch (hErr) {
        console.warn('[history] 失败结算异常（兜底忽略）：', hErr && hErr.message);
      }
      return {
        success: false,
        error: (e && e.code) || 'ai_error',
        message: errMsg || '截图解题失败，请查看终端日志',
      };
    }
  }

  // ============================================================
  // 16. WS connection 总入口：鉴权 → 消息分发 → close 清理
  // ============================================================
  _onWsConnection(ws, req) {
    // ===== H5-DEBUG：WS 连接日志（小程序 WS 通道）=====
    const _wsRemoteIp = (req.socket && req.socket.remoteAddress) ? req.socket.remoteAddress.replace(/^::ffff:/, '') : 'unknown';
    // 16.1 解析 URL，拿 query.token（小程序 ws.connectSocket 时传在 URL 上，避免首帧鉴权时序问题）
    let queryToken = null;
    try {
      const u = new URL(req.url, 'http://localhost');
      queryToken = u.searchParams.get('token') || null;
    } catch (_) { queryToken = null; }
    const tokShort = queryToken ? (queryToken.substring(0, 6) + '***') : '(空)';
    const srvShort = this.token ? (this.token.substring(0, 6) + '***') : '(无token)';
    const urlShort = (req.url || '/').length > 120 ? (req.url.substring(0, 120) + '...') : (req.url || '/');

    // 16.2 先立即设置 authenticated（若 token 已对），否则启动 3s 超时
    if (queryToken && queryToken === this.token) {
      ws.authenticated = true;
      console.log(`[WS] ✅ 新连接（认证通过） from=${_wsRemoteIp}  url=${urlShort}  reqToken=${tokShort}  server=${srvShort}`);
    } else {
      ws.authenticated = false;
      console.log(`[WS] ❌ 新连接（认证失败，3s 后断开） from=${_wsRemoteIp}  url=${urlShort}  reqToken=${tokShort}  server=${srvShort}`);
      this._sendWsAuthTimeout(ws);
    }

    // 16.3 已认证：单连接踢旧，换 minSocket
    if (ws.authenticated) this._promoteToMinSocket(ws);

    // 16.4 接收消息
    ws.on('message', (raw) => {
      let msg = null;
      // 解析消息 JSON（独立 try/catch，一个 bad packet 不崩连接）
      try {
        const str = Buffer.isBuffer(raw) ? raw.toString('utf-8') : String(raw || '');
        if (!str) return; // 空包静默忽略
        msg = JSON.parse(str);
      } catch (e) {
        this._reply(ws, { id: null }, 'error', { code: 'bad_json', msg: '消息非合法 JSON' });
        return;
      }
      this._dispatchWsMessage(ws, msg);
    });

    // 16.5 close 事件：清理 minSocket + 改状态（兼容 H5 活跃兜底）
    ws.on('close', () => {
      this._clearWsAuthTimeout(ws);
      if (this.minSocket === ws) {
        this.minSocket = null;
        // 状态决策：H5 还活跃 → 保持 connected；否则才变 disconnected
        if (this.h5Active) {
          this._setStatus('connected');
        } else {
          this._setStatus('disconnected');
        }
      }
    });

    // 16.6 error：打日志，不额外处理（close 会接着触发）
    ws.on('error', (e) => {
      console.warn('[localHttpServer] WS error:', e && e.message);
    });
  }

  // 把已认证的 ws 提升为当前 minSocket（单连接：踢旧 → 换指向 → 状态变 connected）
  _promoteToMinSocket(ws) {
    ws.authenticated = true;
    this._clearWsAuthTimeout(ws);
    // 踢旧
    if (this.minSocket && this.minSocket !== ws) {
      try { this.minSocket.close(4000, 'replaced by new connection'); } catch (_) { /* 忽略 */ }
    }
    this.minSocket = ws;
    this.lastPingAt = Date.now();
    this._setStatus('connected');
    console.log('[localHttpServer] 小程序已连接');
  }

  // ============================================================
  // 17. WS 消息分发（按 type → handler）
  // ============================================================
  _dispatchWsMessage(ws, msg) {
    if (!msg || typeof msg !== 'object') return;
    const type = String(msg.type || '');
    // ---- 未认证：只允许 auth 消息 ----
    if (!ws.authenticated) {
      if (type !== 'auth') {
        // 没认证还发别的 → 直接 4401
        try { ws.close(4401, 'auth required'); } catch (_) { /* 忽略 */ }
        return;
      }
      this._handleAuth(ws, msg);
      return;
    }
    // ---- 已认证：按 type 分发（每个 handler 独立 try/catch）----
    switch (type) {
      case 'ping':                   return this._handlePing(ws, msg);
      case 'screenshot:req':         return this._handleScreenshotReq(ws, msg);
      case 'overlay:write-answer':   return this._handleOverlayWriteAnswer(ws, msg);
      case 'overlay:pull':           return this._handleOverlayPull(ws, msg);
      default:
        this._reply(ws, msg, 'error', { code: 'unknown_type', msg: `未知消息类型: ${type}` });
    }
  }

  // auth 消息：允许小程序在 query.token 未传的情况下通过消息体补传 token
  _handleAuth(ws, msg) {
    const tok = (msg.payload && msg.payload.token) ? String(msg.payload.token) : '';
    if (tok && tok === this.token) {
      this._promoteToMinSocket(ws);
      this._reply(ws, msg, 'auth:ack', { ok: true });
    } else {
      try { ws.close(4401, 'invalid token'); } catch (_) { /* 忽略 */ }
    }
  }

  // ---- ping（心跳）----
  _handlePing(ws, msg) {
    this.lastPingAt = Date.now();
    this._reply(ws, msg, 'pong', {});
  }

  // ---- screenshot:req（电脑截图 → 压缩 → base64 返回）----
  _handleScreenshotReq(ws, msg) {
    const payload = (msg.payload && typeof msg.payload === 'object') ? msg.payload : {};
    const reqPayload = {
      sourceId: payload.sourceId || null,
      format: (payload.format === 'png') ? 'png' : 'jpeg',
      quality: Number(payload.quality) || 0.85,
      maxSize: Number(payload.maxSize) || 1920,
    };
    // 15s 超时保护
    let settled = false;
    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      this._reply(ws, msg, 'screenshot:res', { ok: false, error: 'timeout', msg: '截图超时 15s' });
    }, SCREENSHOT_TIMEOUT_MS);
    this._doCapture(reqPayload).then((cap) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      this._reply(ws, msg, 'screenshot:res', {
        ok: true,
        data: cap.data,
        width: cap.width,
        height: cap.height,
        mime: cap.mime,
        sources: cap.sources || [],
      });
      // 【新增】小程序截图成功后，异步触发"截图自动解题闭环"：把截图当作面试官题 → AI识图解题 → 面板显示问答
      //     异步执行不阻塞 screenshot:res 回传给小程序（避免小程序等待模型响应而超时）
      try {
        const fire = async () => {
          const r = await this._autoSolveScreenshotAndSync({
            imageDataUrlOrBase64: cap.data,
            mime: cap.mime || 'image/jpeg',
            source: 'miniapp',
          });
          // 可选：把解题结果也通过 WS 推送给小程序（小程序可选择展示或忽略）
          try {
            this._reply(ws, null, 'screenshot:solved', {
              ok: !!r.success,
              source: 'miniapp',
              costMs: r.costMs || 0,
              answer: r.success ? (r.answer || '') : '',
              error: r.success ? '' : (r.message || r.error || ''),
            });
          } catch (_) { /* 推送失败忽略（小程序端可通过轮询 /api/overlay/status 兜底） */ }
        };
        fire().catch((e) => console.warn('[miniapp-screenshot] 自动解题异步失败（已兜底忽略）:', e && e.message));
      } catch (outerE) {
        console.warn('[miniapp-screenshot] 启动自动解题异常:', outerE && outerE.message);
      }
    }).catch((e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      const code = (e && e.code) || 'internal';
      const userMsg = (e && e.userMsg) || e.message || '截图失败';
      this._reply(ws, msg, 'screenshot:res', { ok: false, error: code, msg: userMsg });
    });
  }

  // ---- overlay:write-answer（小程序答案回写到电脑 overlay 答题面板）----
  _handleOverlayWriteAnswer(ws, msg) {
    const text = (msg.payload && msg.payload.text) ? String(msg.payload.text) : '';
    if (!text || !text.trim()) {
      this._reply(ws, msg, 'overlay:write-answer-ack', { ok: false, error: 'empty', msg: '答案文本为空' });
      return;
    }
    // bus 通知 main.js 转发给 overlayWindow
    if (this.bus) {
      try { this.bus.emit('local:write-answer-from-outside', text); } catch (_) { /* 忽略 */ }
    }
    // 更新 state（供后续 pull / 轮询读取）+ 挂 history（没有对应提问则兜底新建 fallback 轮）
    this.recordState({
      answerText: text,
      _historyAction: 'answer',
      _historyError: '',
    });
    const id = Date.now().toString(36);
    this._reply(ws, msg, 'overlay:write-answer-ack', { ok: true, id });
  }

  // ---- overlay:pull（兜底拉取最新 ASR / 答案 / 状态 + 多轮历史）----
  _handleOverlayPull(ws, msg) {
    this._reply(ws, msg, 'overlay:pull-ack', {
      asrText: this.state.asrText,
      answerText: this.state.answerText,
      isRecording: this.state.isRecording,
      lastAnswerAt: this.state.lastAnswerAt,
      questionImage: this.state.questionImage,
      // 多轮对话历史：小程序/面板端可选择解析渲染（正序数组）
      history: Array.isArray(this.state.history) ? this.state.history : [],
      historyVersion: Number(this.state.historyVersion) || 0,
      // 面试 Session：和 HTTP /api/overlay/status 保持一致
      activeSessionId: this.state.activeSessionId || null,
      sessionsVersion: Number(this.state.sessionsVersion) || 0,
    });
  }

  // ============================================================
  // 18. 截图核心：WS + HTTP 共用
  //   由外部（main.js）把 Electron 的 desktopCapturer attach 进来
  //   如果外部没 attach：返回 {error: 'unsupported'}，避免 require('electron') 在纯 Node 环境报错
  //   返回 Promise<{ data:base64, width, height, mime, sources? }>
  // ============================================================
  async _doCapture(payload) {
    const fmt = (payload && payload.format === 'png') ? 'png' : 'jpeg';
    const quality = Number(payload && payload.quality);
    const q = (quality > 0 && quality <= 1) ? quality : 0.85;
    const maxSize = Number(payload && payload.maxSize) || 1920;
    const sourceId = (payload && payload.sourceId) || null;

    if (typeof this.captureFn !== 'function') {
      const e = new Error('CAPTURE_UNSUPPORTED');
      e.code = 'unsupported';
      e.userMsg = '当前环境不支持截图';
      throw e;
    }

    try {
      return await this.captureFn({ format: fmt, quality: q, maxSize, sourceId });
    } catch (e) {
      // 统一包装错误码
      if (!e.code) {
        const m = (e.message || '').toLowerCase();
        if (m.includes('permission') || m.includes('denied') || m.includes('屏幕录制') || m.includes('录制')) {
          e.code = 'permission';
          e.userMsg = e.userMsg || '请允许电脑屏幕录制权限';
        } else if (m.includes('timeout')) {
          e.code = 'timeout';
          e.userMsg = e.userMsg || '截图超时';
        } else {
          e.code = 'internal';
          e.userMsg = e.userMsg || '截图失败：' + (e.message || '未知错误');
        }
      }
      throw e;
    }
  }

  // ============================================================
  // 面试 Session HTTP 路由 1：GET /api/sessions?keyword=&limit=&offset= → 列表摘要
  // ============================================================
  _routeApiSessionsList(req, res, parsed, reqDebug) {
    try {
      const q = (parsed && parsed.query) || {};
      const result = this.listSessions({
        keyword: q.keyword || '',
        limit: Number(q.limit) || 50,
        offset: Number(q.offset) || 0,
      });
      // 附带最新 sessionsVersion，前端可做增量刷新
      result.sessionsVersion = Number(this.state.sessionsVersion) || 0;
      this._json(res, 200, result, reqDebug);
    } catch (e) {
      console.error('[sessions][HTTP] list 异常：', e.message);
      this._json(res, 500, { ok: false, error: 'internal', msg: e.message || 'list 失败' }, reqDebug);
    }
  }

  // ============================================================
  // 面试 Session HTTP 路由 2：GET /api/sessions/:id → 详情（含完整 rounds）
  // ============================================================
  _routeApiSessionDetail(req, res, id, reqDebug) {
    try {
      const r = this.getSessionDetail(id);
      const code = r.ok ? 200 : (r.error === 'not_found' ? 404 : 500);
      if (r.ok) r.sessionsVersion = Number(this.state.sessionsVersion) || 0;
      this._json(res, code, r, reqDebug);
    } catch (e) {
      console.error('[sessions][HTTP] detail 异常：', e.message);
      this._json(res, 500, { ok: false, error: 'internal', msg: e.message || 'detail 失败' }, reqDebug);
    }
  }

  // ============================================================
  // ★ SQLite HTTP 路由 1：GET /api/db/sessions/health —— 查询健康状态 + 分类计数
  //   - 返回：{ok, ready, sessionCount, roundCount, categories:{copilot,mock}, dbPath, msg?}
  //   - SQLite 不可用：ok=false, ready=false, sqliteUnavailable=true，不抛 500（让前端优雅回退）
  // ============================================================
  _routeApiDbSessionsHealth(req, res, parsed, reqDebug) {
    try {
      // SQLite 未就绪：统一返回 sqliteUnavailable 标记
      if (!_sessionRepo || !_sessionRepo.ready) {
        return this._json(res, 200, {
          ok: false, ready: false, sqliteUnavailable: true,
          sessionCount: 0, roundCount: 0, categories: { copilot: 0, mock: 0 },
          msg: (_sessionRepo && _sessionRepo.lastError) ? _sessionRepo.lastError.message : 'SQLite 仓库未初始化',
        }, reqDebug);
      }
      const h = _sessionRepo.health();
      // 额外：按当前登录账号细分 copilot/mock 计数（Tab 徽章）
      const aid = _currentAccountIdForRepo(this);
      let cp = 0, mk = 0;
      try {
        const r1 = _sessionRepo.listSessions({ accountId: aid, category: 'copilot', limit: 1, offset: 0 });
        const r2 = _sessionRepo.listSessions({ accountId: aid, category: 'mock',    limit: 1, offset: 0 });
        cp = Number(r1 && r1.total) || 0;
        mk = Number(r2 && r2.total) || 0;
      } catch (_) { /* ignore */ }
      return this._json(res, 200, {
        ok: true, ready: true,
        sessionCount: Number(h && h.sessionCount) || 0,
        roundCount:   Number(h && h.roundCount)   || 0,
        categories: { copilot: cp, mock: mk },
        dbPath: (h && h.dbPath) ? String(h.dbPath) : '',
      }, reqDebug);
    } catch (e) {
      console.error('[db:sessions][HTTP] health 异常：', e.message);
      return this._json(res, 200, {  // 故意 200：客户端按 sqliteUnavailable 判定降级
        ok: false, ready: false, sqliteUnavailable: true,
        sessionCount: 0, roundCount: 0, categories: { copilot: 0, mock: 0 },
        msg: e && e.message ? e.message : 'health 异常',
      }, reqDebug);
    }
  }

  // ============================================================
  // ★ SQLite HTTP 路由 2：GET /api/db/sessions/list —— 分页列表（按当前账号隔离）
  //   Query: keyword?, category?('copilot'|'mock'|空=全部), limit?(1~200), offset?(>=0)
  //   返回：{ok, total, sessions:[{...category/title/badge/snippet/lastRounds...}], keyword, category, limit, offset}
  // ============================================================
  _routeApiDbSessionsList(req, res, parsed, reqDebug) {
    try {
      const q = (parsed && parsed.query) || {};
      // SQLite 不可用：sqliteUnavailable=true
      if (!_sessionRepo || !_sessionRepo.ready) {
        return this._json(res, 200, {
          ok: false, sqliteUnavailable: true,
          total: 0, sessions: [],
          keyword:  q.keyword  ? String(q.keyword)  : '',
          category: q.category ? String(q.category) : '',
          limit:    Number(q.limit)  || 50,
          offset:   Number(q.offset) || 0,
          msg: 'SQLite 仓库未就绪（桌面端可能尚未启动，或 better-sqlite3 安装异常）',
        }, reqDebug);
      }
      // category 白名单：只有 copilot/mock/空串三种有效值（非法值强制当空=全部）
      const catRaw = String(q.category || '').trim().toLowerCase();
      const category = (catRaw === 'copilot' || catRaw === 'mock') ? catRaw : '';
      const aid = _currentAccountIdForRepo(this);
      const result = _sessionRepo.listSessions({
        accountId: aid,
        keyword:   q.keyword ? String(q.keyword) : '',
        category,
        limit:  Math.max(1, Math.min(200, Number(q.limit)  || 50)),
        offset: Math.max(0, Number(q.offset) || 0),
      });
      // 兼容旧 JSON 层：加 sessionsVersion 字段（前端用它做"是否重拉"判断）
      const merged = Object.assign({ ok: true }, result, {
        keyword:         q.keyword  ? String(q.keyword)  : '',
        category:        catRaw,
        sessionsVersion: Number(this.state.sessionsVersion) || 0,
      });
      return this._json(res, 200, merged, reqDebug);
    } catch (e) {
      console.error('[db:sessions][HTTP] list 异常：', e.message);
      const q = (parsed && parsed.query) || {};
      return this._json(res, 500, {
        ok: false, error: 'internal', msg: e.message || 'list 失败',
        total: 0, sessions: [],
        keyword:  q.keyword  ? String(q.keyword)  : '',
        category: q.category ? String(q.category) : '',
        limit:    Number(q.limit)  || 50,
        offset:   Number(q.offset) || 0,
      }, reqDebug);
    }
  }

  // ============================================================
  // ★ SQLite HTTP 路由 3：GET /api/db/sessions/:id —— 详情（session + rounds + JD快照）
  //   返回：{ok:true, session:{...}, rounds:[...]}
  //         {ok:false, error:'not_found'|'forbidden'|'internal', msg:...}
  // ============================================================
  _routeApiDbSessionsGet(req, res, id, reqDebug) {
    try {
      if (!_sessionRepo || !_sessionRepo.ready) {
        return this._json(res, 200, {
          ok: false, sqliteUnavailable: true, session: null, rounds: [],
          msg: 'SQLite 仓库未就绪（桌面端可能尚未启动，或 better-sqlite3 安装异常）',
        }, reqDebug);
      }
      if (!id) {
        return this._json(res, 400, { ok: false, error: 'invalid', msg: 'sessionId 不能为空', session: null, rounds: [] }, reqDebug);
      }
      const detail = _sessionRepo.getSessionDetail(String(id));
      if (!detail || !detail.id) {
        return this._json(res, 404, {
          ok: false, error: 'not_found', msg: '未找到该面试记录（可能已删除或 sessionId 错误）',
          session: null, rounds: [],
        }, reqDebug);
      }
      // 越权：账号隔离
      const aid = _currentAccountIdForRepo(this);
      if (detail.accountId && detail.accountId !== aid) {
        console.warn(`[db:sessions][HTTP] ⚠️ 越权访问拦截：session=${id} owner=${detail.accountId} visitor=${aid}`);
        return this._json(res, 403, {
          ok: false, error: 'forbidden', msg: '无权查看他人的面试记录',
          session: null, rounds: [],
        }, reqDebug);
      }
      const rounds = Array.isArray(detail.rounds) ? detail.rounds : [];
      const sessionOnly = Object.assign({}, detail);
      delete sessionOnly.rounds;
      return this._json(res, 200, { ok: true, session: sessionOnly, rounds }, reqDebug);
    } catch (e) {
      console.error('[db:sessions][HTTP] get 异常：', e.message);
      return this._json(res, 500, {
        ok: false, error: 'internal', msg: e.message || 'get 失败', session: null, rounds: [],
      }, reqDebug);
    }
  }

  // ============================================================
  // ★ SQLite HTTP 路由 4：DELETE /api/db/sessions/:id —— 删除某场（级联 rounds）
  //   注意：只删 SQLite，不会动 JSON 文件。前端如果真想"彻底删干净"，可先调此接口再调原 JSON 层删除接口（后续迭代合并）。
  // ============================================================
  async _routeApiDbSessionsDelete(req, res, id, reqDebug) {
    try {
      // 先把 body 读完（即使不用，有些客户端会传，避免未消费 request 导致 socket hang up）
      try { await this._readJsonBody(req); } catch (_) { /* ignore */ }
      if (!_sessionRepo || !_sessionRepo.ready) {
        return this._json(res, 200, {
          ok: false, sqliteUnavailable: true,
          msg: 'SQLite 仓库未就绪（桌面端可能尚未启动，或 better-sqlite3 安装异常）',
        }, reqDebug);
      }
      if (!id) {
        return this._json(res, 400, { ok: false, error: 'invalid', msg: 'sessionId 不能为空' }, reqDebug);
      }
      // 越权：先读再判断归属（避免越权删他人）
      const aid = _currentAccountIdForRepo(this);
      const detail = _sessionRepo.getSessionDetail(String(id));
      if (!detail || !detail.id) {
        return this._json(res, 404, { ok: false, error: 'not_found', msg: '未找到该面试记录' }, reqDebug);
      }
      if (detail.accountId && detail.accountId !== aid) {
        console.warn(`[db:sessions][HTTP] ⚠️ 越权删除拦截：session=${id} owner=${detail.accountId} visitor=${aid}`);
        return this._json(res, 403, { ok: false, error: 'forbidden', msg: '无权删除他人的面试记录' }, reqDebug);
      }
      const r = _sessionRepo.deleteSession(String(id));
      if (r) return this._json(res, 200, { ok: true }, reqDebug);
      return this._json(res, 500, { ok: false, error: 'delete_fail', msg: '删除失败（可能 DB 锁或已不存在）' }, reqDebug);
    } catch (e) {
      console.error('[db:sessions][HTTP] delete 异常：', e.message);
      return this._json(res, 500, {
        ok: false, error: 'internal', msg: e.message || 'delete 失败',
      }, reqDebug);
    }
  }

  // ============================================================
  // 面试 Session HTTP 路由 3：POST /api/sessions/start-new → 开新场（body 可选 {targetCompany,targetPosition,interviewType}）
  // ============================================================
  async _routeApiSessionsStartNew(req, res, reqDebug) {
    try {
      let body = null;
      try { body = await this._readJsonBody(req); } catch (_) { body = null; }
      const r = this.startNewSession(body || undefined);
      this._json(res, 200, r, reqDebug);
    } catch (e) {
      console.error('[sessions][HTTP] start-new 异常：', e.message);
      this._json(res, 500, { ok: false, error: 'internal', msg: e.message || 'start-new 失败' }, reqDebug);
    }
  }

  // ============================================================
  // 面试 Session HTTP 路由 4：POST /api/sessions/end-active → 结束当前场
  // ============================================================
  async _routeApiSessionsEndActive(req, res, reqDebug) {
    try {
      // 吞掉可能的 body 错误（没 body 也允许）
      try { await this._readJsonBody(req); } catch (_) { /* ignore */ }
      const r = this.endActiveSession();
      this._json(res, 200, r, reqDebug);
    } catch (e) {
      console.error('[sessions][HTTP] end-active 异常：', e.message);
      this._json(res, 500, { ok: false, error: 'internal', msg: e.message || 'end-active 失败' }, reqDebug);
    }
  }

  // ============================================================
  // 面试 Session HTTP 路由 5.5：POST /api/sessions/ensure-if-ended
  //   如果上一场被显式结束（用户点×/结束按钮）→ 强制开新场；否则懒创建，不提前建 session
  //   用于：开始面试辅助按钮 / 浮层 open-overlay / 重新打开答题面板 → 任何"即将开始新答题"的入口
  //   保证：显式× 结束后不会再"继续刚刚那一场"
  // ============================================================
  async _routeApiSessionsEnsureIfEnded(req, res, reqDebug) {
    try {
      let body = null;
      try { body = await this._readJsonBody(req); } catch (_) { body = null; }
      const r = this.ensureStartNewSessionIfJustEnded(body || undefined);
      this._json(res, 200, r, reqDebug);
    } catch (e) {
      console.error('[sessions][HTTP] ensure-if-ended 异常：', e.message);
      this._json(res, 500, { ok: false, error: 'internal', msg: e.message || 'ensure-if-ended 失败' }, reqDebug);
    }
  }

  // ============================================================
  // 面试 Session HTTP 路由 6：GET /api/sessions/find-by-round?roundId=xxx → 定位 round 属于哪场 session
  //   返回：{ok:true, sessionId, roundId} 找不到返回 ok:true + sessionId=null
  // ============================================================
  _routeApiSessionsFindByRound(req, res, parsed, reqDebug) {
    try {
      const q = (parsed && parsed.query) || {};
      const roundId = q.roundId || '';
      const hit = this.findSessionByRoundId(roundId);
      this._json(res, 200, {
        ok: true,
        roundId,
        sessionId: hit ? hit.sessionId : null,
        sessionsVersion: Number(this.state.sessionsVersion) || 0,
      }, reqDebug);
    } catch (e) {
      console.error('[sessions][HTTP] find-by-round 异常：', e.message);
      this._json(res, 500, { ok: false, error: 'internal', msg: e.message || 'find-by-round 失败' }, reqDebug);
    }
  }

  // ============================================================
  // 19. 主动断开当前小程序连接（用户在二维码弹窗点"断开连接"）
  // ============================================================
  disconnectMiniapp() {
    if (!this.minSocket) return { success: true, reason: 'no_connection' };
    try {
      this.minSocket.close(4000, 'user disconnect');
    } catch (_) { /* 忽略 */ }
    this.minSocket = null;
    this._setStatus('disconnected');
    return { success: true };
  }

  // ============================================================
  // 20. 工具：从 body/loadConfigFn 合并当前用户配置（selectedService/密钥/模型档位/baseUrl 等）
  // ============================================================
  _getMergedUserConfig(bodyCfg = {}) {
    const fromFn = (typeof this.loadConfigFn === 'function') ? (this.loadConfigFn() || {}) : {};
    return Object.assign({}, fromFn, bodyCfg || {});
  }

  // ============================================================
  // 21. 模拟面试 HTTP 路由：
  //   a) POST /api/mock-interview/session
  //      新建/重启一次模拟面试：复用 startNewSession 并在 session.meta.mockInterview 存入用户配置快照
  // ============================================================
  async _routeApiMockInterviewSession(req, res, reqDebug) {
    try {
      if (!mockInterviewAgents) return this._json(res, 500, { ok: false, error: 'service', msg: '模拟面试服务不可用（mockInterviewAgents 加载失败）' }, reqDebug);
      const body = await this._readJsonBody(req).catch(() => ({}));
      // 基础校验：职位/行业/类型必填
      const typeRaw = String(body.type || '').trim();
      const type = mockInterviewAgents.normalizeType(typeRaw); // 兼容 comprehensive/technical/programming
      const targetPosition = String(body.targetPosition || '').trim();
      const industry = String(body.industry || '').trim();
      if (!typeRaw || !['behavior', 'tech', 'coding', 'stress',
        'technical', 'programming', 'comprehensive'].includes(typeRaw)) {
        return this._json(res, 400, { ok: false, error: 'invalid', msg: '请选择面试类型（behavior/tech/coding/stress/technical/programming/comprehensive）' }, reqDebug);
      }
      if (!targetPosition) return this._json(res, 400, { ok: false, error: 'invalid', msg: '请填写目标职位' }, reqDebug);
      if (!industry) return this._json(res, 400, { ok: false, error: 'invalid', msg: '请填写行业/领域' }, reqDebug);
      const totalQuestions = Math.max(1, Math.min(15, Number(body.totalQuestions) || 5));
      const answerMode = ['voice', 'text'].includes(body.answerMode) ? body.answerMode : 'text';
      const language = ['zh', 'en'].includes(body.language) ? body.language : 'zh';
      const maxFollowups = Math.max(0, Math.min(5, Number(body.maxFollowups))); // 0 表示禁用追问

      // 以用户表单为"强制配置"创建新 session（JD/简历也拍快照）
      const snapshotCfg = {
        targetCompany: String(body.targetCompany || industry || '').trim(), // 没有公司就填行业占位（原字段复用）
        targetPosition,
        interviewType: type, // behavior/tech/coding/stress
        jobDescription: String(body.jdText || '').substring(0, 20000),
        resumeText: String(body.resumeText || '').substring(0, 40000),
        // 下面这些是"模拟面试专属"扩展字段，会存进 session 的 meta 里
        _mockInterview: {
          mode: 'mockInterview', // 与真实 Copilot 面试区分
          industry,
          answerMode, // voice/text
          language,
          totalQuestions,
          maxFollowups: Number.isFinite(maxFollowups) ? maxFollowups : 2,
          currentIndex: 0,     // 已完成题数
          history: [],         // [{question,answer,followups:[{q,a}],score,highlights,improvements,summary}]
          createdAt: Date.now()
        }
      };
      const r = this.startNewSession(snapshotCfg);
      // 再把 meta 写入（startNewSession 里只支持原字段，这里扩展 mockInterview 专属部分）
      //   —— 关键修复：meta 赋值【必须放在最外层、在 try 之前】，保证即便 flush 磁盘 / s.meta 访问出错，内存中的 mockInterview 上下文仍然存在。
      //      否则如果 _flushActiveSessionToDisk 在 catch 里被吞，会造成 next-question 的 _getActiveMockCtx() 读取 mi=null 并返回『没有进行中的模拟面试』错误。
      let injectOk = false;
      const s = this._activeSessionObj;
      if (s) {
        try {
          if (!s.meta || typeof s.meta !== 'object') s.meta = {};
          s.meta.mockInterview = snapshotCfg._mockInterview;
          // 内存冗余副本：meta 字段万一被后续逻辑覆盖 / 删除，也能通过 session._mockInterviewCache 找回
          s._mockInterviewCache = snapshotCfg._mockInterview;
          injectOk = true;
        } catch (metaErr) {
          console.error('[mock-interview][HTTP] session meta 写入异常（尝试内存兜底）：', metaErr && metaErr.message);
          try { s._mockInterviewCache = snapshotCfg._mockInterview; injectOk = true; } catch (_) { injectOk = false; }
        }
        try { this._flushActiveSessionToDisk(`新建模拟面试 session=${s && s.id}`); }
        catch (flushErr) { console.warn('[mock-interview][HTTP] session flush 写磁盘失败（不影响内存运行）：', flushErr && flushErr.message); }
      }
      if (!injectOk) {
        // 真正致命：连内存兜底都失败（极罕见：_activeSessionObj 缺失） → 返回 500，前端能明确看到"创建会话失败"而非"没有进行中的模拟面试"
        return this._json(res, 500, { ok: false, error: 'internal', msg: '模拟面试会话上下文初始化失败，请重试' }, reqDebug);
      }
      this._json(res, 200, { ok: true, session: r }, reqDebug);
    } catch (e) {
      console.error('[mock-interview][HTTP] session 异常：', e.message);
      this._json(res, 500, { ok: false, error: 'internal', msg: e.message || '模拟面试启动失败' }, reqDebug);
    }
  }

  // 取 active session 中的 mockInterview 配置（若无则返回 null）
  //   —— 三级兜底：优先 meta.mockInterview（正式存储）→ 其次 s._mockInterviewCache（内存冗余，防止 flush 磁盘失败写丢）→ 最后从 session 顶层字段反向组装（极端兜底，保证至少能进入出题流程）
  _getActiveMockCtx() {
    const s = this._activeSessionObj;
    if (!s) return null;
    let mi = (s.meta && s.meta.mockInterview) || null;
    if (!mi && typeof s._mockInterviewCache === 'object' && s._mockInterviewCache !== null) {
      // 二级兜底：meta 写入时 flush 抛异常被吞的场景，内存缓存仍在
      mi = s._mockInterviewCache;
      // 顺便回填 meta，避免下一次 flush 后 meta 中仍没有 mockInterview
      try {
        if (!s.meta || typeof s.meta !== 'object') s.meta = {};
        if (!s.meta.mockInterview) s.meta.mockInterview = mi;
      } catch (_) { /* ignore 回填失败，至少这次调用拿到 mi 就够了 */ }
    }
    if (!mi) {
      // 三级兜底：mi 完全缺失（极罕见） → 从 session 顶层字段反向组装一份最小可用 mi，避免 next-question 返回『没有进行中的模拟面试』
      //   注意：反向组装出来的 mi.currentIndex=0, history=[], 等于新的一场，可能会丢掉之前的 meta，但比"拿不到题目"强得多
      if (!s.interviewType && !s.targetPosition) return null; // 连基本字段都没有 → 说明这 session 本来就不是模拟面试模式，直接返回 null
      mi = {
        mode: 'mockInterview',
        industry: (s.targetCompany || '').trim(),
        answerMode: 'text',
        language: 'zh',
        totalQuestions: 5,
        maxFollowups: 0,
        currentIndex: 0,
        history: [],
        createdAt: s.startedAt || Date.now(),
        __reconstructed: true  // 标记：本 mi 是反向组装的，便于后续排查
      };
    }
    return {
      session: s,
      mi,
      // type 取值顺序：session.interviewType（正式）> mi 中的综合映射兜底 > 最终落 'behavior'
      type: String(s.interviewType || '').trim() || (mi && mi.industry ? 'behavior' : 'behavior') || 'behavior',
      targetPosition: String(s.targetPosition || (mi && typeof mi.positionLabel === 'string' ? mi.positionLabel : '')).trim(),
      industry: String((mi && mi.industry) || s.targetCompany || '').trim(),
      jdText: s.jdSnapshot || '',
      resumeText: s.resumeSnapshot || '',
      answerMode: (mi && ['voice','text'].includes(mi.answerMode)) ? mi.answerMode : 'text',
      language: (mi && ['zh','en'].includes(mi.language)) ? mi.language : 'zh',
      totalQuestions: Math.max(1, Math.min(15, Number(mi && mi.totalQuestions) || 5)),
      maxFollowups: Number.isFinite(mi && mi.maxFollowups) ? mi.maxFollowups : 0
    };
  }

  // ============================================================
  // b) POST /api/mock-interview/next-question
  //   参数：sessionId（可选，默认用 active）
  //   返回：{ok, done:boolean, questionIndex, totalQuestions, question, focus, expected}
  // ============================================================
  async _routeApiMockInterviewNextQ(req, res, reqDebug) {
    const t0 = Date.now();
    // ===== DEBUG 日志：进入路由就打印（用户日志里没有 HTTP-IN next-question 记录，要确认请求是否真到达此处） =====
    try {
      const s = this._activeSessionObj;
      const miRaw = (s && s.meta && s.meta.mockInterview) || (s && s._mockInterviewCache) || null;
      console.log(`[mock-interview][DEBUG][next-q] ? 收到 next-question 请求：activeSession=${s && s.id || '(null)'} | agents=${mockInterviewAgents ? 'OK' : 'NULL'} | miExists=${miRaw ? 'YES' : 'NO'} | miKeys=${miRaw ? JSON.stringify(Object.keys(miRaw)) : ''} | currentIndex=${Number(miRaw && miRaw.currentIndex) || 0} | totalQuestions=${Number(miRaw && miRaw.totalQuestions) || 0}`);
    } catch (_) { /* ignore debug 日志异常 */ }
    try {
      if (!mockInterviewAgents) {
        console.error('[mock-interview][DEBUG][next-q] ✗ mockInterviewAgents === null（初始化时加载失败），返回 500');
        return this._json(res, 500, { ok: false, error: 'service', msg: '模拟面试服务不可用（mockInterviewAgents 加载失败，请查看启动日志）' }, reqDebug);
      }
      const body = await this._readJsonBody(req).catch(() => ({}));
      const ctx = this._getActiveMockCtx();
      if (!ctx) {
        // 关键：此时 activeSessionObj 可能还存在但 mi 字段丢了 → 把各兜底层级的结果全打出来，便于定位"为什么 mi=null"
        try {
          const s2 = this._activeSessionObj;
          const diags = {
            sessionExists: !!s2,
            sessionId: (s2 && s2.id) || '',
            hasMeta: !!((s2 && s2.meta) && typeof s2.meta === 'object'),
            metaMockInterviewExists: !!((s2 && s2.meta) && s2.meta.mockInterview),
            metaMockInterviewKeys: (s2 && s2.meta && s2.meta.mockInterview) ? JSON.stringify(Object.keys(s2.meta.mockInterview)) : '',
            cacheMockInterviewExists: !!((s2 && s2._mockInterviewCache) && typeof s2._mockInterviewCache === 'object'),
            cacheMockInterviewKeys: (s2 && s2._mockInterviewCache) ? JSON.stringify(Object.keys(s2._mockInterviewCache)) : '',
            interviewType: (s2 && s2.interviewType) || '',
            targetPosition: (s2 && s2.targetPosition) || ''
          };
          console.error(`[mock-interview][DEBUG][next-q] ✗ _getActiveMockCtx=null（400 将返回），诊断快照：${JSON.stringify(diags)}`);
        } catch (_) { /* ignore */ }
        return this._json(res, 400, { ok: false, error: 'invalid', msg: '没有进行中的模拟面试（请先点击『开始模拟面试』）' }, reqDebug);
      }
      const cfg = this._getMergedUserConfig(body.config);
      const done = ctx.mi.currentIndex >= ctx.totalQuestions;
      if (done) {
        // 达到总题数：给出结束提示，不继续出题
        console.log(`[mock-interview][DEBUG][next-q] ✓ 已达总题数（currentIndex=${ctx.mi.currentIndex} >= totalQuestions=${ctx.totalQuestions}），返回 done=true`);
        return this._json(res, 200, {
          ok: true,
          done: true,
          questionIndex: ctx.totalQuestions,
          totalQuestions: ctx.totalQuestions,
          message: '已完成全部题目，请点击『结束并生成复盘报告』。'
        }, reqDebug);
      }
      const questionIndex = ctx.mi.currentIndex + 1; // 第 N 题（1-based）
      // 出题前打印参数摘要（避免大段 JD/简历刷屏，只打印长度）
      console.log(`[mock-interview][DEBUG][next-q] ▶ 开始生成第 ${questionIndex}/${ctx.totalQuestions} 题：type=${ctx.type} | language=${ctx.language} | pos=${ctx.targetPosition || '(空)'} | industry=${ctx.industry || '(空)'} | jdLen=${(ctx.jdText || '').length} | resumeLen=${(ctx.resumeText || '').length} | historyLen=${(ctx.mi.history || []).length} | mi.__reconstructed=${ctx.mi.__reconstructed ? 'YES(反向组装，需关注)' : 'NO(正式 meta)'}`);
      const tGen0 = Date.now();
      let q;
      try {
        q = await mockInterviewAgents.generateQuestion({
          type: ctx.type,
          targetPosition: ctx.targetPosition,
          industry: ctx.industry,
          jdText: ctx.jdText,
          resumeText: ctx.resumeText,
          language: ctx.language,
          questionIndex,
          totalQuestions: ctx.totalQuestions,
          history: ctx.mi.history || [],
          config: cfg
        });
      } catch (genErr) {
        // ★★ 关键：generateQuestion 内部异常（LLM Key、baseURL、模型、格式解析错等）—— 这里一定打完整堆栈，否则只能看到 message 无法定位
        console.error(`[mock-interview][DEBUG][next-q] ✗ generateQuestion 抛错（用时 ${Date.now() - tGen0}ms）：message=${genErr && genErr.message}\n  完整堆栈：\n${genErr && genErr.stack || '无堆栈信息'}`);
        // 如果 cause 里有真实 HTTP 响应体，也打出来（很多 SDK 把详细错误藏在 err.cause / err.response / err.body 里）
        try {
          const extras = {};
          if (genErr && typeof genErr.response === 'object') extras.response = { status: genErr.response.status, headers: Object.keys(genErr.response.headers || {}), bodySnippet: String(genErr.response.data || genErr.response.body || '').slice(0, 500) };
          if (genErr && typeof genErr.cause === 'object') extras.cause = { message: genErr.cause.message, name: genErr.cause.name, stackHead: String(genErr.cause.stack || '').slice(0, 400) };
          if (genErr && (genErr.body || genErr.rawBody)) extras.rawBody = String(genErr.body || genErr.rawBody || '').slice(0, 500);
          if (Object.keys(extras).length > 0) console.error(`[mock-interview][DEBUG][next-q] ✗ generateQuestion 异常附加信息：${JSON.stringify(extras)}`);
        } catch (_) { /* ignore */ }
        throw genErr; // 重新抛 → 被外层 L3130 catch 捕获并返回 500
      }
      const qLen = JSON.stringify(q || {}).length;
      console.log(`[mock-interview][DEBUG][next-q] ✓ 第 ${questionIndex}/${ctx.totalQuestions} 题生成成功，用时 ${Date.now() - tGen0}ms，题目对象大小=${qLen} chars，questionPreview=${JSON.stringify(q && q.question || '').slice(0, 120)}`);
      // 把当前题挂到 session.meta.mockInterview.currentQuestion 上（提交答案时做校验）
      try {
        ctx.mi.currentQuestion = {
          index: questionIndex,
          question: q.question,
          focus: q.focus,
          expected: q.expected,
          createdAt: Date.now()
        };
        this._flushActiveSessionToDisk(`模拟面试下一题 session=${ctx.session.id}`);
      } catch (flushErr) { console.warn(`[mock-interview][DEBUG][next-q] flush 写磁盘失败（不影响返回）：${flushErr && flushErr.message}`); }
      console.log(`[mock-interview][DEBUG][next-q] ⇢ 200 OK 返回：用时总 ${Date.now() - t0}ms`);
      this._json(res, 200, {
        ok: true,
        done: false,
        questionIndex,
        totalQuestions: ctx.totalQuestions,
        question: q.question,
        focus: q.focus,
        expected: q.expected
      }, reqDebug);
    } catch (e) {
      // 外层兜底：再打一遍完整堆栈，保证万无一失
      console.error(`[mock-interview][HTTP] next-question 总异常（用时 ${Date.now() - t0}ms）：message=${e && e.message}\n  完整堆栈：\n${e && e.stack || 'no-stack'}`);
      // ★★ 翻译英文/技术错误为中文友好提示，让浮窗能直接给用户显示具体原因，而不是"生成题目失败"
      //    覆盖：401/403 鉴权、404/ENOTFOUND 域名、ECONNREFUSED 端口、内容为空、baseUrl 带反引号等常见错误
      const rawMsg = String(e && e.message || '').toLowerCase();
      const rawStack = String(e && e.stack || '').toLowerCase();
      const combined = rawMsg + '\n' + rawStack;
      let friendlyMsg = '';
      // 1) 401：未授权（API Key 错误 / 为空 / 环境变量未生效）
      if (/status\s*code\s*401|401\s*unauthorized|invalid.*api.*key|invalid.*key|apikey.*invalid/i.test(combined)) {
        friendlyMsg = '【鉴权失败·401】通义 / 百炼 API Key 无效或为空。\n请检查：① 主窗口 → 设置 → 通义 API Key 是否填写正确；② 若使用 .env 文件，请确认 IA_TONGYI_API_KEY 两侧没有反引号/引号；③ 在百炼控制台（bailian.console.aliyun.com）确认该 API Key 已启用且对应工作空间已添加白名单。';
      }
      // 2) 403：禁止访问（权限不足 / 模型无权限 / 余额不足）
      else if (/status\s*code\s*403|403\s*forbidden|access.*denied|quota.*exceed|insufficient.*balance|余额不足|欠费/i.test(combined)) {
        friendlyMsg = '【访问被拒·403】通义 / 百炼服务拒绝请求。\n请检查：① 该 API Key 对应账号是否有余额；② 所选模型（如 qvq-plus）是否已开通；③ 私有工作空间是否把该 Key 加入了成员。';
      }
      // 3) 404 / 域名解析失败 / 找不到主机：baseUrl 写错或包含反引号
      else if (/status\s*code\s*404|404\s*not\s*found|enotfound|getaddrinfo|eai_again|dns\s*error|host.*not\s*found/i.test(combined)) {
        friendlyMsg = '【域名错误·404/ENOTFOUND】通义 baseUrl 非法（域名解析失败）。\n最常见原因：.env 中的 IA_TONGYI_BASE_URL 两侧加了反引号/双引号（如 `"`https://...`"`），请手动修正 .env 为：IA_TONGYI_BASE_URL=https://llm-xxx.cn-beijing.maas.aliyuncs.com/api/v1（两侧不要加任何引号）。';
      }
      // 4) 连接被拒绝：端口错 / 服务没启动（少见，但可能用户写错了端口段）
      else if (/econnrefused|connection.*refused/i.test(combined)) {
        friendlyMsg = '【连接失败·ECONNREFUSED】baseUrl 端口或协议错误。\n请检查 IA_TONGYI_BASE_URL 是否以 https:// 开头，且不要写错端口段（百炼私有空间一般不需要端口号）。';
      }
      // 5) 超时：网络问题
      else if (/timeout|etimedout|network.*error/i.test(combined)) {
        friendlyMsg = '【网络超时】请求通义/百炼服务超时。\n请检查：① 电脑网络是否通畅；② 是否需要代理（若在公司内网，可能需要配置 HTTPS 代理）；③ 百炼服务是否可用。';
      }
      // 6) 返回空内容：模型选择错误 / 兼容端点调用方式错误（qvq-plus 需要流式调用）—— 若清理后生效，该错误通常会消失
      else if (/返回空内容|content.*empty|空内容|answerlen\s*=\s*0|no.*content/i.test(combined)) {
        friendlyMsg = '【模型返回空】LLM 返回了题目文本为空。\n常见原因：① tongyiBaseUrl 仍带反引号（请查看终端 ConfigManager.env 警告日志）；② 模型名写错；③ 私有工作空间走了错误端点（需要 /compatible-mode/v1）。请先修正 .env 后重试。';
      }
      // 7) 默认：如果 friendlyMsg 仍为空，给出原始 message + 提示查看终端日志
      if (!friendlyMsg) {
        friendlyMsg = '生成题目失败：' + String(e && e.message || '未知错误') + '。\n请查看终端日志中 [callTongyi] / [mock-interview] 前缀的错误信息，特别是 [ConfigManager.env] 中是否有 ⚠️ 警告提示你修正 .env。';
      }
      // 附加：若终端有 ConfigManager.env 警告（用户可能没注意），在错误末尾补充一句
      try {
        const cfg = (typeof this.loadConfigFn === 'function') ? (this.loadConfigFn() || {}) : {};
        const bu = String(cfg.tongyiBaseUrl || '');
        if (bu && !/^https?:\/\//i.test(bu)) {
          friendlyMsg += '（检测到 tongyiBaseUrl 清理后仍没有 http(s):// 前缀 → 这是 .env 写法错误的直接证据，请立即修正 .env！）';
        }
      } catch (_) { /* ignore：附加诊断失败不影响主错误返回 */ }
      // 把友好化后的中文 msg 返回给前端，浮窗显示给用户
      this._json(res, 500, { ok: false, error: 'internal', msg: friendlyMsg, rawError: String(e && e.message || '') }, reqDebug);
    }
  }

  // ============================================================
  // c) POST /api/mock-interview/submit-answer
  //   参数：{answer, sessionId?}
  //   返回：{ok, feedback:{score,highlights,improvements,summary},
  //              followup:{needFollowup,question?,reason?}}
  // ============================================================
  async _routeApiMockInterviewSubmitAnswer(req, res, reqDebug) {
    try {
      if (!mockInterviewAgents) return this._json(res, 500, { ok: false, error: 'service', msg: '模拟面试服务不可用' }, reqDebug);
      const body = await this._readJsonBody(req).catch(() => ({}));
      const answer = String(body.answer || '').trim();
      if (!answer) return this._json(res, 400, { ok: false, error: 'invalid', msg: '回答不能为空' }, reqDebug);
      const ctx = this._getActiveMockCtx();
      if (!ctx) return this._json(res, 400, { ok: false, error: 'invalid', msg: '没有进行中的模拟面试' }, reqDebug);
      const currentQ = ctx.mi.currentQuestion;
      if (!currentQ) return this._json(res, 400, { ok: false, error: 'invalid', msg: '当前没有待作答题目（请先『下一题』）' }, reqDebug);

      const cfg = this._getMergedUserConfig(body.config);
      const { feedback, followup } = await mockInterviewAgents.submitAnswer({
        type: ctx.type,
        question: currentQ.question,
        answer,
        resumeText: ctx.resumeText,
        jdText: ctx.jdText,
        language: ctx.language,
        followups: [],
        maxFollowups: ctx.maxFollowups,
        config: cfg
      });

      // 把本轮（主问题 + 回答 + 空 followups + 初步点评）先入 history；若要追问，会在 submit-followup 中回写
      const item = {
        question: currentQ.question,
        focus: currentQ.focus,
        expected: currentQ.expected,
        answer,
        followups: [],
        score: feedback.score,
        highlights: feedback.highlights,
        improvements: feedback.improvements,
        summary: feedback.summary,
        questionIndex: currentQ.index,
        answeredAt: Date.now()
      };
      ctx.mi.history = Array.isArray(ctx.mi.history) ? ctx.mi.history : [];
      ctx.mi.history.push(item);
      // 如果不需要追问，视为本题完成 → currentIndex + 1，并清 currentQuestion
      if (!followup || !followup.needFollowup) {
        ctx.mi.currentIndex = Number(ctx.mi.currentIndex) + 1;
        ctx.mi.currentQuestion = null;
      } else {
        // 暂存待追问信息，后续 submit-followup 用到
        ctx.mi.pendingFollowup = {
          question: followup.question,
          reason: followup.reason || '',
          startedAt: Date.now()
        };
      }
      this._flushActiveSessionToDisk(`模拟面试提交答案 session=${ctx.session.id}`);

      this._json(res, 200, {
        ok: true,
        feedback,
        followup: followup || { needFollowup: false, reason: 'no followup' },
        historyItem: item,
        currentIndex: Number(ctx.mi.currentIndex) || 0,
        totalQuestions: ctx.totalQuestions
      }, reqDebug);
    } catch (e) {
      console.error('[mock-interview][HTTP] submit-answer 异常：', e.message);
      this._json(res, 500, { ok: false, error: 'internal', msg: e.message || '提交回答失败' }, reqDebug);
    }
  }

  // ============================================================
  // c-2) POST /api/mock-interview/register-answer（浮动面板专用："无单题点评"模式）
  //   语义：仅登记答案，不调用 AI 做单题点评、不触发追问（保证所有题答完后统一 final-review）
  //   参数：{answer, sessionId?}
  //   返回：{ok, currentIndex, totalQuestions, hasNext, done}
  //         - hasNext=false 且 done=true → 调用方直接触发 final-review
  // ============================================================
  async _routeApiMockInterviewRegisterAnswer(req, res, reqDebug) {
    try {
      if (!mockInterviewAgents) return this._json(res, 500, { ok: false, error: 'service', msg: '模拟面试服务不可用' }, reqDebug);
      // 1. 读取 body + 基础校验：回答不能为空、必须有进行中的面试、必须有当前待作答题目
      const body = await this._readJsonBody(req).catch(() => ({}));
      const answer = String(body.answer || '').trim();
      if (!answer) return this._json(res, 400, { ok: false, error: 'invalid', msg: '回答不能为空' }, reqDebug);
      const ctx = this._getActiveMockCtx();
      if (!ctx) return this._json(res, 400, { ok: false, error: 'invalid', msg: '没有进行中的模拟面试' }, reqDebug);
      const currentQ = ctx.mi.currentQuestion;
      if (!currentQ) return this._json(res, 400, { ok: false, error: 'invalid', msg: '当前没有待作答题目（请先『下一题』）' }, reqDebug);

      // 2. 写入 history 项：score/highlights/improvements/summary 留空，final-review 时会统一回填/重算
      //    浮动面板模式下不启用追问（maxFollowups 语义上被忽略），每题只保留一轮 (question + answer)
      const item = {
        question: currentQ.question,
        focus: currentQ.focus,
        expected: currentQ.expected,
        answer,
        followups: [],
        score: null,
        highlights: null,
        improvements: null,
        summary: null,
        questionIndex: currentQ.index,
        answeredAt: Date.now()
      };
      ctx.mi.history = Array.isArray(ctx.mi.history) ? ctx.mi.history : [];
      ctx.mi.history.push(item);

      // 3. 推进游标：本题视为完成（不再走追问分支）→ currentIndex++，清空 currentQuestion
      ctx.mi.currentIndex = Number(ctx.mi.currentIndex) + 1;
      ctx.mi.currentQuestion = null;
      ctx.mi.pendingFollowup = null;
      this._flushActiveSessionToDisk(`模拟面试[floatwin]登记答案 session=${ctx.session.id} q#${currentQ.index}`);

      // 4. 返回 hasNext / done：让浮窗决定"出下一题"还是"直接进入总点评"
      const ci = Number(ctx.mi.currentIndex) || 0;
      const total = Number(ctx.totalQuestions) || 0;
      const hasNext = ci < total;
      const done = !hasNext;
      this._json(res, 200, {
        ok: true,
        currentIndex: ci,
        totalQuestions: total,
        hasNext,
        done,
        historyItem: item
      }, reqDebug);
    } catch (e) {
      console.error('[mock-interview][HTTP] register-answer 异常：', e.message);
      this._json(res, 500, { ok: false, error: 'internal', msg: e.message || '登记答案失败' }, reqDebug);
    }
  }

  // ============================================================
  // d) POST /api/mock-interview/submit-followup
  //   参数：{followupAnswer}  候选人回答追问
  //   返回：{ok, feedback, followup, followups, needContinue}
  //         若 needContinue=true → 继续追问；否则本题完成
  // ============================================================
  async _routeApiMockInterviewSubmitFollowup(req, res, reqDebug) {
    try {
      if (!mockInterviewAgents) return this._json(res, 500, { ok: false, error: 'service', msg: '模拟面试服务不可用' }, reqDebug);
      const body = await this._readJsonBody(req).catch(() => ({}));
      const fuAns = String(body.followupAnswer || '').trim();
      if (!fuAns) return this._json(res, 400, { ok: false, error: 'invalid', msg: '追问回答不能为空' }, reqDebug);
      const ctx = this._getActiveMockCtx();
      if (!ctx) return this._json(res, 400, { ok: false, error: 'invalid', msg: '没有进行中的模拟面试' }, reqDebug);
      const currentQ = ctx.mi.currentQuestion;
      const pending = ctx.mi.pendingFollowup;
      if (!currentQ || !pending || !pending.question) {
        return this._json(res, 400, { ok: false, error: 'invalid', msg: '当前没有待回答的追问' }, reqDebug);
      }
      const history = ctx.mi.history || [];
      const last = history[history.length - 1];
      if (!last || last.question !== currentQ.question) {
        return this._json(res, 400, { ok: false, error: 'invalid', msg: '状态异常：历史中找不到对应题目，可能已被误删除。' }, reqDebug);
      }
      const cfg = this._getMergedUserConfig(body.config);
      const { feedback, followup, followups } = await mockInterviewAgents.submitFollowupAnswer({
        type: ctx.type,
        question: currentQ.question,
        answer: last.answer,
        resumeText: ctx.resumeText,
        jdText: ctx.jdText,
        language: ctx.language,
        followups: last.followups || [],
        lastFollowupQuestion: pending.question,
        lastFollowupAnswer: fuAns,
        maxFollowups: ctx.maxFollowups,
        config: cfg
      });
      // 回写最后一道 history 的 followups 与点评
      last.followups = followups || [];
      last.score = feedback.score;
      last.highlights = feedback.highlights;
      last.improvements = feedback.improvements;
      last.summary = feedback.summary;
      last.lastFollowupAt = Date.now();

      const needContinue = !!(followup && followup.needFollowup);
      if (needContinue) {
        // 还有追问：更新 pendingFollowup
        ctx.mi.pendingFollowup = { question: followup.question, reason: followup.reason || '', startedAt: Date.now() };
      } else {
        // 本题彻底结束：index+1，清 currentQuestion / pendingFollowup
        ctx.mi.pendingFollowup = null;
        ctx.mi.currentQuestion = null;
        ctx.mi.currentIndex = Number(ctx.mi.currentIndex) + 1;
      }
      this._flushActiveSessionToDisk(`模拟面试追问提交 session=${ctx.session.id}`);
      this._json(res, 200, {
        ok: true,
        needContinue,
        feedback,
        followup: followup || { needFollowup: false },
        followups: followups || []
      }, reqDebug);
    } catch (e) {
      console.error('[mock-interview][HTTP] submit-followup 异常：', e.message);
      this._json(res, 500, { ok: false, error: 'internal', msg: e.message || '提交追问失败' }, reqDebug);
    }
  }

  // ============================================================
  // e) POST /api/mock-interview/final-review
  //   返回：{ok, review:string 复盘 MD, averageScore, totalQuestions, scores:number[]}
  // ============================================================
  async _routeApiMockInterviewFinalReview(req, res, reqDebug) {
    try {
      if (!mockInterviewAgents) return this._json(res, 500, { ok: false, error: 'service', msg: '模拟面试服务不可用' }, reqDebug);
      const body = await this._readJsonBody(req).catch(() => ({}));
      const ctx = this._getActiveMockCtx();
      if (!ctx) return this._json(res, 400, { ok: false, error: 'invalid', msg: '没有进行中的模拟面试' }, reqDebug);
      const history = Array.isArray(ctx.mi.history) ? ctx.mi.history : [];
      const cfg = this._getMergedUserConfig(body.config);
      const review = history.length ? await mockInterviewAgents.finalReview(history, cfg) : '本次模拟面试尚未产生答题记录，暂无复盘内容。';
      const scores = history.map(h => Number(h.score)).filter(n => Number.isFinite(n));
      const averageScore = scores.length ? +(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1) : 0;
      // 把最终复盘写入 session.meta.mockInterview.finalReview，并结束 active session
      try {
        ctx.mi.finalReview = review;
        ctx.mi.averageScore = averageScore;
        ctx.mi.scores = scores;
        ctx.mi.endedAt = Date.now();
        ctx.mi.done = true;
        // 结束 session：调用标准 close，这样面试记录列表会显示它
        this._closeActiveSession(true);
      } catch (_) { /* ignore */ }

      this._json(res, 200, {
        ok: true,
        review,
        averageScore,
        totalQuestions: Number(ctx.totalQuestions) || 0,
        answeredCount: history.length,
        scores
      }, reqDebug);
    } catch (e) {
      console.error('[mock-interview][HTTP] final-review 异常：', e.message);
      this._json(res, 500, { ok: false, error: 'internal', msg: e.message || '生成复盘失败' }, reqDebug);
    }
  }

  // ============================================================
  // 22. 简历解析：DOCX/PDF/TXT 统一转文本（内部工具 + HTTP 路由都用）
  //   input: {ext:'docx|pdf|txt', filePath?|fileBase64?}
  // ============================================================
  async _parseResumeToText({ ext, filePath, fileBase64 }) {
    const suffix = String(ext || '').toLowerCase().replace(/^\.+/, '');
    if (filePath && fsLib && fsLib.existsSync && fsLib.existsSync(filePath) && fsLib.readFileSync) {
      // 从本地磁盘路径读取
      const buf = fsLib.readFileSync(filePath);
      return await this._parseResumeFromBuffer(suffix, buf);
    }
    if (fileBase64) {
      // 渲染层用 Base64 传过来（渲染层没有 fs 权限时使用）
      const clean = String(fileBase64).replace(/^data:[^;]+;base64,/, '');
      const buf = Buffer.from(clean, 'base64');
      return await this._parseResumeFromBuffer(suffix, buf);
    }
    return { ok: false, text: '', error: 'parse-failed', msg: '未提供 filePath 或 fileBase64' };
  }

  async _parseResumeFromBuffer(ext, buf) {
    const sizeKB = buf ? (buf.length / 1024) : 0;
    if (!buf || !buf.length) return { ok: false, text: '', error: 'empty', msg: '文件为空' };
    try {
      if (ext === 'txt' || ext === 'md' || ext === 'log') {
        return { ok: true, text: buf.toString('utf8'), parser: 'utf8', sizeKB };
      }
      if (ext === 'docx' || ext === 'doc') {
        // DOC/DOCX：强制使用 mammoth（CJS 兼容）；失败时给出具体原因（如 mammoth 未安装 / extractRawText 不可用）
        if (mammoth && mammoth.extractRawText) {
          const r = await mammoth.extractRawText({ buffer: buf });
          return { ok: true, text: (r && typeof r.value === 'string') ? r.value : '', parser: 'mammoth', sizeKB };
        }
        const hint = mammothReason ? `（原因：${mammothReason}）` : '（原因：mammoth 未安装或 require 失败）';
        return {
          ok: false,
          text: buf.toString('utf8'),
          error: 'parser-missing',
          msg: `${ext} 解析失败：mammoth 不可用${hint}，已回退纯 UTF-8 读取（对二进制文件通常不可读，建议确认 npm install 成功并重试）。`,
          parser: 'fallback-utf8',
          sizeKB
        };
      }
      if (ext === 'pdf') {
        // PDF：统一使用顶层 pdfParserHandle.parseFn（kind=pdf-parse/pdfjs，source 指明来自哪条加载链路）
        // 为兼容异步加载（动态 import pdfjs-dist/legacy），这里先等 handle.ready：
        //   - 若 handle 已经同步 ready（A/c 段）：Promise.resolve() 立即过
        //   - 若 handle 仍在 legacy import 初始化中（B 段）：则 await 一次最多 6s，确保不会因初始化早于请求导致"解析通道不存在"
        //   - 若 handle 仍为 null（三条链路全挂）：走下方 parser-missing 详细报错
        if (!pdfParserHandle) {
          // 没拿到全局句柄时，最多再等 3 秒（避免 legacy import 异步正在初始化但请求抢先到了）
          try {
            await Promise.race([
              new Promise((res) => setTimeout(() => res(false), 3000)),
              (async () => {
                const deadline = Date.now() + 3000;
                while (!pdfParserHandle && Date.now() < deadline) {
                  // 每 80ms 检查一次句柄是否已被加载器填入
                  await new Promise((res) => setTimeout(res, 80));
                }
                return !!pdfParserHandle;
              })()
            ]);
          } catch (_) { /* ignore wait errors */ }
        }
        if (pdfParserHandle && typeof pdfParserHandle.parseFn === 'function') {
          // ready 若仍 pending 则等一下（B 段 legacy 动态 import 还在 import 中）
          if (pdfParserHandle.ready && typeof pdfParserHandle.ready.then === 'function') {
            try { await Promise.race([pdfParserHandle.ready, new Promise((res, rej) => setTimeout(() => rej(new Error('PDF 解析库初始化超时（6s）')), 6000))]); } catch (_) { /* ready 抛错不阻断 parse 本身，交给 parseFn 跑 */ }
          }
          const out = await pdfParserHandle.parseFn(buf);
          const text = typeof (out && out.text) === 'string' ? out.text : '';
          const pages = Array.isArray(out && out.pages) ? out.pages : [];
          const total = (out && typeof out.total === 'number') ? out.total : pages.length;
          return {
            ok: true,
            text,
            parser: `pdf:${pdfParserHandle.source || 'unknown'}:${pdfParserHandle.kind || 'unknown'}`,
            pages: total,
            sizeKB
          };
        }
        // 走到这里说明三条加载链路（pdf-parse → pdfjs-dist/legacy 动态 import → pdfjs-dist 主入口同步 require）都没拿到可用句柄
        const reasons = (resumeParserReasons && resumeParserReasons.length)
          ? `\n详细原因（按尝试顺序）：\n  · ${resumeParserReasons.join('\n  · ')}`
          : '';
        const suggestion = `\n建议：当前版本已把 pdf-parse 作为默认首选（已写入 package.json），请执行 npm install 保证依赖齐全；再重启应用。若仍失败：`
          + `\n  a) 确认 pdf-parse 版本在 package.json 中为最新；`
          + `\n  b) 若是 Electron 打包版，请确认 node_modules/pdf-parse 已被 asar 包含。`;
        return {
          ok: false,
          text: buf.toString('utf8'),
          error: 'parser-missing',
          msg: `PDF 解析失败：当前三条 PDF 解析通道（pdf-parse → pdfjs-dist/legacy 动态 import → pdfjs-dist 主入口）均不可用。${reasons}${suggestion}`,
          parser: 'fallback-utf8',
          sizeKB
        };
      }
      // 其他扩展名（如 .doc 二进制）：兜底按 utf8 读，提示格式不支持
      return {
        ok: false,
        text: buf.toString('utf8'),
        error: 'unsupported-ext',
        msg: `不支持的扩展名：${ext}，目前支持 DOCX / PDF / TXT / MD，已回退纯 UTF-8 读取（可能不可用）。`,
        parser: 'fallback-utf8',
        sizeKB
      };
    } catch (e) {
      // 解析过程异常（如加密 PDF / 损坏文件）：同样返回 utf8 兜底 + 真实错误信息，避免笼统"解析失败"
      return {
        ok: false,
        text: buf.toString('utf8'),
        error: 'parser-error',
        msg: `${ext} 解析异常：${e.message || '未知错误'}，已回退纯 UTF-8。若为加密/扫描 PDF / 图像 PDF，请先 OCR 或转成可复制文本的 PDF（简历图像建议先粘贴文本）。`,
        parser: 'fallback-utf8',
        sizeKB
      };
    }
  }

  // ============================================================
  // 简历优化 HTTP 路由
  //   a) POST /api/resume-opt/parse-file
  // ============================================================
  async _routeApiResumeOptParseFile(req, res, reqDebug) {
    try {
      const body = await this._readJsonBody(req).catch(() => ({}));
      const ext = String(body.ext || '').toLowerCase();
      const filePath = body.filePath ? String(body.filePath) : '';
      const fileBase64 = body.fileBase64 ? String(body.fileBase64) : '';
      if (!ext) return this._json(res, 400, { ok: false, error: 'invalid', msg: '缺少 ext：docx/pdf/txt' }, reqDebug);
      const r = await this._parseResumeToText({ ext, filePath, fileBase64 });
      this._json(res, 200, Object.assign({ ok: !!r.ok }, r), reqDebug);
    } catch (e) {
      console.error('[resume-opt][HTTP] parse-file 异常：', e.message);
      this._json(res, 500, { ok: false, error: 'internal', msg: e.message || '解析失败' }, reqDebug);
    }
  }

  // ============================================================
  // b) POST /api/resume-opt/run
  //   串行跑 ATS/关键词/内容优化 三个 agent；若 onStage 需要广播可后续接入 WS/bus
  // ============================================================
  async _routeApiResumeOptRun(req, res, reqDebug) {
    try {
      if (!resumeOptAgents) return this._json(res, 500, { ok: false, error: 'service', msg: '简历优化服务不可用（resumeOptAgents 加载失败）' }, reqDebug);
      const body = await this._readJsonBody(req).catch(() => ({}));
      const resumeText = String(body.resumeText || '').trim();
      if (resumeText.length < 50) return this._json(res, 400, { ok: false, error: 'invalid', msg: '简历文本过短（至少 50 字）' }, reqDebug);
      const jdText = String(body.jdText || '').trim();
      const language = ['zh', 'en'].includes(body.language) ? body.language : 'zh';
      const cfg = this._getMergedUserConfig(body.config);
      const result = await resumeOptAgents.run({ resumeText, jdText, language, config: cfg });
      // 也把本次优化结果缓存到 localStorage 替代方案：简单写入 active session 不存在就忽略
      this._json(res, 200, { ok: true, result }, reqDebug);
    } catch (e) {
      console.error('[resume-opt][HTTP] run 异常：', e.message);
      this._json(res, 500, { ok: false, error: 'internal', msg: e.message || '简历优化失败' }, reqDebug);
    }
  }

  // ============================================================
  // c) POST /api/resume-opt/export-docx
  //   参数：{content:'优化后全文', savePath:'D:/xxx.docx'（主进程传）, filename?}
  //   主进程会用 dialog.showSaveDialog 拿到 savePath 再过来调
  // ============================================================
  async _routeApiResumeOptExportDocx(req, res, reqDebug) {
    try {
      const body = await this._readJsonBody(req).catch(() => ({}));
      const content = String(body.content || '').trim();
      const savePath = String(body.savePath || '').trim();
      if (!content) return this._json(res, 400, { ok: false, error: 'invalid', msg: '导出内容为空' }, reqDebug);
      if (!savePath) return this._json(res, 400, { ok: false, error: 'invalid', msg: '缺少 savePath' }, reqDebug);
      if (!docxLib) return this._json(res, 500, { ok: false, error: 'service', msg: '未安装 docx 库，导出 DOCX 不可用' }, reqDebug);
      if (!fsLib || !fsLib.writeFileSync) return this._json(res, 500, { ok: false, error: 'service', msg: 'fs 不可用' }, reqDebug);
      // DOCX：逐行构建 Paragraph（空行也给一个空段落），列表（- / •）作为 bullet
      const { Document, Packer, Paragraph, TextRun } = docxLib;
      const lines = content.split(/\r?\n/);
      const children = lines.map(line => {
        const isBullet = /^\s*([-*•]|\d+[\.、)])\s+/.test(line);
        const text = line.replace(/^\s+([-*•]|\d+[\.、)])\s+/, '').replace(/\s+$/g, '');
        return new Paragraph({
          spacing: { after: 120 },
          bullet: isBullet ? isBullet : undefined,
          children: [new TextRun({ text: text.length ? text : ' ', size: 22, font: 'Calibri' })],
        });
      });
      const doc = new Document({
        creator: 'Interview Assist',
        title: '优化后简历',
        sections: [{ properties: {}, children }]
      });
      const buffer = await Packer.toBuffer(doc);
      fsLib.writeFileSync(savePath, Buffer.from(buffer));
      this._json(res, 200, { ok: true, savePath, bytes: buffer.length }, reqDebug);
    } catch (e) {
      console.error('[resume-opt][HTTP] export-docx 异常：', e.message);
      this._json(res, 500, { ok: false, error: 'internal', msg: e.message || '导出失败' }, reqDebug);
    }
  }

  // ============================================================
  // c2) POST /api/resume-opt/export-md
  //   参数：{content:'优化后全文', savePath:'D:/xxx.md', addFrontMatter?:boolean}
  //   说明：渲染层先通过 Electron dialog.showSaveDialog 拿到 savePath，再调用本接口落盘；
  //         可选自动附加 YAML front-matter（标题/时间戳/来源），默认关闭以保证文件内容"所见即所得"。
  // ============================================================
  async _routeApiResumeOptExportMd(req, res, reqDebug) {
    try {
      const body = await this._readJsonBody(req).catch(() => ({}));
      // 兼容 content / text / mdContent 三种字段名，避免未来调用方传参漂移
      const rawContent = String(body.content || body.text || body.mdContent || '');
      const content = body.normalizeEol !== false
        ? rawContent.replace(/\r\n|\r(?!\n)/g, '\n') // 归一化为 \n（md 规范）
        : rawContent;
      let savePath = String(body.savePath || '').trim();
      if (!content) return this._json(res, 400, { ok: false, error: 'invalid', msg: '导出内容为空' }, reqDebug);
      if (!savePath) return this._json(res, 400, { ok: false, error: 'invalid', msg: '缺少 savePath' }, reqDebug);
      if (!fsLib || !fsLib.writeFileSync) return this._json(res, 500, { ok: false, error: 'service', msg: 'fs 不可用' }, reqDebug);

      // 自动补扩展名：用户选路径时没写 .md/.markdown 的话，默认加 .md（保持与 showSaveDialog filters 一致）
      const lower = savePath.toLowerCase();
      if (!lower.endsWith('.md') && !lower.endsWith('.markdown') && !lower.endsWith('.txt')) {
        savePath += '.md';
      }

      // 可选附加 front-matter：默认关闭，用户通过 body.addFrontMatter=true 开启
      let finalText = content;
      if (body.addFrontMatter === true) {
        const title = String(body.title || '优化后简历').replace(/"/g, '\\"');
        const now = new Date();
        const pad2 = (n) => String(n).padStart(2, '0');
        const date = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
        const fm = `---\ntitle: "${title}"\ndate: "${date}"\ngenerated_by: Interview Assist Resume Optimizer\n---\n\n`;
        finalText = fm + content;
      }

      const buf = Buffer.from(finalText, 'utf8');
      fsLib.writeFileSync(savePath, buf);
      this._json(res, 200, { ok: true, savePath, bytes: buf.length }, reqDebug);
    } catch (e) {
      console.error('[resume-opt][HTTP] export-md 异常：', e.message);
      this._json(res, 500, { ok: false, error: 'internal', msg: e.message || '导出 Markdown 失败' }, reqDebug);
    }
  }

  // ============================================================
  // d1) POST /api/resume-opt/ats
  //   参数：{resumeText, jdText?, language?, config?}
  //   返回：{ok:true, stage:'ats', result: ATSScoringAgent.score() 结果}
  // 目的：给渲染层"阶段一完成就立刻渲染 ATS 卡片"，提升进度感知
  // ============================================================
  async _routeApiResumeOptATS(req, res, reqDebug) {
    try {
      if (!resumeOptAgents) return this._json(res, 500, { ok: false, error: 'service', msg: '简历优化服务不可用' }, reqDebug);
      const body = await this._readJsonBody(req).catch(() => ({}));
      const resumeText = String(body.resumeText || '').trim();
      if (resumeText.length < 50) return this._json(res, 400, { ok: false, error: 'invalid', msg: '简历文本过短（<50 字）' }, reqDebug);
      const cfg = this._getMergedUserConfig(body.config);
      const result = await resumeOptAgents.runATS({
        resumeText,
        jdText: String(body.jdText || '').trim(),
        language: ['zh', 'en'].includes(body.language) ? body.language : 'zh',
        config: cfg
      });
      this._json(res, 200, { ok: true, stage: 'ats', result }, reqDebug);
    } catch (e) {
      console.error('[resume-opt][HTTP] ats 异常：', e.message);
      this._json(res, 500, { ok: false, error: 'internal', msg: e.message || 'ATS 阶段失败' }, reqDebug);
    }
  }

  // ============================================================
  // d2) POST /api/resume-opt/keywords
  //   参数：{resumeText, jdText?, language?, config?}
  //   返回：{ok:true, stage:'keywords', result: KeywordMatchAgent.match() 结果}
  // ============================================================
  async _routeApiResumeOptKeywords(req, res, reqDebug) {
    try {
      if (!resumeOptAgents) return this._json(res, 500, { ok: false, error: 'service', msg: '简历优化服务不可用' }, reqDebug);
      const body = await this._readJsonBody(req).catch(() => ({}));
      const resumeText = String(body.resumeText || '').trim();
      if (resumeText.length < 50) return this._json(res, 400, { ok: false, error: 'invalid', msg: '简历文本过短（<50 字）' }, reqDebug);
      const cfg = this._getMergedUserConfig(body.config);
      const result = await resumeOptAgents.runKeywords({
        resumeText,
        jdText: String(body.jdText || '').trim(),
        language: ['zh', 'en'].includes(body.language) ? body.language : 'zh',
        config: cfg
      });
      this._json(res, 200, { ok: true, stage: 'keywords', result }, reqDebug);
    } catch (e) {
      console.error('[resume-opt][HTTP] keywords 异常：', e.message);
      this._json(res, 500, { ok: false, error: 'internal', msg: e.message || '关键词阶段失败' }, reqDebug);
    }
  }

  // ============================================================
  // d3) POST /api/resume-opt/content
  //   参数：{resumeText, jdText?, language?, config?}
  //   返回：{ok:true, stage:'content', result: ContentOptAgent.optimize() 结果}
  // ============================================================
  async _routeApiResumeOptContent(req, res, reqDebug) {
    try {
      if (!resumeOptAgents) return this._json(res, 500, { ok: false, error: 'service', msg: '简历优化服务不可用' }, reqDebug);
      const body = await this._readJsonBody(req).catch(() => ({}));
      const resumeText = String(body.resumeText || '').trim();
      if (resumeText.length < 50) return this._json(res, 400, { ok: false, error: 'invalid', msg: '简历文本过短（<50 字）' }, reqDebug);
      const cfg = this._getMergedUserConfig(body.config);
      const result = await resumeOptAgents.runContent({
        resumeText,
        jdText: String(body.jdText || '').trim(),
        language: ['zh', 'en'].includes(body.language) ? body.language : 'zh',
        config: cfg
      });
      this._json(res, 200, { ok: true, stage: 'content', result }, reqDebug);
    } catch (e) {
      console.error('[resume-opt][HTTP] content 异常：', e.message);
      this._json(res, 500, { ok: false, error: 'internal', msg: e.message || '内容优化阶段失败' }, reqDebug);
    }
  }
}

// 单例导出
const _localHttpServerSingleton = new LocalHttpServer();
// 同时导出"注入 SQLite 仓储"入口（main.js 启动 singleton 后立即调用）
_localHttpServerSingleton.setSessionRepository = setSessionRepository;
_localHttpServerSingleton.createSessionRepo = function createSessionRepo(dbPath) {
  // 便利：外部直接通过此方法 new SessionRepo，不需要自己再 require
  if (!SessionRepoCtor) {
    console.warn('[localHttpServer][sqlite-sync] ⚠️ createSessionRepo 失败：SessionRepoCtor 未成功加载');
    return null;
  }
  try { return new SessionRepoCtor(dbPath); }
  catch (e) {
    console.error('[localHttpServer][sqlite-sync] new SessionRepoCtor 抛错：', e.message);
    return null;
  }
};
module.exports = _localHttpServerSingleton;
