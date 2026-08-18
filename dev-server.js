/**
 * 纯浏览器开发模式的本地 Dev Server（零依赖版）。
 *
 * 设计目标：
 *   1. UI 级开发不依赖 Electron 启动（冷启动慢 3-8s），浏览器刷新秒级。
 *   2. 直接复用项目已有的 aiService.js（LLM 引擎）和 config-manager.js（持久化），
 *      避免两遍逻辑导致语义不一致 / CORS 问题。
 *   3. 暴露与 Electron IPC 同名的 REST 通道 `/ipc/:channel`，
 *      浏览器侧 `fetch('/ipc/xxx', {args})` 即可，copilot.js 业务层 0 修改。
 *   4. 零依赖：仅使用 Node.js 内置模块（http/fs/path/url），无需 npm install。
 *      这样即使 npm 缓存损坏也能启动浏览器开发模式。
 *
 * 用法：node dev-server.js
 *       浏览器打开 http://localhost:5173/
 *
 * 配置读取：项目根目录 .env（与 Electron 模式完全共用一份）
 *   - 无 dotenv 依赖：使用内置极简 .env 解析器
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { URL } = require('url');

// ============================================================
// 0. 极简 .env 解析器（替代 dotenv）
//    支持：KEY=VALUE、# 注释、空行、引号包裹的 VALUE
// ============================================================
function parseEnvFile(envContent) {
  const result = {};
  const lines = envContent.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue; // 跳过空行 & 注释
    const eqIdx = line.indexOf('=');
    if (eqIdx < 0) continue;
    let key = line.substring(0, eqIdx).trim();
    let val = line.substring(eqIdx + 1).trim();
    // 去掉首尾引号（单引号 / 双引号）
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    result[key] = val;
    // 只有当 process.env 中没有该 KEY 时才写入（优先级：Shell 变量 > .env）
    if (typeof process.env[key] === 'undefined') {
      process.env[key] = val;
    }
  }
  return result;
}

// ============================================================
// 1. 读取环境变量 + 初始化配置管理器 & LLM 服务
// ============================================================
const PROJECT_ROOT = __dirname;
const dotEnvPath = path.join(PROJECT_ROOT, '.env');
if (fs.existsSync(dotEnvPath)) {
  try {
    const envContent = fs.readFileSync(dotEnvPath, 'utf8');
    parseEnvFile(envContent);
    console.log(`[dev-server] 读取 .env 成功: ${dotEnvPath}`);
  } catch (e) {
    console.warn(`[dev-server] 读取 .env 失败: ${e.message}`);
  }
} else {
  console.warn(`[dev-server] 未找到 .env 文件，将使用默认值: ${dotEnvPath}`);
}

// 按需加载（require 放在解析 env 之后，保证 ConfigManager / aiService 读取到注入的 env）
// config-manager.js 直接 module.exports = ConfigManager（导出类）
const ConfigManager = require('./src/main/config-manager');
// aiService.js 直接 module.exports = new AIService()（导出单例实例，无需再次 new）
const aiService = require('./services/aiService');

// 浏览器模式下数据存档放在 os.tmpdir 下，与 Electron 的 %AppData% 分桶隔离
const BROWSER_USER_DATA = path.join(
  os.tmpdir(),
  'interview-assistance-browser'
);
if (!fs.existsSync(BROWSER_USER_DATA)) {
  fs.mkdirSync(BROWSER_USER_DATA, { recursive: true });
}
console.log(`[dev-server] 本地数据目录: ${BROWSER_USER_DATA}`);

const configManager = new ConfigManager(BROWSER_USER_DATA);
configManager.loadConfig();

// ============================================================
// 2. 构造模拟 IPC 的 handler 表（与 Electron ipcMain.handle 一一对应）
// ============================================================
const ipcHandlers = {
  // ---------------- 配置类 ----------------
  'get-config': () => configManager.getConfig(),
  'save-config': (cfg) => { configManager.saveConfig(cfg); return { success: true }; },
  'get-interview-config': () => configManager.getConfig(),
  'save-interview-config': (cfg) => { configManager.saveConfig(cfg); return { success: true }; },

  // ---------------- 历史 / 会话类 ----------------
  'get-history': () => configManager.loadHistory(),
  'save-history': (history) => { configManager.saveHistory(history); return { success: true }; },
  'get-recovery-data': () => ({}),
  'restore-session': () => ({ success: true }),
  'get-state-summary': () => ({
    isRecording: false, recognized: 0, dialogCount: 0, questionCount: 0, isQuestionOn: false
  }),
  'save-state': () => ({ success: true }),
  'list-sessions': () => {
    try {
      const dir = path.join(BROWSER_USER_DATA, 'interview-sessions');
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir);
    } catch (_) { return []; }
  },

  // ---------------- 简历类 ----------------
  'save-resume': (content) => { configManager.saveResume(content); return { success: true }; },
  // 与 Electron main.js 保持一致：返回 {success, content} 对象，不是纯字符串
  'load-resume': () => {
    try {
      const p = path.join(BROWSER_USER_DATA, 'resume.md');
      const content = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
      return { success: true, content: content || '' };
    } catch (e) {
      return { success: false, error: e.message, content: '' };
    }
  },
  'delete-resume': () => {
    try { fs.unlinkSync(path.join(BROWSER_USER_DATA, 'resume.md')); } catch (_) {}
    return { success: true };
  },
  'selectResumeFile': () => {
    console.warn('[dev-server] 浏览器模式下请使用 <input type=file> 手动选择');
    return null;
  },
  'open-file-dialog': (options) => {
    // 浏览器无法弹原生对话框，降级返回 null，前端需使用隐藏 <input type=file> 实现
    console.warn('[dev-server] /ipc/open-file-dialog: 浏览器模式降级（请前端用 input[type=file] 替代）');
    return null;
  },
  'parseResume': () => null, // 解析在前端直接用 mammoth/pdfjs 做

  // ---------------- 核心 AI 调用（签名与 Electron main.js 严格对齐） ----------------
  // generate-answer 签名：(question, config)，与 main.js ipcMain.handle('generate-answer') 一致
  'generate-answer': async (question, config) => {
    try {
      const cfg = Object.assign({}, configManager.getConfig(), config || {});
      const answer = await aiService.generateAnswer(
        question,
        cfg.interviewScene,
        cfg.selectedService,
        cfg,
        [],
        '',
        cfg.modelTier
      );
      return { success: true, answer: answer || '' };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
  'optimize-resume': async (resumeText, direction) => {
    return await aiService.optimizeResume(resumeText, direction, configManager.getConfig());
  },
  'generate-review': async (history, extraCfg) => {
    const cfg = Object.assign({}, configManager.getConfig(), extraCfg || {});
    return await aiService.generateReview(history, cfg);
  },
  'screenshot-solve': async (imageDataUrl, cfg, resume, kb) => {
    const mergedCfg = Object.assign({}, configManager.getConfig(), cfg || {});
    return await aiService.screenshotSolve(imageDataUrl, mergedCfg, resume, kb);
  },
  // 持续监听 - 开始（audioService 功能；浏览器模式直接降级不做）
  'start-listening': (sensitivity) => {
    console.log('[dev-server] start-listening（浏览器模式降级，不实际采集系统音频）');
    return { success: false, error: '浏览器模式不支持系统级持续监听，请切到 Electron' };
  },
  // 持续监听 - 添加音频块
  'add-audio-chunk': (chunk) => ({ success: true }),
  // 持续监听 - 停止
  'stop-listening': () => ({ success: true }),
  // 检测文本是否是问题（浏览器模式：简化为"包含问号/中文疑问词即判定为问题"）
  'detect-question': (text, sensitivity = 5) => {
    if (!text) return { isQuestion: false };
    // 简单启发式：包含问号或以 吗/呢/什么/怎么/为什么/如何/请 开头/结尾 → 判定为问题
    const hasQuestionMark = /[?？]/.test(text);
    const hasWhWord = /(^|[^a-zA-Z])(什么|怎么|为?什么|如何|是否|有没有|请|可以|能否|会不会|是不是|多少|哪里|哪个|谁)[\s\S]?$/.test(text);
    const isQuestion = hasQuestionMark || hasWhWord;
    return { isQuestion };
  },
  // 处理识别到的文本 → 自动判题 + 生成答案（对应 main.js 中同名 handler）
  'process-recognized-text': async (text, config, conversationHistory, resumeContent) => {
    try {
      const cfg = Object.assign({}, configManager.getConfig(), config || {});
      const sensitivity = cfg.detectionSensitivity || 5;
      const detectRes = ipcHandlers['detect-question'](text, sensitivity);
      const isQuestion = detectRes && detectRes.isQuestion;
      console.log(`[dev-server][process-recognized-text] text="${text.substring(0, 40)}${text.length > 40 ? '...' : ''}" isQuestion=${isQuestion}`);
      if (isQuestion) {
        const answer = await aiService.generateAnswer(
          text,
          cfg.interviewScene,
          cfg.selectedService,
          cfg,
          conversationHistory || [],
          resumeContent || '',
          cfg.modelTier
        );
        return { isQuestion: true, answer: answer || '', question: text };
      }
      return { isQuestion: false, question: text };
    } catch (e) {
      return { error: e.message, isQuestion: false, question: text };
    }
  },
  // 保存系统录音 WAV（浏览器模式不保存，返回降级信息）
  'save-system-recording': async (sessionId, wavArrayBuffer) => {
    console.log('[dev-server] save-system-recording（浏览器模式不写入磁盘） sessionId=', sessionId);
    return { success: false, error: '浏览器模式不持久化系统录音，请切到 Electron' };
  },

  // ---------------- 浏览器做不到的系统级能力：降级说明 ----------------
  'screenshot-screen': () => ({
    success: false,
    error: '浏览器模式下请使用 navigator.mediaDevices.getDisplayMedia 手动截图'
  }),
  'get-screen-bounds': () => null,
  'set-always-on-top': () => null,
  'set-opacity': () => null,
  'resize-window': () => null,
  'hide-window': () => null,
  'show-window': () => null,
  'toggle-window': () => null,
  'enter-stealth-mode': () => ({ success: false, error: '浏览器不支持隐身窗口，请切到 Electron 模式' }),
  'exit-stealth-mode': () => ({ success: false, error: '浏览器不支持隐身窗口' }),
  'is-in-stealth-mode': () => false,
  'set-exclude-from-capture': () => ({ success: false, method: 'unsupported' }),
  'send-notification': (title, body) => {
    // 服务端无法直接发浏览器通知，只能记录日志
    console.log(`[dev-server][notification] ${title}: ${body}`);
    return { success: true };
  },

  // ---------------- 音频采集（浏览器侧交给 getUserMedia） ----------------
  'get-desktop-sources': () => [],
  'start-native-system-audio': () => ({ success: false, error: '浏览器无法采集系统音频，请开启麦克风采集' }),
  'stop-native-system-audio': () => ({ success: true }),
  'list-audio-devices-native': () => [],
  'start-fallback-capture': () => ({ success: false }),
  'poll-fallback-samples': () => ({ samples: [] }),
  'stop-fallback-capture': () => ({ success: true }),

  // ---------------- 百度 ASR 代理（也可以让前端直接调，放这里也 OK） ----------------
  'get-baidu-access-token': async (config) => {
    const cfg = Object.assign({}, configManager.getConfig(), config || {});
    return await aiService.getBaiduAccessToken(cfg);
  },
  'baidu-recognize': async (params) => {
    return await aiService.recognizeWithBaidu(params, configManager.getConfig());
  },
  'speech-to-text': async (audioBuffer, asrCfg) => {
    const cfg = Object.assign({}, configManager.getConfig(), asrCfg || {});
    return await aiService.speechToText(audioBuffer, cfg);
  },

  // ---------------- 伴生设备中继 ----------------
  'start-relay-server': () => ({ success: false, error: '浏览器模式不启动中继服务器' }),
  'stop-relay-server': () => ({ success: true }),
  'relay-server-status': () => ({ running: false, port: 0, qrUrl: null }),
  'relay-broadcast': () => ({ success: true }),

  // ---------------- ASR 管线（浏览器模式 stub） ----------------
  'start-asr-pipeline': () => ({ success: false, error: '浏览器模式不支持 WASAPI 系统音频采集，请切到 Electron (npm start)' }),
  'stop-asr-pipeline': () => ({ success: true })
};

// ============================================================
// 3. 工具函数：解析 JSON Body、发送响应、MIME 类型、静态文件服务
// ============================================================

/** 常见静态文件扩展名到 MIME 类型的映射 */
const MIME_MAP = {
  '.html': 'text/html; charset=utf-8',
  '.htm':  'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
  '.map':  'application/json; charset=utf-8',
  '.txt':  'text/plain; charset=utf-8',
  '.md':   'text/markdown; charset=utf-8',
  '.pdf':  'application/pdf',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream'
};

/** 从请求中读取完整 Body（最大 50MB）并解析成 JSON */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const MAX_BODY = 50 * 1024 * 1024; // 50MB：支持截图 / 简历上传
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY) {
        reject(new Error('Request body too large (max 50MB)'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      if (buf.length === 0) { resolve({}); return; }
      try {
        resolve(JSON.parse(buf.toString('utf8')));
      } catch (e) {
        reject(new Error('Invalid JSON body: ' + e.message));
      }
    });
    req.on('error', reject);
  });
}

/** 发送 JSON 响应 */
function sendJson(res, statusCode, payload) {
  const body = (payload === undefined || payload === null) ? 'null' : JSON.stringify(payload);
  // 统一加 CORS 头（本服务只在 localhost 监听，安全风险低）
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS'
  });
  res.end(body);
}

/** 安全判断：用户请求的文件路径必须在 PROJECT_ROOT 下，防止路径穿越攻击 */
function resolveSafePath(relativePath) {
  // 解码 URL 编码的路径，去掉开头的 /
  const decoded = decodeURIComponent(relativePath.split('?')[0] || '/');
  const cleaned = decoded.startsWith('/') ? decoded.slice(1) : decoded;
  const absolute = path.resolve(PROJECT_ROOT, cleaned || 'index.html');
  const rootResolved = path.resolve(PROJECT_ROOT);
  if (!absolute.startsWith(rootResolved + path.sep) && absolute !== rootResolved) {
    return null; // 路径穿越，拒绝访问
  }
  return absolute;
}

/** 发送静态文件：处理 304、缓存、Content-Type、错误处理 */
function serveStaticFile(req, res, fsPath) {
  fs.stat(fsPath, (err, stat) => {
    if (err || !stat.isFile()) {
      // SPA fallback：如果文件不存在，回退到 index.html（本项目暂时不需要，但预留）
      const indexPath = path.join(PROJECT_ROOT, 'index.html');
      fs.stat(indexPath, (ierr, istat) => {
        if (ierr || !istat.isFile()) {
          sendJson(res, 404, { error: 'Not Found' });
          return;
        }
        pipeFile(res, indexPath, istat);
      });
      return;
    }
    // 如果是目录，尝试目录下的 index.html
    if (stat.isDirectory()) {
      const idx = path.join(fsPath, 'index.html');
      fs.stat(idx, (derr, dstat) => {
        if (derr || !dstat.isFile()) {
          sendJson(res, 403, { error: 'Directory listing denied' });
          return;
        }
        pipeFile(res, idx, dstat);
      });
      return;
    }
    pipeFile(res, fsPath, stat);
  });
}

function pipeFile(res, fsPath, stat) {
  const ext = path.extname(fsPath).toLowerCase();
  const mime = MIME_MAP[ext] || 'application/octet-stream';
  const headers = {
    'Content-Type': mime,
    'Content-Length': stat.size,
    'Access-Control-Allow-Origin': '*'
  };
  // .js / .css / .html 禁止缓存，保证刷新就是最新代码
  if (/^\.(js|css|html|htm)$/.test(ext)) {
    headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
    headers['Pragma'] = 'no-cache';
    headers['Expires'] = '0';
  } else {
    headers['Cache-Control'] = 'public, max-age=3600';
  }
  res.writeHead(200, headers);
  const stream = fs.createReadStream(fsPath);
  stream.on('error', (e) => {
    try { res.destroy(); } catch (_) {}
    console.error('[dev-server] 读取静态文件失败:', fsPath, e.message);
  });
  stream.pipe(res);
}

// ============================================================
// 4. HTTP 服务器：主路由分发
// ============================================================
const PORT = Number(process.env.DEV_PORT || 5173);

const server = http.createServer(async (req, res) => {
  // 解析 URL（host 可以随便填，我们只关心 pathname）
  let reqUrl;
  try {
    reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch (_) {
    sendJson(res, 400, { error: 'Invalid URL' });
    return;
  }
  const pathname = reqUrl.pathname;

  // ---------------- OPTIONS 预检请求直接放行 ----------------
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Max-Age': '86400'
    });
    res.end();
    return;
  }

  try {
    // ---------------- 1. /ipc/:channel → 模拟 Electron IPC ----------------
    if (req.method === 'POST' && pathname.startsWith('/ipc/')) {
      const channel = decodeURIComponent(pathname.slice('/ipc/'.length));
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch (e) {
        sendJson(res, 400, { error: e.message });
        return;
      }
      const args = Array.isArray(body && body.args) ? body.args : [];
      const handler = ipcHandlers[channel];
      if (!handler) {
        console.warn(`[dev-server] 未实现的 IPC 通道: ${channel}`);
        sendJson(res, 404, { error: `[dev-server] 未实现的 IPC 通道: ${channel}` });
        return;
      }
      try {
        const result = await handler(...args);
        sendJson(res, 200, result === undefined ? null : result);
      } catch (e) {
        console.error(`[dev-server] /ipc/${channel} 错误:`, e.message);
        sendJson(res, 500, { error: e.message, stack: e.stack });
      }
      return;
    }

    // ---------------- 2. 其他 GET / HEAD → 静态文件服务 ----------------
    if (req.method === 'GET' || req.method === 'HEAD') {
      const safePath = resolveSafePath(pathname);
      if (!safePath) {
        sendJson(res, 400, { error: 'Invalid path (possible traversal attack)' });
        return;
      }
      if (req.method === 'HEAD') {
        // HEAD 只返回头部，不返回 Body：快速检测文件是否存在
        fs.stat(safePath, (err, stat) => {
          if (err || !stat.isFile()) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end();
            return;
          }
          const ext = path.extname(safePath).toLowerCase();
          res.writeHead(200, {
            'Content-Type': MIME_MAP[ext] || 'application/octet-stream',
            'Content-Length': stat.size
          });
          res.end();
        });
        return;
      }
      serveStaticFile(req, res, safePath);
      return;
    }

    // ---------------- 3. 其他 Method → 不支持 ----------------
    sendJson(res, 405, { error: 'Method Not Allowed' });
  } catch (e) {
    console.error('[dev-server] 未捕获的请求异常:', e);
    sendJson(res, 500, { error: 'Internal Server Error', message: e.message });
  }
});

// ============================================================
// 5. 启动监听
// ============================================================
server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}/`;
  console.log('');
  console.log('=============================================');
  console.log('  ✅ Interview Assistance 浏览器开发模式');
  console.log(`  地址: ${url}`);
  console.log(`  数据: ${BROWSER_USER_DATA}`);
  console.log('  提示: 系统快捷键/系统音频/隐身条 → 切换到 Electron (npm start)');
  console.log('=============================================');
});

// 优雅关闭（Windows 下 Ctrl+C 触发）
process.on('SIGINT', () => {
  console.log('\n[dev-server] 收到 SIGINT，关闭服务…');
  server.close(() => process.exit(0));
});
