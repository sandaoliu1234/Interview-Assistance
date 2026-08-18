/**
 * 预加载脚本（Preload）：在主进程与渲染层之间建立安全的 IPC 桥。
 *
 * 设计目标（对应方案 Phase 1）：
 * 1. 通过 contextBridge 暴露 window.electronAPI，渲染层不再直接 require('electron')。
 * 2. 把 ipcRenderer.invoke / ipcRenderer.on 收敛到受控接口，避免暴露原始对象。
 * 3. 本文件与现有 main.js 的 ipcMain.handle 通道一一对应，可平滑迁移渲染层。
 *
 * 说明：当前主窗口仍保留 nodeIntegration:true + contextIsolation:false，
 * 因此渲染层现有的 require('electron') 用法仍可正常工作；本桥作为新入口并行存在，
 * 待渲染层全部改为 window.electronAPI 后即可关闭 nodeIntegration。
 */

const { contextBridge, ipcRenderer } = require('electron');

/**
 * 统一的异步调用封装（对应主进程 ipcMain.handle）。
 * @param {string} channel 通道名
 * @param  {...any} args 参数
 * @returns {Promise<any>} 主进程返回结果
 */
function invoke(channel, ...args) {
  return ipcRenderer.invoke(channel, ...args);
}

/**
 * 统一的事件订阅封装（对应主进程 webContents.send）。
 * @param {string} channel 通道名
 * @param {Function} listener 回调
 */
function on(channel, listener) {
  // 用过滤后的转发，避免渲染层拿到原始 event 对象
  const subscription = (event, ...args) => listener(...args);
  ipcRenderer.on(channel, subscription);
  return () => ipcRenderer.removeListener(channel, subscription);
}

// 暴露给渲染层的安全接口（先赋值给变量，便于 contextBridge + window 兜底双路复用，不重复书写）
const _apiImpl = {
  // ===== 配置 =====
  getConfig: () => invoke('get-config'),
  saveConfig: (cfg) => invoke('save-config', cfg),
  getInterviewConfig: () => invoke('get-interview-config'),
  saveInterviewConfig: (cfg) => invoke('save-interview-config', cfg),

  // ===== 历史 / 会话 =====
  getHistory: () => invoke('get-history'),
  saveHistory: (history) => invoke('save-history', history),
  getRecoveryData: () => invoke('get-recovery-data'),
  restoreSession: (data) => invoke('restore-session', data),
  getStateSummary: () => invoke('get-state-summary'),
  saveState: () => invoke('save-state'),

  // ===== 简历 =====
  selectResumeFile: () => invoke('select-resume-file'),
  saveResume: (content) => invoke('save-resume', content),
  loadResume: () => invoke('load-resume'),
  deleteResume: () => invoke('delete-resume'),
  openFileDialog: (options) => invoke('open-file-dialog', options), // 简历/知识库上传用的通用选择器
  parseResume: (filePath) => invoke('parse-resume', filePath), // 后续阶段实现 PDF/DOCX 解析

  // ===== 窗口 / 快捷键 =====
  getScreenBounds: () => invoke('get-screen-bounds'),
  setAlwaysOnTop: (flag) => invoke('set-always-on-top', flag),
  setOpacity: (opacity) => invoke('set-opacity', opacity),
  resizeWindow: (dir, dx, dy) => invoke('resize-window', dir, dx, dy),
  hideWindow: () => invoke('hide-window'),
  showWindow: () => invoke('show-window'),
  toggleWindow: () => invoke('toggle-window'),
  enterStealthMode: () => invoke('enter-stealth-mode'),
  exitStealthMode: () => invoke('exit-stealth-mode'),
  isInStealthMode: () => invoke('is-in-stealth-mode'),
  // 独立控制「从屏幕捕获排除」（对齐 HireMe applyExcludeFromCapture）
  // 返回 { success, method }，method ∈ exclude_from_capture/content_protection/unsupported
  setExcludeFromCapture: (enabled) => invoke('set-exclude-from-capture', enabled),
  showWindowTemporarily: () => invoke('show-window-temporarily'),
  sendNotification: (title, body) => invoke('send-notification', title, body),

  // ===== 独立答题面板（overlayWindow）=====
  openOverlay: () => invoke('open-overlay'),                  // 创建/显示答题面板
  closeOverlay: () => invoke('close-overlay'),                // 关闭答题面板
  overlayStatus: () => invoke('overlay-status'),              // 查询面板状态（exists/bounds）
  resizeOverlay: (dir, dx, dy) => invoke('resize-overlay', dir, dx, dy), // 8 向缩放面板
  moveOverlay: (direction) => invoke('move-overlay', direction),          // 快捷键平移面板

  // ===== 独立答题面板 → ASR / 答案事件订阅 =====
  onAsrInterim: (cb) => on('asr:interim', cb),                // 临时识别文本
  onAsrFinal: (cb) => on('asr:final', cb),                    // 最终识别文本
  onAnswerStart: (cb) => on('asr:answer-start', cb),          // AI 开始答题（loading 显示）
  onAnswerGenerated: (cb) => on('asr:answer-generated', cb),  // AI 答题完成（写入答案区）
  onRecordingStatus: (cb) => on('asr:recording-status', cb),  // 录制态 true/false
  onWriteFromOutside: (cb) => on('asr:answer-write-from-outside', cb), // 小程序回写答案
  onWriteQuestionFromOutside: (cb) => on('asr:question-write-from-outside', cb), // 外部(H5/小程序/面板截图)写入面试官提问
  onLocalStatusChanged: (cb) => on('local:status-changed', cb), // 本地 HTTP/WS 服务四态变化

  // ===== 音频采集 =====
  getDesktopSources: (opts) => invoke('get-desktop-sources', opts),
  startNativeSystemAudio: () => invoke('start-native-system-audio'),
  stopNativeSystemAudio: () => invoke('stop-native-system-audio'),
  listAudioDevicesNative: () => invoke('list-audio-devices-native'),
  startFallbackCapture: (sourceId) => invoke('start-fallback-capture', sourceId),
  pollFallbackSamples: () => invoke('poll-fallback-samples'),
  stopFallbackCapture: () => invoke('stop-fallback-capture'),

  // ===== ASR（百度兼容通道，后续阶段新增通义/Deepgram） =====
  getBaiduAccessToken: (config) => invoke('get-baidu-access-token', config),
  baiduRecognize: (params) => invoke('baidu-recognize', params),
  speechToText: (audioBuffer, config) => invoke('speech-to-text', audioBuffer, config),

  // ===== 录音 =====
  startRecording: () => invoke('start-recording'),
  stopRecording: () => invoke('stop-recording'),

  // ===== 实时监听 / 问题检测 / AI 答题 =====
  startListening: (sensitivity) => invoke('start-listening', sensitivity),
  addAudioChunk: (chunk) => invoke('add-audio-chunk', chunk),
  stopListening: () => invoke('stop-listening'),
  detectQuestion: (text, sensitivity) => invoke('detect-question', text, sensitivity),
  processRecognizedText: (text, config, history, resume) =>
    invoke('process-recognized-text', text, config, history, resume),
  generateAnswer: (question, config) => invoke('generate-answer', question, config),
  optimizeResume: (text, direction) => invoke('optimize-resume', text, direction), // 简历优化（复用 LLM 引擎）
  generateReview: (history, config) => invoke('generate-review', history, config), // AI 面试复盘
  saveSystemRecording: (sessionId, wav) => invoke('save-system-recording', sessionId, wav), // 系统音频存档
  listSessions: () => invoke('list-sessions'), // 列出会话档案
  screenshotSolve: (imageDataUrl, config, resume, kb) => invoke('screenshot-solve', imageDataUrl, config, resume, kb), // 截图解题
  screenshotScreen: () => invoke('screenshot-screen'), // 截取主屏全屏
  startRelayServer: (port) => invoke('start-relay-server', port), // 启动伴生中继
  stopRelayServer: () => invoke('stop-relay-server'), // 停止伴生中继
  relayServerStatus: () => invoke('relay-server-status'), // 中继状态
  relayBroadcast: (payload) => invoke('relay-broadcast', payload), // 广播给伴生设备

  // ===== 隐私审计 =====
  getPrivacySummary: () => invoke('get-privacy-summary'),
  getPrivacyLogs: (limit) => invoke('get-privacy-logs', limit),
  exportPrivacyReport: () => invoke('export-privacy-report'),
  clearPrivacyAudit: () => invoke('clear-privacy-audit'),
  detectSensitiveInfo: (text) => invoke('detect-sensitive-info', text),

  // ===== 小程序二维码 + 本地 HTTP/WS 服务 =====
  generateQR: () => invoke('generate-qr'),                     // 启动本地服务 + 返回二维码图 (dataUrl) + ip/port/token
  startLocalServer: (port) => invoke('start-local-server', port),    // 启动本地服务（指定端口，可空）
  stopLocalServer: () => invoke('stop-local-server'),          // 停止本地服务
  getServerStatus: () => invoke('get-server-status'),          // 查当前连接状态 (idle/listening/connected/disconnected) + IPs/port/token
  disconnectMiniapp: () => invoke('disconnect-miniapp'),       // 主动断开当前小程序连接

  // ===== 事件订阅（主进程主动推送） =====
  onMainLog: (cb) => on('main-log', cb),
  onStealthModeChanged: (cb) => on('stealth-mode-changed', cb),
  onStealthTempReveal: (cb) => on('stealth-temp-reveal', cb),
  onNativeAudioData: (cb) => on('native-audio-data', cb),
  onNativeAudioError: (cb) => on('native-audio-error', cb),
  onNativeAudioMetadata: (cb) => on('native-audio-metadata', cb),
  onCheckRecovery: (cb) => on('check-recovery', cb)
};

// ① 标准方式：contextBridge.exposeInMainWorld（仅 contextIsolation=true 时生效，Electron 安全推荐路径）
contextBridge.exposeInMainWorld('electronAPI', _apiImpl);

// ② 兜底方式：直接挂 window（仅 contextIsolation=false 时生效）
// 说明：contextIsolation=true 时，preload 的 window 与渲染层 window 是隔离的，此处赋值无效；
// contextIsolation=false 时，contextBridge 不挂对象，此处手动挂载，确保渲染层 window.electronAPI 必定存在。
// 双保险避免了「contextIsolation 开关不一致 → overlay-renderer 走 stub 返回 not electron」的错误。
try {
  if (typeof window !== 'undefined' && !window.electronAPI) {
    window.electronAPI = _apiImpl;
  }
} catch (e) {
  console.warn('[preload] window.electronAPI 兜底挂载失败（非致命）：', e.message);
}
