const { app, BrowserWindow, ipcMain, Tray, Menu, globalShortcut, desktopCapturer, session, Notification, screen, safeStorage, shell } = require('electron');
// ============================================================
// ★ 启动前崩溃兜底 + Chromium 参数（解决 Windows 下 electron 秒退 / crashpad not connected 问题）
//   - 未捕获异常/拒绝 全部同步写 crashLog（因为 console 可能还没 flush 进程就没了）
//   - disable-gpu / no-sandbox：Windows 非管理员账号 + 老显卡驱动下 crashpad 的头号解药
//   - disable-crashpad：直接关掉 crashpad 客户端，避免 "not connected" 干扰日志（Windows 下 crashpad 客户端失败时偶发整进程崩）
// ============================================================
(function _startupSafety() {
  const path = require('path');
  const fs   = require('fs');
  const os   = require('os');
  // 崩溃日志放在 {cwd}/logs/crashes/desktop-crash-YYYYMMDD-HHMMSS-pid.log
  const crashDir = path.join(process.cwd(), 'logs', 'crashes');
  try { fs.mkdirSync(crashDir, { recursive: true }); } catch (_) {}
  const pad = (n) => String(n).padStart(2, '0');
  const now = new Date();
  const stamp = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const crashLog = path.join(crashDir, `desktop-crash-${stamp}-${process.pid}.log`);
  const writeCrash = (tag, payload) => {
    try {
      const line = `[${new Date().toISOString()}] [${tag}] ${payload}${os.EOL}`;
      fs.appendFileSync(crashLog, line, 'utf8');
      // 同时写 stderr（父进程/终端若捕获得到会显示）
      process.stderr.write(line);
    } catch (_) {}
  };
  writeCrash('BOOT', `cwd=${process.cwd()}  node=${process.versions.node}  electron=${process.versions.electron || '(null)'}  platform=${process.platform}`);
  process.on('uncaughtException', (err) => {
    writeCrash('uncaughtException', (err && err.stack) ? err.stack : String(err));
  });
  process.on('unhandledRejection', (reason, p) => {
    const txt = (reason && reason.stack) ? reason.stack : String(reason);
    writeCrash('unhandledRejection', `${txt}   promise=${String(p)}`);
  });
  process.on('exit', (code) => {
    writeCrash('exit', `code=${code} (0x${(code >>> 0).toString(16)})`);
  });
  // Chromium 命令行开关（必须在 app.whenReady 之前设置，越靠前越好）
  try {
    app.commandLine.appendSwitch('disable-gpu');
    app.commandLine.appendSwitch('disable-software-rasterizer');
    app.commandLine.appendSwitch('no-sandbox');
    app.commandLine.appendSwitch('disable-crashpad');
    app.commandLine.appendSwitch('max-gum-fps', '60');
  } catch (e) {
    writeCrash('appendSwitch-fail', (e && e.stack) ? e.stack : String(e));
  }
  // ============================================================
  // 🛡️ child_process 安全守卫：禁止二次拉起 electron.exe GUI 进程
  //   - 过去曾出现 cp.spawnSync(electron.exe, <脚本字符串>) 导致 Electron 把
  //     代码内容当应用路径解析，弹出 "Unable to find Electron app at ..." 的
  //     系统级对话框，阻塞整个 npm start 流程。
  //   - 此处 monkey-patch 全部 6 个 child_process 创建入口，一旦检测到调用方
  //     想执行 electron.exe 且未显式声明 ELECTRON_RUN_AS_NODE=1（纯 Node CLI
  //     模式，不创建 GUI），就立刻 throw，并附带完整调用栈写进崩溃日志，
  //     方便定位是谁、在哪里误触发的。
  //   - 允许例外：process.execPath（当前 electron.exe 自己）且带
  //     ELECTRON_RUN_AS_NODE 环境变量时放行（即纯 Node 脚本探测场景）。
  // ============================================================
  (function _installElectronSpawnGuard() {
    // Electron 可执行文件名，一律小写比较
    const ELECTRON_EXE_NAMES = ['electron.exe', 'electron'];
    // 判定某字符串参数是否指向 electron.exe
    const looksLikeElectron = (v) => {
      if (!v) return false;
      const s = String(v).replace(/\\/g, '/').toLowerCase();
      return ELECTRON_EXE_NAMES.some(n => s.endsWith('/' + n) || s.endsWith('\\' + n) || s === n);
    };
    // 判定 options.env 或当前环境是否显式打开 ELECTRON_RUN_AS_NODE=1
    const isRunAsNode = (opts) => {
      const envObj = (opts && opts.env) ? opts.env : process.env;
      if (!envObj) return false;
      const v = String(envObj.ELECTRON_RUN_AS_NODE || '').trim();
      return v === '1' || v === 'true';
    };
    // 构建一个带堆栈的 Error，便于定位调用者
    const makeBlockError = (apiName, args) => {
      const err = new Error(
        `[child_process:${apiName}] 🚫 禁止从 Electron 主进程再拉起 electron.exe GUI 进程。` +
        ` 若确需在 Electron 的 Node CLI 模式下执行脚本，请显式设置 env.ELECTRON_RUN_AS_NODE=1。` +
        ` args0=${String(args && args[0] ? args[0] : '').slice(0, 300)}` +
        ` args1=${Array.isArray(args && args[1]) ? JSON.stringify(args[1]).slice(0, 500) : ''}`
      );
      Error.captureStackTrace(err, makeBlockError); // 裁剪到真正的调用栈
      return err;
    };
    // 单个 API 的统一包装：先校验 → 再调用原始实现
    const wrap = (cp, key) => {
      const orig = cp[key];
      if (typeof orig !== 'function') return;
      cp[key] = function guarded(/* ...args */) {
        const argv = Array.prototype.slice.call(arguments);
        const file  = argv[0]; // spawn/execFile/spawnSync/execFileSync 的第一个参数
        const argArr = Array.isArray(argv[1]) ? argv[1] : null; // spawn 的 args[]
        const opts = argv[argv.length - 1];
        const optionsObj = opts && typeof opts === 'object' && !Array.isArray(opts) ? opts : null;
        // 命中条件：目标文件像 electron.exe，且不是 RUN_AS_NODE 模式
        const blocked = looksLikeElectron(file) && !isRunAsNode(optionsObj);
        if (blocked) {
          const e = makeBlockError(key, argv);
          // 立刻写盘，确保哪怕 throw 被吞掉，日志也能定位到责任人
          writeCrash(`child_process:${key}:BLOCK`, (e && e.stack) ? e.stack : String(e));
          throw e;
        }
        return orig.apply(this, argv);
      };
    };
    try {
      const cp = require('child_process');
      ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork'].forEach(k => wrap(cp, k));
      writeCrash('child_process:guard', `installed (${process.pid})`);
    } catch (e) {
      writeCrash('child_process:guard:FAIL', (e && e.stack) ? e.stack : String(e));
    }
  })();
  // 暴露 crashLog 路径给后续阶段（Phase 1 仓储初始化可以打日志）
  global.__DESKTOP_CRASH_LOG__ = crashLog;
  global.__DESKTOP_SAFE_LOG__ = writeCrash;
})();

// 环境变量加载（必须在最前面，保证后续模块的 process.env 已就绪）
// 加载顺序：1) 系统环境变量  2) 项目根目录 .env 文件（dotenv 不会覆盖已有系统环境变量）
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const os = require('os');
// iconv-lite：Windows GBK 终端下日志转码（非关键，失败就按 UTF-8 原生输出）
let iconv = null;
try { iconv = require('iconv-lite'); } catch (_) { iconv = null; }
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
// ============================================================
// ★ 逐个 require 包裹安全兜底（native 模块 require 崩溃时能写入崩溃日志）
//   - 前一版本 npm start 秒退但没有 [uncaughtException]/[exit] 日志，
//     说明是某个顶层 require（native ABI / iconv / captureExclusion koffi 调 Win32 / asrPipeline 依赖音频库）
//     在 require 阶段直接 native-level crash，绕过了 process.on('uncaughtException')。
//   - 逐个 try/catch require 可以把错误通过 catch 捕获后交给 __DESKTOP_SAFE_LOG__ 写盘。
// ============================================================
const SAFE_LOG = (typeof global.__DESKTOP_SAFE_LOG__ === 'function') ? global.__DESKTOP_SAFE_LOG__ : (() => {});
function safeRequire(modPath, label = modPath) {
  try {
    SAFE_LOG('require:start', label);
    const m = require(modPath);
    SAFE_LOG('require:ok', `${label} -> loaded`);
    return m;
  } catch (e) {
    const stack = (e && e.stack) ? e.stack : String(e);
    SAFE_LOG('require:FAIL', `${label} :: ${stack}`);
    // 让 npm start 的 stderr 也打印
    try { process.stderr.write(`[require:FAIL] ${label} :: ${stack}\n`); } catch (_) {}
    // 非关键模块返回 null 让后续 try/catch 继续跑；关键模块若缺了会在后续阶段再报错
    return null;
  }
}
const speechService = safeRequire('./services/speechService',  'speechService');
const aiService     = safeRequire('./services/aiService',      'aiService');
const audioService  = safeRequire('./services/audioService',   'audioService');
const StateManager  = safeRequire('./services/stateManager',   'StateManager');
const PrivacyAudit  = safeRequire('./services/privacyAudit',   'PrivacyAudit');
// ASR 管线：WASAPI 系统音频 → 百度 ASR → 问题检测 → AI 答题（主进程原生采集，不依赖渲染层）
const ASRPipeline   = safeRequire('./services/asrPipeline',    'ASRPipeline');
let asrPipeline = null; // 管线单例，启动面试辅助时创建
// ★ 缓存"最后一次成功启动 ASR 使用的 config"，供面板端 toggle-asr-pipeline 直接复用，
//   否则面板端拿不到主窗口保存的百度 API Key / 模型 / 简历 / 场景等完整 config，
//   就无法独立完成"开始识别"动作（只能停止）。
let lastAsrConfig = null;
// 配置与本地持久化管理器（替代原先散落的 config/history 读写，密钥不再写死在代码里）
const ConfigManager = safeRequire('./src/main/config-manager', 'ConfigManager');

// ============================================================
// ★ 远端宣传站点（Landing Server）联动：
//   - 登录：邮箱+密码 → 走 landing /api/auth/login → 返回 sessionId → 存本地 remote-session.json
//   - 积分消费：走 landing /api/console/consume → 服务端原子写余额+流水
//   - 充值引导：shell.openExternal(LANDING_BASE_URL/console.html)
//   - 默认地址 http://localhost:3000，可用环境变量 LANDING_BASE_URL 覆盖（生产部署后改指向公网）
//   - 如果 landing server 没启动，全部接口**自动 fallback 本地账号 + 离线允许使用**，保证本地使用不崩
// ============================================================
const LANDING_BASE_URL = String(process.env.LANDING_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');

// 用户数据存储路径（必须在 REMOTE_SESSION_FILE、stateManager、privacyAudit、configManager、interview.db 之前声明）
// 注意：app.getPath('userData') 不要求 app.whenReady，可在顶层直接调用
const userDataPath = path.join(app.getPath('userData'), 'interview-assistant');
if (!fs.existsSync(userDataPath)) {
  fs.mkdirSync(userDataPath, { recursive: true });
}

const REMOTE_SESSION_FILE = path.join(userDataPath, 'remote-session.json');
/** 读取当前登录的远端会话（sessionId / user / expireAt / baseUrl） */
function _readRemoteSession() {
  try {
    if (!fs.existsSync(REMOTE_SESSION_FILE)) return null;
    const raw = JSON.parse(fs.readFileSync(REMOTE_SESSION_FILE, 'utf-8'));
    if (!raw || !raw.sessionId) return null;
    if (raw.expireAt && raw.expireAt < Date.now()) return null; // 已过期
    return raw;
  } catch (_) { return null; }
}
/** 保存远端会话到文件 */
function _writeRemoteSession(sess) {
  try { fs.mkdirSync(userDataPath, { recursive: true }); fs.writeFileSync(REMOTE_SESSION_FILE, JSON.stringify(sess || null, null, 2), 'utf-8'); } catch (_) {}
}
/** 清除远端会话（登出 / 过期） */
function _clearRemoteSession() { try { if (fs.existsSync(REMOTE_SESSION_FILE)) fs.unlinkSync(REMOTE_SESSION_FILE); } catch (_) {} }
/**
 * 统一的远端 HTTP 调用：自动带 Authorization: Bearer <sessionId>
 * 返回 { ok, status, data, errorMsg }（永远不 throw，调用方只看 ok/data）
 */
async function _callLanding({ method = 'GET', pathname, body = null, timeoutMs = 10000, forceSkipAuth = false }) {
  const sess = !forceSkipAuth ? _readRemoteSession() : null;
  const url = `${LANDING_BASE_URL}${pathname}`;
  const headers = { 'Content-Type': 'application/json' };
  if (sess && sess.sessionId) headers['Authorization'] = 'Bearer ' + sess.sessionId;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const resp = await fetch(url, {
      method, headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    clearTimeout(t);
    const text = await resp.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = { _rawText: text }; }
    return { ok: resp.ok && data && data.ok === true, status: resp.status, data };
  } catch (e) {
    return { ok: false, status: 0, errorMsg: e && e.message ? e.message : String(e) };
  }
}
/**
 * 远端登录：email+password → 调 /api/auth/login → 成功则保存 session + 返回 user
 * 未连接 landing server（status===0 或 timeout）直接返回 {ok:false,code:'LANDING_OFFLINE'}，调用方 fallback 本地
 */
async function _remoteLogin(email, password) {
  const r = await _callLanding({ method: 'POST', pathname: '/api/auth/login', body: { email, password }, forceSkipAuth: true, timeoutMs: 6000 });
  if (r.status === 0) return { ok: false, code: 'LANDING_OFFLINE', msg: '宣传站点未启动，已切换本地账号登录' };
  if (!r.ok || !r.data) return { ok: false, code: (r.data && r.data.code) || 'REMOTE_LOGIN_FAILED', msg: (r.data && r.data.msg) || '远端登录失败' };
  const d = r.data;
  const sess = { sessionId: d.sessionId, expireAt: d.expireAt || (Date.now() + 7 * 24 * 3600 * 1000), user: d.user || null, baseUrl: LANDING_BASE_URL, loggedInAt: Date.now() };
  _writeRemoteSession(sess);
  return { ok: true, user: sess.user, session: sess, remote: true };
}
/** 远端登出（可选调用，主要是清本地 session；服务端会话会自行过期） */
async function _remoteLogout() {
  try { await _callLanding({ method: 'POST', pathname: '/api/auth/logout', body: {} }); } catch (_) {}
  _clearRemoteSession();
}

// 系统级窗口捕获排除（对齐 HireMe 发行版 applyExcludeFromCapture，用 koffi 调 Win32 API）
const captureExclusion = safeRequire('./src/main/capture-exclusion', 'captureExclusion');
// 本地伴生设备中继服务（http + SSE + WebSocket，对齐 HireMe localServer/relay）
const relayServer = safeRequire('./src/main/relay-server', 'relayServer');
// 小程序联动：本地 HTTP + WebSocket 服务（WS + HTTP，支持截图/答案回写/ASR推送）
const localHttpServer = safeRequire('./services/localHttpServer', 'localHttpServer');
// 账号鉴权：本地账号注册表、登录会话、密码哈希、重置码
const _authMod = safeRequire('./services/authService', 'authService');
const AuthService = _authMod && _authMod.AuthService ? _authMod.AuthService : null;
const GUEST_ACCOUNT_ID = _authMod && _authMod.GUEST_ACCOUNT_ID ? _authMod.GUEST_ACCOUNT_ID : '__guest__';
// ============================================================
// ★ 三端统一数据源：common-paths（定位 hireme.db 物理路径 + 统一 open 方法）
//   - 桌面端 / Landing :3000 / 管理员 :3001 都 require 本文件，
//     拿到的 HIREME_DB_PATH 一定是同一份（项目根/data/hireme.db）
//   - openUnifiedDatabase(Database) 会执行统一 PRAGMA：WAL / busy_timeout / foreign_keys …
// ============================================================
const commonPaths = safeRequire('./services/common-paths', 'common-paths');
const HIREME_DB_PATH = commonPaths && commonPaths.HIREME_DB_PATH
  ? commonPaths.HIREME_DB_PATH
  : path.join(__dirname, 'data', 'hireme.db'); // 兜底，绝不使用 interview.db 旧路径
// 二维码生成：把 payload JSON 转成 dataUrl，供 overlay 弹窗 <img> 渲染
let qrcodeLib = null;
try { qrcodeLib = safeRequire('qrcode', 'qrcode'); } catch (e) {
  console.warn('[main] qrcode 模块未安装，二维码功能不可用:', e.message);
}

// ============================================================
// ★ 在 Phase 1 三个核心 manager (StateManager / PrivacyAudit / ConfigManager)
//    初始化完成后，立刻做一个【子进程 / child_process.fork 隔离运行】的自检 ——
//    这一步之前的所有 require 和 init:* 已经全部 OK。
//    如果是 iconv / safeStorage / koffi / 其他 native 模块在"app.whenReady 之前"
//    触发 Chromium 崩溃（exit=-36861/0xFFFF7003），直接在 main.js 中做"最小
//    可行启动"二分：先把【experimental features / 磁盘缓存 / GBK 日志编码 /
//    iconv / enable-features / safeStorage】全部降级关掉，再逐项打开。
// 具体做法：【把 app.whenReady 之前的 appendSwitch 全部改为"最小启动集"，
//    默认不用 experimental、不用 disk cache 细粒度参数，只用我们在顶部
//    disable-gpu/disable-crashpad/no-sandbox 这 4 条。
//    成功起来后，再逐条加回。】
// ============================================================
SAFE_LOG('phase:before-ready-switches', 'begin');
// 启用 Chromium 实验特性：渲染层 FaceDetector API（gaze 视线检测降级方案需要）
// 必须在 app.ready 之前调用
try {
  // 【2026-08-29：临时注释"实验性 features + 磁盘缓存定制"】
  //   这一段是目前"app.whenReady 之前"唯一会触发 Chromium/GPU 层的操作，
  //   先注释干净，等 electron 能正常创建窗口后再逐条打开。
  // app.commandLine.appendSwitch('enable-experimental-web-platform-features');
  // app.commandLine.appendSwitch('enable-features', 'ExperimentalWebPlatformFeatures');
  //
  // // === 解决 Windows 下部分环境 GPU 缓存目录无写权限（错误码 0x5：拒绝访问） ===
  // app.commandLine.appendSwitch('disable-gpu-cache');
  // app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
  // app.commandLine.appendSwitch('disable-http-cache');
  // app.commandLine.appendSwitch('media-cache-size', '0');
  // const cacheDir = path.join(app.getPath('userData'), 'chromium-cache');
  // try { fs.mkdirSync(cacheDir, { recursive: true }); } catch (_) { /* 忽略 */ }
  // app.commandLine.appendSwitch('disk-cache-dir', cacheDir);
  // app.commandLine.appendSwitch('gpu-cache-dir', cacheDir);
  SAFE_LOG('phase:before-ready-switches', 'skip (experimental + cache settings disabled for boot stability)');
} catch (e) {
  SAFE_LOG('phase:before-ready-switches:FAIL', (e && e.stack) ? e.stack : String(e));
}

// ============================================================
// ★ GBK 日志编码 + iconv.encode：【也包 try/catch + 顶层安全兜底】
//    iconv-lite 是纯 JS，理论上不会 native crash，
//    但 GBK 编码会给所有 console 加一层写入逻辑，若 stream 异常可能连带影响启动。
//    这里把 iconv 相关全部放在 try/catch 中：失败时直接用原生 console。
// ============================================================
// 保存原始 console 方法
const _origConsoleLog = console.log;
const _origConsoleWarn = console.warn;
const _origConsoleError = console.error;
let isWindowsGBK = false;
try {
  isWindowsGBK = process.platform === 'win32' && iconv && typeof iconv.encode === 'function';
} catch (_) { isWindowsGBK = false; }

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

try {
  console.log   = (...a) => gbkLog(a, process.stdout);
  console.warn  = (...a) => gbkLog(a, process.stderr);
  console.error = (...a) => gbkLog(a, process.stderr);
} catch (_) { /* 降级：保持原生 console */ }
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
let mockInterviewFloatWindow;  // ★ 模拟面试专用浮动面板 BrowserWindow（锁死作答方式、题目+答题+最终总点评专用）
let tray;
let isWindowVisible = true;
let isStealthMode = false;

// ★ 截图/录屏「不可见」总开关（默认开启）：本地看得见，但截屏/录屏/屏幕共享的捕获端看不到。
//   由 config.captureHide 初始化；设置面板可实时切换。
let captureHideEnabled = true;

// ★ 顶层窗口注册表：登记本 App 全部顶层窗口，便于「统一」施加系统级捕获排除。
//   为什么需要它：WDA_EXCLUDEFROMCAPTURE 只对「单个 HWND」生效，主窗口、答题面板、
//   模拟面试浮窗、声源选择器必须各自单独设置，漏掉任何一个都会在截图里露馅。
const windowRegistry = new Map();  // id -> BrowserWindow

// 登记一个窗口（创建后调用；窗口已销毁则忽略）
function registerWindow(id, win) {
  if (win && !win.isDestroyed()) windowRegistry.set(id, win);
}

// 注销一个窗口（窗口 closed 时调用）
function unregisterWindow(id) {
  windowRegistry.delete(id);
}

// 取出当前存活的所有窗口（顺手清理已销毁的引用）
function getLiveWindows() {
  const out = [];
  for (const [id, w] of windowRegistry.entries()) {
    if (w && !w.isDestroyed()) out.push(w);
    else windowRegistry.delete(id);  // 已销毁的从注册表剔除，避免缓存脏引用
  }
  return out;
}

// 对全部已登记窗口统一施加/取消「从屏幕捕获排除」，并返回统计。
// 这是「截图不可见」能力的核心入口，启动时与各窗口 ready 时都会调用。
function applyCaptureHideToAll(enabled) {
  const wins = getLiveWindows();
  let ok = 0;
  for (const w of wins) {
    if (captureExclusion.applyCaptureExclusion(w, enabled)) ok += 1;
  }
  console.log(`[capture-hide] 已对 ${wins.length} 个窗口施加「从捕获排除」=${enabled}（成功 ${ok}）`);
  return { total: wins.length, ok };
}

// 初始化状态管理器 / 隐私审计 / 配置管理 —— 全部 try/catch + 写 crashLog
//   - 这些类的构造函数里会立刻做 fs 读写、JSON.parse、密钥处理，任何一个抛错都可能让 electron 秒退
//   - 🔴 三端统一架构版：ConfigManager 延后到 Phase SQLite init 之后创建，
//     这样能注入：① hireme.db 同一句柄 ② currentAccountIdSafe 账号 Provider
let stateManager = null, privacyAudit = null, configManager = null;
(function _initCoreManagers() {
  const steps = [
    ['StateManager',   () => { StateManager && (stateManager = new StateManager(userDataPath)); }],
    ['PrivacyAudit',   () => { PrivacyAudit && (privacyAudit = new PrivacyAudit(userDataPath)); }],
    // ConfigManager 移到下方 Phase SQLite+AuthService 之后再初始化（需要 externalDb + accountProvider）
  ];
  for (const [name, fn] of steps) {
    try {
      SAFE_LOG(`init:${name}`, `start`);
      fn();
      SAFE_LOG(`init:${name}`, `ok`);
    } catch (e) {
      const stack = (e && e.stack) ? e.stack : String(e);
      SAFE_LOG(`init:${name}:FAIL`, stack);
      try { process.stderr.write(`[init:FAIL] ${name} :: ${stack}\n`); } catch (_) {}
    }
  }
})();

// ============================================================
// ★ 面试记录【三端统一架构 Phase 7】hireme.db 统一初始化
//   - 单一数据库文件：项目根/data/hireme.db（通过 common-paths.HIREME_DB_PATH 定位）
//   - 统一句柄：只 new 一次 Database，后续 AuthService / ConfigManager / SessionRepo
//              都复用同一条连接，避免多连接争抢 WAL 文件锁
//   - 注入链路：
//         authService = new AuthService(..., { externalDb })
//         currentAccountIdSafe() => 账号 provider 可用
//         configManager = new ConfigManager(userDataPath, { externalDb, accountProvider })
//         sessionRepo   = new SessionRepo(externalDb)  → setSessionRepository 给 HTTP/WS
//   - 失败：全部 try/catch 兜底，SQLite 侧降级，JSON 原流程 100% 不受影响
// ============================================================
let _unifiedDb = null;    // 三模块共享的 hireme.db 句柄（单例）
let sessionRepo = null;   // 全局仓储实例（IPC 句柄复用）
SAFE_LOG('phase:sqlite-init', `begin, db=${HIREME_DB_PATH}`);
// ============================================================
// 🛠️ better-sqlite3 ABI 兼容性探测【主进程内轻量版】
//   - Windows 上若用 cp.spawnSync(electron.exe, <probe.js>) 会再启一条 Electron GUI 进程：
//     临时 .js 不是合法 Electron App（无 package.json + 无 BrowserWindow 初始化），
//     会弹系统级对话框 "Unable to find Electron app at ..."，导致 npm start 启动被阻塞。
//   - 所以直接在**主进程**里 try/catch require + pragma('journal_mode') + 写读一条：
//     失败就走降级（__SQLITE_DISABLE_BY_PROBE__=true，跳过 SQLite，JSON 原流程不受影响），
//     且不创建/销毁任何额外进程，完全规避 Electron GUI 弹窗。
// ============================================================
(function _probeBetterSqlite3Inline() {
  const os   = require('os');
  const fs   = require('fs');
  const path = require('path');
  // 候选 better-sqlite3 目录：Electron 运行时优先项目根（Electron ABI 编译），兜底 landing
  const candidates = [
    path.join(__dirname, 'node_modules', 'better-sqlite3'),
    path.join(__dirname, 'landing', 'node_modules', 'better-sqlite3'),
  ].filter(p => fs.existsSync(p));
  if (candidates.length === 0) {
    SAFE_LOG('phase:sqlite-probe', 'SKIP: better-sqlite3 目录均不存在，已降级');
    console.warn('[sqlite-sessions] ⚠️ better-sqlite3 未安装（node_modules 缺失），本次启动跳过 SQLite，JSON 主流程不受影响');
    global.__SQLITE_DISABLE_BY_PROBE__ = true;
    return;
  }
  const tmpDb = path.join(os.tmpdir(), 'hireme-sqlite3-probe-inline-' + process.pid + '-' + Date.now() + '.db');
  try {
    // 1) 顺序尝试 require better-sqlite3（第一家成功即 Database）
    let Database = null;
    let lastErr  = null;
    let usedPath = '';
    for (const _p of candidates) {
      try { delete require.cache[require.resolve(_p)]; } catch (_) {}
      try { Database = require(_p); usedPath = _p; break; }
      catch (e) { lastErr = e; }
    }
    if (!Database) {
      throw lastErr || new Error('无法 require 任何 better-sqlite3 候选路径');
    }
    // 2) 打开临时 DB → WAL → 建表 → 插入 → 查询：最严格的 ABI + SQLITE thread 探测
    const db = new Database(tmpDb, { readonly: false, fileMustExist: false });
    db.pragma('journal_mode = WAL');
    db.exec('CREATE TABLE IF NOT EXISTS _probe (id INTEGER PRIMARY KEY, v TEXT)');
    db.prepare('INSERT INTO _probe(v) VALUES (?)').run('ok-' + process.versions.modules);
    const row = db.prepare('SELECT v FROM _probe LIMIT 1').get();
    db.close();
    if (!row || String(row.v || '').indexOf('ok-') !== 0) {
      throw new Error('probe 写入后查询结果异常: ' + JSON.stringify(row));
    }
    // 3) 结果：OK —— 保存候选路径到 global，后续 openUnifiedDatabase 会优先复用
    global.__SQLITE_DISABLE_BY_PROBE__ = false;
    global.__HIREME_BETTER_SQLITE3_PATH__ = usedPath;
    SAFE_LOG('phase:sqlite-probe', `OK abi=modules-${process.versions.modules}, used=${path.relative(__dirname, usedPath)}`);
  } catch (e) {
    const stack = (e && e.stack) ? e.stack : String(e);
    SAFE_LOG('phase:sqlite-probe', `FAIL :: ${stack.slice(0, 400)}`);
    console.warn('[sqlite-sessions] ⚠️ better-sqlite3 主进程 ABI 探测失败（native 未正确编译 / 与 Electron ABI 不匹配），本次启动跳过 SQLite，JSON 主流程完全不受影响：', (e && e.message) || String(e));
    global.__SQLITE_DISABLE_BY_PROBE__ = true;
  } finally {
    // 清理临时 DB（无论成败）
    try { if (fs.existsSync(tmpDb)) fs.unlinkSync(tmpDb); } catch (_) {}
    try { if (fs.existsSync(tmpDb + '-wal')) fs.unlinkSync(tmpDb + '-wal'); } catch (_) {}
    try { if (fs.existsSync(tmpDb + '-shm')) fs.unlinkSync(tmpDb + '-shm'); } catch (_) {}
  }
})();
try {
  // ============================================================
  // 🛠️ 降级重试机制：探测失败但 build/Release 编译产物存在时，
  // 直接在主进程 try/catch 中尝试初始化（绕过主进程探测的 native 加载异常）。
  // ============================================================
  let _buildProductAvailable = false;
  try {
    const _releaseFile = path.join(__dirname, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
    if (fs.existsSync(_releaseFile) && fs.statSync(_releaseFile).size > 1000000) {
      _buildProductAvailable = true;
    }
  } catch (_) {}
  if (global.__SQLITE_DISABLE_BY_PROBE__ && _buildProductAvailable) {
    SAFE_LOG('phase:sqlite-init', 'probe 失败但 build/Release 编译产物存在，启用降级重试（主进程再次尝试初始化）...');
    console.info('[sqlite-sessions] ℹ️ 内联 ABI 探测未通过，但检测到已编译的 better_sqlite3.node，尝试降级初始化（如仍失败将跳过SQLite，不影响JSON主流程）');
    global.__SQLITE_DISABLE_BY_PROBE__ = false; // 取消禁用标记，让下面的逻辑再试一次
  }

  if (global.__SQLITE_DISABLE_BY_PROBE__) {
    SAFE_LOG('phase:sqlite-init', 'skip: disabled by probe (better-sqlite3 native mismatch)');
    sessionRepo = null;
  } else {
    // ============================================================
    // ★ 【三端统一】只 new 一次 hireme.db 单例（通过 common-paths.openUnifiedDatabase）
    // ============================================================
    // 1) 加载 better-sqlite3：
    //    - 优先使用【主进程探测通过的】 global.__HIREME_BETTER_SQLITE3_PATH__
    //      （避免 Electron 主进程误加载 landing 下 Node ABI 版本造成 native crash）
    //    - 其次 Electron 环境：先项目根 node_modules（Electron ABI 编译），再 landing（Node ABI 编译）
    //    - 与 services/* 内 requireBetterSqlite3() 实现顺序保持一致
    let Database = null;
    const preferPath = typeof global.__HIREME_BETTER_SQLITE3_PATH__ === 'string' && global.__HIREME_BETTER_SQLITE3_PATH__
      ? global.__HIREME_BETTER_SQLITE3_PATH__
      : '';
    const dbCandidates = (preferPath ? [preferPath] : []).concat([
      path.join(__dirname, 'node_modules', 'better-sqlite3'),
      path.join(__dirname, 'landing', 'node_modules', 'better-sqlite3'),
    ]);
    let _lastDbErr = null;
    for (const _p of dbCandidates) {
      try { Database = require(_p); SAFE_LOG('phase:sqlite-init', `using better-sqlite3 from ${path.relative(__dirname, _p) || _p}`); break; }
      catch (_e) { _lastDbErr = _e; }
    }
    if (!Database) {
      SAFE_LOG('phase:sqlite-init', `FAIL: better-sqlite3 not loaded | ${_lastDbErr && _lastDbErr.message}`);
      throw _lastDbErr || new Error('better-sqlite3 未找到（项目根 与 landing/node_modules 均不可加载）');
    }
    // 2) 统一打开：WAL + busy_timeout + foreign_keys + NORMAL + cache_size
    let _db = null;
    if (commonPaths && typeof commonPaths.openUnifiedDatabase === 'function') {
      const { db, ready, error } = commonPaths.openUnifiedDatabase(Database);
      if (!ready || !db) throw error || new Error('openUnifiedDatabase 返回失败');
      _db = db;
    } else {
      // common-paths 加载失败时兜底（极少）
      const _dbDir = path.dirname(HIREME_DB_PATH);
      if (!fs.existsSync(_dbDir)) fs.mkdirSync(_dbDir, { recursive: true });
      _db = new Database(HIREME_DB_PATH);
      _db.pragma('journal_mode = WAL');
      _db.pragma('busy_timeout = 5000');
      _db.pragma('foreign_keys = ON');
    }
    _unifiedDb = _db;
    SAFE_LOG('phase:sqlite-init', `unified db opened: ${HIREME_DB_PATH}`);

    // 3) 创建 SessionRepository（直接 new，传入 externalDb 共享句柄）
    //    - 不再通过 localHttpServer.createSessionRepo(INTERVIEW_SQLITE_PATH) 开独立连接
    const SessionRepo = safeRequire('./services/session-repo.js', 'session-repo');
    if (SessionRepo) {
      sessionRepo = new SessionRepo(_unifiedDb);
    } else {
      // fallback：兼容旧逻辑 createSessionRepo（此时传 db 句柄）
      if (typeof localHttpServer?.createSessionRepo === 'function') {
        sessionRepo = localHttpServer.createSessionRepo(_unifiedDb);
      }
    }
    if (sessionRepo && typeof localHttpServer?.setSessionRepository === 'function') {
      localHttpServer.setSessionRepository(sessionRepo);
    }
    // 健康检查打印
    const h = (sessionRepo && typeof sessionRepo.health === 'function') ? sessionRepo.health() : null;
    if (h && h.ok) {
      console.log(`[sqlite-sessions] ✅ 初始化成功（三端统一 hireme.db）：DB=${path.relative(process.cwd(), HIREME_DB_PATH)} | sessions=${h.sessionCount} rounds=${h.roundCount}`);
      SAFE_LOG('phase:sqlite-init', `ok, sessions=${h.sessionCount}, rounds=${h.roundCount}`);
    } else {
      console.warn('[sqlite-sessions] ⚠️ SQLite 仓库初始化未就绪：', h && h.msg ? h.msg : 'unknown');
      SAFE_LOG('phase:sqlite-init', `not-ready: ${(h && h.msg) ? h.msg : 'unknown'}`);
    }
  }
} catch (e) {
  sessionRepo = null;
  const stack = (e && e.stack) ? e.stack : String(e);
  SAFE_LOG('phase:sqlite-init:FAIL', stack);
  console.warn('[sqlite-sessions] ❌ 启动时初始化 hireme.db 统一仓库失败（SQLite 侧安全跳过，JSON 原流程不受影响）：', e && e.message);
}

SAFE_LOG('phase:sqlite-migrate', 'begin');
// 启动时【自动】做一次 JSON → SQLite 的幂等迁移（迁过的 session 会被跳过，重复启动不重复）
// 目的：老用户升级到带 SQLite 的新版本后，历史记录自动进入 DB，Web 端就能立刻看到
try {
  if (sessionRepo && sessionRepo.ready) {
    // 用 child_process 同步跑 scripts/migrate-sessions-to-sqlite.js 会有路径问题，所以直接复用 migration 函数
    // 为了代码复用，我们直接在 main.js 里内联一份"简化版迁移逻辑"（只做 logs/sessions/{accountId} 扫描 + upsert）
    const _SESSION_ROOT = path.join(__dirname, 'logs', 'sessions');
    if (fs.existsSync(_SESSION_ROOT)) {
      let _migNew = 0, _migSkip = 0;
      // 辅助函数：推断 category（与 migrate-sessions-to-sqlite.js / localHttpServer._inferSessionCategory 完全对齐）
      const _inferCat = (s) => {
        if (!s || typeof s !== 'object') return 'copilot';
        if (s.category === 'copilot' || s.category === 'mock') return s.category;
        if (s.meta && s.meta.mockInterview) return 'mock';
        if (s.config && s.config._mockInterview) return 'mock';
        if (s._cfg && s._cfg._mockInterview) return 'mock';
        return 'copilot';
      };
      const _migrateDir = (dir, accountId) => {
        if (!fs.existsSync(dir)) return;
        for (const name of fs.readdirSync(dir)) {
          if (!name.endsWith('.json') || name.startsWith('_index')) continue;
          try {
            const full = path.join(dir, name);
            const raw = JSON.parse(fs.readFileSync(full, 'utf-8'));
            if (!raw || !raw.id) continue;
            if (sessionRepo.exists(raw.id)) { _migSkip++; continue; }
            const rounds = Array.isArray(raw.rounds) ? raw.rounds : [];
            let ac = 0, ec = 0;
            for (const r of rounds) {
              if (r && r.status === 'answered') ac++;
              else if (r && r.status === 'error') ec++;
            }
            const st = Number(raw.startedAt || raw.started_at || 0);
            const en = Number(raw.endedAt || raw.ended_at || 0);
            const la = Number(raw.lastActiveAt || en || st || Date.now());
            const status = (raw.status === 'ended' || en > 0) ? 'ended' : 'active';
            const cat = _inferCat(raw);
            const snippet = (typeof raw.snippet === 'string' && raw.snippet.trim()) ? raw.snippet.slice(0, 500)
              : (rounds.length ? String(rounds[rounds.length - 1].questionText || rounds[rounds.length - 1].answerText || '').slice(0, 500) : '');
            sessionRepo.upsertSession({
              id: String(raw.id), accountId,
              category: cat,
              title: String(raw.title || '').slice(0, 200),
              targetCompany:  String(raw.targetCompany  || raw.target_company  || '').slice(0, 200),
              targetPosition: String(raw.targetPosition || raw.target_position || '').slice(0, 200),
              interviewType:  String(raw.interviewType  || raw.interview_type  || '').slice(0, 100),
              status, startedAt: st, endedAt: en, lastActiveAt: la,
              roundCount: rounds.length, questionCount: rounds.length,
              answeredCount: ac, errorCount: ec,
              durationMs: (raw.stats && raw.stats.totalDurationMs) || Math.max(0, en - st),
              jdSnapshot: String(raw.jdSnapshot || raw.jd_snapshot || '').slice(0, 20000),
              resumeSnapshot: String(raw.resumeSnapshot || raw.resume_snapshot
                || (raw.config && (raw.config.resumeContent || raw.config.resumeText)) || '').slice(0, 40000),
              snippet,
            });
            sessionRepo.upsertRoundsForSession(String(raw.id), rounds);
            _migNew++;
          } catch (_) { /* 单条失败不影响其它 */ }
        }
      };
      // 顶层遗留（老版本）→ 挂到 __guest__
      const topFiles = fs.readdirSync(_SESSION_ROOT, { withFileTypes: true });
      if (topFiles.some(e => e.isFile() && e.name.endsWith('.json') && !e.name.startsWith('_index'))) {
        _migrateDir(_SESSION_ROOT, '__guest__');
      }
      // 账号子目录（主流格式）
      for (const e of topFiles) {
        if (!e.isDirectory()) continue;
        _migrateDir(path.join(_SESSION_ROOT, e.name), e.name);
      }
      if (_migNew > 0 || _migSkip > 0) {
        console.log(`[sqlite-sessions] 📥 启动自动迁移：新迁 ${_migNew} 场，跳过已存在 ${_migSkip} 场`);
      }
      SAFE_LOG('phase:sqlite-migrate', `done, new=${_migNew}, skipped=${_migSkip}`);
    } else {
      SAFE_LOG('phase:sqlite-migrate', 'skip: no logs/sessions directory');
    }
  } else {
    SAFE_LOG('phase:sqlite-migrate', 'skip: sessionRepo not ready');
  }
} catch (migE) {
  const stack = (migE && migE.stack) ? migE.stack : String(migE);
  SAFE_LOG('phase:sqlite-migrate:FAIL', stack);
  console.warn('[sqlite-sessions] ⚠️ 启动自动迁移异常（不影响后续运行，用户可手动重跑 scripts/migrate-sessions-to-sqlite.js）：', migE && migE.message);
}

SAFE_LOG('phase:authService', 'begin');
// ===== 账号鉴权服务：本地持久化账号表 + safeStorage 加密会话 =====
// stateChangeListener：登录/登出/改资料时向主窗口+浮窗广播 'auth-state-change'
// 🔴 三端统一：传入 _unifiedDb 共享句柄（避免再 new 一次 Database）
let authService = null;
try {
  if (AuthService) {
    authService = new AuthService(userDataPath, (safeStorage || null), {
      externalDb: _unifiedDb || null,   // ★ 复用统一 hireme.db 单例
      stateChangeListener(userObj) {
        try { broadcastToAllViews('auth-state-change', userObj); } catch (_) {}
      }
    });
  }
  SAFE_LOG('phase:authService', 'ok');
} catch (e) {
  const stack = (e && e.stack) ? e.stack : String(e);
  SAFE_LOG('phase:authService:FAIL', stack);
  console.warn('[auth] AuthService 初始化失败（降级为 null）：', e && e.message);
  authService = null;
}
// 注入到 LocalHttpServer 单例（内部 setAuthService 实现了按账号分 session 目录）
try {
  if (authService && localHttpServer && typeof localHttpServer.setAuthService === 'function') {
    localHttpServer.setAuthService(authService);
  }
} catch (e) {
  console.warn('[auth] setAuthService 注入失败：', e && e.message);
}

// ★ 预置默认账号：确保始终存在一个管理员账号，
//   邮箱 15376110673@163.com / 密码 123456，便于直接登录体验。
//   不存在则创建；已存在（DUPLICATE_EMAIL）视为成功，不覆盖密码。
try {
  if (authService) {
    const r = authService.createAccount({
      email: '15376110673@163.com',
      password: '123456',
      displayName: '默认账号',
      isAdmin: true,
    });
    if (r && r.ok) console.log('[auth] 已预置默认账号：15376110673@163.com');
    else if (r && r.error === 'DUPLICATE_EMAIL') console.log('[auth] 默认账号已存在：15376110673@163.com');
    else console.warn('[auth] 预置默认账号结果：', r && r.error);
  } else {
    console.warn('[auth] authService 未就绪，跳过预置默认账号');
  }
} catch (e) { console.warn('[auth] 预置默认账号异常：', e && e.message); }

// 暴露给外部 IPC 复用：判断当前账号 ID（用于 resume/kb 按账号拼路径）
function currentAccountIdSafe() {
  try { return authService.currentAccountId || GUEST_ACCOUNT_ID; } catch (_) { return GUEST_ACCOUNT_ID; }
}

// ============================================================
// ★ 【三端统一】ConfigManager 延后初始化（必须在 AuthService 之后）
//   - externalDb       ：复用 _unifiedDb 共享句柄（第 3 个模块共享连接）
//   - accountProvider  ：currentAccountIdSafe()（多账号隔离必须，拿当前登录账号 id）
// ============================================================
SAFE_LOG('init:ConfigManager', 'start');
try {
  if (ConfigManager) {
    configManager = new ConfigManager(userDataPath, {
      externalDb:      _unifiedDb || null,
      accountProvider: () => currentAccountIdSafe(),
    });
    SAFE_LOG('init:ConfigManager', 'ok');
  } else {
    SAFE_LOG('init:ConfigManager', 'skip: module not loaded');
  }
} catch (e) {
  const stack = (e && e.stack) ? e.stack : String(e);
  SAFE_LOG('init:ConfigManager:FAIL', stack);
  try { process.stderr.write(`[init:FAIL] ConfigManager :: ${stack}\n`); } catch (_) {}
  configManager = null;
  console.warn('[config] ConfigManager 初始化失败（降级为 null）：', e && e.message);
}
// 空兜底：后续所有 loadConfig / saveConfig / saveResume 等函数即使 configManager=null 也不抛错
if (!configManager) {
  try {
    const { defaultInterviewConfig } = require('./src/shared/interview-config');
    configManager = {
      config: defaultInterviewConfig && typeof defaultInterviewConfig === 'function' ? defaultInterviewConfig() : {},
      loadConfig()     { try { return this.config; } catch (_) { return {}; } },
      saveConfig()     { /* noop */ },
      loadHistory()    { return []; },
      saveHistory()    { /* noop */ },
      loadResume()     { return { success: false, error: 'ConfigManager 未就绪' }; },
      saveResume()     { return { success: false, error: 'ConfigManager 未就绪' }; },
      deleteResume()   { return { success: false, error: 'ConfigManager 未就绪' }; },
      saveSession()    { return { success: false, error: 'ConfigManager 未就绪' }; },
      listSessions()   { return []; },
      saveRecording()  { /* noop */ },
      saveReview()     { return { success: false, error: 'ConfigManager 未就绪' }; },
    };
  } catch (_nocfg) {
    configManager = {
      config: {},
      loadConfig()     { return {}; },
      saveConfig()     {},
      loadHistory()    { return []; },
      saveHistory()    {},
      loadResume()     { return { success: false, error: 'ConfigManager 未就绪' }; },
      saveResume()     { return { success: false, error: 'ConfigManager 未就绪' }; },
      deleteResume()   { return { success: false, error: 'ConfigManager 未就绪' }; },
      saveSession()    { return { success: false, error: 'ConfigManager 未就绪' }; },
      listSessions()   { return []; },
      saveRecording()  {},
      saveReview()     { return { success: false, error: 'ConfigManager 未就绪' }; },
    };
  }
}

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
      // 注：「截图/录屏不可见」已解耦为独立的 captureHide 开关（默认开启），
      // 此处隐身模式只负责鼠标穿透 + 跳过任务栏，不再重复设置捕获排除。
      // 通知渲染层切换 class
      mainWindow.webContents.send('stealth-mode-changed', true);
      showNotification('面试助手', '已进入隐身模式');
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
    // ★ 闪屏修复：先不显示，等页面 load + first-paint 之后再一次性 show，
    //    避免用户看到「白屏 → Copilot 半渲染 → 登录页」的混乱过渡。
    show: false,
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

  // ★ 闪屏修复：did-finish-load + first-paint 之后再显示窗口
  //   first-paint 之后浏览器已完成首帧绘制，此时用户看到的就是"完整正确"的页面，
  //   而不是 HTML 未加载完/JS 还没切路由的中间状态。
  let didFirstPaint = false;
  mainWindow.webContents.once('did-finish-load', () => {
    const tryShow = () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      try { if (!mainWindow.isVisible()) mainWindow.show(); } catch (_) {}
    };
    if (didFirstPaint) { tryShow(); return; }
    try {
      mainWindow.webContents.once('paint', () => { didFirstPaint = true; tryShow(); });
      // 兜底：如果 600ms 内没有 paint 事件（比如 GPU 合成跳过 paint），仍然 show
      //   避免窗口"卡住不显示"。
      setTimeout(() => { didFirstPaint = true; tryShow(); }, 600);
    } catch (_) {
      didFirstPaint = true; tryShow();
    }
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
    unregisterWindow('main');  // 注销主窗口，避免脏引用
  });

  // ★ 登记主窗口到统一排除注册表，并按当前开关施加「截图/录屏不可见」
  registerWindow('main', mainWindow);
  captureExclusion.applyCaptureExclusion(mainWindow, captureHideEnabled);

  mainWindow.on('resize', () => {
    const [width, height] = mainWindow.getSize();
    const config = loadConfig();
    config.windowWidth = width;
    config.windowHeight = height;
    saveConfig(config);
  });
}

app.whenReady().then(() => {
  SAFE_LOG('phase:app-whenReady', 'entered');
  try {
    // ★ 启动强制清会话：让每次运行都从未登录态开始，登录页作为默认首页
    try { authService && authService.logoutCurrent && authService.logoutCurrent(); } catch (e) { console.warn('[auth] 启动清会话失败：', e && e.message); }
    SAFE_LOG('phase:app-whenReady', 'auth-logout done');

    // 加载保存的状态
    stateManager && stateManager.load && stateManager.load();
    SAFE_LOG('phase:app-whenReady', 'stateManager.load done');

    // 检查是否有未完成的会话
    try {
      const recoveryData = stateManager && stateManager.getRecoveryData && stateManager.getRecoveryData();
      if (recoveryData && recoveryData.hasUnfinished) {
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
    } catch (e) {
      console.warn('[app] 未完成会话检查失败：', e && e.message);
    }
    SAFE_LOG('phase:app-whenReady', 'recovery check done');

    // 启动自动保存（30秒间隔）
    try { stateManager && stateManager.startAutoSave && stateManager.startAutoSave(30000); } catch (_) {}
    SAFE_LOG('phase:app-whenReady', 'autosave started');

    // 注册 display media handler（解决 renderer 调 getDisplayMedia 抛 "Not supported"）
    // 拦截后我们自己弹一个应用内选择器，用户选完把 source 返回给 getDisplayMedia
    try { setupDisplayMediaHandler(); } catch (e) { console.warn('[app] setupDisplayMediaHandler 失败：', e && e.message); }
    SAFE_LOG('phase:app-whenReady', 'display media handler done');
  } catch (e) {
    const stack = (e && e.stack) ? e.stack : String(e);
    SAFE_LOG('phase:app-whenReady-preWindow:FAIL', stack);
    console.warn('[app] whenReady 前半段（createWindow 之前）异常：', e && e.message);
  }

  // ★ 启动即按配置确定「截图/录屏不可见」开关：默认 config.captureHide=true。
  //   必须在 createWindow() 之前设置，确保主窗口以正确状态创建。
  try {
    const _startCfg = loadConfig();
    captureHideEnabled = _startCfg.captureHide !== false;  // 默认开启
    console.log(`[capture-hide] 启动读取 config.captureHide=${captureHideEnabled}`);
  } catch (e) {
    console.warn('[capture-hide] 读取 config.captureHide 失败，回退默认 true:', e && e.message);
    captureHideEnabled = true;
  }

  try {
    createWindow();
    SAFE_LOG('phase:app-whenReady', 'createWindow done');
  } catch (e) {
    const stack = (e && e.stack) ? e.stack : String(e);
    SAFE_LOG('phase:app-whenReady-createWindow:FAIL', stack);
    console.warn('[app] createWindow 失败：', e && e.message);
  }
  try { createTray(); SAFE_LOG('phase:app-whenReady', 'createTray done'); }
  catch (e) {
    const stack = (e && e.stack) ? e.stack : String(e);
    SAFE_LOG('phase:app-whenReady-createTray:FAIL', stack);
    console.warn('[app] createTray 失败：', e && e.message);
  }

  // 按当前开关对全部已登记窗口（此时至少主窗口）统一施加「从屏幕捕获排除」
  try {
    applyCaptureHideToAll(captureHideEnabled);
    console.log(`[capture-hide] 启动已对全部窗口施加排除=${captureHideEnabled}`);
  } catch (e) {
    console.warn('[capture-hide] 启动施加排除失败（不致命）:', e && e.message);
  }
  SAFE_LOG('phase:app-whenReady', 'capture-hide applied');

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
  SAFE_LOG('phase:app-whenReady', 'attachLocalHttpServerExternals done');

  try {
    const config = loadConfig();
    registerGlobalShortcuts(config);
  } catch (e) {
    console.warn('[app] registerGlobalShortcuts 失败：', e && e.message);
  }
  SAFE_LOG('phase:app-whenReady', 'ALL DONE');
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

    // ★ 登记声源选择器到统一排除注册表，并施加「截图/录屏不可见」（保持与其他窗口一致）
    registerWindow('picker', pickerWindow);
    captureExclusion.applyCaptureExclusion(pickerWindow, captureHideEnabled);

    pickerWindow.setMenuBarVisibility(false);

    pickerWindow.on('closed', () => {
      unregisterWindow('picker');  // 注销选择器，避免脏引用
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
    // 注：「截图/录屏不可见」已解耦为独立开关（captureHide，默认开启），
    // 此处不再重复设置捕获排除。
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

// 独立控制「从屏幕捕获排除」：可在非隐身状态下单独启用（对齐 HireMe 的 applyExcludeFromCapture）。
// 现统一作用于「全部已登记窗口」（主窗口/答题面板/模拟面试浮窗/声源选择器），
// 避免只排除主窗口导致答案面板在截图里露馅。
// 返回 { success, total, ok, method }，method 标识实际生效方式（exclude_from_capture / monitor / content_protection / unsupported）
ipcMain.handle('set-exclude-from-capture', (event, enabled) => {
  captureHideEnabled = !!enabled;
  const res = applyCaptureHideToAll(captureHideEnabled);
  let method = 'unsupported';
  if (res.ok > 0) {
    // 能加载 koffi 即 Windows 路径（内部已优先 EXCLUDEFROMCAPTURE、老系统回退 MONITOR）
    method = captureExclusion.ensureFunc() ? 'exclude_from_capture' : 'content_protection';
  }
  return { success: res.ok > 0, total: res.total, ok: res.ok, method };
});

// ★ 截图/录屏「不可见」独立总开关：实时切换对全部窗口的捕获排除。
// 与隐身模式正交——默认开启，用户可随时在设置面板关闭（用于自己录演示视频）。
// 返回 { success, total, ok, method }
ipcMain.handle('set-capture-hide', (event, enabled) => {
  captureHideEnabled = !!enabled;
  const res = applyCaptureHideToAll(captureHideEnabled);
  let method = 'unsupported';
  if (res.ok > 0) {
    method = captureExclusion.ensureFunc() ? 'exclude_from_capture' : 'content_protection';
  }
  return { success: res.ok > 0, total: res.total, ok: res.ok, method };
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
    // ★ 积分预校验：简历优化 10 积分 / 每次
    //   - 远端 session 存在 → 调 landing /api/console/consume 原子扣费
    //   - 远端 session 不存在 → 不阻断（离线仍能优化），返回 warning 让前端弹提示
    let consumeWarning = null;
    const hasRemote = !!_readRemoteSession();
    if (hasRemote) {
      // 这里复用统一扣费 HTTP 封装
      const r = await _callLanding({
        method: 'POST', pathname: '/api/console/consume',
        body: {
          credits: 10, bizType: 'resume_optimize',
          bizId:   `resume-${Date.now()}`,
          desc:    `简历优化（${String(direction || 'general')}）`,
        },
        timeoutMs: 12000,
      });
      if (!r.ok || !r.data) {
        if (r.data && r.data.code === 'INSUFFICIENT_CREDITS') {
          const cur  = Number(r.data.current)  || 0;
          const need = Number(r.data.required) || 10;
          const miss = Number(r.data.missing)  || (need - cur);
          return {
            success: false, blocked: true, errorCode: 'INSUFFICIENT_CREDITS',
            error: `积分不足，无法开始「简历优化」。当前 ${cur} / 需要 ${need} / 还差 ${miss}。请点击顶部「充值」按钮打开宣传站点控制台充值。`,
            current: cur, required: need, missing: miss,
          };
        }
        // 其它异常：NOT_LOGGED_IN 等 → 降级为"离线允许"
        consumeWarning = (r && r.data && r.data.msg) ? `[积分] ${r.data.msg}，已以离线模式继续。` : `[积分] 远端扣费失败（${r.errorMsg || '未知错误'}），已以离线模式继续。`;
      }
    } else {
      consumeWarning = '未连接宣传站点（离线/本地模式）：本次未扣除积分，简历优化功能仍可使用。';
    }

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
    return { success: true, answer, warning: consumeWarning };
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
// ★ 账号鉴权 IPC：前缀 auth-（9 条）
//   所有错误都以结构化 {ok:false, error, msg?} 形式返回，渲染层根据 error 码展示中文提示。
//   渲染进程**永远拿不到**明文 token / 密码哈希。
// ============================================================
// 1) 当前登录用户（启动即拉一次）：返回 user 形态：{loggedIn,accountId,email,displayName,avatar,...}
//    远端 session 存在且未过期 → 优先返回远端 user（附带 isRemote=true + landingBaseUrl 供渲染层跳转控制台）
ipcMain.handle('auth-current-user', async () => {
  try {
    const remoteSess = _readRemoteSession();
    if (remoteSess && remoteSess.user) {
      const u = remoteSess.user;
      return {
        ok: true,
        loggedIn: true,
        accountId:   u.accountId   || ('remote-' + (u.email || '').replace(/[^a-zA-Z0-9]/g, '_')),
        email:       u.email       || '',
        displayName: u.displayName || (u.email || '').split('@')[0],
        avatar:      u.avatar      || '',
        isAdmin:     !!u.isAdmin,
        createdAt:   u.createdAt   || 0,
        lastLoginTs: u.lastLoginTs || remoteSess.loggedInAt || 0,
        // 桌面端专属附加字段：渲染层可据此决定"显示积分余额""充值按钮""去控制台"
        isRemote:    true,
        balanceMode: 'remote',
        landingBaseUrl: remoteSess.baseUrl || LANDING_BASE_URL,
        remoteExpireAt: remoteSess.expireAt || 0,
      };
    }
    // Fallback：本地账号
    return Object.assign({ ok: true, isRemote: false, balanceMode: 'local', landingBaseUrl: LANDING_BASE_URL }, authService.getCurrentUser());
  } catch (e) {
    console.error('[main][auth-current-user] 异常：', e.message);
    return { ok: false, error: 'EXCEPTION', msg: e.message };
  }
});
// 2) 是否已有任何账号（首次启动引导创建本地管理员）
ipcMain.handle('auth-has-any-account', async () => {
  try { return { ok: true, hasAny: !!authService.hasAnyAccount() }; }
  catch (e) { return { ok: false, error: 'EXCEPTION', msg: e.message }; }
});
// 3) 本地创建账号（首次启动管理员引导 / 宣传网站导入）
//   防护 DEAD_END：本地已有账号时，不允许再通过此 IPC 随意创建（避免用户"公开注册入口"滥用）。
//   如果确实需要手动导入第二个账号，请传 payload._secretAllowMulti=true 并手动编辑 main.js，
//   或直接从 accounts.json 手动复制条目。
ipcMain.handle('auth-create-account', async (_e, payload = {}) => {
  try {
    // ★ DEAD_END 防护：账号已存在 → 直接拒绝
    if (authService.hasAnyAccount() && !(payload && payload._secretAllowMulti === true)) {
      return { ok: false, error: 'DEAD_END', msg: '初始化入口已关闭，请使用正常登录或联系管理员创建账号。' };
    }
    const r = authService.createAccount({
      email: payload && payload.email,
      password: payload && payload.password,
      displayName: payload && payload.displayName,
      avatar: payload && payload.avatar,
      // 首次创建的账号永远是管理员
      isAdmin: true,
    });
    return Object.assign({ ok: r.ok, error: r.error || '' }, r.accountId ? { accountId: r.accountId } : {});
  } catch (e) {
    console.error('[main][auth-create-account] 异常：', e.message);
    return { ok: false, error: 'EXCEPTION', msg: e.message };
  }
});
// 4) 登录：邮箱 + 密码 → currentUser
//    策略：
//      ① 先尝试「宣传站点远端登录」→ 成功即主登录态（带 isRemote=true）；
//      ② 远端不在线（LANDING_OFFLINE）或远端鉴权失败时，自动 fallback 本地账号库；
//      ③ 远端成功后，**顺手**也登录本地同名账号（密码不匹配就跳过不报错），保证 localHttpServer 按 accountId 分目录不崩。
ipcMain.handle('auth-login', async (_e, payload = {}) => {
  try {
    const email    = String((payload && payload.email)    || '').trim();
    const password = String((payload && payload.password) || '');

    // --- 步骤1：先试远端 ---
    const rem = await _remoteLogin(email, password);
    if (rem.ok) {
      // 远端登录成功：尝试本地也登录同名账号（密码不匹配忽略，纯为 localHttpServer 按 accountId 分目录兜底）
      try { authService.login(email, password); } catch (_) {}
      const u = rem.user || {};
      const r2 = {
        ok: true, remote: true,
        loggedIn: true,
        accountId:   u.accountId   || ('remote-' + email.replace(/[^a-zA-Z0-9]/g, '_')),
        email:       u.email       || email,
        displayName: u.displayName || email.split('@')[0],
        avatar:      u.avatar      || '',
        isAdmin:     !!u.isAdmin,
        createdAt:   u.createdAt   || 0,
        lastLoginTs: u.lastLoginTs || Date.now(),
        isRemote:    true, balanceMode: 'remote',
        landingBaseUrl: LANDING_BASE_URL,
        remoteExpireAt: rem.session && rem.session.expireAt ? rem.session.expireAt : 0,
      };
      // 广播 auth-state-change（让顶部栏 / 其它浮窗立即重绘登录态）
      try { broadcastToAllViews('auth-state-change', r2); } catch (_) {}
      return r2;
    }

    // --- 步骤2：fallback 本地账号 ---
    const r = authService.login(email, password);
    if (!r.ok) return { ok: false, error: r.error || 'LOGIN_FAILED', msg: (rem && rem.code === 'REMOTE_LOGIN_FAILED') ? rem.msg : undefined };
    // 本地登录成功也广播
    try { broadcastToAllViews('auth-state-change', Object.assign({ok:true,isRemote:false,balanceMode:'local',landingBaseUrl:LANDING_BASE_URL}, r)); } catch (_) {}
    return Object.assign({ ok: true, isRemote: false, balanceMode: 'local', landingBaseUrl: LANDING_BASE_URL }, r);
  } catch (e) {
    console.error('[main][auth-login] 异常：', e.message);
    return { ok: false, error: 'EXCEPTION', msg: e.message };
  }
});
// 5) 退出登录 → 总会话清 → currentUser(游客)
//    远端登录 → 先远端 logout（清 remote-session.json）+ 再本地 logout；纯本地 → 只本地
ipcMain.handle('auth-logout', async () => {
  try {
    const hasRemote = !!_readRemoteSession();
    if (hasRemote) await _remoteLogout();
    authService.logoutCurrent();
    const next = { ok: true, loggedIn: false, accountId: GUEST_ACCOUNT_ID, email: '', displayName: '游客', avatar: '', isAdmin: false, isRemote: false, balanceMode: 'local', landingBaseUrl: LANDING_BASE_URL };
    try { broadcastToAllViews('auth-state-change', next); } catch (_) {}
    return next;
  } catch (e) {
    console.error('[main][auth-logout] 异常：', e.message);
    return { ok: false, error: 'EXCEPTION', msg: e.message };
  }
});
// 6) 忘记密码步骤1：邮箱 → 返回 8 位重置码 + expireAt
ipcMain.handle('auth-forgot-step1', async (_e, payload = {}) => {
  try {
    const r = authService.forgotStep1GenerateResetCode(payload && payload.email);
    if (r.ok) return { ok: true, resetCode: r.resetCode, expireAt: r.expireAt };
    return { ok: false, error: r.error || 'FAILED' };
  } catch (e) {
    console.error('[main][auth-forgot-step1] 异常：', e.message);
    return { ok: false, error: 'EXCEPTION', msg: e.message };
  }
});
// 7) 忘记密码步骤2：邮箱+重置码+新密码 → ok
ipcMain.handle('auth-forgot-step2-reset', async (_e, payload = {}) => {
  try {
    const r = authService.forgotStep2ResetByCode(
      payload && payload.email,
      payload && payload.resetCode,
      payload && payload.newPassword,
    );
    return r.ok ? { ok: true } : { ok: false, error: r.error || 'FAILED' };
  } catch (e) {
    console.error('[main][auth-forgot-step2-reset] 异常：', e.message);
    return { ok: false, error: 'EXCEPTION', msg: e.message };
  }
});
// 8) 账号设置：改密码（旧密码+新密码）
ipcMain.handle('auth-change-password', async (_e, payload = {}) => {
  try {
    const u = authService.getCurrentUser();
    if (!u || !u.loggedIn) return { ok: false, error: 'NOT_LOGGED_IN' };
    const r = authService.changePassword(u.accountId, payload && payload.oldPassword, payload && payload.newPassword);
    if (r.ok) return Object.assign({ ok: true }, authService.getCurrentUser());
    return { ok: false, error: r.error || 'FAILED' };
  } catch (e) {
    console.error('[main][auth-change-password] 异常：', e.message);
    return { ok: false, error: 'EXCEPTION', msg: e.message };
  }
});
// 9) 账号设置：更新个人资料（昵称/头像）/ 读取账号完整信息
ipcMain.handle('auth-update-profile', async (_e, patch = {}) => {
  try {
    const u = authService.getCurrentUser();
    if (!u || !u.loggedIn) return { ok: false, error: 'NOT_LOGGED_IN' };
    const r = authService.updateProfile(u.accountId, patch || {});
    return r.ok ? Object.assign({ ok: true }, r) : { ok: false, error: r.error || 'FAILED' };
  } catch (e) {
    console.error('[main][auth-update-profile] 异常：', e.message);
    return { ok: false, error: 'EXCEPTION', msg: e.message };
  }
});
// 10) 读取指定账号的完整资料（个人中心只读展示）
ipcMain.handle('auth-get-account', async (_e, accountId) => {
  try {
    const u = authService.getCurrentUser();
    // 仅允许读自己的账号（避免跨账号）
    const id = accountId || (u && u.accountId);
    if (u && u.loggedIn && String(u.accountId) !== String(id)) {
      return { ok: false, error: 'FORBIDDEN' };
    }
    const r = authService.getAccount(id);
    return r ? { ok: true, account: r } : { ok: false, error: 'NOT_FOUND' };
  } catch (e) {
    console.error('[main][auth-get-account] 异常：', e.message);
    return { ok: false, error: 'EXCEPTION', msg: e.message };
  }
});
// 11) 🟢 合并游客(__guest__)的 session / resume 到当前登录账号：【已废弃】
//     —— 需求变更：只要用户登录，就能直接看到 SQLite 中属于自己的相关数据；
//        GUEST 命名空间独立保留（用户登出=回到游客模式时还能看到），不再执行
//        任何 session/resume 的搬运与清空操作。
//     —— 本 IPC 保留返回 ok:true+stats=0，是为了兼容"仍在调用本 IPC 的旧渲染
//        进程/旧前端缓存/第三方调用"，避免它们收到 EXCEPTION 出错。
ipcMain.handle('auth-merge-guest-to-current', async () => {
  try {
    const u = authService.getCurrentUser();
    if (!u || !u.loggedIn) return { ok: false, error: 'NOT_LOGGED_IN' };
    const curId = u.accountId;
    if (String(curId) === GUEST_ACCOUNT_ID) return { ok: false, error: 'BAD_STATE', msg: '当前就是游客账号，无需合并。' };
    console.info('[main][auth-merge-guest-to-current] ℹ️ 合并功能已废弃：直接返回空 stats（不搬运 session/resume，不清空 GUEST）。');
    // 返回与旧版相同字段的"空 stats"，保持前端兼容性
    const stats = {
      sessionMerged: 0,
      sessionFilesCopied: 0,
      sessionSkippedDup: 0,
      resumeMerged: false,
      resumeChars: 0,
      sessionClearedFromGuest: 0,
      resumeClearedFromGuest: false,
      deprecated: true, // 额外告知调用方：本次结果是"废弃空实现"返回的
    };
    return { ok: true, stats };
  } catch (e) {
    console.error('[main][auth-merge-guest-to-current] 异常：', e.message);
    return { ok: false, error: 'EXCEPTION', msg: e.message };
  }
});

// ============================================================
// ★ 积分消费 & 宣传页控制台联动：前缀 credits-
//   设计原则：
//     - 有远端 session → 所有变动走 landing server（原子双写余额+流水，对账一致）
//     - 没远端 session（宣传站没启动 / 本地离线 / 未注册远端）→ 允许"离线使用"，不扣积分
//       但通过 offline:true 明确告知前端，让前端弹提醒。
// ============================================================
// 1) 查询宣传站点服务端状态（给顶部栏 UI 显示用）
ipcMain.handle('credits-get-server-info', async () => {
  const sess = _readRemoteSession();
  return {
    ok: true,
    landingBaseUrl: LANDING_BASE_URL,
    remoteConnected: !!(sess && sess.sessionId),
    remoteExpireAt: sess && sess.expireAt ? sess.expireAt : 0,
  };
});

// 2) 查询当前用户积分余额（远端登录时实时 GET /api/console/credits）
ipcMain.handle('credits-get-balance', async () => {
  const sess = _readRemoteSession();
  if (!sess || !sess.sessionId) {
    return { ok: true, offline: true, balance: null, totalRecharged: 0, totalConsumed: 0, msg: '未连接宣传站点或未远端登录，暂不显示积分余额。' };
  }
  const r = await _callLanding({ method: 'GET', pathname: '/api/console/credits' });
  if (!r.ok || !r.data) {
    // NOT_LOGGED_IN：本地 session 失效 → 清理并回传 offline
    if (r.data && r.data.code === 'NOT_LOGGED_IN') _clearRemoteSession();
    return { ok: false, offline: !!(r.status === 0), error: (r.data && r.data.code) || 'FETCH_FAILED', msg: (r.data && r.data.msg) || r.errorMsg || '拉取余额失败' };
  }
  return { ok: true, offline: false, ...(r.data.credits || {}) };
});

// 3) 扣积分（桌面端三大功能入口在调用"真正业务"前，必须先调本 IPC）
//    payload: { credits: 正整数, bizType: 'copilot_session' | 'mock_round' | 'resume_optimize', bizId?: string, desc?: string }
ipcMain.handle('credits-consume', async (_e, payload = {}) => {
  const credits = Number(payload && payload.credits);
  if (!Number.isSafeInteger(credits) || credits <= 0) {
    return { ok: false, error: 'BAD_CREDITS', msg: '消费积分必须为正整数' };
  }
  const bizType = String((payload && payload.bizType) || '').trim() || 'consume';
  const bizId   = String((payload && payload.bizId)   || '').trim().slice(0, 64);
  const desc    = String((payload && payload.desc)    || '').trim().slice(0, 200);

  const sess = _readRemoteSession();
  if (!sess || !sess.sessionId) {
    // 离线 fallback：允许功能继续，标记 offline=true，让前端弹提醒
    return {
      ok: true, offline: true,
      creditsConsumed: 0, balance: null, flowId: null,
      msg: '离线模式（宣传站点未连接或未远端登录）：本次未扣除宣传站点积分，功能仍可使用。上线后请留意是否需要补扣。',
    };
  }

  const r = await _callLanding({
    method: 'POST', pathname: '/api/console/consume',
    body: { credits, bizType, bizId, desc },
    timeoutMs: 12000,
  });
  if (!r.ok || !r.data) {
    if (r.data && r.data.code === 'NOT_LOGGED_IN') _clearRemoteSession();
    return {
      ok: false, offline: !!(r.status === 0),
      error: (r.data && r.data.code) || 'CONSUME_FAILED',
      msg:   (r.data && r.data.msg)  || r.errorMsg || '扣积分失败',
      // 若是积分不足，把缺失数值透传给前端，让前端直接弹"还差 N 分，去充值"
      ...(r.data && typeof r.data.current === 'number'
           ? { current: r.data.current, required: r.data.required, missing: r.data.missing } : {}),
    };
  }
  // 成功：返回扣费结果 {creditsConsumed, balance, flowId}
  return Object.assign({ ok: true, offline: false }, r.data);
});

// 4) 打开宣传站点控制台 → 用户充值 / 看流水 / 看订单
ipcMain.handle('credits-open-console', async () => {
  try {
    const url = `${LANDING_BASE_URL}/console.html`;
    await shell.openExternal(url);
    return { ok: true, url };
  } catch (e) {
    return { ok: false, error: 'OPEN_FAILED', msg: e.message };
  }
});

// 5) 管理员：打开宣传站点后台（如果账号 isAdmin=true 才有意义；非管理员打开后 landing 会直接 403）
ipcMain.handle('credits-open-admin', async () => {
  try {
    const url = `${LANDING_BASE_URL}/admin.html`;
    await shell.openExternal(url);
    return { ok: true, url };
  } catch (e) {
    return { ok: false, error: 'OPEN_FAILED', msg: e.message };
  }
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
      // ★ 面试类型互斥过滤：'copilot'=仅真实面试 / 'mock'=仅模拟面试 / 空字符串=全部
      category: (opts && opts.category) ? String(opts.category) : '',
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

// ============================================================
// ★ 面试记录【双写模式 Phase 1】SQLite 统一仓储：IPC 句柄（db:sessions-*）
//   - 桌面端渲染进程「面试记录」页面优先走这套句柄（查询性能比 JSON 列表高 10x）
//   - Web 端（Landing）如果与桌面端运行在同一台 PC，可通过本地 HTTP 代理复用同套接口
//   - 失败兜底：SQLite 未就绪时返回 {ok:false, sqliteUnavailable:true, sessions:[]}，
//              前端可据此回退到旧的 interview-session-list JSON 层接口
//   - 权限隔离：所有查询强制绑定当前账号 ID（currentAccountIdSafe），
//              防止越权读别人账号的面试记录（即使前端传了 accountId 参数也会被忽略）
// ============================================================
/**
 * 【IPC】db:sessions-health —— 查询 SQLite 仓库健康状态 + 统计数字
 * 用于前端「面试记录」页首屏先判断：SQLite 是否可用？有没有数据？
 * 返回：{ok, ready, sessionCount, roundCount, categories:{copilot,mock}, dbPath, msg}
 */
ipcMain.handle('db:sessions-health', () => {
  try {
    if (!sessionRepo || !sessionRepo.ready) {
      return { ok: false, ready: false, sqliteUnavailable: true,
        sessionCount: 0, roundCount: 0, categories: { copilot: 0, mock: 0 },
        msg: (sessionRepo && sessionRepo.lastError) ? sessionRepo.lastError.message : 'SQLite 仓库未初始化' };
    }
    const h = sessionRepo.health();
    // 额外按账号+分类细分计数（右上角徽章用）
    const aid = currentAccountIdSafe();
    let cp = 0, mk = 0;
    try {
      const r1 = sessionRepo.listSessions({ accountId: aid, category: 'copilot', limit: 1, offset: 0 });
      const r2 = sessionRepo.listSessions({ accountId: aid, category: 'mock',    limit: 1, offset: 0 });
      cp = Number(r1 && r1.total) || 0;
      mk = Number(r2 && r2.total) || 0;
    } catch (_) { /* ignore */ }
    return { ok: true, ready: true,
      sessionCount: Number(h && h.sessionCount) || 0,
      roundCount:   Number(h && h.roundCount)   || 0,
      categories: { copilot: cp, mock: mk },
      dbPath: (h && h.dbPath) ? String(h.dbPath) : ''
    };
  } catch (e) {
    console.error('[main][db:sessions-health] 异常:', e && e.message);
    return { ok: false, ready: false, sqliteUnavailable: true,
      sessionCount: 0, roundCount: 0, categories: { copilot: 0, mock: 0 },
      msg: e && e.message ? e.message : 'health 失败' };
  }
});

/**
 * 【IPC】db:sessions-list —— 分页查询当前账号的面试记录列表（SQLite 层）
 * 支持：keyword 模糊搜索（公司/职位/标题/摘要）、category 过滤（copilot/mock/空=全部）、
 *       limit/offset 分页；与旧 interview-session-list 返回结构完全兼容，
 *       这样前端不用写两套渲染逻辑，直接替换数据源即可。
 * 参数：opts = { keyword, category, limit, offset }
 * 返回：{ok, total, sessions:[{id,category,title,targetCompany,targetPosition,status,
 *          startedAt,endedAt,lastActiveAt,roundCount,answeredCount,errorCount,durationMs,
 *          snippet,lastRounds,interviewType}], keyword, category, limit, offset }
 */
ipcMain.handle('db:sessions-list', async (event, opts = {}) => {
  try {
    if (!sessionRepo || !sessionRepo.ready) {
      return { ok: false, sqliteUnavailable: true,
        total: 0, sessions: [],
        keyword:  opts && opts.keyword  ? String(opts.keyword)  : '',
        category: opts && opts.category ? String(opts.category) : '',
        limit:    Number(opts && opts.limit)  || 50,
        offset:   Number(opts && opts.offset) || 0,
        msg: 'SQLite 仓库未就绪（可能是 better-sqlite3 未正确安装或 DB 初始化失败）'
      };
    }
    // ★ 安全：强制用当前登录账号 ID，不允许前端传 accountId 绕过隔离
    const aid = currentAccountIdSafe();
    const r = sessionRepo.listSessions({
      accountId: aid,
      keyword:  opts && opts.keyword  ? String(opts.keyword)  : '',
      // category：空字符串表示全部，与面试记录 Tab 切换的 真实面试 / 模拟面试 / 全部 三态对齐
      category: (opts && opts.category && (String(opts.category) === 'copilot' || String(opts.category) === 'mock'))
                ? String(opts.category) : '',
      limit:  Math.max(1, Math.min(200, Number(opts && opts.limit)  || 50)),
      offset: Math.max(0, Number(opts && opts.offset) || 0),
    });
    return Object.assign({ ok: true }, r, {
      keyword:  opts && opts.keyword  ? String(opts.keyword)  : '',
      category: opts && opts.category ? String(opts.category) : '',
    });
  } catch (e) {
    console.error('[main][db:sessions-list] 异常:', e && e.message);
    return { ok: false, error: 'internal',
      total: 0, sessions: [],
      keyword:  opts && opts.keyword  ? String(opts.keyword)  : '',
      category: opts && opts.category ? String(opts.category) : '',
      limit:    Number(opts && opts.limit)  || 50,
      offset:   Number(opts && opts.offset) || 0,
      msg: e && e.message ? e.message : 'list 失败'
    };
  }
});

/**
 * 【IPC】db:sessions-get —— 获取某场面试的完整详情（session + rounds[] + jdSnapshot + resumeSnapshot）
 * 参数：sessionId
 * 返回：{ok:true, session:{...}, rounds:[...]} 或 {ok:false, error, msg}
 *   session 字段：id/category/title/targetCompany/targetPosition/interviewType/status/
 *                startedAt/endedAt/lastActiveAt/roundCount/questionCount/answeredCount/
 *                errorCount/durationMs/jdSnapshot/resumeSnapshot/snippet
 *   round 字段：id/seq/sessionId/status/questionText/answerText/aiAnswer/createdAt/answeredAt/durationMs/meta
 */
ipcMain.handle('db:sessions-get', async (event, id) => {
  try {
    if (!sessionRepo || !sessionRepo.ready) {
      return { ok: false, sqliteUnavailable: true, session: null, rounds: [],
        msg: 'SQLite 仓库未就绪（可能是 better-sqlite3 未正确安装或 DB 初始化失败）' };
    }
    if (!id) {
      return { ok: false, error: 'invalid', msg: 'sessionId 不能为空', session: null, rounds: [] };
    }
    const detail = sessionRepo.getSessionDetail(String(id));
    if (!detail || !detail.id) {
      return { ok: false, error: 'not_found', msg: '未找到该面试记录（可能已被删除或 sessionId 错误）',
        session: null, rounds: [] };
    }
    // ★ 越权校验：确保请求的 session 属于当前登录账号
    const aid = currentAccountIdSafe();
    if (detail.accountId && detail.accountId !== aid) {
      console.warn(`[main][db:sessions-get] ⚠️ 越权访问拦截：requested=${detail.accountId} current=${aid} session=${id}`);
      return { ok: false, error: 'forbidden', msg: '无权查看他人的面试记录', session: null, rounds: [] };
    }
    // 拆分为 session + rounds，与旧 interview-session-get 返回格式保持一致（便于前端无缝切换）
    const rounds = Array.isArray(detail.rounds) ? detail.rounds : [];
    const sessionOnly = Object.assign({}, detail);
    delete sessionOnly.rounds;
    return { ok: true, session: sessionOnly, rounds };
  } catch (e) {
    console.error('[main][db:sessions-get] 异常:', e && e.message);
    return { ok: false, error: 'internal', session: null, rounds: [],
      msg: e && e.message ? e.message : 'get 失败' };
  }
});

/**
 * 【IPC】db:sessions-delete —— 删除某场面试（同时删 session 行 + 关联 rounds）
 * 注意：只标记 SQLite 侧删除，JSON 文件不会动——用户要求清数据时，
 *      如果想删 JSON 文件，前端可并行调旧的删除接口（后续迭代再合并）。
 * 参数：sessionId
 * 返回：{ok:true} 或 {ok:false, error, msg}
 */
ipcMain.handle('db:sessions-delete', async (event, id) => {
  try {
    if (!sessionRepo || !sessionRepo.ready) {
      return { ok: false, sqliteUnavailable: true,
        msg: 'SQLite 仓库未就绪（可能是 better-sqlite3 未正确安装或 DB 初始化失败）' };
    }
    if (!id) return { ok: false, error: 'invalid', msg: 'sessionId 不能为空' };
    // ★ 越权校验：先读详情再判断归属（避免越权删别人的）
    const aid = currentAccountIdSafe();
    const detail = sessionRepo.getSessionDetail(String(id));
    if (!detail || !detail.id) {
      return { ok: false, error: 'not_found', msg: '未找到该面试记录' };
    }
    if (detail.accountId && detail.accountId !== aid) {
      console.warn(`[main][db:sessions-delete] ⚠️ 越权删除拦截：requested=${detail.accountId} current=${aid} session=${id}`);
      return { ok: false, error: 'forbidden', msg: '无权删除他人的面试记录' };
    }
    const r = sessionRepo.deleteSession(String(id));
    if (r) return { ok: true };
    return { ok: false, error: 'delete_fail', msg: '删除失败（可能 DB 锁或已不存在）' };
  } catch (e) {
    console.error('[main][db:sessions-delete] 异常:', e && e.message);
    return { ok: false, error: 'internal', msg: e && e.message ? e.message : 'delete 失败' };
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
  // ★ asr:* 通道诊断：浮窗收不到文字时的根因定位开关
  //   只在 asr:interim / asr:final / asr:recording-status 三个通道打诊断，
  //   其他高频通道（如 local:status-changed）不打，避免刷屏。
  const isAsrChannel = typeof channel === 'string' && channel.startsWith('asr:');
  try {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args);
  } catch (_) { /* 忽略 */ }
  try {
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.webContents.send(channel, ...args);
  } catch (_) { /* 忽略 */ }
  // ★ 模拟面试浮窗也必须收到 ASR 事件广播（asr:interim / asr:final / asr:recording-status）：
  //   语音模式下浮窗靠这些通道把识别文字实时写进作答 textarea；
  //   之前只广播 mainWindow + overlayWindow，导致浮窗永远收不到麦克风转写结果。
  try {
    if (mockInterviewFloatWindow && !mockInterviewFloatWindow.isDestroyed()) {
      const wc = mockInterviewFloatWindow.webContents;
      const floatWcId = wc && typeof wc.id === 'function' ? wc.id : (wc && wc.id);
      const argsPreview = (channel === 'asr:interim' || channel === 'asr:final')
        ? `text="${String(args[0]||'').slice(0, 30)}" len=${String(args[0]||'').length}`
        : `args=${JSON.stringify(args).slice(0, 60)}`;
      if (isAsrChannel) {
        console.log(`[broadcast-ASR] ✉ 向浮窗广播 channel=${channel} wcId=${floatWcId} destroyed=${!!mockInterviewFloatWindow.isDestroyed()} visible=${mockInterviewFloatWindow.isVisible()} ${argsPreview}`);
      }
      mockInterviewFloatWindow.webContents.send(channel, ...args);
      if (isAsrChannel) {
        console.log(`[broadcast-ASR] ✓ send() 调用完成（无同步抛错）：channel=${channel}`);
      }
    } else if (isAsrChannel) {
      // ★ 浮窗不存在/已销毁 但却在广播 ASR 事件 → 说明顺序错了（ASR 启动早于浮窗创建）
      const destroyed = mockInterviewFloatWindow ? mockInterviewFloatWindow.isDestroyed() : '(null)';
      console.log(`[broadcast-ASR] ⚠ 浮窗对象不可用 → ASR 文本不会送达！mockInterviewFloatWindow=${mockInterviewFloatWindow ? 'exists' : 'NULL'} destroyed=${destroyed}`);
    }
  } catch (e) {
    if (isAsrChannel) console.log(`[broadcast-ASR] ❌ 浮窗 send() 异常 channel=${channel}: ${e && e.message}`);
  }
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
  // ★ 登记答题面板到统一排除注册表，并按当前开关施加「截图/录屏不可见」
  //   overlay 是透明 alwaysOnTop 独立窗口，显示标准答案——必须排除，否则录屏会拍到答案。
  registerWindow('overlay', overlayWindow);
  captureExclusion.applyCaptureExclusion(overlayWindow, captureHideEnabled);
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
    unregisterWindow('overlay');  // 注销答题面板，避免脏引用
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
    // ★ 重建后 HWND 变化，旧亲和性失效——重新施加「从捕获排除」，确保截图/录屏仍不可见
    captureExclusion.applyCaptureExclusion(overlayWindow, captureHideEnabled);
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
 *      触发 renderer 显示「面试结束总结页」（查看本场 / 复盘 / 开启新的面试）
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
    let answeredCount = Number((endedSession && (endedSession.answeredCount || 0)) || 0);
    // 兜底：若没 answeredCount 但有 rounds，按 rounds 中 status === 'answered' 计数
    if (!answeredCount && Array.isArray(endedSession && endedSession.rounds) && endedSession.rounds.length) {
      answeredCount = endedSession.rounds.filter((r) => r && r.status === 'answered').length || endedSession.rounds.length;
    }
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
      answeredCount,
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

    // ====== ★ 防御性归一化：部分入口（如模拟面试浮窗）调用 startAsrPipeline() 时不传 config ======
    //   原先直接 config.baiduApiKey 会在 config=undefined 时抛
    //   "TypeError: Cannot read properties of undefined (reading 'baiduApiKey')" 导致管线启动失败
    const inCfg = (config && typeof config === 'object' && !Array.isArray(config)) ? config : {};

    // ====== ★ 兜底合并：传入 config 缺少百度密钥/LLM 服务配置时，从应用全局配置补齐 ======
    //   浮窗首次启动 ASR 没有任何参数 → 百度 Key 必须从用户保存的应用配置里取；
    //   同时 selectedService / tongyiApiKey 等 LLM 字段也一并补齐（管线 AI 判定/答题要用）
    let baseCfg = inCfg;
    if (!inCfg.baiduApiKey || !inCfg.baiduSecretKey || !inCfg.baiduAppId || !inCfg.selectedService) {
      try {
        const appCfg = loadConfig() || {};
        baseCfg = Object.assign({}, appCfg, inCfg); // inCfg 显式传入的值优先，应用配置兜底
        console.log('[main] start-asr-pipeline：传入 config 不完整，已从应用配置兜底合并（baiduApiKey/selectedService 等字段）');
      } catch (cfgErr) {
        console.warn('[main] start-asr-pipeline：应用配置兜底加载失败（继续用传入 config）：', cfgErr && cfgErr.message);
      }
    }

    // 合并环境变量（.env 中的百度 Key 作为兜底）
    const mergedConfig = Object.assign({}, baseCfg, {
      baiduApiKey: baseCfg.baiduApiKey || process.env.BAIDU_API_KEY,
      baiduSecretKey: baseCfg.baiduSecretKey || process.env.BAIDU_SECRET_KEY,
      baiduAppId: baseCfg.baiduAppId || process.env.BAIDU_APP_ID
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

    // 注册回调：app.bus.emit 解耦 + 多窗口 webContents.send
    // ★ transcribeOnly 纯转写模式（模拟面试浮窗）：
    //   bus.emit 会把识别文本写进 localHttpServer 的主面板 history（面试官区），
    //   而麦克风识别的是"用户自己的回答"——必须跳过 bus，只向各窗口（含浮窗）广播。
    const isTranscribeOnly = !!(mergedConfig && mergedConfig.transcribeOnly);
    asrPipeline.onInterim = (text) => {
      if (!isTranscribeOnly) app.bus.emit('asr:interim', text);
      broadcastToAllViews('asr:interim', text);
    };
    asrPipeline.onFinal = (text) => {
      if (!isTranscribeOnly) app.bus.emit('asr:final', text);
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

/**
 * 按账号返回简历路径（支持多账号隔离）：
 *   - 未登录 → {userDataPath}/accounts/__guest__/resume.md
 *   - 已登录 accountId=xxx → {userDataPath}/accounts/xxx/resume.md
 * 首次调用时顺带执行"老全局简历迁移到 guest 账号"（仅一次）
 */
let _resumeMigrated = false;
function _getResumePath() {
  const p = authService.resolveAccountPath(null, 'resume.md');
  if (!_resumeMigrated) {
    _resumeMigrated = true;
    try {
      const legacyPath = path.join(userDataPath, 'resume.md');
      if (fs.existsSync(legacyPath) && !fs.existsSync(p)) {
        const buf = fs.readFileSync(legacyPath);
        fs.writeFileSync(p, buf);
        console.log('[resume-migrate] ✅ 已把全局 resume.md 迁移到账号 ' + authService.currentAccountId + ' 命名空间');
        // 老文件不删（留备份），避免万一失败
      }
      // resume_meta.json 同样迁移（解析器信息）
      const legacyMeta = path.join(userDataPath, 'resume_meta.json');
      const metaDir = path.dirname(p);
      const newMeta = path.join(metaDir, 'resume_meta.json');
      if (fs.existsSync(legacyMeta) && !fs.existsSync(newMeta)) {
        fs.copyFileSync(legacyMeta, newMeta);
      }
    } catch (e) {
      console.warn('[resume-migrate] 迁移异常（不影响后续运行）：', e.message);
    }
  }
  return p;
}

/** 获取同目录下的 resume_meta.json 路径（解析缓存） */
function _getResumeMetaPath() { return path.join(path.dirname(_getResumePath()), 'resume_meta.json'); }

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

// 保存简历内容（按当前登录账号隔离）
ipcMain.handle('save-resume', async (event, content) => {
  try {
    const p = _getResumePath();
    fs.writeFileSync(p, content, 'utf-8');

    // 隐私审计：数据保存操作
    privacyAudit.logDataOperation('resume', 'save', Buffer.byteLength(content, 'utf-8'));

    // 检测敏感信息
    const sensitiveInfo = privacyAudit.detectSensitiveInfo(content);
    if (sensitiveInfo.length > 0) {
      privacyAudit.logSensitiveData('resume', 'multiple_detected', '简历内容(' + currentAccountIdSafe() + ')');
      return {
        success: true,
        warning: '简历中检测到敏感信息，请注意隐私保护',
        detected: sensitiveInfo
      };
    }

    // 更新状态：key 按账号命名空间化，避免多账号相互覆盖
    const ns = 'resume:' + currentAccountIdSafe();
    stateManager.update(`${ns}.content`, content);
    stateManager.update(`${ns}.filePath`, p);
    stateManager.update(`${ns}.lastModified`, Date.now());

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// 加载保存的简历（按当前登录账号隔离）
ipcMain.handle('load-resume', async () => {
  try {
    const p = _getResumePath();
    if (fs.existsSync(p)) {
      const content = fs.readFileSync(p, 'utf-8');
      return { success: true, content, meta: _readResumeMeta(_getResumeMetaPath()), accountId: currentAccountIdSafe() };
    }
    return { success: false, error: '简历不存在', accountId: currentAccountIdSafe() };
  } catch (error) {
    return { success: false, error: error.message, accountId: currentAccountIdSafe() };
  }
});

// 删除保存的简历（按当前登录账号隔离）
ipcMain.handle('delete-resume', async () => {
  try {
    const p = _getResumePath();
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
    }
    // 清同名命名空间下的 meta
    const m = _getResumeMetaPath();
    if (fs.existsSync(m)) { try { fs.unlinkSync(m); } catch (_) {} }
    // 更新状态（按账号命名空间）
    const ns = 'resume:' + currentAccountIdSafe();
    stateManager.update(`${ns}.content`, '');
    stateManager.update(`${ns}.filePath`, null);
    stateManager.update(`${ns}.lastModified`, null);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// 辅助：读取 resume_meta.json（解析器 / 字数等缓存信息）
function _readResumeMeta(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (_) { return null; }
}

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
    const r = { ok: true, status: localHttpServer.getStatus() };
    // 诊断：每秒轮询一次会刷屏，所以只在状态变化 / 参数异常（port=0 或 token 空）时才打印
    const st = r && r.status ? r.status : null;
    const port = Number(st && st.port) || 0;
    const tokenLen = String((st && st.token) || '').length;
    if (port === 0 || tokenLen === 0) {
      console.log(`[mock-interview][main][IPC:get-server-status] ⚠ 返回值异常：port=${port} tokenLen=${tokenLen}`);
    }
    return r;
  } catch (e) {
    console.error(`[mock-interview][main][IPC:get-server-status] ✗ 内部异常：${e && e.message}`);
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
  const t0 = Date.now();
  console.log(`[mock-interview][main][IPC:get-server-http-info] ? 收到请求，准备启动/读取 HTTP 服务状态...`);
  try {
    attachLocalHttpServerExternals();
    let started = false;
    if (localHttpServer.status === 'idle') {
      await localHttpServer.start({ bus: app.bus });
      started = true;
    }
    const st = localHttpServer.getStatus() || {};
    const port = Number(st && st.port) || 0;
    const token = String(st && st.token ? st.token : '');
    const r = {
      ok: true,
      isRunning: !!st && st.status && st.status !== 'idle',
      port,
      token,
      baseUrl: (st && st.port) ? `http://127.0.0.1:${st.port}` : '',
      status: st
    };
    console.log(`[mock-interview][main][IPC:get-server-http-info] ✓ 返回：startedNew=${started} port=${port} token=${token ? `${token.slice(0,4)}***${token.slice(-4)}(len=${token.length})` : '<empty>'} baseUrl=${r.baseUrl || '(空)'} 用时=${Date.now() - t0}ms`);
    return r;
  } catch (e) {
    console.error(`[mock-interview][main][IPC:get-server-http-info] ✗ 内部异常：${e && e.message} 用时=${Date.now() - t0}ms 堆栈：\n${e && e.stack || 'no-stack'}`);
    return { ok: false, error: 'internal', msg: e && e.message || '获取 HTTP 服务失败', isRunning:false, port:0, token:'', baseUrl:'' };
  }
});

// ============================================================
// ★ 模拟面试浮动面板 BrowserWindow（mockInterviewFloatWindow）
// 职责划分：
//   - 主进程(main.js)：创建/销毁 BrowserWindow、窗口尺寸/置顶/位置、接收 startParams 并在 did-finish-load 时推送给渲染层
//   - 渲染进程(mockInterviewFloat.html + mockInterviewFloatRenderer.js)：UI 渲染、作答流程推进、语音/文字交互、调用 localHttpServer 接口
// 用法：主窗口 mockResumePanels.js 在用户点击"开始模拟面试"后，先调 HTTP /session 启动会话，
//       再调 electronAPI.openMockInterviewFloatWin(startParams) 打开浮窗。
// ============================================================

/**
 * 获取模拟面试浮窗当前状态：{exists, bounds}
 * @returns {{exists:boolean, bounds:null|{x:number,y:number,width:number,height:number}}}
 */
function getMockInterviewFloatStatus() {
  const exists = !!(mockInterviewFloatWindow && !mockInterviewFloatWindow.isDestroyed());
  let bounds = null;
  if (exists) {
    try { bounds = mockInterviewFloatWindow.getBounds(); } catch (_) { bounds = null; }
  }
  return { exists, bounds };
}

/**
 * 关闭模拟面试浮窗：释放资源 + 清引用
 */
function closeMockInterviewFloatWindow() {
  if (!mockInterviewFloatWindow) return;
  try {
    if (!mockInterviewFloatWindow.isDestroyed()) mockInterviewFloatWindow.close();
  } catch (_) { /* 忽略关窗过程中的异常 */ }
  mockInterviewFloatWindow = null;
}

/**
 * 创建/显示模拟面试浮动面板窗口。
 * - 若窗口已存在：仅 focus/show，不会重建。
 * - startParams 结构（由渲染层传入）：
 *   { answerMode:'voice'|'text', totalQuestions:number, language:'zh'|'en',
 *     positionLabel:string, industryLabel:string, typeLabel:string, serverInfo:{port,token,baseUrl} }
 * @returns {BrowserWindow|null}
 */

/**
 * ★ 浮动面板补发定时器 & ack 管理（核心修复：主进程监听 IPC ack 必须用 ipcMain.on，不能用 wc.on）
 *   数据结构：Map<webContentsId, Set<Timeout>>
 *   作用：
 *    1. 创建/补发 startParams 时把 setTimeout 返回值放入对应 wcId 的 Set
 *    2. 收到浮窗 ipcRenderer.send('mock-interview:started-ack') 时，按 evt.sender.id 找到该 wc
 *    3. 清掉所有未到期的补发定时器（t2/t3 等）
 *    4. 浮窗 closed 时按 wcId 清理整组，避免内存泄漏
 */
const _mockFloatPendingByWcId = new Map();

/**
 * 一次性全局注册：浮窗启动成功后发的 mock-interview:started-ack 事件
 * 【注意】必须用 ipcMain.on 接收 ipcRenderer.send，wc.on('mock-interview:started-ack', ...) 永远不会触发
 */
(function _registerMockFloatAckListenerOnce() {
  if (global._mockFloatAckRegistered) return;
  try { global._mockFloatAckRegistered = true; } catch (_) { /* ignore */ }
  ipcMain.on('mock-interview:started-ack', (evt) => {
    try {
      const senderWc = evt && evt.sender;
      // 先检查 senderWc 是否存在，再检查是否有 isDestroyed 方法且已销毁（加括号明确 && 优先级）
      if (!senderWc || (typeof senderWc.isDestroyed === 'function' && senderWc.isDestroyed())) return;
      const wcId = Number(senderWc.id);
      if (!wcId) return;
      const timers = _mockFloatPendingByWcId.get(wcId);
      if (!timers || timers.size === 0) {
        console.log(`[mock-interview][main][ack] ✓ 收到浮窗 ack（wcId=${wcId}），无待取消的补发定时器`);
        return;
      }
      let count = 0;
      timers.forEach(t => { try { clearTimeout(t); count++; } catch (_) {} });
      timers.clear();
      console.log(`[mock-interview][main][ack] ✓ 收到浮窗 ack（wcId=${wcId}），已取消 ${count} 个未执行的补发定时器`);
      // 窗口已存在分支用的是同一个 wc，也注册了 ack 清理，保持 set 即可（不清 Map key，多次 create 时复用）
    } catch (e) {
      console.warn(`[mock-interview][main][ack] 处理浮窗 ack 异常（非致命）：${e && e.message}`);
    }
  });
  console.log(`[mock-interview][main][ack] 全局 ack 监听器已一次性注册（ipcMain.on mock-interview:started-ack）`);
})();

/**
 * 一次性全局注册：浮窗 → 主进程 的『诊断日志』通道（排障专用，避免用户必须开浮窗 DevTools 才能看到业务层日志）
 *   对应 src/renderer/mockInterviewFloatRenderer.js 中 F_DIAG.send()
 *   打印格式：[float][wcId=xx] ❌/⚠️/ℹ️ [level] tagMsg | summary（已脱敏+裁剪，安全可直接看）
 */
(function _registerMockFloatDiagnosticListenerOnce() {
  if (global._mockFloatDiagRegistered) return;
  try { global._mockFloatDiagRegistered = true; } catch (_) { /* ignore */ }
  ipcMain.on('mock-interview:diagnostic', (evt, payload) => {
    try {
      const senderWc = evt && evt.sender;
      // 安全判断：必须存在 senderWc → 且若有 isDestroyed 方法则需未销毁 → 取 id
      const wcId = (senderWc && (typeof senderWc.isDestroyed !== 'function' || !senderWc.isDestroyed())) ? Number(senderWc.id) : 0;
      const level = (payload && payload.level) ? String(payload.level) : 'info';
      const tagMsg = String(payload && payload.tagMsg || '');
      const summary = String(payload && payload.summary || '');
      const icon = (level === 'error') ? '❌' : (level === 'warn' ? '⚠️' : 'ℹ️');
      const prefix = `[float][wcId=${wcId}]${icon}[${level}]`;
      if (summary) console.log(`${prefix} ${tagMsg} | ${summary}`);
      else console.log(`${prefix} ${tagMsg}`);
    } catch (e) {
      // 诊断通道自身失败时，仅打一行 warn，不能吞掉/干扰正常业务日志
      console.warn(`[mock-interview][main][diag] 处理浮窗诊断消息异常（非致命）：${e && e.message}`);
    }
  });
  console.log(`[mock-interview][main][diag] 全局浮窗诊断监听器已一次性注册（ipcMain.on mock-interview:diagnostic）`);
})();

/**
 * 一次性全局注册：preload.js 执行探针监听器（判断"preload 到底有没有执行、是在哪个窗口执行的"）
 *   对应 preload.js 开头 ipcRenderer.send('preload-executed', probe)
 *   打印字段：wcId / window / process.type / contextIsolated / electronAPIBefore(挂载前是否已存在) / preload 文件路径
 *   判断依据：如果创建浮窗后没有任何 [preload-probe][wcId=xx] 日志 → 100% 证明 preload 没有被 BrowserWindow 调用（可能 webPreferences.preload 路径错、或 sandbox 强制 true 禁用 Node API）
 */
(function _registerPreloadProbeListenerOnce() {
  if (global._preloadProbeRegistered) return;
  try { global._preloadProbeRegistered = true; } catch (_) { /* ignore */ }
  ipcMain.on('preload-executed', (evt, probe) => {
    try {
      const senderWc = evt && evt.sender;
      const wcId = (senderWc && (typeof senderWc.isDestroyed !== 'function' || !senderWc.isDestroyed())) ? Number(senderWc.id) : 0;
      const hostWebContentsType = (senderWc && senderWc.hostWebContents && senderWc.hostWebContents.id) ? `webview(hostWcId=${senderWc.hostWebContents.id})` : 'window';
      const p = probe || {};
      console.log(`[preload-probe][wcId=${wcId}] ✓ preload.js 已执行（type=${hostWebContentsType}）：processType=${String(p.processType||'')} contextIsolated=${String(p.contextIsolated)} hasCtxBridge=${!!p.hasContextBridge} hasIpc=${!!p.hasIpcRenderer} typeofWindow=${String(p.typeofWindow)} electronAPI_before_bridge=${!!p.electronAPIBefore} script=${String(p.preloadScriptLocation||'')}`);
    } catch (e) {
      console.warn(`[preload-probe] 处理探针消息异常（非致命）：${e && e.message}`);
    }
  });
  console.log(`[preload-probe] 全局 preload 执行探针监听器已一次性注册（ipcMain.on preload-executed）`);
})();

/**
 * 一次性全局注册：『浮窗 → 主进程 Node.js 代发 HTTP 请求』代理通道
 * ★ 终极兜底方案（彻底解决 file:// → http:// 同源策略/CSP/Chromium 拦截问题）
 *   原理：Node.js 的 http/https 模块没有同源策略、没有 CSP、没有协议限制 → 100% 能通
 *   对应：mockInterviewFloatRenderer.js apiFetch 中，当原生 fetch 出现"Failed to fetch"（Chromium 拦截特征）时自动回退到 IPC 代发
 *   请求参数（req）：{ url, method, headers, body(String|Object) , timeoutMs }
 *   返回结构（总是同步 resolve，不会在 IPC 层 reject）：
 *     成功：{ ok:true,  status, statusText, data(json 或 null), rawText, elapsedMs }
 *     失败：{ ok:false, status, statusText, errorMsg, rawText, elapsedMs, cause }
 */
(function _registerMockInterviewHttpProxyOnce() {
  if (global._mockHttpProxyRegistered) return;
  try { global._mockHttpProxyRegistered = true; } catch (_) { /* ignore */ }
  // 提前加载 Node 内置 http/https 模块（懒加载，失败时告知用户）
  const httpMod = (function () { try { return require('http'); } catch (_) { return null; } })();
  const httpsMod = (function () { try { return require('https'); } catch (_) { return null; } })();
  const { URL } = require('url');

  ipcMain.handle('mock-interview:http-proxy', async (_evt, req) => {
    const t0 = Date.now();
    try {
      const r = req || {};
      const rawUrl = String(r.url || '').trim();
      const method = String(r.method || 'GET').toUpperCase();
      const timeoutMs = Number(r.timeoutMs) || 120000; // 默认 120s 超时
      if (!rawUrl) {
        return { ok: false, status: 0, errorMsg: 'HTTP Proxy: url 为空', elapsedMs: Date.now() - t0 };
      }
      // 1. 解析 URL（识别 http/https，取 host/path）
      let u;
      try { u = new URL(rawUrl); } catch (parseErr) {
        return { ok: false, status: 0, errorMsg: `HTTP Proxy: URL 解析失败（${parseErr && parseErr.message || '未知错误'}），url=${rawUrl.slice(0, 200)}`, elapsedMs: Date.now() - t0 };
      }
      const useHttps = (u.protocol === 'https:');
      const mod = useHttps ? httpsMod : httpMod;
      if (!mod) {
        return { ok: false, status: 0, errorMsg: `HTTP Proxy: 缺少 Node ${useHttps ? 'https' : 'http'} 内置模块（运行环境异常）`, elapsedMs: Date.now() - t0 };
      }
      // 2. 处理 headers（对象 → 大小写兼容）+ 处理 body
      const headers = {};
      if (r.headers && typeof r.headers === 'object') {
        Object.keys(r.headers).forEach(k => {
          try { headers[String(k)] = String(r.headers[k]); } catch (_) {}
        });
      }
      let sendBody = null;
      if (r.body !== undefined && r.body !== null && ['POST','PUT','PATCH'].indexOf(method) >= 0) {
        if (Buffer.isBuffer(r.body)) {
          sendBody = r.body;
          if (!headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/octet-stream';
        } else if (typeof r.body === 'string') {
          sendBody = r.body;
          if (!headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'text/plain; charset=utf-8';
        } else {
          try {
            sendBody = JSON.stringify(r.body);
            if (!headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/json; charset=utf-8';
          } catch (jsonErr) {
            return { ok: false, status: 0, errorMsg: `HTTP Proxy: body 序列化失败（${jsonErr && jsonErr.message}）`, elapsedMs: Date.now() - t0 };
          }
        }
        if (sendBody && Buffer.isBuffer(sendBody)) headers['Content-Length'] = String(Buffer.byteLength(sendBody));
        else if (typeof sendBody === 'string') headers['Content-Length'] = String(Buffer.byteLength(sendBody, 'utf8'));
      }
      // 3. 构造请求选项
      const options = {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port ? Number(u.port) : (useHttps ? 443 : 80),
        method,
        path: u.pathname + (u.search || ''),
        headers,
        timeout: timeoutMs
      };
      if (useHttps) {
        // HTTPS 时允许通义/百炼自签或 SNI 场景（避免极端环境拦截）
        options.rejectUnauthorized = true;
      }

      // 4. 发起请求（用 Promise 包装回调形式）
      const result = await new Promise((resolve) => {
        let _timedOut = false;
        let _finished = false;
        const reqObj = mod.request(options, (res) => {
          // 收集响应体
          const chunks = [];
          res.on('data', (c) => { try { chunks.push(c); } catch (_) {} });
          res.on('end', () => {
            if (_finished) return;
            _finished = true;
            let rawText = '';
            try { rawText = Buffer.concat(chunks).toString('utf8'); } catch (_) { rawText = ''; }
            let data = null;
            const ct = (res.headers && (res.headers['content-type'] || res.headers['Content-Type'])) ? String(res.headers['content-type'] || res.headers['Content-Type']) : '';
            if (ct.indexOf('application/json') >= 0 || rawText.trim().startsWith('{') || rawText.trim().startsWith('[')) {
              try { data = JSON.parse(rawText); } catch (_) { data = null; }
            }
            const status = Number(res.statusCode) || 0;
            resolve({
              ok: status >= 200 && status < 300,
              status,
              statusText: String(res.statusMessage || ''),
              data,
              rawText
            });
          });
          res.on('error', (e) => {
            if (_finished) return;
            _finished = true;
            resolve({ ok: false, status: 0, errorMsg: `响应体读取失败：${e && e.message || '未知错误'}`, cause: String(e && e.message || '') });
          });
        });
        // 请求级错误（DNS 解析失败/拒绝连接/TLS 握手中途断开等）
        reqObj.on('error', (e) => {
          if (_finished) return;
          _finished = true;
          resolve({ ok: false, status: 0, errorMsg: `请求失败：${e && e.message || '未知错误'}`, cause: String(e && e.message || '') });
        });
        // 超时：主动 abort（避免无限等待）
        reqObj.on('timeout', () => {
          if (_finished || _timedOut) return;
          _timedOut = true;
          try { reqObj.destroy(new Error(`timeout after ${timeoutMs}ms`)); } catch (_) {}
        });
        // 写 body
        if (sendBody !== null) {
          try { reqObj.write(sendBody); } catch (writeErr) {
            if (_finished) return;
            _finished = true;
            resolve({ ok: false, status: 0, errorMsg: `写入 body 失败：${writeErr && writeErr.message || ''}`, cause: String(writeErr && writeErr.message || '') });
            return;
          }
        }
        try { reqObj.end(); } catch (endErr) {
          if (_finished) return;
          _finished = true;
          resolve({ ok: false, status: 0, errorMsg: `req.end 失败：${endErr && endErr.message || ''}`, cause: String(endErr && endErr.message || '') });
        }
      });

      const elapsedMs = Date.now() - t0;
      // 打印代理请求诊断日志（脱敏 Authorization）
      const authRaw = String(headers['Authorization'] || headers['authorization'] || '');
      const authMasked = authRaw ? authRaw.replace(/(Bearer\s+)([A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]{4,})/i, (_, p1, p2) => `${p1}${p2.slice(0,4)}***${p2.slice(-3)}(len=${p2.length})`) : '';
      console.log(`[mock-interview][main][HTTP-Proxy] ${result.ok ? '✅' : '❌'} ${method} ${rawUrl.slice(0, 320)} | HTTP ${result.status || 0} | auth=${authMasked || '(no auth)'} | elapsed=${elapsedMs}ms | error=${result.errorMsg ? result.errorMsg.slice(0, 200) : '(none)'}`);
      return { ...result, elapsedMs };
    } catch (outerErr) {
      const elapsedMs = Date.now() - t0;
      console.error(`[mock-interview][main][HTTP-Proxy] ❌ 代理顶层异常：${outerErr && outerErr.message || '未知错误'} (elapsed=${elapsedMs}ms)`);
      return { ok: false, status: 0, errorMsg: `HTTP Proxy 顶层异常：${outerErr && outerErr.message || '未知错误'}`, elapsedMs };
    }
  });
  console.log(`[mock-interview][main][HTTP-Proxy] 全局 HTTP 代理 IPC 通道已一次性注册（ipcMain.handle mock-interview:http-proxy），使用 Node ${httpMod ? 'http' : '!!HTTP缺失!!'}/${httpsMod ? 'https' : '!!HTTPS缺失!!'} 模块代发请求`);
})();

/**
 * 辅助：把某个补发定时器注册到指定 wc 的待取消集合中
 * @param {Electron.WebContents} wc 目标浮窗的 webContents
 * @param {NodeJS.Timeout} timer setTimeout 返回的定时器
 */
function _trackMockFloatTimer(wc, timer) {
  if (!wc || !timer) return;
  if (wc.isDestroyed && wc.isDestroyed()) return;
  const wcId = Number(wc.id);
  if (!wcId) return;
  if (!_mockFloatPendingByWcId.has(wcId)) _mockFloatPendingByWcId.set(wcId, new Set());
  _mockFloatPendingByWcId.get(wcId).add(timer);
}

/**
 * 辅助：浮窗 closed 时清掉 wcId 对应的所有补发定时器
 * @param {Electron.WebContents} wc 目标浮窗的 webContents
 */
function _clearMockFloatTimersByWc(wc) {
  if (!wc) return;
  try {
    const wcId = Number(wc.id);
    if (!wcId) return;
    const timers = _mockFloatPendingByWcId.get(wcId);
    if (timers) {
      timers.forEach(t => { try { clearTimeout(t); } catch (_) {} });
      timers.clear();
      _mockFloatPendingByWcId.delete(wcId);
    }
  } catch (_) { /* ignore */ }
}

function createMockInterviewFloatWindow(startParams) {
  // 1) 诊断：打印最终下发的 startParams（脱敏 token），保证主进程控制台能看到注入是否成功
  try {
    const p = (startParams && typeof startParams === 'object') ? startParams : {};
    const safe = {
      answerMode: p.answerMode, totalQuestions: p.totalQuestions, language: p.language,
      typeLabel: p.typeLabel, interviewType: p.interviewType, positionLabel: p.positionLabel, industryLabel: p.industryLabel,
      port: Number((p.serverInfo && p.serverInfo.port) || 0),
      baseUrl: (p.serverInfo && p.serverInfo.baseUrl) ? String(p.serverInfo.baseUrl).replace(/\/$/, '') : '',
      token: (p.serverInfo && p.serverInfo.token) ? `${String(p.serverInfo.token).slice(0, 4)}***${String(p.serverInfo.token).slice(-4)}(len=${String(p.serverInfo.token).length})` : '<empty>'
    };
    console.log(`[mock-interview][main][createFloat] ▶ createMockInterviewFloatWindow 开始，startParams 快照：${JSON.stringify(safe)}`);
  } catch (_) { /* ignore 诊断日志异常 */ }

  // 窗口已存在：直接显示 + 重新下发 startParams（避免重建时资源丢失）
  if (mockInterviewFloatWindow && !mockInterviewFloatWindow.isDestroyed()) {
    mockInterviewFloatWindow.show();
    mockInterviewFloatWindow.focus();
    // 已存在窗口：走一次双发机制（第一次立即，第二次 250ms 后）
    try {
      const wc = mockInterviewFloatWindow.webContents;
      wc.send('mock-interview:start-params', startParams || {});
      console.log(`[mock-interview][main][createFloat] ✓ 窗口已存在，立即发送 startParams`);
      const t2 = setTimeout(() => {
        if (!mockInterviewFloatWindow.isDestroyed() && wc && !wc.isDestroyed()) {
          try { wc.send('mock-interview:start-params', startParams || {}); console.log(`[mock-interview][main][createFloat] → (窗口已存在 250ms) 补发 startParams`); } catch (e) { console.warn(`[mock-interview][main][createFloat] ✗ (窗口已存在) 250ms 补发异常：${e && e.message}`); }
        }
      }, 250);
      // ★ 修复：将 t2 放入按 wcId 索引的全局 Map，ipcMain.on('mock-interview:started-ack') 会统一清（不再用无效的 wc.on）
      _trackMockFloatTimer(wc, t2);
    } catch (e) { console.warn(`[mock-interview][main][createFloat] (窗口已存在) 下发 startParams 异常：${e && e.message}`); }
    return mockInterviewFloatWindow;
  }

  // 1. 新建 BrowserWindow：标准 frame 标题栏 + 可缩放 + 置顶提示用户
  // ★ 排障增强：创建前先打印"即将传入的完整 webPreferences 快照"（双向校验：传前 vs 传后）
  const _targetWp = {
    preload: path.join(__dirname, 'preload.js'),
    nodeIntegration: true,
    contextIsolation: false,
    enableRemoteModule: true,
    webSecurity: false,          // ★ 核心：关闭同源策略，允许 file:// → http:// fetch
    allowRunningInsecureContent: true,
    sandbox: false,              // ★ 配套：preload.js 能使用 Node API（挂载 electronAPI）
    backgroundThrottling: false  // ★ 配套：失焦不节流计时器（VAD/ASR）
  };
  console.log(`[mock-interview][main][createFloat] ★ ① 创建前：webPreferences 传入快照 → webSecurity=${_targetWp.webSecurity ? 'ENABLED(危险)' : 'DISABLED(✅ 允许 file→http fetch)'} | sandbox=${_targetWp.sandbox} | allowRunningInsecure=${_targetWp.allowRunningInsecureContent} | preload="${_targetWp.preload}"`);
  mockInterviewFloatWindow = new BrowserWindow({
    width: 820,
    height: 720,
    minWidth: 560,
    minHeight: 480,
    title: '模拟面试 · 进行中',
    frame: true,
    resizable: true,
    minimizable: true,
    maximizable: true,
    fullscreenable: false,
    autoHideMenuBar: true,
    backgroundColor: '#0f1218',
    webPreferences: _targetWp,
    icon: path.join(__dirname, 'assets', 'icon.png')
  });
  // ★ 登记模拟面试浮窗到统一排除注册表，并施加「截图/录屏不可见」
  registerWindow('mock', mockInterviewFloatWindow);
  captureExclusion.applyCaptureExclusion(mockInterviewFloatWindow, captureHideEnabled);
  try { mockInterviewFloatWindow.setMenuBarVisibility(false); } catch (_) { /* 部分平台无菜单栏 */ }
  // ★ 排障增强：创建后双向打印"实际生效的 webPreferences"（避免某些 Electron 版本悄悄覆盖/忽略传入值）
  try {
    const wc = mockInterviewFloatWindow.webContents;
    const wcId = wc ? Number(wc.id) : 0;
    let diagLine = '';
    if (wc && typeof wc.getWebPreferences === 'function') {
      const wp = wc.getWebPreferences();
      diagLine = `★ ② 创建后（getWebPreferences）：webSecurity=${wp.webSecurity ? 'ENABLED(危险，实际被覆盖！)' : 'DISABLED(✅ 已生效)'} | sandbox=${wp.sandbox} | allowRunningInsecure=${wp.allowRunningInsecureContent} | nodeIntegration=${wp.nodeIntegration} | contextIsolation=${wp.contextIsolation}`;
    } else {
      diagLine = `★ ② 创建后：getWebPreferences 接口不存在（此 Electron 版本无该接口），请以"① 创建前传入值"为准判断 webSecurity/sandbox`;
    }
    console.log(`[mock-interview][main][createFloat] ${diagLine} (wcId=${wcId})`);

    // ---- ★★★ 排障增强 A：console-message 全转发（浮窗 DevTools Console 的 warn/error 同步打到主进程终端）
    //   原因：F_DIAG 只转发渲染层自己调用 log() 产生的日志；但还有第三方库/未通过 log() 的 console.error/warn（如 fetch 原生错误堆栈）需要捕获
    try {
      if (wc && typeof wc.on === 'function') {
        wc.on('console-message', (_evt, level, message, line, sourceId) => {
          try {
            const levelStr = (level === 3) ? 'error' : (level === 2 ? 'warn' : (level === 0 ? 'verbose' : 'info'));
            if (levelStr !== 'error' && levelStr !== 'warn') return; // info/verbose 量太大忽略
            const icon = levelStr === 'error' ? '❌' : '⚠️';
            console.log(`[float-console][wcId=${wcId}]${icon}[${levelStr}] ${String(message || '').slice(0, 1000)}  (at ${String(sourceId||'(unknown)')}:${line})`);
          } catch (_) {}
        });
        // ---- 排障增强 B：did-fail-load / did-fail-provisional-load（浮窗 HTML 本身加载失败）
        wc.on('did-fail-load', (_evt, errCode, errDesc, validatedURL, isMainFrame) => {
          if (isMainFrame) console.error(`[mock-interview][main][createFloat][wcId=${wcId}] ❌ 主页面加载失败：errCode=${errCode} errDesc=${errDesc} url=${validatedURL}`);
          else console.warn(`[mock-interview][main][createFloat][wcId=${wcId}] ⚠️ 子资源加载失败：errCode=${errCode} errDesc=${errDesc} url=${validatedURL}`);
        });
        wc.on('did-fail-provisional-load', (_evt, errCode, errDesc, validatedURL, isMainFrame) => {
          console.error(`[mock-interview][main][createFloat][wcId=${wcId}] ❌ 页面加载临时失败(provisional)：errCode=${errCode} errDesc=${errDesc} url=${validatedURL} mainFrame=${isMainFrame}`);
        });
      }
    } catch (_evtErr) {
      console.warn(`[mock-interview][main][createFloat] console-message 事件监听注册失败（非致命）：${_evtErr && _evtErr.message}`);
    }

    // ---- ★★★ 排障增强 C：webRequest 全链路监听（浮窗发起的所有请求，看 Chromium 层到底发/没发、到哪个阶段挂了）
    //   监听目标 wc.session 的 onBeforeRequest/onCompleted/onErrorOccurred
    //   只记录：URL 含 127.0.0.1:28765 或 /api/mock-interview/* 接口（避免日志太杂）
    try {
      const sess = (wc && wc.session) ? wc.session : null;
      if (sess && typeof sess.webRequest === 'object' && sess.webRequest) {
        const wr = sess.webRequest;
        // ★★★ 关键修复：filter 只匹配 http/https，绝不能包含 file:// ！
        //   原因：Electron 的 webRequest 拦截 file:// 协议的主文档加载时会导致页面加载挂起/失败
        //   （did-finish-load 永不触发 → 渲染脚本不执行 → 面板不渲染白屏）。
        //   上一轮用 <all_urls> 恰好踩中这个坑：拦截了 loadFile 加载的 file:// 主文档。
        //   改为 http/https 后：既能继续观察 127.0.0.1:28765 的 fetch 请求，又完全不干扰 file:// 页面加载。
        const filter = { urls: ['http://*/*', 'https://*/*'] };
        const isTarget = (u) => typeof u === 'string' && ((u.indexOf('127.0.0.1:28765') >= 0) || (u.indexOf('/api/mock-interview/next-question') >= 0) || (u.indexOf('/api/mock-interview/register-answer') >= 0) || (u.indexOf('/api/mock-interview/final-review') >= 0));
        // onBeforeRequest：请求从 JS 层发出，进入 Chromium 网络栈前的第一个钩子（如果不触发 → 证明被 CSP/同源/协议在 JS 层就拦了）
        if (typeof wr.onBeforeRequest === 'function') {
          wr.onBeforeRequest(filter, (details) => {
            try { if (isTarget(details && details.url)) console.log(`[float-webReq][wcId=${wcId}] → onBeforeRequest : ${String(details.method||'GET')} ${String(details.url||'').slice(0, 300)} id=${details.id} type=${details.resourceType}`); } catch (_) {}
            return {}; // 不修改请求，纯观察
          });
        }
        // onSendHeaders：Chromium 已完成 request body 组装、即将把字节写到 TCP 连接（请求真正"出本机"的标志）
        //   ★ 如果 onBeforeRequest 打印了但 onSendHeaders 没打印 → 说明在 Chromium 网络栈内部挂起（建连/CORS/缓存层异常）
        if (typeof wr.onSendHeaders === 'function') {
          wr.onSendHeaders(filter, (details) => {
            try { if (isTarget(details && details.url)) console.log(`[float-webReq][wcId=${wcId}] → onSendHeaders : ${String(details.method||'GET')} ${String(details.url||'').slice(0, 300)} id=${details.id} bytes=${Number(details.requestHeadersSize||0)}`); } catch (_) {}
          });
        }
        // onHeadersReceived：服务端已返回响应头（说明服务端收到并处理了请求，正等响应体）
        //   ★ 如果 onSendHeaders 打印了但 onHeadersReceived 没打印 → 服务端/链路问题（本地 HTTP 服务未收到请求 → 防火墙/端口占用/请求被 Windows Defender 拦等）
        if (typeof wr.onHeadersReceived === 'function') {
          wr.onHeadersReceived(filter, (details) => {
            try { if (isTarget(details && details.url)) console.log(`[float-webReq][wcId=${wcId}] ← onHeadersReceived : HTTP ${Number(details.statusCode||0)} ${String(details.method||'GET')} ${String(details.url||'').slice(0, 300)} id=${details.id}`); } catch (_) {}
          });
        }
        // onCompleted：请求成功（即使 HTTP 4xx/5xx 也算 completed）到达响应体阶段
        if (typeof wr.onCompleted === 'function') {
          wr.onCompleted(filter, (details) => {
            try { if (isTarget(details && details.url)) console.log(`[float-webReq][wcId=${wcId}] ← onCompleted   : HTTP ${Number(details.statusCode||0)} ${String(details.method||'GET')} ${String(details.url||'').slice(0, 300)} id=${details.id}`); } catch (_) {}
          });
        }
        // onErrorOccurred：Chromium 网络层抛错（DNS 解析失败 / 拒绝连接 / ERR_BLOCKED_BY_CLIENT / ERR_BLOCKED_BY_CSP / ERR_UNSAFE_PORT / ERR_INVALID_URL 等 —— 所有 Failed to fetch 的真相都在这里）
        if (typeof wr.onErrorOccurred === 'function') {
          wr.onErrorOccurred(filter, (details) => {
            try { if (isTarget(details && details.url)) console.log(`[float-webReq][wcId=${wcId}] ❌ onErrorOccurred: err="${String(details.error||'')}" ${String(details.method||'GET')} ${String(details.url||'').slice(0, 300)} id=${details.id}`); } catch (_) {}
          });
        }
        console.log(`[mock-interview][main][createFloat] ★ ③ webRequest 全链路监听已挂（wcId=${wcId}，filter=http/https only，不碰 file://）：onBeforeRequest / onSendHeaders / onHeadersReceived / onCompleted / onErrorOccurred → 命中 127.0.0.1:28765 或 mock-interview/* 接口时打印详细阶段`);
      } else {
        console.warn(`[mock-interview][main][createFloat] ⚠️ 浮窗 wc.session 或 wc.session.webRequest 不可用，webRequest 链路监听跳过（非致命）`);
      }
    } catch (_wrErr) {
      console.warn(`[mock-interview][main][createFloat] webRequest 监听注册失败（非致命）：${_wrErr && _wrErr.message}`);
    }

    // ---- ★★★ 排障增强 D：页面加载进度观测 + 3 秒安全兜底强制 show
    try {
      if (wc && typeof wc.on === 'function') {
        // dom-ready：DOM 解析完成（渲染脚本开始执行），比 did-finish-load 更早
        wc.once('dom-ready', () => {
          try { console.log(`[mock-interview][main][createFloat][wcId=${wcId}] ℹ️ dom-ready：DOM 已解析，渲染脚本开始执行`); } catch (_) {}
        });
        // did-stop-loading：所有加载活动停止（无论成功失败）
        wc.once('did-stop-loading', () => {
          try { console.log(`[mock-interview][main][createFloat][wcId=${wcId}] ℹ️ did-stop-loading：页面加载活动已停止`); } catch (_) {}
        });
        // render-process-gone：渲染进程崩溃（OOM / GPU 异常等）
        wc.on('render-process-gone', (_evt, details) => {
          try { console.error(`[mock-interview][main][createFloat][wcId=${wcId}] ❌ 渲染进程崩溃：reason=${details && details.reason} exitCode=${details && details.exitCode}`); } catch (_) {}
        });
        // unresponsive：页面无响应（JS 死循环等）
        wc.on('unresponsive', () => {
          try { console.error(`[mock-interview][main][createFloat][wcId=${wcId}] ❌ 页面无响应（unresponsive，可能有 JS 死循环）`); } catch (_) {}
        });
        // ============================================================
        // ★ 终极 ASR 文本丢失定位：在 webContents 层（主进程侧）挂 ipc-message 监听
        //   目的：区分"主进程没发出消息"还是"消息到达了 webContents 子系统但渲染层 ipcRenderer.on 没回调"
        //     - 如果下面这条日志打印了 → 证明 broadcastToAllViews 的 webContents.send 工作正常，
        //       问题在渲染层（preload window.electronAPI 没挂 onAsrInterim / ipcRenderer.on 不可用 / 吞了异常）
        //     - 如果下面这条日志没打印（但 [broadcast-ASR] 有 ✉）→ 证明 webContents.send() 被 Electron 丢弃了
        //       （如 webContents 对象不是目标浮窗的 / wc 已被替换 / 跨进程消息路由错误）
        // ============================================================
        wc.on('ipc-message', (_evt, channel, ...args) => {
          if (typeof channel === 'string' && channel.startsWith('asr:')) {
            const textPreview = (channel === 'asr:interim' || channel === 'asr:final')
              ? `text="${String(args[0]||'').slice(0, 30)}" len=${String(args[0]||'').length}`
              : `args=${JSON.stringify(args).slice(0, 60)}`;
            console.log(`[float-wc-ipc][wcId=${wcId}] ↓ 渲染进程从主进程收到 IPC channel=${channel} frame=${_evt && _evt.frameId || '(main)'} ${textPreview}`);
          }
        });
        wc.on('ipc-message-sync', (_evt, channel, ...args) => {
          if (typeof channel === 'string' && channel.startsWith('asr:')) {
            console.log(`[float-wc-ipc][wcId=${wcId}] ↓ sync IPC channel=${channel}`);
          }
        });
      }
    } catch (_obsErr) {
      console.warn(`[mock-interview][main][createFloat] 页面加载观测注册失败（非致命）：${_obsErr && _obsErr.message}`);
    }
    // 3 秒安全兜底：若 did-finish-load 因任何原因未触发（页面加载挂起），强制 show 窗口避免"窗口存在但不可见"
    const _safetyShowTimer = setTimeout(() => {
      try {
        if (mockInterviewFloatWindow && !mockInterviewFloatWindow.isDestroyed()) {
          if (!mockInterviewFloatWindow.isVisible()) {
            mockInterviewFloatWindow.show();
            console.warn(`[mock-interview][main][createFloat][wcId=${wcId}] ⚠️ 3s 安全兜底：did-finish-load 未触发（页面加载可能挂起/被拦截），已强制 show 窗口`);
          }
        }
      } catch (_) {}
    }, 3000);
    mockInterviewFloatWindow.once('closed', () => { try { clearTimeout(_safetyShowTimer); } catch (_) {} });

  } catch (_wpErr) {
    // getWebPreferences 或整段排障代码抛错时，至少打一行日志证明创建完成了，避免"完全没有 webPreferences 诊断"
    console.log(`[mock-interview][main][createFloat] ✓ BrowserWindow 创建完成（排障诊断段抛错，忽略）：err=${_wpErr && _wpErr.message}`);
  }

  // 2. 窗口关闭时：统一清引用 + 清补发定时器（全局 Map + 兼容老的 global._mockFloatTimers 双保险），保证下次 create 从零开始
  mockInterviewFloatWindow.once('closed', () => {
    try {
      // 先通过 webContents.id 清理全局 Map 中对应的所有补发定时器（主修复：ipc ack 管理）
      try {
        if (mockInterviewFloatWindow) {
          const wc = mockInterviewFloatWindow.webContents;
          if (wc) _clearMockFloatTimersByWc(wc);
        }
      } catch (_) {}
      // 再清理旧的 global._mockFloatTimers 兼容引用
      if (typeof _mockFloatTimers !== 'undefined' && _mockFloatTimers && Array.isArray(_mockFloatTimers)) {
        _mockFloatTimers.forEach(t => { try { clearTimeout(t); } catch (_) {} });
        _mockFloatTimers.length = 0;
      }
    } catch (_) { /* ignore */ }
    unregisterWindow('mock');  // 注销模拟面试浮窗，避免脏引用
    mockInterviewFloatWindow = null;
  });

  // 3. ★★ 三保险下发 startParams ★★
  //    保险 1：把 startParams encode 到 URL query → 即使所有 IPC 事件丢失，浮窗也能从 window.location.search 读到（最底层兜底）
  //    保险 2：webContents 'did-finish-load' 触发后第一次 send（保证渲染脚本已执行，订阅已挂好）
  //    保险 3：250ms / 1000ms 后两次补发（避免 did-finish-load 与订阅仍有竞态），收到浮窗 mock-interview:started-ack 后立刻取消未发送的补发
  const loadFileOptions = {};
  try {
    const queryPayload = encodeURIComponent(JSON.stringify(startParams || {}));
    loadFileOptions.search = `startParams=${queryPayload}`;
    console.log(`[mock-interview][main][createFloat] ✓ 保险 1：startParams 已 encode 到 loadFile query，长度=${queryPayload.length} chars`);
  } catch (e) {
    console.warn(`[mock-interview][main][createFloat] ✗ 保险 1（query 传参）encode 失败（不影响保险 2/3）：${e && e.message}`);
  }
  // 补发定时器集合（窗口关闭时统一清理，兼容老的 global._mockFloatTimers 引用）
  const pendingTimers = [];
  try {
    if (typeof _mockFloatTimers === 'undefined') global._mockFloatTimers = pendingTimers;
    else { global._mockFloatTimers = pendingTimers; }
  } catch (_) { /* ignore */ }

  mockInterviewFloatWindow.webContents.once('did-finish-load', () => {
    console.log(`[mock-interview][main][createFloat] ✓ 保险 2：webContents did-finish-load 到达，准备发送 startParams + 250/1000ms 补发`);
    const wc = mockInterviewFloatWindow && !mockInterviewFloatWindow.isDestroyed() ? mockInterviewFloatWindow.webContents : null;
    if (!wc) return;
    // show + 第一次发送
    try { if (mockInterviewFloatWindow && !mockInterviewFloatWindow.isDestroyed()) mockInterviewFloatWindow.show(); } catch (_) {}
    try { wc.send('mock-interview:start-params', startParams || {}); console.log(`[mock-interview][main][createFloat] → (did-finish-load) 第 1 次发送 startParams`); } catch (e) { console.warn(`[mock-interview][main][createFloat] ✗ 第 1 次 send 异常：${e && e.message}`); }
    // 第 2 次补发：250ms 后
    const t2 = setTimeout(() => {
      if (mockInterviewFloatWindow && !mockInterviewFloatWindow.isDestroyed()) {
        try { wc.send('mock-interview:start-params', startParams || {}); console.log(`[mock-interview][main][createFloat] → (250ms) 第 2 次补发 startParams`); } catch (e) { console.warn(`[mock-interview][main][createFloat] ✗ 第 2 次补发异常：${e && e.message}`); }
      }
    }, 250);
    pendingTimers.push(t2);
    _trackMockFloatTimer(wc, t2); // ★ 修复：同时注册到按 wcId 管理的全局 Map，ack 时统一取消
    // 第 3 次补发：1000ms 后（防止极端竞态）
    const t3 = setTimeout(() => {
      if (mockInterviewFloatWindow && !mockInterviewFloatWindow.isDestroyed()) {
        try { wc.send('mock-interview:start-params', startParams || {}); console.log(`[mock-interview][main][createFloat] → (1000ms) 第 3 次补发 startParams`); } catch (e) { console.warn(`[mock-interview][main][createFloat] ✗ 第 3 次补发异常：${e && e.message}`); }
      }
    }, 1000);
    pendingTimers.push(t3);
    _trackMockFloatTimer(wc, t3); // ★ 修复：同时注册到按 wcId 管理的全局 Map，ack 时统一取消
    // ★ 修复：删除无效的 wc.on('mock-interview:started-ack', onAck) —— 主进程监听 ipcRenderer.send 必须用 ipcMain.on
    //   已在 createMockInterviewFloatWindow 之前通过 _registerMockFloatAckListenerOnce() 全局一次性注册
  });

  // 3. 加载浮动面板 HTML（携带 query 参数）
  mockInterviewFloatWindow.loadFile(
    path.join(__dirname, 'mockInterviewFloat.html'),
    loadFileOptions
  ).catch((e) => {
    console.error('[mock-interview][main] 浮窗 loadFile 失败：', e && e.message);
  });

  // 开发模式（--dev）下自动打开 DevTools，方便调试 VAD/识别
  if (process.argv.includes('--dev')) {
    try { mockInterviewFloatWindow.webContents.openDevTools({ mode: 'detach' }); } catch (_) {}
  }

  return mockInterviewFloatWindow;
}

/**
 * IPC: open-mock-interview-floatwin — 由主窗口 mockResumePanels.js 点击"开始模拟面试"后调用
 * @param {object} event IPC 事件
 * @param {object} params 启动参数（包含 answerMode、totalQuestions、serverInfo 等）
 * @returns {{success:boolean, status:object}}
 */
ipcMain.handle('open-mock-interview-floatwin', async (event, params) => {
  const t0 = Date.now();
  // 打印入口参数（脱敏 token）：判断主窗口传进来的 params 是否一开始就空/脏
  let safeIncoming = {};
  try {
    const p = (params && typeof params === 'object') ? params : {};
    safeIncoming = {
      answerMode: p.answerMode, totalQuestions: Number(p.totalQuestions) || 0, language: p.language,
      hasServerInfo: !!((p.serverInfo && typeof p.serverInfo === 'object')),
      in_port: Number((p.serverInfo && p.serverInfo.port) || 0),
      in_baseUrl: (p.serverInfo && p.serverInfo.baseUrl) ? String(p.serverInfo.baseUrl).slice(0, 60) : '',
      in_token: (p.serverInfo && p.serverInfo.token) ? `${String(p.serverInfo.token).slice(0, 4)}***${String(p.serverInfo.token).slice(-4)}(len=${String(p.serverInfo.token).length})` : '<empty>'
    };
    console.log(`[mock-interview][main][IPC:open-floatwin] ▶ 收到请求：incoming=${JSON.stringify(safeIncoming)}`);
  } catch (_) { /* ignore 诊断日志异常 */ }
  try {
    // 先确保 localHttpServer 已启动（渲染层要 fetch /api/mock-interview/*）：实际启动由主窗口提前完成，这里做幂等兜底
    try {
      await ensureLocalHttpServerWithBus();
      if (localHttpServer && localHttpServer.status === 'idle') {
        await localHttpServer.start({ bus: app.bus });
      }
    } catch (e) {
      console.warn('[mock-interview][open] HTTP 启动兜底异常（非致命）：', e && e.message);
    }
    // ========== ★ 双保险：强制注入 serverInfo ==========
    const finalParams = (params && typeof params === 'object') ? { ...params } : {};
    try {
      const st = (localHttpServer && typeof localHttpServer.getStatus === 'function')
        ? (localHttpServer.getStatus() || {})
        : {};
      const port = Number(st.port) || 0;
      const token = String(st.token || '');
      if (port > 0 && token.length > 0) {
        finalParams.serverInfo = {
          port,
          token,
          baseUrl: `http://127.0.0.1:${port}`
        };
      }
      // 诊断：注入后 finalParams 的 serverInfo 是否真有有效值
      console.log(`[mock-interview][main][IPC:open-floatwin] ✓ 注入完成：finalParams.port=${Number((finalParams.serverInfo && finalParams.serverInfo.port) || 0)} token=${(finalParams.serverInfo && finalParams.serverInfo.token) ? `${String(finalParams.serverInfo.token).slice(0, 4)}***${String(finalParams.serverInfo.token).slice(-4)}(len=${String(finalParams.serverInfo.token).length})` : '<empty>'} baseUrl=${(finalParams.serverInfo && finalParams.serverInfo.baseUrl) || '(空)'}`);
    } catch (e) {
      console.warn('[mock-interview][open] 注入 serverInfo 异常（使用原始 params）：', e && e.message);
    }
    const w = createMockInterviewFloatWindow(finalParams);
    const status = getMockInterviewFloatStatus();
    console.log(`[mock-interview][main][IPC:open-floatwin] ⇢ 返回：success=${!!(w && !w.isDestroyed())} floatExists=${status && status.exists} 总用时=${Date.now() - t0}ms`);
    return { success: !!(w && !w.isDestroyed()), status };
  } catch (e) {
    console.error(`[mock-interview][main][IPC:open-floatwin] ✗ 总异常：${e && e.message} 总用时=${Date.now() - t0}ms 堆栈：\n${e && e.stack || 'no-stack'}`);
    return { success: false, error: 'internal', msg: e && e.message || '打开失败', status: getMockInterviewFloatStatus() };
  }
});

/**
 * IPC: close-mock-interview-floatwin — 主窗口或浮窗自身请求关闭
 * @returns {{success:boolean}}
 */
ipcMain.handle('close-mock-interview-floatwin', () => {
  closeMockInterviewFloatWindow();
  return { success: true };
});

/**
 * IPC: mock-interview-floatwin-status — 查询浮窗是否存在 + bounds（主窗口按钮 disabled 判断）
 * @returns {{exists:boolean, bounds:object|null}}
 */
ipcMain.handle('mock-interview-floatwin-status', () => getMockInterviewFloatStatus());

