// 环境探测：区分 Electron / 浏览器双入口
const isElectronRenderer = typeof process !== 'undefined'
  && process.versions
  && !!process.versions.electron;
const hasNodeRequire = typeof require !== 'undefined';

/**
 * 浏览器模式下统一调用 dev-server 的 `/ipc/:channel` REST 通道。
 * 语义与 Electron 的 ipcRenderer.invoke 完全一致：返回 Promise<any>，
 * 失败时 reject 一个带错误消息的 Error。
 * （该函数实现与 copilot.js 的 invokeDevServer 完全一致，保持两端行为统一）
 */
const rendererInvokeDevServer = async (channel, ...args) => {
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
    if (/Failed to fetch|NetworkError/.test(String(e.message))) {
      throw new Error(`无法连接 dev-server。请先执行 \`node dev-server.js\`，或切换到 Electron 模式 \`npm start\`（原错误：${e.message}）`);
    }
    throw e;
  }
};

// Electron 模式：真实加载依赖；浏览器模式：ipcRenderer.invoke 走 fetch('/ipc/*') 调 dev-server
let ipcRenderer = null;
let RealtimeSpeechService = null;

if (isElectronRenderer && hasNodeRequire) {
  // ---- Electron 模式（原始行为，完全保持不变）----
  ipcRenderer = require('electron').ipcRenderer;
  RealtimeSpeechService = require('./services/realtimeSpeechService');
} else {
  // ---- 浏览器模式：invoke 走 REST；on/send 降级为 no-op，保证 UI 不崩 ----
  ipcRenderer = {
    // 关键：把 invoke 映射到 dev-server 的 REST 通道，
    //       这样 get-config/get-history/load-resume/... 都能拿到真实数据
    invoke: (channel, ...args) => rendererInvokeDevServer(channel, ...args),
    // 事件订阅：浏览器模式下没有主进程推事件，所以只做登记 + 返回 unsubscribe 函数
    on: (channel, listener) => {
      console.log(`[renderer-stub-on] channel=${channel}（浏览器模式下不订阅，返回空 unsubscribe）`);
      return function unsubscribe() { /* no-op */ };
    },
    // 移除监听器：浏览器模式下本来就没订阅，忽略即可
    removeListener: (channel, listener) => { /* no-op */ },
    // 主进程推送消息：浏览器模式下没有主进程，直接忽略
    send: (channel, ...args) => {
      console.log(`[renderer-stub-send] channel=${channel} args=`, args, '（浏览器模式下忽略）');
    }
  };
  // RealtimeSpeechService：浏览器模式不支持 WASAPI 系统音频采集，降级为返回友好错误
  RealtimeSpeechService = class {
    start() { return { success: false, error: '浏览器模式不支持系统音频实时识别，请切到 Electron (npm start)' }; }
    stop() { return true; }
    addAudio() {}
    flush() { return Promise.resolve([]); }
  };
}

// 状态管理
let appState = {
  config: {},
  history: [],
  favorites: [],
  isRecording: false,
  mediaRecorder: null,
  audioChunks: [],
  recorder: null,                  // PCM 录音器（手动录音用）
  currentQuestion: '',
  currentAnswer: '',
  isStealthMode: false,
  isListening: false,
  listeningSource: null,           // 监听来源: 'interview' | 'test' | null
  // 系统音频实时识别相关（替换原"持续监听"流程）
  listeningMediaRecorder: null,    // 保留兼容
  listeningAudioChunks: [],        // 保留兼容
  listeningRecorder: null,         // 兼容
  listeningTimer: null,            // 兼容
  systemAudioRt: null,             // RealtimeSpeechService 实例
  systemAudioRecorder: null,       // 系统音频 PCM 录音器
  systemAudioPump: null,           // 100ms / 1.5s 处理定时器
  // WASAPI 直连（用 native-audio-node）
  nativeListening: false,          // 是否在 WASAPI 直连模式
  nativeAudioBuffer: [],           // 累积音频数据（用于 REST 模式）
  nativeBufferSeconds: 0,          // 当前 buffer 时长
  isFavorited: false,
  // 优化：去重机制和对话历史
  recentQuestions: new Map(),      // 去重：问题文本 → 处理时间
  conversationHistory: [],         // 对话上下文：{role, content, timestamp}
  duplicateTimeout: 30000,         // 去重时间窗口：30秒
  // 简历相关
  resumeContent: ''                // 简历内容
};

// 暴露到 window，供 Copilot 控制器（src/renderer/copilot.js）同步配置与简历内容
window.appState = appState;

// ============================================================
// WAV 编码 + 原始 PCM 录音器
// 解决 MediaRecorder 输出 webm/opus 与百度 API 仅支持 wav/pcm 的不匹配问题
// 始终以 16kHz / 单声道 / 16-bit PCM 录制并直接编码为 WAV
// ============================================================
const WAV_SAMPLE_RATE = 16000;

// Float32 (-1..1) PCM 编码为 16-bit 单声道 WAV ArrayBuffer
function encodeWav(samples, sampleRate = WAV_SAMPLE_RATE) {
  const num = samples.length;
  const buf = new ArrayBuffer(44 + num * 2);
  const view = new DataView(buf);
  const writeStr = (o, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
  };
  // RIFF 头
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + num * 2, true);
  writeStr(8, 'WAVE');
  // fmt 块
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);                // PCM 子块大小
  view.setUint16(20, 1, true);                 // 格式 = PCM
  view.setUint16(22, 1, true);                 // 单声道
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);    // 字节率
  view.setUint16(32, 2, true);                 // 块对齐
  view.setUint16(34, 16, true);                // 位深
  // data 块
  writeStr(36, 'data');
  view.setUint32(40, num * 2, true);
  // PCM 数据（clamp 到 [-1, 1]）
  let off = 44;
  for (let i = 0; i < num; i++) {
    let s = samples[i];
    if (s > 1) s = 1; else if (s < -1) s = -1;
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    off += 2;
  }
  return buf;
}

// 基于 AudioContext 的 PCM 录音器
// 用法：
//   麦克风：const r = createPcmRecorder(); await r.start();
//   系统声音：const r = createPcmRecorder({ stream: systemStream }); r.start();
function createPcmRecorder({ stream: providedStream = null } = {}) {
  let ctx = null, source = null, processor = null, stream = null;
  let chunks = [];
  let archiveChunks = [];  // 系统音频存档缓冲：独立累积，不被 ASR 的 takeLastSeconds 清空，供会话结束时导出 WAV
  let active = false;

  return {
    async start() {
      if (providedStream) {
        stream = providedStream;
      } else {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
        });
      }
      // 强制 16kHz：AudioContext 会自动把输入重采样到目标采样率
      ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: WAV_SAMPLE_RATE });
      source = ctx.createMediaStreamSource(stream);
      // 4096 样本缓冲 / 1 进 1 出；不连到 destination，避免回放出声
      processor = ctx.createScriptProcessor(4096, 1, 1);
      source.connect(processor);
      chunks = [];
      active = true;
      processor.onaudioprocess = (e) => {
        if (active) {
          const data = new Float32Array(e.inputBuffer.getChannelData(0));
          chunks.push(data);
          // 同步累积到存档缓冲（拷贝一份，避免 takeAll/takeLastSeconds 取走后丢失）
          archiveChunks.push(new Float32Array(data));
        }
      };
    },
    // 取走全部累积样本并清空缓冲
    takeAll() {
      const total = chunks.reduce((s, c) => s + c.length, 0);
      const merged = new Float32Array(total);
      let off = 0;
      for (const c of chunks) { merged.set(c, off); off += c.length; }
      chunks = [];
      return merged;
    },
    // 取存档缓冲的全部样本（用于会话结束导出 WAV）；不清空，可重复取
    takeArchive() {
      const total = archiveChunks.reduce((s, c) => s + c.length, 0);
      const merged = new Float32Array(total);
      let off = 0;
      for (const c of archiveChunks) { merged.set(c, off); off += c.length; }
      return merged;
    },
    // 清空存档缓冲（释放内存）
    clearArchive() {
      archiveChunks = [];
    },
    // 取走最后 N 秒的样本并清空缓冲（不够 N 秒就全取）
    takeLastSeconds(seconds) {
      const want = Math.floor(WAV_SAMPLE_RATE * seconds);
      const total = chunks.reduce((s, c) => s + c.length, 0);
      if (total <= want) return this.takeAll();
      const drop = total - want;
      const kept = new Float32Array(want);
      let dst = 0, skip = drop;
      for (const c of chunks) {
        if (skip >= c.length) { skip -= c.length; continue; }
        if (skip > 0) {
          kept.set(c.subarray(skip), dst);
          dst += c.length - skip; skip = 0;
        } else {
          kept.set(c, dst); dst += c.length;
        }
      }
      chunks = [];
      return kept;
    },
    stop() {
      active = false;
      try { if (processor) processor.disconnect(); } catch (e) {}
      try { if (source) source.disconnect(); } catch (e) {}
      // 只在是自己创建的流时（getUserMedia）才关闭；外部传入的流由调用方管理
      if (!providedStream && stream) {
        try { stream.getTracks().forEach(t => t.stop()); } catch (e) {}
      }
      const c = ctx;
      ctx = null; source = null; processor = null; stream = null;
      chunks = [];
      archiveChunks = [];
      if (c && c.state !== 'closed') c.close().catch(() => {});
    }
  };
}

// 字体缩放（A⁻/A⁺）：独立于 Copilot 控制器，避免其初始化链路中断导致字体缩放失效
const FONT_ZOOM_MIN = 0.8;   // 最小 80%
const FONT_ZOOM_MAX = 1.5;   // 最大 150%
const FONT_ZOOM_STEP = 0.1;  // 步长 10%
const FONT_ZOOM_KEY = 'hireme:fontZoom';
const FONT_ZOOM_BASE = 16;   // 根元素基准字号（px），与 styles.css 中 html{font-size:16px} 对齐

/**
 * 初始化字体大小调整（纯字体缩放，不影响布局/间距/图标）：
 * 1. 从 localStorage 读取上次设置（非法值回退到 100%）
 * 2. 通过修改 <html> 根元素的 font-size 实现 rem 整体放大
 *    例：currentZoom=1.2 → html{font-size:19.2px} → 所有 1rem 单位字号从 16px 变 19.2px
 * 3. 绑定 A⁻（缩小）和 A⁺（放大）按钮的 click 事件
 * 4. 更新中间百分比显示，边界自动禁用按钮
 */
function initFontZoom() {
  const zoomOutBtn = document.getElementById('fontZoomOut');  // A⁻
  const zoomInBtn = document.getElementById('fontZoomIn');    // A⁺
  const zoomValLabel = document.getElementById('fontZoomVal'); // 中间显示 100%
  // 三个元素缺失则不初始化（例如未来删除 UI 时不会报错）
  if (!zoomOutBtn || !zoomInBtn || !zoomValLabel) return;

  // 读取持久化值，超出范围则用默认值 1
  let currentZoom = parseFloat(localStorage.getItem(FONT_ZOOM_KEY));
  if (!(currentZoom >= FONT_ZOOM_MIN && currentZoom <= FONT_ZOOM_MAX)) {
    currentZoom = 1;
  }

  /**
   * 统一应用缩放：修改根字号、百分比文字、按钮可用态
   * 只改 documentElement 的 font-size，所有 rem 字号按比例联动
   * padding/margin/width 仍用 px，布局保持稳定
   */
  const applyZoom = () => {
    document.documentElement.style.fontSize = (FONT_ZOOM_BASE * currentZoom) + 'px';
    zoomValLabel.textContent = Math.round(currentZoom * 100) + '%';
    zoomOutBtn.disabled = currentZoom <= FONT_ZOOM_MIN + 1e-9;  // 到下边界禁用减号
    zoomInBtn.disabled = currentZoom >= FONT_ZOOM_MAX - 1e-9;   // 到上边界禁用加号
  };
  applyZoom();

  // 缩小按钮（A⁻）：减去一个步长，裁剪到最小值，持久化并应用
  zoomOutBtn.addEventListener('click', () => {
    currentZoom = Math.max(FONT_ZOOM_MIN, +(currentZoom - FONT_ZOOM_STEP).toFixed(2));
    localStorage.setItem(FONT_ZOOM_KEY, String(currentZoom));
    applyZoom();
  });

  // 放大按钮（A⁺）：加上一个步长，裁剪到最大值，持久化并应用
  zoomInBtn.addEventListener('click', () => {
    currentZoom = Math.min(FONT_ZOOM_MAX, +(currentZoom + FONT_ZOOM_STEP).toFixed(2));
    localStorage.setItem(FONT_ZOOM_KEY, String(currentZoom));
    applyZoom();
  });

  // 与 overlay 面板保持一致：百分比标签也监听 storage 事件同步 + 双击复位 100%
  window.addEventListener('storage', (e) => {
    if (e.key !== FONT_ZOOM_KEY) return;
    const z = parseFloat(e.newValue);
    if (z >= FONT_ZOOM_MIN && z <= FONT_ZOOM_MAX && Math.abs(z - currentZoom) > 1e-6) {
      currentZoom = z;
      applyZoom();
    }
  });
  zoomValLabel.style.cursor = 'pointer';
  zoomValLabel.title = '双击恢复 100%';
  zoomValLabel.addEventListener('dblclick', () => {
    currentZoom = 1;
    localStorage.setItem(FONT_ZOOM_KEY, String(currentZoom));
    applyZoom();
  });
}

// DOM元素
const elements = {
  recordingStatus: document.getElementById('recordingStatus'),
  statusIndicator: document.querySelector('.status-indicator'),
  statusText: document.querySelector('.status-text'),
  settingsBtn: document.getElementById('settingsBtn'),
  settingsModal: document.getElementById('settingsModal'),
  closeSettingsBtn: document.getElementById('closeSettingsBtn'),
  saveSettingsBtn: document.getElementById('saveSettingsBtn'),
  historySidebar: document.getElementById('historySidebar'),
  openHistoryBtn: document.getElementById('openHistoryBtn'), // 顶栏 📋 历史按钮：打开/关闭侧栏
  closeHistoryBtn: document.getElementById('closeHistoryBtn'),
  historyList: document.getElementById('historyList'),
  copilotHistoryRow: document.getElementById('copilotHistoryRow'), // 主窗口「📋 面试记录」卡片：点击展开侧栏
  alwaysOnTop: document.getElementById('alwaysOnTop'),
  opacitySlider: document.getElementById('opacitySlider'),
  opacityValue: document.getElementById('opacityValue'),
  quickHideBtn: document.getElementById('quickHideBtn'),
  toggleStealthBtn: document.getElementById('toggleStealthBtn'),
  hotkeyDisplay: document.getElementById('hotkeyDisplay'),
  hotkeyInput: document.getElementById('hotkeyInput'),
  testHideBtn: document.getElementById('testHideBtn'),
  captureHideToggle: document.getElementById('captureHideToggle'),  // 截图/录屏不可见总开关
  listenBtn: document.getElementById('listenBtn'),
  listeningStatus: document.getElementById('listeningStatus'),
  listeningText: document.getElementById('listeningText'),
  listeningProgress: document.getElementById('listeningProgress'),
  detectionSensitivity: document.getElementById('detectionSensitivity'),
  sensitivityValue: document.getElementById('sensitivityValue'),
  processingInterval: document.getElementById('processingInterval'),
  audioBoost: document.getElementById('audioBoost'),
  audioBoostValue: document.getElementById('audioBoostValue'),
  autoSaveHistory: document.getElementById('autoSaveHistory'),
  startInterviewBtn: document.getElementById('startInterviewBtn'),
  // 简历相关元素
  uploadResumeBtn: document.getElementById('uploadResumeBtn'),
  saveResumeBtn: document.getElementById('saveResumeBtn'),
  clearResumeBtn: document.getElementById('clearResumeBtn'),
  resumeEditor: document.getElementById('resumeEditor'),
  resumeStatus: document.getElementById('resumeStatus'),
  // 三 Tab 切换（Copilot / 模拟面试 / 简历优化）
  modeTabs: document.getElementById('modeTabs'),
  copilotPanel: document.getElementById('copilotPanel'),
  classicPanel: document.getElementById('classicPanel'),
  resumePanel: document.getElementById('resumePanel'),
  // 公司/职位 JD
  targetCompany: document.getElementById('targetCompany'),
  targetPosition: document.getElementById('targetPosition'),
  jobDescription: document.getElementById('jobDescription'),
  // 面试记录：📚 查看全部面试记录（已挪到卡片区开始面试辅助正下方；⏹/🆕 已删除 —— 用户要求：浮动面板点×=结束本场；主窗口不再放两按钮）
  btnViewAllSessions: document.getElementById('btnViewAllSessions'),
  bottomToast: document.getElementById('bottomToast'),
  // 面试记录：关闭浮动面板后显示的「面试结束总结页」
  endSessionView:     document.getElementById('endSessionView'),
  esvBackHomeBtn:     document.getElementById('esvBackHomeBtn'),
  esvSessionMeta:     document.getElementById('esvSessionMeta'),
  esvDuration:        document.getElementById('esvDuration'),
  esvQuestionCount:   document.getElementById('esvQuestionCount'),
  esvAnswerCount:     document.getElementById('esvAnswerCount'),
  esvRatingStars:     document.getElementById('esvRatingStars'),
  esvRatingHint:      document.getElementById('esvRatingHint'),
  esvCopyInviteBtn:   document.getElementById('esvCopyInviteBtn'),
  esvReviewBtn:       document.getElementById('esvReviewBtn'),
  esvNewSessionBtn:   document.getElementById('esvNewSessionBtn'),
  esvViewDetailBtn:   document.getElementById('esvViewDetailBtn'),
  // 面试记录：viewRouter 四面板（home / list / detail / end）
  viewHome: document.getElementById('viewHome'),
  viewSessionsList: document.getElementById('viewSessionsList'),
  viewSessionDetail: document.getElementById('viewSessionDetail'),
  // 面试记录：列表页
  btnListBackHome: document.getElementById('btnListBackHome'),
  sessionsListContainer: document.getElementById('sessionsListContainer'),
  sessionsEmptyHint: document.getElementById('sessionsEmptyHint'),
  sessionSearchInput: document.getElementById('sessionSearchInput'),
  sessionTotalHint: document.getElementById('sessionTotalHint'),
  btnReloadSessionList: document.getElementById('btnReloadSessionList'),
  // ★ 面试类型分类 Tab（真实 copilot / 模拟 mock）
  sessionCategoryTabs: document.getElementById('sessionCategoryTabs'),
  // 面试记录：详情页
  btnDetailBack: document.getElementById('btnDetailBack'),
  sessionDetailTitle: document.getElementById('sessionDetailTitle'),
  sessionDetailMeta:  document.getElementById('sessionDetailMeta'),
  sessionDetailChat:  document.getElementById('sessionDetailChat'),
  sessionDetailEmpty: document.getElementById('sessionDetailEmpty'),

  // ============================================================
  // ★ 登录 / 账号 相关元素（全屏 SPA 视图 #authPage + 旧 Modal DOM 兼容）
  // ============================================================
  // 全屏视图容器：主路由级别（data-view='auth'），打开时覆盖整个主窗口
  authPage:            document.getElementById('authPage'),
  loginPageCard:       document.getElementById('loginPageCard'),
  forgotPageCard:      document.getElementById('forgotPageCard'),
  mergePageCard:       document.getElementById('mergePageCard'),
  loginPageTitle:      document.getElementById('loginPageTitle'),

  // 顶部按钮（保留，后续兼容桌面标题栏旁登录按钮）
  loginBtn:         document.getElementById('loginBtn'),
  userArea:         document.getElementById('userArea'),
  userAvatarBtn:    document.getElementById('userAvatarBtn'),
  userDropdown:     document.getElementById('userDropdown'),
  udAvatarBig:      document.getElementById('udAvatarBig'),
  udDisplayName:    document.getElementById('udDisplayName'),
  udUserEmail:      document.getElementById('udUserEmail'),

  // 登录弹窗（保留用于向后兼容 / 旧有模态 id，实际已由全屏视图接管显示）
  loginModal:       document.getElementById('loginModal'),
  closeLoginBtn:    document.getElementById('closeLoginBtn'),
  loginModalTitle:  document.getElementById('loginModalTitle'),
  loginPanel:       document.getElementById('panelLogin'),
  loginForm:        document.getElementById('loginForm'),
  loginEmail:       document.getElementById('loginEmail'),
  loginPwd:         document.getElementById('loginPwd'),
  loginError:       document.getElementById('loginError'),
  loginSubmitBtn:   document.getElementById('loginSubmitBtn'),
  forgotLink:       document.getElementById('forgotLink'),

  // 初始化管理员面板
  initAdminPanel:   document.getElementById('panelInitAdmin'),
  initAdminForm:    document.getElementById('initAdminForm'),
  initEmail:        document.getElementById('initEmail'),
  initDisplayName:  document.getElementById('initDisplayName'),
  initPwd:          document.getElementById('initPwd'),
  initPwd2:         document.getElementById('initPwd2'),
  initAdminError:   document.getElementById('initAdminError'),
  initAdminSubmitBtn: document.getElementById('initAdminSubmitBtn'),

  // 忘记密码弹窗 / 页面（三步流程共用的 DOM，新旧 id 均绑定）
  forgotPwdModal:   document.getElementById('forgotPwdModal'),
  closeForgotBtn:   document.getElementById('closeForgotBtn'),
  forgotBack1:      document.getElementById('forgotBack1'),
  forgotBack2:      document.getElementById('forgotBack2'),
  forgotGoLogin:    document.getElementById('forgotGoLogin'),
  forgotStep1:      document.getElementById('forgotStep1'),
  forgotStep2:      document.getElementById('forgotStep2'),
  forgotStep3:      document.getElementById('forgotStep3'),
  forgotStep1Form:  document.getElementById('forgotStep1Form'),
  forgotStep2Form:  document.getElementById('forgotStep2Form'),
  forgotEmail:      document.getElementById('forgotEmail'),
  forgotError:      document.getElementById('forgotError'),
  forgotResetCodeDisplay: document.getElementById('forgotResetCodeDisplay'),
  forgotResetInput: document.getElementById('forgotResetInput'),
  forgotNewPwd:     document.getElementById('forgotNewPwd'),
  forgotNewPwd2:    document.getElementById('forgotNewPwd2'),
  forgotError2:     document.getElementById('forgotError2'),
  forgotStepPills:  document.querySelectorAll('.step-pill'),
  forgotStep1Next:  document.getElementById('forgotStep1Next'),
  forgotStep2Submit:document.getElementById('forgotStep2Submit'),

  // 合并游客数据弹窗 / 页面
  mergeGuestDialog: document.getElementById('mergeGuestDialog'),
  mergeStatsList:   document.getElementById('mergeStatsList'),
  mergeSkipBtn:     document.getElementById('mergeSkipBtn'),
  mergeDoBtn:       document.getElementById('mergeDoBtn'),

  // ============================================================
  // ★ 积分 & 充值 & 后台管理：动态插入到顶部栏的 DOM（缓存引用，避免每次创建新元素）
  //   实际 DOM 节点在首次渲染时由 _ensureCreditsTopDom() 创建并挂载到 userArea 之前。
  // ============================================================
  creditsTopWrapper:      null, // 父容器 <div class="credits-top">
  creditsBalanceBadge:    null, // 左侧徽章「积分 1234」
  creditsStatusBadge:     null, // 右侧小徽章「离线」/「在线」
  creditsRechargeBtn:     null, // 「充值」按钮 → 调 credits.openConsole
  creditsAdminBtn:        null, // 「后台」按钮（仅管理员显示）→ 调 credits.openAdmin
};

// ============================================================
// ★ 面试记录：真实/模拟 分类 Tab 状态（互斥）
//   categoryFilter 允许值：'copilot' | 'mock'
//   不允许为空（方案 A 强制互斥分开展示）
// ============================================================
const SessionListUI = {
  /** 当前选中的面试类型过滤器：'copilot'=真实 / 'mock'=模拟 */
  categoryFilter: 'copilot',
};

/**
 * 切换面试类型 Tab 并重新拉取列表。
 * @param {'copilot'|'mock'} category   目标分类
 * @param {object}         [opts]       可选参数
 * @param {boolean}        [opts.skipFetch=false]  true 时仅更新 UI，不重新拉列表
 */
function setSessionCategory(category, opts = {}) {
  // 1. 防御：仅接受 'copilot' 或 'mock'（方案 A 强制互斥）
  const cat = (category === 'mock') ? 'mock' : 'copilot';
  SessionListUI.categoryFilter = cat;

  // 2. 同步 DOM：所有 sc-tab 去除 active，匹配的加上
  if (elements.sessionCategoryTabs) {
    const tabs = elements.sessionCategoryTabs.querySelectorAll('.sc-tab');
    tabs.forEach((tab) => {
      if (tab.dataset.category === cat) tab.classList.add('active');
      else tab.classList.remove('active');
    });
  }

  // 3. 搜索关键字保持不变，仅按新分类重刷列表
  if (!(opts && opts.skipFetch)) {
    const kw = (elements.sessionSearchInput && elements.sessionSearchInput.value) || '';
    renderSessionsList(kw);
  }
}

// ============================================================
// ★ 登录 / 账号 UI 状态
// ============================================================
const AuthUI = {
  /** 当前登录用户对象：{loggedIn, accountId, email, displayName, avatar, ...}，未登录时 loggedIn=false */
  currentUser: null,
  /** 本地是否已创建过任何账号（用于判断弹窗显示普通登录 or 初始化管理员） */
  hasAnyAccount: true,
  /** 邮箱正则（与 authService 保持一致） */
  emailRe: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
};

/**
 * 获取 electronAPI 通道（兜底为 ipcRenderer 双通道）
 * @returns {{auth?: object, authLegacy?: boolean}}
 */
function _authCh() {
  if (window.electronAPI && window.electronAPI.auth) return { api: window.electronAPI };
  // 兼容无 preload 的回退：直接用 ipcRenderer.invoke（渲染层通过 require('electron') 取得）
  const ir = window.ipcRenderer || (typeof require === 'function' ? (() => { try { return require('electron').ipcRenderer; } catch (_) { return null; } })() : null);
  return {
    api: null,
    legacy: !!ir,
    invoke: (k, a) => ir.invoke(k, a),
    on: (k, cb) => ir.on(k, (_e, p) => cb(p)),
  };
}

/**
 * 生成头像显示字符：优先显示名首字；无则取邮箱 @ 前首字；再兜底 "U"
 * @param {{displayName?:string, email?:string}} user
 * @returns {string}
 */
function _avatarLetter(user) {
  if (!user) return 'U';
  const dn = String(user.displayName || '').trim();
  if (dn) return Array.from(dn)[0].toUpperCase();
  const em = String(user.email || '').trim().split('@')[0];
  if (em) return Array.from(em)[0].toUpperCase();
  return 'U';
}

/**
 * 渲染顶部入口：登录按钮 or 头像
 */
function renderTopAccountEntry() {
  const user = AuthUI.currentUser || {};
  const logged = !!user.loggedIn;
  // 按钮显隐
  if (elements.loginBtn)   elements.loginBtn.classList.toggle('hidden',  logged);
  if (elements.userArea)   elements.userArea.classList.toggle('hidden', !logged);
  // 头像字符
  const letter = _avatarLetter(user);
  if (elements.userAvatarBtn)  elements.userAvatarBtn.textContent = letter;
  if (elements.udAvatarBig)    elements.udAvatarBig.textContent = letter;
  // 下拉资料
  if (elements.udDisplayName)  elements.udDisplayName.textContent = user.displayName || '—';
  if (elements.udUserEmail)    elements.udUserEmail.textContent   = user.email       || '—';

  // ---- 顶部积分徽章 / 充值 / 后台入口（登录后显示） ----
  _ensureCreditsTopDom();
  _setCreditsTopVisible(logged);
  if (logged) {
    // 按钮权限：isAdmin 才显示后台入口
    if (elements.creditsAdminBtn) {
      elements.creditsAdminBtn.style.display = (user.isAdmin === true) ? '' : 'none';
    }
    // 异步拉取余额并渲染（不阻塞，失败显示「离线」）
    _refreshCreditsBadge().catch((e) => console.warn('[credits] 顶部积分刷新失败：', e && e.message));
  } else {
    // 未登录：直接清空余额文字
    if (elements.creditsBalanceBadge) elements.creditsBalanceBadge.textContent = '积分 —';
    if (elements.creditsStatusBadge)  elements.creditsStatusBadge.textContent  = '';
  }
}

// ============================================================
// ★ 顶部积分栏：DOM 创建 + 渲染余额 + 通用"尝试扣积分并在不足时引导充值"工具
// ============================================================
/**
 * 获取 credits 通道（优先 ch.api.credits，否则走 ipc.invoke 兜底）。
 * 浏览器模式下可能不存在，调用方需自行处理 null。
 */
function _creditsCh() {
  try {
    if (typeof window === 'undefined') return null;
    // 优先 electronAPI（preload 暴露的正式通道）
    if (window.electronAPI && window.electronAPI.credits) return window.electronAPI.credits;
    // 兼容：项目其它地方使用的 _ch() / require('electron').ipcRenderer 兜底
    const ch = (typeof _authCh === 'function') ? _authCh() : null;
    if (ch && ch.api && ch.api.credits) return ch.api.credits;
    return null;
  } catch (_) { return null; }
}
/** 确保"积分+充值"的顶部 DOM 已创建，并挂到 elements.userArea 之前。 */
function _ensureCreditsTopDom() {
  if (!elements.userArea || !elements.userArea.parentNode) return;
  if (elements.creditsTopWrapper) return; // 已创建
  const wrap = document.createElement('div');
  wrap.className = 'credits-top';
  wrap.style.cssText = 'display:inline-flex;align-items:center;gap:8px;margin-right:10px;vertical-align:middle;';
  // 余额徽章
  const bal = document.createElement('span');
  bal.className = 'credits-balance';
  bal.style.cssText = 'display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;background:linear-gradient(135deg,#3B82F6 0%,#8B5CF6 100%);color:#fff;font-weight:600;font-size:13px;box-shadow:0 2px 8px rgba(59,130,246,0.25);';
  bal.textContent = '积分 —';
  wrap.appendChild(bal);
  // 状态小徽章（离线/在线）
  const tag = document.createElement('span');
  tag.className = 'credits-status';
  tag.style.cssText = 'font-size:11px;padding:2px 8px;border-radius:999px;background:#F3F4F6;color:#4B5563;border:1px solid #E5E7EB;';
  tag.textContent = '';
  wrap.appendChild(tag);
  // 充值按钮
  const rech = document.createElement('button');
  rech.type = 'button';
  rech.className = 'credits-recharge-btn';
  rech.textContent = '💎 充值';
  rech.style.cssText = 'border:none;padding:4px 12px;border-radius:8px;background:#FCD34D;color:#7C2D12;font-weight:600;font-size:13px;cursor:pointer;';
  rech.title = '打开宣传站点控制台进行充值（浏览器模式）';
  rech.addEventListener('click', async () => {
    try {
      const c = _creditsCh(); if (!c || !c.openConsole) { alert('当前环境不可用：请在 HireMe 桌面端或宣传站点控制台页面中充值。'); return; }
      await c.openConsole();
    } catch (e) { console.warn(e); }
  });
  wrap.appendChild(rech);
  // 管理员：后台按钮
  const adm = document.createElement('button');
  adm.type = 'button';
  adm.className = 'credits-admin-btn';
  adm.textContent = '🛠 后台';
  adm.style.cssText = 'border:none;padding:4px 12px;border-radius:8px;background:#6366F1;color:#fff;font-weight:600;font-size:13px;cursor:pointer;display:none;';
  adm.title = '（管理员）打开宣传站点后台管理系统（在系统浏览器中打开）';
  adm.addEventListener('click', async () => {
    try {
      const c = _creditsCh(); if (!c || !c.openAdmin) { alert('当前环境不可用。'); return; }
      await c.openAdmin();
    } catch (e) { console.warn(e); }
  });
  wrap.appendChild(adm);
  // 插到 userArea 之前（保证在最右侧用户头像左侧）
  elements.userArea.parentNode.insertBefore(wrap, elements.userArea);
  elements.creditsTopWrapper   = wrap;
  elements.creditsBalanceBadge = bal;
  elements.creditsStatusBadge  = tag;
  elements.creditsRechargeBtn  = rech;
  elements.creditsAdminBtn     = adm;
}
/** 登录/未登录时显隐整个 credits-top 包装 */
function _setCreditsTopVisible(visible) {
  if (!elements.creditsTopWrapper) return;
  elements.creditsTopWrapper.style.display = visible ? '' : 'none';
}
/**
 * 异步刷新顶部积分徽章：
 *   - 远端有连接 → 调 getBalance() 拿到实时 balance
 *   - 离线 / 本地模式 / 未连接 → 标「离线」
 */
async function _refreshCreditsBadge() {
  const c = _creditsCh();
  if (!elements.creditsBalanceBadge) return;
  if (!c || !c.getBalance) {
    elements.creditsBalanceBadge.textContent = '积分 —';
    if (elements.creditsStatusBadge) elements.creditsStatusBadge.textContent = '';
    return;
  }
  const b = await c.getBalance();
  if (b && (b.offline || b.balance === null || b.balance === undefined)) {
    elements.creditsBalanceBadge.textContent = '积分 —';
    if (elements.creditsStatusBadge) {
      elements.creditsStatusBadge.textContent = '离线';
      elements.creditsStatusBadge.style.background = '#FEF3C7';
      elements.creditsStatusBadge.style.color = '#92400E';
      elements.creditsStatusBadge.style.borderColor = '#FDE68A';
    }
    return;
  }
  if (b && b.ok) {
    const bal = Number(b.balance) || 0;
    elements.creditsBalanceBadge.textContent = `积分 ${bal.toLocaleString()}`;
    if (elements.creditsStatusBadge) {
      elements.creditsStatusBadge.textContent = '在线';
      elements.creditsStatusBadge.style.background = '#D1FAE5';
      elements.creditsStatusBadge.style.color = '#065F46';
      elements.creditsStatusBadge.style.borderColor = '#6EE7B7';
    }
  } else {
    elements.creditsBalanceBadge.textContent = '积分 —';
    if (elements.creditsStatusBadge) {
      elements.creditsStatusBadge.textContent = (b && b.msg) || '异常';
      elements.creditsStatusBadge.style.background = '#FEE2E2';
      elements.creditsStatusBadge.style.color = '#991B1B';
      elements.creditsStatusBadge.style.borderColor = '#FECACA';
    }
  }
}
/**
 * 通用工具：尝试在"执行某功能"前扣积分；如果没积分就引导用户去充值。
 * 适合三大功能入口（Copilot/模拟面试/简历优化）统一调用。
 *
 * @param {object}  p
 * @param {'copilot_session'|'mock_round'|'resume_optimize'}  p.bizType  业务类型（对应 server.js 的流水 bizType）
 * @param {number}  p.credits  需要消耗的积分数量（正整数）
 * @param {string} [p.bizId]   业务唯一 ID（可选，用于对账/去重）
 * @param {string} [p.desc]    流水说明文字（可选，用户流水里展示）
 * @param {string} [p.bizName] 业务的中文名称（弹窗"是否去充值"时显示用）
 * @returns {Promise<{ok:boolean, offline?:boolean, msg?:string, balance?:number, creditsConsumed?:number, flowId?:string, skipped?:boolean}>}
 *   - ok:true → 扣费成功 OR 离线模式允许使用
 *   - ok:false → 失败（积分不足 / 调用失败）；若 missing>0 表示积分不足且用户取消了充值
 */
async function tryConsumeCreditsBefore(p = {}) {
  const bizType = String(p.bizType || '').trim() || 'consume';
  const credits = Number(p.credits);
  const bizName = String(p.bizName || bizType || '本次功能');
  if (!Number.isSafeInteger(credits) || credits <= 0) {
    return { ok: false, error: 'BAD_CREDITS', msg: '非法积分数量' };
  }

  const c = _creditsCh();
  // 通道不存在（比如非 Electron 纯浏览器打开 renderer）：视为"离线允许"
  if (!c || !c.consume) {
    return { ok: true, offline: true, skipped: true, msg: '未连接积分服务，本次未扣积分。' };
  }

  const r = await c.consume({
    credits,
    bizType,
    bizId: p.bizId ? String(p.bizId).slice(0, 64) : undefined,
    desc:  p.desc  ? String(p.desc).slice(0, 200)  : undefined,
  });

  // 成功：扣费成功 OR 离线不扣 → 放行业务
  if (r && r.ok) {
    // 扣费/离线成功 → 顺手刷新顶部余额，避免显示旧值
    _refreshCreditsBadge().catch(() => {});
    if (r.offline && r.msg) {
      try {
        alert(`💡 ${r.msg}\n\n建议：在宣传站点服务器启动时，使用同一账号（在 HireMe 内登录），即可开启积分消费。`);
      } catch (_) {}
    }
    return { ...r };
  }

  // 失败：积分不足 → 弹"去充值"对话框
  if (r && r.error === 'INSUFFICIENT_CREDITS') {
    const cur  = Number(r.current)  || 0;
    const need = Number(r.required) || credits;
    const miss = Number(r.missing)  || (need - cur);
    const msg =
      `积分不足，无法开始「${bizName}」。\n\n` +
      `当前可用积分：${cur}\n本次需要积分：${need}\n还差：${miss}\n\n` +
      `是否现在打开宣传站点控制台进行充值？（将在系统浏览器中打开）`;
    const ok = window.confirm(msg);
    if (ok) {
      try { if (c.openConsole) await c.openConsole(); } catch (_) {}
    }
    return { ok: false, error: 'INSUFFICIENT_CREDITS', current: cur, required: need, missing: miss,
             msg: `积分不足，还差 ${miss} 分。已取消开始「${bizName}」。` };
  }

  // 其它失败：兜底弹一个 alert 并透传
  const errMsg = (r && r.msg) || '扣积分失败';
  try { alert(`⚠️ ${errMsg}\n\n本次未开始「${bizName}」。`); } catch (_) {}
  return { ok: false, error: (r && r.error) || 'CONSUME_FAILED', msg: errMsg };
}

/**
 * 显示通用错误文本（含 CSS 抖动），2.5s 后自动淡化
 * @param {HTMLElement|null} el
 * @param {string}           msg
 */
function _setAuthError(el, msg) {
  if (!el) return;
  el.textContent = msg || '';
  el.classList.remove('hidden');
  el.classList.remove('shake');
  // 触发动画重排
  void el.offsetWidth;
  el.classList.add('shake');
  clearTimeout(el.__hideT);
  el.__hideT = setTimeout(() => el.classList.add('hidden'), 2500);
}

/**
 * 账号全屏 SPA 路由：显示 #authPage 并切换内部卡片
 *   - mode: 'login'（默认：登录/初始化）| 'forgot'（忘记密码三步）
 *   🟢 已移除 mode='merge'：合并游客数据功能已废弃，传 merge 等价于显示 login
 *   - 内部实现会同时隐藏另外两张卡片，保证同一时刻 #authPage 内只有一张卡片可见
 * @param {'login'|'forgot'} [mode='login']
 */
function showAuthPage(mode) {
  const which = (mode === 'forgot') ? 'forgot' : 'login';
  if (elements.authPage) {
    // 全屏视图作为 SPA 路由：去掉 .hidden 即进入（与 viewHome / viewSessionsList 同级机制）
    elements.authPage.classList.remove('hidden');
  }
  // 🟢 只维护两张卡：登录 / 忘记密码。合并卡片不再使用（如果 HTML 里仍存在，统一加 hidden）
  const cards = [elements.loginPageCard, elements.forgotPageCard, elements.mergePageCard].filter(Boolean);
  const showCard = which === 'forgot' ? elements.forgotPageCard : elements.loginPageCard;
  cards.forEach((c) => { if (c) c.classList.add('hidden'); });
  if (showCard) showCard.classList.remove('hidden');
  // 打开全屏视图时，收起身后可能还开着的用户下拉（视觉整洁）
  if (elements.userDropdown && !elements.userDropdown.classList.contains('hidden')) {
    elements.userDropdown.classList.add('hidden');
  }
  // 打开后把焦点放到第一个输入框，体验与页面一致
  requestAnimationFrame(() => {
    if (which === 'login' && elements.loginEmail) try { elements.loginEmail.focus({ preventScroll: true }); } catch (_) {}
    else if (which === 'forgot' && elements.forgotEmail) try { elements.forgotEmail.focus({ preventScroll: true }); } catch (_) {}
  });
}

/**
 * 关闭账号全屏 SPA 路由：回到主界面（viewHome/viewSessionsList 等根据当前路由继续显示）
 *   - 本质是把 #authPage 加回 .hidden
 */
function hideAuthPage() {
  if (elements.authPage) {
    // 全屏视图加回 .hidden 即退出账号页，背后主界面由 viewRouter 维持可见
    elements.authPage.classList.add('hidden');
  }
  // 退出账号视图时，顺手把忘记密码步骤条归位（下次进入更干净）
  try { setForgotStep(1); } catch (_) {}
  // 关闭合并卡片（如果之前被打开）+ 合并统计列表清空（避免再次看到旧数据）
  if (elements.mergeStatsList) elements.mergeStatsList.innerHTML = '';
}

/**
 * 打开登录页：冷启动显示"初始化管理员"，否则显示普通登录
 *   - 现在以全屏 SPA 路由显示，不再依赖模态遮罩层
 */
async function openLoginModal() {
  if (!elements.loginPageCard) return;
  // 弹窗打开前刷新 hasAnyAccount 状态（避免启动后外部同步账号，首次点击仍显示初始化）
  try {
    const ch = _authCh();
    const r = (ch && ch.api) ? await ch.api.auth.hasAnyAccount() : (ch && ch.legacy ? await ch.invoke('auth-has-any-account') : null);
    if (r && typeof r.hasAny === 'boolean') AuthUI.hasAnyAccount = r.hasAny;
  } catch (_) { /* 失败沿用缓存，不至于阻塞页面打开 */ }

  const isInit = !AuthUI.hasAnyAccount;
  if (elements.loginPanel)     elements.loginPanel.classList.toggle('hidden',  isInit);
  if (elements.initAdminPanel) elements.initAdminPanel.classList.toggle('hidden', !isInit);
  // 新全屏视图下的标题（优先）
  if (elements.loginPageTitle) {
    elements.loginPageTitle.textContent = isInit ? '🌱 创建第一个本地账号' : '🔐 登录 HireMe';
  }
  // 旧模态标题（兼容/兜底，若未来切换回模态也能工作）
  if (elements.loginModalTitle) {
    elements.loginModalTitle.textContent = isInit ? '🌱 创建第一个本地账号' : '🔐 登录 HireMe';
  }
  // 清空错误 + 清空表单（避免上一次残留）
  if (elements.loginError)     elements.loginError.classList.add('hidden');
  if (elements.initAdminError) elements.initAdminError.classList.add('hidden');
  if (elements.loginEmail)     elements.loginEmail.value = '';
  if (elements.loginPwd)       elements.loginPwd.value   = '';
  if (elements.initEmail)      elements.initEmail.value  = '';
  if (elements.initDisplayName)elements.initDisplayName.value = '';
  if (elements.initPwd)        elements.initPwd.value    = '';
  if (elements.initPwd2)       elements.initPwd2.value   = '';

  // 实际进入账号页面（login 卡片）
  showAuthPage('login');
}

/**
 * 关闭登录页：回到主界面
 */
function closeLoginModal() {
  hideAuthPage();
  // 旧模态同步关闭（向前兼容）
  if (elements.loginModal) {
    elements.loginModal.classList.remove('open');
    setTimeout(() => { if (elements.loginModal) elements.loginModal.classList.add('hidden'); }, 100);
  }
}

/**
 * 切换忘记密码步骤条高亮
 * @param {1|2|3} step
 */
function setForgotStep(step) {
  const boxes = [elements.forgotStep1, elements.forgotStep2, elements.forgotStep3];
  boxes.forEach((el, idx) => { if (el) el.classList.toggle('hidden', idx !== step - 1); });
  const NodeList = window.NodeList;
  (function setPills() {
    const pills = (elements.forgotStepPills instanceof NodeList) ? Array.from(elements.forgotStepPills) : document.querySelectorAll('.step-pill');
    pills.forEach((pill) => {
      const s = Number(pill.dataset.step || 0);
      pill.classList.toggle('active', s <= step);
    });
  })();
}

/**
 * 打开忘记密码流程（以全屏视图 forgot 卡片承载）
 */
function openForgotModal() {
  if (elements.forgotEmail)    elements.forgotEmail.value    = '';
  if (elements.forgotError)    elements.forgotError.classList.add('hidden');
  if (elements.forgotError2)   elements.forgotError2.classList.add('hidden');
  if (elements.forgotResetInput) elements.forgotResetInput.value = '';
  if (elements.forgotNewPwd)  elements.forgotNewPwd.value  = '';
  if (elements.forgotNewPwd2) elements.forgotNewPwd2.value = '';
  if (elements.forgotResetCodeDisplay) {
    elements.forgotResetCodeDisplay.innerHTML = '';
    elements.forgotResetCodeDisplay.classList.add('hidden');
  }
  setForgotStep(1);
  // 以全屏视图 forgot 卡片显示
  showAuthPage('forgot');
  // 旧模态同步关闭/打开（兼容/兜底）
  if (elements.forgotPwdModal) {
    elements.forgotPwdModal.classList.remove('hidden');
    requestAnimationFrame(() => { if (elements.forgotPwdModal) elements.forgotPwdModal.classList.add('open'); });
  }
}

function closeForgotModal() {
  // 若当前只有 forgot 卡片（之前从登录页点过来），返回登录页；否则回到主界面
  if (elements.authPage && !elements.authPage.classList.contains('hidden')
      && elements.loginPageCard && elements.loginPageCard.classList.contains('hidden')
      && elements.mergePageCard && elements.mergePageCard.classList.contains('hidden')) {
    // 只把内部卡片切回 login，保留 #authPage 打开状态（用户还没登录完成呢）
    if (elements.loginPageCard)  elements.loginPageCard.classList.remove('hidden');
    if (elements.forgotPageCard) elements.forgotPageCard.classList.add('hidden');
    if (elements.mergePageCard)  elements.mergePageCard.classList.add('hidden');
  } else {
    // 其他情况：直接收起整个账号视图
    hideAuthPage();
  }
  // 旧模态同步关闭
  if (elements.forgotPwdModal) {
    elements.forgotPwdModal.classList.remove('open');
    setTimeout(() => { if (elements.forgotPwdModal) elements.forgotPwdModal.classList.add('hidden'); }, 100);
  }
}

/**
 * 登录成功后：直接进入主界面。
 * 🟢 已移除"询问合并游客数据"流程 —— 根据需求：只要用户登录，
 *    就能看到 SQLite 中属于他本人的相关数据；GUEST 账号下的数据保持独立，
 *    不再进行 session/resume 的搬运与清空。
 *    用户如果想回到 GUEST 命名空间下的数据，直接登出（回到游客模式）即可看到。
 */
async function maybeAskMergeGuest() {
  // 空实现：不弹任何对话框，登录成功后直接进主界面
  return;
}

/**
 * 预检测游客是否有数据（用于决定是否弹出合并对话框）
 * 🟢 已废弃：保留函数签名（避免其他地方直接调用时报 undefined），但永远返回 false。
 * @returns {Promise<{hasData:boolean, stats:Array<{label:string, value:string}>}>}
 */
async function getGuestStatsPreflight() {
  return { hasData: false, stats: [] };
}

/**
 * 打开合并游客数据确认页
 * 🟢 已废弃：合并功能已移除。保留函数签名但啥都不做，保证兼容性。
 */
async function openMergeGuestDialog(stats) {
  return;
}

function closeMergeGuestDialog() {
  // 🟢 已废弃：合并对话框不存在需要关闭的内容；保留一个空实现兜底
  hideAuthPage();
}

/**
 * 账号切换时，重新加载当前命名空间下的：简历、面试记录列表、Copilot/模拟面试面板缓存数据
 * （配置 / 知识库按账号隔离需 main.js configManager 支持命名空间，未支持时这里至少保证 I/O 层 resume/session 正确）
 */
async function onAccountNamespaceSwitched(userObj) {
  try {
    // 1. 重新加载 resume（main.js load-resume 会自动按 currentAccountId 切换路径）
    await loadResume();
    // 2. 如果当前正位于面试记录列表页，则按当前分类过滤器刷新
    if (typeof renderSessionsList === 'function'
        && elements.viewSessionsList
        && !elements.viewSessionsList.classList.contains('hidden')) {
      const kw = (elements.sessionSearchInput && elements.sessionSearchInput.value) || '';
      renderSessionsList(kw);
    }
    // 3. 通知 Copilot / 模拟面试等子模块：账号命名空间已变更
    try {
      window.dispatchEvent(new CustomEvent('hireme:account-namespace-changed', {
        detail: { user: userObj || null },
      }));
    } catch (_) { /* 旧浏览器不支持 CustomEvent 时忽略 */ }
  } catch (e) {
    console.warn('[auth] 账号切换时重载 UI 失败：', e && e.message);
  }
}

/**
 * 初始化鉴权 UI：获取当前用户 + hasAnyAccount + 订阅状态变更事件
 */
async function initAuthUI() {
  try {
    const ch = _authCh();
    if (!ch || (!ch.api && !ch.legacy)) {
      console.warn('[auth] electronAPI.auth + ipc 双通道均不可用，登录功能停用');
      // 退化为"永远隐藏登录按钮"，避免用户点了没反应
      if (elements.loginBtn) elements.loginBtn.classList.add('hidden');
      return;
    }

    // 1. 初始状态：并行取 currentUser + hasAnyAccount
    let curUser = null; let hasAny = true;
    try {
      const r = (ch.api) ? await ch.api.auth.currentUser() : await ch.invoke('auth-current-user');
      if (r && typeof r === 'object') curUser = { loggedIn: !!r.loggedIn, accountId: r.accountId, email: r.email, displayName: r.displayName, avatar: r.avatar || '', isAdmin: !!r.isAdmin, createdAt: r.createdAt, lastLoginTs: r.lastLoginTs, sessionExpireAt: r.sessionExpireAt };
    } catch (e) { console.warn('[auth] init currentUser 失败：', e && e.message); }
    try {
      const r = (ch.api) ? await ch.api.auth.hasAnyAccount() : await ch.invoke('auth-has-any-account');
      if (r && typeof r.hasAny === 'boolean') hasAny = r.hasAny;
    } catch (e) { console.warn('[auth] init hasAnyAccount 失败：', e && e.message); }
    AuthUI.currentUser   = curUser || { loggedIn: false, accountId: '__guest__' };
    AuthUI.hasAnyAccount = hasAny;
    renderTopAccountEntry();

    // 2. 订阅 auth-state-change（登录/登出/改资料后都会广播）
    const stateCb = async (userObj) => {
      // 用户信息可能来自 preload 回调第一参数或 ipcRenderer.on 第二参数，此处统一按对象处理
      const u = (userObj && typeof userObj === 'object' && !Array.isArray(userObj) && 'loggedIn' in userObj)
        ? userObj
        : null;
      if (u) {
        const prev = AuthUI.currentUser && AuthUI.currentUser.accountId;
        const next = u.accountId;
        AuthUI.currentUser = u;
        if (u.loggedIn) AuthUI.hasAnyAccount = true;
        renderTopAccountEntry();
        // 账号切换（含游客→账号 / 账号→游客 / 账号A→账号B）→ 切换命名空间
        if (prev !== next) await onAccountNamespaceSwitched(u);
      }
    };
    if (ch.api && typeof ch.api.auth.onAuthStateChanged === 'function') {
      ch.api.auth.onAuthStateChanged(stateCb);
    } else if (ch.legacy) {
      ch.on('auth-state-change', stateCb);
    }
  } catch (e) {
    console.warn('[auth] initAuthUI 失败：', e && e.message);
  }
}

// 初始化（唯一入口）
async function init() {
  // ★ 闪屏修复：第一时间判定登录态 → 决定要显示 auth 还是 home。
  //   #viewHome 起始就是 hidden，#authPage 起始是显示的（index.html 调过了），所以
  //   - 未登录：保持 authPage（首帧就是登录页）
  //   - 已登录：先切隐藏 authPage，再 viewRouter.init() 显示 home
  //   这样就不会"先闪 Copilot 再切登录"。
  //   加载配置 / 简历 / 历史等都在判定完成后并行跑，保证首屏视觉顺序正确。
  let isLoggedIn = false;
  try {
    // 先用 initAuthUI 拉 currentUser（会写入 AuthUI.currentUser）
    //   注意：这里要顺序放最前面，因为后面的"已登录/未登录"决策依赖它。
    await initAuthUI();
    isLoggedIn = !!(AuthUI.currentUser && AuthUI.currentUser.loggedIn);
  } catch (e) {
    console.warn('[init] 启动判定登录态失败，默认显示登录页：', e && e.message);
    isLoggedIn = false;
  }

  // 加载配置（异步，不阻塞视觉决策）
  try { appState.config = await ipcRenderer.invoke('get-config'); } catch (e) { console.warn('[init] get-config 失败：', e && e.message); }
  // 系统A 老历史（仍加载，作为系统B 不可用时的兜底）
  try { appState.history = await ipcRenderer.invoke('get-history'); } catch (e) { console.warn('[init] get-history 失败：', e && e.message); }

  // 加载保存的简历
  try { await loadResume(); } catch (e) { console.warn('[init] loadResume 失败：', e && e.message); }

  // 初始化UI（非致命：任一渲染失败都不应阻断后续事件绑定，否则会出现"页面能开但按钮全失效"）
  try { updateSettingsUI(); } catch (e) { console.warn('[init] updateSettingsUI 失败（非致命）：', e && e.message); }
  // 先兜底渲染（如果系统B 没就绪，用户至少能看到老数据）
  try { renderHistory(null); } catch (e) { console.warn('[init] renderHistory 失败（非致命）：', e && e.message); }

  // 启动"系统B 历史（答题面板/H5/截图/ASR 共用的 state.history）"的周期性刷新
  // 首次立即刷一次，之后每 2 秒对比 historyVersion 决定是否重绘（避免无脑 DOM 重建）
  (async function startSysbHistoryPolling() {
    try {
      // 全局句柄（便于后续若要卸载可 cancel）
      window.__sysbHistoryState = window.__sysbHistoryState || {
        lastVersion: 0,
        timer: null,
      };
      const st = window.__sysbHistoryState;

      // 首次立即刷新
      try { await refreshHistoryFromSystemB(); } catch (_) {}

      // 2 秒轮询：historyVersion 变化时才重绘 DOM，减少 CPU 抖动
      st.timer = setInterval(async () => {
        try {
          let snap = null;
          if (window.electronAPI && typeof window.electronAPI.fetchOverlayState === 'function') {
            snap = await window.electronAPI.fetchOverlayState();
          } else if (window.ipcRenderer && typeof window.ipcRenderer.invoke === 'function') {
            snap = await window.ipcRenderer.invoke('overlay-full-status');
          } else {
            return;
          }
          if (!snap || !snap.ok) return;
          const next = Number(snap.historyVersion) || 0;
          // 版本号变化 或 历史条目数量变化（极端情况：版本号未 +1 但内容变了，数量变化也触发重绘）
          const count = Array.isArray(snap.history) ? snap.history.length : -1;
          const countChanged = (typeof st.lastCount === 'number') ? (st.lastCount !== count) : true;
          if (next !== st.lastVersion || countChanged) {
            st.lastVersion = next;
            st.lastCount = count;
            try { await refreshHistoryFromSystemB(); } catch (_) {}
          }
        } catch (e) {
          console.warn('[history][sysb] poll 异常:', e && e.message);
        }
      }, 2000);
    } catch (e) {
      console.warn('[history][sysb] startSysbHistoryPolling 失败:', e && e.message);
    }
  })();

  // 初始化字体大小缩放（A⁻ / 100% / A⁺）：必须在 bindEvents 前，保证与其他控件互不干扰
  try { initFontZoom(); } catch (_) {}

  // 绑定事件
  try { bindEvents(); } catch (e) { console.warn('[init] bindEvents 失败：', e && e.message); }

  // 透明窗口模式：给可拖动区域添加 -webkit-app-region: drag
  // CSS 中通过 .draggable-region 选择器设置
  document.querySelectorAll('.draggable-region').forEach(el => {
    el.style.webkitAppRegion = 'drag';
  });
  // 按钮不能拖动（否则点击按钮会变成拖动窗口）
  document.querySelectorAll('.draggable-region button').forEach(el => {
    el.style.webkitAppRegion = 'no-drag';
  });

  // 初始化窗口边缘缩放手柄
  try { initResizeHandles(); } catch (_) {}

  // 监听主进程发来的隐身模式切换事件（来自托盘菜单/快捷键）
  try {
    ipcRenderer.on('stealth-mode-changed', (event, active) => {
      appState.isStealthMode = active;
      if (active) {
        document.body.classList.add('stealth-active');
        elements.toggleStealthBtn && elements.toggleStealthBtn.classList.add('active');
      } else {
        document.body.classList.remove('stealth-active', 'stealth-temp-reveal');
        elements.toggleStealthBtn && elements.toggleStealthBtn.classList.remove('active');
      }
    });
  } catch (_) {}

  // 监听主进程的"临时全显"事件（Ctrl+Shift+Space 触发）
  try {
    ipcRenderer.on('stealth-temp-reveal', (event, reveal) => {
      if (reveal) {
        document.body.classList.add('stealth-temp-reveal');
      } else {
        document.body.classList.remove('stealth-temp-reveal');
      }
    });
  } catch (_) {}

  // ★ 面试记录 Session 初始化
  //   1) 绑定面试相关 UI（📚 查看全部面试记录 / 结束横幅两按钮 / 公司&职位失焦自动开新场 / 列表&详情控件）
  //   2) viewRouter 初始化：默认显示 #viewHome
  //   3) 监听浮动面板关闭事件：main.js _postSessionOnOverlayClose → onOverlayClosedPostSession → 显示横幅
  try {
    bindSessionUIActions();
    bindOverlayClosedPostSessionListener();
    if (typeof viewRouter === 'object' && viewRouter && typeof viewRouter.init === 'function') {
      viewRouter.init();
    }
  } catch (e) {
    console.warn('[session] 初始化失败（非致命）：', e && e.message);
  }

  // ★ 闪屏修复：根据当前登录态决定最终显示哪个页面
  //   - 未登录：强制显示 auth 全屏（openLoginModal 会自动切换卡片、刷新 hasAnyAccount 状态）
  //   - 已登录：隐藏 auth 全屏 → 显示 viewRouter.init() 已经渲染好的 Home
  if (isLoggedIn) {
    // 已登录：authPage 必须隐藏（否则作为全屏覆盖层会盖住 home）
    try { closeLoginModal(); } catch (e) { console.warn('[init] 已登录用户关闭 authPage 失败：', e && e.message); }
    // 兜底：确保 #viewHome 可见（HTML 初始 hidden，viewRouter.init 应该已经去掉，但保险起见再去一次）
    if (elements.viewHome && elements.viewHome.classList.contains('hidden')) {
      elements.viewHome.classList.remove('hidden');
    }
  } else {
    // 未登录：强制门 —— 停留在登录页（不允许进 Home）
    try { await openLoginModal(); } catch (e) { console.warn('[init] 启动展示登录页失败：', e && e.message); }
  }
}

// 启动应用
init();

// 初始化窗口缩放手柄的拖动逻辑
function initResizeHandles() {
  const handles = document.querySelectorAll('.resize-handle');
  console.log(`[resize] 初始化 ${handles.length} 个缩放手柄`);
  handles.forEach(handle => {
    const direction = handle.dataset.direction;
    let startX = 0, startY = 0;
    let dragging = false;

    handle.addEventListener('mousedown', (e) => {
      // 隐身模式也允许缩放
      dragging = true;
      startX = e.screenX;
      startY = e.screenY;
      document.body.classList.add('resizing', 'resize-' + direction);
      console.log(`[resize] 拖拽开始: ${direction}`);
      e.preventDefault();
      e.stopPropagation();
    });

    // 用 window 监听 mousemove/mouseup，跨元素更可靠（隐身模式 pointer-events:none 不会影响 window）
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const deltaX = e.screenX - startX;
      const deltaY = e.screenY - startY;
      startX = e.screenX;
      startY = e.screenY;
      ipcRenderer.invoke('resize-window', direction, deltaX, deltaY);
    });

    window.addEventListener('mouseup', () => {
      if (dragging) {
        dragging = false;
        document.body.classList.remove('resizing', 'resize-n', 'resize-s', 'resize-w', 'resize-e', 'resize-nw', 'resize-ne', 'resize-sw', 'resize-se');
        console.log('[resize] 拖拽结束');
      }
    });
  });
}

// 绑定事件
function bindEvents() {
  // ===== 三 Tab 切换逻辑：点击顶部 Tab，切换按钮高亮 + 切换对应面板显示 =====
  if (elements.modeTabs) {
    // 为每个 data-mode 按钮绑定点击事件
    elements.modeTabs.querySelectorAll('.mode-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.mode;  // copilot / classic / resume

        // 1. 切换按钮高亮：所有按钮移除 active，当前按钮添加 active
        elements.modeTabs.querySelectorAll('.mode-tab').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');

        // 2. 切换面板显示：根据 mode 决定哪个面板移除 .hidden，其余两个加上 .hidden
        if (elements.copilotPanel) {
          elements.copilotPanel.classList.toggle('hidden', mode !== 'copilot');
        }
        if (elements.classicPanel) {
          elements.classicPanel.classList.toggle('hidden', mode !== 'classic');
        }
        if (elements.resumePanel) {
          elements.resumePanel.classList.toggle('hidden', mode !== 'resume');
        }
      });
    });
  }

  // 设置
  if (elements.settingsBtn) {
    elements.settingsBtn.addEventListener('click', async () => {
      // 打开设置前先从磁盘重载配置：确保能看到 Copilot 已保存的统一配置字段
      // （面试类型/模型档位/字数/截断/JD 等），且保存设置时不会覆盖丢失这些字段
      try {
        appState.config = await ipcRenderer.invoke('get-config');
      } catch (_) { /* 重载失败则沿用内存中的配置 */ }
      updateSettingsUI();
      if (elements.settingsModal) elements.settingsModal.classList.add('open');
    });
  }
  
  if (elements.closeSettingsBtn) {
    elements.closeSettingsBtn.addEventListener('click', () => {
      if (elements.settingsModal) elements.settingsModal.classList.remove('open');
    });
  }
  
  if (elements.saveSettingsBtn) {
    elements.saveSettingsBtn.addEventListener('click', saveSettings);
  }
  
  // 透明度滑块
  if (elements.opacitySlider && elements.opacityValue) {
    elements.opacitySlider.addEventListener('input', () => {
      const opacity = parseFloat(elements.opacitySlider.value);
      elements.opacityValue.textContent = Math.round(opacity * 100) + '%';
      ipcRenderer.invoke('set-opacity', opacity);
    });
  }
  
  // 始终置顶
  if (elements.alwaysOnTop) {
    elements.alwaysOnTop.addEventListener('change', () => {
      ipcRenderer.invoke('set-always-on-top', elements.alwaysOnTop.checked);
    });
  }

  // ★ 截图/录屏「不可见」总开关：实时切换（不依赖点「保存设置」）。
  //   切换后立即把全部窗口的捕获排除状态下发到主进程，实现「勾上就立刻不可见」。
  if (elements.captureHideToggle) {
    elements.captureHideToggle.addEventListener('change', async () => {
      try {
        await ipcRenderer.invoke('set-capture-hide', elements.captureHideToggle.checked);
      } catch (_) { /* 忽略切换失败，不影响 UI */ }
    });
  }
  
  // 点击弹窗外部关闭
  if (elements.settingsModal) {
    elements.settingsModal.addEventListener('click', (e) => {
      if (e.target === elements.settingsModal) {
        elements.settingsModal.classList.remove('open');
      }
    });
  }
  
  // 历史记录侧边栏：顶栏按钮 + 面试记录卡片 + Ctrl+H 快捷键（三个入口，.open 类切换滑出/收起）
  // ★ 打开侧栏时会立刻强制刷新一次系统B历史，确保用户刚识别出的轮次立刻出现在侧栏里（不等 2 秒轮询）
  //   关闭侧栏：① × 按钮 ② 再点一次顶栏/面试记录卡片 ③ 再按一次 Ctrl+H ④ 点击旧系统B历史卡片 都能关
  /** 开关侧栏辅助函数：force=true 强制打开，force=false 强制关闭，undefined/不传=toggle。打开时自动刷新系统B历史。 */
  const toggleHistorySidebar = async (force) => {
    if (!elements.historySidebar) return;
    const willOpen = (typeof force === 'boolean') ? force : !elements.historySidebar.classList.contains('open');
    elements.historySidebar.classList.toggle('open', willOpen);
    if (willOpen) {
      // 打开时立刻拉一次系统B历史（不等轮询），保证"最新的一轮"能马上看到；失败兜底系统A
      try { await refreshHistoryFromSystemB(); } catch (_) { /* ignore */ }
    }
  };
  // 入口1：顶栏 📋 历史按钮
  if (elements.openHistoryBtn) {
    elements.openHistoryBtn.addEventListener('click', () => toggleHistorySidebar());
  }
  // 入口2：主窗口「📋 面试记录」卡片（语义就是"查看历史记录"，所以点击强制打开侧栏）
  if (elements.copilotHistoryRow) {
    elements.copilotHistoryRow.addEventListener('click', () => toggleHistorySidebar(true));
  }
  // 入口3：本地快捷键 Ctrl+H（渲染层 document 监听）—— 注意避让已注册的全局 Ctrl+Shift+H（快速隐藏主窗口）
  //   判断条件：ctrl 按下 AND H 键 AND Shift 没按下
  if (typeof document !== 'undefined') {
    document.addEventListener('keydown', (ev) => {
      const isCtrl = !!(ev.ctrlKey || ev.metaKey);
      const key = (ev.key || '').toLowerCase();
      const isHotkey = isCtrl && key === 'h' && !ev.shiftKey && !ev.altKey;
      if (!isHotkey) return;
      ev.preventDefault();
      ev.stopPropagation();
      toggleHistorySidebar();
    }, { passive: false });
  }
  // 原有：侧栏头部 × 按钮关闭
  if (elements.closeHistoryBtn && elements.historySidebar) {
    elements.closeHistoryBtn.addEventListener('click', () => {
      elements.historySidebar.classList.remove('open');
    });
  }
  
  // 隐私保护功能
  if (elements.quickHideBtn) {
    elements.quickHideBtn.addEventListener('click', () => {
      ipcRenderer.invoke('toggle-window');
    });
  }
  
  if (elements.toggleStealthBtn) {
    elements.toggleStealthBtn.addEventListener('click', toggleStealthMode);
  }

  // 隐身模式拖动手柄上的"退出"按钮
  const stealthExitBtn = document.getElementById('stealthExitBtn');
  if (stealthExitBtn) {
    stealthExitBtn.addEventListener('click', (e) => {
      e.stopPropagation();  // 阻止冒泡到父容器的 drag
      if (appState.isStealthMode) {
        toggleStealthMode();
      }
    });
  }
  // 双击拖动手柄的拖动区域也可以退出隐身
  const stealthDragHandle = document.getElementById('stealthDragHandle');
  if (stealthDragHandle) {
    stealthDragHandle.addEventListener('dblclick', (e) => {
      if (e.target.closest('.stealth-exit-btn')) return;  // X 按钮已处理
      if (appState.isStealthMode) {
        toggleStealthMode();
      }
    });
  }
  
  if (elements.testHideBtn) {
    elements.testHideBtn.addEventListener('click', () => {
      ipcRenderer.invoke('hide-window');
      setTimeout(() => {
        ipcRenderer.invoke('show-window');
      }, 3000);
    });
  }
  
  // 持续监听
  if (elements.listenBtn) {
    elements.listenBtn.addEventListener('click', toggleListening);
  }

  // 灵敏度设置
  if (elements.detectionSensitivity && elements.sensitivityValue) {
    elements.detectionSensitivity.addEventListener('input', () => {
      elements.sensitivityValue.textContent = elements.detectionSensitivity.value;
    });
  }

  // 音频增益设置
  if (elements.audioBoost) {
    elements.audioBoost.addEventListener('input', () => {
      if (elements.audioBoostValue) {
        elements.audioBoostValue.textContent = elements.audioBoost.value + 'x';
      }
    });
  }

  // 开始面试按钮
  if (elements.startInterviewBtn) {
    elements.startInterviewBtn.addEventListener('click', startInterview);
  }

  // 简历相关事件
  if (elements.uploadResumeBtn) {
    elements.uploadResumeBtn.addEventListener('click', uploadResume);
  }
  if (elements.saveResumeBtn) {
    elements.saveResumeBtn.addEventListener('click', saveResume);
  }
  if (elements.clearResumeBtn) {
    elements.clearResumeBtn.addEventListener('click', clearResume);
  }
  if (elements.resumeEditor) {
    elements.resumeEditor.addEventListener('input', () => {
      // 自动保存到内存状态
      appState.resumeContent = elements.resumeEditor.value;
    });
  }

  // 内嵌面试蒙版已废弃（答题面板现已切换为独立 overlayWindow 窗口）
  // 这里保留 bindEvents 结构，避免移除整个调用点引发后续逻辑错位
  const _legacyCloseOverlayBtn = null;
  
  initOverlayDragResize();

  // ★ 登录 / 账号 相关 UI 事件绑定
  try { bindAuthEvents(); } catch (e) { console.warn('[bindEvents] bindAuthEvents 失败：', e && e.message); }
}

// ============================================================
// ★ 登录 / 账号 UI：事件绑定（登录表单 / 初始化管理员 / 忘记密码 / 合并游客 / 登出）
// ============================================================
function bindAuthEvents() {
  // ------------------------------------------------------------
  // 1) 顶部登录按钮：点击打开登录弹窗
  // ------------------------------------------------------------
  if (elements.loginBtn) {
    elements.loginBtn.addEventListener('click', () => openLoginModal());
  }
  // 关闭登录弹窗 ×
  if (elements.closeLoginBtn) {
    elements.closeLoginBtn.addEventListener('click', () => closeLoginModal());
  }
  // 点击登录弹窗遮罩（.modal）空白处：关闭
  if (elements.loginModal) {
    elements.loginModal.addEventListener('click', (ev) => {
      if (ev.target === elements.loginModal) closeLoginModal();
    });
  }

  // ------------------------------------------------------------
  // 2) 普通登录表单提交
  // ------------------------------------------------------------
  if (elements.loginForm) {
    elements.loginForm.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const email = String((elements.loginEmail && elements.loginEmail.value) || '').trim();
      const pwd   = String((elements.loginPwd   && elements.loginPwd.value)   || '');
      if (!AuthUI.emailRe.test(email)) { _setAuthError(elements.loginError, '请输入合法邮箱'); return; }
      if (!pwd)                           { _setAuthError(elements.loginError, '请输入密码'); return; }
      try {
        const ch = _authCh(); if (!ch || (!ch.api && !ch.legacy)) return;
        if (elements.loginSubmitBtn) elements.loginSubmitBtn.disabled = true;
        const r = (ch.api) ? await ch.api.auth.login({ email, password: pwd }) : await ch.invoke('auth-login', { email, password: pwd });
        if (!r || !r.ok) {
          const code = r && r.error;
          const msg = {
            USER_NOT_FOUND: '账号不存在，请确认邮箱或联系管理员',
            BAD_PASSWORD:  '密码错误，请重试',
            SESSION_FAILED:'登录会话签发失败，请重试',
          }[String(code || '')] || ('登录失败：' + (code || '未知原因'));
          _setAuthError(elements.loginError, msg);
          return;
        }
        // 登录成功：关闭弹窗；auth-state-change 事件会自动更新顶部头像
        closeLoginModal();
        // 询问是否合并游客数据
        await maybeAskMergeGuest();
      } catch (e) {
        console.warn('[auth][login] 异常：', e && e.message);
        _setAuthError(elements.loginError, '登录异常：' + (e && e.message || '未知'));
      } finally {
        if (elements.loginSubmitBtn) elements.loginSubmitBtn.disabled = false;
      }
    });
  }

  // ------------------------------------------------------------
  // 3) 登录表单：忘记密码链接 → 打开忘记密码弹窗
  // ------------------------------------------------------------
  if (elements.forgotLink) {
    elements.forgotLink.addEventListener('click', () => {
      closeLoginModal();
      openForgotModal();
    });
  }

  // ------------------------------------------------------------
  // 4) 初始化管理员表单提交（冷启动创建第一个本地账号）
  // ------------------------------------------------------------
  if (elements.initAdminForm) {
    elements.initAdminForm.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const email = String((elements.initEmail && elements.initEmail.value) || '').trim();
      const dn    = String((elements.initDisplayName && elements.initDisplayName.value) || '').trim();
      const p1    = String((elements.initPwd && elements.initPwd.value) || '');
      const p2    = String((elements.initPwd2 && elements.initPwd2.value) || '');
      if (!AuthUI.emailRe.test(email)) { _setAuthError(elements.initAdminError, '请输入合法邮箱'); return; }
      if (!dn)                            { _setAuthError(elements.initAdminError, '请填写显示名 / 昵称'); return; }
      if (p1.length < 6)                  { _setAuthError(elements.initAdminError, '密码至少 6 位'); return; }
      if (p1 !== p2)                      { _setAuthError(elements.initAdminError, '两次输入的密码不一致'); return; }
      try {
        const ch = _authCh(); if (!ch || (!ch.api && !ch.legacy)) return;
        if (elements.initAdminSubmitBtn) elements.initAdminSubmitBtn.disabled = true;
        // createAccount：authService 内部已要求 hasAnyAccount=false 才能成功，否则返回 DEAD_END
        const r = (ch.api)
          ? await ch.api.auth.createAccount({ email, displayName: dn, password: p1, isAdmin: true })
          : await ch.invoke('auth-create-account', { email, displayName: dn, password: p1, isAdmin: true });
        if (!r || !r.ok) {
          const code = r && r.error;
          const msg = {
            INVALID_EMAIL:    '邮箱格式不正确',
            WEAK_PASSWORD:    '密码过于简单（至少 6 位）',
            DUPLICATE_EMAIL:  '该邮箱已创建过账号，请直接登录',
            DEAD_END:         '本地已存在账号，如需新增请通过宣传网站或手动编辑 accounts.json',
          }[String(code || '')] || ('创建失败：' + (code || '未知原因'));
          _setAuthError(elements.initAdminError, msg);
          return;
        }
        // 创建成功：紧接着自动登录（createAccount 本身不签发会话，需 login 一次）
        const lr = (ch.api)
          ? await ch.api.auth.login({ email, password: p1 })
          : await ch.invoke('auth-login', { email, password: p1 });
        if (!lr || !lr.ok) {
          _setAuthError(elements.initAdminError, '账号创建成功，但自动登录失败，请手动登录');
          AuthUI.hasAnyAccount = true;
          closeLoginModal();
          setTimeout(() => openLoginModal(), 150);
          return;
        }
        closeLoginModal();
      } catch (e) {
        console.warn('[auth][init-admin] 异常：', e && e.message);
        _setAuthError(elements.initAdminError, '创建异常：' + (e && e.message || '未知'));
      } finally {
        if (elements.initAdminSubmitBtn) elements.initAdminSubmitBtn.disabled = false;
      }
    });
  }

  // ------------------------------------------------------------
  // 5) 忘记密码流程（三步）
  // ------------------------------------------------------------
  if (elements.closeForgotBtn) {
    elements.closeForgotBtn.addEventListener('click', () => closeForgotModal());
  }
  if (elements.forgotPwdModal) {
    elements.forgotPwdModal.addEventListener('click', (ev) => {
      if (ev.target === elements.forgotPwdModal) closeForgotModal();
    });
  }
  if (elements.forgotBack1) {
    elements.forgotBack1.addEventListener('click', () => { closeForgotModal(); openLoginModal(); });
  }
  if (elements.forgotBack2) {
    elements.forgotBack2.addEventListener('click', () => {
      if (elements.forgotError2)  elements.forgotError2.classList.add('hidden');
      setForgotStep(1);
    });
  }
  if (elements.forgotGoLogin) {
    elements.forgotGoLogin.addEventListener('click', () => {
      // 步骤3 → 登录页：优先切卡片（不重新 hasAnyAccount 拉取，速度更快）；兜底再调 openLoginModal
      try {
        const cards = [elements.loginPageCard, elements.forgotPageCard, elements.mergePageCard];
        cards.forEach((c) => { if (c) c.classList.add('hidden'); });
        if (elements.loginPageCard) elements.loginPageCard.classList.remove('hidden');
        if (elements.authPage)     elements.authPage.classList.remove('hidden');
        setForgotStep(1);
      } catch (_) {
        openLoginModal();
      }
    });
  }

  // ------------------------------------------------------------
  // 3.5) 登录页：无「返回」按钮
  //   设计：登录页为强制门，只有登录成功（login/merge 表单提交通过）
  //   才会 closeLoginModal()/hideAuthPage() 进入 Copilot 主窗口。
  //   不提供"不登录就退出"的路径，故无需返回按钮及其事件绑定。
  // ------------------------------------------------------------
  // Step1 表单：邮箱 → 获取重置码 → 切换到步骤 2 并显示
  if (elements.forgotStep1Form) {
    elements.forgotStep1Form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const email = String((elements.forgotEmail && elements.forgotEmail.value) || '').trim();
      if (!AuthUI.emailRe.test(email)) { _setAuthError(elements.forgotError, '请输入合法邮箱'); return; }
      try {
        const ch = _authCh(); if (!ch || (!ch.api && !ch.legacy)) return;
        if (elements.forgotStep1Next) elements.forgotStep1Next.disabled = true;
        const r = (ch.api) ? await ch.api.auth.forgotStep1({ email }) : await ch.invoke('auth-forgot-step1', { email });
        if (!r || !r.ok) {
          const code = r && r.error;
          const msg = { USER_NOT_FOUND: '该邮箱未注册账号' }[String(code || '')] || ('生成重置码失败：' + (code || '未知'));
          _setAuthError(elements.forgotError, msg); return;
        }
        // 显示重置码（桌面端直接显示，不发邮件）
        const code = String(r.resetCode || '').trim();
        if (elements.forgotResetCodeDisplay) {
          elements.forgotResetCodeDisplay.classList.remove('hidden');
          elements.forgotResetCodeDisplay.innerHTML = '';
          const label = document.createElement('div');
          label.className = 'rc-label';
          label.textContent = '本机一次性重置码（请复制使用）：';
          const copyBox = document.createElement('div');
          copyBox.className = 'rc-copy';
          copyBox.textContent = code;
          copyBox.title = '点击复制';
          copyBox.addEventListener('click', async () => {
            try {
              if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(code);
                const old = copyBox.textContent;
                copyBox.textContent = '✅ 已复制';
                setTimeout(() => { copyBox.textContent = old; }, 1200);
              }
            } catch (_) { /* 复制失败不影响下一步 */ }
          });
          elements.forgotResetCodeDisplay.appendChild(label);
          elements.forgotResetCodeDisplay.appendChild(copyBox);
        }
        setForgotStep(2);
      } catch (e) {
        console.warn('[auth][forgot-s1] 异常：', e && e.message);
        _setAuthError(elements.forgotError, '请求异常：' + (e && e.message || '未知'));
      } finally {
        if (elements.forgotStep1Next) elements.forgotStep1Next.disabled = false;
      }
    });
  }
  // Step2 表单：重置码 + 新密码 × 2 → 重置 → 切换步骤 3
  if (elements.forgotStep2Form) {
    elements.forgotStep2Form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const email = String((elements.forgotEmail && elements.forgotEmail.value) || '').trim();
      const code  = String((elements.forgotResetInput && elements.forgotResetInput.value) || '').trim();
      const p1    = String((elements.forgotNewPwd   && elements.forgotNewPwd.value)   || '');
      const p2    = String((elements.forgotNewPwd2  && elements.forgotNewPwd2.value)  || '');
      if (!code || code.length < 6)                 { _setAuthError(elements.forgotError2, '请输入正确的重置码'); return; }
      if (p1.length < 6)                            { _setAuthError(elements.forgotError2, '新密码至少 6 位'); return; }
      if (p1 !== p2)                                { _setAuthError(elements.forgotError2, '两次新密码不一致'); return; }
      try {
        const ch = _authCh(); if (!ch || (!ch.api && !ch.legacy)) return;
        if (elements.forgotStep2Submit) elements.forgotStep2Submit.disabled = true;
        const r = (ch.api)
          ? await ch.api.auth.forgotStep2Reset({ email, resetCode: code, newPassword: p1 })
          : await ch.invoke('auth-forgot-step2-reset', { email, resetCode: code, newPassword: p1 });
        if (!r || !r.ok) {
          const code_e = r && r.error;
          const msg = {
            USER_NOT_FOUND:   '该邮箱未注册账号',
            BAD_RESET_CODE:   '重置码错误或已过期',
            WEAK_PASSWORD:    '新密码过于简单（至少 6 位）',
          }[String(code_e || '')] || ('重置失败：' + (code_e || '未知原因'));
          _setAuthError(elements.forgotError2, msg);
          return;
        }
        setForgotStep(3);
      } catch (e) {
        console.warn('[auth][forgot-s2] 异常：', e && e.message);
        _setAuthError(elements.forgotError2, '请求异常：' + (e && e.message || '未知'));
      } finally {
        if (elements.forgotStep2Submit) elements.forgotStep2Submit.disabled = false;
      }
    });
  }

  // ------------------------------------------------------------
  // 6) 头像下拉菜单点击（展示 / 隐藏 + 点外部关闭）
  // ------------------------------------------------------------
  if (elements.userAvatarBtn) {
    elements.userAvatarBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (elements.userDropdown) elements.userDropdown.classList.toggle('hidden');
    });
  }
  // 点下拉外部关闭
  document.addEventListener('click', (ev) => {
    if (!elements.userDropdown || elements.userDropdown.classList.contains('hidden')) return;
    if (elements.userArea && elements.userArea.contains(ev.target)) return;
    elements.userDropdown.classList.add('hidden');
  });
  // ESC 也关下拉
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      if (elements.userDropdown && !elements.userDropdown.classList.contains('hidden')) {
        elements.userDropdown.classList.add('hidden');
      }
    }
  });
  // 下拉菜单项：个人中心 / 账号设置 / 退出登录
  if (elements.userDropdown) {
    elements.userDropdown.addEventListener('click', async (ev) => {
      const item = ev.target && ev.target.closest && ev.target.closest('.ud-item');
      if (!item) return;
      const act = String(item.dataset.act || '');
      // 点击任何菜单项后都先收起来，避免遮挡后续弹窗
      elements.userDropdown.classList.add('hidden');
      if (act === 'profile') {
        showToast('个人中心：功能入口预留（宣传网站上线后提供）', 'info');
      } else if (act === 'settings') {
        showToast('账号设置：修改密码 / 改昵称功能稍后补充', 'info');
      } else if (act === 'logout') {
        try {
          const ch = _authCh(); if (!ch || (!ch.api && !ch.legacy)) return;
          if (ch.api) await ch.api.auth.logout();
          else         await ch.invoke('auth-logout');
          // auth-state-change 会自动刷新顶部入口 + 切换游客命名空间
        } catch (e) {
          console.warn('[auth][logout] 异常：', e && e.message);
          showToast('退出登录失败：' + (e && e.message || '未知'), 'error');
        }
      }
    });
  }

  // ------------------------------------------------------------
  // 7) 合并游客数据弹窗：🟢 已废弃，保留空实现以兼容 HTML 元素可能存在（但点击无副作用）
  // ------------------------------------------------------------
  if (elements.mergeSkipBtn) {
    elements.mergeSkipBtn.addEventListener('click', () => closeMergeGuestDialog());
  }
  if (elements.mergeDoBtn) {
    elements.mergeDoBtn.addEventListener('click', () => {
      // 🟢 合并功能已移除：提示用户，不做任何数据搬运 / 删除
      showToast('ℹ️ 合并游客数据功能已停用，登录后将直接显示当前账号名下的 SQLite 数据', 'info');
      closeMergeGuestDialog();
    });
  }
}

// 初始化面试弹窗的拖动和缩放（拖动范围 = 整个电脑屏幕，含多显示器）
async function initOverlayDragResize() {
  const overlayWindow = document.getElementById('overlayWindow');
  const dragHandle = document.getElementById('overlayDragHandle');
  if (!overlayWindow || !dragHandle) return;
  
  // 获取整个屏幕的物理边界（多显示器合并）
  // 默认值：浏览器模式下 dev-server 不会返回屏幕信息，此时用当前窗口可视区域作为边界
  let screenBounds = { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
  try {
    let fetched = null;
    if (window.electronAPI && window.electronAPI.getScreenBounds) {
      fetched = await window.electronAPI.getScreenBounds();
    } else if (typeof ipcRenderer !== 'undefined' && ipcRenderer.invoke) {
      fetched = await ipcRenderer.invoke('get-screen-bounds');
    }
    // 只有拿到了合法值才覆盖默认值（浏览器模式下 dev-server 返回 null，这里保持默认）
    if (fetched && typeof fetched.width === 'number' && typeof fetched.height === 'number') {
      screenBounds = fetched;
    }
  } catch (e) {
    console.warn('获取屏幕尺寸失败，使用默认窗口尺寸:', e);
  }
  console.log('[面试弹窗] 屏幕物理边界:', screenBounds);
  
  const minW = 280, minH = 200;
  const maxW = Math.max(minW + 100, screenBounds.width);
  const maxH = Math.max(minH + 100, screenBounds.height);
  const sx = screenBounds.x;
  const sy = screenBounds.y;
  const sw = screenBounds.width;
  const sh = screenBounds.height;
  
  // 拖动功能
  let isDragging = false;
  let startX, startY, startLeft, startTop;
  
  dragHandle.addEventListener('mousedown', (e) => {
    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;
    startLeft = parseInt(overlayWindow.style.left) || (sw / 2 - overlayWindow.offsetWidth / 2) + sx;
    startTop = parseInt(overlayWindow.style.top) || (sh / 2 - overlayWindow.offsetHeight / 2) + sy;
    e.preventDefault();
  });
  
  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const deltaX = e.clientX - startX;
    const deltaY = e.clientY - startY;
    let newLeft = startLeft + deltaX;
    let newTop = startTop + deltaY;
    
    // 限制在整块屏幕范围内（屏幕可以是负坐标，比如副显示器在主显示器左侧）
    newLeft = Math.max(sx, Math.min(newLeft, sx + sw - overlayWindow.offsetWidth));
    newTop = Math.max(sy, Math.min(newTop, sy + sh - overlayWindow.offsetHeight));
    
    overlayWindow.style.left = newLeft + 'px';
    overlayWindow.style.top = newTop + 'px';
    overlayWindow.style.transform = 'none';
  });
  
  document.addEventListener('mouseup', () => {
    isDragging = false;
  });
  
  // 缩放功能
  let isResizing = false;
  let resizeDirection = '';
  let resizeStartX, resizeStartY;
  let resizeStartWidth, resizeStartHeight;
  let resizeStartLeft, resizeStartTop;
  
  document.querySelectorAll('.overlay-resize-handle').forEach(handle => {
    handle.addEventListener('mousedown', (e) => {
      isResizing = true;
      resizeDirection = handle.dataset.direction;
      resizeStartX = e.clientX;
      resizeStartY = e.clientY;
      resizeStartWidth = overlayWindow.offsetWidth;
      resizeStartHeight = overlayWindow.offsetHeight;
      resizeStartLeft = parseInt(overlayWindow.style.left) || (sw / 2 - overlayWindow.offsetWidth / 2) + sx;
      resizeStartTop = parseInt(overlayWindow.style.top) || (sh / 2 - overlayWindow.offsetHeight / 2) + sy;
      e.preventDefault();
    });
  });
  
  document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;
    
    const deltaX = e.clientX - resizeStartX;
    const deltaY = e.clientY - resizeStartY;
    let newWidth = resizeStartWidth;
    let newHeight = resizeStartHeight;
    let newLeft = resizeStartLeft;
    let newTop = resizeStartTop;
    
    switch (resizeDirection) {
      case 'n':
        newHeight = Math.max(minH, Math.min(maxH, resizeStartHeight - deltaY));
        newTop = resizeStartTop + (resizeStartHeight - newHeight);
        break;
      case 's':
        newHeight = Math.max(minH, Math.min(maxH, resizeStartHeight + deltaY));
        break;
      case 'w':
        newWidth = Math.max(minW, Math.min(maxW, resizeStartWidth - deltaX));
        newLeft = resizeStartLeft + (resizeStartWidth - newWidth);
        break;
      case 'e':
        newWidth = Math.max(minW, Math.min(maxW, resizeStartWidth + deltaX));
        break;
      case 'nw':
        newWidth = Math.max(minW, Math.min(maxW, resizeStartWidth - deltaX));
        newHeight = Math.max(minH, Math.min(maxH, resizeStartHeight - deltaY));
        newLeft = resizeStartLeft + (resizeStartWidth - newWidth);
        newTop = resizeStartTop + (resizeStartHeight - newHeight);
        break;
      case 'ne':
        newWidth = Math.max(minW, Math.min(maxW, resizeStartWidth + deltaX));
        newHeight = Math.max(minH, Math.min(maxH, resizeStartHeight - deltaY));
        newTop = resizeStartTop + (resizeStartHeight - newHeight);
        break;
      case 'sw':
        newWidth = Math.max(minW, Math.min(maxW, resizeStartWidth - deltaX));
        newHeight = Math.max(minH, Math.min(maxH, resizeStartHeight + deltaY));
        newLeft = resizeStartLeft + (resizeStartWidth - newWidth);
        break;
      case 'se':
        newWidth = Math.max(minW, Math.min(maxW, resizeStartWidth + deltaX));
        newHeight = Math.max(minH, Math.min(maxH, resizeStartHeight + deltaY));
        break;
    }
    
    // 限制在整块屏幕范围内
    newLeft = Math.max(sx, Math.min(newLeft, sx + sw - newWidth));
    newTop = Math.max(sy, Math.min(newTop, sy + sh - newHeight));
    
    overlayWindow.style.width = newWidth + 'px';
    overlayWindow.style.height = newHeight + 'px';
    overlayWindow.style.left = newLeft + 'px';
    overlayWindow.style.top = newTop + 'px';
    overlayWindow.style.transform = 'none';
  });
  
  document.addEventListener('mouseup', () => {
    isResizing = false;
  });
}

// 更新设置UI
function updateSettingsUI() {
  document.getElementById('baiduApiKey').value = appState.config.baiduApiKey || '';
  document.getElementById('baiduSecretKey').value = appState.config.baiduSecretKey || '';
  document.getElementById('baiduAppId').value = appState.config.baiduAppId || '';
  document.getElementById('realtimeMode').value = appState.config.realtimeMode || 'websocket';
  document.getElementById('wenxinApiKey').value = appState.config.wenxinApiKey || '';
  document.getElementById('zhipuApiKey').value = appState.config.zhipuApiKey || '';
  document.getElementById('tongyiApiKey').value = appState.config.tongyiApiKey || '';
  document.getElementById('aiServiceSelect').value = appState.config.selectedService || 'wenxin';
  elements.alwaysOnTop.checked = appState.config.alwaysOnTop !== false;
  elements.opacitySlider.value = appState.config.windowOpacity || 0.95;
  elements.opacityValue.textContent = Math.round((appState.config.windowOpacity || 0.95) * 100) + '%';
  elements.hotkeyInput.value = appState.config.hotkey || 'CommandOrControl+Shift+H';
  elements.detectionSensitivity.value = appState.config.detectionSensitivity || 5;
  elements.sensitivityValue.textContent = appState.config.detectionSensitivity || 5;
  elements.processingInterval.value = appState.config.processingInterval || 3000;
  elements.audioBoost.value = appState.config.audioBoost || 50;
  elements.audioBoostValue.textContent = (appState.config.audioBoost || 50) + 'x';
  elements.autoSaveHistory.checked = appState.config.autoSaveHistory !== false;
  // 截图/录屏不可见总开关：默认开启（config.captureHide !== false）
  if (elements.captureHideToggle) {
    elements.captureHideToggle.checked = appState.config.captureHide !== false;
  }

  // 格式化显示快捷键
  const displayHotkey = formatHotkeyForDisplay(appState.config.hotkey || 'CommandOrControl+Shift+H');
  if (elements.hotkeyDisplay) {
    elements.hotkeyDisplay.textContent = displayHotkey;
  }
}

// 格式化快捷键显示
function formatHotkeyForDisplay(hotkey) {
  return hotkey
    .replace('CommandOrControl', 'Ctrl')
    .replace('Command', 'Cmd')
    .replace('Control', 'Ctrl')
    .replace('Shift', 'Shift')
    .replace('Alt', 'Alt');
}

// 保存设置
function saveSettings() {
  appState.config.baiduApiKey = document.getElementById('baiduApiKey').value;
  appState.config.baiduSecretKey = document.getElementById('baiduSecretKey').value;
  appState.config.baiduAppId = document.getElementById('baiduAppId').value;
  appState.config.realtimeMode = document.getElementById('realtimeMode').value;
  appState.config.wenxinApiKey = document.getElementById('wenxinApiKey').value;
  appState.config.zhipuApiKey = document.getElementById('zhipuApiKey').value;
  appState.config.tongyiApiKey = document.getElementById('tongyiApiKey').value;
  appState.config.selectedService = document.getElementById('aiServiceSelect').value;
  appState.config.alwaysOnTop = elements.alwaysOnTop.checked;
  appState.config.windowOpacity = parseFloat(elements.opacitySlider.value);
  appState.config.hotkey = elements.hotkeyInput.value;
  appState.config.detectionSensitivity = parseInt(elements.detectionSensitivity.value);
  appState.config.processingInterval = parseInt(elements.processingInterval.value);
  appState.config.audioBoost = parseInt(elements.audioBoost.value);
  appState.config.autoSaveHistory = elements.autoSaveHistory.checked;
  // 截图/录屏不可见总开关状态写回配置（实时切换在 change 事件里已下发 IPC，这里仅持久化）
  if (elements.captureHideToggle) {
    appState.config.captureHide = elements.captureHideToggle.checked;
  }

  saveConfig();
  elements.settingsModal.classList.remove('open');

  // 更新显示的快捷键
  const displayHotkey = formatHotkeyForDisplay(appState.config.hotkey);
  if (elements.hotkeyDisplay) {
    elements.hotkeyDisplay.textContent = displayHotkey;
  }
}

// 保存配置
async function saveConfig() {
  await ipcRenderer.invoke('save-config', appState.config);
}

// 切换隐身模式
async function toggleStealthMode() {
  if (appState.isStealthMode) {
    await ipcRenderer.invoke('exit-stealth-mode');
    appState.isStealthMode = false;
    document.body.classList.remove('stealth-active', 'stealth-temp-reveal');
    if (elements.toggleStealthBtn) {
      elements.toggleStealthBtn.classList.remove('active');
    }
  } else {
    await ipcRenderer.invoke('enter-stealth-mode');
    appState.isStealthMode = true;
    document.body.classList.add('stealth-active');
    if (elements.toggleStealthBtn) {
      elements.toggleStealthBtn.classList.add('active');
    }
  }
}

// 渲染历史记录（优先使用系统B：localHttpServer.state.history，即答题面板/H5/截图/ASR 共用的新历史结构；
// 拿不到系统B 时回退显示系统A 老数据 appState.history，保持兼容性）
function renderHistory(sysbList) {
  // ===== 优先：系统B 新数据（通过 fetchOverlayState IPC 拿到的 state.history 数组） =====
  if (Array.isArray(sysbList) && sysbList.length > 0) {
    renderHistoryFromSystemB(sysbList);
    return;
  }

  // ===== 兜底：系统A 老数据（用户在旧通道中自动保存的 {id,question,answer,timestamp}） =====
  if (appState.history.length === 0) {
    elements.historyList.innerHTML = '<div style="padding: 20px; text-align: center; color: #999;">暂无历史记录</div>';
    return;
  }

  elements.historyList.innerHTML = appState.history.map(item => `
    <div class="history-item" data-id="${item.id}">
      <div class="question">${escapeHtml(item.question.substring(0, 50))}${item.question.length > 50 ? '...' : ''}</div>
      <div class="time">${escapeHtml(item.timestamp || '')}</div>
    </div>
  `).join('');

  // 绑定点击事件
  document.querySelectorAll('.history-item').forEach(item => {
    item.addEventListener('click', () => {
      const id = parseInt(item.dataset.id);
      const historyItem = appState.history.find(h => h.id === id);
      if (historyItem) {
        elements.questionInput.value = historyItem.question;
        elements.historySidebar.classList.remove('open');
      }
    });
  });
}

/**
 * 渲染侧栏：系统B 历史卡片。
 * 系统B 数据结构（每一轮 Round）：
 *   { id, questionText, answerText, questionImage?, status, source?, createdAt }
 * 展示规则：
 *   1. 侧栏以"最新在最上"倒序展示（state.history 内存本是正序，最新在下）。
 *   2. 每轮只显示提问摘要 + 状态徽章 + 创建时间。
 *   3. 点击后：把提问+答案拼接到主窗口"面试官问题输入框"，方便回看。
 * @param {Array} sysbHistory 系统B 历史数组（正序或倒序均可，内部按 createdAt 统一排序）
 */
function renderHistoryFromSystemB(sysbHistory) {
  if (!elements.historyList) return;
  const list = Array.isArray(sysbHistory) ? sysbHistory.slice() : [];
  if (list.length === 0) {
    elements.historyList.innerHTML = '<div style="padding: 20px; text-align: center; color: #999;">暂无历史记录</div>';
    return;
  }

  // 排序：按 createdAt 倒序（最新在最上）；createdAt 为字符串时尝试 Date.parse，失败按原序
  list.sort((a, b) => {
    const ta = a && a.createdAt ? (Date.parse(a.createdAt) || a.createdAt || 0) : 0;
    const tb = b && b.createdAt ? (Date.parse(b.createdAt) || b.createdAt || 0) : 0;
    if (typeof tb === 'number' && typeof ta === 'number') return tb - ta;
    return String(tb || '').localeCompare(String(ta || ''));
  });

  // 来源/状态的显示映射
  const sourceMap = {
    'asr-panel': '🎙ASR',
    'manual': '✍️ 手动',
    'screenshot': '📸 截图',
    'h5': '📱 H5',
    'screen-solve': '🖥解题',
  };
  const statusMap = {
    'asked':      { label: '⏳ 正在答题', cls: 'badge badge-asked' },
    'answered':   { label: '✅ 已回答',   cls: 'badge badge-answered' },
    'error':      { label: '❌ 答题失败', cls: 'badge badge-error' },
  };

  elements.historyList.innerHTML = list.map((r, idx) => {
    const id = r && r.id ? String(r.id) : `sysb-${idx}`;
    const q = (r && r.questionText) ? String(r.questionText).trim() : '';
    const a = (r && r.answerText) ? String(r.answerText).trim() : '';
    const sourceRaw = r && r.source ? String(r.source) : '';
    const sourceTxt = sourceMap[sourceRaw] || (sourceRaw ? ('🏷 ' + sourceRaw) : '');
    const statusRaw = r && r.status ? String(r.status) : '';
    const statusBadge = statusMap[statusRaw] || { label: '', cls: '' };
    const createdAt = (r && r.createdAt) ? String(r.createdAt) : '';
    const qShow = q.length > 50 ? (q.slice(0, 50) + '…') : q;
    const hasImg = !!(r && r.questionImage && String(r.questionImage).trim().length > 0);

    // data-sysb-id 标识这是系统B 条目；data-idx 存数组索引（排序后的），点击时按 id 查详情
    return `
      <div class="history-item" data-sysb-id="${escapeAttr(id)}" data-sysb-real-id="${escapeAttr(String(r && r.id ? r.id : id))}">
        <div class="history-item-head">
          ${statusBadge.label ? `<span class="${escapeAttr(statusBadge.cls)}">${escapeHtml(statusBadge.label)}</span>` : ''}
          ${sourceTxt ? `<span class="badge badge-source">${escapeHtml(sourceTxt)}</span>` : ''}
          ${hasImg ? `<span class="badge badge-image" title="本轮包含截图">🖼</span>` : ''}
        </div>
        <div class="question">${escapeHtml(qShow || '（无提问文本）')}</div>
        ${a ? `<div class="answer-preview">${escapeHtml(a.length > 60 ? (a.slice(0, 60) + '…') : a)}</div>` : ''}
        <div class="time">${escapeHtml(createdAt)}</div>
      </div>
    `;
  }).join('');

  // 绑定点击事件：
  //   - 原行为保留：把提问+答案回写到主窗口输入框，方便复看
  //   - 新增：通过 roundId → interviewSessionFindByRound → 定位所属 session → 跳详情页并高亮该 round
  const items = elements.historyList.querySelectorAll('.history-item');
  items.forEach((itemEl) => {
    itemEl.addEventListener('click', async () => {
      const realId = itemEl.getAttribute('data-sysb-real-id');
      const rawMatch = list.find((h) => h && String(h.id) === String(realId));
      if (!rawMatch) return;
      const q = String((rawMatch && rawMatch.questionText) || '').trim();
      const a = String((rawMatch && rawMatch.answerText) || '').trim();
      // 回写到主窗口输入框，格式：先提问，再分隔线，再答案（保持人类可读）
      if (elements.questionInput) {
        const parts = [];
        if (q) parts.push('【面试官提问】\n' + q);
        if (a) parts.push('【AI 助手回答】\n' + a);
        elements.questionInput.value = parts.join('\n\n');
      }
      // 关闭侧栏
      if (elements.historySidebar) elements.historySidebar.classList.remove('open');

      // ★ 新增：定位该 round 属于哪一场 Session，并跳转详情页（到达与底部「查看全部面试记录→点一场」同一页面）
      try {
        const roundId = String((rawMatch && rawMatch.id) || '');
        let res = null;
        if (window.electronAPI && typeof window.electronAPI.interviewSessionFindByRound === 'function') {
          res = await window.electronAPI.interviewSessionFindByRound(roundId);
        } else if (window.ipcRenderer && typeof window.ipcRenderer.invoke === 'function') {
          res = await window.ipcRenderer.invoke('interview-session-find-by-round', roundId);
        }
        if (res && res.ok && res.sessionId && typeof viewRouter === 'object' && viewRouter && typeof viewRouter.go === 'function') {
          // go(detail, sessionId, roundId) ：同一详情页，附加 round 锚点高亮
          viewRouter.go('detail', String(res.sessionId), roundId || undefined);
        }
      } catch (e) {
        console.warn('[history][sysb] 跳转到面试记录详情失败（非致命）:', e && e.message);
      }
    });
  });
}

/**
 * 安全的属性值转义（避免 id/source 含引号导致 HTML 属性被截断或 XSS）。
 * @param {string} val 原始属性值
 * @returns {string} 转义后的值
 */
function escapeAttr(val) {
  const s = String(val == null ? '' : val);
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 从系统B 拉取最新历史（通过 IPC overlay-full-status 拿 state 快照）。
 * 成功时把 history 数组传给 renderHistory() 渲染；失败时 renderHistory() 兜底走系统A 老历史。
 */
async function refreshHistoryFromSystemB() {
  try {
    // 优先使用 preload.js 暴露的 window.electronAPI.fetchOverlayState（Electron 模式）
    let snap = null;
    if (window.electronAPI && typeof window.electronAPI.fetchOverlayState === 'function') {
      snap = await window.electronAPI.fetchOverlayState();
    } else if (window.ipcRenderer && typeof window.ipcRenderer.invoke === 'function') {
      // 兼容老模式：nodeIntegration:true 时渲染层直接 require('electron') 拿到的 ipcRenderer
      snap = await window.ipcRenderer.invoke('overlay-full-status');
    } else {
      // 浏览器模式（dev-server）：没有系统B 的 IPC，不渲染系统B
      renderHistory(null);
      return;
    }
    if (snap && snap.ok && Array.isArray(snap.history)) {
      renderHistory(snap.history);
    } else {
      // 系统B 不可用（localHttpServer 尚未启动或内部异常）→ 兜底系统A
      renderHistory(null);
    }
  } catch (e) {
    console.warn('[history][sysb] refreshHistoryFromSystemB 异常:', e && e.message);
    // 异常不阻塞 UI：兜底显示系统A
    try { renderHistory(null); } catch (_) { /* ignore */ }
  }
}

// HTML转义
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// 持续监听功能：优先使用 WASAPI 直连（native-audio-node），失败则降级到 getDisplayMedia
// @param {string} source - 监听来源: 'interview' | 'test' (默认: 'test')
async function toggleListening(source = 'test') {
  if (appState.isListening) {
    await stopListening();
    return;
  }

  // 标记监听来源
  appState.listeningSource = source;
  const modeText = source === 'interview' ? '面试模式' : '测试模式（捕获系统声音）';
  console.log('[realtime]',`🎧 启动${modeText}...`);

  try {
    console.log('[realtime]','步骤 1: 尝试 WASAPI 直连模式（native-audio-node）...');
    await startNativeListening();
    if (appState.nativeListening) {
      console.log('[realtime]','✓ WASAPI 模式启动成功');
      updateListeningUI(true);
      return;
    }
    console.warn('[realtime]','WASAPI 模式未成功启动，降级到 getDisplayMedia');
  } catch (e) {
    console.warn('[realtime]','WASAPI 模式失败: ' + e.message + '，降级到 getDisplayMedia');
  }

  try {
    console.log('[realtime]','步骤 2: 尝试 getDisplayMedia 模式...');
    await startListening();
    if (appState.isListening) {
      console.log('[realtime]','✓ getDisplayMedia 模式启动成功');
    }
  } catch (e) {
    console.error('[realtime]','两种模式均失败，请检查配置');
    alert('音频捕获启动失败: ' + e.message);
  }
}

// ============================================================
// 测试音频：自动开启监听 + 播放 1 秒 880Hz 测试音 + 检测捕获
// 用法：点一次按钮即可，不用先开"捕获系统声音"
//       1) 若监听未启动 → 自动选会议窗口并开启（弹一次选择器）
//       2) 播放 1 秒测试音
//       3) 检测录音器捕获的样本，输出 RMS / 峰值
//       4) 给出明确的下一步建议
// ============================================================
async function playTestTone() {
  // 如果监听未启动，先开启
  let wasAutoStarted = false;
  if (!appState.isListening || !appState.systemAudioRecorder) {
    console.log('[realtime]','🔊 录音器未启动，正在自动开启监听（会弹选择器）...');
    try {
      await startListening();
      // 给录音器 1.5s 稳定时间
      await new Promise(r => setTimeout(r, 1500));
      // 用户可能取消了选择器
      if (!appState.systemAudioRecorder) {
        console.error('[realtime]','❌ 监听未启动（可能取消了音频源选择），无法继续测试');
        return;
      }
      wasAutoStarted = true;
    } catch (e) {
      console.error('[realtime]','自动开启监听失败: ' + e.message);
      return;
    }
  }

  try {
    console.log('[realtime]','🔊 播放 1 秒 880Hz 测试音（你应该听到"哔"声）...');

    // 用 OfflineAudioContext 生成 1 秒的 880Hz 正弦波（带渐入渐出避免爆音）
    const sampleRate = 16000;
    const offCtx = new OfflineAudioContext(1, sampleRate * 1, sampleRate);
    const osc = offCtx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 880;
    const gain = offCtx.createGain();
    gain.gain.setValueAtTime(0, 0);
    gain.gain.linearRampToValueAtTime(0.4, 0.05);
    gain.gain.setValueAtTime(0.4, 0.95);
    gain.gain.linearRampToValueAtTime(0, 1.0);
    osc.connect(gain).connect(offCtx.destination);
    osc.start(0);
    osc.stop(1);
    const buffer = await offCtx.startRendering();

    // 用 Web Audio 实时播放
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = audioCtx.createBufferSource();
    src.buffer = buffer;
    src.connect(audioCtx.destination);
    src.start();

    // 1.5s 后检查录音器是否捕获到
    setTimeout(() => {
      if (appState.systemAudioRecorder) {
        const samples = appState.systemAudioRecorder.takeLastSeconds(1.5);
        if (samples.length === 0) {
          console.error('[realtime]','❌ 录音器未捕获到任何样本！');
          console.error('[realtime]','   可能原因：');
          console.error('[realtime]','   1) 腾讯会议用了独立音频设备（耳机），系统扬声器没声音');
          console.error('[realtime]','   2) 会议里没人在说话');
          console.error('[realtime]','   3) Windows "Stereo Mix" 被禁用（见下方说明）');
        } else {
          let sumSq = 0, peak = 0;
          for (let i = 0; i < samples.length; i++) {
            const a = Math.abs(samples[i]);
            if (a > peak) peak = a;
            sumSq += a * a;
          }
          const rms = Math.sqrt(sumSq / samples.length);
          console.log('[realtime]',`📊 录音器捕获统计: 样本数=${samples.length}, RMS=${rms.toFixed(4)}, 峰值=${peak.toFixed(4)}`);
          if (rms < 0.005) {
            console.error('[realtime]','⚠️ 音量极低（接近静音）！系统音频捕获是工作的，但选中的源没有声音');
            console.error('[realtime]','   排查：');
            console.error('[realtime]','   • 让面试官开口说话，然后观察 RMS 是否上升');
            console.error('[realtime]','   • 打开腾讯会议 → 设置 → 音频 → 把扬声器改为"系统默认"');
            console.error('[realtime]','   • 拔掉耳机（很多笔记本插耳机后会议声音自动切到耳机）');
            console.error('[realtime]','   • 检查 Windows 任务栏扬声器图标，确认腾讯会议声音在响');
          } else if (rms < 0.05) {
            console.warn('[realtime]','⚠️ 音量偏小，可能不是最佳音频源（但系统捕获是工作的）');
          } else {
            console.log('[realtime]','✓ 音量正常！系统音频捕获工作正常');
            console.log('[realtime]','✓ 这下可以正常识别会议内容了');
          }
        }
      } else {
        console.error('[realtime]','录音器未启动，无法检测');
      }
      audioCtx.close();
      // 测试完成
      if (wasAutoStarted) {
        console.log('[realtime]','💡 监听已为你开启，可继续使用（要停止请点"停止捕获"按钮）');
      }
    }, 1500);

  } catch (e) {
    console.error('[realtime]','测试音播放失败: ' + e.message);
  }
}

// ============================================================
// 诊断：枚举所有音频设备，识别可用的系统回环（loopback）设备
// 用于解决 Electron 28 getDisplayMedia loopback 静默 bug
// ============================================================
async function diagnoseAudioDevices() {
  console.log('[realtime]','🔍 枚举系统音频设备...');
  try {
    // 必须先调用一次 getUserMedia，否则设备 label 是空的（隐私保护）
    try {
      const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
      tmp.getTracks().forEach(t => t.stop());
    } catch (e) {
      console.warn('[realtime]','提示：未授权麦克风，设备 label 可能为空');
    }

    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioInputs  = devices.filter(d => d.kind === 'audioinput');
    const audioOutputs = devices.filter(d => d.kind === 'audiooutput');

    console.log('[realtime]',`发现 ${audioInputs.length} 个输入设备，${audioOutputs.length} 个输出设备`);

    // 输出设备
    console.log('[realtime]','─── 音频输出设备 ───');
    for (const d of audioOutputs) {
      console.log('[realtime]',`  [output] ${d.label || '(无标签)'} | id=${d.deviceId.substring(0, 20)}...`);
    }

    // 输入设备
    console.log('[realtime]','─── 音频输入设备（getUserMedia 可用） ───');
    for (const d of audioInputs) {
      const isMic = /麦克风|microphone/i.test(d.label);
      const isLoopback = /stereo mix|what you hear|loopback|cable output|vb-audio|voicemeeter output/i.test(d.label);
      let flag = '';
      if (isLoopback) flag = '🔁 [系统回环]';
      else if (isMic) flag = '🎤 [麦克风]';
      else flag = '❓ [未知]';
      console.log('[realtime]',`  [input] ${d.label || '(无标签)'} ${flag}`);
    }

    // 检测真正的回环设备（排除麦克风）
    const loopbackInputs = audioInputs.filter(d =>
      /stereo mix|what you hear|loopback|cable output|vb-audio|voicemeeter output/i.test(d.label)
    );

    console.log('[realtime]','════════════════ 诊断结果 ════════════════');
    if (loopbackInputs.length > 0) {
      console.log('[realtime]',`✓ 发现 ${loopbackInputs.length} 个回环设备：${loopbackInputs.map(d => d.label).join('、')}`);
      console.log('[realtime]','  → 下次点"捕获系统声音"时这些设备会自动出现在选择器中');
    } else {
      console.error('[realtime]','❌ 系统没有任何可用的音频回环设备');
      console.error('[realtime]','');
      console.error('[realtime]','原因：你的声卡是 Realtek，没默认开启"Stereo Mix"回环');
      console.error('[realtime]','');
      console.error('[realtime]','══════════ 解决方案（选一个）══════════');
      console.error('[realtime]','');
      console.error('[realtime]','方案 A：开启 Realtek 立体声混音（无需装软件，2 分钟）');
      console.error('[realtime]','  1. 右下角任务栏 → 右键扬声器图标 → "声音设置"');
      console.error('[realtime]','  2. 点"更多声音设置" → 切到"录制"标签');
      console.error('[realtime]','  3. 右键空白处 → 勾选"显示已禁用的设备"');
      console.error('[realtime]','  4. 应该能看到 "立体声混音 / Stereo Mix" → 右键 → 启用');
      console.error('[realtime]','  5. 重启本应用，再点"🔍 音频设备"看是否出现');
      console.error('[realtime]','');
      console.error('[realtime]','方案 B：装 VB-Audio 虚拟声卡（免费，最稳定）');
      console.error('[realtime]','  1. 访问 https://vb-audio.com/Cable/ 下载 VBCABLE_Driver_Pack43.zip');
      console.error('[realtime]','  2. 解压 → 右键 VBCABLE_Setup.exe → 以管理员身份运行 → Install → 重启电脑');
      console.error('[realtime]','  3. Windows 声音设置 → 输出设备 → 选 "CABLE Input"');
      console.error('[realtime]','  4. 腾讯会议 → 设置 → 扬声器 → 选 "CABLE Input"');
      console.error('[realtime]','  5. 重启本应用，设备列表会出现 "CABLE Output"');
      console.error('[realtime]','');
      console.error('[realtime]','💡 推荐先试方案 A，2 分钟就能搞定');
    }
  } catch (e) {
    console.error('[realtime]','枚举设备失败: ' + e.message);
  }
}

// 暴露到全局，方便测试
window.diagnoseAudioDevices = diagnoseAudioDevices;
window.playTestTone = playTestTone;
window.startMicCapture = startMicCapture;
window.stopMicCapture = stopMicCapture;

// ============================================================
// WASAPI 直连模式：用 native-audio-node 抓系统音频
// 这绕过了 Electron getDisplayMedia 在 Realtek 上的 bug
//
// 流程：native 模块（main 进程）→ IPC 推数据 → 渲染层 → 百度 ASR
// ============================================================

// 全局 IPC 监听器（注册一次）
let __nativeAudioDataHandler = null;
let __nativeAudioErrorHandler = null;
let __nativeAudioMetaHandler = null;

async function startNativeListening() {
  if (appState.nativeListening) {
    console.log('[realtime]','WASAPI 模式已在运行中');
    return;
  }

  try {
    console.log('[realtime]','🎯 启动 WASAPI 直连模式（native-audio-node）...');

    // 1. 注册 IPC 监听器（只注册一次）
    if (!__nativeAudioDataHandler) {
      __nativeAudioDataHandler = (_event, data) => {
        // data 是 Array（Float32 数组）
        if (!appState.nativeListening) return;
        const samples = new Float32Array(data);

        // 静音检测：计算 RMS，低于阈值则跳过发送（节省百度API额度）
        let rms = 0;
        for (let i = 0; i < samples.length; i++) {
          rms += samples[i] * samples[i];
        }
        rms = Math.sqrt(rms / samples.length);
        const isSilence = rms < 0.001; // 静音阈值：RMS < 0.001

        // WS 模式：有声音发送真实数据，静音发送静音帧（保持连接，避免百度断开）
        if (appState.systemAudioRt) {
          try { 
            if (!isSilence) {
              appState.systemAudioRt.sendAudio(samples);
            } else {
              // 静音时发送静音帧保持连接，避免百度返回 -3101 wait audio over time
              const silence = new Float32Array(1600); // 100ms 静音
              appState.systemAudioRt.sendAudio(silence);
            }
          } catch (e) {}
        }

        // REST 模式：静音时不累积数据
        if (appState.nativeUseRest && !isSilence) {
          appState.nativeAudioBuffer.push(...data);
          appState.nativeBufferSeconds = appState.nativeAudioBuffer.length / 16000;
          if (appState.nativeBufferSeconds >= 1.5) {
            processNativeRestChunk();
          }
        }
      };
      ipcRenderer.on('native-audio-data', __nativeAudioDataHandler);

      __nativeAudioErrorHandler = (_event, msg) => {
        console.error('[realtime]','WASAPI 错误: ' + msg);
      };
      ipcRenderer.on('native-audio-error', __nativeAudioErrorHandler);

      __nativeAudioMetaHandler = (_event, m) => {
        console.log('[realtime]',`✓ WASAPI 元数据: rate=${m.sampleRate} ch=${m.channelsPerFrame} bits=${m.bitsPerChannel} float=${m.isFloat} enc=${m.encoding}`);
      };
      ipcRenderer.on('native-audio-metadata', __nativeAudioMetaHandler);
    }

    // 2. 启动主进程录制
    const result = await ipcRenderer.invoke('start-native-system-audio');
    if (!result.ok) {
      console.error('[realtime]','启动失败: ' + result.error);
      return;
    }
    console.log('[realtime]','✓ WASAPI 录制已启动');

    // 3. 启动百度 ASR（与 getDisplayMedia 模式共用）
    const config = await ipcRenderer.invoke('get-config');
    const mode = config.recognitionMode || 'websocket';

    if (mode === 'websocket') {
      try {
        const tokenRes = await ipcRenderer.invoke('get-baidu-access-token', {
          apiKey: config.baiduApiKey,
          secretKey: config.baiduSecretKey
        });
        if (tokenRes.success) {
          console.log('[realtime]','✓ access_token 已获取（' + tokenRes.token.substring(0, 8) + '...）');
        }
        if (!tokenRes.success) throw new Error(tokenRes.error);

        const svc = new RealtimeSpeechService();
        // 应用用户设置的 boost（默认 2x，native-audio-node 返回的是正常电平，不需要大增益）
        svc.setBoost(config.audioBoost || 2);
        console.log('[realtime]','音频增益: ' + (config.audioBoost || 2) + 'x');
        let wsOk = false;
        let wsClosed = false;
        svc.on('open', () => {
          wsOk = true;
          appState.wsReconnectCount = 0; // 重置重连计数
          console.log('[realtime]','✓ WebSocket 已连接，WASAPI → 百度识别链路建立');
        });
        svc.on('interim', (data) => {  // ★ 修：服务发的是 'interim' 不是 'partial'
          console.log('[realtime-speech] renderer 收到 interim:', data.text);
          const el = document.getElementById('interimText');
          if (el) el.textContent = data.text;  // ★ 修：data 是对象 {text, sn, ...}
          // 内嵌面试蒙版已移除，不再写入 overlayInterimText
          const overlayEl = null;
          if (overlayEl) overlayEl.textContent = data.text;
        });
        svc.on('final', async (data) => {
          console.log('[realtime-speech] renderer 收到 final:', data.text);
          await processRecognizedText(data.text);  // ★ 修：传 data.text 而不是 data
        });
        svc.on('error', (e) => {
          console.error('[realtime]','WS 错误: ' + e.message);
        });
        svc.on('close', (info) => {
          wsClosed = true;
          console.log('[realtime]','WS 关闭: ' + JSON.stringify(info));
          // WS 关了，且还没成功过 → 降级到 REST
          if (!wsOk && appState.nativeListening) {
            console.warn('[realtime]','WS 关闭且未成功，降级到 REST');
            appState.systemAudioRt = null;
            appState.nativeUseRest = true;
          }
          // WS 之前成功过，断开后自动重连（最多重连 3 次）
          if (wsOk && appState.nativeListening && !appState.nativeUseRest) {
            const reconnectCount = appState.wsReconnectCount || 0;
            if (reconnectCount < 3) {
              appState.wsReconnectCount = reconnectCount + 1;
              console.log('[realtime]',`WS 断开，${reconnectCount + 1}/3 尝试重连...`);
              setTimeout(() => {
                startNativeListening();
              }, 2000);
            } else {
              console.warn('[realtime]','WS 重连 3 次失败，降级到 REST');
              appState.systemAudioRt = null;
              appState.nativeUseRest = true;
            }
          }
        });
        appState.systemAudioRt = svc;
        console.log('[realtime]','正在连接 wss://vop.baidu.com/realtime_asr ...');
        svc.connect({  // ★ 必须传参！构造函数不保存参数
          accessToken: tokenRes.token,
          appId: config.baiduAppId,
          appKey: config.baiduApiKey
        });
        // 10s 超时降级（WS 首次连接可能慢，给足时间）
        setTimeout(() => {
          if (!wsOk && !wsClosed) {
            console.warn('[realtime]','WS 10s 未连上，降级到 REST 模式');
            try { svc.finish && svc.finish(); } catch (_) {}
            try { svc.close && svc.close(); } catch (_) {}
            appState.systemAudioRt = null;
            appState.nativeUseRest = true;
            console.log('[realtime]','使用 REST 模式（每 1.5 秒识别一次）');
          }
        }, 10000);
      } catch (e) {
        console.warn('[realtime]','WS 模式不可用，降级到 REST: ' + e.message);
        appState.nativeUseRest = true;
      }
    } else {
      appState.nativeUseRest = true;
      console.log('[realtime]','使用 REST 模式（每 1.5 秒识别一次）');
    }

    appState.nativeListening = true;
    appState.isListening = true;

    console.log('[realtime]','✓ WASAPI 直连模式已启动，开始实时识别系统声音');

  } catch (e) {
    console.error('[realtime]','启动 WASAPI 失败: ' + e.message);
  }
}

async function processNativeRestChunk() {
  if (!appState.nativeListening || !appState.nativeUseRest) return;
  if (appState.nativeAudioBuffer.length < 16000 * 0.3) return;

  const samples = new Float32Array(appState.nativeAudioBuffer);
  appState.nativeAudioBuffer = [];
  appState.nativeBufferSeconds = 0;

  try {
    const wav = encodeWav(samples, 16000);
    const config = await ipcRenderer.invoke('get-config');
    const result = await ipcRenderer.invoke('baidu-recognize', {
      audioData: wav,
      apiKey: config.baiduApiKey,
      secretKey: config.baiduSecretKey,
      appId: config.baiduAppId,
      rate: 16000,
      channel: 1
    });
    if (result.ok && result.text) {
      scheduleProcessRecognizedText(result.text);
    }
  } catch (e) {
    console.error('[realtime]','REST 识别失败: ' + e.message);
  }
}

async function stopNativeListening() {
  if (!appState.nativeListening) return;
  appState.nativeListening = false;
  appState.isListening = false;
  appState.nativeUseRest = false;

  try {
    await ipcRenderer.invoke('stop-native-system-audio');
  } catch (_) {}

  if (appState.systemAudioRt) {
    try { appState.systemAudioRt.finish && appState.systemAudioRt.finish(); } catch (_) {}
    appState.systemAudioRt = null;
  }

  appState.nativeAudioBuffer = [];
  appState.nativeBufferSeconds = 0;

  console.log('[realtime]','WASAPI 模式已停止');
}

// ============================================================
// 麦克风模式：用笔记本麦克风录下扬声器播放的声音
// 这绕过 getDisplayMedia audio: 'loopback' 的 Realtek 兼容性问题
//
// 原理：腾讯会议 → 扬声器 → 空气 → 麦克风 → getUserMedia → ASR
// 优点：保证能听到声音
// 缺点：会有回声（你的声音也会被录进去），可能识别你说话的内容
//
// 使用建议：
//   1. 关闭笔记本自带麦克风（避免录到你说话）—— 实际上不太可能关掉
//   2. 开会时尽量少说话
//   3. 把面试官声音调大（让麦克风更容易拾取）
//   4. 用完后记得点"停止"
// ============================================================
let micCaptureActive = false;

async function startMicCapture() {
  if (micCaptureActive) {
    console.log('[realtime]','麦克风模式已在运行中');
    return;
  }

  try {
    console.log('[realtime]','🎤 启动麦克风模式...');
    console.log('[realtime]','   提示：让扬声器声音大一些，麦克风能听到即可');

    // 1. 请求麦克风权限并获取流
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // 关掉所有处理，让原始声音进 ASR
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });

    const tracks = stream.getAudioTracks();
    if (tracks.length === 0) {
      console.error('[realtime]','❌ 麦克风未授权，请在 Windows 设置 → 隐私 → 麦克风 中开启');
      return;
    }

    console.log('[realtime]',`✓ 拿到麦克风流（设备: ${tracks[0].label || 'default'}）`);

    // 2. 创建录音器（同系统音频捕获的代码）
    const recorder = createPcmRecorder({ stream });
    appState.systemAudioRecorder = recorder;  // 复用同一个变量

    // 3. 根据配置选择 ASR 模式
    const config = await ipcRenderer.invoke('get-config');
    const mode = config.recognitionMode || 'websocket';

    if (mode === 'websocket') {
      // 尝试 WebSocket 模式
      try {
        const tokenRes = await ipcRenderer.invoke('get-baidu-access-token', {
          apiKey: config.baiduApiKey,
          secretKey: config.baiduSecretKey
        });
        if (!tokenRes.success) throw new Error(tokenRes.error);

        const wsResult = await new Promise((resolve) => {
          const svc = new RealtimeSpeechService({
            accessToken: tokenRes.token,
            appId: config.baiduAppId,
            appKey: config.baiduApiKey,    // ★ 必须传 appkey
            sampleRate: 16000
          });
          let wsOk = false;
          svc.on('open', () => {
            wsOk = true;
            console.log('[realtime]','✓ WebSocket 已连接，开始识别');
            // 把录音器的样本送进 WS
            recorder.onData = (samples) => svc.sendAudio(samples);
            recorder.start();
            appState.realtimeService = svc;
            resolve({ ok: true });
          });
          svc.on('interim', (data) => {  // ★ 修：'partial' → 'interim'
            const interimEl = document.getElementById('interimText');
            if (interimEl) interimEl.textContent = data.text;  // ★ 修：data.text
            // 内嵌面试蒙版已移除，不再写入 overlayInterimText
            const overlayEl = null;
            if (overlayEl) overlayEl.textContent = data.text;
          });
          svc.on('final', async (data) => {
            await processRecognizedText(data.text);  // ★ 修：data.text
          });
          svc.on('error', (e) => {
            console.error('[realtime]','WS 错误: ' + e.message);
            if (!wsOk) resolve({ ok: false, error: e.message });
          });
          svc.on('close', (info) => {
            console.log('[realtime]','WS 关闭: ' + JSON.stringify(info));
          });
          svc.connect({  // ★ 必须传参！
            accessToken: tokenRes.token,
            appId: config.baiduAppId,
            appKey: config.baiduApiKey
          });
          // 5s 超时
          setTimeout(() => {
            if (!wsOk) resolve({ ok: false, error: 'WS 连接超时' });
          }, 5000);
        });

        if (!wsResult.ok) {
          throw new Error(wsResult.error);
        }
      } catch (e) {
        console.warn('[realtime]','WS 模式不可用，降级到 REST: ' + e.message);
        runMicRestMode(recorder, config);
      }
    } else {
      // REST 分块模式
      runMicRestMode(recorder, config);
    }

    micCaptureActive = true;
    appState.isListening = true;

    // 改按钮文字
    const btn = document.getElementById('micBtn');
    if (btn) {
      btn.querySelector('.btn-text').textContent = '停止麦克风';
      btn.classList.add('listening');
    }
    const listenBtn = document.getElementById('listenBtn');
    if (listenBtn) {
      listenBtn.disabled = true;
    }

    console.log('[realtime]','✓ 麦克风模式已启动，开始识别');

  } catch (e) {
    if (e.name === 'NotAllowedError') {
      console.error('[realtime]','❌ 麦克风权限被拒绝');
      console.error('[realtime]','   解决：Windows 设置 → 隐私 → 麦克风 → 开启"允许应用访问麦克风"');
    } else {
      console.error('[realtime]','❌ 麦克风模式启动失败: ' + e.message);
    }
  }
}

function runMicRestMode(recorder, config) {
  console.log('[realtime]','使用 REST 模式（每 1.5 秒识别一次）');
  recorder.start();
  appState.systemAudioRecorder = recorder;

  const interval = setInterval(async () => {
    if (!micCaptureActive) {
      clearInterval(interval);
      return;
    }
    const samples = recorder.takeLastSeconds(1.5);
    if (samples.length < 16000 * 0.3) return;  // 跳过太短的片段
    try {
      const wav = encodeWav(samples, 16000);
      const result = await ipcRenderer.invoke('baidu-recognize', {
        audioData: wav,
        apiKey: config.baiduApiKey,
        secretKey: config.baiduSecretKey,
        appId: config.baiduAppId,
        rate: 16000,
        channel: 1
      });
      if (result.ok && result.text) {
        await processRecognizedText(result.text);
      }
    } catch (e) {
      console.error('[realtime]','REST 识别失败: ' + e.message);
    }
  }, 1500);
}

async function stopMicCapture() {
  if (!micCaptureActive) return;
  micCaptureActive = false;
  appState.isListening = false;

  if (appState.systemAudioRecorder) {
    appState.systemAudioRecorder.stop();
    appState.systemAudioRecorder = null;
  }
  if (appState.realtimeService) {
    try { appState.realtimeService.finish(); } catch (_) {}
    appState.realtimeService = null;
  }

  const listenBtn = document.getElementById('listenBtn');
  if (listenBtn) {
    listenBtn.disabled = false;
  }

  console.log('[realtime]','麦克风模式已停止');
}

// ============================================================
// 系统声音实时识别
// 流程：getDisplayMedia → AudioContext→16kHz PCM → RealtimeSpeechService → LLM
// 兜底：WebSocket 不可用时降级到 REST 分块识别
// ============================================================

// 弹出应用内选择器，让用户从桌面源列表里选一个
// 替代 navigator.mediaDevices.getDisplayMedia（Electron 28 对其 audio 约束支持差）
async function pickSystemAudioSource() {
  const result = await ipcRenderer.invoke('get-desktop-sources', { types: ['window', 'screen'] });
  if (!result.success) {
    throw new Error('枚举桌面源失败: ' + result.error);
  }
  const sources = result.sources;
  if (sources.length === 0) {
    throw new Error('未发现可用的窗口或屏幕');
  }
  // 只有一个时直接用，省去弹窗
  if (sources.length === 1) return sources[0];

  return new Promise((resolve, reject) => {
    const overlay = document.createElement('div');
    overlay.className = 'source-picker-overlay';
    overlay.innerHTML = `
      <div class="source-picker-modal">
        <h3>🎧 选择要捕获的窗口</h3>
        <p class="source-picker-hint">选择腾讯会议窗口（必须勾选"共享音频"）</p>
        <ul class="source-picker-list" id="sourcePickerList">
          ${sources.map(s => `
            <li class="source-picker-item" data-id="${escapeHtml(s.id)}">
              <div class="source-picker-icon">${s.thumbnail ? `<img src="${s.thumbnail}" alt="">` : '🪟'}</div>
              <div class="source-picker-name">${escapeHtml(s.name)}</div>
            </li>
          `).join('')}
        </ul>
        <div class="source-picker-actions">
          <button class="btn btn-secondary" id="sourcePickerCancel">取消</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.addEventListener('click', (e) => {
      const item = e.target.closest('.source-picker-item');
      if (item) {
        const id = item.dataset.id;
        const src = sources.find(s => s.id === id);
        document.body.removeChild(overlay);
        resolve(src);
      } else if (e.target.id === 'sourcePickerCancel' || e.target === overlay) {
        document.body.removeChild(overlay);
        reject(new Error('用户取消选择'));
      }
    });
  });
}

// HTML 转义
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// 通过 Electron 原生方式从指定桌面源拿音频流
// getUserMedia + mandatory.chromeMediaSource = 'desktop' + chromeMediaSourceId
async function getAudioStreamFromSource(sourceId) {
  return await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sourceId
      }
    },
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sourceId,
        maxWidth: 1280,
        maxHeight: 720
      }
    }
  });
}

// 处理识别出的文字：问句则调用 LLM，答案保存到历史并显示在弹窗
async function processRecognizedText(text) {
  if (!text || !text.trim()) return;

  const trimmedText = text.trim();
  const questionKey = trimmedText.toLowerCase().replace(/[？?，,。.！!]/g, '');

  // 1) 去重检查：30秒内不处理相同问题
  const lastTime = appState.recentQuestions.get(questionKey);
  if (lastTime && Date.now() - lastTime < appState.duplicateTimeout) {
    console.log('[recognize]','跳过重复问题: "' + trimmedText + '"');
    return;
  }

  console.log('[recognize]','处理识别文字: "' + trimmedText + '"');
  console.log('[renderer] 准备调用 process-recognized-text:', trimmedText);

  try {
    console.log('[llm]','调用 LLM 服务...（模型: ' + appState.config.selectedService + '）');

    // 2) 构建对话上下文（最近5轮对话）
    const context = buildConversationContext();

    console.log('[renderer] 调用 IPC，上下文长度:', context.length);
    console.log('[renderer] 简历内容长度:', appState.resumeContent?.length || 0);

    const processResult = await ipcRenderer.invoke('process-recognized-text', trimmedText, appState.config, context, appState.resumeContent);

    console.log('[renderer] IPC 返回结果:', processResult);

    if (processResult && processResult.isQuestion) {
      // 记录到去重缓存
      appState.recentQuestions.set(questionKey, Date.now());

      // 清理过期记录（每100条清理一次）
      if (appState.recentQuestions.size > 100) {
        const now = Date.now();
        for (const [key, time] of appState.recentQuestions.entries()) {
          if (now - time > appState.duplicateTimeout) {
            appState.recentQuestions.delete(key);
          }
        }
      }

      console.log('[llm]','✓ LLM 判断为问题: "' + processResult.question + '"');
      appState.currentQuestion = processResult.question;

      // 内嵌面试蒙版已移除，这里不再向 answerLoading/answerReady 写入状态；
      // 新独立窗口 overlay-renderer 通过 app.bus 监听 asr:answer-start / asr:answer-generated 更新 UI。
      const loadingEl = document.getElementById('answerLoading');
      const readyEl = document.getElementById('answerReady');
      if (loadingEl) loadingEl.style.display = 'block';
      if (readyEl) readyEl.style.display = 'none';

      // 内嵌面试蒙版已移除，不再写入 overlayAnswerText；
      // 答案会通过 ASR bus 广播到独立答题面板 overlay-renderer.js。
      const answerEl = document.getElementById('overlayAnswerText');
      if (answerEl) {
        answerEl.textContent = processResult.answer || '正在生成答案...';
      }

      if (appState.config.autoSaveHistory !== false) {
        const historyItem = {
          id: Date.now(),
          question: processResult.question,
          answer: processResult.answer,
          timestamp: new Date().toLocaleString()
        };
        appState.history.unshift(historyItem);
        await ipcRenderer.invoke('save-history', appState.history);
        // 系统A 写入后先刷新老通道显示；2 秒轮询会自动把系统B 的新历史合并进来
        renderHistory(null);
      }

      if (loadingEl) loadingEl.style.display = 'none';
      if (readyEl) readyEl.style.display = 'block';
    } else if (processResult && processResult.error) {
      console.error('[llm]','LLM 处理失败: ' + processResult.error);
      console.error('[renderer] LLM 错误:', processResult.error);
    } else {
      console.log('[recognize]','非问题，跳过: "' + trimmedText + '"');
    }
  } catch (e) {
    console.error('[renderer] 处理识别结果失败:', e);
    console.error('[llm]','处理失败: ' + e.message);
  }
}

/**
 * 构建对话上下文（最近5轮对话）
 * @returns {Array} 对话上下文数组
 */
function buildConversationContext() {
  const maxContextTurns = 5;
  const history = [];

  // 从本地历史记录中构建上下文
  // 假设用户已回答过问题，将用户回答也加入上下文
  for (let i = appState.history.length - 1; i >= 0 && history.length < maxContextTurns; i--) {
    const item = appState.history[i];

    // 面试官的问题
    history.push({
      role: 'interviewer',
      content: item.question,
      timestamp: item.timestamp
    });

    // AI 生成的参考答案（用户可能参考）
    history.push({
      role: 'assistant',
      content: item.answer,
      timestamp: item.timestamp
    });
  }

  // 按时间正序排列
  return history.reverse();
}

/**
 * 延迟处理识别结果（避免面试官还没说完就触发）
 * @param {string} text - 识别的文本
 * @param {number} delay - 延迟时间（毫秒），默认 500ms
 */
function scheduleProcessRecognizedText(text, delay = 500) {
  const timerKey = `process_${Date.now()}`;

  // 清除之前的定时器（避免多次延迟叠加）
  if (appState._processTimer) {
    clearTimeout(appState._processTimer);
  }

  appState._processTimer = setTimeout(async () => {
    appState._processTimer = null;
    await processRecognizedText(text);
  }, delay);

  return timerKey;
}

// ============================================================
// 简历管理功能
// ============================================================

/**
 * 加载保存的简历
 */
async function loadResume() {
  try {
    const result = await ipcRenderer.invoke('load-resume');
    if (result.success && result.content) {
      appState.resumeContent = result.content;
      if (elements.resumeEditor) {
        elements.resumeEditor.value = result.content;
        elements.resumeStatus.textContent = '已加载上次保存的简历';
      }
    }
  } catch (error) {
    console.error('[resume] 加载简历失败:', error);
  }
}

/**
 * 上传简历文件
 */
async function uploadResume() {
  try {
    console.log('[recognize]','选择简历文件...');
    const result = await ipcRenderer.invoke('select-resume-file');

    if (result.success) {
      appState.resumeContent = result.content;
      if (elements.resumeEditor) {
        elements.resumeEditor.value = result.content;
        elements.resumeStatus.textContent = `已加载: ${result.filePath}`;
      }
      console.log('[recognize]','简历加载成功');
    } else {
      if (elements.resumeStatus) {
        elements.resumeStatus.textContent = result.error || '上传失败';
      }
      console.error('[recognize]','简历上传失败:', result.error);
    }
  } catch (error) {
    if (elements.resumeStatus) {
      elements.resumeStatus.textContent = '上传失败: ' + error.message;
    }
    console.error('[recognize]','简历上传异常:', error);
  }
}

/**
 * 保存简历内容
 */
async function saveResume() {
  const content = elements.resumeEditor.value;
  if (!content.trim()) {
    elements.resumeStatus.textContent = '内容为空，未保存';
    return;
  }

  try {
    const result = await ipcRenderer.invoke('save-resume', content);
    if (result.success) {
      appState.resumeContent = content;
      elements.resumeStatus.textContent = '简历已保存';
      console.log('[recognize]','简历保存成功');
    } else {
      elements.resumeStatus.textContent = '保存失败: ' + result.error;
      console.error('[recognize]','简历保存失败:', result.error);
    }
  } catch (error) {
    elements.resumeStatus.textContent = '保存失败: ' + error.message;
    console.error('[recognize]','简历保存异常:', error);
  }
}

/**
 * 清空简历
 */
async function clearResume() {
  if (!confirm('确定要清空简历内容吗？')) {
    return;
  }

  try {
    await ipcRenderer.invoke('delete-resume');
    appState.resumeContent = '';
    if (elements.resumeEditor) {
      elements.resumeEditor.value = '';
      elements.resumeStatus.textContent = '简历已清空';
    }
    console.log('[recognize]','简历已清空');
  } catch (error) {
    console.error('[recognize]','清空简历失败:', error);
  }
}

// 启动系统音频流式监听
async function startListening() {
  try {
    console.log('[realtime]','步骤 1/5：调用 getDisplayMedia 触发系统音频捕获...');
    // 1) 用 getDisplayMedia 触发系统音频捕获
    //    主进程已注册 setDisplayMediaRequestHandler，会拦截这个调用并弹应用内选择器
    //    （绕开 Chromium 系统选择器，避免 Electron 28 上 "Not supported" 错误）
    const displayStream = await navigator.mediaDevices.getDisplayMedia({
      audio: true,
      video: true   // getDisplayMedia 强制要求 video 字段
    });
    console.log('[realtime]','✓ getDisplayMedia 成功');

    // 2) 立即停止视频轨（我们只要音频）
    displayStream.getVideoTracks().forEach(t => t.stop());
    const audioTracks = displayStream.getAudioTracks();
    if (audioTracks.length === 0) {
      throw new Error('该窗口未开启音频共享，请在腾讯会议共享时勾选"共享音频"');
    }
    console.log('[realtime]',`✓ 拿到 ${audioTracks.length} 条音频轨，停止视频轨`);
    const audioStream = new MediaStream(audioTracks);

    // 3) 通知后端开启后端监听（用于声音活动检测）
    const sensitivity = appState.config.detectionSensitivity || 5;
    console.log('[realtime]',`步骤 3/5：开启后端监听，灵敏度=${sensitivity}`);
    await ipcRenderer.invoke('start-listening', sensitivity);
    console.log('[realtime]','✓ 后端监听已启动');

    // 4) 根据配置选择模式
    const useWS = appState.config.realtimeMode !== 'rest'
                  && appState.config.baiduAppId
                  && appState.config.baiduApiKey
                  && appState.config.baiduSecretKey;

    console.log('[realtime]',`步骤 4/5：模式选择 = ${useWS ? 'WebSocket（实时）' : 'REST（兜底）'}`);
    if (useWS) {
      const ok = await startSystemAudioWebSocket(audioStream);
      if (!ok) {
        console.warn('[realtime]','WebSocket 模式失败，降级到 REST 模式');
        await startSystemAudioRest(audioStream);
      } else {
        // 健康检查：WS 在 5s 内被服务端断开（code 1005 等），自动降级到 REST
        watchWebSocketHealth(audioStream);
      }
    } else {
      if (!appState.config.baiduAppId) {
        console.warn('[realtime]','未配置 baiduAppId，使用 REST 模式');
      }
      await startSystemAudioRest(audioStream);
    }

    // 5) 用户关掉共享窗口时自动停止
    audioTracks[0].onended = () => {
      console.log('[realtime]','用户停止了音频共享（关闭了会议窗口共享）');
      stopListening();
    };

    appState.isListening = true;
    updateListeningUI(true);
    console.log('[realtime]','✓ 全部步骤完成，监听已启动');
  } catch (error) {
    if (error.name === 'NotAllowedError') {
      console.log('[realtime]','用户取消了音频源选择');
      return;
    }
    console.error('[realtime]','启动监听失败: ' + error.message);
    console.error('启动监听失败:', error);
    alert('启动监听失败: ' + error.message);
  }
}

// WebSocket 流式识别；连接失败返回 false，由调用方降级到 REST
async function startSystemAudioWebSocket(audioStream) {
  // 1) 拿 access_token
  console.log('[realtime]','WS 模式：向主进程申请百度 access_token...');
  const tokenResult = await ipcRenderer.invoke('get-baidu-access-token', appState.config);
  if (!tokenResult.success) {
    console.error('[realtime]','获取 token 失败: ' + tokenResult.error);
    return false;
  }
  console.log('[realtime]','✓ access_token 已获取（' + tokenResult.token.substring(0, 8) + '...）');

  // 2) 创建并连接 WebSocket
  const rt = new RealtimeSpeechService();
  rt.on('open', () => console.log('[realtime]','✓ WebSocket 已连接'));
  rt.on('interim', (data) => {
    if (elements.interimText) elements.interimText.textContent = data.text;
    console.log('[recognize]','中间结果: ' + data.text);
  });
  rt.on('final', async (data) => {
    if (elements.interimText) elements.interimText.textContent = '';
    console.log('[recognize]','最终结果: ' + data.text);
    // 使用延迟处理，避免面试官还没说完就触发
    scheduleProcessRecognizedText(data.text);
  });
  rt.on('error', (err) => console.error('[realtime]','WS 错误: ' + (err && err.message || err)));
  rt.on('close', (info) => console.log('[realtime]','WS 关闭: ' + JSON.stringify(info)));

  try {
    console.log('[realtime]','正在连接 wss://vop.baidu.com/realtime_asr ...');
    await rt.connect({
      accessToken: tokenResult.token,
      appId: appState.config.baiduAppId,
      appKey: appState.config.baiduApiKey    // ★ 必须传 appkey
    });
  } catch (e) {
    console.error('[realtime]','WS 连接失败: ' + e.message);
    return false;
  }
  appState.systemAudioRt = rt;

  // 3) PCM 录音器（用系统音频流）
  const recorder = createPcmRecorder({ stream: audioStream });
  await recorder.start();
  appState.systemAudioRecorder = recorder;
  console.log('[realtime]','✓ PCM 录音器已启动，等待音频数据...');

  // 4) 100ms 一次：取累积样本 → 静音检测 → Int16 → 发给 WS
  let totalSent = 0;
  let firstAudioLogged = false;
  let lastSendLog = 0;
  appState.systemAudioPump = setInterval(() => {
    const samples = recorder.takeAll();
    if (samples.length === 0) return;
    
    // 静音检测：计算 RMS，低于阈值发送静音帧保持连接
    let rms = 0;
    for (let i = 0; i < samples.length; i++) {
      rms += samples[i] * samples[i];
    }
    rms = Math.sqrt(rms / samples.length);
    if (rms < 0.001) {
      // 静音时发送静音帧保持连接，避免百度返回 -3101 wait audio over time
      const silence = new Float32Array(1600);
      const silenceI16 = new Int16Array(1600);
      rt.sendAudio(silenceI16);
      return;
    }
    
    if (!firstAudioLogged) {
      firstAudioLogged = true;
      console.log('[realtime]','✓ 首次捕获到音频数据: ' + samples.length + ' 个样本（' + (samples.length/16).toFixed(0) + 'ms）');
    }
    const i16 = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      let s = Math.max(-1, Math.min(1, samples[i]));
      i16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    rt.sendAudio(i16);
    totalSent += samples.length;
    // 每秒打印一次累计发送量
    const seconds = Math.floor(totalSent / 16000);
    if (seconds > lastSendLog) {
      lastSendLog = seconds;
      console.log('[realtime]','已发送 ' + seconds + 's 音频到百度（累计 ' + totalSent + ' 样本）');
    }
  }, 100);

  console.log('[realtime]','✓ WebSocket 模式启动成功');
  return true;
}

// WS 健康检查：5s 内如果 WS 被断开（服务端拒绝 = code 1005），自动降级 REST
function watchWebSocketHealth(audioStream) {
  const rt = appState.systemAudioRt;
  if (!rt) return;
  const startTime = Date.now();
  let audioReceived = false;  // 是否收到过非空识别结果

  // 监听 final 事件，标记收到过有效结果
  rt.on('final', (data) => {
    if (data && data.text && data.text.trim()) {
      audioReceived = true;
    }
  });

  // 5s 后判断
  setTimeout(() => {
    if (audioReceived) {
      console.log('[realtime]','✓ WS 健康检查通过：已收到有效识别结果');
      return;
    }
    if (!rt.isOpen) {
      console.warn('[realtime]','健康检查：WS 在 5s 内被关闭（可能是 AppID 无实时 ASR 权限）');
      console.warn('[realtime]','自动降级到 REST 模式...');
      // 停掉现有 pump
      if (appState.systemAudioPump) {
        clearInterval(appState.systemAudioPump);
        appState.systemAudioPump = null;
      }
      // 关闭 WS
      try { rt.close(); } catch (_) {}
      // 启动 REST
      startSystemAudioRest(audioStream);
    } else {
      console.log('[realtime]','WS 仍连接中（5s 内无识别结果，可能音频源是静音）');
    }
  }, 5000);
}

// REST 兜底：1.5s 一次，取最后 1.5s 样本编码 WAV 调一次
async function startSystemAudioRest(audioStream) {
  console.log('[realtime] 使用 REST 兜底模式');
  const recorder = createPcmRecorder({ stream: audioStream });
  await recorder.start();
  appState.systemAudioRecorder = recorder;

  let firstAudioLogged = false;
  let ticks = 0;
  appState.systemAudioPump = setInterval(async () => {
    ticks++;
    const samples = recorder.takeLastSeconds(1.5);
    if (samples.length < WAV_SAMPLE_RATE * 0.3) {
      if (ticks === 3 && !firstAudioLogged) {
        console.warn('[realtime] 4.5s 内未捕获到任何音频样本，请检查：');
        console.warn('  1) 腾讯会议是否已开启"共享音频"');
        console.warn('  2) 音频轨是否真的拿到了（看上方"拿到 N 条音频轨"日志）');
        console.warn('  3) 麦克风/系统声音是否实际有声音输入');
      }
      return;
    }
    if (!firstAudioLogged) {
      firstAudioLogged = true;
      console.log(`[realtime] REST 模式首次捕获到音频：${samples.length} 样本`);
    }
    try {
      const wavBuffer = encodeWav(samples);
      const result = await ipcRenderer.invoke(
        'speech-to-text',
        { data: Array.from(new Uint8Array(wavBuffer)) },
        appState.config
      );
      if (result.success && result.text && result.text.trim()) {
        console.log(`[realtime] REST 识别: "${result.text}"`);
        await processRecognizedText(result.text);
      } else if (result.error) {
        console.error(`[realtime] REST 识别失败: ${result.error}`);
      }
    } catch (e) {
      console.error('[realtime] REST 识别失败:', e);
    }
  }, 1500);
}

// 导出系统音频存档：取 recorder 的 archive 缓冲 → 编码 WAV → 主进程存盘
async function saveSystemRecording() {
  try {
    const rec = appState.systemAudioRecorder;
    if (!rec || typeof rec.takeArchive !== 'function') return null;
    const samples = rec.takeArchive();
    if (!samples || samples.length < WAV_SAMPLE_RATE) return null; // 不足 1 秒不存
    const wav = encodeWav(samples, WAV_SAMPLE_RATE);
    const sessionId = String(Date.now());
    const res = await ipcRenderer.invoke('save-system-recording', sessionId, wav);
    if (res && res.success) {
      console.log('[realtime]','💾 系统音频已存档：' + (res.path || ''));
      appState.lastRecordingPath = res.path;
      return res.path;
    }
  } catch (e) {
    console.error('[saveSystemRecording]', e);
  }
  return null;
}

async function stopListening() {
  appState.isListening = false;
  appState.listeningSource = null;  // 清除来源标志

  if (appState.nativeListening) {
    await stopNativeListening();
  }

  if (appState.systemAudioPump) {
    clearInterval(appState.systemAudioPump);
    appState.systemAudioPump = null;
  }
  if (appState.systemAudioRecorder) {
    // 停止前先导出系统音频存档（stop 会清空存档缓冲）
    try { await saveSystemRecording(); } catch (_) {}
    appState.systemAudioRecorder.stop();
    appState.systemAudioRecorder = null;
  }
  if (appState.systemAudioRt) {
    appState.systemAudioRt.close();
    appState.systemAudioRt = null;
  }
  if (appState.listeningTimer) {
    clearInterval(appState.listeningTimer);
    appState.listeningTimer = null;
  }
  if (appState.listeningRecorder) {
    appState.listeningRecorder.stop();
    appState.listeningRecorder = null;
  }
  if (elements.interimText) elements.interimText.textContent = '';
  await ipcRenderer.invoke('stop-listening');
  updateListeningUI(false);
}

function updateListeningUI(isListening) {
  if (isListening) {
    elements.listenBtn.classList.add('listening');
    elements.listenBtn.querySelector('.btn-text').textContent = '停止捕获';
    elements.listeningStatus.classList.add('active');
    elements.listeningProgress.classList.add('active');
    elements.listeningText.textContent = '🎧 正在捕获系统声音，识别到问题自动生成答案';
  } else {
    elements.listenBtn.classList.remove('listening');
    elements.listenBtn.querySelector('.btn-text').textContent = '捕获系统声音';
    elements.listeningStatus.classList.remove('active');
    elements.listeningProgress.classList.remove('active');
    elements.listeningText.textContent = '点击"捕获系统声音" → 选会议窗口 → 勾选"共享音频"';
  }
}

// 开始面试
async function startInterview() {
  // ★ 积分预校验：Copilot 真实面试场（单场首次启动扣 5 积分，价格对齐 server.js CREDIT_PRICE_LIST.COPILOT_PER_SESSION=5）
  //   - 积分充足 → 放行；离线/本地 → 放行并弹提示；不足 → 引导充值并取消启动
  const pre = await tryConsumeCreditsBefore({
    bizType: 'copilot_session',
    credits: 5,
    bizName: 'Copilot 面试场（系统声音/麦克风捕获）',
    bizId:   (appState && appState.currentSessionId) ? String(appState.currentSessionId) : undefined,
    desc:    '真实面试场开始：按场计费，30 分钟内同场面试不重复扣费。',
  });
  if (!pre || !pre.ok) {
    // 扣费失败（主要是积分不足已被用户取消）：直接 return，不再进入捕获
    console.warn('[startInterview] 积分未通过，已取消启动：', (pre && pre.msg) || pre);
    return;
  }

  // 内嵌面试蒙版已废弃（答题面板现已切换为独立 overlayWindow 窗口）：
  // - 不再 show() 本地 document.getElementById('interviewOverlay')；
  // - 独立面板由主窗口「开始面试辅助」按钮（copilot.js startInterviewAssist）通过 api.openOverlay() 打开。
  // - 老入口（本函数）仍保留，用于兼容"捕获系统声音"相关的历史模式（microphone/mixed/system）。

  // 内嵌面试蒙版已移除，以下 DOM 已不存在，统一 null-guard 避免报错
  const overlay = document.getElementById('interviewOverlay');
  if (overlay) overlay.classList.add('show');

  const loadingEl = document.getElementById('answerLoading');
  const readyEl = document.getElementById('answerReady');
  if (loadingEl) loadingEl.style.display = 'none';
  if (readyEl) readyEl.style.display = 'none';

  // 清空之前的内容（内嵌蒙版已移除，以下为了兼容保留 guard）
  const interimEl = document.getElementById('overlayInterimText');
  if (interimEl) interimEl.textContent = '';
  const answerEl = document.getElementById('overlayAnswerText');
  if (answerEl) {
    answerEl.textContent = '';
  }

  // 依据「系统音频模式」开关（audioMode）决定采集链路：
  //   system    → 系统声音（WASAPI 直连优先，失败降级 getDisplayMedia）
  //   microphone→ 仅麦克风（适合无系统音频环回设备的环境）
  //   mixed     → 系统声音 + 麦克风同时采集
  const mode = (appState.config && appState.config.audioMode) || 'system';

  if (mode === 'microphone') {
    // 仅麦克风模式：避免误开系统音频采集
    if (!micCaptureActive) {
      console.log('[realtime]','🚀 开始面试：以麦克风模式采集...');
      try {
        await startMicCapture();
      } catch (e) {
        console.error('[realtime]','麦克风采集启动失败: ' + e.message);
      }
    } else {
      console.log('[realtime]','✓ 麦克风采集已在运行中，直接开始面试');
    }
    return;
  }

  if (mode === 'mixed') {
    // 混合模式：两条链路都启动
    if (!appState.isListening) {
      console.log('[realtime]','🚀 开始面试：混合模式（系统声音 + 麦克风）...');
      try {
        await toggleListening('interview');
      } catch (e) {
        console.error('[realtime]','系统音频启动失败: ' + e.message);
      }
    }
    if (!micCaptureActive) {
      try {
        await startMicCapture();
      } catch (e) {
        console.error('[realtime]','麦克风启动失败: ' + e.message);
      }
    }
    return;
  }

  // 系统声音模式（默认）：若未在监听中，自动启动系统音频捕获
  if (!appState.isListening) {
    console.log('[realtime]','🚀 开始面试：自动启动系统音频捕获...');
    try {
      await toggleListening('interview');
    } catch (e) {
      console.error('[realtime]','启动音频捕获失败: ' + e.message);
    }
  } else {
    console.log('[realtime]','✓ 音频捕获已在运行中，直接开始面试');
  }
}

/* ==========================================================================
 * ★ 面试记录 Session 三态视图（viewRouter：home / list / detail）
 *   主窗口底部 3 按钮：📚查看全部面试记录 / ⏹结束本场 / 🆕开始新的一场
 *   与侧栏历史卡片点击 → 跳同一详情页（#viewSessionDetail）并按 roundId 高亮
 *   规则说明：
 *     - 不做删除/导出（增值功能暂缓，用户明确要求不加）
 *     - 不加快捷键（用户明确：不要快捷键）
 *     - 公司/职位失焦防抖 1.5s：若非空且发生有效更改 → 自动 startNewSession（切到新场）
 * ========================================================================== */

/**
 * 统一的面试 Session IPC 调用入口（优先 electronAPI，否则直连 ipcRenderer.invoke）。
 * @param {'list'|'get'|'start'|'end'|'find'} op  操作
 * @param {any} [payload]  参数
 * @returns {Promise<any>}
 */
async function _callInterviewSession(op, payload) {
  const m1 = window && window.electronAPI;
  const m2 = window && window.ipcRenderer && typeof window.ipcRenderer.invoke === 'function';
  // m3 兜底：copilot.js/fallback 兼容逻辑用 electronIpcRenderer（可能是 preload 外的手动赋值）
  const m3 = (typeof electronIpcRenderer !== 'undefined') && electronIpcRenderer && typeof electronIpcRenderer.invoke === 'function';
  switch (op) {
    case 'list':
      if (m1 && typeof m1.interviewSessionList === 'function') return m1.interviewSessionList(payload);
      if (m2) return window.ipcRenderer.invoke('interview-session-list', payload);
      if (m3) return electronIpcRenderer.invoke('interview-session-list', payload);
      break;
    case 'get':
      if (m1 && typeof m1.interviewSessionGet === 'function') return m1.interviewSessionGet(payload);
      if (m2) return window.ipcRenderer.invoke('interview-session-get', payload);
      if (m3) return electronIpcRenderer.invoke('interview-session-get', payload);
      break;
    case 'start':
      if (m1 && typeof m1.interviewSessionStartNew === 'function') return m1.interviewSessionStartNew(payload);
      if (m2) return window.ipcRenderer.invoke('interview-session-start-new', payload);
      if (m3) return electronIpcRenderer.invoke('interview-session-start-new', payload);
      break;
    case 'end':
      if (m1 && typeof m1.interviewSessionEndActive === 'function') return m1.interviewSessionEndActive();
      if (m2) return window.ipcRenderer.invoke('interview-session-end-active');
      if (m3) return electronIpcRenderer.invoke('interview-session-end-active');
      break;
    case 'find':
      if (m1 && typeof m1.interviewSessionFindByRound === 'function') return m1.interviewSessionFindByRound(payload);
      if (m2) return window.ipcRenderer.invoke('interview-session-find-by-round', payload);
      if (m3) return electronIpcRenderer.invoke('interview-session-find-by-round', payload);
      break;
  }
  return { ok: false, error: 'no_channel', msg: '面试记录 IPC 通道未就绪' };
}

/**
 * 显示底部 toast 反馈（⏹/🆕/📚 点击/错误反馈）。
 * @param {string} text  内容
 * @param {'ok'|'warn'|'error'} [type] 样式
 * @param {number} [ms]  自动隐藏毫秒，默认 2500
 */
function showToast(text, type, ms) {
  try {
    const t = elements.bottomToast;
    if (!t) return;
    t.classList.remove('hidden','toast-ok','toast-warn','toast-error');
    if (type === 'warn') t.classList.add('toast-warn');
    else if (type === 'error') t.classList.add('toast-error');
    else t.classList.add('toast-ok');
    t.textContent = String(text || '');
    if (t.__toastTimer) { clearTimeout(t.__toastTimer); t.__toastTimer = null; }
    const dur = Number(ms) || 2500;
    t.__toastTimer = setTimeout(() => {
      t.classList.add('hidden');
      t.__toastTimer = null;
    }, dur);
  } catch (_) { /* ignore */ }
}

/**
 * 读当前主窗口填写的「目标公司 / 目标职位 / JD」快照。
 * 用于开新场时作为 Session 的初始 config（localHttpServer.startNewSession 会把这些写入 session.config）。
 * @returns {{targetCompany:string,targetPosition:string,jobDescription:string}}
 */
function readCompanyPositionSnapshot() {
  return {
    targetCompany: (elements.targetCompany ? String(elements.targetCompany.value || '').trim() : ''),
    targetPosition: (elements.targetPosition ? String(elements.targetPosition.value || '').trim() : ''),
    jobDescription: (elements.jobDescription ? String(elements.jobDescription.value || '') : ''),
  };
}

/**
 * MS 粒度时间戳 → 本地化短时间字符串（列表/详情 meta 展示用）。
 * @param {number|string|null} ts
 * @returns {string}
 */
function formatTime(ts) {
  const n = Number(ts);
  if (!n || !isFinite(n)) return '';
  const d = new Date(n);
  if (isNaN(d.getTime())) return '';
  const pad = (x) => (x < 10 ? '0' + x : String(x));
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 计算一场面试的持续时长（endedAt - startedAt，单位秒 → 友好字符串）。
 * @param {number} startedAt
 * @param {number} [endedAt]
 * @returns {string}
 */
function formatDuration(startedAt, endedAt) {
  const s = Number(startedAt) || 0;
  const e = Number(endedAt) || Date.now();
  if (!s || e < s) return '';
  const sec = Math.floor((e - s) / 1000);
  if (sec <= 0) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const sc = sec % 60;
  if (h > 0) return `${h}小时${m}分${sc}秒`;
  if (m > 0) return `${m}分${sc}秒`;
  return `${sc}秒`;
}

/**
 * viewRouter：home / sessions-list / session-detail / end-session 四态切换。
 * 设计：
 *   - 默认 state.view = 'home'
 *   - go('home')                       → 显示首页，隐藏其他
 *   - go('list')                       → 显示列表 + 调用 renderSessionsList()
 *   - go('detail', sessionId, roundId) → 详情页 + 渲染 + roundId 锚点高亮
 *   - go('end', payload)               → 显示面试结束总结页（payload 含 sessionId / roundsCount 等）
 */
const viewRouter = {
  /** 当前路由：home / list / detail / end */
  state: { view: 'home', detailSessionId: null, highlightRoundId: null },

  /** 初始化：默认显示首页，不做任何会话 IPC（避免启动首屏等待） */
  init() {
    this.state = { view: 'home', detailSessionId: null, highlightRoundId: null };
    this._applyDom();
  },

  /** 路由切换入口（渲染层唯一调用点） */
  async go(view, payload, subPayload) {
    const v = String(view || 'home');
    switch (v) {
      case 'home':
        this.state.view = 'home';
        this.state.detailSessionId = null;
        this.state.highlightRoundId = null;
        this._applyDom();
        break;
      case 'list':
        this.state.view = 'list';
        this._applyDom();
        await renderSessionsList();
        break;
      case 'detail':
        this.state.view = 'detail';
        this.state.detailSessionId = String(payload || '');
        this.state.highlightRoundId = subPayload ? String(subPayload) : null;
        this._applyDom();
        await renderSessionDetail(this.state.detailSessionId, this.state.highlightRoundId);
        break;
      case 'end':
        this.state.view = 'end';
        this._applyDom();
        // 渲染结束总结页：payload 可能为空（直接 go('end')）
        if (payload && typeof payload === 'object') {
          renderEndSessionView(payload);
        }
        break;
      default:
        this.state.view = 'home';
        this._applyDom();
    }
  },

  /** 纯 DOM 切换：显示目标 panel / 隐藏其他；无数据请求 */
  _applyDom() {
    const panels = [elements.viewHome, elements.viewSessionsList, elements.viewSessionDetail, elements.endSessionView];
    panels.forEach((p) => {
      if (!p) return;
      if (!p.classList.contains('view-panel')) p.classList.add('view-panel');
      p.classList.add('hidden');
    });
    switch (this.state.view) {
      case 'list':
        elements.viewSessionsList && elements.viewSessionsList.classList.remove('hidden');
        break;
      case 'detail':
        elements.viewSessionDetail && elements.viewSessionDetail.classList.remove('hidden');
        break;
      case 'end':
        elements.endSessionView && elements.endSessionView.classList.remove('hidden');
        break;
      case 'home':
      default:
        elements.viewHome && elements.viewHome.classList.remove('hidden');
    }
  }
};

/**
 * 渲染「全部面试记录」列表（含 search + 总数提示 + 空态）。
 * 空态 → 给出"还没有面试记录"的友好占位；否则渲染卡片；每条点击 → go('detail', session.id)。
 */
async function renderSessionsList() {
  const listEl = elements.sessionsListContainer;
  const emptyEl = elements.sessionsEmptyHint;
  const totalHint = elements.sessionTotalHint;
  const searchEl = elements.sessionSearchInput;
  if (!listEl || !emptyEl) return;

  // ★ 当前选中的面试类型：'copilot'=真实面试 / 'mock'=模拟面试（方案 A 强制互斥）
  const categoryFilter = (SessionListUI.categoryFilter === 'mock') ? 'mock' : 'copilot';
  const categoryLabel  = (categoryFilter === 'mock') ? '🎯 模拟面试' : '💼 真实面试';

  const keyword = searchEl ? String(searchEl.value || '').trim() : '';
  listEl.innerHTML = '';
  emptyEl.classList.add('hidden');
  totalHint && (totalHint.textContent = '加载中…');

  let res = null;
  try {
    // ★ IPC 透传 category 过滤参数（真实/模拟互斥）
    res = await _callInterviewSession('list', {
      keyword,
      limit: 200,
      offset: 0,
      category: categoryFilter,
    });
  } catch (e) {
    console.warn('[session][list] IPC 异常:', e && e.message);
    showToast('读取面试记录失败：' + (e && e.message || '网络异常'), 'error');
  }
  // 【排障日志】如果返回结构异常，在 DevTools Console 里明确打印一次（方便定位"明明有文件却说 0 场"）
  try {
    const okFlag = !!(res && res.ok !== false && Array.isArray(res.sessions));
    const count = (res && Array.isArray(res.sessions)) ? res.sessions.length : -1;
    if (!okFlag) {
      console.warn('[session][list] ⚠️ 未拿到 sessions 数组：res=', res);
    } else {
      console.log(`[session][list] ✅ 拿到面试记录：category=${categoryFilter} total=${Number(res.total || 0)} currentPageCount=${count}`);
    }
  } catch (_) { /* ignore */ }
  if (!res || res.ok === false || !Array.isArray(res.sessions)) {
    totalHint && (totalHint.textContent = `共 0 场 · ${categoryLabel}`);
    emptyEl.classList.remove('hidden');
    // ★ 空态文案按分类区分（互斥展示）
    emptyEl.innerHTML = `📭 <br>当前分类（${categoryLabel}）暂无面试记录。<br>${categoryFilter === 'mock' ? '回到「模拟面试」面板，点击「开始模拟面试」生成记录。' : '开启 Copilot 模式进行真实面试后，记录会出现在这里。'}`;
    return;
  }
  const arr = res.sessions;
  // ★ 共 N 场 · 类型标签（真实/模拟）
  totalHint && (totalHint.textContent = `共 ${Number(res.total || arr.length)} 场 · ${categoryLabel}` + (keyword ? `（关键词：${keyword}）` : ''));
  if (arr.length === 0) {
    emptyEl.classList.remove('hidden');
    // ★ 搜索无结果 / 当前分类无数据 文案
    if (keyword) {
      emptyEl.innerHTML = `🔍 <br>关键词「${escapeHtml(keyword)}」在${categoryLabel}中没有匹配结果。`;
    } else {
      emptyEl.innerHTML = `📭 <br>${categoryLabel}暂无记录。<br>${categoryFilter === 'mock' ? '从「模拟面试」面板开始一场模拟面试试试吧。' : '开启 Copilot 模式进行真实面试后再回来查看。'}`;
    }
    return;
  }

  listEl.innerHTML = arr.map((s, i) => {
    const id = String(s.sessionId || s.id || `s-${i}`);
    const company = String(s.targetCompany || '未知公司').trim() || '未知公司';
    const position = String(s.targetPosition || '未知职位').trim() || '未知职位';
    const title = `${company} · ${position}`;
    const active = (s.status === 'active');
    const roundsCount = Number(s.roundsCount || 0);
    const qCount = Number(s.questionCount || 0);
    const startedAt = Number(s.startedAt || 0);
    const endedAt   = Number(s.endedAt || 0);
    const startedStr = formatTime(startedAt);
    const durationStr = active
      ? ('进行中 · ' + (formatDuration(startedAt, Date.now()) || '<1 秒'))
      : (endedAt ? ('已结束 · ' + (formatDuration(startedAt, endedAt) || '0 秒')) : '已结束');

    // ★ 卡片上的面试类型徽章：与后端推断保持一致（兜底 meta.mockInterview 等老数据）
    const cat = (s.category === 'mock'
      || (s.meta && typeof s.meta === 'object' && s.meta.mockInterview)
      || (s.config && typeof s.config === 'object' && s.config._mockInterview)) ? 'mock' : 'copilot';
    const catBadge = (cat === 'mock')
      ? '<span class="sc-cat sc-cat-mock">🎯 模拟</span>'
      : '<span class="sc-cat sc-cat-copilot">💼 真实</span>';

    // 列表"前一段对话"摘要：优先用 snippet；否则用最后一轮的问题
    let desc = String(s.snippet || '').trim();
    if (!desc && Array.isArray(s.lastRounds) && s.lastRounds.length) {
      const lr = s.lastRounds[s.lastRounds.length - 1];
      const q = String((lr && lr.questionText) || '').trim();
      const a = String((lr && lr.answerText) || '').trim();
      desc = q || a || '';
    }
    return `
      <button class="session-card" type="button" data-session-id="${escapeAttr(id)}">
        <div class="sc-row1">
          <div class="sc-title">${escapeHtml(title)}</div>
          ${catBadge}
          <span class="sc-status ${active ? 'active' : 'closed'}">${active ? '● 进行中' : '● 已结束'}</span>
        </div>
        <div class="sc-meta">
          ${startedStr ? `<span>🕒 ${escapeHtml(startedStr)}</span>` : ''}
          <span>💬 ${roundsCount} 轮</span>
          ${qCount ? `<span>❓ ${qCount} 题</span>` : ''}
          <span>${escapeHtml(durationStr)}</span>
        </div>
        ${desc ? `<div class="sc-desc">${escapeHtml(desc)}</div>` : ''}
      </button>
    `;
  }).join('');

  // 绑定每条卡片点击 → go('detail', id)
  listEl.querySelectorAll('.session-card').forEach((btn) => {
    btn.addEventListener('click', () => {
      const sid = btn.getAttribute('data-session-id');
      sid && viewRouter.go('detail', sid);
    });
  });
}

/**
 * 渲染面试详情页：标题 + 会话元信息 + rounds 对话气泡。
 * @param {string} sessionId
 * @param {string} [highlightRoundId] 需要高亮的 round（侧栏跳转传入）
 */
async function renderSessionDetail(sessionId, highlightRoundId) {
  const titleEl = elements.sessionDetailTitle;
  const metaEl = elements.sessionDetailMeta;
  const chatEl = elements.sessionDetailChat;
  const emptyEl = elements.sessionDetailEmpty;
  if (!titleEl || !chatEl || !emptyEl) return;
  chatEl.innerHTML = '';
  emptyEl.classList.add('hidden');
  titleEl.textContent = '加载中…';
  metaEl && (metaEl.textContent = '');

  let res = null;
  try {
    res = await _callInterviewSession('get', String(sessionId || ''));
  } catch (e) {
    console.warn('[session][detail] IPC 异常:', e && e.message);
  }
  if (!res || !res.ok || !res.session) {
    titleEl.textContent = '面试详情';
    metaEl && (metaEl.textContent = '');
    chatEl.innerHTML = '';
    emptyEl.classList.remove('hidden');
    emptyEl.textContent = (res && res.msg) ? ('读取失败：' + res.msg) : '该场面试不存在或无法读取。';
    showToast('读取失败：' + ((res && res.msg) || '未知错误'), 'error');
    return;
  }
  const s = res.session;
  const company = String((s.config && s.config.targetCompany) || s.targetCompany || '未知公司').trim() || '未知公司';
  const position = String((s.config && s.config.targetPosition) || s.targetPosition || '未知职位').trim() || '未知职位';
  const rounds = Array.isArray(s.rounds) ? s.rounds : [];
  const active = (s.status === 'active');
  const startedAt = Number(s.startedAt) || 0;
  const endedAt   = Number(s.endedAt)   || 0;

  titleEl.textContent = `${company} · ${position}`;

  // meta ：状态 / 开始 / 结束 / 轮数 / 时长
  if (metaEl) {
    const pills = [];
    pills.push(`<span class="pill ${active ? 'status-active' : 'status-closed'}">${active ? '● 进行中' : '● 已结束'}</span>`);
    startedAt && pills.push(`<span class="pill">🕒 开始 ${escapeHtml(formatTime(startedAt))}</span>`);
    endedAt   && pills.push(`<span class="pill">⌛ 结束 ${escapeHtml(formatTime(endedAt))}</span>`);
    pills.push(`<span class="pill">💬 ${rounds.length} 轮</span>`);
    const dur = formatDuration(startedAt, active ? Date.now() : endedAt);
    dur && pills.push(`<span class="pill">⏱ 时长 ${escapeHtml(dur)}</span>`);
    metaEl.innerHTML = pills.join('');
  }

  if (rounds.length === 0) {
    emptyEl.classList.remove('hidden');
    emptyEl.textContent = '该场面试还没有任何对话轮次。';
    return;
  }

  // 渲染每一轮：round-index 小徽标 + createdAt + 面试官(Q) + AI(A) 气泡
  chatEl.innerHTML = rounds.map((r, i) => {
    const id = String(r.id || `r-${i}`);
    const needHighlight = highlightRoundId && String(highlightRoundId) === id;
    const idx = i + 1;
    const createdAt = Number(r.createdAt || 0);
    const qFull = String(r.questionText || '').trim();      // 完整面试官原文（含问题之外的描述）
    const qCore = String(r.detectedQuestion || r.questionText || '').trim();
    const a     = String(r.answerText || '').trim();
    const status = String(r.status || '');
    const source = String(r.source || '');
    const sourceMap = {
      'asr-panel': '🎙ASR', 'manual': '✍️ 手动', 'screenshot': '📸 截图',
      'h5': '📱 H5', 'screen-solve': '🖥解题',
    };
    const statusMap = { asked: '答题中', answered: '已回答', error: '失败' };
    const footArr = [];
    source && footArr.push('来源：' + (sourceMap[source] || source));
    status && footArr.push('状态：' + (statusMap[status] || status));
    Number(r.durationMs) > 0 && footArr.push('答题耗时：' + (Math.round(r.durationMs / 100) / 10) + 's');
    createdAt && footArr.push(formatTime(createdAt));
    // Q 气泡：显示完整原文（用户阶段4 明确：对话框需要显示识别出的"全部文字"，而不是仅问题）；检测出的问题在脚注里提示一下
    const questionBody = qFull || (qCore ? (qCore + '（注：仅识别到问题核心）') : '（无识别文本）');
    const coreHint = (qFull && qCore && qFull !== qCore && qFull.indexOf(qCore) < 0)
      ? `<div style="margin-top:6px; font-size:0.75rem; color:var(--text-tertiary)">🔍 识别出的核心问题：${escapeHtml(qCore)}</div>`
      : '';
    return `
      <section class="round-block ${needHighlight ? 'round-highlight' : ''}" id="round-${escapeAttr(id)}" data-round-id="${escapeAttr(id)}">
        <div class="round-head">
          <span class="round-index">第 ${idx} 轮</span>
          <span>roundId: ${escapeHtml(id)}</span>
        </div>
        <div class="speech-bubble question">
          <span class="speech-role">👤 面试官</span>
          ${escapeHtml(questionBody)}
          ${coreHint}
        </div>
        ${a ? `<div class="speech-bubble answer"><span class="speech-role">🤖 AI 助手</span>${escapeHtml(a)}</div>` : ''}
        ${footArr.length ? `<div class="round-meta-foot">${footArr.map((x)=>`<span>${escapeHtml(x)}</span>`).join('')}</div>` : ''}
      </section>
    `;
  }).join('');

  // 如果有 highlightRoundId：滚到对应 block + 动画 1.6s 已在 CSS round-highlight
  if (highlightRoundId) {
    requestAnimationFrame(() => {
      try {
        const el = chatEl.querySelector(`#round-${CSS.escape ? CSS.escape(String(highlightRoundId)) : String(highlightRoundId).replace(/(["\\])/g,'\\\\$1')}`);
        if (el && typeof el.scrollIntoView === 'function') {
          el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      } catch (_) { /* scrollIntoView 小概率抛错（极长 id），忽略 */ }
    });
  } else {
    // 默认滚到底（和主窗口正序内存最近一轮在下一致：详情最近一轮在下，对齐用户记忆）
    requestAnimationFrame(() => { chatEl.scrollTop = chatEl.scrollHeight; });
  }
}

// ============================================================================
// 给模拟面试（mockResumePanels.js）暴露的语音作答控制：
// window.HireMeCore.startMockInterviewVoiceAnswer(callbacks, opts)
// 只负责：麦克风 → 百度实时 ASR（缺实时能力则降级为 1.5s REST 识别一次）
// callbacks: {onInterim(text), onFinal(text), onError(msg), onStateChange(state)}
// state: 'idle'|'starting'|'mic'|'connecting'|'listening'|'stopped'
// 返回: { stop():Promise<void>, isRunning():boolean }
// ============================================================================
(function exposeMockInterviewVoice() {
  // 小工具：把 Float32Array（16kHz 单声道）按百度实时 ASR 要求喂给 WS；这里统一不做二次重采样，依赖 createPcmRecorder 已经 16k。
  function toFloat32(samplesLike) {
    if (samplesLike instanceof Float32Array) return samplesLike;
    if (Array.isArray(samplesLike)) return new Float32Array(samplesLike);
    if (samplesLike && typeof samplesLike.length === 'number') {
      const out = new Float32Array(samplesLike.length);
      for (let i = 0; i < samplesLike.length; i++) out[i] = Number(samplesLike[i]) || 0;
      return out;
    }
    return new Float32Array(0);
  }

  async function startMockInterviewVoiceAnswer(callbacks, opts) {
    const cb = Object.assign({ onInterim: () => {}, onFinal: () => {}, onError: () => {}, onStateChange: () => {} }, callbacks || {});
    const state = { running: false };
    const setState = (s) => { cb.onStateChange(s); };

    // ★ 积分预校验：AI 模拟面试每 1 轮（面试官 1 问 + 你 1 答 + AI 点评）扣 3 分（MOCK_PER_ROUND）
    const pre = await tryConsumeCreditsBefore({
      bizType: 'mock_round',
      credits: 3,
      bizName: 'AI 模拟面试（1 轮问答）',
      bizId:   (opts && (opts.roundId || opts.sessionId)) ? String(opts.roundId || opts.sessionId) : undefined,
      desc:    '模拟面试 1 轮：包含面试官提问、你的语音作答、AI 点评反馈。',
    });
    if (!pre || !pre.ok) {
      cb.onError((pre && pre.msg) || '积分不足，已取消本轮模拟面试。');
      setState('stopped');
      return { stop: async () => {}, isRunning: () => false };
    }

    setState('starting');

    // 1) 取媒体流（麦克风）
    let stream = null;
    let recorder = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 16000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
    } catch (e) {
      cb.onError(`麦克风授权失败：${e.message || e}`);
      setState('stopped');
      return { stop: async () => {}, isRunning: () => false };
    }

    try {
      // 2) 建录音器（复用 renderer.js 全局 createPcmRecorder）
      recorder = createPcmRecorder({ stream });
      await recorder.start();
      state.running = true;
      setState('mic');
    } catch (e) {
      try { stream.getTracks().forEach(t => t.stop()); } catch (_) {}
      cb.onError(`录音器启动失败：${e.message || e}`);
      setState('stopped');
      return { stop: async () => {}, isRunning: () => false };
    }

    // 3) 读取配置并决定走实时 WS 还是 REST
    let cfg = null;
    try {
      cfg = (typeof ipcRenderer !== 'undefined' && ipcRenderer.invoke)
        ? (await ipcRenderer.invoke('get-config')) || {}
        : {};
    } catch (_) { cfg = {}; }

    const apiKey = cfg.baiduApiKey || '';
    const secretKey = cfg.baiduSecretKey || '';
    const appId = cfg.baiduAppId || '';
    const recogMode = cfg.recognitionMode || 'websocket';

    let rtSvc = null; // RealtimeSpeechService（全局存在的类）
    let useRest = (recogMode !== 'websocket') || !window.RealtimeSpeechService || typeof RealtimeSpeechService !== 'function';
    let wsPump = null;   // setInterval 句柄
    let restPump = null;
    let closedByUser = false;
    let wsWentOk = false;
    let wsWentClosed = false;

    // stop 函数（对外 & 对内共用）
    const stopFn = async () => {
      closedByUser = true;
      state.running = false;
      try { if (wsPump) { clearInterval(wsPump); wsPump = null; } } catch (_) {}
      try { if (restPump) { clearInterval(restPump); restPump = null; } } catch (_) {}
      try { if (rtSvc && rtSvc.finish) rtSvc.finish(); } catch (_) {}
      try { if (rtSvc && rtSvc.close) rtSvc.close(); } catch (_) {}
      try { if (recorder && recorder.stop) recorder.stop(); } catch (_) {}
      try { if (stream) stream.getTracks().forEach(t => t.stop()); } catch (_) {}
      setState('stopped');
    };

    // 4) WebSocket 模式：百度实时 ASR
    if (!useRest && apiKey && secretKey && appId) {
      try {
        setState('connecting');
        const tokenRes = (typeof ipcRenderer !== 'undefined' && ipcRenderer.invoke)
          ? (await ipcRenderer.invoke('get-baidu-access-token', { apiKey, secretKey }))
          : { success: false, error: 'ipc 不可用' };
        if (!tokenRes || !tokenRes.success) {
          throw new Error((tokenRes && tokenRes.error) || '获取百度 access_token 失败');
        }
        rtSvc = new RealtimeSpeechService();
        rtSvc.setBoost(Number(cfg.audioBoost) || 2);
        rtSvc.on('open', () => { wsWentOk = true; setState('listening'); });
        rtSvc.on('interim', (d) => {
          const t = (d && typeof d === 'object') ? d.text : String(d || '');
          cb.onInterim(t);
        });
        rtSvc.on('final', (d) => {
          const t = (d && typeof d === 'object') ? d.text : String(d || '');
          cb.onFinal(t);
        });
        rtSvc.on('error', (e) => {
          cb.onError(`ASR 错误：${(e && e.message) || e}`);
        });
        rtSvc.on('close', (info) => {
          wsWentClosed = true;
          // WS 没成功过：切 REST 兜底继续识别
          if (!wsWentOk && !closedByUser && !useRest) {
            useRest = true;
            try { if (wsPump) { clearInterval(wsPump); wsPump = null; } } catch (_) {}
            cb.onError('实时 ASR 未接通，已自动降级为每 1.5s 识别一次。');
            startRestPump();
          }
        });
        rtSvc.connect({ accessToken: tokenRes.token, appId, appKey: apiKey });

        // 100ms 循环：从 recorder 取样本 -> sendAudio；静音时发静音帧，防百度 -3101
        let firstAudioLogged = false;
        wsPump = setInterval(() => {
          if (!state.running || closedByUser) return;
          try {
            const raw = recorder.takeAll ? recorder.takeAll() : new Float32Array(0);
            const samples = toFloat32(raw);
            if (!firstAudioLogged && samples.length) { firstAudioLogged = true; }
            if (!samples.length) {
              const silence = new Float32Array(1600); // 100ms 静音
              try { rtSvc.sendAudio(silence); } catch (_) {}
            } else {
              try { rtSvc.sendAudio(samples); } catch (_) {}
            }
          } catch (_) {}
        }, 100);

        // 10s 超时：若 WS 还没 open，降级 REST
        setTimeout(() => {
          if (!wsWentOk && !wsWentClosed && !closedByUser && !useRest) {
            useRest = true;
            try { rtSvc && rtSvc.close && rtSvc.close(); } catch (_) {}
            try { if (wsPump) { clearInterval(wsPump); wsPump = null; } } catch (_) {}
            cb.onError('实时 ASR 10s 未连接，已降级为 1.5s 识别模式。');
            startRestPump();
          }
        }, 10000);
      } catch (e) {
        useRest = true;
        cb.onError(`实时 ASR 启动失败：${e.message || e}，降级为 1.5s 识别模式。`);
      }
    } else {
      // 没配密钥或强制模式 → 直接降级 REST
      if (!apiKey || !secretKey) {
        cb.onError('请先在设置页配置百度 ASR：API Key + Secret Key（可不配 AppID，REST 模式不用）。否则无法语音作答。');
      }
    }

    // REST 兜底（每 1.5s 累积录音，编码 WAV → baidu-recognize IPC）
    function startRestPump() {
      if (restPump) return;
      setState('listening');
      const MIN_BYTES = 16000 * 0.4; // 最少 0.4s
      restPump = setInterval(async () => {
        if (!state.running || closedByUser) return;
        try {
          const samples = toFloat32(recorder.takeAll ? recorder.takeAll() : []);
          if (samples.length < MIN_BYTES) return;
          const wav = encodeWav(samples, 16000);
          if (!wav) return;
          if (!ipcRenderer || !ipcRenderer.invoke) return;
          const result = await ipcRenderer.invoke('baidu-recognize', {
            audioData: wav, apiKey, secretKey, appId, rate: 16000, channel: 1
          });
          if (result && result.ok && result.text) {
            // REST 只有 final，为了让用户看到识别过程，先给一个 interim 再 final
            cb.onInterim(result.text);
            setTimeout(() => cb.onFinal(result.text), 120);
          }
        } catch (e) {
          cb.onError(`REST 识别异常：${e.message || e}`);
        }
      }, 1500);
    }

    // 如果强制 REST 但密钥存在，则立即启动 REST pump
    if (useRest && !restPump && apiKey && secretKey) startRestPump();

    return {
      stop: stopFn,
      isRunning: () => !!state.running
    };
  }

  // 挂载到全局（mockResumePanels 中通过 window.HireMeCore 访问）
  if (!window.HireMeCore) window.HireMeCore = {};
  window.HireMeCore.startMockInterviewVoiceAnswer = startMockInterviewVoiceAnswer;
})();

/**
 * 监听主进程广播「浮动答题面板已被关闭，本场面试已结束」→ 显示面试结束总结页。
 *   优先走 electronAPI.onOverlayClosedPostSession（preload 桥），
 *   失败直连 window.ipcRenderer.on('overlay:closed-post-session')。
 */
function bindOverlayClosedPostSessionListener() {
  const handler = (payload) => {
    try {
      renderEndSessionView(payload || {});
    } catch (e) {
      console.warn('[session][end-view] renderEndSessionView 异常:', e && e.message);
    }
  };
  if (window.electronAPI && typeof window.electronAPI.onOverlayClosedPostSession === 'function') {
    try {
      const off = window.electronAPI.onOverlayClosedPostSession(handler);
      if (typeof off === 'function') window.__unbindESB = off;
      return;
    } catch (e) {
      console.warn('[session][esb-listener] preload 桥异常，回退直连 ipcRenderer:', e && e.message);
    }
  }
  if (window.ipcRenderer && typeof window.ipcRenderer.on === 'function') {
    window.ipcRenderer.on('overlay:closed-post-session', (_evt, payload) => handler(payload));
  }
}

/**
 * 最近一次渲染的面试结束页 payload，供页面内按钮事件共享。
 * 注意：不能直接挂到 DOM dataset（避免对象循环），用模块级闭包保存。
 */
let _lastEndSessionPayload = {};

/**
 * 渲染「面试结束总结页」：关闭浮动面板后，主窗口切换到全页总结。
 *   面试时长 / 检测到问题 / AI 建议 · 保存提示 · 评分 · 推荐 · 复盘/新面试
 * @param {{sessionId?:string, roundsCount?:number, answeredCount?:number, startedAt?:number, endedAt?:number, company?:string, position?:string, endResError?:string, endResMsg?:string}} payload
 */
function renderEndSessionView(payload) {
  payload = payload || {};
  _lastEndSessionPayload = payload;

  const view = elements.endSessionView;
  const metaEl = elements.esvSessionMeta;
  const durEl = elements.esvDuration;
  const qEl = elements.esvQuestionCount;
  const aEl = elements.esvAnswerCount;
  if (!view) return;

  const company = String(payload.company || '未知公司').trim() || '未知公司';
  const position = String(payload.position || '未知职位').trim() || '未知职位';
  if (metaEl) {
    metaEl.innerHTML = `<span class="pill">${escapeHtml(company)} · ${escapeHtml(position)}</span><span class="pill status-closed">已结束</span>`;
  }

  const durStr = formatDuration(Number(payload.startedAt) || 0, Number(payload.endedAt) || Date.now());
  if (durEl) durEl.textContent = durStr || '—';
  if (qEl) qEl.textContent = String(Number(payload.roundsCount) || 0);
  if (aEl) aEl.textContent = String(Number(payload.answeredCount) || Number(payload.roundsCount) || 0);

  // 每次打开重置评分
  resetEndSessionRating();

  // 切换到结束总结页（viewRouter 会处理 DOM 显隐）
  if (typeof viewRouter === 'object' && viewRouter && typeof viewRouter.go === 'function') {
    viewRouter.go('end');
  }
}

/** 隐藏面试结束总结页：回到首页 */
function hideEndSessionView() {
  if (typeof viewRouter === 'object' && viewRouter && typeof viewRouter.go === 'function') {
    viewRouter.go('home');
  }
}

/**
 * 重置评分星星为未选择状态。
 */
function resetEndSessionRating() {
  const stars = elements.esvRatingStars;
  const hint = elements.esvRatingHint;
  if (stars) {
    stars.dataset.rating = '0';
    Array.from(stars.querySelectorAll('button')).forEach((btn) => {
      btn.textContent = '☆';
      btn.classList.remove('selected');
    });
  }
  if (hint) hint.textContent = '点击星星评分';
}

/**
 * 提交用户评分（当前仅本地记录，可扩展为上报）。
 * @param {number} rating 1-5
 */
function submitEndSessionRating(rating) {
  console.log('[session][end] 用户评分:', rating, 'sessionId:', _lastEndSessionPayload && _lastEndSessionPayload.sessionId);
  // TODO：可在此调用统计接口，例如 window.electronAPI.feedbackRating(rating, sessionId)
}

/**
 * 绑定面试 Session 的所有 UI 事件。
 *   - Copilot 卡片区「📚 查看全部面试记录」按钮：go('list')
 *   - 面试结束总结页 ESV：返回 / 🔍查看本场 / ✨复盘 / 🆕开启新面试 / 评分 / 复制推荐链接
 *   - 列表页：返回 / 搜索回车 / 刷新按钮
 *   - 详情页：返回（统一回到列表页，符合用户心智）
 *   - 公司/职位：失焦 + 1.5s 防抖 → 非空且变化 → 自动 startNewSession（用户未要求删除，保留）
 */
function bindSessionUIActions() {
  // -------- Copilot 卡片区：📚 查看全部面试记录（已从底部挪到开始面试辅助按钮正下方） --------
  if (elements.btnViewAllSessions) {
    elements.btnViewAllSessions.addEventListener('click', () => viewRouter.go('list'));
  }

  // -------- 面试结束总结页 ESV：返回 / 查看本场 / 复盘 / 开启新面试 / 评分 / 复制推荐链接 --------
  if (elements.esvBackHomeBtn) {
    elements.esvBackHomeBtn.addEventListener('click', () => hideEndSessionView());
  }
  if (elements.esvViewDetailBtn) {
    elements.esvViewDetailBtn.addEventListener('click', () => {
      const sid = String((_lastEndSessionPayload && _lastEndSessionPayload.sessionId) || '');
      if (!sid) {
        // 小概率异常：无 sessionId → 兜底跳列表页让用户挑一场
        showToast('未能识别本场面试 ID，已跳到全部记录列表', 'warn');
        hideEndSessionView();
        viewRouter.go('list');
        return;
      }
      hideEndSessionView();
      viewRouter.go('detail', sid);
    });
  }
  if (elements.esvReviewBtn) {
    // 「面试复盘」按钮：触发 Copilot 的 AI 复盘（先回到首页再打开复盘弹窗）
    elements.esvReviewBtn.addEventListener('click', async () => {
      hideEndSessionView();
      try {
        // 触发 Copilot 模块的 generateReviewForHistory（定义在 copilot.js，挂载在 window 上）
        if (window.generateReviewForHistory && typeof window.generateReviewForHistory === 'function') {
          await window.generateReviewForHistory();
        } else {
          showToast('复盘入口尚未就绪，请稍后手动点击「✨ 生成 AI 复盘」', 'warn');
        }
      } catch (e) {
        console.warn('[session][esv-review] 复盘异常:', e && e.message);
        showToast('生成复盘失败：' + (e && e.message || '异常'), 'error');
      }
    });
  }
  if (elements.esvNewSessionBtn) {
    elements.esvNewSessionBtn.addEventListener('click', async () => {
      hideEndSessionView();
      try {
        const cfg = readCompanyPositionSnapshot();
        const r = await _callInterviewSession('start', cfg);
        if (r && r.ok) {
          const company = String((r.session && ((r.session.config && r.session.config.targetCompany) || r.session.targetCompany)) || '未知公司').trim() || '未知公司';
          const position = String((r.session && ((r.session.config && r.session.config.targetPosition) || r.session.targetPosition)) || '未知职位').trim() || '未知职位';
          showToast(`🆕 已开启新一场：${company} · ${position}`, 'ok');
        } else {
          showToast('开新场失败：' + ((r && r.msg) || '未知原因'), 'error');
        }
      } catch (e) {
        console.warn('[session][esv-new] 异常:', e && e.message);
        showToast('开新场失败：' + (e && e.message || '异常'), 'error');
      }
    });
  }
  if (elements.esvCopyInviteBtn) {
    elements.esvCopyInviteBtn.addEventListener('click', async () => {
      const inviteLink = 'https://hireme.ai/invite?ref=desktop';
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(inviteLink);
        } else {
          // 兜底：创建临时 textarea
          const ta = document.createElement('textarea');
          ta.value = inviteLink;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
        }
        showToast('推荐链接已复制到剪贴板', 'ok');
      } catch (e) {
        console.warn('[session][esv-invite] 复制失败:', e && e.message);
        showToast('复制失败：' + (e && e.message || '异常'), 'error');
      }
    });
  }
  if (elements.esvRatingStars) {
    const starBtns = elements.esvRatingStars.querySelectorAll('button[data-star]');
    starBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        const rating = Number(btn.dataset.star) || 0;
        const stars = elements.esvRatingStars;
        if (stars) stars.dataset.rating = String(rating);
        starBtns.forEach((b) => {
          const s = Number(b.dataset.star) || 0;
          b.textContent = s <= rating ? '★' : '☆';
          b.classList.toggle('selected', s <= rating);
        });
        const hint = elements.esvRatingHint;
        const hints = ['点击星星评分', '继续努力', '一般般', '还不错', '很满意', '太棒了'];
        if (hint) hint.textContent = hints[rating] || '点击星星评分';
        submitEndSessionRating(rating);
      });
    });
  }

  // -------- 列表页：返回 / 搜索回车 / 刷新 --------
  if (elements.btnListBackHome) {
    elements.btnListBackHome.addEventListener('click', () => viewRouter.go('home'));
  }
  if (elements.btnReloadSessionList) {
    elements.btnReloadSessionList.addEventListener('click', () => renderSessionsList());
  }
  if (elements.sessionSearchInput) {
    let t = null;
    elements.sessionSearchInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        // 防抖 200ms：避免连续回车刷多次
        t && clearTimeout(t);
        t = setTimeout(() => renderSessionsList(), 200);
      }
    });
    // 清空搜索词 → 立即重绘（空关键词 = 展示全部）
    elements.sessionSearchInput.addEventListener('input', () => {
      if (!String(elements.sessionSearchInput.value || '').trim()) {
        t && clearTimeout(t); t = null; renderSessionsList();
      }
    });
  }

  // ★ 列表页：真实面试 / 模拟面试 分类 Tab 点击切换（互斥）
  if (elements.sessionCategoryTabs) {
    elements.sessionCategoryTabs.addEventListener('click', (ev) => {
      // 事件委托：命中 .sc-tab 按钮才响应
      const tab = ev.target && ev.target.closest && ev.target.closest('.sc-tab');
      if (!tab) return;
      const cat = String(tab.dataset.category || '').toLowerCase();
      if (cat === 'copilot' || cat === 'mock') {
        setSessionCategory(cat);
      }
    });
  }

  // ★ 自定义事件：hireme:open-session-detail
  //   两种使用场景（二选一或同时传，以 sessionId 优先）：
  //   ① 有 sessionId：进入"面试记录页"并打开某一条详情（典型：某场已结束面试点击"查看本场"）
  //   ② 只有 category：进入"面试记录页"并切到对应分类 Tab（典型：点击"查看所有模拟面试记录"）
  //   detail = { sessionId?, category?, source? }  category 支持 'copilot' | 'mock'
  window.addEventListener('hireme:open-session-detail', (ev) => {
    const detail = (ev && ev.detail && typeof ev.detail === 'object') ? ev.detail : {};
    const sid = String(detail.sessionId || detail.id || '').trim();
    const cat = String(detail.category || '').toLowerCase();
    const hasCat = (cat === 'mock' || cat === 'copilot');
    // 两个都没传：无事可做
    if (!sid && !hasCat) return;

    // 场景 1：指定了 sessionId → 最终跳详情
    if (sid) {
      const switchFn = () => { viewRouter.go('detail', sid); };
      if (hasCat && SessionListUI.categoryFilter !== cat) {
        // 先切 Tab（会重新拉该分类的列表），再在下一帧跳详情，确保分类正确后再渲染详情返回
        setSessionCategory(cat);
        setTimeout(switchFn, 0);
      } else {
        switchFn();
      }
      return;
    }

    // 场景 2：只有 category → 切 Tab + 跳到面试记录列表页（"查看所有模拟面试记录"场景）
    const gotoListFn = () => { viewRouter.go('list'); };
    if (hasCat && SessionListUI.categoryFilter !== cat) {
      setSessionCategory(cat);
      setTimeout(gotoListFn, 0);
    } else {
      gotoListFn();
    }
  });

  // -------- 详情页：返回按钮 --------
  if (elements.btnDetailBack) {
    elements.btnDetailBack.addEventListener('click', () => {
      // 统一回到列表页（符合：同一详情页，从 home 侧栏进 vs 从列表进，返回都回列表 → 最符合直觉）
      viewRouter.go('list');
    });
  }

  // -------- 公司/职位：失焦 → 1.5s 防抖 → 非空且变化 → 自动开新场 --------
  const companyEl = elements.targetCompany;
  const positionEl = elements.targetPosition;
  if (companyEl || positionEl) {
    // 记录上一次"已用于自动开新场"的快照，避免重复触发
    let lastTriggeredSnapshot = { company: '', position: '' };
    let debounceTimer = null;
    /** 检测并启动新场：防抖函数体 */
    const tryAutoStart = () => {
      debounceTimer = null;
      const cfg = readCompanyPositionSnapshot();
      const c = cfg.targetCompany;
      const p = cfg.targetPosition;
      // 空值不开（未填），等用户填完再说
      if (!c && !p) return;
      // 与上次已触发快照完全一致 → 不重复开
      if (c === lastTriggeredSnapshot.company && p === lastTriggeredSnapshot.position) return;
      lastTriggeredSnapshot = { company: c, position: p };
      (async () => {
        try {
          const r = await _callInterviewSession('start', cfg);
          if (r && r.ok) {
            showToast(`🆕 检测到新公司/新职位：已自动开启新一场`, 'ok');
          } else if (r && r.error === 'no_change') {
            // localHttpServer.startNewSession 内部如果判断同一场没变化，会返回 no_change（保留未来扩展，当前不打断）
          } else {
            showToast('自动开新场失败：' + ((r && r.msg) || '未知原因'), 'warn');
          }
        } catch (e) {
          console.warn('[session][auto-new] 异常:', e && e.message);
        }
      })();
    };
    /** 失焦统一入口：1.5s 防抖（快速改公司+职位时只在最后一起触发） */
    const onBlur = () => {
      debounceTimer && clearTimeout(debounceTimer);
      debounceTimer = setTimeout(tryAutoStart, 1500);
    };
    companyEl  && companyEl.addEventListener('blur',  onBlur);
    positionEl && positionEl.addEventListener('blur', onBlur);
  }
}


