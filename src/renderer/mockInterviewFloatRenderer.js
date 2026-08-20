/**
 * src/renderer/mockInterviewFloatRenderer.js
 * ------------------------------------------------------------
 * 渲染层：模拟面试浮动面板（独立 BrowserWindow）的全部逻辑。
 *
 * 功能范围：
 *   1. 接收主进程下发的『启动参数』（answerMode、总题数、语言、serverInfo 等）
 *   2. 锁死作答方式（语音 / 文字），UI 只展示不可切换
 *   3. 调用本地 HTTP：session → next-question → register-answer（无单题点评）→ final-review
 *   4. 语音模式：
 *        - 自动启动麦克风监听（复用 electronAPI.startAsrPipeline / onAsrInterim / onAsrFinal）
 *        - 识别结果实时写入 readonly textarea
 *        - 10 秒无有效语音（VAD）自动触发『提交本题答案 → 下一题』
 *        - 进入下一题作答环节时，麦克风再次自动启动
 *   5. 文字模式：仅显示『提交回答』按钮，用户点击后推进题目
 *   6. 所有题目答完后：调用 final-review 获取统一总点评并渲染 markdown
 *   7. 『结束面试』按钮：立即停止麦克风并跳转 final-review
 *
 * 不生成任何测试文件；不新增模拟数据。
 * 每个函数都有中文注释说明其作用。
 * ------------------------------------------------------------
 */
(function () {
  'use strict';

  // ------------------------------------------------------------
  // 0. 基础工具：$ / $$ / toast / lightMarkdown / apiFetch
  // ------------------------------------------------------------
  const $ = (sel) => (sel && document.querySelector ? document.querySelector(sel) : null);
  const $$ = (sel) => (sel && document.querySelectorAll ? Array.from(document.querySelectorAll(sel)) : []);

  /**
   * 浮窗内嵌 toast：右上角浮层提示，不依赖主窗口 renderer.js
   * @param {string} msg  提示文案
   * @param {'info'|'success'|'warn'|'error'} level 级别
   * @param {number} ms   显示时长（毫秒）
   */
  function toast(msg, level = 'info', ms = 2800) {
    try {
      const box = $('#miToastContainer');
      if (!box) return;
      const el = document.createElement('div');
      el.className = `mi-toast level-${level}`;
      el.textContent = String(msg || '');
      box.appendChild(el);
      setTimeout(() => {
        el.style.transition = 'opacity .3s ease, transform .3s ease';
        el.style.opacity = '0';
        el.style.transform = 'translateY(-6px)';
        setTimeout(() => { try { box.removeChild(el); } catch (_) { /* ignore */ } }, 320);
      }, ms);
    } catch (_) { /* 即使 toast 出错也不影响主流程 */ }
  }

  /**
   * 极轻量 Markdown → HTML（不需要引入 markdown 库）
   *   - 转义 &<>"'；- 标题、粗体、列表、代码块、换行、引用
   */
  function lightMarkdown(md) {
    const s = String(md || '');
    const esc = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const codeBlocks = [];
    // 代码块（```）先占位避免被换行切
    let withCode = esc.replace(/```([\s\S]*?)```/g, (_m, body) => {
      codeBlocks.push(body); return `\u0000CODE${codeBlocks.length - 1}\u0000`;
    });
    let html = withCode
      .replace(/^######\s*(.+)$/gm, '<h6>$1</h6>')
      .replace(/^#####\s*(.+)$/gm, '<h5>$1</h5>')
      .replace(/^####\s*(.+)$/gm, '<h4>$1</h4>')
      .replace(/^###\s*(.+)$/gm, '<h3>$1</h3>')
      .replace(/^##\s*(.+)$/gm, '<h2>$1</h2>')
      .replace(/^#\s*(.+)$/gm, '<h1>$1</h1>')
      .replace(/^\s*[-*•]\s+(.+)$/gm, '<li>$1</li>')
      .replace(/^\s*\d+[\.、)）]\s+(.+)$/gm, '<li>$1</li>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/^>\s*(.+)$/gm, '<blockquote>$1</blockquote>')
      .replace(/\n{2,}/g, '</p><p>')
      .replace(/\n/g, '<br/>');
    html = `<p>${html}</p>`;
    html = html.replace(/<\/li><br\/?><li>/g, '</li><li>');
    html = html.replace(/(<li>[^<]+<\/li>(\s*<br\/?>\s*<li>[^<]+<\/li>)+)/g, '<ul>$1</ul>');
    html = html.replace(/(<blockquote>[^<]+<\/blockquote>(\s*<br\/?>\s*<blockquote>[^<]+<\/blockquote>)+)/g, '$1');
    html = html.replace(/\u0000CODE(\d+)\u0000/g, (_m, idx) => `<pre><code>${codeBlocks[Number(idx)] || ''}</code></pre>`);
    return html;
  }

  // ------------------------------------------------------------
  // 1. HTTP 封装：复用 serverInfo（启动参数传入），避免重复走 IPC 查 HTTP 信息
  // ------------------------------------------------------------
  /** 本地服务信息：由主进程 startParams.serverInfo 下发 */
  let _serverInfo = { baseUrl: '', token: '' };
  /** 是否已完成 _serverInfo 初始化 */
  let _serverReady = false;

  // ------------------------------------------------------------
  // 0.2 IPC 双通道封装（浮窗专用）：优先 electronAPI bridge，失败自动退回 ipcRenderer.invoke / on
  //      原因：浮窗 webPreferences 显式配了 preload.js + contextIsolation=false，理论上 electronAPI 一定存在；
  //            但为避免 preload 运行时异常 / 字段未完整挂载（例如兜底 catch 吞了异常）导致整面板不可用，
  //            所有与主进程通信的入口均走『双通道』模式，electronAPI 优先，ipcRenderer 兜底。
  // ------------------------------------------------------------
  /** 统一获取 ipcRenderer（contextIsolation=false + nodeIntegration=true 时一定可用） */
  function getIPC() {
    if (window.ipcRenderer) return window.ipcRenderer;
    try { if (window.require) return window.require('electron').ipcRenderer; } catch (_) { /* ignore */ }
    return null;
  }
  /** 统一异步 invoke（双通道：electronAPI.<camelFn>() → ipcRenderer.invoke(channel)） */
  async function _ipcCall(camelFnName, kebabChannel, ...args) {
    if (window.electronAPI && typeof window.electronAPI[camelFnName] === 'function') {
      try { return await window.electronAPI[camelFnName](...args); }
      catch (e) { console.warn(`[float-ipc][A→B] ${camelFnName} 异常，退回 ipcRenderer.invoke(${kebabChannel})：`, e.message); }
    }
    const ipc = getIPC();
    if (!ipc) throw new Error(`IPC 不可用（${camelFnName} / ${kebabChannel}）`);
    return ipc.invoke(kebabChannel, ...args);
  }
  /** 统一事件订阅（双通道：electronAPI.on<Camel>(cb) → ipcRenderer.on(channel, cb)）；返回取消订阅函数 */
  function _ipcOn(electronAPIName, rendererChannel, cb) {
    if (typeof cb !== 'function') return function () {};
    // 通道 A：electronAPI.onXxx(cb)，约定 electronAPI 返回 unsubscribe 函数
    if (window.electronAPI && typeof window.electronAPI[electronAPIName] === 'function') {
      try {
        const unsub = window.electronAPI[electronAPIName](cb);
        if (typeof unsub === 'function') return unsub;
      } catch (e) { console.warn(`[float-ipc][on-A→B] ${electronAPIName} 异常，退回 ipcRenderer.on(${rendererChannel})：`, e.message); }
    }
    // 通道 B：直接 ipcRenderer.on + 返回 removeListener 包装
    const ipc = getIPC();
    if (!ipc) return function () {};
    const handler = (_evt, ...a) => { try { cb(...a); } catch (_) { /* ignore cb 内部异常 */ } };
    try { ipc.on(rendererChannel, handler); } catch (_) { return function () {}; }
    return function () { try { ipc.removeListener(rendererChannel, handler); } catch (_) { /* ignore */ } };
  }
  // 浮窗专用：封装好的具体 IPC 函数（对应 main.js / preload.js 通道命名）
  const F_IPC = {
    getServerStatus: () => _ipcCall('getServerStatus', 'get-server-status'),
    // HTTP 客户端专用：返回扁平 {ok, port, token, baseUrl, isRunning}，服务未启动时会自动启动，层级稳定无嵌套
    getHttpInfo: () => _ipcCall('getHttpInfo', 'get-server-http-info'),
    startAsrPipeline: (cfg) => _ipcCall('startAsrPipeline', 'start-asr-pipeline', cfg),
    stopAsrPipeline: () => _ipcCall('stopAsrPipeline', 'stop-asr-pipeline'),
    closeFloatWin: () => _ipcCall('closeMockInterviewFloatWin', 'close-mock-interview-floatwin'),
    onAsrInterim: (cb) => _ipcOn('onAsrInterim', 'asr:interim', cb),
    onAsrFinal: (cb) => _ipcOn('onAsrFinal', 'asr:final', cb),
    onRecordingStatus: (cb) => _ipcOn('onRecordingStatus', 'asr:recording-status', cb),
    onMockStartParams: (cb) => _ipcOn('onMockInterviewStartParams', 'mock-interview:start-params', cb),
    /**
     * 单向通知主进程：浮窗已收到并处理 startParams（主进程据此取消后续补发定时器，避免重复推送）。
     * 用 ipcRenderer.send 轻量通知，不需要主进程返回值。
     */
    notifyStartedAck: () => {
      try {
        const ipc = getIPC();
        if (!ipc || typeof ipc.send !== 'function') return false;
        ipc.send('mock-interview:started-ack');
        return true;
      } catch (_) { return false; }
    },
    /**
     * ★ 终极兜底：HTTP 代理 IPC 通道（主进程 Node.js 代发请求）
     *   作用：当渲染层 fetch 被 Chromium 同源/CSP 拦截（抛 "Failed to fetch" / status=0）时，
     *   apiFetch 自动回退到此通道。Node.js http/https 模块无任何协议/策略限制，100% 能通。
     *   请求：{ url, method, headers, body, timeoutMs }
     *   返回：{ ok, status, statusText, data(json 或 null), rawText, elapsedMs, errorMsg }
     */
    httpProxy: (req) => _ipcCall('httpProxy', 'mock-interview:http-proxy', req)
  };

  // ------------------------------------------------------------
  // 1.2 F_DIAG：浮窗 → 主进程 诊断日志单向通道（排障专用，不影响业务流程）
  //      解决：浮窗 DevTools Console 日志在主进程终端看不到，用户难以判断"浮窗 boot 走到了哪一步"。
  //      行为：
  //        - 极轻量（ipcRenderer.send 单向，无回值，send 失败静默吞掉）
  //        - 内容统一脱敏 + 长度裁剪（最大 600 字 IPC payload，避免卡顿）
  //        - main.js 通过 ipcMain.on('mock-interview:diagnostic') 统一打印到主进程终端（带 wcId）
  // ------------------------------------------------------------
  const F_DIAG = {
    /**
     * 将诊断信息发送到主进程（单向通知，无回值，所有异常静默）
     * @param {'info'|'warn'|'error'} level
     * @param {string} tagMsg 短标签+主消息，如 "[boot] 来源=IPC-PUSH，startParams 快照"
     * @param {string} [summaryText] 额外摘要文本（最长 420 字，超出自动截断，内部自动脱敏）
     */
    send(level, tagMsg, summaryText) {
      try {
        const ipc = getIPC();
        if (!ipc || typeof ipc.send !== 'function') return; // 极端情况：IPC 完全不可用时直接放弃诊断
        const safeLevel = (level === 'warn' || level === 'error') ? level : 'info';
        const safeTagMsg = String(tagMsg || '').slice(0, 180);
        // 双重脱敏：替换 JSON 字符串中可能出现的完整 Bearer Token（如 "Bearer sk-xxx..." → "Bearer ***"）
        let safeSummary = String(summaryText == null ? '' : summaryText)
          .replace(/Bearer\s+[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]{12,}/gi, 'Bearer ***')
          .replace(/("token"\s*:\s*")[^"]{8,}(")/g, '$1***$2')
          .slice(0, 420);
        ipc.send('mock-interview:diagnostic', {
          level: safeLevel,
          ts: Date.now(),
          tagMsg: safeTagMsg,
          summary: safeSummary
        });
      } catch (_) { /* 诊断通道绝对不能抛异常影响主流程 */ }
    }
  };

  /**
   * 辅助：打印结构化日志（浮窗里统一带前缀 + 脱敏 token）
   *   - 同时写入：① 渲染层 DevTools Console（F12 可见）
   *                ② 通过 F_DIAG.send → 主进程终端（用户直接可见，无需开 DevTools）
   * @param {'info'|'warn'|'error'} level
   * @param {string} tag    短标签，如 [boot] / [apiFetch] / [next-q]
   * @param {string} msg    主消息
   * @param {any} [extra]   额外对象（自动 JSON.stringify → 脱敏 → 裁剪）
   */
  function log(level, tag, msg, extra) {
    const fn = (level === 'warn') ? console.warn : ((level === 'error') ? console.error : console.log);
    const prefix = `[float]${tag}`;
    // 发到 DevTools Console（原始完整信息）
    try {
      if (extra === undefined) fn(`${prefix} ${msg}`);
      else fn(`${prefix} ${msg}`, extra);
    } catch (_) { /* ignore：极端情况 console 不可用 */ }
    // 发到主进程终端（脱敏 + 裁剪）
    try {
      let extraSummary = '';
      if (extra !== undefined) {
        try {
          if (typeof extra === 'string' || typeof extra === 'number' || typeof extra === 'boolean') extraSummary = String(extra);
          else extraSummary = JSON.stringify(extra);
        } catch (_) { try { extraSummary = String(extra); } catch (_e) { extraSummary = '[unserializable]'; } }
      }
      F_DIAG.send(level, `${tag} ${msg}`, extraSummary);
    } catch (_) { /* ignore */ }
  }

  /**
   * 辅助：对 token 进行脱敏输出，只保留前后 4 位（避免日志泄漏）；空值返回 '<empty>'
   * @param {string} [t]
   * @returns {string}
   */
  function maskToken(t) {
    const s = String(t || '');
    if (!s) return '<empty>';
    if (s.length <= 8) return s.slice(0, 2) + '***';
    return `${s.slice(0, 4)}***${s.slice(-4)}(len=${s.length})`;
  }

  /**
   * 辅助：把当前 _serverInfo 输出为快照（脱敏）
   * @returns {{ready:boolean, baseUrl:string, tokenMasked:string}}
   */
  function snapshotServerInfo() {
    return {
      ready: !!_serverReady,
      baseUrl: (_serverInfo && _serverInfo.baseUrl) ? _serverInfo.baseUrl : '<empty>',
      tokenMasked: maskToken((_serverInfo && _serverInfo.token) || '')
    };
  }

  /**
   * 辅助：从 window.location.search 中读取并解析 startParams（主进程"保险 1"写入的 query 参数）。
   * 用于兜底：即便所有 IPC 'mock-interview:start-params' 事件因竞态丢失，也能直接从 URL decode 拿到启动参数。
   * @returns {object|null} 解析成功返回对象，否则返回 null
   */
  function tryReadStartParamsFromURL() {
    try {
      if (!window || !window.location || typeof window.location.search !== 'string') return null;
      const usp = new URLSearchParams(window.location.search);
      const raw = usp.get('startParams');
      if (!raw || typeof raw !== 'string' || raw.trim().length === 0) {
        log('warn', '[URL]', `search 中没有 startParams 参数：search=${window.location.search.slice(0, 120)}`);
        return null;
      }
      const parsed = JSON.parse(decodeURIComponent(raw));
      if (!parsed || typeof parsed !== 'object') {
        log('warn', '[URL]', `startParams parse 后不是对象：type=${typeof parsed}`);
        return null;
      }
      log('info', '[URL]', `startParams 从 URL query 解析成功：keys=${JSON.stringify(Object.keys(parsed))} serverInfo.port=${Number((parsed.serverInfo && parsed.serverInfo.port) || 0)} serverInfo.token=${maskToken((parsed.serverInfo && parsed.serverInfo.token) || '')}`);
      return parsed;
    } catch (e) {
      log('error', '[URL]', `startParams 从 URL query 解析失败：${e && e.message} | search=${(window && window.location && window.location.search) ? window.location.search.slice(0, 200) : 'no-location'} | stack=${e && e.stack || 'no-stack'}`);
      return null;
    }
  }

  /**
   * 初始化 serverInfo（启动参数传入或 IPC 兜底查询）
   * @param {{port?:number, token?:string, baseUrl?:string}} info
   */
  function initServerInfo(info) {
    if (!info) info = {};
    const port = Number(info.port) || 0;
    const base = info.baseUrl || (port ? `http://127.0.0.1:${port}` : '');
    _serverInfo = {
      baseUrl: base ? String(base).replace(/\/$/, '') : '',
      token: String(info.token || '')
    };
    _serverReady = !!(base && _serverInfo.token);
  }

  /**
   * 统一 HTTP 调用：POST JSON + Bearer Token
   * @param {string} path   路径，如 /api/mock-interview/next-question
   * @param {object} payload body
   * @returns {Promise<any>} 返回 json.ok=true 时的 payload；否则抛 Error（err.payload = 完整 json）
   */
  async function apiFetch(path, payload) {
    log('info', `[apiFetch][${path}]`, `发起请求前 _serverInfo 快照：${JSON.stringify(snapshotServerInfo())}`);
    if (!_serverReady) {
      // 兜底 1：优先用 F_IPC.getHttpInfo() → 对应 main.js get-server-http-info
      //         扁平结构 {ok, port, token, baseUrl}，且服务未启动时会自动启动（最稳）
      log('warn', `[apiFetch][${path}]`, `_serverReady=false，执行兜底 1：F_IPC.getHttpInfo()`);
      const info = await F_IPC.getHttpInfo().catch((e) => { log('warn', `[apiFetch][${path}]`, `兜底 1 IPC 异常：${e && e.message}`); return null; });
      log('info', `[apiFetch][${path}]`, `兜底 1 返回：${JSON.stringify({ ok: info && info.ok, port: info && Number(info.port) || 0, token: maskToken(info && info.token), baseUrl: (info && info.baseUrl) || '' })}`);
      if (info && info.ok && Number(info.port) > 0 && String(info.token || '').length > 0) {
        initServerInfo({
          port: Number(info.port) || 0,
          token: String(info.token || ''),
          baseUrl: String(info.baseUrl || '')
        });
      }
    }
    if (!_serverReady) {
      // 兜底 2：F_IPC.getServerStatus()（对应 get-server-status 嵌套结构 {ok, status:{port,token,...}}）
      //         兼容读取两种层级：st.status.port（真实）或 st.port（扁平）
      log('warn', `[apiFetch][${path}]`, `兜底 1 后 _serverReady 仍=false，执行兜底 2：F_IPC.getServerStatus()`);
      const st = await F_IPC.getServerStatus().catch((e) => { log('warn', `[apiFetch][${path}]`, `兜底 2 IPC 异常：${e && e.message}`); return null; });
      const nested = st && st.status ? st.status : null;
      const port = Number((nested && nested.port) || (st && st.port)) || 0;
      const token = String((nested && nested.token) || (st && st.token) || '');
      log('info', `[apiFetch][${path}]`, `兜底 2 解析结果：port=${port} token=${maskToken(token)}`);
      if (port > 0 && token.length > 0) initServerInfo({ port, token, baseUrl: `http://127.0.0.1:${port}` });
    }
    if (!_serverReady) {
      // 两次兜底都失败：明确打出"为何仍未就绪"
      log('error', `[apiFetch][${path}]`, `两次兜底后 _serverReady 仍=false，最终 _serverInfo：${JSON.stringify(snapshotServerInfo())}`);
      throw new Error('本地服务未就绪，请先从主窗口启动模拟面试。');
    }
    const url = _serverInfo.baseUrl + path;
    // ============================================================
    // ★ 策略调整：默认走【主进程 Node.js IPC HTTP 代理】，Chromium fetch 仅作为反向兜底
    //
    // 背景：日志反复验证（本次两次请求 100% 命中）—— file:// 页面在当前用户环境下
    //       直接 fetch http://127.0.0.1:28765 时，Chromium 网络栈必定悬停：
    //       onBeforeRequest 打印 → onSendHeaders 不打印 → 90s/150s 超时 → abort → IPC 兜底成功。
    //       这意味着 fetch 主路径每道题都先让用户等 90s 惩罚，毫无意义。
    // 收益对比（next-question 一次）：
    //   · 旧方案：90s 超时 + 5s LLM ≈ 95s → 用户体验极差
    //   · 新方案：立即走 IPC → Node http 代发 → 5s LLM ≈ 5s → 瞬间看到题目
    // 风险：本地 JSON 请求 < 2KB，IPC 序列化/反序列化 < 0.5ms，完全可忽略。
    //
    // 兜底顺序：
    //   1) 默认走 F_IPC.httpProxy（主进程 Node http/https 模块代发）
    //   2) 若 IPC 代理也失败（理论罕见，如主进程挂/代理通道未注册），回退 Chromium fetch（12s 短超时）
    // ============================================================
    const isNextQuestion = path && path.indexOf('next-question') >= 0;
    const isFinalReview = path && path.indexOf('final-review') >= 0;
    const proxyTimeoutMs = isNextQuestion
      ? 120000     // 题目生成：LLM 通常 5-20s，给 120s 长超时（覆盖极慢的私有部署）
      : isFinalReview
        ? 200000   // 总点评：多轮答案汇总+点评，给 200s 够宽
        : 40000;    // register-answer / session 等本地接口：40s 足够
    log('info', `[apiFetch][${path}]`, `主路径【主进程 IPC HTTP 代理】：POST ${url} | Authorization=Bearer ${maskToken(_serverInfo.token)} | payloadKeys=${JSON.stringify(Object.keys(payload || {}))} | timeout=${proxyTimeoutMs}ms`);
    try {
      const proxyResult = await F_IPC.httpProxy({
        url,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json;charset=utf-8',
          'Authorization': `Bearer ${_serverInfo.token}`
        },
        body: payload || {},
        timeoutMs: proxyTimeoutMs
      });
      // IPC 代理返回：{ ok, status, statusText, data, rawText, errorMsg, elapsedMs }
      const pr = proxyResult || {};
      // 拿 json：优先 data（主进程已按 JSON 解析），否则解析 rawText
      let json = pr.data || null;
      if (!json && typeof pr.rawText === 'string' && pr.rawText.length > 0) {
        try { json = JSON.parse(pr.rawText); } catch (_) { json = null; }
      }
      if (!json) json = {};
      log('info', `[apiFetch][${path}]`, `[proxy-OK] IPC 代理返回：HTTP ${pr.status || 0} elapsed=${Number(pr.elapsedMs)||0}ms ok=${!!(json && json.ok) ? 'true' : 'false'} keys=${JSON.stringify(Object.keys(json || {}))} msgPreview=${JSON.stringify((json && (json.msg || json.error)) || (pr.errorMsg || '')).slice(0, 120)}`);
      // 统一判断：代理层 HTTP 成功（2xx）且业务层 ok=true → 返回 json
      const httpOk = (pr.status >= 200 && pr.status < 300) && !!pr.ok;
      if (httpOk && json.ok) {
        return json;
      }
      // 统一抛错（HTTP 非 2xx / 业务 ok=false / 代理层失败）
      const msgFallback = (json && (json.msg || json.error)) || pr.errorMsg || `HTTP ${pr.status || 0}`;
      log('error', `[apiFetch][${path}]`, `[proxy-FAIL] IPC 代理失败：status=${pr.status||0} json.ok=${!!(json&&json.ok)} msg=${JSON.stringify(msgFallback)} | json=${JSON.stringify(json).slice(0, 800)} | proxyError=${String(pr.errorMsg||'').slice(0, 300)}`);
      const errFb = new Error(msgFallback);
      errFb.payload = json || null;
      errFb.status = Number(pr.status) || 0;
      errFb.url = url;
      errFb._viaProxy = true;
      throw errFb;
    } catch (proxyErr) {
      // ===========================================
      // ★ 反向兜底：IPC 代理失败时回退 Chromium fetch（防止主进程代理通道未注册/异常）
      //   给出较短超时 12s（即使悬停也只惩罚 12s，远小于原 90s/150s）
      // ===========================================
      const pMsg = String(proxyErr && proxyErr.message || proxyErr || '').slice(0, 200);
      log('warn', `[apiFetch][${path}]`, `⟲ IPC 代理失败（"${pMsg}"），回退到 Chromium fetch（12s 短超时）请求 ${url}`);
      const abortCtl = new AbortController();
      const abortTimer = setTimeout(() => {
        try { abortCtl.abort(new Error('fetch fallback timeout after 12s')); } catch (_) {}
      }, 12000);
      let res;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json;charset=utf-8',
            'Authorization': `Bearer ${_serverInfo.token}`
          },
          body: JSON.stringify(payload || {}),
          signal: abortCtl.signal
        });
        clearTimeout(abortTimer);
      } catch (netErr) {
        clearTimeout(abortTimer);
        const netMsg = String(netErr && netErr.message || netErr || '');
        log('error', `[apiFetch][${path}]`, `❌ 双通道都失败：IPC="${pMsg}" | fetch="${netMsg.slice(0,200)}"`);
        const finalErr = new Error('网络异常：' + (netMsg ? netMsg : pMsg));
        finalErr.payload = null;
        finalErr.cause = proxyErr || netErr || null;
        finalErr.status = 0;
        finalErr._bothFailed = true;
        throw finalErr;
      }
      const json = await res.json().catch(() => ({}));
      log('info', `[apiFetch][${path}]`, `[fallback-fetch-OK] Chromium fetch 成功（IPC 异常场景兜底）：HTTP ${res.status} ok=${json && json.ok} keys=${JSON.stringify(Object.keys(json || {}))}`);
      if (!res.ok || !json.ok) {
        const msg = (json && (json.msg || json.error)) || `HTTP ${res.status}`;
        log('error', `[apiFetch][${path}]`, `[fallback-fetch-FAIL] HTTP 失败：status=${res.status} ok=${json && json.ok} msg=${msg}`);
        const err = new Error(msg);
        err.payload = json;
        err.status = Number(res.status) || 0;
        err.url = url;
        throw err;
      }
      return json;
    }
  }

  // ------------------------------------------------------------
  // 2. 浮窗状态：与"当前面试生命周期"一致
  // ------------------------------------------------------------
  const FloatState = {
    /** 作答方式：'voice' | 'text'（启动后锁死，不可切换） */
    answerMode: 'text',
    /** 总题数 */
    totalQuestions: 5,
    /** 面试语言 'zh' | 'en' */
    language: 'zh',
    /** 面试类型标签（显示用） */
    typeLabel: '综合',
    /** 当前题目索引（从 1 开始显示；后端 currentIndex 是已完成数） */
    currentIndexDisplay: 0,
    /** 浮窗当前阶段：'loading' | 'question' | 'answering' | 'transition' | 'final' */
    phase: 'loading',
    /** 语音识别：最后一次收到 ASR 事件的时间戳（ms） */
    lastAsrAt: 0,
    /** 语音识别：最后一次"有效文本变更"的时间戳（ms），VAD 以此为主 */
    lastTextChangeAt: 0,
    /** 已落定的识别文本（合并进 textarea 的稳定部分） */
    asrFinalText: '',
    /** 正在识别的草稿文本（临时显示在 textarea 末尾，灰体区分）—— 实际合并时直接整体拼接 */
    asrInterimText: '',
    /** VAD 定时器句柄：setInterval 每 200ms 检查一次静默时长 */
    vadTimer: null,
    /** 静默时长上限（秒）：用户要求 1 分钟（太长容易误答为"不说话了"，1 分钟足够思考 + 停顿） */
    SILENCE_LIMIT_SEC: 60,
    /** 标志：是否正在执行『自动提交』动作（避免 VAD 重复触发多次 submit） */
    submitting: false,
    /** 标志：ASR 管线是否已启动（语音模式下每道题需要重启） */
    asrStarted: false,
    /** ASR 事件取消订阅函数集合（窗口关闭时统一清理） */
    unsubscribeFns: []
  };

  // ------------------------------------------------------------
  // 3. DOM 元素引用：集中缓存，避免每次渲染都 querySelector
  // ------------------------------------------------------------
  const DOM = {};
  function cacheDomRefs() {
    DOM.body = document.body;
    DOM.title = $('#miTitle');
    DOM.typeBadge = $('#miTypeBadge');
    DOM.langBadge = $('#miLangBadge');
    DOM.modeBadge = $('#miModeBadge');
    DOM.progress = $('#miProgress');

    DOM.questionText = $('#miQuestionText');
    DOM.questionTag = $('#miQuestionTag');

    DOM.answerEditor = $('#miAnswerEditor');
    DOM.answerLabel = $('#miAnswerLabel');

    DOM.voiceRow = $('#miVoiceRow');
    DOM.voicePillText = $('#miVoicePillText');
    DOM.silenceFill = $('#miSilenceFill');
    DOM.silenceNum = $('#miSilenceNum');
    DOM.voiceStatusSlot = $('#miVoiceStatusSlot');

    DOM.submitBtn = $('#miSubmitBtn');
    DOM.endBtn = $('#miEndBtn');

    DOM.finalCard = $('#miFinalCard');
    DOM.finalAvgScore = $('#miFinalAvgScore');
    DOM.finalTotal = $('#miFinalTotal');
    DOM.finalReviewBody = $('#miFinalReviewBody');
    DOM.finalTitle = $('#miFinalTitle');

    DOM.scrollBody = $('#miScrollBody');
  }

  // ------------------------------------------------------------
  // 4. UI 更新：模式切换 / 进度 / 题目渲染 / 静默进度
  // ------------------------------------------------------------
  /**
   * 根据 answerMode 设置 body[data-mode]，驱动 CSS 显示差异：
   *   - voice：显示 miVoiceRow；隐藏提交按钮；textarea readonly
   *   - text：  隐藏 miVoiceRow；显示提交按钮；textarea 可编辑
   */
  function applyModeUI() {
    if (!DOM.body) return;
    const mode = FloatState.answerMode === 'voice' ? 'voice' : 'text';
    DOM.body.setAttribute('data-mode', mode);
    // 徽章：模式 + 配色
    if (DOM.modeBadge) {
      DOM.modeBadge.textContent = (mode === 'voice') ? '模式：语音（锁定）' : '模式：文字（锁定）';
      DOM.modeBadge.classList.remove('mode-voice', 'mode-text');
      DOM.modeBadge.classList.add(mode === 'voice' ? 'mode-voice' : 'mode-text');
    }
    // textarea：语音模式只读（用户不能手动改识别结果）；文字模式可编辑
    if (DOM.answerEditor) {
      if (mode === 'voice') DOM.answerEditor.setAttribute('readonly', 'readonly');
      else DOM.answerEditor.removeAttribute('readonly');
    }
    // 语音行：仅语音模式显示
    if (DOM.voiceRow) DOM.voiceRow.style.display = (mode === 'voice') ? 'flex' : 'none';
  }

  /** 更新顶部进度徽章：第 X / Y 题 */
  function updateProgressUI() {
    if (!DOM.progress) return;
    const cur = Math.max(0, Number(FloatState.currentIndexDisplay) || 0);
    const total = Math.max(0, Number(FloatState.totalQuestions) || 0);
    DOM.progress.textContent = `第 ${cur} / ${total} 题`;
  }

  /**
   * 渲染当前题目到 UI
   * @param {{question:string, focus?:string, expected?:string, index?:number, total?:number}} q
   */
  function renderQuestion(q) {
    FloatState.currentIndexDisplay = Number(q && q.index) || (FloatState.currentIndexDisplay + 1) || 1;
    updateProgressUI();
    if (DOM.questionText) DOM.questionText.textContent = (q && q.question) || '（题目加载失败）';
    if (DOM.questionTag) {
      const tag = q && q.focus ? String(q.focus) : '';
      if (tag) { DOM.questionTag.textContent = tag; DOM.questionTag.style.display = 'inline-block'; }
      else DOM.questionTag.style.display = 'none';
    }
    // 空答案区
    if (DOM.answerEditor) DOM.answerEditor.value = '';
    FloatState.asrFinalText = '';
    FloatState.asrInterimText = '';
    FloatState.lastAsrAt = Date.now();
    FloatState.lastTextChangeAt = Date.now();
    // 清空静默进度
    updateSilenceUI(0);
  }

  /**
   * 更新 60 秒（1 分钟）静默进度条 + 数字
   * @param {number} sec 当前静默秒数（0 ~ SILENCE_LIMIT_SEC）
   */
  function updateSilenceUI(sec) {
    const s = Math.max(0, Math.min(Number(sec) || 0, FloatState.SILENCE_LIMIT_SEC));
    const pct = (s / FloatState.SILENCE_LIMIT_SEC) * 100;
    if (DOM.silenceFill) DOM.silenceFill.style.width = `${pct}%`;
    if (DOM.silenceNum) DOM.silenceNum.textContent = `静默 ${s.toFixed(1)}s / ${FloatState.SILENCE_LIMIT_SEC}s`;
  }

  /**
   * 语音模式：把"最终文本 + 临时文本"合并进 textarea；
   * 临时文本末尾追加『…』暗示识别中
   */
  function mergeVoiceTextToEditor() {
    if (!DOM.answerEditor) {
      log('warn', `[mergeVoiceText] DOM.answerEditor 不存在，跳过写入。asrFinal=${JSON.stringify(FloatState.asrFinalText||'').slice(0,60)} interim=${JSON.stringify(FloatState.asrInterimText||'').slice(0,60)}`);
      return;
    }
    const fin = FloatState.asrFinalText || '';
    const interim = FloatState.asrInterimText || '';
    if (!fin && !interim) { DOM.answerEditor.value = ''; return; }
    // 末尾无空白自动加一个空格，方便"识别结果追加"视觉不挤
    let value = fin;
    if (value && !/\s$/.test(value)) value += ' ';
    if (interim) value += interim + '…';
    const toWrite = value.trim();
    // ★ 诊断日志：第一次写入时打印本次写入的关键信息，便于定位"赋值了但 UI 没刷新"的根因
    const isFirstWrite = !FloatState._firstVoiceWriteDone;
    if (isFirstWrite && toWrite) FloatState._firstVoiceWriteDone = true;
    DOM.answerEditor.value = toWrite;
    // 自动滚动到底部
    try { DOM.answerEditor.scrollTop = DOM.answerEditor.scrollHeight; } catch (_) { /* ignore */ }
    if (isFirstWrite || (interim && interim.length % 5 === 0)) {
      log('info', `[mergeVoiceText] 写入作答区 len=${toWrite.length} finalLen=${fin.length} interimLen=${interim.length} readonly=${DOM.answerEditor.readOnly} hidden=${DOM.answerEditor.classList && DOM.answerEditor.classList.contains('hidden') ? 'YES' : 'no'} textareaPreview="${toWrite.slice(0, 40)}"`);
    }
  }

  // ------------------------------------------------------------
  // 5. ASR / VAD：语音模式的"自动监听 + 60s 静默自动提交"核心逻辑
  // ------------------------------------------------------------
  /**
   * 启动 ASR 管线：语音模式下『进入一道新题的作答环节』时调用。
   * 做幂等：若已启动则先停止，保证 clean state（避免上一题残留串字）。
   */
  async function startASR() {
    if (FloatState.answerMode !== 'voice') return;
    try {
      // 先停上一题的 ASR（若有），保证状态干净
      await stopASR(true);
      // 使用双通道 F_IPC.startAsrPipeline（优先 electronAPI，失败自动退回 ipcRenderer.invoke）
      // ★ 关键参数（主进程 start-asr-pipeline 会据此切换管线行为）：
      //   - transcribeOnly: true —— 纯转写模式：跳过"问题检测 + AI 答题"，
      //     避免用户说出的回答被误判为"面试官提问"而触发 AI 抢答；同时不污染主面板 history。
      //   - inputSource: 'mic' —— 采集源切换为麦克风（native.startMicrophone），
      //     模拟面试是用户对着麦克风说话；默认的 WASAPI Loopback 只能抓扬声器播放的系统声音。
      //   百度密钥等配置由主进程从应用配置/环境变量兜底合并，无需浮窗传入。
      const r = await F_IPC.startAsrPipeline({ transcribeOnly: true, inputSource: 'mic' })
        .catch((e) => ({ success: false, error: (e && e.message) || '启动异常' }));
      if (!r || !r.success) {
        const msg = (r && r.error) || '启动失败';
        toast('麦克风监听启动失败：' + msg, 'error', 4200);
        setVoicePillText(`启动失败：${msg}`);
        return;
      }
      FloatState.asrStarted = true;
      setVoicePillText('麦克风监听中…请开始作答');
      toast(`麦克风已启动，开始作答后将自动识别；${FloatState.SILENCE_LIMIT_SEC} 秒（1 分钟）无有效语音会自动提交本题。`, 'info', 3600);
      // =====================================================================
      // 注册 ASR 事件订阅（临时 + 最终 + 录制态）：
      //   ① 先走 F_IPC 双通道（electronAPI.onXxx 优先，失败回退 ipcRenderer.on）
      //   ② ★ 再额外加一层『渲染层 ipcRenderer.on 直连兜底』—— 彻底避免 electronAPI.onAsrInterim
      //     在某些环境下（contextIsolation=false + preload 异常）虽然返回了 unsubscribe 函数，
      //     但实际回调从未触发的情况。直连兜底与 F_IPC 订阅共存：收到事件时去重（以文本+时间戳判定）。
      // =====================================================================
      log('info', `[ASR-sub] 注册订阅：F_IPC.onAsrInterim 通道是否可用=${typeof F_IPC.onAsrInterim} | electronAPI.onAsrInterim=${typeof (window.electronAPI && window.electronAPI.onAsrInterim)}`);
      FloatState.unsubscribeFns.push(F_IPC.onAsrInterim(handleAsrInterim));
      FloatState.unsubscribeFns.push(F_IPC.onAsrFinal(handleAsrFinal));
      FloatState.unsubscribeFns.push(F_IPC.onRecordingStatus(handleRecordingStatus));
      // —— ② 渲染层直连兜底（与 F_IPC 双通道并行，双保险）——
      const _rawIpc = getIPC();
      let _dedupInterim = '';
      const _rawInterim = (_evt, text) => {
        // 如果和上一次 interim 完全相同（F_IPC 已处理过），跳过，避免重复写 UI 与 VAD 锚点重置
        const t = String(text || '');
        if (t === _dedupInterim) return;
        _dedupInterim = t;
        handleAsrInterim(t);
      };
      let _dedupFinal = '';
      const _rawFinal = (_evt, text) => {
        const t = String(text || '');
        // final 去重：同一文本 500ms 内只处理一次（F_IPC + 直连会各收 1 次）
        const key = `${t.length}:${t.slice(0, 30)}`;
        if (key === _dedupFinal && Date.now() - (FloatState._lastFinalAt || 0) < 500) return;
        _dedupFinal = key;
        FloatState._lastFinalAt = Date.now();
        handleAsrFinal(t);
      };
      const _rawRec = (_evt, b) => handleRecordingStatus(b);
      if (_rawIpc && typeof _rawIpc.on === 'function') {
        try { _rawIpc.on('asr:interim', _rawInterim); } catch (_) {}
        try { _rawIpc.on('asr:final', _rawFinal); } catch (_) {}
        try { _rawIpc.on('asr:recording-status', _rawRec); } catch (_) {}
        log('info', `[ASR-sub] 直连兜底订阅：ipcRenderer.on('asr:interim/final/recording-status') 已挂`);
        FloatState.unsubscribeFns.push(() => {
          try { _rawIpc.removeListener('asr:interim', _rawInterim); } catch (_) {}
          try { _rawIpc.removeListener('asr:final', _rawFinal); } catch (_) {}
          try { _rawIpc.removeListener('asr:recording-status', _rawRec); } catch (_) {}
        });
      } else {
        log('warn', `[ASR-sub] 无法挂直连兜底：getIPC()=${_rawIpc}（此为严重警告：若 electronAPI 也失效则浮窗永远收不到 ASR 文本）`);
      }
      // 启动 VAD 定时器：每 200ms 检查一次"静默时长达 10s 否"
      startVADTimer();
      // 重置静默时间锚点
      FloatState.lastAsrAt = Date.now();
      FloatState.lastTextChangeAt = Date.now();
    } catch (e) {
      console.error('[float][voice] startASR 异常：', e && e.message);
      toast('麦克风启动异常：' + (e.message || '未知错误'), 'error', 4200);
    }
  }

  /**
   * 停止 ASR + 取消事件订阅 + 停止 VAD 定时器。
   * @param {boolean} silent 是否静默停止（不更新 UI 文案/不发 toast）
   */
  async function stopASR(silent = false) {
    // ① 停 VAD 定时器
    if (FloatState.vadTimer) {
      clearInterval(FloatState.vadTimer);
      FloatState.vadTimer = null;
    }
    // ② 取消所有 ASR 事件订阅
    while (FloatState.unsubscribeFns.length) {
      const fn = FloatState.unsubscribeFns.pop();
      try { if (typeof fn === 'function') fn(); } catch (_) { /* ignore */ }
    }
    // ③ 调主进程 stopAsrPipeline（双通道 F_IPC，electronAPI/ipcRenderer 任选其一能成功即可）
    if (FloatState.asrStarted) {
      try { await F_IPC.stopAsrPipeline().catch(() => null); } catch (_) { /* ignore */ }
    }
    FloatState.asrStarted = false;
    if (!silent) {
      setVoicePillText('麦克风已暂停');
      updateSilenceUI(0);
    }
  }

  /**
   * VAD：启动定时器，每 200ms 检查一次"静默时长"。
   * 触发条件：从『最后一次文本有效变更』到现在 >= SILENCE_LIMIT_SEC（60 秒/1 分钟），且答案文本非空 → 自动 submit。
   *
   * 说明：
   *   - 『60 秒无有效语音输入』定义为：答案文本在 60 秒内没有任何新增/变化。
   *   - 这比单纯用"音频音量 RMS"更贴合语义：用户如果只在哼气/敲键盘，ASR 不会出字，也视为无效。
   *   - 若答案文本为空，即使满 60 秒也不提交（避免空答案），改弹 toast 提示一次。
   */
  function startVADTimer() {
    if (FloatState.vadTimer) clearInterval(FloatState.vadTimer);
    let emptyHintedAt = 0;  // 答案为空时：避免每 60s 弹一次 toast 刷屏，记录上次提示时间
    FloatState.vadTimer = setInterval(() => {
      if (FloatState.answerMode !== 'voice') return;
      if (FloatState.phase !== 'answering') return;
      if (FloatState.submitting) return;
      const now = Date.now();
      const silentSec = (now - FloatState.lastTextChangeAt) / 1000;
      updateSilenceUI(silentSec);
      if (silentSec >= FloatState.SILENCE_LIMIT_SEC) {
        const ansText = String(DOM.answerEditor && DOM.answerEditor.value || '').trim();
        if (ansText) {
          // ✅ 有效静默 60s（1 分钟）+ 非空答案 → 自动提交
          toast(`连续 ${FloatState.SILENCE_LIMIT_SEC}s（1 分钟）无有效语音变更，自动提交本题答案…`, 'info', 2400);
          submitAnswer(true);  // true = 自动触发（VAD）
        } else {
          // ⚠️ 空答案：不提交；仅提示一次，避免每 60s 弹 toast
          if (now - emptyHintedAt > FloatState.SILENCE_LIMIT_SEC * 1000 * 3) {
            toast(`已 ${FloatState.SILENCE_LIMIT_SEC}s（1 分钟）未作答，请对着麦克风说话，或点击右下角『结束面试并生成报告』。`, 'warn', 3600);
            emptyHintedAt = now;
          }
          // 重置静默锚点，避免下次立即再触发；给用户更多作答时间
          FloatState.lastTextChangeAt = now;
          updateSilenceUI(0);
        }
      }
    }, 200);
  }

  /** 设置语音胶囊的文字（呼吸灯右侧描述） */
  function setVoicePillText(t) {
    if (DOM.voicePillText) DOM.voicePillText.textContent = String(t || '');
  }

  /** ASR 临时文本回调：并入 asrInterimText，更新编辑器 + 刷新"有效变更时间" */
  function handleAsrInterim(text) {
    const t = String(text || '');
    // ★ 诊断日志：确认事件真的从主进程广播到了浮窗渲染层
    log('info', `[asr-interim] 收到文本 len=${t.length} preview="${t.slice(0, 40)}" | DOM.answerEditor.exists=${!!DOM.answerEditor} | tagName=${DOM.answerEditor ? DOM.answerEditor.tagName : 'NULL'}`);
    const last = FloatState.asrInterimText;
    FloatState.asrInterimText = t;
    FloatState.lastAsrAt = Date.now();
    if (t !== last) {
      // 临时文本也算"有效变更"——用户正在说话
      FloatState.lastTextChangeAt = Date.now();
    }
    mergeVoiceTextToEditor();
  }

  /**
   * ASR 最终文本回调：拼接到 asrFinalText，清空 asrInterimText。
   * 合并后立刻更新"有效变更时间"，VAD 从新锚点重新计 60 秒（1 分钟）
   */
  function handleAsrFinal(text) {
    const t = String(text || '');
    if (!t) return;
    // ★ 诊断日志：确认 final 事件真的到达浮窗
    log('info', `[asr-final] 收到文本 len=${t.length} text="${t.slice(0, 60)}" | DOM.answerEditor.exists=${!!DOM.answerEditor}`);
    // 最终文本追加：若末尾无标点/无空白，自动加一个空格，提升可读性
    let fin = FloatState.asrFinalText || '';
    if (fin && !/[\s，。,.!?！？；;：:]$/.test(fin)) fin += ' ';
    fin += t;
    FloatState.asrFinalText = fin;
    FloatState.asrInterimText = '';
    FloatState.lastAsrAt = Date.now();
    FloatState.lastTextChangeAt = Date.now();
    mergeVoiceTextToEditor();
  }

  /** 主进程 recording-status 回调：仅用于 UI 状态显示（不影响核心逻辑） */
  function handleRecordingStatus(isRecording) {
    if (isRecording) setVoicePillText('麦克风监听中…识别你的回答');
    else setVoicePillText('麦克风已暂停（等待下一题）');
  }

  // ------------------------------------------------------------
  // 6. 题目流程推进：获取下一题 → 提交答案 → 循环 → 最终点评
  // ------------------------------------------------------------
  /**
   * 获取下一题并渲染：
   *   - 若接口返回 done=true → 直接进入 final-review
   *   - 否则进入 'answering' 阶段；语音模式自动启动麦克风
   */
  async function fetchAndRenderNextQuestion() {
    FloatState.phase = 'transition';
    const nextNo = Math.max(1, (Number(FloatState.currentIndexDisplay) || 0) + 1);
    log('info', '[next-q]', `开始获取第 ${nextNo} 题，phase=transition，_serverInfo=${JSON.stringify(snapshotServerInfo())}`);
    if (DOM.questionText) {
      DOM.questionText.innerHTML = `<span class="mi-loading"><span class="mi-spinner"></span> 正在生成第 ${nextNo} 题…</span>`;
    }
    setActionsDisabled(true);
    try {
      const q = await apiFetch('/api/mock-interview/next-question', {});
      log('info', '[next-q]', `接口成功：done=${q && q.done} keys=${JSON.stringify(Object.keys(q || {}))} questionPreview=${JSON.stringify((q && q.question) || '').slice(0, 120)}`);
      if (q && q.done) {
        // 全部题完成 → 直接进入最终点评
        toast('题目已全部作答完毕，正在生成总点评…', 'info', 3000);
        await fetchAndRenderFinalReview();
        return;
      }
      renderQuestion(q);
      FloatState.phase = 'answering';
      setActionsDisabled(false);
      // 语音模式：进入"作答环节" → 自动启动麦克风
      if (FloatState.answerMode === 'voice') {
        try { await startASR(); } catch (_) { /* ignore */ }
      }
    } catch (e) {
      // 关键日志：打出 status / url / 完整 payload，避免只打 message 丢细节
      const diag = {
        message: e && e.message,
        status: Number(e && e.status) || 0,
        url: String(e && e.url || ''),
        payloadKeys: (e && e.payload && Array.isArray(Object.keys(e.payload))) ? Object.keys(e.payload) : null,
        payloadPreview: (e && e.payload) ? JSON.stringify(e.payload).slice(0, 800) : null
      };
      log('error', '[next-q]', `获取题目失败：${JSON.stringify(diag)} | 完整堆栈：${e && e.stack || 'no-stack'}`);
      toast('获取题目失败：' + (e.message || '未知错误'), 'error', 4200);
      FloatState.phase = 'question';
      setActionsDisabled(false);
    }
  }

  /**
   * 提交当前题答案 → 调用 register-answer（无单题点评，仅登记 + 推进游标）
   *   - 语音模式：先停麦克风（VAD 也会被 stopASR 清理），避免提交后继续识别
   *   - 文字模式：仅读取 textarea 内容
   * @param {boolean} fromVAD 是否来自 VAD 自动触发（仅日志/提示区分）
   */
  async function submitAnswer(fromVAD = false) {
    if (FloatState.submitting) return;
    const ansText = String(DOM.answerEditor && DOM.answerEditor.value || '').trim();
    if (!ansText) { toast('回答不能为空', 'warn', 2400); return; }
    FloatState.submitting = true;
    setActionsDisabled(true);
    FloatState.phase = 'transition';
    try {
      // ① 语音模式：先停 ASR + VAD，保证不再出字
      if (FloatState.answerMode === 'voice') await stopASR(true);
      // ② 调 register-answer：登记答案并推进题目索引
      const r = await apiFetch('/api/mock-interview/register-answer', { answer: ansText });
      toast(fromVAD ? '答案已登记，进入下一题…' : `已提交第 ${Number(FloatState.currentIndexDisplay) || 1} 题答案`, 'success', 2000);
      // ③ 判断是否还有下一题
      if (r && r.done) {
        // 所有题答完 → final-review
        toast('所有题目已回答完毕，正在生成总点评…', 'info', 3000);
        await fetchAndRenderFinalReview();
        return;
      }
      // ④ 还有下一题 → 自动出下一题
      await fetchAndRenderNextQuestion();
    } catch (e) {
      console.error('[float][submit] 异常：', e && e.message);
      toast('提交答案失败：' + (e.message || '未知错误'), 'error', 4200);
      FloatState.phase = 'answering';
      setActionsDisabled(false);
      // 失败时：语音模式重新启动麦克风（让用户继续说）
      if (FloatState.answerMode === 'voice') { try { await startASR(); } catch (_) { /* ignore */ } }
    } finally {
      FloatState.submitting = false;
    }
  }

  /**
   * 结束面试并生成复盘报告（用户主动点击『结束面试』）：
   *   - 停麦克风（如有）
   *   - 调 final-review 接口
   *   - 渲染最终点评卡片
   */
  async function endInterviewAndFinalReview() {
    if (FloatState.phase === 'final') return; // 已在最终页，不重复
    if (!confirmEarlyEnd()) return;  // 兜底确认（避免用户误触，但不使用原生 confirm；下方自定义弹窗兜底）
    FloatState.phase = 'transition';
    setActionsDisabled(true);
    try {
      // 停麦克风
      if (FloatState.answerMode === 'voice') await stopASR(true);
    } catch (_) { /* ignore */ }
    try {
      toast('正在生成最终总点评…请稍候', 'info', 4200);
      await fetchAndRenderFinalReview();
    } catch (e) {
      console.error('[float][end] 异常：', e && e.message);
      toast('生成复盘失败：' + (e.message || '未知错误'), 'error', 4200);
      FloatState.phase = 'answering';
      setActionsDisabled(false);
      if (FloatState.answerMode === 'voice') { try { await startASR(); } catch (_) { /* ignore */ } }
    }
  }

  /** 提前结束面试的兜底确认：如果当前还有进行中的答案，提示一次（toast + 3s 冷却再接受第二次点击） */
  let _lastEndClickAt = 0;
  function confirmEarlyEnd() {
    const ansText = String(DOM.answerEditor && DOM.answerEditor.value || '').trim();
    if (!ansText) return true;
    const now = Date.now();
    if (now - _lastEndClickAt < 3200) { _lastEndClickAt = 0; return true; } // 3s 内再点 → 确认通过
    _lastEndClickAt = now;
    toast('当前题答案尚未登记，再次点击『结束面试』将丢弃本题并生成报告。', 'warn', 3200);
    return false;
  }

  /**
   * 调 final-review 接口并渲染总点评卡片（进入 'final' 阶段）
   */
  async function fetchAndRenderFinalReview() {
    FloatState.phase = 'final';
    // 显示 loading
    if (DOM.finalCard) DOM.finalCard.classList.remove('hidden');
    if (DOM.finalReviewBody) {
      DOM.finalReviewBody.innerHTML = `<div class="mi-loading"><span class="mi-spinner"></span> 正在生成总点评报告（AI 正在综合分析所有回答）…</div>`;
    }
    try {
      const r = await apiFetch('/api/mock-interview/final-review', {});
      // 渲染元数据徽章
      const answered = Number(r && r.answeredCount) || 0;
      const total = Number(r && r.totalQuestions) || FloatState.totalQuestions || 0;
      const avg = Number(r && r.averageScore) || 0;
      if (DOM.finalAvgScore) DOM.finalAvgScore.textContent = `平均分：${avg.toFixed(1)}`;
      if (DOM.finalTotal) DOM.finalTotal.textContent = `答 ${answered} / ${total} 题`;
      if (DOM.finalTitle) DOM.finalTitle.textContent = '🎯 最终总点评 / 复盘报告';
      // 渲染 markdown 正文
      if (DOM.finalReviewBody) DOM.finalReviewBody.innerHTML = lightMarkdown((r && r.review) || '（暂无复盘内容）');
      // 顶部进度更新：X / X
      FloatState.currentIndexDisplay = total;
      updateProgressUI();
      // 作答区禁用（结束了就不能再写）
      if (DOM.answerEditor) {
        DOM.answerEditor.value = '（面试已结束，本题答案未提交 → 总点评已生成）';
        DOM.answerEditor.setAttribute('readonly', 'readonly');
      }
      // 按钮：结束按钮改为『关闭窗口』
      if (DOM.endBtn) {
        DOM.endBtn.innerHTML = '✕ 关闭窗口';
        DOM.endBtn.onclick = closeFloatWindow;
      }
      if (DOM.submitBtn) DOM.submitBtn.disabled = true;
      // 滚动到最终卡片
      if (DOM.finalCard && typeof DOM.finalCard.scrollIntoView === 'function') {
        setTimeout(() => DOM.finalCard.scrollIntoView({ behavior: 'smooth', block: 'start' }), 120);
      }
      toast(`总点评已生成（平均分 ${avg.toFixed(1)}），可在面试记录中查看详情。`, 'success', 5000);
    } catch (e) {
      console.error('[float][final-review] 异常：', e && e.message);
      if (DOM.finalReviewBody) DOM.finalReviewBody.innerHTML = `<p style="color:#ff7a90">生成失败：${String(e.message || '未知错误')}</p>`;
    }
  }

  /** 关闭当前浮窗（最终点评结束后用）：双通道 F_IPC.closeFloatWin，最终失败退回 window.close() */
  function closeFloatWindow() {
    // 优先 IPC 通知主进程关窗（主进程会统一清 BrowserWindow 引用）；任何异常都直接调 window.close() 兜底
    Promise.resolve()
      .then(() => F_IPC.closeFloatWin())
      .catch(() => null)
      .then(() => { try { window.close(); } catch (_) { /* ignore */ } });
  }

  /** 设置『提交回答』『结束面试』两个按钮的 disabled 状态 */
  function setActionsDisabled(disabled) {
    if (DOM.submitBtn) DOM.submitBtn.disabled = !!disabled;
    if (DOM.endBtn) DOM.endBtn.disabled = !!disabled;
  }

  // ------------------------------------------------------------
  // 7. 启动入口：监听主进程 mock-interview:start-params → 初始化并开始第 1 题
  // ------------------------------------------------------------
  /**
   * 启动流程：
   *   1. 解析 startParams，写入 FloatState + initServerInfo
   *   2. 应用 UI（锁死模式、徽章渲染）
   *   3. 调 /api/mock-interview/next-question 拿第 1 题
   *      （主窗口 mockResumePanels.js 已经在打开浮窗前调过 /session，这里直接出第 1 题即可）
   */
  async function bootMockInterviewFloat(startParams) {
    // ★★ 三保险兜底 ★★：
    //   情况 A：startParams 由主进程 mock-interview:start-params IPC 推送进来（正常路径）
    //   情况 B：IPC 事件因竞态丢失，startParams 传进来是空 → 立刻尝试从 URL query（主进程写入的 ?startParams=...）兜底 parse
    //   情况 C：A/B 都失败 → 打错误日志并让用户手动重试（8s 超时报错）
    let p = (startParams && typeof startParams === 'object') ? startParams : null;
    const paramsSource = p ? 'IPC-PUSH' : 'URL-QUERY-FALLBACK';
    if (!p) {
      log('warn', '[boot]', `startParams 通过 IPC-PUSH 收到为空，立即走 tryReadStartParamsFromURL() 兜底解析`);
      p = tryReadStartParamsFromURL();
    }
    if (!p || typeof p !== 'object') p = {};
    try {
      // ① 打印启动参数（脱敏 serverInfo.token，避免泄露）+ 启动来源
      const safeParams = JSON.parse(JSON.stringify({
        answerMode: p.answerMode, totalQuestions: p.totalQuestions, language: p.language,
        typeLabel: p.typeLabel, interviewType: p.interviewType, positionLabel: p.positionLabel, industryLabel: p.industryLabel,
        serverInfo_port: Number((p.serverInfo && p.serverInfo.port) || 0),
        serverInfo_baseUrl: (p.serverInfo && p.serverInfo.baseUrl) ? p.serverInfo.baseUrl.replace(/\/$/, '') : '',
        serverInfo_token: maskToken((p.serverInfo && p.serverInfo.token) || '')
      }));
      log('info', '[boot]', `来源=${paramsSource}，startParams 快照：${JSON.stringify(safeParams)}`);
      // ①+ 收到参数后立即 ACK 主进程 → 让主进程取消 t2/t3 补发定时器（避免重复推送）
      const ackOk = F_IPC.notifyStartedAck();
      log('info', '[boot]', `已 F_IPC.notifyStartedAck() 通知主进程：result=${ackOk}`);

      // ② 写入状态
      FloatState.answerMode = (p.answerMode === 'voice') ? 'voice' : 'text';
      FloatState.totalQuestions = Number(p.totalQuestions) || 5;
      FloatState.language = (p.language === 'en') ? 'en' : 'zh';
      FloatState.typeLabel = String(p.typeLabel || p.interviewType || '综合');
      // ② 初始化 HTTP 服务信息：优先用 params.serverInfo（主窗口传进来的）
      initServerInfo(p.serverInfo || {});
      log('info', '[boot]', `初始化 params.serverInfo 后 _serverInfo=${JSON.stringify(snapshotServerInfo())}`);
      // ②+ 若主窗口传进来的 serverInfo 脏（port=0 或 token 空），立刻通过 IPC 向主进程再取一次扁平的 HTTP 信息（会自动启动 server）
      if (!_serverReady) {
        log('warn', '[boot]', `params.serverInfo 未就绪（port=0 或 token 空），立刻 IPC 再取一次 getHttpInfo()`);
        try {
          const info = await F_IPC.getHttpInfo();
          log('info', '[boot]', `getHttpInfo 返回：${JSON.stringify({ ok: info && info.ok, port: info && Number(info.port) || 0, token: maskToken(info && info.token), baseUrl: (info && info.baseUrl) || '' })}`);
          if (info && info.ok && Number(info.port) > 0 && String(info.token || '').length > 0) {
            initServerInfo({
              port: Number(info.port) || 0,
              token: String(info.token || ''),
              baseUrl: String(info.baseUrl || '')
            });
            log('info', '[boot]', `IPC 二次填充后 _serverInfo=${JSON.stringify(snapshotServerInfo())}`);
          }
        } catch (e) {
          log('warn', '[boot]', `getHttpInfo 二次填充异常：${e && e.message}`);
        }
      }
      // ③ UI 初始化
      if (DOM.typeBadge) DOM.typeBadge.textContent = `类型：${FloatState.typeLabel}`;
      if (DOM.langBadge) DOM.langBadge.textContent = FloatState.language === 'en' ? 'English' : '中文';
      applyModeUI();
      FloatState.currentIndexDisplay = 0;
      updateProgressUI();
      // ④ 获取并渲染第 1 题
      log('info', '[boot]', `UI 初始化完成 → 调用 fetchAndRenderNextQuestion() 拉取第 1 题`);
      await fetchAndRenderNextQuestion();
    } catch (e) {
      log('error', '[boot]', `启动异常：来源=${paramsSource} msg=${e && e.message} | stack=${e && e.stack || 'no-stack'}`);
      toast('启动失败：' + (e.message || '未知错误'), 'error', 5000);
    }
  }

  // ------------------------------------------------------------
  // 8. DOMContentLoaded：缓存 DOM 引用、绑定按钮事件、订阅启动参数事件
  // ------------------------------------------------------------
  document.addEventListener('DOMContentLoaded', () => {
    log('info', '[DOM]', `DOMContentLoaded 触发，startParams.search=${(window.location && window.location.search) ? window.location.search.slice(0, 200) : '(空)'}`);
    // 诊断 IPC / electronAPI 可用性（8s 兜底超时时如果没 started，需要把这些打出来）
    const ipcDiag = {
      hasElectronAPI: !!window.electronAPI,
      electronAPIFields: (window.electronAPI && typeof window.electronAPI === 'object') ? Object.keys(window.electronAPI).filter(k => typeof window.electronAPI[k] !== 'object').slice(0, 50) : null,
      hasWindowIpcRenderer: !!window.ipcRenderer,
      requireIpcRendererAvailable: (() => { try { return !!(window.require && window.require('electron') && window.require('electron').ipcRenderer); } catch (_) { return false; } })()
    };
    log('info', '[DOM]', `IPC 双通道可用性诊断：${JSON.stringify(ipcDiag)}`);
    cacheDomRefs();

    // ---- 按钮：提交回答（仅文字模式可见，由 CSS body[data-mode="text"] 控制显示） ----
    if (DOM.submitBtn) DOM.submitBtn.addEventListener('click', () => submitAnswer(false));

    // ---- 按钮：结束面试并生成报告（两模式都可见） ----
    if (DOM.endBtn) DOM.endBtn.addEventListener('click', endInterviewAndFinalReview);

    // ---- 窗口关闭前：清理 ASR / VAD / 事件订阅（防止主进程资源泄漏） ----
    window.addEventListener('beforeunload', () => {
      try { stopASR(true); } catch (_) { /* ignore */ }
    });

    // ---- 订阅主进程下发的『启动参数』事件（一次即可，首次触发后取消）—— 双通道 F_IPC.onMockStartParams ----
    //   onMockStartParams 本身就是 electronAPI.onXxx + ipcRenderer.on 的双通道封装，无需再硬判断
    let started = false;
    const unsub = F_IPC.onMockStartParams((params) => {
      if (started) return;
      started = true;
      const pCount = (params && typeof params === 'object') ? Object.keys(params).length : -1;
      log('info', '[DOM]', `onMockStartParams 触发：paramsIsObject=${!!(params && typeof params === 'object')} keysCount=${pCount}，取消订阅 → 调用 bootMockInterviewFloat`);
      // 首次收到参数 → 启动面试；取消订阅避免重复
      try { if (typeof unsub === 'function') unsub(); } catch (_) { /* ignore */ }
      bootMockInterviewFloat(params);
    });
    log('info', '[DOM]', `onMockStartParams 订阅已注册（双通道）；若 8s 内未收到 params 会 toast 提示并尝试 URL query 兜底启动`);
    // 兜底：8s 内未收到启动参数
    setTimeout(() => {
      if (started) return;
      // 8s 内未通过 IPC 收到 → 尝试 URL query 兜底启动一次（这是"保险 1"：即便所有 IPC 事件都没挂上也能自动拉起）
      log('warn', '[DOM]', `8s 内未收到 IPC push startParams → 尝试 URL query 兜底启动 tryReadStartParamsFromURL() + bootMockInterviewFloat(null)`);
      const fromUrl = tryReadStartParamsFromURL();
      const urlHasValid = !!(fromUrl && typeof fromUrl === 'object' && (fromUrl.answerMode || (fromUrl.serverInfo && fromUrl.serverInfo.port)));
      if (urlHasValid) {
        started = true;
        try { if (typeof unsub === 'function') unsub(); } catch (_) { /* ignore */ }
        bootMockInterviewFloat(null);
        return;
      }
      // URL query 也没有有效参数 → 打完整 IPC 诊断 + 让用户重试（最末端错误）
      const finalDiag = {
        startParamsFromURL: fromUrl,
        locationHref: (window.location && window.location.href) ? String(window.location.href).slice(0, 260) : '',
        electronAPIExists: !!window.electronAPI,
        electronAPIOpenMock: !!(window.electronAPI && typeof window.electronAPI.openMockInterviewFloatWin === 'function'),
        electronAPIGetHttpInfo: !!(window.electronAPI && typeof window.electronAPI.getHttpInfo === 'function'),
        windowIpcRenderer: !!window.ipcRenderer,
        requireElectron: (() => { try { return !!(window.require && window.require('electron')); } catch (e) { return `err:${e && e.message}`; } })()
      };
      log('error', '[DOM]', `8s 内未收到启动参数 & URL query 也无有效内容 → 最终诊断：${JSON.stringify(finalDiag)}`);
      toast('未收到启动参数：请从主窗口点击『开始模拟面试』以打开浮动面板（若持续失败请按 F12 查看 Console 中 [DOM] 前缀日志）。', 'warn', 12000);
    }, 8000);
  });
})();
