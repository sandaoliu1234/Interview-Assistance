const { app, BrowserWindow, ipcMain, Tray, Menu, globalShortcut, desktopCapturer, session, Notification, screen } = require('electron');
// 环境变量加载（必须在最前面，保证后续模块的 process.env 已就绪）
// 加载顺序：1) 系统环境变量  2) 项目根目录 .env 文件（dotenv 不会覆盖已有系统环境变量）
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const os = require('os');
const iconv = require('iconv-lite');
// ===== Node.js 原生事件总线：主进程内各模块（ASR/HTTP/WS/Overlay）解耦通信 =====
// 事件列表（集中在 app.bus 上，新增事件请在此注释说明）：
//   - 'asr:interim'(text)            ASR 临时文本
//   - 'asr:final'(text)              ASR 最终文本
//   - 'asr:answer-start'(question)   AI 答题开始（用于面板显示 loading）
//   - 'asr:answer-generated'(text)   AI 答题完成（写入 overlay 答案区 + 推小程序）
//   - 'asr:recording-status'(bool)   识别态（true=正在识别 / false=暂停）
//   - 'asr:error'(message)           ASR 错误
//   - 'local:status-changed'(obj)    本地 HTTP/WS 服务状态变化（四态）
//   - 'local:write-answer-from-outside'(text)   小程序侧回写答案 → 转发给 overlay
const { EventEmitter } = require('events');
if (!app.bus) {
  app.bus = new EventEmitter();
  app.bus.setMaxListeners(50);     // 每个 listener 都算，默认 10 太小
  console.log('[app.bus] 事件总线初始化完成');
}
const speechService = require('./services/speechService');
const aiService = require('./services/aiService');
const audioService = require('./services/audioService');
const StateManager = require('./services/stateManager');
const PrivacyAudit = require('./services/privacyAudit');
// ASR 管线：WASAPI 系统音频 → 百度 ASR → 问题检测 → AI 答题（主进程原生采集，不依赖渲染层）
const ASRPipeline = require('./services/asrPipeline');
let asrPipeline = null; // 管线单例，启动面试辅助时创建
// ★ 缓存"最后一次成功启动 ASR 使用的 config"，供面板端 toggle-asr-pipeline 直接复用，
//   否则面板端拿不到主窗口保存的百度 API Key / 模型 / 简历 / 场景等完整 config，
//   就无法独立完成"开始识别"动作（只能停止）。
let lastAsrConfig = null;
// 配置与本地持久化管理器（替代散落的 config/history 读写，密钥不再写死在代码里）
const ConfigManager = require('./src/main/config-manager');
// 系统级窗口捕获排除（对齐 HireMe 发行版 applyExcludeFromCapture，用 koffi 调 Win32 API）
const captureExclusion = require('./src/main/capture-exclusion');
// 本地伴生设备中继服务（http + SSE + WebSocket，对齐 HireMe localServer/relay）
const relayServer = require('./src/main/relay-server');
// 小程序联动：本地 HTTP + WebSocket 服务（WS + HTTP，支持截图/答案回写/ASR推送）
const localHttpServer = require('./services/localHttpServer');
// 二维码生成：把 payload JSON 转成 dataUrl，供 overlay 弹窗 <img> 渲染
let qrcodeLib = null;
try { qrcodeLib = require('qrcode'); } catch (e) {
  console.warn('[main] qrcode 模块未安装，二维码功能不可用:', e.message);
}

// 启用 Chromium 实验特性：渲染层 FaceDetector API（gaze 视线检测降级方案需要）
// 必须在 app.ready 之前调用
try {
  app.commandLine.appendSwitch('enable-experimental-web-platform-features');
  app.commandLine.appendSwitch('enable-features', 'ExperimentalWebPlatformFeatures');

  // === 解决 Windows 下部分环境 GPU 缓存目录无写权限（错误码 0x5：拒绝访问） ===
  // 报错表现：
  //   ERROR:cache_util_win.cc Unable to move the cache: 拒绝访问 (0x5)
  //   ERROR:disk_cache.cc Unable to create cache
  //   ERROR:gpu_disk_cache.cc Gpu Cache Creation failed: -2
  // 影响：纯告警级错误，不影响 GPU 运算与 MediaPipe 推理，但刷屏干扰日志。
  // 处理：关闭 Chromium 所有磁盘缓存（GPU/Shader/HTTP/Media 全关），强制内存缓存。
  app.commandLine.appendSwitch('disable-gpu-cache');
  app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
  app.commandLine.appendSwitch('disable-http-cache');
  app.commandLine.appendSwitch('media-cache-size', '0');
  // 把磁盘缓存目录明确指向 userData 下的可写位置（兜底措施）
  const cacheDir = path.join(app.getPath('userData'), 'chromium-cache');
  try { fs.mkdirSync(cacheDir, { recursive: true }); } catch (_) { /* 忽略 */ }
  app.commandLine.appendSwitch('disk-cache-dir', cacheDir);
  app.commandLine.appendSwitch('gpu-cache-dir', cacheDir);
} catch (_) { /* 极少数情况下 app 尚未初始化，忽略 */ }

// 保存原始 console 方法
const _origConsoleLog = console.log;
const _origConsoleWarn = console.warn;
const _origConsoleError = console.error;

// Windows PowerShell 默认代码页是 GBK(936)，直接输出 UTF-8 会乱码
// 使用 iconv-lite 将中文日志转换为 GBK 编码后输出
const isWindowsGBK = process.platform === 'win32';

function gbkLog(args, stream = process.stdout) {
  try {
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      let output;

      if (typeof arg === 'string') {
        output = isWindowsGBK ? iconv.encode(arg, 'gbk') : arg;
      } else if (Buffer.isBuffer(arg)) {
        output = arg;
      } else {
        output = String(arg);
        if (isWindowsGBK) {
          output = iconv.encode(output, 'gbk');
        }
      }

      stream.write(output);
      if (i < args.length - 1) {
        stream.write(' ');
      }
    }
    stream.write('\n');
  } catch (e) {
    // 降级处理：直接用原始方法
    if (Array.isArray(args)) {
      _origConsoleLog(...args);
    } else {
      _origConsoleLog(args);
    }
  }
}

// ============================================================
// 控制台日志编码处理（Windows GBK 兼容）
// ============================================================

console.log   = (...a) => gbkLog(a, process.stdout);
console.warn  = (...a) => gbkLog(a, process.stderr);
console.error = (...a) => gbkLog(a, process.stderr);
let nativeAudio = null;
async function loadNativeAudio() {
  if (nativeAudio) return nativeAudio;
  try {
    nativeAudio = await import('native-audio-node');
    console.log('[native-audio] 模块加载成功');
    return nativeAudio;
  } catch (e) {
    console.error('[native-audio] 加载失败:', e.message);
    throw e;
  }
}

let mainWindow;
let overlayWindow;   // ★ 独立答题面板 BrowserWindow（可跨屏，alwaysOnTop）
let tray;
let isWindowVisible = true;
let isStealthMode = false;

// 用户数据存储路径
const userDataPath = path.join(app.getPath('userData'), 'interview-assistant');
if (!fs.existsSync(userDataPath)) {
  fs.mkdirSync(userDataPath, { recursive: true });
}

// 初始化状态管理器
const stateManager = new StateManager(userDataPath);

// 初始化隐私审计
const privacyAudit = new PrivacyAudit(userDataPath);

// 配置与本地持久化管理器（替代原先散落的 config/history 读写）。
// 默认配置由 interview-config.js 提供，密钥字段一律为空，需用户填写或运行时注入。
const configManager = new ConfigManager(userDataPath);

// 加载配置（迁移到统一模型，且不继承任何硬编码密钥）
function loadConfig() {
  return configManager.loadConfig();
}

// 保存配置
function saveConfig(config) {
  configManager.saveConfig(config);
}

// 加载历史记录
function loadHistory() {
  return configManager.loadHistory();
}

// 保存历史记录
function saveHistory(history) {
  configManager.saveHistory(history);
}

// 创建系统托盘
function createTray() {
  const trayIconPath = path.join(__dirname, 'assets', 'tray-icon.png');
  let iconPath = trayIconPath;
  
  if (!fs.existsSync(trayIconPath)) {
    iconPath = path.join(__dirname, 'assets', 'icon.png');
    if (!fs.existsSync(iconPath)) {
      // 项目中无图标文件，使用 Electron 内置 nativeImage 创建默认占位图标
      try {
        const { nativeImage } = require('electron');
        const emptyPng = Buffer.from(
          '89504E470D0A1A0A0000000D49484452000000100000001008060000001FF3FF610000001A49444154789CEDC1010D000000C220FBA77C0D9F0000000000000000000000000000000000000000000000000000000000E8F600010001300E47A80000000049454E44AE426082',
          'hex'
        );
        iconPath = nativeImage.createFromBuffer(emptyPng);
      } catch (e) {
        iconPath = null;
      }
    }
  }
  
  if (!iconPath) {
    console.warn('无法创建托盘图标，托盘功能被禁用');
    tray = null;
    return;
  }
  
  try {
    tray = new Tray(iconPath);
  } catch (e) {
    console.error('创建系统托盘失败:', e);
    tray = null;
    return;
  }
  
  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示/隐藏 (Ctrl+Shift+H)',
      click: toggleWindowVisibility
    },
    {
      label: isStealthMode ? '退出隐身模式' : '进入隐身模式',
      click: toggleStealthMode
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        app.quit();
      }
    }
  ]);
  
  tray.setToolTip('面试助手 - 点击显示/隐藏');
  tray.setContextMenu(contextMenu);
  
  tray.on('click', () => {
    toggleWindowVisibility();
  });
}

// 切换窗口可见性
function toggleWindowVisibility() {
  if (!mainWindow) return;
  
  if (isWindowVisible) {
    mainWindow.hide();
    isWindowVisible = false;
  } else {
    mainWindow.show();
    mainWindow.focus();
    isWindowVisible = true;
  }
  updateTrayMenu();
}

// 切换隐身模式
function toggleStealthMode() {
  isStealthMode = !isStealthMode;

  if (mainWindow) {
    if (isStealthMode) {
      // 隐身模式：不再用 setIgnoreMouseEvents（会让 webkit-app-region 失效）
      // 改用 CSS pointer-events: none，让大部分 UI 透明穿透底层应用
      // 但保留一个拖动手柄 (stealth-drag-handle) 可交互
      mainWindow.setSkipTaskbar(true);
      // ★ 系统级捕获排除（对齐 HireMe）：窗口从录屏/截图/屏幕共享中排除，本地仍可见
      captureExclusion.applyCaptureExclusion(mainWindow, true);
      // 通知渲染层切换 class
      mainWindow.webContents.send('stealth-mode-changed', true);
      showNotification('面试助手', '已进入隐身模式（窗口已从屏幕捕获排除）');
    } else {
      // 退出隐身模式：恢复鼠标交互
      mainWindow.setIgnoreMouseEvents(false);
      mainWindow.setSkipTaskbar(false);
      // ★ 恢复正常屏幕捕获
      captureExclusion.applyCaptureExclusion(mainWindow, false);
      mainWindow.webContents.send('stealth-mode-changed', false);
      showNotification('面试助手', '已退出隐身模式');
    }
  }
  updateTrayMenu();
}

// 发送桌面通知
function showNotification(title, body) {
  try {
    if (Notification.isSupported()) {
      const notification = new Notification({
        title: title,
        body: body,
        silent: true
      });
      notification.show();
    }
  } catch (e) {
    // Notification API 不可用，忽略
    console.log('[showNotification] 跳过通知:', e.message);
  }
}

// 临时显示窗口（高透明度）
function showWindowTemporarily() {
  if (mainWindow && isStealthMode) {
    // 不再操作 setIgnoreMouseEvents
    // 改由 CSS class (stealth-temp-reveal) 控制 pointer-events
    mainWindow.webContents.send('stealth-temp-reveal', true);
    // 3秒后恢复隐身模式
    setTimeout(() => {
      if (isStealthMode && mainWindow) {
        mainWindow.webContents.send('stealth-temp-reveal', false);
      }
    }, 3000);
  }
}

// 平移窗口（隐身模式下也能用，避免鼠标穿透时无法拖动）
// direction: 'up' | 'down' | 'left' | 'right'
function moveWindow(direction) {
  if (!mainWindow) return;

  const step = 30; // 每次按键平移的像素数
  const [x, y] = mainWindow.getPosition();
  const [width, height] = mainWindow.getSize();
  const { screen } = require('electron');
  const display = screen.getDisplayNearestPoint({ x, y });
  const { width: sw, height: sh } = display.workArea;

  let newX = x, newY = y;
  switch (direction) {
    case 'up':    newY = Math.max(display.workArea.y, y - step); break;
    case 'down':  newY = Math.min(display.workArea.y + sh - height, y + step); break;
    case 'left':  newX = Math.max(display.workArea.x, x - step); break;
    case 'right': newX = Math.min(display.workArea.x + sw - width, x + step); break;
  }

  mainWindow.setPosition(newX, newY);
}

// 更新托盘菜单
function updateTrayMenu() {
  if (!tray) return;
  
  const contextMenu = Menu.buildFromTemplate([
    {
      label: isWindowVisible ? '隐藏窗口 (Ctrl+Shift+H)' : '显示窗口 (Ctrl+Shift+H)',
      click: toggleWindowVisibility
    },
    {
      label: isStealthMode ? '退出隐身模式' : '进入隐身模式',
      click: toggleStealthMode
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        app.quit();
      }
    }
  ]);
  
  tray.setContextMenu(contextMenu);
}

// 注册全局快捷键
function registerGlobalShortcuts(config) {
  const hotkey = config.hotkey || 'CommandOrControl+Shift+H';
  const tempShowHotkey = 'CommandOrControl+Shift+Space';  // 临时显示窗口的快捷键

  // 先取消注册之前的快捷键
  globalShortcut.unregisterAll();

  try {
    // 隐藏/显示窗口的快捷键
    globalShortcut.register(hotkey, () => {
      toggleWindowVisibility();
    });
    console.log(`快捷键已注册: ${hotkey}`);

    // 临时显示窗口的快捷键（3秒）
    globalShortcut.register(tempShowHotkey, () => {
      if (isStealthMode) {
        showWindowTemporarily();
      }
    });
    console.log(`临时显示快捷键已注册: ${tempShowHotkey}`);

    // 平移窗口的快捷键（隐身模式下也能用）
    // 步进 30px，自动吸附屏幕边界，支持多显示器
    // 注意：避免用 Ctrl+Alt+方向键（Windows 显卡驱动保留用于旋转屏幕）
    const moveHotkeys = [
      { accelerator: 'Alt+Shift+Up',    direction: 'up'    },
      { accelerator: 'Alt+Shift+Down',  direction: 'down'  },
      { accelerator: 'Alt+Shift+Left',  direction: 'left'  },
      { accelerator: 'Alt+Shift+Right', direction: 'right' }
    ];
    moveHotkeys.forEach(({ accelerator, direction }) => {
      const ok = globalShortcut.register(accelerator, () => moveWindow(direction));
      console.log(`平移快捷键 ${accelerator}: ${ok ? 'OK' : '失败（可能冲突）'}`);
    });
    console.log('平移窗口快捷键已注册: Alt+Shift+方向键');

    // Esc 键退出隐身模式（隐身模式下用户的主要退出入口）
    const escOk = globalShortcut.register('Escape', () => {
      if (isStealthMode) {
        toggleStealthMode();
      }
    });
    console.log(`Esc 退出隐身: ${escOk ? 'OK' : '失败（可能被其他程序占用）'}`);
  } catch (error) {
    console.error('快捷键注册失败:', error);
  }
}

function createWindow() {
  const config = loadConfig();
  
  mainWindow = new BrowserWindow({
    width: config.windowWidth || 524,    // 默认窗口宽度：524px
    height: config.windowHeight || 874,   // 默认窗口高度：874px
    minWidth: 300,
    minHeight: 400,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: true,
    alwaysOnTop: config.alwaysOnTop,
    skipTaskbar: true,                      // 共享屏幕时不显示在任务栏，保持隐蔽
    hasShadow: false,
    webPreferences: {
      // 安全桥：渲染层可通过 window.electronAPI 调用主进程能力，
      // 后续把渲染层改为 window.electronAPI 后即可关闭 nodeIntegration。
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: true
    },
    icon: path.join(__dirname, 'assets', 'icon.png')
  });

  mainWindow.loadFile('index.html');

  // 强制应用启动窗口尺寸为 524×874（忽略 config.json 中上次保存的尺寸）
  mainWindow.setSize(524, 874);

  // 开发模式下打开开发者工具
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  
  mainWindow.on('resize', () => {
    const [width, height] = mainWindow.getSize();
    const config = loadConfig();
    config.windowWidth = width;
    config.windowHeight = height;
    saveConfig(config);
  });
}

app.whenReady().then(() => {
  // 加载保存的状态
  stateManager.load();

  // 检查是否有未完成的会话
  const recoveryData = stateManager.getRecoveryData();
  if (recoveryData.hasUnfinished) {
    const duration = recoveryData.session.endTime
      ? Date.now() - recoveryData.session.startTime
      : Date.now() - recoveryData.session.startTime;
    console.log('[app] 检测到未完成会话，时长:', Math.floor(duration / 60000), '分钟');

    // 通知渲染进程（如果窗口已创建）
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('check-recovery', recoveryData);
      }
    }, 1000);
  }

  // 启动自动保存（30秒间隔）
  stateManager.startAutoSave(30000);

  // 注册 display media handler（解决 renderer 调 getDisplayMedia 抛 "Not supported"）
  // 拦截后我们自己弹一个应用内选择器，用户选完把 source 返回给 getDisplayMedia
  setupDisplayMediaHandler();

  createWindow();
  createTray();

  // ===== 关键修复：提前挂载 localHttpServer 的外部依赖（loadConfigFn / captureFn）=====
  //   问题背景：用户点「面板截图→AI解题」时，还没生成二维码（localHttpServer 未启动），
  //            若此时 attachLocalHttpServerExternals() 未执行，会导致 localHttpServer.loadConfigFn
  //            为 undefined，_autoSolveScreenshotAndSync 拿到的 cfg 是空对象，造成 tongyiApiKey 为空报错。
  //   方案：应用窗口创建完成后立即 attach（该函数内部是幂等的，重复调用安全）。
  try {
    attachLocalHttpServerExternals();
    console.log('[app] localHttpServer externals 已提前挂载（loadConfigFn / captureFn 就绪）');
  } catch (e) {
    console.warn('[app] localHttpServer externals 预挂载失败（不致命，后续启动服务时会重试）:', e && e.message);
  }

  const config = loadConfig();
  registerGlobalShortcuts(config);
});

// ============================================================
// 系统声音捕获：getDisplayMedia 拦截 + 应用内源选择器
// 同时输出到主进程 console 和 渲染层的日志面板（🐛 按钮）
// ============================================================

function mainLog(level, ...args) {
  // 1) 输出到主进程 console（已自动转码）
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(...args);

  // 2) 转发到渲染层（如果窗口已就绪）
  try {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
      mainWindow.webContents.send('main-log', level, ...args);
    }
  } catch (_) { /* 忽略发送失败 */ }
}

let pickerWindow = null;
let pendingPickerResolve = null;
let pendingPickerSources = [];

function setupDisplayMediaHandler() {
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      console.log('[display-media] getDisplayMedia 被调用');
      const sources = await desktopCapturer.getSources({
        types: ['window', 'screen'],
        fetchWindowIcons: false
      });
      console.log(`[display-media] 找到 ${sources.length} 个源`);

      if (sources.length === 0) {
        callback({});
        return;
      }
      // 只有一个源时直接用，免去用户操作
      if (sources.length === 1) {
        // ★ 关键：audio: 'loopback' 让 getDisplayMedia 走系统音频回环捕获
        // 如果只传 video，会拿到一个无声音的 stream（这是之前没声音的根因）
        callback({ video: sources[0], audio: 'loopback' });
        return;
      }
      // 多个源：弹应用内选择器
      const source = await showSourcePicker(sources);
      if (source) {
        console.log('[display-media] 用户选择了:', source.name);
        callback({ video: source, audio: 'loopback' });
      } else {
        console.log('[display-media] 用户取消选择');
        callback({});
      }
    } catch (e) {
      console.error('[display-media] handler 异常:', e);
      callback({});
    }
  });

  // 接收选择器窗口的回调
  ipcMain.on('source-picker-selected', (event, sourceId) => {
    if (pendingPickerResolve) {
      const source = pendingPickerSources.find(s => s.id === sourceId) || null;
      pendingPickerResolve(source);
      pendingPickerResolve = null;
      pendingPickerSources = [];
      if (pickerWindow && !pickerWindow.isDestroyed()) {
        pickerWindow.close();
      }
    }
  });

  // ============================================================
  // 备用方案：在主进程用隐藏 BrowserWindow + 旧 API 抓音频
  // 适用于 getDisplayMedia audio: 'loopback' 在某些 Realtek 声卡上
  // 返回静音流的场景（这是绕过 Electron 28/31 已知 bug 的最后手段）
  // ============================================================
  ipcMain.handle('start-fallback-capture', async (event, sourceId) => {
    const { BrowserWindow } = require('electron');
    if (global.__fallbackWin) {
      try { global.__fallbackWin.destroy(); } catch (_) {}
    }
    const win = new BrowserWindow({
      show: false,
      width: 1, height: 1,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true
      }
    });
    global.__fallbackWin = win;
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`
      <!doctype html>
      <html><head><meta charset="utf-8"></head>
      <body>
        <script>
          window.startFallback = async function(sourceId) {
            try {
              const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                  mandatory: {
                    chromeMediaSource: 'desktop',
                    chromeMediaSourceId: sourceId
                  }
                }
              });
              const ctx = new AudioContext({ sampleRate: 16000 });
              const src = ctx.createMediaStreamSource(stream);
              const proc = ctx.createScriptProcessor(4096, 1, 1);
              const chunks = [];
              proc.onaudioprocess = (e) => {
                const data = e.inputBuffer.getChannelData(0);
                chunks.push(new Float32Array(data));
                if (chunks.length > 50) chunks.shift();
              };
              src.connect(proc);
              window.__fallbackStream = stream;
              window.__fallbackCtx = ctx;
              window.__fallbackProc = proc;
              window.__fallbackChunks = chunks;
              return { ok: true, sampleRate: 16000 };
            } catch (e) {
              return { ok: false, error: e.message, name: e.name };
            }
          };
          window.getFallbackSamples = function() {
            if (!window.__fallbackChunks || window.__fallbackChunks.length === 0) return [];
            const total = window.__fallbackChunks.reduce((sum, c) => sum + c.length, 0);
            const result = new Float32Array(total);
            let offset = 0;
            for (const c of window.__fallbackChunks) {
              result.set(c, offset);
              offset += c.length;
            }
            window.__fallbackChunks.length = 0;
            return Array.from(result);
          };
          window.stopFallback = function() {
            try {
              if (window.__fallbackStream) window.__fallbackStream.getTracks().forEach(t => t.stop());
              if (window.__fallbackCtx) window.__fallbackCtx.close();
            } catch (_) {}
          };
        </script>
      </body></html>
    `));
    const safeId = sourceId.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const result = await win.webContents.executeJavaScript(
      `window.startFallback('${safeId}')`
    );
    if (!result.ok) {
      try { win.destroy(); } catch (_) {}
      global.__fallbackWin = null;
      return { ok: false, error: result.error || 'unknown' };
    }
    return { ok: true, sampleRate: 16000 };
  });

  ipcMain.handle('poll-fallback-samples', async () => {
    if (!global.__fallbackWin || global.__fallbackWin.isDestroyed()) {
      return { ok: false, error: 'window destroyed' };
    }
    try {
      const samples = await global.__fallbackWin.webContents.executeJavaScript(
        'window.getFallbackSamples()'
      );
      return { ok: true, samples };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('stop-fallback-capture', async () => {
    if (global.__fallbackWin && !global.__fallbackWin.isDestroyed()) {
      try {
        await global.__fallbackWin.webContents.executeJavaScript('window.stopFallback()');
      } catch (_) {}
      try { global.__fallbackWin.destroy(); } catch (_) {}
    }
    global.__fallbackWin = null;
    return { ok: true };
  });

  // ============================================================
  // ★ 系统音频捕获（用 native-audio-node，Windows WASAPI 直接抓）
  // 这绕过 Electron getDisplayMedia audio: 'loopback' 在 Realtek 上的 bug
  // 捕获到的是 Float32 16kHz 单声道 PCM，完美匹配百度 ASR
  // ============================================================
  let nativeSystemRecorder = null;
  let nativeStreamSender = null;  // 当前向哪个 webContents 推送数据

  ipcMain.handle('start-native-system-audio', async (event) => {
    if (nativeSystemRecorder) {
      return { ok: false, error: '已经在运行中' };
    }
    try {
      const mod = await loadNativeAudio();
      nativeSystemRecorder = new mod.SystemAudioRecorder({
        sampleRate: 16000,       // 16kHz，匹配百度
        chunkDurationMs: 100,    // 100ms 一个块
        stereo: false,           // 单声道
        mute: false,             // 不静音系统（用户能听到）
        emitSilence: true        // 静音时也推送空块（保持流连续）
      });

      let meta = null;
      let chunkCount = 0;
      let totalBytes = 0;
      let maxAbs = 0;
      let peakReportAt = Date.now();

      nativeSystemRecorder.on('metadata', (m) => {
        meta = m;
        console.log('[native-audio] metadata:', JSON.stringify(m));
        if (!event.sender.isDestroyed()) {
          event.sender.send('native-audio-metadata', m);
        }
      });

      nativeSystemRecorder.on('data', (chunk) => {
        chunkCount++;
        const buffer = chunk.data;
        if (chunkCount === 1) {
          console.log(`[native-audio] 数据类型: ${buffer.constructor.name}, 长度: ${buffer.length}, 前16字节:`, Array.from(buffer.slice(0, 16)));
        }
        
        let samples;
        if (meta && meta.isFloat && meta.bitsPerChannel === 32) {
          samples = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.length / 4);
        } else if (meta && !meta.isFloat && meta.bitsPerChannel === 16) {
          samples = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2);
        } else {
          samples = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.length / 4);
        }
        
        totalBytes += buffer.length;
        let chunkMax = 0;
        let chunkMin = 0;
        let sum = 0;
        let zeroCount = 0;
        for (let i = 0; i < samples.length; i++) {
          const a = Math.abs(samples[i]);
          if (a > chunkMax) chunkMax = a;
          if (a > maxAbs) maxAbs = a;
          if (samples[i] < chunkMin) chunkMin = samples[i];
          sum += samples[i];
          if (samples[i] === 0) zeroCount++;
        }
        const avg = sum / samples.length;
        
        let outData = samples;
        if (chunkMax > 1.5) {
          outData = new Float32Array(samples.length);
          const scale = 1.0 / 32768.0;
          for (let i = 0; i < samples.length; i++) {
            outData[i] = samples[i] * scale;
          }
          if (chunkCount === 1) {
            console.log(`[native-audio] 检测到 int16 数据，已归一化 (raw peak=${chunkMax.toFixed(0)}, 归一化因子=${scale})`);
          }
        } else if (chunkCount === 1) {
          console.log(`[native-audio] 数据是标准 Float32 (peak=${chunkMax.toFixed(4)})`);
        }
        // 每 5 秒输出一次详细音量报告
        if (Date.now() - peakReportAt > 5000) {
          console.log(`[native-audio] 5s 统计: ${chunkCount}块, ${totalBytes}字节, 峰值=${maxAbs.toFixed(4)}, 最小值=${chunkMin.toFixed(4)}, 平均值=${avg.toFixed(6)}, 零值占比=${(zeroCount/samples.length*100).toFixed(2)}%`);
          peakReportAt = Date.now();
          chunkCount = 0;
          totalBytes = 0;
          maxAbs = 0;
        }
        // 推送到渲染层
        if (nativeStreamSender && !nativeStreamSender.isDestroyed()) {
          // 转为 Array 以便 IPC 传输（避免 Transferable 问题）
          nativeStreamSender.send('native-audio-data', Array.from(outData));
        }
      });

      nativeSystemRecorder.on('error', (e) => {
        console.error('[native-audio] 错误:', e.message);
        if (nativeStreamSender && !nativeStreamSender.isDestroyed()) {
          nativeStreamSender.send('native-audio-error', e.message);
        }
      });

      await nativeSystemRecorder.start();
      nativeStreamSender = event.sender;
      console.log('[native-audio] 启动成功');
      return { ok: true };
    } catch (e) {
      console.error('[native-audio] 启动失败:', e);
      nativeSystemRecorder = null;
      nativeStreamSender = null;
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('stop-native-system-audio', async () => {
    if (nativeSystemRecorder) {
      try {
        await nativeSystemRecorder.stop();
      } catch (e) {
        console.error('[native-audio] 停止失败:', e);
      }
      nativeSystemRecorder = null;
      nativeStreamSender = null;
    }
    return { ok: true };
  });

  ipcMain.handle('list-audio-devices-native', async () => {
    try {
      const mod = await loadNativeAudio();
      // ⚠️ native 模块静态方法实际叫 listDevices（不是 listAudioDevices），
      // 之前写错时这个 IPC 一直抛 TypeError 或返回空，导致配置面板没法枚举音频输出设备。
      const devices = (typeof mod.listDevices === 'function') ? mod.listDevices()
        : (typeof mod.listAudioDevices === 'function') ? mod.listAudioDevices() : [];
      return { ok: true, devices: Array.isArray(devices) ? devices : [] };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
}

function showSourcePicker(sources) {
  return new Promise((resolve) => {
    if (pickerWindow && !pickerWindow.isDestroyed()) {
      pickerWindow.focus();
      return;
    }
    pendingPickerResolve = resolve;
    pendingPickerSources = sources;

    pickerWindow = new BrowserWindow({
      width: 540,
      height: 480,
      title: '选择要捕获的窗口',
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      }
    });

    pickerWindow.setMenuBarVisibility(false);

    pickerWindow.on('closed', () => {
      pickerWindow = null;
      if (pendingPickerResolve) {
        pendingPickerResolve(null);
        pendingPickerResolve = null;
        pendingPickerSources = [];
      }
    });

    pickerWindow.loadFile(path.join(__dirname, 'source-picker.html'));

    pickerWindow.webContents.once('did-finish-load', () => {
      // 把 source 数据发给选择器窗口（含缩略图 dataURL）
      const data = sources.map(s => ({
        id: s.id,
        name: s.name,
        thumbnail: s.thumbnail ? s.thumbnail.toDataURL() : null
      }));
      pickerWindow.webContents.send('set-sources', data);
    });
  });
}

app.on('window-all-closed', () => {
  // 停止自动保存
  stateManager.stopAutoSave();

  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  // 退出前：兜底结束当前面试 session（把 endedAt/status 写回文件），避免留下一堆 status=active 但已关机的"僵尸场"
  try {
    const svc = require('./services/localHttpServer');
    if (svc && typeof svc.endActiveSession === 'function') {
      const r = svc.endActiveSession();
      if (r && r.ended) console.log(`[main][will-quit] ✅ 兜底结束本场面试：sessionId=${r.session && r.session.id} title=${r.session && r.session.title}`);
    }
  } catch (_) { /* 忽略：localHttpServer 没启动就不需要 end */ }
  // 退出前停止小程序本地 HTTP+WS 服务，避免端口残留
  try {
    const svc = require('./services/localHttpServer');
    if (svc && typeof svc.stop === 'function') svc.stop();
  } catch (_) { /* 忽略 */ }
});

// IPC 通信处理
// 返回整个屏幕的尺寸（所有显示器合并后的总范围），用于弹窗跨屏拖动
ipcMain.handle('get-screen-bounds', () => {
  try {
    const { screen } = require('electron');
    const displays = screen.getAllDisplays();
    if (!displays || displays.length === 0) {
      return { x: 0, y: 0, width: 1920, height: 1080 };
    }
    // 合并所有显示器的工作区域
    let minX = Infinity, minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;
    for (const d of displays) {
      const wa = d.workArea;
      if (wa.x < minX) minX = wa.x;
      if (wa.y < minY) minY = wa.y;
      if (wa.x + wa.width > maxX) maxX = wa.x + wa.width;
      if (wa.y + wa.height > maxY) maxY = wa.y + wa.height;
    }
    return {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
      displays: displays.map(d => ({ id: d.id, bounds: d.bounds, workArea: d.workArea }))
    };
  } catch (e) {
    return { x: 0, y: 0, width: 1920, height: 1080 };
  }
});

ipcMain.handle('get-config', () => loadConfig());
ipcMain.handle('save-config', (event, config) => {
  saveConfig(config);
  // 如果快捷键变化，重新注册
  registerGlobalShortcuts(config);
  return { success: true };
});

// 统一配置模型通道（对应 HireMe Copilot 页面全部字段）
ipcMain.handle('get-interview-config', () => configManager.getConfig());
ipcMain.handle('save-interview-config', (event, cfg) => {
  configManager.saveConfig(cfg);
  registerGlobalShortcuts(cfg);
  return { success: true };
});
ipcMain.handle('get-history', () => loadHistory());
ipcMain.handle('save-history', (event, history) => saveHistory(history));

ipcMain.handle('set-always-on-top', (event, flag) => {
  if (mainWindow) {
    mainWindow.setAlwaysOnTop(flag);
  }
});

ipcMain.handle('set-opacity', (event, opacity) => {
  if (mainWindow && !isStealthMode) {
    mainWindow.setOpacity(opacity);
  }
});

// 窗口边缘拖拽缩放（仅在 transparent+frame:false 模式下使用）
ipcMain.handle('resize-window', (event, direction, deltaX, deltaY) => {
  if (!mainWindow) return;
  const [width, height] = mainWindow.getSize();
  const [x, y] = mainWindow.getPosition();
  const minW = 280, minH = 320;
  let newW = width, newH = height, newX = x, newY = y;
  if (direction.includes('e')) newW = Math.max(minW, width + deltaX);
  if (direction.includes('s')) newH = Math.max(minH, height + deltaY);
  if (direction.includes('w')) {
    newW = Math.max(minW, width - deltaX);
    newX = x + (width - newW);
  }
  if (direction.includes('n')) {
    newH = Math.max(minH, height - deltaY);
    newY = y + (height - newH);
  }
  mainWindow.setBounds({ x: newX, y: newY, width: newW, height: newH });
});

ipcMain.handle('hide-window', () => {
  if (mainWindow) {
    mainWindow.hide();
    isWindowVisible = false;
    updateTrayMenu();
  }
});

ipcMain.handle('show-window', () => {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
    isWindowVisible = true;
    updateTrayMenu();
  }
});

ipcMain.handle('toggle-window', () => {
  toggleWindowVisibility();
});

ipcMain.handle('enter-stealth-mode', () => {
  isStealthMode = true;
  if (mainWindow) {
    // 隐身模式：用 CSS pointer-events 控制，保留 webkit-app-region 拖动能力
    mainWindow.setSkipTaskbar(true);
    // ★ 系统级捕获排除：窗口从录屏/截图/屏幕共享中排除，本地仍可见
    captureExclusion.applyCaptureExclusion(mainWindow, true);
    mainWindow.webContents.send('stealth-mode-changed', true);
  }
  updateTrayMenu();
});

ipcMain.handle('exit-stealth-mode', () => {
  isStealthMode = false;
  if (mainWindow) {
    // 退出隐身模式：恢复鼠标交互
    mainWindow.setIgnoreMouseEvents(false);
    mainWindow.setSkipTaskbar(false);
    // ★ 恢复正常屏幕捕获
    captureExclusion.applyCaptureExclusion(mainWindow, false);
    mainWindow.webContents.send('stealth-mode-changed', false);
  }
  updateTrayMenu();
});

// 独立控制「从屏幕捕获排除」：可在非隐身状态下单独启用（对齐 HireMe 的 applyExcludeFromCapture）
// 返回 { success, method }，method 标识实际生效方式（exclude_from_capture / monitor / content_protection / unsupported）
ipcMain.handle('set-exclude-from-capture', (event, enabled) => {
  if (!mainWindow) return { success: false, method: 'no_window' };
  const ok = captureExclusion.applyCaptureExclusion(mainWindow, !!enabled);
  // 反馈实际生效方式，便于 UI 提示
  let method = 'unsupported';
  if (ok) {
    if (captureExclusion.ensureFunc()) {
      // Windows 路径：能加载 koffi 即尝试了 EXCLUDEFROMCAPTURE（内部已做 MONITOR 回退）
      method = 'exclude_from_capture';
    } else {
      method = 'content_protection';
    }
  }
  return { success: ok, method };
});

ipcMain.handle('is-in-stealth-mode', () => {
  return isStealthMode;
});

// 给出可捕获的窗口/屏幕列表（用于系统声音捕获选择器）
// 修复 navigator.mediaDevices.getDisplayMedia 在某些 Electron 28 配置下报 "Not supported" 的问题：
// 改用 Electron 原生 desktopCapturer 枚举，再用 getUserMedia + chromeMediaSourceId 约束捕获
ipcMain.handle('get-desktop-sources', async (event, opts = {}) => {
  try {
    const sources = await desktopCapturer.getSources({
      types: opts.types || ['window', 'screen'],
      fetchWindowIcons: false
    });
    return {
      success: true,
      sources: sources.map(s => ({
        id: s.id,
        name: s.name,
        thumbnail: s.thumbnail ? s.thumbnail.toDataURL() : null
      }))
    };
  } catch (e) {
    console.error('枚举桌面源失败:', e);
    return { success: false, error: e.message };
  }
});

// 通用文件选择对话框（供简历 / 知识库上传使用）
ipcMain.handle('open-file-dialog', async (event, options = {}) => {
  try {
    const { dialog } = require('electron');
    const result = await dialog.showOpenDialog(mainWindow, {
      title: options.title || '选择文件',
      filters: options.filters || [{ name: 'All Files', extensions: ['*'] }],
      properties: ['openFile']
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, canceled: true };
    }
    return { success: true, filePath: result.filePaths[0] };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// 语音识别
ipcMain.handle('speech-to-text', async (event, audioBuffer, config) => {
  try {
    if (!config?.baiduApiKey || !config?.baiduSecretKey) {
      return { success: false, error: '请先在设置中填写百度语音 API Key 和 Secret' };
    }
    const text = await speechService.baiduSpeechToText(
      Buffer.from(audioBuffer.data),
      config.baiduApiKey,
      config.baiduSecretKey
    );
    return { success: true, text };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// 给实时 ASR 用的：返回百度 access_token（不直接发音频）
ipcMain.handle('get-baidu-access-token', async (event, config) => {
  try {
    // 兼容两种字段命名：baiduApiKey/baiduSecretKey（来自 appState.config）和 apiKey/secretKey（renderer 显式传）
    const apiKey = config?.baiduApiKey || config?.apiKey;
    const secretKey = config?.baiduSecretKey || config?.secretKey;
    if (!apiKey || !secretKey) {
      return { success: false, error: '请先在设置中填写百度语音 API Key 和 Secret' };
    }

    // 隐私审计：记录请求
    privacyAudit.logNetworkRequest(
      'aip.baidubce.com',
      'POST',
      'token_request',
      Buffer.byteLength(JSON.stringify({
        grant_type: 'client_credentials',
        client_id: apiKey,
        client_secret: secretKey
      }), 'utf-8')
    );

    const token = await speechService.getBaiduAccessToken(apiKey, secretKey);

    return { success: true, token };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// REST 模式用：把 WAV 字节发给百度短语音 API（renderer 期望的接口）
ipcMain.handle('baidu-recognize', async (event, params) => {
  try {
    const { audioData, apiKey, secretKey, appId, rate = 16000, channel = 1 } = params || {};
    if (!apiKey || !secretKey) {
      return { ok: false, error: '请先在设置中填写百度语音 API Key 和 Secret' };
    }
    if (!audioData) {
      return { ok: false, error: '没有音频数据' };
    }
    // audioData 可能是 Buffer（带 .data）或纯 Buffer
    const buf = Buffer.isBuffer(audioData) ? audioData : Buffer.from(audioData.data || audioData);
    const text = await speechService.baiduSpeechToText(buf, apiKey, secretKey, {
      appId,
      rate,
      channel
    });
    return { ok: true, text };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

// AI生成答题思路
ipcMain.handle('generate-answer', async (event, question, config) => {
  try {
    const answer = await aiService.generateAnswer(
      question,
      config.interviewScene,
      config.selectedService,
      config,
      [],
      '',
      config.modelTier
    );
    return { success: true, answer };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// 简历优化：复用现有 LLM 引擎（文心/智谱/通义直连），按优化方向改写简历
// 入参：resumeText（简历纯文本）、direction（general|keywords|star|concise）
// 说明：密钥来自用户在设置面板填写的 config，不写死在代码中
ipcMain.handle('optimize-resume', async (event, resumeText, direction) => {
  try {
    // 入参校验：简历为空直接返回友好错误，不发起网络请求
    if (!resumeText || !resumeText.trim()) {
      return { success: false, error: '请先在「简历优化」页上传或粘贴简历内容' };
    }
    // 读取完整配置（含用户在设置面板填写的 API Key 与所选服务）
    const config = loadConfig();
    const service = config.selectedService || 'tongyi';
    // 优化方向 -> 人类可读文案，用于拼装提示词
    const dirMap = {
      general:  '通用优化（整体提升表达、结构与人岗匹配度）',
      keywords: '关键词匹配（对照岗位 JD，提升 ATS 系统通过率）',
      star:     'STAR 法则（用情境-任务-行动-结果重塑每段经历）',
      concise:  '精简表达（去冗余、突出核心贡献与量化成果）'
    };
    const dirText = dirMap[direction] || dirMap.general;
    // 拼装简历优化提示词：先给逐条建议，再给可直接替换的全文
    const prompt = `你是一位资深 HR 与简历优化专家。请基于下方原始简历，按【优化方向】给出改写建议与可直接使用的优化后版本。

【优化方向】：${dirText}

【原始简历】：
${resumeText}

要求：
1. 先输出「逐条优化建议」（点出痛点与可改进处）；
2. 再输出「优化后简历全文」（可直接替换原简历，保留真实信息、不得编造经历）；
3. 语言精炼、专业，紧扣优化方向。`;
    const answer = await aiService.generateAnswer(
      prompt,
      config.interviewScene || 'behavioral',
      service,
      config,
      [],
      '',
      config.modelTier,
      false // 简历优化用自定义提示词，禁止编程档位改写场景
    );
    return { success: true, answer };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// 保存系统音频存档（WAV）：渲染层在停止采集时把 archive 缓冲编码成 WAV 传来
ipcMain.handle('save-system-recording', async (event, sessionId, wavArrayBuffer) => {
  try {
    const id = sessionId || String(Date.now());
    const filePath = configManager.saveRecording(id, wavArrayBuffer);
    if (!filePath) return { success: false, error: '写入失败' };
    return { success: true, path: filePath, sessionId: id };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// AI 面试复盘：把问答历史喂 LLM 生成复盘报告，并存盘
ipcMain.handle('generate-review', async (event, history, config) => {
  try {
    if (!Array.isArray(history) || history.length === 0) {
      return { success: false, error: '没有问答记录，无法复盘' };
    }
    const service = (config && config.selectedService) || 'tongyi';
    const review = await aiService.generateReview(
      history,
      service,
      config,
      config && config.modelTier
    );
    // 存盘为 review.md
    const sessionId = String(Date.now());
    const reviewPath = configManager.saveReview(sessionId, review);
    return { success: true, review, sessionId, reviewPath };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// 列出历史会话档案（含 transcript/wav/review）—— 旧语义：configManager 存档，不要与下面面试记录混用
ipcMain.handle('list-sessions', () => {
  return { success: true, sessions: configManager.listSessions() };
});

// ============================================================
// ★ 面试 Session（面试记录）专用 5 个 IPC：前缀 interview-session-
//   所有通道都先 ensureLocalHttpServerWithBus（幂等），保证：
//     1) localHttpServer 启动；2) loadConfigFn 已挂；3) sessions 目录已初始化；4) bus 订阅已挂
//   即便还没开始 ASR 识别（用户一打开 app 就点底部按钮）也能正常返回空列表/开新场。
// ============================================================
// 1) 列表：返回 {ok, total, sessions:[摘要…], sessionsVersion, keyword, limit, offset}
ipcMain.handle('interview-session-list', async (event, opts = {}) => {
  try {
    await ensureLocalHttpServerWithBus();
    const r = localHttpServer.listSessions({
      keyword: opts && opts.keyword ? String(opts.keyword) : '',
      limit: Number(opts && opts.limit) || 50,
      offset: Number(opts && opts.offset) || 0,
    });
    return Object.assign({ ok: true }, r);
  } catch (e) {
    console.error('[main][interview-session-list] 异常:', e && e.message);
    return { ok: false, error: 'internal', msg: e && e.message ? e.message : 'list 失败', total: 0, sessions: [] };
  }
});
// 2) 详情：返回 {ok:true, session, from} 或 {ok:false, error, msg}
ipcMain.handle('interview-session-get', async (event, id) => {
  try {
    await ensureLocalHttpServerWithBus();
    const r = localHttpServer.getSessionDetail(id);
    // r 本身自带 ok/session/error 字段
    return Object.assign({ ok: false }, r || {});
  } catch (e) {
    console.error('[main][interview-session-get] 异常:', e && e.message);
    return { ok: false, error: 'internal', msg: e && e.message ? e.message : 'get 失败' };
  }
});
// 3) 开始新的一场面试：主窗口底部 🆕 按钮 / 输入了新公司新职位失焦自动切 触发
ipcMain.handle('interview-session-start-new', async (event, forceConfig) => {
  try {
    await ensureLocalHttpServerWithBus();
    // forceConfig 校验：允许 null/undefined；是对象才透传
    const cfg = (forceConfig && typeof forceConfig === 'object') ? forceConfig : undefined;
    const r = localHttpServer.startNewSession(cfg);
    return Object.assign({ ok: false }, r || {});
  } catch (e) {
    console.error('[main][interview-session-start-new] 异常:', e && e.message);
    return { ok: false, error: 'internal', msg: e && e.message ? e.message : 'start-new 失败' };
  }
});
// 4) 结束当前场面试：主窗口底部 ⏹ 按钮 / app will-quit 兜底 触发
ipcMain.handle('interview-session-end-active', async () => {
  try {
    await ensureLocalHttpServerWithBus();
    const r = localHttpServer.endActiveSession();
    return Object.assign({ ok: false }, r || {});
  } catch (e) {
    console.error('[main][interview-session-end-active] 异常:', e && e.message);
    return { ok: false, error: 'internal', msg: e && e.message ? e.message : 'end-active 失败' };
  }
});
// 5) 根据历史侧栏里的 roundId → 反向查属于哪一场 session（侧栏卡片点击 → 跳详情用）
//   返回：{ok:true, roundId, sessionId|null, sessionsVersion}
ipcMain.handle('interview-session-find-by-round', async (event, roundId) => {
  try {
    await ensureLocalHttpServerWithBus();
    const hit = localHttpServer.findSessionByRoundId(roundId);
    const s = (localHttpServer && localHttpServer.state) ? localHttpServer.state : {};
    return {
      ok: true,
      roundId: roundId ? String(roundId) : '',
      sessionId: hit ? hit.sessionId : null,
      sessionsVersion: Number(s && s.sessionsVersion) || 0,
    };
  } catch (e) {
    console.error('[main][interview-session-find-by-round] 异常:', e && e.message);
    return { ok: false, roundId: roundId ? String(roundId) : '', sessionId: null, error: 'internal', msg: e && e.message ? e.message : 'find-by-round 失败' };
  }
});
// 6) 切场边界辅助：如果用户刚显式×结束了面试（存在 _lastEndedSessionId 标记）→ 强制开新场；否则懒创建。
//    调用点：开始面试辅助 / open-overlay IPC（创建独立浮层）/ 重新打开答题面板。
//    目的：保证显式"结束本场"后再次打开浮层 = 落到新场，不会继续/恢复刚结束的那一场。
ipcMain.handle('interview-session-ensure-if-ended', async (event, cfg) => {
  try {
    await ensureLocalHttpServerWithBus();
    const forceCfg = (cfg && typeof cfg === 'object') ? cfg : undefined;
    const r = localHttpServer.ensureStartNewSessionIfJustEnded(forceCfg);
    return Object.assign({ ok: false }, r || {});
  } catch (e) {
    console.error('[main][interview-session-ensure-if-ended] 异常:', e && e.message);
    return { ok: false, error: 'internal', msg: e && e.message ? e.message : 'ensure-if-ended 失败' };
  }
});

// 截图解题：接收截图 data URL + 简历/知识库上下文，调视觉模型返回解答
//  【升级】复用 localHttpServer._autoSolveScreenshotAndSync 公共函数：
//    面板截图/小程序截图/H5 截图统一走同一套"面试官题→AI解题→面板/H5写入"闭环，保证行为一致
ipcMain.handle('screenshot-solve', async (event, imageDataUrl, config, resumeContent, knowledgeBase) => {
  try {
    // 双保险：调用前确保 loadConfigFn / captureFn 已挂载（幂等，重复调用安全）
    //   防止极端情况下（比如用户在 app ready 回调未完成时就点了截图）依赖还没挂好
    attachLocalHttpServerExternals();

    // 【修复】透传渲染层(getInterviewConfig)拿到的最新简历/知识库上下文：
    //   渲染层传的 resumeContent 参数即 resumeText 字段值；不传时公共函数内部会回退读本地配置
    const r = await localHttpServer._autoSolveScreenshotAndSync({
      imageDataUrlOrBase64: imageDataUrl,
      mime: 'image/png',  // 面板截图框选后默认是 PNG dataURL
      source: 'panel',
      resumeContent: (typeof resumeContent === 'string') ? resumeContent : '',
      knowledgeBase: (typeof knowledgeBase === 'string') ? knowledgeBase : '',
    });
    if (r && r.success) {
      return { success: true, answer: (r.answer || '').trim() };
    }
    // 失败：返回友好错误
    const errMsg = (r && r.message) ? r.message : '截图解题失败，请查看终端日志';
    console.error('[ipc:screenshot-solve] 失败:', errMsg, r ? r.error : 'no_result');
    return { success: false, error: errMsg };
  } catch (error) {
    console.error('[ipc:screenshot-solve] 异常:', error && error.message, '\n', error && error.stack);
    return { success: false, error: (error && error.message) ? error.message : '截图解题异常' };
  }
});

// 截取主屏幕全屏图（按实际分辨率），返回 data URL，供截图解题框选
//  【压缩】全屏 PNG 原图在 2K/4K 屏下 base64 可达 5-20MB，可能超过百炼/通义视觉模型
//    Base64 10MB 上限。这里与小程序截图链路参数对齐：宽度超过 1920 等比缩小 + 转 JPEG(质量 0.85)，
//    压缩后一般 300-800KB，OCR 文字识别完全够用。
//  【修复】之前用 nativeImage.createFromDataURL(dataUrl) 在大图时抛
//    "Error processing argument at index 0, conversion failure"——thumbnail 本身就是
//    nativeImage 实例，直接在其上 resize/toJPEG 即可，完全绕过 dataURL 转换。
ipcMain.handle('screenshot-screen', async () => {
  try {
    const { screen } = require('electron');
    const primary = screen.getPrimaryDisplay();

    // ============================================================
    // 【策略 A】优先走 Electron desktopCapturer（最快，纯内存）
    //   注意：Windows 高分屏/DPI 缩放组合下，返回的 thumbnail 可能：
    //         (a) isEmpty()===true  (b) isEmpty()===false 但内部 buffer 损坏
    //         (c) getSize/resize 正常但 toJPEG/resize 抛 "conversion failure"
    //   因此整个 A 路径包独立 try/catch，任何异常立刻 fallback 到策略 B，绝不往下走。
    // ============================================================
    let dataUrlResult = null;
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: primary.size.width, height: primary.size.height }
      });
      if (sources.length) {
        let img = sources[0].thumbnail;
        if (!img || img.isEmpty()) throw new Error('sources[0].thumbnail is empty');
        const sz = img.getSize();
        if (!sz || !sz.width || !sz.height) throw new Error(`sources[0].thumbnail.getSize() returns invalid: ${JSON.stringify(sz)}`);
        const MAX_W = 1920;
        if (sz.width > MAX_W) img = img.resize({ width: MAX_W });
        const jpegBuf = img.toJPEG(0.85);
        if (!jpegBuf || jpegBuf.length < 100) throw new Error(`toJPEG abnormal output (bytes=${jpegBuf ? jpegBuf.length : 0})`);
        dataUrlResult = 'data:image/jpeg;base64,' + jpegBuf.toString('base64');
        console.log(`[screenshot-screen] 🗜️ [策略A desktopCapturer] 压缩完成: 原始 ${sz.width}x${sz.height} → 输出 JPEG ${(dataUrlResult.length / 1024).toFixed(0)}KB`);
      }
    } catch (aErr) {
      // A 路径任何异常都忽略，仅打印警告后走 B 路径
      console.warn(`[screenshot-screen] ⚠️ 策略A(desktopCapturer)失败: ${aErr.message} → fallback 策略B(PowerShell)`);
      dataUrlResult = null;
    }

    // ============================================================
    // 【策略 B】PowerShell + .NET Graphics.CopyFromScreen（Windows 原生 API，兼容任何分辨率/DPI）
    //   触发条件：A 路径未成功产出 dataUrl（未执行 / 抛错 / 产出异常）
    // ============================================================
    if (!dataUrlResult) {
      const fb = await _powershellCaptureScreenAsJpegDataUrl();
      if (fb && fb.dataUrl) {
        console.log(`[screenshot-screen] ✅ [策略B PowerShell] 成功: ${fb.width}x${fb.height} → ${(fb.dataUrl.length / 1024).toFixed(0)}KB`);
        return { success: true, dataUrl: fb.dataUrl, width: fb.width || primary.size.width, height: fb.height || primary.size.height };
      }
      throw new Error('desktopCapturer 失败，且 PowerShell fallback 也失败（请检查终端日志）');
    }

    return { success: true, dataUrl: dataUrlResult, width: primary.size.width, height: primary.size.height };
  } catch (e) {
    // 终端打印完整堆栈（避免前端 alert 里的 e.message 只剩 "conversion failure from" 截断）
    console.error(`[screenshot-screen] ❌ 截屏失败: ${e.message}\n${e.stack || new Error().stack}`);
    return { success: false, error: e.message };
  }
});

// ============================================================
// 【兜底】用 PowerShell (.NET System.Drawing) 抓主屏 → JPEG base64 dataURL
//   只在 Windows 使用；Win10/11 自带 .NET 4.x，无需任何依赖。
//   与 desktopCapturer 相比，兼容性更好（DPI缩放/高分屏都工作），但稍慢（100-200ms）。
// 返回：{ dataUrl, width, height } 或 null（失败）
// ============================================================
async function _powershellCaptureScreenAsJpegDataUrl() {
  try {
    const { execFile } = require('child_process');
    // 单条 PowerShell：抓主屏→存 JPEG 到临时文件→读回输出 Base64→删临时文件
    const psScript = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$scr = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap($scr.Width, $scr.Height)
$g   = [System.Drawing.Graphics]::FromImage($bmp)
try {
  $g.CopyFromScreen($scr.X, $scr.Y, 0, 0, $scr.Size)
  $tmp = Join-Path $env:TEMP "ia_screen_$([guid]::NewGuid()).jpg"
  $bmp.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Jpeg)
  $bytes = [System.IO.File]::ReadAllBytes($tmp)
  Remove-Item $tmp -Force -ErrorAction SilentlyContinue
  [Console]::Out.Write([Convert]::ToBase64String($bytes))
} finally {
  $g.Dispose(); $bmp.Dispose()
}
`.replace(/\r?\n/g, '; ');
    return await new Promise((resolve, reject) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
        { maxBuffer: 50 * 1024 * 1024, timeout: 15000 },
        (err, stdout, stderr) => {
          if (err) return reject(new Error(stderr ? stderr.toString() : err.message));
          const b64 = String(stdout || '').trim();
          if (!b64) return reject(new Error('PowerShell 截屏输出为空'));
          // 临时用 nativeImage 取尺寸（需要时才算尺寸，避免用户内存浪费）
          let w = 0, h = 0;
          try {
            const { nativeImage } = require('electron');
            const nimg = nativeImage.createFromBuffer(Buffer.from(b64, 'base64'));
            if (!nimg.isEmpty()) {
              const sz = nimg.getSize(); w = sz.width; h = sz.height;
            }
          } catch (_) { /* 尺寸获取失败不致命：只留 dataUrl 即可 */ }
          resolve({ dataUrl: 'data:image/jpeg;base64,' + b64, width: w, height: h });
        }
      );
    });
  } catch (e) {
    console.error('[screenshot-screen][powershell-fallback] ❌ 失败:', e && e.message);
    return null;
  }
}

// 伴生设备中继：启动/停止/状态/广播（对齐 HireMe localServer/relay）
ipcMain.handle('start-relay-server', async (event, port) => {
  const r = await relayServer.start(port || 9876);
  if (r.success) {
    // 附带本机局域网 IPv4，便于伴生设备浏览器访问
    try {
      const os = require('os');
      const ips = [];
      const ifaces = os.networkInterfaces();
      Object.keys(ifaces).forEach((name) => {
        (ifaces[name] || []).forEach((iface) => {
          if (iface.family === 'IPv4' && !iface.internal) ips.push(iface.address);
        });
      });
      r.ips = ips;
    } catch (_) { r.ips = []; }
  }
  return r;
});
ipcMain.handle('stop-relay-server', () => {
  relayServer.stop();
  return { success: true };
});
ipcMain.handle('relay-server-status', () => {
  return { running: relayServer.isRunning(), port: relayServer.port };
});
// 渲染层把实时转写/答案通过此通道广播给所有伴生设备
ipcMain.handle('relay-broadcast', (event, payload) => {
  relayServer.broadcast(payload);
  return { success: true };
});

// ============================================================
// ★ 简历优化：保存文件对话框（导出优化后的 DOCX）
// ============================================================
ipcMain.handle('save-file-dialog', async (event, options = {}) => {
  try {
    const { dialog } = require('electron');
    const result = await dialog.showSaveDialog(mainWindow, {
      title: options.title || '保存文件',
      defaultPath: options.defaultPath || '优化后简历.docx',
      filters: options.filters || [{ name: 'Word 文档', extensions: ['docx'] }]
    });
    if (result.canceled || !result.filePath) {
      return { success: false, canceled: true };
    }
    return { success: true, filePath: result.filePath };
  } catch (e) {
    return { success: false, error: e && e.message || 'save dialog failed' };
  }
});

// ============================================================
// ★ 模拟面试：点『模拟面试记录』直接打开面试记录详情（若有 sessionId）
//   没有 sessionId 时：只打开主界面的『面试记录』列表（交给渲染层实现 tab 切换），
//   这里统一返回当前 active / 最近结束的 sessionId，方便前端自行跳详情。
// ============================================================
ipcMain.handle('mock-interview-last-session', () => {
  try {
    const list = localHttpServer.listSessions({ limit: 1, keyword: '' });
    const items = (list && list.sessions) || [];
    const activeId = (localHttpServer.state && localHttpServer.state.activeSessionId) || null;
    return { ok: true, activeId, lastId: items[0] ? items[0].id : null, firstId: items[0] ? items[0].id : null };
  } catch (e) {
    return { ok: false, error: e && e.message || 'query sessions failed', activeId: null, lastId: null };
  }
});


// ============================================================
// ★ 独立答题面板（overlayWindow）：可跨屏、毛玻璃、系统音频识别结果专用
// ============================================================

/**
 * 获取答题面板默认 bounds：右侧 1/4 屏幕，高度 60%
 * 支持多显示器：选最近主窗口的显示器（主屏兜底）。
 * @returns {{ x:number, y:number, width:number, height:number }}
 */
function getDefaultOverlayBounds() {
  try {
    const anchor = (mainWindow && !mainWindow.isDestroyed()) ? mainWindow.getBounds() : null;
    const disp = anchor
      ? screen.getDisplayNearestPoint({ x: anchor.x + 1, y: anchor.y + 1 })
      : screen.getPrimaryDisplay();
    const wa = disp.workArea;           // 去掉任务栏后的工作区
    const W = Math.max(360, Math.min(520, Math.floor(wa.width * 0.28)));
    const H = Math.max(420, Math.min(720, Math.floor(wa.height * 0.62)));
    const x = wa.x + wa.width - W - 24;  // 右侧留 24px
    const y = wa.y + 24;                 // 顶部留 24px（顶到面试官视频区）
    return { x, y, width: W, height: H };
  } catch (e) {
    return { x: 1200, y: 120, width: 400, height: 600 };
  }
}

/**
 * 广播消息给「主窗口」+「答题面板」所有存活的 webContents。
 * 保证 ASR 文本/答案同时推送给 copilot 页和 overlay 独立窗口。
 * @param {string} channel
 * @param  {...any} args
 */
function broadcastToAllViews(channel, ...args) {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args);
  } catch (_) { /* 忽略 */ }
  try {
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.webContents.send(channel, ...args);
  } catch (_) { /* 忽略 */ }
}

/**
 * 创建独立答题面板窗口（createOverlayWindow）。
 * 已存在则直接显示到最前，不重复创建。
 * 创建完成后立刻订阅 app.bus，把 ASR/答案事件转发到 overlay 渲染层。
 */
function createOverlayWindow() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    try {
      overlayWindow.show();
      overlayWindow.focus();
      return overlayWindow;
    } catch (_) { /* 忽略，继续重建 */ }
  }
  // 开新浮层 = 新的关闭流程：重置 post-close 原子锁
  //   （上一次 closed 事件的 finally 会再保险地重置一次，这里在入口处也重置保证可靠）
  _overlayCloseFlowHandled = false;
  const b = getDefaultOverlayBounds();
  overlayWindow = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height,
    minWidth: 320, minHeight: 360,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: true,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,                     // 面试最重要：答案不能被会议/面试页面挡住
    skipTaskbar: true,                     // 不占任务栏，像浮动工具
    hasShadow: false,                      // 投影由 CSS box-shadow 控制
    show: false,                           // 等 loadFile 完成再 show，避免白闪
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: true,               // 过渡期保留，后续 overlay 完全走 preload 桥
      // ★ Electron contextBridge 仅在 contextIsolation=true 时工作。
      // 之前为 false 导致 window.electronAPI 不存在，overlay-renderer 走了 stub 返回 "not electron"。
      // 改为 true 确保 preload 暴露的安全桥正常注入；overlay-renderer 只用 window.electronAPI，不需要全局 require。
      contextIsolation: true,
      enableRemoteModule: true,
    },
    icon: path.join(__dirname, 'assets', 'icon.png'),
  });
  // alwaysOnTop 等级：screen-saver，确保高于会议软件的全屏共享
  try { overlayWindow.setAlwaysOnTop(true, 'screen-saver'); } catch (_) {}

  // ===== 订阅 app.bus → 转发给 overlay 渲染层（只要 overlay 存在就实时更新）=====
  const onAsrInterim = (text) => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    overlayWindow.webContents.send('asr:interim', text);
  };
  const onAsrFinal = (text) => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    overlayWindow.webContents.send('asr:final', text);
  };
  const onAnswerStart = (q) => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    overlayWindow.webContents.send('asr:answer-start', q);
  };
  const onAnswerGenerated = (text) => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    overlayWindow.webContents.send('asr:answer-generated', { text });
  };
  const onRecordingStatus = (r) => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    overlayWindow.webContents.send('asr:recording-status', !!r);
  };
  const onWriteOutside = (text) => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    overlayWindow.webContents.send('asr:answer-write-from-outside', text);
  };
  // 【新增】外部写入面试官提问（H5/小程序/面板截图通用）→ 转发给 overlay 渲染层
  //   兼容两种 payload：对象 {text, imageDataUrl?} / 纯字符串（旧调用兜底）；统一归一化后再发给渲染层
  const onWriteQuestionOutside = (payload) => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    let sendObj;
    if (payload && typeof payload === 'object') {
      sendObj = {
        text: (typeof payload.text === 'string') ? payload.text : '',
        imageDataUrl: (typeof payload.imageDataUrl === 'string') ? payload.imageDataUrl : '',
      };
    } else {
      sendObj = { text: String(payload || ''), imageDataUrl: '' };
    }
    overlayWindow.webContents.send('asr:question-write-from-outside', sendObj);
  };
  const onLocalStatusChanged = (obj) => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    overlayWindow.webContents.send('local:status-changed', obj);
  };

  app.bus.on('asr:interim', onAsrInterim);
  app.bus.on('asr:final', onAsrFinal);
  app.bus.on('asr:answer-start', onAnswerStart);
  app.bus.on('asr:answer-generated', onAnswerGenerated);
  app.bus.on('asr:recording-status', onRecordingStatus);
  app.bus.on('local:write-answer-from-outside', onWriteOutside);
  app.bus.on('local:write-question-from-outside', onWriteQuestionOutside); // 新增
  app.bus.on('local:status-changed', onLocalStatusChanged);

  overlayWindow.once('closed', () => {
    // 清理监听器（防止内存泄漏）
    app.bus.off('asr:interim', onAsrInterim);
    app.bus.off('asr:final', onAsrFinal);
    app.bus.off('asr:answer-start', onAnswerStart);
    app.bus.off('asr:answer-generated', onAnswerGenerated);
    app.bus.off('asr:recording-status', onRecordingStatus);
    app.bus.off('local:write-answer-from-outside', onWriteOutside);
    app.bus.off('local:write-question-from-outside', onWriteQuestionOutside); // 新增清理
    app.bus.off('local:status-changed', onLocalStatusChanged);
    overlayWindow = null;

    // ★ 语义升级：关闭浮层 = 用户明确结束本场面试
    //   原子锁：如果 ipc-close 已经调了 _postSessionOnOverlayClose（_overlayCloseFlowHandled=true），这里就跳过；
    //   如果是用户 Alt+F4 直接关系统窗 / will-quit 关窗 → 没有走 IPC，则在 closed 事件里兜底调用 post close。
    Promise.resolve().then(async () => {
      await new Promise((r) => setImmediate(r));
      try {
        if (!_overlayCloseFlowHandled) {
          await _postSessionOnOverlayClose({ from: 'closed-event' });
        }
      } catch (e) {
        console.error('[main][overlay][closed] _postSessionOnOverlayClose 异常:', e && e.message);
      } finally {
        // 不管成功失败，下一次 createOverlayWindow 的新关闭流程都能重新触发 post close
        _overlayCloseFlowHandled = false;
      }
    });
    // （停止 ASR 不在此处：用户关面板时不自动停 ASR，允许主窗口继续录，随时 reopen 继续显示）
  });

  overlayWindow.loadFile(path.join(__dirname, 'overlay.html')).then(() => {
    overlayWindow.show();
    // 加载完成后立刻同步一次当前状态（如果 ASR 已运行，不会丢字）
    try {
      if (asrPipeline && asrPipeline.isRunning) {
        overlayWindow.webContents.send('asr:recording-status', true);
      } else {
        overlayWindow.webContents.send('asr:recording-status', false);
      }
    } catch (_) { /* 忽略 */ }
  }).catch((err) => {
    console.error('[overlay] load overlay.html 失败:', err);
  });

  // 开发模式下也可以打开 overlay DevTools（调试时用 --dev --overlay-dev）
  if (process.argv.includes('--overlay-dev')) {
    overlayWindow.webContents.openDevTools({ mode: 'detach' });
  }
  return overlayWindow;
}

/**
 * 关闭/销毁答题面板窗口（不停 ASR）。
 */
function closeOverlayWindow() {
  if (!overlayWindow) return;
  try {
    if (!overlayWindow.isDestroyed()) overlayWindow.close();
  } catch (_) { /* 忽略 */ }
  overlayWindow = null;
}

/**
 * 浮动答题面板被关闭后的统一后处理（不管是点×按钮 / IPC close-overlay / 系统关窗 都会到这里）：
 *   1) 兜底把本场面试 endActiveSession（点叉号代表结束本场面试 —— 用户明确要求）
 *   2) 把主窗口 show + focus（弹出主窗口）
 *   3) 给主窗口 webContents.send('overlay:closed-post-session', payload)
 *      触发 renderer 显示两按钮横幅（查看本场 / 开启新的面试）
 *
 * 加 _lastOverlayClosePayload 幂等保护：一次窗口关闭过程只会真正执行一次，
 * 避免 close-overlay IPC 同步 end + overlayWindow 'closed' 再次 end 造成重复。
 *
 * @param {{from?:string}} [opts]  调试用来源：'ipc-close' / 'closed-event'
 */
let _lastOverlayPostCloseToken = 0;
/**
 * 标记：本次关闭流程里，是否已经真正执行过 endActiveSession（不管成功与否）。
 * 避免：IPC close-overlay 先 await post close → 关窗 → window.closed 事件 setImmediate 前 token 被
 *       下一次 open-overlay 里 ensure → startNewSession 又推进 token → 导致 closed 事件"误判 IPC 没执行"进而再 end 一次（no_active_session 无伤但日志冗余）。
 *       用独立布尔做一次关闭的原子锁更稳：同一个 overlayWindow.closed 生命周期内只执行一次真正后处理。
 */
let _overlayCloseFlowHandled = false;
async function _postSessionOnOverlayClose(opts) {
  const from = (opts && typeof opts.from === 'string') ? opts.from : 'unknown';
  // 原子锁：同一关闭流程只做一次真实 post close（多入口不会重复 end）
  if (_overlayCloseFlowHandled) {
    console.log(`[main][overlay-post-close] 跳过（本关闭流程已处理过），from=${from}`);
    void opts;
    return;
  }
  _overlayCloseFlowHandled = true;
  const token = ++_lastOverlayPostCloseToken;
  const originClosedAt = Date.now();
  let endRes = null;
  try {
    // --- 1) 结束本场面试（用户点浮动面板右上角 × = 结束本场）---
    try {
      await ensureLocalHttpServerWithBus();
      if (_lastOverlayPostCloseToken !== token) return; // 保护：快速连关窗口不要复用过期 token
      if (localHttpServer && typeof localHttpServer.endActiveSession === 'function') {
        endRes = localHttpServer.endActiveSession();
        console.log(`[main][overlay-post-close] endActiveSession：ended=${!!(endRes && endRes.ended)} sessionId=${String((endRes && endRes.session && (endRes.session.sessionId || endRes.session.id)) || '').slice(0,10)} from=${from}`);
      }
    } catch (e) {
      console.error('[main][overlay-post-close] endActiveSession 异常:', e && e.message);
    }

    // --- 2) 显示并聚焦主窗口 ---
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }
    } catch (e) {
      console.error('[main][overlay-post-close] 显示主窗口异常:', e && e.message);
    }
    if (_lastOverlayPostCloseToken !== token) return;

    // --- 3) 组合 payload 广播给主窗口 renderer ---
    const s = (localHttpServer && localHttpServer.state) ? localHttpServer.state : {};
    let endedSession = (endRes && endRes.session) ? endRes.session : null;
    const sessionId = (endedSession && (endedSession.sessionId || endedSession.id)) ? String(endedSession.sessionId || endedSession.id)
      : (s.activeSessionId ? String(s.activeSessionId) : null);
    let roundsCount = Number((endedSession && (endedSession.roundsCount || (Array.isArray(endedSession.rounds) ? endedSession.rounds.length : 0))) || 0);
    let company = '';
    let position = '';
    if (endedSession && endedSession.config && typeof endedSession.config === 'object') {
      company = String(endedSession.config.targetCompany || '').trim();
      position = String(endedSession.config.targetPosition || '').trim();
    }
    if (!company && endedSession) company = String(endedSession.targetCompany || '').trim();
    if (!position && endedSession) position = String(endedSession.targetPosition || '').trim();
    company = company || '未知公司';
    position = position || '未知职位';
    let endedAt = Number((endedSession && endedSession.endedAt) || 0) || originClosedAt;
    let startedAt = Number((endedSession && endedSession.startedAt) || 0);

    // 如果 endRes 是 no_active_session（之前已被其他方式结束）且拿到了 sessionId，尝试再查详情以便正确显示 roundsCount
    if ((!endedSession || roundsCount <= 0) && sessionId && localHttpServer && typeof localHttpServer.getSessionDetail === 'function') {
      try {
        const det = localHttpServer.getSessionDetail(sessionId);
        if (det && det.ok && det.session) {
          endedSession = det.session;
          roundsCount = Number((endedSession && (endedSession.roundsCount || (Array.isArray(endedSession.rounds) ? endedSession.rounds.length : 0))) || 0);
          if (endedSession.config && typeof endedSession.config === 'object') {
            const c2 = String(endedSession.config.targetCompany || '').trim();
            const p2 = String(endedSession.config.targetPosition || '').trim();
            if (c2) company = c2;
            if (p2) position = p2;
          }
          endedAt = Number(endedSession.endedAt) || endedAt;
          startedAt = Number(endedSession.startedAt) || startedAt;
        }
      } catch (_) { /* ignore */ }
    }

    const payload = {
      ok: true,
      from,
      sessionId,
      roundsCount,
      endedAt,
      startedAt,
      company: company || '未知公司',
      position: position || '未知职位',
      endResError: (endRes && !endRes.ok) ? String(endRes.error || '') : '',
      endResMsg:   (endRes && !endRes.ok) ? String(endRes.msg   || '') : '',
    };
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('overlay:closed-post-session', payload);
      }
    } catch (e) {
      console.error('[main][overlay-post-close] 广播异常:', e && e.message);
    }
    void opts;
  } catch (e) {
    console.error('[main][overlay-post-close] 外层异常:', e && e.message);
  }
}

/**
 * 获取 overlay 当前状态（用于 copilot.js 的「重新打开按钮」disabled 判断）
 */
function getOverlayStatus() {
  const exists = !!(overlayWindow && !overlayWindow.isDestroyed());
  let bounds = null;
  if (exists) {
    try { bounds = overlayWindow.getBounds(); } catch (_) {}
  }
  return { exists, bounds };
}

ipcMain.handle('close-overlay', async () => {
  // ★ 语义升级：用户点浮动面板右上角 × = 结束本场面试 + 显示主窗口 + 弹两按钮横幅 + 关浮层
  // 顺序保证：
  //  1) 先同步 await _postSessionOnOverlayClose（endActiveSession 同步 flush 写 session endedAt=ended 到 logs/sessions/，并推 token）
  //  2) 再 closeOverlayWindow() → closed 事件因 snapshotToken != token（token 已推进）会跳过 end 兜底，避免重复 no_active_session
  //  3) 最后返回 {success:true}
  try {
    await _postSessionOnOverlayClose({ from: 'ipc-close' });
  } catch (e) {
    console.error('[main][close-overlay] post close 异常：', e && e.message);
  }
  closeOverlayWindow();
  return { success: true };
});

/**
 * 答题面板 IPC：open-overlay
 * 由 copilot.js 开始面试辅助 / 重新打开答题面板 触发。
 * 语义升级：如果上一场刚被用户显式 × 结束（_lastEndedSessionId 标记存在）→ 在开浮层前强制开新场，
 *           确保"重新打开答题面板"不会落到/继续刚才那一场已经结束的面试记录。
 */
ipcMain.handle('open-overlay', async () => {
  // 先做切场边界判断（结束 → 新场）
  try {
    await ensureLocalHttpServerWithBus();
    if (localHttpServer && typeof localHttpServer.ensureStartNewSessionIfJustEnded === 'function') {
      const r = localHttpServer.ensureStartNewSessionIfJustEnded(undefined);
      if (r && r.openedNew) {
        console.log(`[main][open-overlay] ✅ 检测到上一场刚显式结束，已自动开启新一场 session=${String((r.session && r.session.id) || '').substring(0, 8)}... | closedPreviousId=${String(r.closedPreviousId || '').substring(0, 8)}...`);
      }
    }
  } catch (e) {
    console.error('[main][open-overlay] ensure-if-ended 异常：', e && e.message);
  }
  const w = createOverlayWindow();
  const ok = !!(w && !w.isDestroyed());
  return { success: ok, status: getOverlayStatus() };
});

/**
 * 答题面板 IPC：overlay-status
 * copilot 页面轮询/按钮点击时调用，用于显示「重新打开」按钮。
 */
ipcMain.handle('overlay-status', () => getOverlayStatus());

/**
 * ⭐ 答题面板 IPC：overlay-full-status
 * -----------------------------
 * 背景：答题面板窗口(overlayWindow)是通过 loadFile(file://) 加载的 overlay.html；
 *       因此渲染层里的 fetch('/api/overlay/status') 相对路径会被解析成
 *       file:///api/overlay/status → 读本地磁盘不存在的文件 → 永远拿不到数据，
 *       导致"面板显示不出 H5/小程序/ASR 写入的多轮历史"。
 *
 * 功能：本 IPC 不走网络，直接从内存里的 localHttpServer.state 拿最新快照，
 *       结构与 /api/overlay/status 完全对齐（渲染层可按同一结构使用）。
 *       即便用户还没点二维码（HTTP 服务未 start）也能返回 state（面板/ASR 场景
 *       还没启动伴生设备也需要显示历史）。
 *
 * 返回：{
 *   ok: true,
 *   asrText, answerText, questionImage, isRecording, lastAnswerAt,
 *   history: [...],          // 正序数组，最近 10 轮
 *   historyVersion: number   // 历史变更版本号
 * }
 */
ipcMain.handle('overlay-full-status', () => {
  try {
    // 即便 localHttpServer 单例还没初始化 state 属性（极端场景），也做兜底：空结构 + ok:true
    const s = (localHttpServer && localHttpServer.state) ? localHttpServer.state : {};
    return {
      ok: true,
      asrText: String(s.asrText || ''),
      answerText: String(s.answerText || ''),
      questionImage: String(s.questionImage || ''),
      isRecording: !!s.isRecording,
      lastAnswerAt: Number(s.lastAnswerAt) || 0,
      // 多轮对话历史（正序数组，最近 10 轮）：与 _routeApiOverlayStatus 完全一致
      history: Array.isArray(s.history) ? s.history : [],
      historyVersion: Number(s.historyVersion) || 0,
      // 面试 Session：当前进行中 + 版本号（主窗口 viewRouter 轮询刷新列表/详情时可对比）
      activeSessionId: s.activeSessionId || null,
      sessionsVersion: Number(s.sessionsVersion) || 0,
    };
  } catch (e) {
    // IPC 抛错时返回 ok:false + 错误信息，让渲染层能打出日志定位，避免静默白屏
    console.error('[main] overlay-full-status 异常:', e && e.message);
    return {
      ok: false,
      error: 'internal',
      msg: e && e.message ? e.message : 'unknown',
      history: [],
      historyVersion: 0,
    };
  }
});

/**
 * 答题面板 IPC：resize-overlay（8 向缩放）
 * 方向 n/s/e/w/nw/ne/sw/se，dx/dy 是相对位移；通过 setBounds 完成。
 */
ipcMain.handle('resize-overlay', (event, direction, dx, dy) => {
  if (!overlayWindow || overlayWindow.isDestroyed()) return { success: false };
  try {
    const [W, H] = overlayWindow.getSize();
    const [X, Y] = overlayWindow.getPosition();
    const minW = 320, minH = 360;
    let nw = W, nh = H, nx = X, ny = Y;
    if (String(direction).includes('e')) nw = Math.max(minW, W + (dx | 0));
    if (String(direction).includes('s')) nh = Math.max(minH, H + (dy | 0));
    if (String(direction).includes('w')) {
      const dw = dx | 0;                 // 负 = 右移右边界 = 变宽
      nw = Math.max(minW, W - dw);
      nx = X + (W - nw);                 // 左侧不动点：保持右边界像素不变
    }
    if (String(direction).includes('n')) {
      const dh = dy | 0;
      nh = Math.max(minH, H - dh);
      ny = Y + (H - nh);                 // 下边界不动
    }
    overlayWindow.setBounds({ x: nx, y: ny, width: nw, height: nh });
    return { success: true };
  } catch (e) {
    console.error('[resize-overlay] 失败:', e.message);
    return { success: false, error: e.message };
  }
});

/**
 * 答题面板 IPC：move-overlay（快捷键平移备用）
 */
ipcMain.handle('move-overlay', (event, direction) => {
  if (!overlayWindow || overlayWindow.isDestroyed()) return { success: false };
  try {
    const step = 30;
    const [x, y] = overlayWindow.getPosition();
    const [w, h] = overlayWindow.getSize();
    const disp = screen.getDisplayNearestPoint({ x, y });
    const wa = disp.workArea;
    let nx = x, ny = y;
    switch (direction) {
      case 'up':    ny = Math.max(wa.y, y - step); break;
      case 'down':  ny = Math.min(wa.y + wa.height - h, y + step); break;
      case 'left':  nx = Math.max(wa.x, x - step); break;
      case 'right': nx = Math.min(wa.x + wa.width - w, x + step); break;
    }
    overlayWindow.setPosition(nx, ny);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// 持续监听 - 开始监听（旧：渲染层 getDisplayMedia 模式）
ipcMain.handle('start-listening', (event, sensitivity = 5) => {
  return audioService.startListening(sensitivity);
});

// 持续监听 - 添加音频数据
ipcMain.handle('add-audio-chunk', (event, chunk) => {
  const result = audioService.addAudioChunk(chunk);
  return result;
});

// 持续监听 - 停止监听（旧：渲染层 getDisplayMedia 模式）
ipcMain.handle('stop-listening', () => {
  return audioService.stopListening();
});

// ============================================================
// WASAPI 原生系统音频采集 + 百度 ASR + AI 答题（新模式）
// 不依赖渲染层 getDisplayMedia，无弹窗，主进程直采
// ============================================================

/**
 * 启动面试辅助管线
 * 渲染层 invoke('start-asr-pipeline', config) 触发：
 *   1. WASAPI Loopback 采集系统音频
 *   2. 百度实时 ASR WebSocket 识别
 *   3. 问题检测
 *   4. AI 答题
 * 结果通过 3 种通道广播：
 *   - app.bus.emit → overlayWindow / HTTP+WS 中继订阅
 *   - broadcastToAllViews → 主窗口 + overlay 窗口的 webContents
 *   - 同时保留旧通道（asr:interim/asr:final/asr:answer/asr:status/asr:error）
 *     供 copilot.js 现存逻辑兼容
 */
ipcMain.handle('start-asr-pipeline', async (event, config) => {
  try {
    // ====== ★ 前置保障：必须确保 localHttpServer.start + _attachBus 已执行 ======
    //   否则 asrPipeline 发出的 bus 事件没人订阅 → history 轮不创建 → 面板不显示本轮对话
    //   失败降级：仍继续启动管线，ASR/AI 会照常执行，仅面板历史为空
    await ensureLocalHttpServerWithBus();

    // 如果管线已在运行，先停止
    if (asrPipeline && asrPipeline.isRunning) {
      await asrPipeline.stop();
      app.bus.emit('asr:recording-status', false);
    }

    // 合并环境变量（.env 中的百度 Key 作为兜底）
    const mergedConfig = Object.assign({}, config, {
      baiduApiKey: config.baiduApiKey || process.env.BAIDU_API_KEY,
      baiduSecretKey: config.baiduSecretKey || process.env.BAIDU_SECRET_KEY,
      baiduAppId: config.baiduAppId || process.env.BAIDU_APP_ID
    });

    // 创建管线实例
    asrPipeline = new ASRPipeline();

    // ★ P1-1/P3-1：把 app.bus 注入到管线实例（作为 emitBus 函数），
    //   让管线在"开始 AI 答题前"直接发 asr:question-asked 创建提问轮，
    //   以及"AI 成功/失败"都直接发 asr:answer-generated 结算 history（失败写 error）
    asrPipeline.emitBus = (evt, payload) => {
      try { app.bus.emit(evt, payload); } catch (e) {
        console.error(`[main] asrPipeline.emitBus(${evt}) 失败:`, e && e.message);
      }
    };
    // ★ P3-2：跨入口共享上下文函数：从 localHttpServer.state.history 反向组装最近 5 轮 {role,content}
    //   这样如果用户先在手机 H5 上提问，再回到系统声音识别，AI 也能看到前面的对话历史
    asrPipeline.getSharedContext = () => {
      try {
        const s = (localHttpServer && localHttpServer.state) ? localHttpServer.state : null;
        const arr = (s && Array.isArray(s.history)) ? s.history : [];
        const out = [];
        // 取最近 5 轮（10 条消息，每轮 user + assistant 各一条）
        const rounds = arr.slice(-5);
        for (const r of rounds) {
          const q = (r && r.questionText) ? String(r.questionText).trim() : '';
          const a = (r && r.answerText) ? String(r.answerText).trim() : '';
          if (q) out.push({ role: 'user', content: q });
          if (a && (r.status === 'answered' || r.status === 'error')) {
            out.push({ role: 'assistant', content: a });
          }
        }
        return out;
      } catch (e) {
        console.warn('[main] asrPipeline.getSharedContext 异常:', e && e.message);
        return [];
      }
    };

    // 注册回调：app.bus.emit 解耦 + 双窗口 webContents.send
    asrPipeline.onInterim = (text) => {
      app.bus.emit('asr:interim', text);
      broadcastToAllViews('asr:interim', text);
    };
    asrPipeline.onFinal = (text) => {
      app.bus.emit('asr:final', text);
      broadcastToAllViews('asr:final', text);
    };
    // 问题检测完成 → AI 开始答题前：发 answer-start 用于 overlay 显示 ⏳
    asrPipeline.onBeforeAnswer = (question) => {
      app.bus.emit('asr:answer-start', question || '');
      broadcastToAllViews('asr:answer-start', question || '');
    };
    // ★ P1-2：asrPipeline.onAnswer 现在回传对象 {text, question, durationMs, error}
    //   - 兼容：如果上游还是传字符串（其他入口），兜底归一化
    asrPipeline.onAnswer = (payload) => {
      // 归一化为对象
      const p = (payload && typeof payload === 'object')
        ? payload
        : { text: String(payload || ''), question: '', durationMs: 0, error: '' };
      const answerText = String(p.text || '');
      const question = String(p.question || '');
      const hasError = !!(p.error && String(p.error).trim().length);
      // bus 发"统一对象版本"（localHttpServer 用它结算 history）
      // ★ 注意：这里再补一次 bus，保证即使 asrPipeline 内部 emitBus 没走到（例如构造异常），
      //         history 也能被正确更新；asrPipeline 内部发的那次是"更早的保证"，二者不冲突，
      //         localHttpServer 的 finishHistoryRound 内若已结算会幂等（historyVersion 会 bump 两次但无副作用）
      app.bus.emit('asr:answer-generated', {
        text: answerText,
        question,
        error: hasError ? String(p.error) : '',
        durationMs: Number(p.durationMs) || 0,
      });
      // 给主窗口 + overlay 窗口渲染端 IPC 广播（渲染端 onAnswerGenerated 处理）
      broadcastToAllViews('asr:answer-generated', {
        text: answerText,
        question,
        error: hasError ? String(p.error) : '',
      });
      // 兼容老通道 asr:answer（给 copilot.js / 旧 renderer 逻辑，纯 answer 文本）
      const senderWin = BrowserWindow.fromWebContents(event.sender);
      if (senderWin && !senderWin.isDestroyed()) {
        if (hasError) {
          // 失败场景：把错误信息以文本形式也发过去，避免老 UI 空白
          senderWin.webContents.send('asr:answer', `【AI 生成失败】${p.error}`);
        } else {
          senderWin.webContents.send('asr:answer', answerText);
        }
      }
      // 伴生设备（手机/iPad 实时查看）广播：成功才广播 answer；失败广播 error 事件
      try {
        if (hasError) {
          relayServer.broadcast({ type: 'answer-error', question, error: String(p.error) });
        } else {
          relayServer.broadcast({ type: 'answer', question, answer: answerText || '' });
        }
      } catch (_) { /* relayServer 未启动忽略 */ }
    };
    asrPipeline.onError = (message) => {
      console.error('[main] ASR 管线错误:', message);
      app.bus.emit('asr:error', message);
      broadcastToAllViews('asr:error', message);
    };
    asrPipeline.onStatus = (status) => {
      console.log('[main] ASR 管线状态:', status);
      // status 常见值：started / running / paused / stopped；翻译成 recording 布尔
      const recording = status === 'started' || status === 'running';
      app.bus.emit('asr:recording-status', recording);
      broadcastToAllViews('asr:recording-status', recording);
      // 兼容老通道 asr:status（传原文字符串）
      broadcastToAllViews('asr:status', status);
    };

    // 启动管线
    await asrPipeline.start(mergedConfig, {});
    // 启动后显式广播一次 recording=true（防止 onStatus 先于管线 start 回调的 race）
    app.bus.emit('asr:recording-status', true);
    broadcastToAllViews('asr:recording-status', true);
    // ★ 缓存最后一次启动成功的完整 config，供面板端 toggle-asr-pipeline 独立启动时复用
    lastAsrConfig = mergedConfig;

    return { success: true };
  } catch (error) {
    console.error('[main] 启动 ASR 管线失败:', error);
    return { success: false, error: error.message };
  }
});

/**
 * 停止面试辅助管线
 */
ipcMain.handle('stop-asr-pipeline', async () => {
  try {
    if (asrPipeline) {
      await asrPipeline.stop();
      asrPipeline = null;
    }
    app.bus.emit('asr:recording-status', false);
    broadcastToAllViews('asr:recording-status', false);
    return { success: true };
  } catch (error) {
    console.error('[main] 停止 ASR 管线失败:', error);
    return { success: false, error: error.message };
  }
});

// ============================================================
// 面板端专用：一键"开始/停止识别系统声音"切换
//   - 设计要点：
//     1) 状态锁：_asrToggleBusy 期间不接受新请求（避免短时间多次启停抖动）
//     2) 停止：无条件调用 stop-asr-pipeline，即使当前没在运行也视为成功（幂等）
//     3) 启动：必须有 lastAsrConfig 缓存才能"直接启动"；
//              如果 lastAsrConfig 为空（用户从未在主窗口启动过）→ 返回 needMainConfig=true，
//              渲染端提示"请先在主窗口完成 API Key 等设置并点一次『开始面试辅助』"
// ============================================================
let _asrToggleBusy = false;
ipcMain.handle('toggle-asr-pipeline', async () => {
  if (_asrToggleBusy) {
    return { success: false, error: '正在切换状态，请稍候再试', busy: true };
  }
  _asrToggleBusy = true;
  try {
    const isRunning = !!(asrPipeline && asrPipeline.isRunning);
    if (isRunning) {
      // ---- 态：识别中 → 停止 ----
      const res = await ipcMain.emit ? null : null; // 占位，真正走下面逻辑
      // 直接复用 stop-asr-pipeline 的处理（避免重复代码）
      try {
        if (asrPipeline) {
          await asrPipeline.stop();
          asrPipeline = null;
        }
        app.bus.emit('asr:recording-status', false);
        broadcastToAllViews('asr:recording-status', false);
      } catch (e) {
        return { success: false, error: `停止失败：${e.message}` };
      }
      return { success: true, action: 'stopped', isRecording: false };
    } else {
      // ---- 态：未识别 → 启动 ----
      if (!lastAsrConfig) {
        return {
          success: false,
          needMainConfig: true,   // 渲染端据此给出"请回主窗口先启动一次"的提示
          error: '暂无可复用的配置，请先在主窗口完成设置并点击「开始面试辅助」至少一次',
        };
      }
      // ====== ★ 前置保障：同 start-asr-pipeline，确保 localHttpServer + bus 订阅已就绪 ======
      //   面板点「一键启动识别」走的就是这条入口，原来经常漏掉 _attachBus → 面板不显示本轮
      await ensureLocalHttpServerWithBus();
      // 复用 start-asr-pipeline 的完整逻辑：通过 ipcMain.handle 注册的函数无法直接复用，
      // 所以这里直接通过 invoke 的方式从"事件层面"触发——但 ipcMain.handle 注册的 handler
      // 只接受渲染端 invoke 调用，主进程内部得重走一遍。
      // 简便做法：直接把 start-asr-pipeline 内的创建步骤在内部再跑一次（避免引入循环 invoke 依赖）
      const mergedConfig = lastAsrConfig;
      if (asrPipeline && asrPipeline.isRunning) {
        try { await asrPipeline.stop(); } catch (_) {}
        asrPipeline = null;
      }
      asrPipeline = new ASRPipeline();
      // 注入 bus / 共享上下文（与 start-asr-pipeline 中完全一致）
      asrPipeline.emitBus = (evt, payload) => {
        try { app.bus.emit(evt, payload); } catch (e) {
          console.error(`[main][toggle] asrPipeline.emitBus(${evt}) 失败:`, e && e.message);
        }
      };
      asrPipeline.getSharedContext = () => {
        try {
          const s = (localHttpServer && localHttpServer.state) ? localHttpServer.state : null;
          const arr = (s && Array.isArray(s.history)) ? s.history : [];
          const out = [];
          const rounds = arr.slice(-5);
          for (const r of rounds) {
            const q = (r && r.questionText) ? String(r.questionText).trim() : '';
            const a = (r && r.answerText) ? String(r.answerText).trim() : '';
            if (q) out.push({ role: 'user', content: q });
            if (a && (r.status === 'answered' || r.status === 'error')) {
              out.push({ role: 'assistant', content: a });
            }
          }
          return out;
        } catch (e) {
          console.warn('[main][toggle] asrPipeline.getSharedContext 异常:', e && e.message);
          return [];
        }
      };
      // 注册回调（与 start-asr-pipeline 中完全一致）
      asrPipeline.onInterim = (text) => {
        app.bus.emit('asr:interim', text);
        broadcastToAllViews('asr:interim', text);
      };
      asrPipeline.onFinal = (text) => {
        app.bus.emit('asr:final', text);
        broadcastToAllViews('asr:final', text);
      };
      asrPipeline.onBeforeAnswer = (question) => {
        app.bus.emit('asr:answer-start', question || '');
        broadcastToAllViews('asr:answer-start', question || '');
      };
      asrPipeline.onAnswer = (payload) => {
        const p = (payload && typeof payload === 'object')
          ? payload
          : { text: String(payload || ''), question: '', durationMs: 0, error: '' };
        const answerText = String(p.text || '');
        const question = String(p.question || '');
        const hasError = !!(p.error && String(p.error).trim().length);
        app.bus.emit('asr:answer-generated', {
          text: answerText, question,
          error: hasError ? String(p.error) : '',
          durationMs: Number(p.durationMs) || 0,
        });
        broadcastToAllViews('asr:answer-generated', {
          text: answerText, question,
          error: hasError ? String(p.error) : '',
        });
      };
      asrPipeline.onError = (message) => {
        console.error('[main][toggle] ASR 管线错误:', message);
        app.bus.emit('asr:error', message);
        broadcastToAllViews('asr:error', message);
      };
      asrPipeline.onStatus = (status) => {
        const recording = status === 'started' || status === 'running';
        app.bus.emit('asr:recording-status', recording);
        broadcastToAllViews('asr:recording-status', recording);
        broadcastToAllViews('asr:status', status);
      };
      try {
        await asrPipeline.start(mergedConfig, {});
        app.bus.emit('asr:recording-status', true);
        broadcastToAllViews('asr:recording-status', true);
        // 启动成功 → 再缓存一次（理论上 lastAsrConfig 本来就是最新的，防御性写入）
        lastAsrConfig = mergedConfig;
        return { success: true, action: 'started', isRecording: true };
      } catch (e) {
        return { success: false, error: `启动失败：${e.message}` };
      }
    }
  } catch (error) {
    console.error('[main] toggle-asr-pipeline 异常:', error);
    return { success: false, error: error.message };
  } finally {
    _asrToggleBusy = false;
  }
});

// 面板端专用：查 ASR 当前运行态 + 是否有可用 config
ipcMain.handle('get-asr-status', () => {
  return {
    success: true,
    isRecording: !!(asrPipeline && asrPipeline.isRunning),
    hasCachedConfig: !!lastAsrConfig,
  };
});

// 检测文本是否是问题
ipcMain.handle('detect-question', (event, text, sensitivity = 5) => {
  const isQuestion = audioService.detectQuestion(text, sensitivity);
  return { isQuestion };
});

// 处理识别的文本，判断是否需要自动生成答案
// ★ P2-1 修复：这条"主窗口老流程"也必须写入 localHttpServer.state.history（系统B），
//              否则面板/H5 端根本看不到主窗口产生的问答轮（两套历史分家）。
//              做法：AI 开始前 bus.emit('asr:question-asked') 创建提问轮，
//                   AI 完成/失败 bus.emit('asr:answer-generated') 结算。
ipcMain.handle('process-recognized-text', async (event, text, config, conversationHistory, resumeContent) => {
  try {
    const sensitivity = config.detectionSensitivity || 5;
    const isQuestion = audioService.detectQuestion(text, sensitivity);
    const questionText = String(text || '').trim();

    const _origLog = console.error;
    _origLog(`[process-recognized-text] 文本: ${text}`);
    _origLog(`[process-recognized-text] 问题检测: ${isQuestion}`);
    _origLog(`[process-recognized-text] 简历内容: ${resumeContent?.length || 0} 字符`);

    if (isQuestion) {
      // 发送桌面通知
      showNotification('✨ 检测到新问题', questionText.substring(0, 50) + (questionText.length > 50 ? '...' : ''));

      // ★ 先创建提问轮（让面板/H5 立刻看到本轮 ⏳ 正在生成）—— 与 ASR 新链路保持一致
      try {
        app.bus.emit('asr:question-asked', { question: questionText, source: 'main-window-asr' });
      } catch (_) { /* 忽略 */ }

      // 隐私审计：记录 AI 请求
      const prompt = aiService.buildPrompt(
        questionText,
        config.interviewScene,
        conversationHistory || [],
        resumeContent || ''
      );
      privacyAudit.logNetworkRequest(
        config.selectedService === 'tongyi' ? 'dashscope.aliyuncs.com' :
        config.selectedService === 'wenxin' ? 'aip.baidubce.com' :
        config.selectedService === 'zhipu' ? 'open.bigmodel.cn' : 'unknown',
        'POST',
        'answer_generation',
        Buffer.byteLength(new TextEncoder().encode(prompt), 'utf-8')
      );

      _origLog(`[process-recognized-text] 开始调用 AI: ${config.selectedService}`);
      const startTime = Date.now();

      let answer = '';
      let aiError = '';
      try {
        answer = await aiService.generateAnswer(
          questionText,
          config.interviewScene,
          config.selectedService,
          config,
          conversationHistory || [],
          resumeContent || '',
          config.modelTier
        );
      } catch (e) {
        aiError = `AI 生成失败：${e.message || '未知错误'}`;
        _origLog(`[process-recognized-text] AI 异常: ${aiError}`);
      }

      const duration = Date.now() - startTime;

      // 隐私审计：记录响应
      privacyAudit.logNetworkResponse(
        config.selectedService === 'tongyi' ? 'dashscope.aliyuncs.com' :
        config.selectedService === 'wenxin' ? 'aip.baidubce.com' :
        config.selectedService === 'zhipu' ? 'open.bigmodel.cn' : 'unknown',
        Buffer.byteLength(new TextEncoder().encode(answer || '', 'utf-8')),
        duration,
        !aiError
      );

      _origLog(`[process-recognized-text] AI 完成: ${answer?.length || 0} 字符，耗时 ${duration}ms`);

      // ★ 结算 history：成功/失败都用统一 bus 发（系统B同步）
      try {
        app.bus.emit('asr:answer-generated', {
          text: answer || '',
          question: questionText,
          error: aiError,
          durationMs: duration,
          source: 'main-window-asr',
        });
      } catch (_) { /* 忽略 */ }

      // 广播给伴生设备（手机/iPad 实时查看问答）
      try {
        if (aiError) {
          relayServer.broadcast({ type: 'answer-error', question: questionText, error: aiError });
        } else {
          relayServer.broadcast({ type: 'answer', question: questionText, answer: answer || '' });
        }
      } catch (_) { /* 忽略 */ }

      // 异常场景在返回值里也带 error，让主窗口 renderer 能提示
      if (aiError) {
        return { isQuestion: true, answer: '', question: questionText, error: aiError };
      }
      return { isQuestion: true, answer, question: questionText };
    }

    return { isQuestion: false, question: questionText };
  } catch (error) {
    const _origLog = console.error;
    _origLog(`[process-recognized-text] 错误: ${error.message}`);
    return { error: error.message };
  }
});

// 发送桌面通知
ipcMain.handle('send-notification', (event, title, body) => {
  showNotification(title, body);
  return { success: true };
});

// ============================================================
// 简历上传与管理
// ============================================================

// 简历数据路径
const resumePath = path.join(userDataPath, 'resume.md');

// 选择并读取简历文件
ipcMain.handle('select-resume-file', async () => {
  const { dialog } = require('electron');

  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择简历文件',
    filters: [
      { name: 'Markdown Files', extensions: ['md', 'markdown'] },
      { name: 'Text Files', extensions: ['txt'] },
      { name: 'All Files', extensions: ['*'] }
    ],
    properties: ['openFile']
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { success: false, error: '用户取消' };
  }

  try {
    const content = fs.readFileSync(result.filePaths[0], 'utf-8');
    return { success: true, content, filePath: result.filePaths[0] };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// 保存简历内容
ipcMain.handle('save-resume', async (event, content) => {
  try {
    fs.writeFileSync(resumePath, content, 'utf-8');

    // 隐私审计：数据保存操作
    privacyAudit.logDataOperation('resume', 'save', Buffer.byteLength(content, 'utf-8'));

    // 检测敏感信息
    const sensitiveInfo = privacyAudit.detectSensitiveInfo(content);
    if (sensitiveInfo.length > 0) {
      privacyAudit.logSensitiveData('resume', 'multiple_detected', '简历内容');
      return {
        success: true,
        warning: '简历中检测到敏感信息，请注意隐私保护',
        detected: sensitiveInfo
      };
    }

    // 更新状态
    stateManager.update('resume.content', content);
    stateManager.update('resume.filePath', resumePath);
    stateManager.update('resume.lastModified', Date.now());

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// 加载保存的简历
ipcMain.handle('load-resume', async () => {
  try {
    if (fs.existsSync(resumePath)) {
      const content = fs.readFileSync(resumePath, 'utf-8');
      return { success: true, content };
    }
    return { success: false, error: '简历不存在' };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// 删除保存的简历
ipcMain.handle('delete-resume', async () => {
  try {
    if (fs.existsSync(resumePath)) {
      fs.unlinkSync(resumePath);
    }
    // 更新状态
    stateManager.update('resume.content', '');
    stateManager.update('resume.filePath', null);
    stateManager.update('resume.lastModified', null);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// ============================================================
// 状态管理 IPC 处理
// ============================================================

// 获取恢复数据
ipcMain.handle('get-recovery-data', () => {
  return stateManager.getRecoveryData();
});

// 恢复会话
ipcMain.handle('restore-session', async (event, data) => {
  try {
    // 恢复简历内容
    if (data.resume?.content) {
      appState.resumeContent = data.resume.content;
    }

    // 恢复对话历史
    if (data.conversation?.history && Array.isArray(data.conversation.history)) {
      appState.conversationHistory = data.conversation.history;
      appState.conversationTurns = data.conversation.currentTurns || 0;
    }

    // 恢复会话状态
    if (data.session) {
      stateManager.update('session', data.session);
    }

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// 更新会话状态
ipcMain.handle('update-session', (event, sessionData) => {
  stateManager.batchUpdate({
    'session': sessionData
  });
  return { success: true };
});

// 添加对话历史
ipcMain.handle('add-conversation-turn', (event, turnData) => {
  stateManager.update('conversation.history', [
    ...(stateManager.get('conversation.history') || []),
    turnData
  ]);
  const turns = stateManager.get('conversation.currentTurns') || 0;
  stateManager.update('conversation.currentTurns', turns + 1);

  const questionCount = stateManager.get('session.questionCount') || 0;
  stateManager.update('session.questionCount', questionCount + 1);

  return { success: true };
});

// 获取当前状态摘要
ipcMain.handle('get-state-summary', () => {
  return stateManager.getStateSummary();
});

// 手动保存状态
ipcMain.handle('save-state', () => {
  return stateManager.save();
});

// ============================================================
// 隐私审计 IPC 处理
// ============================================================

// 获取审计摘要
ipcMain.handle('get-privacy-summary', () => {
  return privacyAudit.getSummary();
});

// 获取最近审计日志
ipcMain.handle('get-privacy-logs', (event, limit) => {
  return privacyAudit.getRecentLogs(limit || 100);
});

// 导出审计报告
ipcMain.handle('export-privacy-report', () => {
  return privacyAudit.exportReport();
});

// 清空审计日志
ipcMain.handle('clear-privacy-audit', () => {
  return privacyAudit.clear();
});

// 检测敏感信息
ipcMain.handle('detect-sensitive-info', (event, text) => {
  return privacyAudit.detectSensitiveInfo(text);
});

// 临时显示窗口（高透明度）
ipcMain.handle('show-window-temporarily', () => {
  showWindowTemporarily();
  return { success: true };
});

// ============================================================
// ★ 小程序联动：本地 HTTP + WebSocket 服务 IPC 处理器
// 5 个通道：generate-qr / start-local-server / stop-local-server / get-server-status / disconnect-miniapp
// 所有通道独立 try/catch，单点失败不崩溃主进程
// ============================================================

/**
 * 截图核心实现：供 localHttpServer.captureFn 调用（WS + HTTP 共用同一份）
 * 流程：desktopCapturer.getSources 取主屏 → thumbnail.toJPEG/PNG → base64
 *       如果 maxSize 限制：二次用隐藏 BrowserWindow + canvas 等比缩放（简单起见，此处先取原图再压缩质量）
 * @param {{ format:'jpeg'|'png', quality:number, maxSize:number, sourceId:string|null }} payload
 * @returns {Promise<{ data:string, width:number, height:number, mime:string }>}
 */
async function doScreenshotForMiniapp(payload) {
  const fmt = (payload && payload.format === 'png') ? 'png' : 'jpeg';
  const quality = Number(payload && payload.quality);
  const q = (quality > 0 && quality <= 1) ? quality : 0.85;
  const maxSize = Number(payload && payload.maxSize) || 1920;
  const sourceId = (payload && payload.sourceId) || null;

  // 1. 枚举屏幕源（取主屏；sourceId 指定时用指定）
  let sources;
  try {
    sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: maxSize, height: Math.floor(maxSize * 0.6) } // 初始缩略图限制尺寸
    });
  } catch (e) {
    // desktopCapturer 抛错：通常是权限不足（屏幕录制被禁用）
    const err = new Error('CAPTURE_SOURCE_ERROR');
    err.code = 'permission';
    err.userMsg = '获取屏幕源失败：请在系统设置中允许本应用进行屏幕录制';
    throw err;
  }
  if (!sources || sources.length === 0) {
    const e = new Error('NO_SCREEN_SOURCE');
    e.code = 'unsupported';
    e.userMsg = '未检测到可用屏幕';
    throw e;
  }
  // 优先用 sourceId 匹配；否则用第一个（主屏）
  let src = sources[0];
  if (sourceId) {
    const found = sources.find(s => s.id === sourceId);
    if (found) src = found;
  }

  try {
    // 2. thumbnail 已被 Electron 缩放到指定尺寸，直接取图片
    const thumb = src.thumbnail;
    if (!thumb) {
      const e = new Error('EMPTY_THUMBNAIL');
      e.code = 'internal';
      e.userMsg = '截图缩略图为空，请重试';
      throw e;
    }
    let finalImg = thumb;
    let origW, origH;
    try {
      origW = thumb.getSize().width;
      origH = thumb.getSize().height;
    } catch (_) { origW = 0; origH = 0; }

    // 3. 如果缩略图超 maxSize，再压一次（通常不会触发，因为 thumbnailSize 已限制）
    if (origW > 0 && origH > 0 && (origW > maxSize || origH > maxSize)) {
      try {
        const scale = Math.min(maxSize / origW, maxSize / origH);
        finalImg = thumb.resize({
          width: Math.floor(origW * scale),
          height: Math.floor(origH * scale),
          quality: 'good'
        });
      } catch (_) { /* resize 失败就用原图，不能 crash */ }
    }

    // 4. 转 JPEG/PNG → base64
    let mime = 'image/jpeg';
    let buf;
    if (fmt === 'png') {
      mime = 'image/png';
      buf = finalImg.toPNG();
    } else {
      // JPEG quality: 0-100（Electron API 是百分制，非 0-1）
      const pct = Math.max(1, Math.min(100, Math.round(q * 100)));
      buf = finalImg.toJPEG(pct);
    }
    if (!buf || buf.length === 0) {
      const e = new Error('EMPTY_BUFFER');
      e.code = 'internal';
      e.userMsg = '生成截图数据为空，请重试';
      throw e;
    }
    let sz = { width: 0, height: 0 };
    try { sz = finalImg.getSize(); } catch (_) {}
    return {
      data: buf.toString('base64'),
      width: sz.width,
      height: sz.height,
      mime
    };
  } catch (e) {
    // 已经带 code/userMsg 的直接向上抛
    if (e.code) throw e;
    // 其他：包装成 internal
    const wrap = new Error('CAPTURE_PROCESS_ERROR');
    wrap.code = 'internal';
    wrap.userMsg = '截图处理失败：' + (e.message || '未知错误');
    throw wrap;
  }
}

/**
 * 确保 localHttpServer 的外部依赖（captureFn / loadConfigFn / bus）已挂载
 * 每次 start 前调用一次（幂等）。
 */
function attachLocalHttpServerExternals() {
  // 截图函数
  if (typeof localHttpServer.captureFn !== 'function') {
    localHttpServer.captureFn = doScreenshotForMiniapp;
  }
  // 配置读取函数（小程序 /api/connect 下发 AI/OCR/面试配置）
  if (typeof localHttpServer.loadConfigFn !== 'function') {
    localHttpServer.loadConfigFn = () => loadConfig();
  }
}

/**
 * ★ 启动系统声音识别/截图答题/面板多入口联动 的前置保障：确保 localHttpServer 已启动 + bus 订阅已挂载
 * --------------------------------------------------------------
 * 为什么要专门加这个？——
 *   localHttpServer._attachBus() 仅在 localHttpServer.start({bus}) 里被调用，
 *   而 start() 原来只在「生成二维码」「显式启动本地HTTP服务」两个 IPC 入口里才会跑。
 *   用户如果直接点「开始面试辅助」→ start-asr-pipeline / toggle-asr-pipeline，
 *   那么虽然 asrPipeline 会 bus.emit('asr:final' / 'asr:question-asked' / 'asr:answer-generated')，
 *   但 localHttpServer 里这 3 个订阅从未挂上，结果就是：
 *     - 面试官原文不写 history.questionText
 *     - history 轮从未创建
 *     - 答案 never 结算
 *     - 浮动答题面板 / H5 / 主窗口历史侧栏 全都不显示这一轮对话 ← ★ 就是你这次遇到的情况
 *
 * 行为：
 *   - 已经启动（status !== 'idle'）：直接 return true，零开销
 *   - idle：自动 attachExternals → start({bus:app.bus})；成功 true；失败打 warn 并返回 false（不阻断 ASR 管线，仅降级：面板不显示历史，但 ASR/AI 本身还能跑）
 */
async function ensureLocalHttpServerWithBus() {
  try {
    if (localHttpServer && localHttpServer.status !== 'idle') {
      return true; // 已启动（含 starting / listening / stopping）→ 不用重复
    }
    attachLocalHttpServerExternals();
    await localHttpServer.start({ bus: app.bus });
    console.log('[main] ✅ ensureLocalHttpServerWithBus：localHttpServer 已启动，bus 订阅已挂载（history 写入链路就绪）');
    return true;
  } catch (e) {
    // ALL_PORTS_BUSY / NO_IP 等启动失败：只警告，不阻断 ASR 管线
    const code = (e && e.message) || 'unknown';
    const msg = (e && e.userMsg) || (e && e.message) || '启动失败';
    console.warn(`[main] ⚠ ensureLocalHttpServerWithBus 启动失败（已降级：ASR/AI 仍会执行，但 history 轮不会写入，面板可能不显示本轮）code=${code} msg=${msg}`);
    return false;
  }
}

/**
 * IPC: generate-qr — 生成二维码 dataUrl
 * 内部会自动：未启动服务 → 先启动服务 → 再生成二维码
 * 返回 { ok, dataUrl, status, error?, msg? }
 */
ipcMain.handle('generate-qr', async () => {
  try {
    if (!qrcodeLib) {
      console.error('[generate-qr] 失败：qrcode 依赖未安装');
      return { ok: false, error: 'qrcode_missing', msg: 'qrcode 依赖未安装，请联系开发者' };
    }
    attachLocalHttpServerExternals();

    // 服务未启动 → 先启动
    if (localHttpServer.status === 'idle') {
      try {
        console.log('[generate-qr] 本地 HTTP 服务未启动，先调用 localHttpServer.start()');
        await localHttpServer.start({ bus: app.bus });
      } catch (e) {
        const code = (e && e.message) || 'start_failed';
        const userMsg = (e && e.userMsg) || e.message || '服务启动失败';
        console.error(`[generate-qr] ❌ 启动失败：code=${code}  userMsg=${userMsg}`);
        return { ok: false, error: code, msg: userMsg };
      }
    }
    // 二维码内容改为 H5 页面访问 URL（阶梯 4：微信「扫一扫」扫 URL 二维码 → 直接跳转微信内浏览器打开页面）
    // 旧版小程序对接使用的 JSON payload 仍然保留一份在返回值中，便于以后切回或调试，不影响当前 UI
    const jsonPayload = localHttpServer.getQRPayload();
    const st = localHttpServer.getStatus();
    const qrContentUrl = `http://${st.primaryIp}:${st.port}/h5?token=${encodeURIComponent(st.token)}`;
    console.log('====================================================================');
    console.log(`[generate-qr] ✅ 二维码生成准备就绪：`);
    console.log(`[generate-qr]   state：${st.status}  primaryIp：${st.primaryIp}  port：${st.port}  ips：${(st.ips || []).join(', ')}`);
    console.log(`[generate-qr]   二维码内容 URL（手机微信扫一扫跳转）：${qrContentUrl}`);
    console.log(`[generate-qr]   自测链接（电脑浏览器打开也能访问 H5）：http://127.0.0.1:${st.port}/h5?token=${encodeURIComponent(st.token)}`);
    console.log(`[generate-qr]   token（前 6 位）：${(st.token || '').substring(0, 6)}***`);
    console.log('====================================================================');
    const dataUrl = await qrcodeLib.toDataURL(qrContentUrl, {
      errorCorrectionLevel: 'M',   // 中容错：手机扫描时部分遮挡也能识别
      margin: 2,                   // 留白，不紧贴边缘
      width: 200                   // 与 overlay.html <img width=200 对齐
    });
    // 返回结构对齐 overlay-renderer.js renderQrResult 期望：success + 扁平字段
    return {
      ok: true,
      success: true,
      dataUrl,
      qrUrl: qrContentUrl,         // 显式回传 URL，便于 overlay 提示用户（如显示连接提示）
      jsonPayload,                 // 保留：旧 JSON 格式 payload（小程序对接/复制连接用）
      status: st.status,           // 四态字符串：listening / connected
      primaryIp: st.primaryIp,
      port: st.port,
      ips: st.ips,
      token: st.token,
      // 完整状态快照（供 renderQrStatus 直接使用）
      fullStatus: st
    };
  } catch (e) {
    console.error('[generate-qr] ❌ 异常:', e.message, e.stack);
    return { ok: false, error: 'internal', msg: e.message || '二维码生成失败' };
  }
});

/**
 * IPC: start-local-server — 仅启动本地 HTTP+WS 服务（不生成二维码，用于"启动服务但先不展示码"场景）
 */
ipcMain.handle('start-local-server', async (event, port) => {
  try {
    attachLocalHttpServerExternals();
    if (localHttpServer.status !== 'idle') {
      // 已在运行：直接返回当前状态
      return { ok: true, alreadyRunning: true, status: localHttpServer.getStatus() };
    }
    const st = await localHttpServer.start({ bus: app.bus });
    return { ok: true, status: st };
  } catch (e) {
    const code = (e && e.message) || 'start_failed';
    const userMsg = (e && e.userMsg) || e.message || '启动失败';
    return { ok: false, error: code, msg: userMsg };
  }
});

/**
 * IPC: stop-local-server — 停止本地 HTTP+WS 服务（退出应用 / 用户点停止）
 */
ipcMain.handle('stop-local-server', () => {
  try {
    localHttpServer.stop();
    return { ok: true };
  } catch (e) {
    console.error('[stop-local-server] 异常:', e.message);
    return { ok: false, error: 'internal', msg: e.message || '停止失败' };
  }
});

/**
 * IPC: get-server-status — 拉取当前服务状态快照（overlay 弹窗每秒轮询一次，展示四态指示灯）
 */
ipcMain.handle('get-server-status', () => {
  try {
    return { ok: true, status: localHttpServer.getStatus() };
  } catch (e) {
    return { ok: false, error: 'internal', msg: e.message || '读取状态失败' };
  }
});

/**
 * IPC: disconnect-miniapp — 主动断开当前小程序连接（二维码弹窗"断开连接"按钮）
 */
ipcMain.handle('disconnect-miniapp', () => {
  try {
    const r = localHttpServer.disconnectMiniapp();
    return { ok: true, ...r };
  } catch (e) {
    console.error('[disconnect-miniapp] 异常:', e.message);
    return { ok: false, error: 'internal', msg: e.message || '断开失败' };
  }
});

/**
 * IPC: get-server-http-info — 渲染层调用模拟面试/简历优化 HTTP 路由时的 baseInfo：{port,token,baseUrl,isRunning}
 *   如 HTTP 服务尚未启动，会立即启动一次再返回（保证 fetch 可用）。
 */
ipcMain.handle('get-server-http-info', async () => {
  try {
    attachLocalHttpServerExternals();
    if (localHttpServer.status === 'idle') {
      await localHttpServer.start({ bus: app.bus });
    }
    const st = localHttpServer.getStatus() || {};
    return {
      ok: true,
      isRunning: !!st && st.status && st.status !== 'idle',
      port: Number(st && st.port) || 0,
      token: String(st && st.token ? st.token : ''),
      baseUrl: (st && st.port) ? `http://127.0.0.1:${st.port}` : '',
      status: st
    };
  } catch (e) {
    return { ok: false, error: 'internal', msg: e && e.message || '获取 HTTP 服务失败', isRunning:false, port:0, token:'', baseUrl:'' };
  }
});
