/**
 * Copilot 模式控制器。
 * 负责：模式切换、统一配置表单读写、简历/知识库 PDF·DOCX·MD·TXT 解析、
 * 热词标签、开始面试辅助（复用经典模式已有的采集 + AI 流程）。
 *
 * 依赖：渲染层已开启 nodeIntegration，可直接 require('electron'/'fs'/'pdfjs-dist'/'mammoth')。
 * 同时优先使用 preload 暴露的 window.electronAPI；不可用时回退到 ipcRenderer。
 */

// 环境探测：区分 Electron / 浏览器
const isElectron = typeof process !== 'undefined'
  && process.versions
  && !!process.versions.electron;
const hasRequire = typeof require !== 'undefined';

// 优先使用 preload 桥，否则回退到原始 electronIpcRenderer（Electron 兼容），
// 最后回退到浏览器模式：fetch('/ipc/:channel') 调 dev-server 提供的模拟 IPC。
// 注意：变量名用 electronIpcRenderer 是为了避免与 renderer.js 的全局 ipcRenderer 冲突
//       （两者在同一页面作用域，否则会报 SyntaxError: Identifier 'ipcRenderer' has already been declared）
const electronIpcRenderer = (isElectron && hasRequire) ? require('electron').ipcRenderer : null;
// 视线检测控制器（对齐 HireMe gaze；降级实现：摄像头人脸在场检测。浏览器模式下不加载）
// 注意：Electron renderer 进程的 __dirname 是 index.html 所在的项目根目录，
// 不是 copilot.js 自身的 src/renderer/ 目录，所以路径要用 ./src/renderer/gaze-controller
let GazeController = null;
if (isElectron && hasRequire) {
  try {
    GazeController = require('./src/renderer/gaze-controller');
  } catch (e) {
    // 路径不对或模块不存在时降级为 null，不影响其他功能
    console.warn('[copilot] gaze-controller 加载失败，视线检测不可用:', e.message);
  }
}
let gazeCtrl = null;

/**
 * 浏览器模式下统一调用 dev-server 的 `/ipc/:channel` REST 通道。
 * 语义与 ipcRenderer.invoke 完全一致：返回 Promise<any>，
 * 失败时 reject 一个带错误消息的 Error。
 */
const invokeDevServer = async (channel, ...args) => {
  try {
    const resp = await fetch(`/ipc/${encodeURIComponent(channel)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args })
    });
    const text = await resp.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch (_) { payload = text; }
    if (!resp.ok) {
      const msg = (payload && payload.error) ? payload.error : `HTTP ${resp.status}`;
      throw new Error(msg);
    }
    return payload;
  } catch (e) {
    // 网络错误（例如未启动 npm run dev）给出更友好的提示
    if (/Failed to fetch|NetworkError/.test(String(e.message))) {
      throw new Error(`无法连接 dev-server。请先执行 \`npm run dev\`，或切换到 Electron 模式 \`npm start\`（原错误：${e.message}）`);
    }
    throw e;
  }
};

// api 选择：preload 桥 > electronIpcRenderer(Electron) > dev-server 模拟 IPC（浏览器）
const api = (window.electronAPI && typeof window.electronAPI.getInterviewConfig === 'function')
  ? window.electronAPI
  : (isElectron && electronIpcRenderer)
    ? {
        getInterviewConfig: () => electronIpcRenderer.invoke('get-interview-config'),
        saveInterviewConfig: (c) => electronIpcRenderer.invoke('save-interview-config', c),
        getConfig: () => electronIpcRenderer.invoke('get-config'),
        saveConfig: (c) => electronIpcRenderer.invoke('save-config', c),
        getHistory: () => electronIpcRenderer.invoke('get-history'),
        saveHistory: (h) => electronIpcRenderer.invoke('save-history', h),
        saveResume: (t) => electronIpcRenderer.invoke('save-resume', t),
        loadResume: () => electronIpcRenderer.invoke('load-resume'),
        openFileDialog: (o) => electronIpcRenderer.invoke('open-file-dialog', o),
        selectResumeFile: () => electronIpcRenderer.invoke('select-resume-file'),
        optimizeResume: (t, d) => electronIpcRenderer.invoke('optimize-resume', t, d),
        generateReview: (h, c) => electronIpcRenderer.invoke('generate-review', h, c),
        listSessions: () => electronIpcRenderer.invoke('list-sessions'),
        screenshotSolve: (img, c, r, k) => electronIpcRenderer.invoke('screenshot-solve', img, c, r, k),
        screenshotScreen: () => electronIpcRenderer.invoke('screenshot-screen'),
        startRelayServer: (p) => electronIpcRenderer.invoke('start-relay-server', p),
        stopRelayServer: () => electronIpcRenderer.invoke('stop-relay-server'),
        relayServerStatus: () => electronIpcRenderer.invoke('relay-server-status'),
        generateAnswer: (q, c, r, k) => electronIpcRenderer.invoke('generate-answer', q, c, r, k),
        getBaiduAccessToken: (c) => electronIpcRenderer.invoke('get-baidu-access-token', c),
        baiduRecognize: (p) => electronIpcRenderer.invoke('baidu-recognize', p),
        speechToText: (a, c) => electronIpcRenderer.invoke('speech-to-text', a, c),
        parseResume: (p) => electronIpcRenderer.invoke('parse-resume', p),
        getStateSummary: () => electronIpcRenderer.invoke('get-state-summary'),
        saveState: () => electronIpcRenderer.invoke('save-state'),
        getRecoveryData: () => electronIpcRenderer.invoke('get-recovery-data'),
        restoreSession: (d) => electronIpcRenderer.invoke('restore-session', d),
        deleteResume: () => electronIpcRenderer.invoke('delete-resume'),
        // WASAPI 原生系统音频管线（新模式，不依赖渲染层 getDisplayMedia）
        startAsrPipeline: (c) => electronIpcRenderer.invoke('start-asr-pipeline', c),
        stopAsrPipeline: () => electronIpcRenderer.invoke('stop-asr-pipeline'),
        // 独立答题面板
        openOverlay: () => electronIpcRenderer.invoke('open-overlay'),
        closeOverlay: () => electronIpcRenderer.invoke('close-overlay'),
        overlayStatus: () => electronIpcRenderer.invoke('overlay-status'),
        resizeOverlay: (dir, dx, dy) => electronIpcRenderer.invoke('resize-overlay', dir, dx, dy),
        moveOverlay: (direction) => electronIpcRenderer.invoke('move-overlay', direction),
        // 切场边界：如果上一场被显式× 结束 → 强制开新一场
        ensureSessionIfEnded: (c) => electronIpcRenderer.invoke('interview-session-ensure-if-ended', c),
        // Session 管理（面试记录）
        getSessionDetail: (id) => electronIpcRenderer.invoke('get-session-detail', id),
        endActiveSession: () => electronIpcRenderer.invoke('end-active-session'),
        findSessionByRound: (roundId) => electronIpcRenderer.invoke('interview-session-find-by-round', roundId),
        // 小程序服务（后续 M2 才会用，先填 IPC 占位保证 fallback 不报错）
        generateQR: () => electronIpcRenderer.invoke('generate-qr'),
        startLocalServer: (p) => electronIpcRenderer.invoke('start-local-server', p),
        stopLocalServer: () => electronIpcRenderer.invoke('stop-local-server'),
        getServerStatus: () => electronIpcRenderer.invoke('get-server-status'),
        disconnectMiniapp: () => electronIpcRenderer.invoke('disconnect-miniapp'),
      }
    : {
      // ---------- 浏览器模式（fetch dev-server /ipc/*）----------
      getInterviewConfig: () => invokeDevServer('get-interview-config'),
      saveInterviewConfig: (c) => invokeDevServer('save-interview-config', c),
      getConfig: () => invokeDevServer('get-config'),
      saveConfig: (c) => invokeDevServer('save-config', c),
      getHistory: () => invokeDevServer('get-history'),
      saveHistory: (h) => invokeDevServer('save-history', h),
      saveResume: (t) => invokeDevServer('save-resume', t),
      loadResume: () => invokeDevServer('load-resume'),
      deleteResume: () => invokeDevServer('delete-resume'),
      listSessions: () => invokeDevServer('list-sessions'),
      optimizeResume: (t, d) => invokeDevServer('optimize-resume', t, d),
      generateReview: (h, c) => invokeDevServer('generate-review', h, c),
      screenshotSolve: (img, c, r, k) => invokeDevServer('screenshot-solve', img, c, r, k),
      generateAnswer: (q, c, r, k) => invokeDevServer('generate-answer', q, c, r, k),
      getStateSummary: () => invokeDevServer('get-state-summary'),
      saveState: () => invokeDevServer('save-state'),
      getRecoveryData: () => invokeDevServer('get-recovery-data'),
      restoreSession: (d) => invokeDevServer('restore-session', d),
      getBaiduAccessToken: (c) => invokeDevServer('get-baidu-access-token', c),
      baiduRecognize: (p) => invokeDevServer('baidu-recognize', p),
      speechToText: (a, c) => invokeDevServer('speech-to-text', a, c),
      parseResume: (p) => invokeDevServer('parseResume', p),
      selectResumeFile: () => invokeDevServer('selectResumeFile'),
      // 浏览器专属：openFileDialog 返回 null，由 pickFile() fallback 到隐藏 <input type=file>
      openFileDialog: () => Promise.resolve(null),
      // 浏览器无法整屏无弹窗截图：返回错误信息，让 UI 提示用户用 getDisplayMedia 或切 Electron
      screenshotScreen: () => Promise.resolve({
        success: false,
        error: '浏览器模式无法自动整屏截图。请切到 Electron (npm start) 使用该功能。'
      }),
      // 中继/窗口级能力：浏览器做不到，统一返回降级信息
      startRelayServer: () => invokeDevServer('start-relay-server'),
      stopRelayServer: () => invokeDevServer('stop-relay-server'),
      relayServerStatus: () => invokeDevServer('relay-server-status'),
      // 浏览器模式不支持 WASAPI 系统音频采集
      startAsrPipeline: () => Promise.resolve({ success: false, error: '浏览器模式不支持 WASAPI 系统音频采集，请切到 Electron (npm start)' }),
      stopAsrPipeline: () => invokeDevServer('stop-asr-pipeline')
    };

// 当前配置对象（由主进程加载后写入）
let cfg = null;
// 防抖保存定时器
let saveTimer = null;
// 热词标签容器
let hotWords = [];

/**
 * 把当前 cfg 同步进经典模式的 window.appState，
 * 使「开始面试辅助」触发的经典采集 + AI 流程使用最新配置与简历。
 */
function syncAppState() {
  if (window.appState) {
    window.appState.config = Object.assign({}, cfg);
    window.appState.resumeContent = cfg.resumeText || '';
  }
}

/**
 * 启动视线检测：无人脸时自动隐藏答题 overlay，有人脸时恢复。
 * 依赖 GazeController（渲染层 require），不可用时静默跳过。
 */
function startGaze() {
  if (!GazeController || gazeCtrl) return;
  gazeCtrl = new GazeController();
  // 无人脸持续一段时间 → 隐藏 overlay（答案不可见，降低被发现概率）
  gazeCtrl.onHide = () => {
    const ov = document.getElementById('interviewOverlay');
    if (ov) ov.classList.add('gaze-hidden');
  };
  // 重新检测到人脸 → 恢复 overlay 显示
  gazeCtrl.onShow = () => {
    const ov = document.getElementById('interviewOverlay');
    if (ov) ov.classList.remove('gaze-hidden');
  };
  gazeCtrl.onUnsupported = (msg) => {
    console.warn('[gaze]', msg);
    gazeCtrl = null;
  };
  gazeCtrl.start();
}

/**
 * 停止视线检测并释放摄像头。
 */
function stopGaze() {
  if (gazeCtrl) {
    gazeCtrl.stop();
    gazeCtrl = null;
  }
  const ov = document.getElementById('interviewOverlay');
  if (ov) ov.classList.remove('gaze-hidden');
}

/**
 * 防抖保存配置到主进程。
 */
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await api.saveInterviewConfig(cfg);
      syncAppState();
    } catch (e) {
      console.error('[copilot] 保存配置失败:', e.message);
    }
  }, 400);
}

/**
 * 设置一组分段控件 / 卡片组中某个子项为选中态。
 * @param {string} containerId 容器元素 id
 * @param {string} selector 子元素选择器
 * @param {string} attr 用于匹配的 data-* 属性名
 * @param {string} value 当前值
 */
function setActiveInGroup(containerId, selector, attr, value) {
  const box = document.getElementById(containerId);
  if (!box) return;
  box.querySelectorAll(selector).forEach((el) => {
    el.classList.toggle('active', el.getAttribute(attr) === String(value));
  });
}

/**
 * 根据 cfg 把值回填到表单控件。
 */
function populateForm() {
  if (!cfg) return;
  // 面试类型
  setActiveInGroup('interviewTypeGrid', '.type-card', 'data-type', cfg.type);
  // AI 指令风格
  setActiveInGroup('instructionStyleSeg', '.seg-btn', 'data-style', cfg.instructionStyle);
  // 回答字数
  setActiveInGroup('answerLengthSeg', '.seg-btn', 'data-len', cfg.answerLength);
  // 截断模式
  setActiveInGroup('cutoffModeSeg', '.seg-btn', 'data-cutoff', cfg.cutoffMode);
  // 模型档位
  setActiveInGroup('modelTierGrid', '.model-card', 'data-tier', cfg.modelTier);
  // 系统音频开关
  const sat = document.getElementById('systemAudioToggle');
  if (sat) sat.checked = cfg.audioMode === 'system';
  // 视线检测开关
  const gt = document.getElementById('gazeToggle');
  if (gt) gt.checked = cfg.gazeEnabled === true;
  // 文本输入
  setVal('targetCompany', cfg.targetCompany);
  setVal('targetPosition', cfg.targetPosition);
  setVal('jobDescription', cfg.jobDescription);
  setVal('copilotCustomInstruction', cfg.customInstruction);
  setVal('copilotResumeEditor', cfg.resumeText);
  setVal('copilotKbEditor', cfg.knowledgeBase);
  // 热词
  hotWords = Array.isArray(cfg.hotWords) ? cfg.hotWords.slice() : [];
  renderHotWords();
}

/** 安全地给 input/textarea 赋值 */
function setVal(id, value) {
  const el = document.getElementById(id);
  if (el && value !== undefined && value !== null) el.value = value;
}

/**
 * 渲染热词标签。
 */
function renderHotWords() {
  const box = document.getElementById('hotWordsBox');
  if (!box) return;
  // 保留输入框，移除旧标签
  box.querySelectorAll('.tag').forEach((t) => t.remove());
  const input = document.getElementById('hotWordsInput');
  // 更新热词计数显示
  const countEl = document.getElementById('hotWordsCount');
  if (countEl) countEl.textContent = String(hotWords.length);
  hotWords.forEach((word) => {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = word;
    const close = document.createElement('span');
    close.className = 'tag-close';
    close.textContent = '×';
    close.addEventListener('click', () => {
      hotWords = hotWords.filter((w) => w !== word);
      cfg.hotWords = hotWords;
      renderHotWords();
      scheduleSave();
    });
    tag.appendChild(close);
    box.insertBefore(tag, input);
  });
}

/**
 * 解析文件为纯文本：PDF(DOCX(MD(TXT。
 * @param {string} filePath 文件路径
 * @param {Buffer} buffer 文件二进制
 * @returns {Promise<string|null>} 解析出的文本；失败返回 null
 */
/**
 * 解析文件为纯文本：PDF(DOCX(MD(TXT。
 * - Electron 模式：通过 buffer + require(mammoth/pdfjs-dist) 解析
 * - 浏览器模式：
 *     MD / TXT 直接转 UTF-8
 *     PDF / DOCX 优先尝试全局加载的 mammoth/pdfjs-dist，失败则提示手动粘贴
 * @param {string} filePath 文件名或路径（浏览器下只有文件名）
 * @param {Buffer|ArrayBuffer} buffer 文件二进制
 * @returns {Promise<string|null>} 解析出的文本；失败返回 null
 */
async function parseFileToText(filePath, buffer) {
  const lower = String(filePath || '').toLowerCase();
  try {
    // 把 ArrayBuffer / Uint8Array 统一转 Buffer（如果有 Buffer 构造函数），否则保持原样
    const ab = (buffer instanceof ArrayBuffer) ? buffer
      : (buffer && buffer.buffer instanceof ArrayBuffer) ? buffer.buffer
      : null;
    const data = ab ? new Uint8Array(ab) : buffer;

    if (lower.endsWith('.docx') || lower.endsWith('.doc')) {
      // DOCX：有 mammoth 就用，否则提示手动粘贴
      if (hasRequire) {
        const mammoth = require('mammoth');
        const result = await mammoth.extractRawText({ buffer: Buffer.from(data) });
        return result.value || '';
      }
      if (window.mammoth && typeof window.mammoth.extractRawText === 'function') {
        const result = await window.mammoth.extractRawText({ arrayBuffer: ab || buffer });
        return (result && result.value) ? result.value : '';
      }
      alert('浏览器模式暂不支持 DOCX 自动解析，请先切到 Electron (npm start)，或把内容复制粘贴到文本框。');
      return null;
    }
    if (lower.endsWith('.pdf')) {
      if (hasRequire) {
        const pdfjsLib = require('pdfjs-dist');
        try {
          const resolved = tryResolvePdfWorker();
          if (resolved) pdfjsLib.GlobalWorkerOptions.workerSrc = 'file://' + resolved;
        } catch (_) { /* 忽略 worker 配置错误 */ }
        const doc = await pdfjsLib.getDocument({ data: new Uint8Array(data) }).promise;
        let text = '';
        for (let i = 1; i <= doc.numPages; i++) {
          const page = await doc.getPage(i);
          const content = await page.getTextContent();
          text += content.items.map((it) => it.str).join(' ') + '\n';
        }
        return text;
      }
      alert('浏览器模式暂不支持 PDF 自动解析，请先切到 Electron (npm start)，或把内容复制粘贴到文本框。');
      return null;
    }
    // MD / TXT：直接转 UTF-8（浏览器端用 TextDecoder，Node 端用 Buffer.toString）
    if (typeof TextDecoder !== 'undefined') {
      return new TextDecoder('utf-8').decode(data);
    }
    return Buffer.from(data).toString('utf8');
  } catch (e) {
    console.error('[copilot] 解析文件失败:', e.message);
    return null;
  }
}

/** 尝试解析 pdfjs worker 文件路径（兼容不同扩展名，仅 Electron 用） */
function tryResolvePdfWorker() {
  if (!hasRequire) return null;
  const candidates = [
    'pdfjs-dist/build/pdf.worker.min.mjs',
    'pdfjs-dist/build/pdf.worker.min.js'
  ];
  for (const p of candidates) {
    try {
      return require.resolve(p);
    } catch (_) { /* 继续尝试 */ }
  }
  return null;
}

/**
 * 浏览器模式下用隐藏 <input type=file"> 弹原生文件选择框。
 * @param {Object} options filters: [{ extensions: ['pdf','docx',...] }]
 * @returns {Promise<{path:string,name:string,buffer:Uint8Array}|null>}
 */
function browserPickFile(options) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    const filters = (options && options.filters) || [];
    const accept = filters
      .map((f) => (f.extensions || []).map((e) => `.${e}`).join(','))
      .filter(Boolean)
      .join(',');
    if (accept) input.accept = accept;
    input.style.display = 'none';
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      document.body.removeChild(input);
      if (!file) return resolve(null);
      const ab = await file.arrayBuffer();
      resolve({
        path: file.name,         // 浏览器拿不到绝对路径，用 name 代替供扩展名识别
        name: file.name,
        buffer: new Uint8Array(ab)
      });
    });
    document.body.appendChild(input);
    // 触发点击（部分浏览器要求 click 必须在用户交互栈中；这里我们是用户点击上传按钮后的同步调用链，OK）
    input.click();
  });
}

/**
 * 打开文件选择器并返回 {path, buffer}。
 * - Electron：走 api.openFileDialog 原生对话框
 * - 浏览器：走隐藏 <input type=file"> 降级
 * @param {Object} options 对话框选项（title / filters）
 * @returns {Promise<{path:string,name?:string,buffer:Uint8Array}|null>}
 */
async function pickFile(options) {
  // 1) 先尝试原生 / Electron 通道
  try {
    const res = await api.openFileDialog(options);
    // 如果在 Electron 环境下且 IPC 调用成功（无论是否取消），都直接返回，不再 fallback
    if (isElectron) {
      if (res && res.success && !res.canceled && (res.filePath || (res.filePaths && res.filePaths[0]))) {
        const filePath = res.filePath || res.filePaths[0];
        const fs = require('fs');
        const buffer = fs.readFileSync(filePath);
        return { path: filePath, buffer };
      }
      // 用户取消了，返回 null
      return null;
    }
    // 浏览器模式下，openFileDialog 是 mock 的，走 fallback
  } catch (e) {
    // 浏览器模式下 openFileDialog 直接返回 null 也会走这里 fallback
    if (isElectron) {
      console.error('[copilot] openFileDialog 失败:', e.message);
      return null;
    }
  }
  // 2) fallback：浏览器原生 <input type=file">
  return browserPickFile(options || {});
}

/**
 * 处理简历上传：解析后写入文本框与配置，并落盘。
 */
async function handleResumeUpload() {
  const picked = await pickFile({
    title: '选择简历（PDF / DOCX / MD / TXT）',
    filters: [
      { name: '简历文件', extensions: ['pdf', 'docx', 'doc', 'md', 'markdown', 'txt'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  if (!picked) return;
  const status = document.getElementById('copilotResumeStatus');
  status.textContent = '解析中…';
  const text = await parseFileToText(picked.path, picked.buffer);
  if (text === null) {
    status.textContent = '解析失败，请直接粘贴文本';
    return;
  }
  cfg.resumeText = text;
  setVal('copilotResumeEditor', text);
  await api.saveResume(text);
  status.textContent = `已解析 ${text.length} 字`;
  scheduleSave();
}

/**
 * 处理知识库追加：解析后追加到 knowledgeBase。
 */
async function handleKbUpload() {
  const picked = await pickFile({
    title: '追加知识库资料（PDF / DOCX / TXT）',
    filters: [
      { name: '资料文件', extensions: ['pdf', 'docx', 'doc', 'md', 'markdown', 'txt'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  if (!picked) return;
  const text = await parseFileToText(picked.path, picked.buffer);
  if (text === null) return;
  cfg.knowledgeBase = (cfg.knowledgeBase ? cfg.knowledgeBase + '\n\n' : '') + text;
  setVal('copilotKbEditor', cfg.knowledgeBase);
  scheduleSave();
}

/**
 * 加载并渲染面试历史记录。
 */
async function loadHistory() {
  try {
    const history = await api.getHistory();
    const list = document.getElementById('copilotHistoryList');
    if (!list) return;
    if (!history || history.length === 0) {
      list.innerHTML = '<div class="history-empty">暂无面试记录</div>';
      return;
    }
    list.innerHTML = history.slice(0, 20).map((item) => `
      <div class="history-item">
        <div class="hi-q">${escapeHtml(item.question || '')}</div>
        <div class="hi-a">${escapeHtml((item.answer || '').slice(0, 80))}${(item.answer || '').length > 80 ? '…' : ''}</div>
        <div class="hi-time">${escapeHtml(item.timestamp || '')}</div>
      </div>
    `).join('');
  } catch (e) {
    console.error('[copilot] 加载历史失败:', e.message);
  }
}

/**
 * 生成 AI 复盘：取面试历史喂 LLM，弹窗展示复盘报告。
 */
async function generateReviewForHistory() {
  const btn = document.getElementById('copilotReviewBtn');
  try {
    // 取历史问答记录
    const history = await api.getHistory();
    if (!history || history.length === 0) {
      alert('暂无面试记录，先开始一次面试后再复盘');
      return;
    }
    // 整理成 {question, answer} 列表（最多取最近 30 条）
    const qa = history.slice(0, 30).map((h) => ({ question: h.question || '', answer: h.answer || '' }));
    if (btn) { btn.disabled = true; btn.textContent = '✨ 复盘生成中…'; }
    const c = await api.getInterviewConfig();
    const res = await api.generateReview(qa, c);
    if (btn) { btn.disabled = false; btn.textContent = '✨ 生成 AI 复盘'; }
    if (!res || !res.success) {
      alert('复盘生成失败：' + (res && res.error ? res.error : '未知错误'));
      return;
    }
    // 弹窗展示复盘
    showReviewModal(res.review, res.reviewPath);
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = '✨ 生成 AI 复盘'; }
    alert('复盘生成异常：' + e.message);
  }
}

/**
 * 展示内容模态框（复盘/解题答案通用，首次创建后续复用）。
 * @param {string} content 文本内容
 * @param {string} filePath 存档路径（可选，展示在底部）
 * @param {string} title 弹窗标题（默认「AI 面试复盘」）
 */
function showReviewModal(content, filePath, title) {
  let modal = document.getElementById('reviewModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'reviewModal';
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-card" style="max-width:680px;">
        <div class="modal-header">
          <h3 id="reviewModalTitle">✨ AI 面试复盘</h3>
          <button class="modal-close" type="button">×</button>
        </div>
        <div class="modal-body" id="reviewModalBody" style="max-height:60vh;overflow:auto;white-space:pre-wrap;line-height:1.6;"></div>
        <div class="modal-footer"><span class="review-path-hint" style="color:var(--text-muted);font-size:12px;"></span></div>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => {
      if (e.target === modal || e.target.classList.contains('modal-close')) modal.classList.remove('open');
    });
  }
  const titleEl = document.getElementById('reviewModalTitle');
  if (titleEl) titleEl.textContent = title || '✨ AI 面试复盘';
  document.getElementById('reviewModalBody').textContent = content || '';
  const hint = modal.querySelector('.review-path-hint');
  if (hint) hint.textContent = filePath ? ('已存档：' + filePath) : '';
  modal.classList.add('open');
}

/**
 * 全屏选区 overlay：在截图上拖框，返回裁剪后的 data URL；取消返回 null。
 * 兼容浏览器模式 dev-server 实现：无需修改
 * @deprecated 已迁移到答题面板（overlay-renderer.js），此处保留为空壳兜底
 * @param {string} dataUrl 全屏截图 data URL
 * @returns {Promise<string|null>}
 */
function pickRegionFromImage(dataUrl) { return Promise.resolve(null); }

// 伴生中继运行状态
let relayRunning = false;

/**
 * 切换伴生中继：启动后显示局域网地址供手机/iPad 访问；再次点击停止。
 */
async function toggleRelay() {
  const btn = document.getElementById('copilotRelayBtn');
  try {
    if (!relayRunning) {
      const r = await api.startRelayServer(9876);
      if (r && r.success) {
        relayRunning = true;
        const ips = (r.ips && r.ips.length) ? r.ips : ['<本机IP>'];
        if (btn) btn.innerHTML = '<span>📱</span> 伴生中继 : ' + r.port + '（点击停止）';
        alert('伴生中继已启动（端口 ' + r.port + '）。\n\n手机/iPad 与本机同一 Wi-Fi，浏览器打开：\n' + ips.map((ip) => 'http://' + ip + ':' + r.port).join('\n'));
      } else {
        alert('启动失败：' + (r && r.error ? r.error : '端口可能被占用'));
      }
    } else {
      await api.stopRelayServer();
      relayRunning = false;
      if (btn) btn.innerHTML = '<span>📱</span> 伴生设备';
    }
  } catch (e) {
    alert('伴生中继异常：' + e.message);
  }
}

/** 简单 HTML 转义，避免记录渲染 XSS */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// ==================== 面试辅助 ASR 管线（WASAPI → 百度 ASR → AI 答题）====================

/** ASR 事件监听器引用（用于 unregister） */
let asrListeners = null;
/**
 * 答题面板关闭后是否代表「这场面试已被显式结束」：
 *   - 收到主进程 overlay:closed-post-session 事件 → 置 true
 *   - 用户主动点击 startInterviewAssist（开始面试辅助）→ 置 false（进入新一场）
 * 作用：refreshReopenOverlayBtn 中，若 asrRunning=true 但 asrSessionEnded=true → 不显示"重新打开答题面板"，
 *       避免用户误点后产生「继续刚刚那一场」的困惑心智。
 *       （用户应点击「开启新的面试」→ startInterviewAssist，入口更清晰）
 */
let asrSessionEnded = false;

/**
 * 启动面试辅助（M1 改造：面板独立为 overlayWindow）
 * 1. Electron 模式：调 open-overlay IPC → 主进程创建独立 BrowserWindow（可跨屏，alwaysOnTop）
 *    浏览器模式：仍显示 index.html 内嵌 overlay（兼容 dev-server）
 * 2. 注册 ASR 事件监听器（Electron 监听 IPC，浏览器模式监听自定义事件 stub）
 * 3. 调用主进程 IPC 启动 WASAPI + 百度 ASR + AI 答题管线
 */
async function startInterviewAssist() {
  // 保存配置到主进程
  try {
    await api.saveInterviewConfig(cfg);
  } catch (e) {
    console.warn('[copilot] 保存配置失败:', e.message);
  }
  // 切场边界：如果上一场刚被用户显式× 结束 → 强制开新一场（保证"开始面试辅助"不会落到刚结束的那场）
  try {
    if (typeof api.ensureSessionIfEnded === 'function') {
      const r = await api.ensureSessionIfEnded(cfg);
      if (r && r.openedNew) {
        console.log(`[copilot] ensureSessionIfEnded ✅ 已自动开启新一场 session=${String((r.session && (r.session.id || r.session.sessionId)) || '').slice(0,8)}...  |  closedPreviousId=${String(r.closedPreviousId || '').slice(0,8)}...`);
      }
    }
  } catch (e) {
    console.warn('[copilot] ensureSessionIfEnded 异常：', e.message);
  }
  // 进入新一场 → "本场已结束"标记重置为 false
  asrSessionEnded = false;
  syncAppState();

  // =========== 1. 显示答题面板：Electron 走 open-overlay；浏览器走内嵌 overlay ===========
  let overlayOpenedOk = false;
  try {
    if (typeof api.openOverlay === 'function') {
      // ★ 新模式：独立窗口（跨屏可拖）
      const r = await api.openOverlay();
      overlayOpenedOk = !!(r && r.success);
    } else {
      // 浏览器模式：沿用内嵌 DOM overlay
      const overlay = document.getElementById('interviewOverlay');
      if (overlay) overlay.classList.add('show');
      overlayOpenedOk = true;
    }
  } catch (e) {
    console.warn('[copilot] 打开答题面板异常:', e.message);
    overlayOpenedOk = false;
  }

  // 重置内嵌面板内容（即便独立窗口也要重置，防止用户切回浏览器模式时看到旧字）
  const interimEl = document.getElementById('overlayInterimText');
  const answerEl = document.getElementById('overlayAnswerText');
  const loadingEl = document.getElementById('answerLoading');
  const readyEl = document.getElementById('answerReady');
  if (interimEl) interimEl.textContent = '';
  if (answerEl) answerEl.textContent = '';
  if (loadingEl) loadingEl.style.display = 'none';
  if (readyEl) readyEl.style.display = 'none';

  // 刷新「重新打开答题面板」按钮显示态
  refreshReopenOverlayBtn();

  // =========== 2. 注册 ASR 事件监听器（仅 Electron 模式有效）===========
  if (isElectron && electronIpcRenderer) {
    asrListeners = {
      // 临时识别文本 → 内嵌 overlay 实时显示（独立窗口由主进程 app.bus 直接推，不经过 copilot）
      interim: (_event, text) => {
        const el = document.getElementById('overlayInterimText');
        if (el) el.textContent = text || '';
      },
      // 最终识别文本 → 更新内嵌 overlay
      final: (_event, text) => {
        const el = document.getElementById('overlayInterimText');
        if (el) el.textContent = text || '';
      },
      // AI 答案 → 显示答案区域（独立窗口也会收到，但那是 overlayWindow 自己处理的事件）
      answer: (_event, text) => {
        const el = document.getElementById('overlayAnswerText');
        if (el) el.textContent = text || '';
        if (loadingEl) loadingEl.style.display = 'none';
        if (readyEl) readyEl.style.display = 'block';
      },
      // 状态变化 → 更新内嵌状态徽章
      status: (_event, status) => {
        const badge = document.querySelector('#interviewOverlay .status-badge.recording');
        if (!badge) return;
        const statusMap = {
          connecting:  '🔄 正在连接百度 ASR…',
          listening:  '🎤 正在识别系统声音',
          generating:  '⏳ 正在生成答案…',
          stopping:    '🛑 正在停止…',
          stopped:     '⏹ 已停止',
          disconnected:'⚠️ ASR 连接断开'
        };
        badge.textContent = statusMap[status] || status;
      },
      // 错误
      error: (_event, message) => {
        console.error('[copilot] ASR 错误:', message);
        const el = document.getElementById('overlayAnswerText');
        if (el) el.textContent = '❌ ' + message;
      }
    };

    // 注册监听器
    electronIpcRenderer.on('asr:interim', asrListeners.interim);
    electronIpcRenderer.on('asr:final', asrListeners.final);
    electronIpcRenderer.on('asr:answer', asrListeners.answer);
    electronIpcRenderer.on('asr:status', asrListeners.status);
    electronIpcRenderer.on('asr:error', asrListeners.error);
  }

  // 视线检测：配置开启时启动（独立答题面板弹出时不影响视线，摄像头仍对着用户）
  if (cfg.gazeEnabled) startGaze();

  // =========== 3. 调用主进程启动 ASR 管线 ===========
  try {
    const result = await api.startAsrPipeline(cfg);
    if (!result || !result.success) {
      const errMsg = (result && result.error) || '启动失败';
      const el = document.getElementById('overlayAnswerText');
      if (el) el.textContent = '❌ ' + errMsg;
    }
  } catch (e) {
    console.error('[copilot] 启动 ASR 管线失败:', e.message);
    const el = document.getElementById('overlayAnswerText');
    if (el) el.textContent = '❌ 启动 ASR 管线失败: ' + e.message;
  }
  // 面板打开失败也要提示用户（但不影响 ASR 管线，ASR 仍会推给小程序/WebSocket 端）
  if (!overlayOpenedOk) {
    console.warn('[copilot] 答题面板未成功打开（可手动点「重新打开答题面板」恢复）');
  }
}

/**
 * 停止面试辅助
 * 1. 调用主进程 IPC 停止 WASAPI 采集 + ASR
 * 2. 移除事件监听器
 * 3. 隐藏内嵌 overlay + 调 close-overlay IPC 关闭独立面板
 */
async function stopInterviewAssist() {
  // 停止主进程管线
  try {
    await api.stopAsrPipeline();
  } catch (e) {
    console.warn('[copilot] 停止 ASR 管线失败:', e.message);
  }

  // 移除 ASR 事件监听器
  if (asrListeners && isElectron && electronIpcRenderer) {
    try {
      electronIpcRenderer.removeListener('asr:interim', asrListeners.interim);
      electronIpcRenderer.removeListener('asr:final', asrListeners.final);
      electronIpcRenderer.removeListener('asr:answer', asrListeners.answer);
      electronIpcRenderer.removeListener('asr:status', asrListeners.status);
      electronIpcRenderer.removeListener('asr:error', asrListeners.error);
    } catch (e) { /* 忽略 */ }
    asrListeners = null;
  }

  // 关闭独立答题面板（M1：新独立窗口）
  try {
    if (typeof api.closeOverlay === 'function') await api.closeOverlay();
  } catch (e) {
    console.warn('[copilot] 关闭独立 overlayWindow 失败:', e.message);
  }

  // 隐藏内嵌浮动面板（兼容浏览器模式）
  const overlay = document.getElementById('interviewOverlay');
  if (overlay) overlay.classList.remove('show');

  // 刷新「重新打开答题面板」按钮
  refreshReopenOverlayBtn();
}

/**
 * 刷新「重新打开答题面板」按钮的显示/禁用/文字。
 * - 独立面板存在：显示「已打开」，可点击置顶
 * - 独立面板不存在但 ASR 在运行中：显示「📂 重新打开答题面板」蓝色
 * - 否则（没开始面试辅助）：隐藏
 */
async function refreshReopenOverlayBtn() {
  try {
    const btn = document.getElementById('reopenOverlayBtn');
    if (!btn) return;
    // 非 Electron 模式不显示（浏览器模式的内嵌 overlay 已经在页面上可见）
    if (!isElectron) { btn.style.display = 'none'; return; }
    if (typeof api.overlayStatus !== 'function') { btn.style.display = 'none'; return; }

    // ASR 是否在运行：只要 asrListeners 已注册（启动过）就算正在使用中
    const asrRunning = !!asrListeners;
    let exists = false;
    try {
      const s = await api.overlayStatus();
      exists = !!(s && s.exists);
    } catch (_) { exists = false; }

    if (exists) {
      btn.style.display = '';
      btn.classList.remove('primary-outline');
      btn.classList.add('secondary');
      btn.innerHTML = '<span>🪟</span> 答题面板已打开（点击置顶）';
      btn.disabled = false;
      btn.title = '将独立答题面板显示到最前面';
    } else if (asrRunning && !asrSessionEnded) {
      // 只有"ASR 运行中且本场未被显式结束"才显示"重新打开答题面板"
      //   本场被× 显式结束 → 改走主窗口顶部 banner 的「开启新的面试」按钮
      btn.style.display = '';
      btn.classList.remove('secondary');
      btn.classList.add('primary-outline');
      btn.innerHTML = '<span>📂</span> 重新打开答题面板';
      btn.disabled = false;
      btn.title = '被误关闭的答题面板重新弹出（不中断 ASR 识别）';
    } else {
      btn.style.display = 'none';
    }
  } catch (e) {
    console.warn('[copilot] refreshReopenOverlayBtn 失败:', e.message);
  }
}

/**
 * 绑定所有表单控件的事件。
 * 每一组控件单独 try/catch + 空检：即使某个元素不存在 / 报错，
 * 其他分组（尤其是面试类型）的绑定也不会被阻塞。
 */
function bindForm() {
  // ===== 1. 面试类型卡片（用户本次重点反馈功能）=====
  try {
    const grid = document.getElementById('interviewTypeGrid');
    if (grid) {
      grid.querySelectorAll('.type-card').forEach((el) => {
        el.addEventListener('click', () => {
          cfg.type = el.getAttribute('data-type');
          // 同步 interviewScene（主进程 generateAnswer 依赖）
          const map = { behavior: 'behavioral', technical: 'technical', programming: 'coding', comprehensive: 'behavioral' };
          cfg.interviewScene = map[cfg.type] || 'behavioral';
          setActiveInGroup('interviewTypeGrid', '.type-card', 'data-type', cfg.type);
          scheduleSave();
        });
      });
    } else {
      console.warn('[copilot.bindForm] #interviewTypeGrid 不存在，面试类型无法绑定');
    }
  } catch (e) {
    console.error('[copilot.bindForm] 绑定面试类型失败:', e.message);
  }

  // ===== 2. AI 指令风格 =====
  // 点击风格按钮 → 在输入框中填入对应的预设指令（追加而非覆盖，保留用户已有内容）
  const STYLE_PRESETS = {
    oral: '用自然口语表达，像和朋友聊天一样，多用"我觉得""其实""说白了"等口语连接词，避免书面化表述，语气轻松自信。',
    concise: '回答简短精炼，直击要点，不说废话，每个观点不超过两句话，避免重复和铺垫，让面试官快速抓住核心。',
    technical: '深入技术原理，展示底层实现细节，引用具体技术名词和架构方案，体现技术深度和专业性，必要时给出代码或架构示意。',
    achievement: '用数据和成果说话，多用量化指标（提升了XX%、节省了XX成本），强调业务价值和实际产出，突出个人贡献和团队协作。',
  };
  try {
    const seg = document.getElementById('instructionStyleSeg');
    if (seg) seg.querySelectorAll('.seg-btn').forEach((el) => {
      el.addEventListener('click', () => {
        cfg.instructionStyle = el.getAttribute('data-style');
        setActiveInGroup('instructionStyleSeg', '.seg-btn', 'data-style', cfg.instructionStyle);
        // 将对应风格的预设指令追加到输入框末尾
        const ta = document.getElementById('copilotCustomInstruction');
        if (ta) {
          const preset = STYLE_PRESETS[cfg.instructionStyle] || '';
          const existing = ta.value.trim();
          // 已有内容则换行追加，空则直接填入
          ta.value = existing ? existing + '\n' + preset : preset;
          cfg.customInstruction = ta.value;
          // 更新字数统计
          const icc = document.getElementById('instructionCharCount');
          if (icc) icc.textContent = String(ta.value.length);
          // 触发 input 事件确保其他监听器同步
          ta.dispatchEvent(new Event('input', { bubbles: true }));
        }
        scheduleSave();
      });
    });
  } catch (e) { console.error('[copilot.bindForm] 绑定指令风格失败:', e.message); }

  // ===== 3. 回答字数 =====
  try {
    const seg = document.getElementById('answerLengthSeg');
    if (seg) seg.querySelectorAll('.seg-btn').forEach((el) => {
      el.addEventListener('click', () => {
        cfg.answerLength = el.getAttribute('data-len');
        setActiveInGroup('answerLengthSeg', '.seg-btn', 'data-len', cfg.answerLength);
        scheduleSave();
      });
    });
  } catch (e) { console.error('[copilot.bindForm] 绑定回答字数失败:', e.message); }

  // ===== 4. 截断模式 =====
  try {
    const seg = document.getElementById('cutoffModeSeg');
    if (seg) seg.querySelectorAll('.seg-btn').forEach((el) => {
      el.addEventListener('click', () => {
        cfg.cutoffMode = el.getAttribute('data-cutoff');
        setActiveInGroup('cutoffModeSeg', '.seg-btn', 'data-cutoff', cfg.cutoffMode);
        scheduleSave();
      });
    });
  } catch (e) { console.error('[copilot.bindForm] 绑定截断模式失败:', e.message); }

  // ===== 5. 模型档位 =====
  try {
    const grid = document.getElementById('modelTierGrid');
    if (grid) grid.querySelectorAll('.model-card').forEach((el) => {
      el.addEventListener('click', () => {
        cfg.modelTier = el.getAttribute('data-tier');
        setActiveInGroup('modelTierGrid', '.model-card', 'data-tier', cfg.modelTier);
        scheduleSave();
      });
    });
  } catch (e) { console.error('[copilot.bindForm] 绑定模型档位失败:', e.message); }

  // ===== 6. 系统音频 / 视线检测开关 =====
  try {
    const sat = document.getElementById('systemAudioToggle');
    if (sat) sat.addEventListener('change', () => {
      cfg.audioMode = sat.checked ? 'system' : 'microphone';
      scheduleSave();
    });
    const gt = document.getElementById('gazeToggle');
    if (gt) gt.addEventListener('change', () => {
      cfg.gazeEnabled = gt.checked;
      scheduleSave();
    });
  } catch (e) { console.error('[copilot.bindForm] 绑定开关失败:', e.message); }

  // ===== 7. 文本输入（目标公司 / 职位 / JD / 自定义指令 / 简历 / 知识库）=====
  try {
    bindInput('targetCompany', (v) => cfg.targetCompany = v);
    bindInput('targetPosition', (v) => cfg.targetPosition = v);
    bindInput('jobDescription', (v) => cfg.jobDescription = v);
    bindInput('copilotCustomInstruction', (v) => {
      cfg.customInstruction = v;
      // 更新自定义指令字数统计
      const icc = document.getElementById('instructionCharCount');
      if (icc) icc.textContent = String(v.length);
    });
    bindInput('copilotResumeEditor', (v) => {
      cfg.resumeText = v;
      // 更新简历字数统计
      const rcc = document.getElementById('resumeCharCount');
      if (rcc) rcc.textContent = String(v.length);
    });
    bindInput('copilotKbEditor', (v) => cfg.knowledgeBase = v);
  } catch (e) { console.error('[copilot.bindForm] 绑定文本输入失败:', e.message); }

  // ===== 8. 热词输入 =====
  try {
    const hwInput = document.getElementById('hotWordsInput');
    if (hwInput) {
      hwInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ',') {
          e.preventDefault();
          const val = hwInput.value.trim().replace(/,$/, '');
          if (val && !hotWords.includes(val)) {
            hotWords.push(val);
            cfg.hotWords = hotWords;
            renderHotWords();
            scheduleSave();
          }
          hwInput.value = '';
        }
      });
    }
  } catch (e) { console.error('[copilot.bindForm] 绑定热词失败:', e.message); }

  // ===== 9. 简历 / 知识库上传 & 清空按钮 =====
  try {
    const resumeBtn = document.getElementById('copilotUploadResumeBtn');
    if (resumeBtn) resumeBtn.addEventListener('click', handleResumeUpload);
    // 清空简历按钮：清空文本框 + 配置 + 更新字数统计
    const resumeClearBtn = document.getElementById('copilotClearResumeBtn');
    if (resumeClearBtn) resumeClearBtn.addEventListener('click', () => {
      cfg.resumeText = '';
      setVal('copilotResumeEditor', '');
      const rcc = document.getElementById('resumeCharCount');
      if (rcc) rcc.textContent = '0';
      scheduleSave();
    });
    const kbBtn = document.getElementById('copilotUploadKbBtn');
    if (kbBtn) kbBtn.addEventListener('click', handleKbUpload);
    const kbClearBtn = document.getElementById('copilotClearKbBtn');
    if (kbClearBtn) kbClearBtn.addEventListener('click', () => {
      cfg.knowledgeBase = '';
      setVal('copilotKbEditor', '');
      scheduleSave();
    });
    // 清空自定义指令按钮：清空输入框 + 配置 + 更新字数统计
    const instrClearBtn = document.getElementById('copilotClearInstructionBtn');
    if (instrClearBtn) instrClearBtn.addEventListener('click', () => {
      cfg.customInstruction = '';
      setVal('copilotCustomInstruction', '');
      const icc = document.getElementById('instructionCharCount');
      if (icc) icc.textContent = '0';
      scheduleSave();
    });
    // 清空热词按钮：清空热词数组 + 重新渲染 + 更新计数
    const hwClearBtn = document.getElementById('copilotClearHotWordsBtn');
    if (hwClearBtn) hwClearBtn.addEventListener('click', () => {
      hotWords = [];
      cfg.hotWords = [];
      renderHotWords(); // renderHotWords 内部会更新 hotWordsCount
      scheduleSave();
    });
  } catch (e) { console.error('[copilot.bindForm] 绑定上传按钮失败:', e.message); }

  // ===== 10. 开始面试辅助按钮 =====
  try {
    const startBtn = document.getElementById('copilotStartBtn');
    if (startBtn) startBtn.addEventListener('click', startInterviewAssist);
  } catch (e) { console.error('[copilot.bindForm] 绑定开始按钮失败:', e.message); }

  // ===== 10.1「重新打开答题面板」按钮 =====
  try {
    const reopenBtn = document.getElementById('reopenOverlayBtn');
    if (reopenBtn) {
      reopenBtn.addEventListener('click', async () => {
        try {
          if (typeof api.openOverlay === 'function') {
            await api.openOverlay();
          }
        } catch (e) { console.error('[copilot] reopen 答题面板失败:', e.message); }
        // 刷新文案（面板存在 -> 显示"已打开（点击置顶）"）
        refreshReopenOverlayBtn();
      });
    }
    // 初始刷新（页面打开时如果之前启动过 ASR，立刻给正确态）
    refreshReopenOverlayBtn();
    // 每 3 秒轻量刷新（用户可能手动关了 ×，按钮要自动切换回「📂 重新打开」）
    setInterval(() => { try { refreshReopenOverlayBtn(); } catch (_) {} }, 3000);
  } catch (e) { console.error('[copilot.bindForm] 绑定重新打开答题面板失败:', e.message); }

  // ===== 11. 关闭答题 overlay 时停止管线 + 视线检测 =====
  try {
    const closeOverlayBtn = document.getElementById('closeOverlayBtn');
    if (closeOverlayBtn) closeOverlayBtn.addEventListener('click', () => {
      stopGaze();
      stopInterviewAssist();
    });
  } catch (e) { console.error('[copilot.bindForm] 绑定关闭 overlay 失败:', e.message); }

  // ===== 12. AI 复盘按钮 =====
  try {
    const reviewBtn = document.getElementById('copilotReviewBtn');
    if (reviewBtn) reviewBtn.addEventListener('click', generateReviewForHistory);
  } catch (e) { console.error('[copilot.bindForm] 绑定复盘按钮失败:', e.message); }
}

/** 给文本控件绑定输入即保存 */
function bindInput(id, setter) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('input', () => {
    setter(el.value);
    scheduleSave();
  });
}

/**
 * 更新字数统计。
 * @param {string} sourceId 源文本框 id
 * @param {string} displayId 显示字数元素 id
 * @param {number} max 最大字数（用于展示）
 */
function updateCharCount(sourceId, displayId, max) {
  const source = document.getElementById(sourceId);
  const display = document.getElementById(displayId);
  if (!source || !display) return;
  const len = source.value.length;
  display.textContent = `${len}/${max}`;
  if (len > max) display.style.color = 'var(--danger)';
  else display.style.color = '';
}

/**
 * 绑定清空按钮：清空对应字段并保存。
 */
function bindClearBtn(btnId, fieldId, afterClear) {
  const btn = document.getElementById(btnId);
  const field = document.getElementById(fieldId);
  if (!btn || !field) return;
  btn.addEventListener('click', () => {
    field.value = '';
    if (afterClear) afterClear();
    scheduleSave();
  });
}

/**
 * 模式切换：Copilot / 模拟面试 / 简历优化。
 */
function bindTabs() {
  const tabs = document.querySelectorAll('.mode-tab');
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const mode = tab.getAttribute('data-mode');
      tabs.forEach((t) => t.classList.toggle('active', t === tab));
      // 逐个面板做空检，避免某个 panel 被删掉时整个点击回调崩溃
      const cp = document.getElementById('copilotPanel');
      if (cp) cp.classList.toggle('hidden', mode !== 'copilot');
      const clp = document.getElementById('classicPanel');
      if (clp) clp.classList.toggle('hidden', mode !== 'classic');
      const rp = document.getElementById('resumePanel');
      if (rp) rp.classList.toggle('hidden', mode !== 'resume');
    });
  });
}

/**
 * 绑定「简历优化」面板的交互（对应 HireMe 第三个标签页）。
 *
 *  注意：简历优化 / 模拟面试 的真实 DOM 事件绑定，已经由
 *  `src/renderer/mockResumePanels.js` 的 `bindEvents() / initMockAndResumeUI()`
 *  统一接管（包括：resumeOptUploadBtn / resumeOptClearBtn / resumeOptUseSavedBtn /
 *  resumeDropzone / resumeFileInput / resumeOptEditor 字数计数 / resumeOptStartBtn /
 *  resumeOptExportDocxBtn / resumeOptCopyBtn）。
 *
 *  本函数在这里仅保留一个"守卫壳"：
 *    - 兼容 seg 控件初选中 active 状态（若简历方向段控件存在），
 *    - 保证旧版本/未来误调用时不会抛错，
 *    - 不会再次绑定同一按钮，避免「两套点击回调各跑一遍」导致上传 / 清空 / 字数更新被覆盖
 */
function bindResumePanel() {
  // 优化方向分段控件：如果 UI 存在，就按 HTML 里的 active 默认项同步 resumeDir；
  // 真实的 click 事件绑定已由 mockResumePanels.js 的 setResumeLang 统一承担，这里不重复绑。
  const dirSeg = document.querySelector('#resumePanel .seg-control');
  if (dirSeg) {
    const buttons = dirSeg.querySelectorAll('.seg-btn');
    const first = dirSeg.querySelector('.seg-btn.active') || dirSeg.querySelector('.seg-btn');
    if (first) buttons.forEach((b) => b.classList.toggle('active', b === first));
  }
}

/**
 * 绑定杂项交互：面试记录折叠、高级设置入口。
 */
function bindMisc() {
  // 面试记录折叠行：点击展开/收起历史列表
  const historyRow = document.getElementById('copilotHistoryRow');
  if (historyRow) {
    historyRow.addEventListener('click', () => {
      const list = document.getElementById('copilotHistoryList');
      if (list) list.classList.toggle('hidden');
    });
  }
  // 高级设置按钮：打开设置弹窗（关闭逻辑由 renderer.js 接管）
  const advBtn = document.getElementById('advancedSettingsBtn');
  if (advBtn) {
    advBtn.addEventListener('click', () => {
      const modal = document.getElementById('settingsModal');
      if (modal) modal.classList.add('open');
    });
  }
}

/**
 * 初始化 Copilot 模式。
 * 每个初始化步骤独立 try/catch，避免某一步失败导致整个页面交互
 *（面试类型 / 模型选择 / 简历上传 等）全部失效。
 * 字体缩放相关逻辑已统一放到 renderer.js 的 initFontZoom 中初始化，
 * 这里不再重复声明（否则会与 renderer.js 的常量名冲突，报 SyntaxError）。
 */
async function initCopilot() {
  // 默认配置（兜底），保证 cfg 至少有 type / instructionStyle 等必要字段
  const fallbackCfg = {
    type: 'behavior', instructionStyle: 'oral', answerLength: 'standard',
    cutoffMode: 'auto', modelTier: 'standard', audioMode: 'system',
    targetCompany: '', targetPosition: '', jobDescription: '',
    customInstruction: '', resumeText: '', knowledgeBase: '', hotWords: []
  };

  try {
    const loaded = await api.getInterviewConfig();
    // 合并兜底 + 加载到的配置，避免新增字段或 get-interview-config 返回
    // 全局 config（缺少 interview 字段）时出现 undefined
    cfg = Object.assign({}, fallbackCfg, loaded || {});
  } catch (e) {
    console.error('[copilot] 加载配置失败，使用默认配置:', e.message);
    cfg = fallbackCfg;
  }

  // 各初始化步骤独立 try/catch，互不影响
  try { bindTabs(); }        catch (e) { console.error('[copilot] bindTabs 失败:', e.message); }
  try { bindForm(); }        catch (e) { console.error('[copilot] bindForm 失败:', e.message); }
  try { bindResumePanel(); } catch (e) { console.error('[copilot] bindResumePanel 失败:', e.message); }
  try { bindMisc(); }        catch (e) { console.error('[copilot] bindMisc 失败:', e.message); }
  try { populateForm(); }    catch (e) { console.error('[copilot] populateForm 失败:', e.message); }
  try { loadHistory(); }     catch (e) { console.error('[copilot] loadHistory 失败:', e.message); }
  try { initFontZoom(); }    catch (e) { console.error('[copilot] initFontZoom 失败:', e.message); }

  // 默认进入 Copilot 视图
  try {
    const copilotTab = document.querySelector('.mode-tab[data-mode="copilot"]');
    if (copilotTab) copilotTab.click();
  } catch (e) {
    console.error('[copilot] 默认切换 Tab 失败:', e.message);
  }

  // ============ 订阅主进程广播「答题面板关闭→本场面试结束」============
  //   触发场景：用户点独立浮层右上角 × / 系统 Alt+F4 直接关浮层 / will-quit 关窗
  //   收到后：① 置 asrSessionEnded=true 让"重新打开答题面板"按钮隐藏（用户应该点 banner 的「开启新的面试」）
  //           ② 刷新按钮状态
  if (isElectron && electronIpcRenderer && typeof electronIpcRenderer.on === 'function') {
    try {
      electronIpcRenderer.on('overlay:closed-post-session', (_evt, payload) => {
        console.log('[copilot] 收到 overlay:closed-post-session', payload && payload.sessionId ? `sessionId=${String(payload.sessionId).slice(0,8)}... rounds=${payload.roundsCount}` : payload);
        asrSessionEnded = true;
        try { refreshReopenOverlayBtn(); } catch (_) {}
      });
    } catch (e) {
      console.warn('[copilot] 绑定 overlay:closed-post-session 监听失败:', e.message);
    }
  }
}

// 渲染层脚本在 body 末尾加载，DOM 已就绪，直接初始化
initCopilot();
