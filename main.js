const { app, BrowserWindow, ipcMain, Tray, Menu, globalShortcut, desktopCapturer, session } = require('electron');
const path = require('path');
const fs = require('fs');
const iconv = require('iconv-lite');
const speechService = require('./services/speechService');
const aiService = require('./services/aiService');
const audioRecorder = require('./services/audioRecorder');
const audioService = require('./services/audioService');
const StateManager = require('./services/stateManager');
const PrivacyAudit = require('./services/privacyAudit');

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

// 配置文件路径
const configPath = path.join(userDataPath, 'config.json');
const historyPath = path.join(userDataPath, 'history.json');

// 加载配置
function loadConfig() {
  // 默认配置（已在代码中写死凭据，开箱即用；用户仍可在设置面板覆盖）
  const defaults = {
    baiduAppId: '123982909',
    baiduApiKey: '6wDfN3s2DaBxFklznqdaA5jb',
    baiduSecretKey: '4zeZ8Or967jWFft4nyuAoKwm7e1CDhxg',
    wenxinApiKey: '',
    zhipuApiKey: '',
    tongyiApiKey: 'sk-ws-H.EDPILXP.VR5B.MEYCIQDJLXfHGsMFd7HVRQzIoa8zRhBOvQRp6bbtxo6pV0KumQIhAOJbNX-O9f-bQxSVVpgt3sU2VGmKNulN1I9rvgml4ijQ',
    selectedService: 'tongyi',
    interviewScene: 'behavioral',
    alwaysOnTop: true,
    windowOpacity: 0.95,
    windowWidth: 400,
    windowHeight: 600,
    hotkey: 'CommandOrControl+Shift+H',
    // 实时 ASR 模式：'websocket'（推荐，低延迟） / 'rest'（兜底，分块识别）
    realtimeMode: 'websocket'
  };

  try {
    if (fs.existsSync(configPath)) {
      const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      // 合并策略：saved 中"非空"字段覆盖默认值；为空时回退到默认值
      // 这样既保留用户自定义能力，又保证凭据缺失时仍可工作
      const merged = { ...defaults };
      for (const key of Object.keys(defaults)) {
        const v = saved[key];
        if (v !== '' && v !== null && v !== undefined) {
          merged[key] = v;
        }
      }
      return merged;
    }
  } catch (e) {
    console.error('加载配置失败:', e);
  }
  return defaults;
}

// 保存配置
function saveConfig(config) {
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  } catch (e) {
    console.error('保存配置失败:', e);
  }
}

// 加载历史记录
function loadHistory() {
  try {
    if (fs.existsSync(historyPath)) {
      return JSON.parse(fs.readFileSync(historyPath, 'utf8'));
    }
  } catch (e) {
    console.error('加载历史记录失败:', e);
  }
  return [];
}

// 保存历史记录
function saveHistory(history) {
  try {
    fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));
  } catch (e) {
    console.error('保存历史记录失败:', e);
  }
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
      // 通知渲染层切换 class
      mainWindow.webContents.send('stealth-mode-changed', true);
      showNotification('面试助手', '已进入隐身模式（鼠标拖动顶部小条可移动窗口）');
    } else {
      // 退出隐身模式：恢复鼠标交互
      mainWindow.setIgnoreMouseEvents(false);
      mainWindow.setSkipTaskbar(false);
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
    width: config.windowWidth || 400,
    height: config.windowHeight || 600,
    minWidth: 300,
    minHeight: 400,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: true,
    alwaysOnTop: config.alwaysOnTop,
    skipTaskbar: false,
    hasShadow: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: true
    },
    icon: path.join(__dirname, 'assets', 'icon.png')
  });

  mainWindow.loadFile('index.html');

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

  const config = loadConfig();
  registerGlobalShortcuts(config);
});

// ============================================================
// 控制台日志编码处理（Windows GBK 兼容）
// ============================================================

// 覆盖 console 方法，让所有日志自动转换为 GBK（Windows）
console.log   = (...a) => gbkLog(_origConsoleLog, ...a);
console.warn  = (...a) => gbkLog(_origConsoleWarn, ...a);
console.error = (...a) => gbkLog(_origConsoleError, ...a);

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
      const devices = mod.listAudioDevices();
      return { ok: true, devices };
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
    mainWindow.webContents.send('stealth-mode-changed', false);
  }
  updateTrayMenu();
});

ipcMain.handle('is-in-stealth-mode', () => {
  return isStealthMode;
});

// 录音相关
ipcMain.handle('start-recording', async () => {
  try {
    await audioRecorder.startRecording();
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('stop-recording', async () => {
  try {
    const audioBuffer = await audioRecorder.stopRecording();
    return { success: true, audioBuffer };
  } catch (error) {
    return { success: false, error: error.message };
  }
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
      config
    );
    return { success: true, answer };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// 持续监听 - 开始监听
ipcMain.handle('start-listening', (event, sensitivity = 5) => {
  return audioService.startListening(sensitivity);
});

// 持续监听 - 添加音频数据
ipcMain.handle('add-audio-chunk', (event, chunk) => {
  const result = audioService.addAudioChunk(chunk);
  return result;
});

// 持续监听 - 停止监听
ipcMain.handle('stop-listening', () => {
  return audioService.stopListening();
});

// 检测文本是否是问题
ipcMain.handle('detect-question', (event, text, sensitivity = 5) => {
  const isQuestion = audioService.detectQuestion(text, sensitivity);
  return { isQuestion };
});

// 处理识别的文本，判断是否需要自动生成答案
ipcMain.handle('process-recognized-text', async (event, text, config, conversationHistory, resumeContent) => {
  try {
    const sensitivity = config.detectionSensitivity || 5;
    const isQuestion = audioService.detectQuestion(text, sensitivity);

    const _origLog = console.error;
    _origLog(`[process-recognized-text] 文本: ${text}`);
    _origLog(`[process-recognized-text] 问题检测: ${isQuestion}`);
    _origLog(`[process-recognized-text] 简历内容: ${resumeContent?.length || 0} 字符`);

    if (isQuestion) {
      // 发送桌面通知
      showNotification('✨ 检测到新问题', text.substring(0, 50) + (text.length > 50 ? '...' : ''));

      // 隐私审计：记录 AI 请求
      const prompt = aiService.buildPrompt(
        text,
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

      const answer = await aiService.generateAnswer(
        text,
        config.interviewScene,
        config.selectedService,
        config,
        conversationHistory || [],
        resumeContent || ''
      );

      const duration = Date.now() - startTime;

      // 隐私审计：记录响应
      privacyAudit.logNetworkResponse(
        config.selectedService === 'tongyi' ? 'dashscope.aliyuncs.com' :
        config.selectedService === 'wenxin' ? 'aip.baidubce.com' :
        config.selectedService === 'zhipu' ? 'open.bigmodel.cn' : 'unknown',
        Buffer.byteLength(new TextEncoder().encode(answer || '', 'utf-8')),
        duration,
        true
      );

      _origLog(`[process-recognized-text] AI 完成: ${answer?.length || 0} 字符，耗时 ${duration}ms`);
      return { isQuestion: true, answer, question: text };
    }

    return { isQuestion: false, question: text };
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
