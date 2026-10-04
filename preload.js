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

// ------------------------------------------------------------
// ★ preload 执行探针（排障专用）：立刻通过 ipc 单向通知主进程"preload.js 已执行"
//   说明：用于判断『为什么 hasElectronAPI=false？是 preload 根本没执行 vs 执行了但挂载失败』
//   主进程在 main.js 中 ipcMain.once('preload-executed', ...) 注册一次性监听器打印详细状态
// ------------------------------------------------------------
try {
  const probe = {
    ts: Date.now(),
    hasContextBridge: !!contextBridge,
    hasIpcRenderer: !!ipcRenderer,
    typeofWindow: typeof window,
    typeofProcess: typeof process,
    processType: (typeof process !== 'undefined' && process && process.type) ? String(process.type) : '(unknown)',
    contextIsolated: (typeof process !== 'undefined' && process && typeof process.contextIsolated === 'boolean') ? process.contextIsolated : null,
    electronAPIBefore: typeof window !== 'undefined' ? !!window.electronAPI : null,
    preloadScriptLocation: (typeof __filename !== 'undefined') ? String(__filename) : '(unknown)'
  };
  ipcRenderer.send('preload-executed', probe);
} catch (_probeErr) {
  // 探针本身绝对不能影响 preload 剩余逻辑
  try { console.warn('[preload] 执行探针发送失败（非致命）：', _probeErr && _probeErr.message); } catch (_) {}
}

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
  // 独立控制「从屏幕捕获排除」（对齐参考实现 applyExcludeFromCapture）
  // 返回 { success, method }，method ∈ exclude_from_capture/content_protection/unsupported
  setExcludeFromCapture: (enabled) => invoke('set-exclude-from-capture', enabled),
  // ★ 截图/录屏「不可见」总开关：实时切换对全部窗口的捕获排除。
  //   返回 { success, total, ok, method }
  setCaptureHide: (enabled) => invoke('set-capture-hide', enabled),
  showWindowTemporarily: () => invoke('show-window-temporarily'),
  sendNotification: (title, body) => invoke('send-notification', title, body),

  // ===== 独立答题面板（overlayWindow）=====
  openOverlay: () => invoke('open-overlay'),                  // 创建/显示答题面板
  closeOverlay: () => invoke('close-overlay'),                // 关闭答题面板
  overlayStatus: () => invoke('overlay-status'),              // 查询面板窗口状态（exists/bounds）
  resizeOverlay: (dir, dx, dy) => invoke('resize-overlay', dir, dx, dy), // 8 向缩放面板
  moveOverlay: (direction) => invoke('move-overlay', direction),          // 快捷键平移面板
  // ⭐ 面板端(H5/小程序/ASR 等外部入口)产生的最新状态快照(含多轮历史 history[]+historyVersion)
  //    结构对齐 /api/overlay/status 的 flat JSON：{ ok:true, asrText, answerText, questionImage, isRecording, lastAnswerAt, history:[], historyVersion }
  //    为什么需要单独 IPC？overlay.html 用 loadFile(file://) 加载，fetch('/api/overlay/status') 相对路径会解析到 file:///api/...，永远拿不到 HTTP 响应
  fetchOverlayState: () => invoke('overlay-full-status'),

  // ===== 模拟面试浮动面板（mockInterviewFloatWindow）=====
  //   语义：主窗口点击『开始模拟面试』→ openMockInterviewFloatWin(params) 打开浮窗；整个面试在浮窗内完成。
  openMockInterviewFloatWin: (params) => invoke('open-mock-interview-floatwin', params || {}), // 创建/显示浮窗，并下发 params
  closeMockInterviewFloatWin: () => invoke('close-mock-interview-floatwin'),                    // 关闭浮窗
  mockInterviewFloatStatus: () => invoke('mock-interview-floatwin-status'),                     // 查询浮窗状态（exists/bounds）
  // 事件：主进程 did-finish-load 后，把『启动参数』推给浮窗渲染层（含 answerMode、总题数、serverInfo 等）
  onMockInterviewStartParams: (cb) => on('mock-interview:start-params', cb),

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
  listSessions: () => invoke('list-sessions'), // 列出会话档案（旧语义：transcript/wav/review，不要与面试记录 interviewSession* 混用）

  // ===== 面试 Session（面试记录）专用：主窗口底部 3 按钮 / 列表页 / 详情页 / 侧栏 round 卡片跳转 =====
  //   每条 IPC 对应 main.js 里同名前缀 interview-session-* 的 handle；所有通道在第一次调用时会自动启动 localHttpServer 并初始化 sessions 目录
  interviewSessionList: (opts) => invoke('interview-session-list', opts || {}),                         // 列表（摘要）
  interviewSessionGet: (id)   => invoke('interview-session-get', id),                                   // 详情（含完整 rounds）
  interviewSessionStartNew: (cfg) => invoke('interview-session-start-new', cfg),                        // 🆕 开始新的一场面试（cfg 可传 targetCompany/Position 等快照，可空）
  interviewSessionEndActive: () => invoke('interview-session-end-active'),                              // ⏹ 结束当前场
  interviewSessionFindByRound: (roundId) => invoke('interview-session-find-by-round', roundId),        // 侧栏 round 卡片 → 定位属于哪场 session
  // 切场边界：如果上一场被用户显式× 结束（答题面板右上角×）→ 强制开新一场（保证"开始面试辅助"或"重新打开答题面板"不会落到刚结束的那场）
  ensureSessionIfEnded: (cfg) => invoke('interview-session-ensure-if-ended', cfg || undefined),
  // 别名：与 copilot.js 内部 api 对象的命名对齐（兼容直接 window.electronAPI.xxx 调用）
  getSessionDetail: (id) => invoke('interview-session-get', id),
  endActiveSession: () => invoke('interview-session-end-active'),
  findSessionByRound: (roundId) => invoke('interview-session-find-by-round', roundId),
  // 面试事件：main → renderer 单向广播（on 模式，不用 invoke）
  //   - overlay:closed-post-session：用户点浮动答题面板右上角× → 结束本场 + 主窗口弹出两按钮 banner（查看本场/开启新面试）
  onOverlayClosedPostSession: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const handler = (_evt, payload) => { try { cb(payload); } catch (e) { console.error('[preload][overlay:closed-post-session] cb 异常:', e && e.message); } };
    ipcRenderer.on('overlay:closed-post-session', handler);
    return () => { try { ipcRenderer.off('overlay:closed-post-session', handler); } catch (_) {} };
  },

  screenshotSolve: (imageDataUrl, config, resume, kb) => invoke('screenshot-solve', imageDataUrl, config, resume, kb), // 截图解题
  screenshotScreen: () => invoke('screenshot-screen'), // 截取主屏全屏
  startRelayServer: (port) => invoke('start-relay-server', port), // 启动伴生中继
  stopRelayServer: () => invoke('stop-relay-server'), // 停止伴生中继
  relayServerStatus: () => invoke('relay-server-status'), // 中继状态

  // ===== 面板端独立启停 ASR（新版 ASRPipeline 通道路由） =====
  // ★ 面试辅助 2.0 主通道（WASAPI Loopback 原生采集 + 百度实时 ASR WS + AI 答题）
  //   面板端按钮"开始/停止识别"直接调用 toggleAsrPipeline，不需要回主窗口
  startAsrPipeline: (config) => invoke('start-asr-pipeline', config),
  stopAsrPipeline: () => invoke('stop-asr-pipeline'),
  asrPipelineStatus: () => invoke('asr-pipeline-status'),
  // ★ 面板端专用：一键切换识别状态（推荐面板端直接用这个，返回 { success, action:'started'|'stopped', isRecording, needMainConfig?, error }）
  toggleAsrPipeline: () => invoke('toggle-asr-pipeline'),
  // 面板端专用：查"当前是否识别中 + 是否有可复用配置缓存"
  getAsrStatus: () => invoke('get-asr-status'),
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
  /**
   * ★ 补：获取本地 HTTP 服务扁平状态（推荐，用于所有 HTTP 客户端）
   *   返回 { ok, port, token, baseUrl, isRunning }，层级稳定无嵌套，serverInfo 直接可用
   */
  getHttpInfo: () => invoke('get-server-http-info'),
  /**
   * ★ 补：HTTP 代理通道（主进程 Node.js 代发请求，绕开 Chromium 同源/CSP 对 file:// 页面 fetch http:// 的拦截）
   *   请求：{ url, method, headers, body, timeoutMs } → 返回 { ok, status, data, rawText, errorMsg, elapsedMs }
   */
  httpProxy: (req) => invoke('mock-interview:http-proxy', req || {}),
  /**
   * ★ 补：模拟面试浮窗启动完成后，单向通知主进程取消补发定时器（无需回值）
   */
  notifyStartedAck: () => { try { ipcRenderer.send('mock-interview:started-ack'); return true; } catch (_) { return false; } },
  disconnectMiniapp: () => invoke('disconnect-miniapp'),       // 主动断开当前小程序连接

  // ===== 事件订阅（主进程主动推送） =====
  onMainLog: (cb) => on('main-log', cb),
  onStealthModeChanged: (cb) => on('stealth-mode-changed', cb),
  onStealthTempReveal: (cb) => on('stealth-temp-reveal', cb),
  onNativeAudioData: (cb) => on('native-audio-data', cb),
  onNativeAudioError: (cb) => on('native-audio-error', cb),
  onNativeAudioMetadata: (cb) => on('native-audio-metadata', cb),
  onCheckRecovery: (cb) => on('check-recovery', cb),

  // ============================================================
  // ★ 账号鉴权：auth-* 共 11 条 IPC（对应 main.js auth-create-account / auth-merge-guest-to-current 等）
  //   渲染层永远拿不到明文密码、哈希值或 token。
  // ============================================================
  auth: {
    /** 当前登录用户（未登录返回 {loggedIn:false, accountId:'__guest__'}） */
    currentUser: () => invoke('auth-current-user'),
    /** 是否已创建任何本地账号（用于冷启动切换到初始化面板） */
    hasAnyAccount: () => invoke('auth-has-any-account'),
    /**
     * 创建账号（仅限 hasAnyAccount===false 时成功；否则返回 DEAD_END 错误）。
     * 用于冷启动"创建第一个本地超级管理员"。
     */
    createAccount: (payload) => invoke('auth-create-account', payload || {}),
    /** 邮箱 + 密码 → 登录，返回 { ok, user:{loggedIn, accountId, email, displayName, ...} } */
    login: (payload) => invoke('auth-login', payload || {}),
    /** 退出登录 → 返回新的 currentUser（游客态） */
    logout: () => invoke('auth-logout'),
    /** 忘记密码步骤 1：邮箱 → 返回重置码（桌面端本地显示，不发邮件） */
    forgotStep1: (payload) => invoke('auth-forgot-step1', payload || {}),
    /** 忘记密码步骤 2：邮箱 + 重置码 + 新密码 → 成功 ok:true */
    forgotStep2Reset: (payload) => invoke('auth-forgot-step2-reset', payload || {}),
    /** 已登录用户修改密码：需提供旧密码 */
    changePassword: (payload) => invoke('auth-change-password', payload || {}),
    /** 修改昵称 / 头像 */
    updateProfile: (patch) => invoke('auth-update-profile', patch || {}),
    /** 获取指定账号完整资料（不传则取当前登录账号） */
    getAccount: (accountId) => invoke('auth-get-account', accountId || null),
    /**
     * 🟢 【已废弃】把游客(__guest__)的 session/resume 合并到当前登录账号。
     *   —— 需求变更：不再执行合并；登录后直接读取 SQLite 中 ia_sessions.account_id
     *      = 当前登录账号 的记录，GUEST 命名空间下的数据保持独立（登出回到游客
     *      模式时仍可见）。
     *   —— 本函数保留兼容返回：{ok:true, stats:{sessionMerged:0, resumeMerged:false,...}}，
     *      不会搬运或删除任何数据。
     */
    mergeGuestToCurrent: () => invoke('auth-merge-guest-to-current'),
    /**
     * 登录态变更事件：登录/登出/初始化完成/修改资料后主进程广播。
     * cb 接收 user 对象（形态与 currentUser() 返回一致）。
     * @returns {() => void} 取消订阅函数
     */
    onAuthStateChanged: (cb) => on('auth-state-change', cb),
  },

  // ============================================================
  // ★ 积分消费 & 宣传页控制台联动：credits-* 5 条 IPC 封装
  //   远端登录态 → 直接请求 landing server 原子双写；离线/本地 → fallback 标记 offline=true
  // ============================================================
  credits: {
    /** 宣传站点服务端状态：{ landingBaseUrl, remoteConnected, remoteExpireAt } */
    getServerInfo: () => invoke('credits-get-server-info'),
    /** 查询积分余额（远端登录返回实时 balance；离线返回 offline=true）*/
    getBalance:    () => invoke('credits-get-balance'),
    /**
     * 扣积分（每次 Copilot 面试场 / 模拟面试 1 轮 / 简历优化都先调本方法）
     * @param {object} p       { credits: number, bizType: 'copilot_session'|'mock_round'|'resume_optimize', bizId?: string, desc?: string }
     * @returns {Promise<any>} { ok, offline?, creditsConsumed?, balance?, flowId?, msg?, current?, required?, missing? }
     */
    consume: (p) => invoke('credits-consume', p || {}),
    /** 打开系统浏览器 → 宣传站点控制台（充值 / 看流水 / 看订单） */
    openConsole: () => invoke('credits-open-console'),
    /** （管理员）打开系统浏览器 → 宣传站点后台管理页 */
    openAdmin:   () => invoke('credits-open-admin'),
  },
};

// ① 标准方式：contextBridge.exposeInMainWorld（仅 contextIsolation=true 时可用）
// ★★★ 关键修复：必须 try/catch 保护！
//   原因：当 BrowserWindow 配置 contextIsolation=false（本应用主窗口/浮窗均为 false）时，
//   contextBridge.exposeInMainWorld 会直接抛出
//   "Error: contextBridge API can only be used when contextIsolation is enabled"，
//   这个未捕获异常会导致：
//     1) Electron 报 "Unable to load preload script"（preload 被判定加载失败）
//     2) 异常之后的代码【全部不再执行】——包括下方 ② 的 window.electronAPI 兜底挂载！
//   这正是此前所有窗口 hasElectronAPI=false 的真正根因（渲染层只能走 require('electron') 兜底路径）。
try {
  contextBridge.exposeInMainWorld('electronAPI', _apiImpl);
} catch (_bridgeErr) {
  // contextIsolation=false 时 contextBridge 不可用是预期内的，走 ② window 直挂兜底，不算错误
  try { console.warn('[preload] contextBridge 挂载跳过（contextIsolation=false 时不支持，改走 window 直挂兜底）：', _bridgeErr && _bridgeErr.message); } catch (_) {}
}

// ② 兜底方式：直接挂 window（仅 contextIsolation=false 时生效）
// 说明：contextIsolation=false 时，preload 与渲染层共享同一个 JS 上下文（main world），
// 此处赋值渲染层 window.electronAPI 立即可见。现在 ① 已被 try/catch 保护，
// 这里的兜底挂载终于能可靠执行到（此前被 ① 的未捕获异常短路，永远跑不到）。
try {
  if (typeof window !== 'undefined' && !window.electronAPI) {
    window.electronAPI = _apiImpl;
  }
} catch (e) {
  console.warn('[preload] window.electronAPI 兜底挂载失败（非致命）：', e.message);
}
