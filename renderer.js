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
  closeHistoryBtn: document.getElementById('closeHistoryBtn'),
  historyList: document.getElementById('historyList'),
  alwaysOnTop: document.getElementById('alwaysOnTop'),
  opacitySlider: document.getElementById('opacitySlider'),
  opacityValue: document.getElementById('opacityValue'),
  quickHideBtn: document.getElementById('quickHideBtn'),
  toggleStealthBtn: document.getElementById('toggleStealthBtn'),
  hotkeyDisplay: document.getElementById('hotkeyDisplay'),
  hotkeyInput: document.getElementById('hotkeyInput'),
  testHideBtn: document.getElementById('testHideBtn'),
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
  resumePanel: document.getElementById('resumePanel')
};

// 初始化（唯一入口）
async function init() {
  // 加载配置
  appState.config = await ipcRenderer.invoke('get-config');
  appState.history = await ipcRenderer.invoke('get-history');

  // 加载保存的简历
  await loadResume();

  // 初始化UI
  updateSettingsUI();
  renderHistory();

  // 初始化字体大小缩放（A⁻ / 100% / A⁺）：必须在 bindEvents 前，保证与其他控件互不干扰
  initFontZoom();

  // 绑定事件
  bindEvents();

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
  initResizeHandles();

  // 监听主进程发来的隐身模式切换事件（来自托盘菜单/快捷键）
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

  // 监听主进程的"临时全显"事件（Ctrl+Shift+Space 触发）
  ipcRenderer.on('stealth-temp-reveal', (event, reveal) => {
    if (reveal) {
      document.body.classList.add('stealth-temp-reveal');
    } else {
      document.body.classList.remove('stealth-temp-reveal');
    }
  });
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
  
  // 点击弹窗外部关闭
  if (elements.settingsModal) {
    elements.settingsModal.addEventListener('click', (e) => {
      if (e.target === elements.settingsModal) {
        elements.settingsModal.classList.remove('open');
      }
    });
  }
  
  // 历史记录侧边栏
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

  // 关闭面试蒙版按钮
  const closeOverlayBtn = document.getElementById('closeOverlayBtn');
  if (closeOverlayBtn) {
    closeOverlayBtn.addEventListener('click', async () => {
      const overlay = document.getElementById('interviewOverlay');
      overlay.classList.remove('show');

      // 关闭弹窗时，只有监听来源是"面试"时才停止
      if (appState.isListening && appState.listeningSource === 'interview') {
        console.log('[realtime]', '🛑 关闭面试弹窗，停止音频捕获');
        await stopListening();
      } else if (appState.isListening && appState.listeningSource === 'test') {
        console.log('[realtime]', 'ℹ️ 关闭面试弹窗，测试模式继续运行（手动停止捕获按钮）');
      }

      // 清空内容
      document.getElementById('overlayInterimText').textContent = '';
      const answerEl = document.getElementById('overlayAnswerText');
      if (answerEl) {
        answerEl.textContent = '';
      }
      document.getElementById('answerLoading').style.display = 'none';
      document.getElementById('answerReady').style.display = 'none';
    });
  }
  
  initOverlayDragResize();
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

// 渲染历史记录
function renderHistory() {
  if (appState.history.length === 0) {
    elements.historyList.innerHTML = '<div style="padding: 20px; text-align: center; color: #999;">暂无历史记录</div>';
    return;
  }
  
  elements.historyList.innerHTML = appState.history.map(item => `
    <div class="history-item" data-id="${item.id}">
      <div class="question">${escapeHtml(item.question.substring(0, 50))}${item.question.length > 50 ? '...' : ''}</div>
      <div class="time">${item.timestamp}</div>
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
          const overlayEl = document.getElementById('overlayInterimText');
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
            const overlayEl = document.getElementById('overlayInterimText');
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

      document.getElementById('answerLoading').style.display = 'block';
      document.getElementById('answerReady').style.display = 'none';

      // 显示答案到弹窗
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
        renderHistory();
      }

      document.getElementById('answerLoading').style.display = 'none';
      document.getElementById('answerReady').style.display = 'block';
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
  const overlay = document.getElementById('interviewOverlay');
  overlay.classList.add('show');

  document.getElementById('answerLoading').style.display = 'none';
  document.getElementById('answerReady').style.display = 'none';

  // 清空之前的内容
  document.getElementById('overlayInterimText').textContent = '';
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

