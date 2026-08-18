/**
 * localHttpServer.js — 小程序联动本地 HTTP + WebSocket 服务
 *
 * 功能总览：
 *   1. 绑定 0.0.0.0，端口范围 28765–28774 自动探测
 *   2. Token 鉴权（WS query + HTTP Authorization: Bearer 双通道）
 *   3. 单连接模式：新小程序连接会踢掉旧连接（close 4000 replaced）
 *   4. 心跳检测：60s 未收到 ping 主动 close(4408)
 *   5. 5s 轮询 IP 变化：换 WiFi 时触发 network-changed 事件（主进程会让 overlay 重绘二维码）
 *   6. WebSocket 协议：
 *        ping               → pong（心跳）
 *        screenshot:req     → screenshot:res（电脑截屏，JPEG/PNG + base64 + 指定 maxSize 压缩）
 *        overlay:write-answer → overlay:write-answer-ack（小程序 AI 答案回写电脑答题面板）
 *        overlay:pull      → overlay:pull-ack（兜底轮询：拉取当前最新 ASR/答案/状态快照）
 *   7. HTTP 接口：
 *        GET  /health                   免鉴权，服务存活探针
 *        GET  /api/connect              鉴权后下发 AI/OCR/面试配置
 *        GET  /api/overlay/status       鉴权后拉取当前 ASR/答案/录制态快照（兜底轮询）
 *        GET  /api/screenshot           鉴权后触发截图（与 WS screenshot:req 共用 _doCapture）
 *        POST /api/answer/write         鉴权后回写答案到 overlay（与 WS overlay:write-answer 同效果）
 *        POST /api/disconnect           鉴权后主动断开当前 WS 连接
 *   8. app.bus 订阅 → WS 推送（asr:interim 200ms 节流，其他立即）：
 *        asr:interim / asr:final / answer:start / answer:generated / status:change
 *   9. 内部状态 state = { asrText, answerText, isRecording, lastAnswerAt } 持续维护
 *
 * 所有对外异常均有友好错误码 + 中文可读 msg；内部 try/catch 独立包裹，单点失败不崩溃整个服务。
 */

'use strict';

// ===== Node 原生模块 =====
const http = require('http');
const os = require('os');
const crypto = require('crypto');
const url = require('url');
const path = require('path');         // H5 静态文件路径拼接（原生标准库，无新依赖）
const fs = require('fs');             // H5 静态 HTML 文件读取（原生标准库，无新依赖）

// ===== 项目已有服务：AI 答题/视觉模型（阶梯 2 复用，不新写推理逻辑）=====
let aiService = null;
try { aiService = require('./aiService'); } catch (e) {
  console.error('[localHttpServer] require(./aiService) 失败，H5 提问功能不可用:', e.message);
}
let WebSocketServerCtor = null;
try {
  // Electron 主进程 / 普通 Node 统一：优先使用项目已安装的 ws 包
  WebSocketServerCtor = require('ws').WebSocketServer || require('ws').Server;
} catch (e) {
  console.error('[localHttpServer] require(ws) 失败:', e.message);
}

// ===== 常量配置 =====
const PORT_START = 28765;                  // 起始端口（10 个备选：28765-28774）
const PORT_END = 28774;
const BIND_ADDR = '0.0.0.0';               // 允许局域网访问
const AUTH_TIMEOUT_MS = 3000;              // WS 连接 3s 未认证 → 4401
const HEARTBEAT_INTERVAL_MS = 10 * 1000;   // 心跳检查间隔 10s
const HEARTBEAT_IDLE_MAX_MS = 60 * 1000;   // 60s 无 ping → 视为掉线（4408）
const IP_MONITOR_INTERVAL_MS = 5 * 1000;   // IP 变化监控 5s
const ASR_INTERIM_THROTTLE_MS = 200;       // ASR 临时文本 WS 推送节流 200ms
const SCREENSHOT_TIMEOUT_MS = 15 * 1000;   // 截图超时 15s
const HTTP_BODY_LIMIT_BYTES = 1024 * 1024; // HTTP POST body 1MB

// ============================================================
// IP 优先级算法（重要：数值越小越优先；排序时按升序，最前即首选 IP）
// - 第 1 权重：网卡名关键词（虚拟网卡一律惩罚+N，真实物理网卡奖励-1）
// - 第 2 权重：常见局域网 IP 段（192.168.1.x/0.x 等家用/办公常见段再-1，VMware 常用虚拟段 192.168.56/150.x 再+1）
// - 第 3 权重：私网段大类（192.168 > 10 > 172.16~31 > 169.254）
// ============================================================
function _ipPriorityClass(addr, ifaceName) {
  if (!addr) return 99;
  const name = String(ifaceName || '').toLowerCase();

  // ---------- 第 1 权重：网卡名惩罚/奖励 ----------
  // 明确的虚拟网卡关键词 → 惩罚 +4（优先级大幅降低，一定排到真实网卡后面）
  const VIRTUAL_KEYWORDS = [
    'vmnet', 'vmware', 'virtualbox', 'virtual',
    'vethernet', 'hyper-v', 'hyperv', 'wsl', 'default switch',
    'tap', 'tun', 'bridge', 'vpn', 'ppp', 'loopback', 'pseudo-interface',
  ];
  let prio = 0;
  if (VIRTUAL_KEYWORDS.some((kw) => name.indexOf(kw.toLowerCase()) >= 0)) {
    prio += 4;
  } else {
    // 真实物理网卡关键词 → 奖励 -1（优先级更前）
    const REAL_KEYWORDS = [
      'wlan', 'wi-fi', 'wifi', 'wireless',
      '以太网', 'ethernet', 'eth ', 'eth0', 'eth1', 'en0', 'en1',
      '本地连接', 'local area',
      'realtek', 'broadcom', 'intel', 'atheros', 'mediatek', 'killer',
    ];
    if (REAL_KEYWORDS.some((kw) => name.indexOf(kw.toLowerCase()) >= 0)) {
      prio -= 1;
    }
  }

  // ---------- 第 2 权重：常见/虚拟 IP 段细分 ----------
  // 最常见家用/办公局域网段：192.168.0.x / 1.x / 2.x / 3.x + 10.0.0.x / 10.0.1.x → 再 -1
  if (/^192\.168\.[0123]\./.test(addr) || /^10\.0\.[01]\./.test(addr)) {
    prio -= 1;
  }
  // VMware/VirtualBox 典型虚拟段：192.168.56.x、192.168.150.x → 再 +2（虚拟惩罚叠加）
  if (/^192\.168\.(56|150)\./.test(addr)) {
    prio += 2;
  }

  // ---------- 第 3 权重：私网段大类 ----------
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(addr)) {
    prio += 2; // 172.16~31 常见 Docker/WSL 段
  } else if (addr.startsWith('10.')) {
    prio += 1; // 10.* 作为第二选择
  } else if (addr.startsWith('169.254.')) {
    prio += 3; // APIPA/自动私有 → 最末
  } else if (!addr.startsWith('192.168.')) {
    prio += 9; // 非私网段（公网等）→ 基本不考虑
  }

  return prio;
}

class LocalHttpServer {
  constructor() {
    // ===== 网络层对象 =====
    this.server = null;          // http.Server
    this.wsServer = null;        // ws.WebSocketServer
    this.port = null;            // 实际绑定端口
    this.token = null;           // 当次启动的一次性鉴权 token（IA-xxxx，面试辅助重开会重新生成）

    // ===== IP 信息 =====
    this.ips = [];               // 枚举到的所有本机 IPv4（非 internal，已去重+排序）
    this.primaryIp = null;       // 二维码中使用的首选 IP

    // ===== 小程序 WS 连接（单连接）=====
    this.minSocket = null;       // 当前已认证的小程序 WebSocket（同时只允许 1 条）
    this._authTimers = new WeakMap(); // 每条 WS → 3s 认证超时定时器（便于连接后立即清）

    // ===== 连接状态机 =====
    // idle(未启动) → listening(服务监听中等待连接) → connected(小程序已连上) → disconnected（掉线）
    this.status = 'idle';
    this.lastPingAt = 0;         // 最近一次收到小程序 ping 的时间戳 ms
    this.lastStatusAt = 0;       // 最近一次 status 变更的时间戳 ms

    // ===== 答题实时态快照（供 WS push + HTTP 兜底轮询读取）=====
    this.state = {
      asrText: '',               // ASR 最新文本（interim 覆盖 / final 也是覆盖，外部显示逻辑可以自行 append）
      answerText: '',            // AI 最新答案文本
      isRecording: false,        // ASR 管线是否在录制
      lastAnswerAt: 0,           // 最近一次 AI 答案生成的时间戳 ms（Date.now()）
    };

    // ===== 定时器句柄 =====
    this._heartbeatTimer = null;
    this._ipMonitorTimer = null;
    this._lastIpsSignature = ''; // 上次枚举 IP 的"签名"，用于判断网络是否变化（换 WiFi）

    // ===== H5 移动端纯 HTTP 活跃态（无 WebSocket 的在线判断）=====
    // 因为 H5 不会连 /ws，纯靠 token + HTTP 请求判断"是否已连接/是否在线"
    this.h5Active = false;         // H5 是否在活跃状态（最近 30s 内有合法 token 请求）
    this.h5LastActiveAt = 0;       // H5 最近一次合法请求的时间戳 ms
    this._h5IdleTimer = null;      // H5 活跃超时定时器（30s 无请求 → 回 listening）
    const H5_IDLE_TIMEOUT_MS = 30 * 1000; // H5 无请求超时阈值：30s
    this._H5_IDLE_TIMEOUT_MS = H5_IDLE_TIMEOUT_MS;

    // ===== H5 静态文件缓存（首次命中时读盘，后续直接内存返回，阶梯 3 原生 fs）=====
    this._h5HtmlCache = null;   // string 类型的完整 HTML 源码；null 表示尚未读取
    this._h5HtmlPath = path.join(__dirname, '..', 'public', 'h5', 'index.html'); // 相对 services/ → ../public/h5/index.html

    // ===== 节流 =====
    this._interimThrottleTimer = null;  // asr:interim 节流定时器
    this._interimPendingText = '';      // 节流窗口内最新的 interim 文本

    // ===== 外部引用 =====
    this.bus = null;             // 主进程的 app.bus（EventEmitter）
    this._busHandlers = null;    // 本次启动创建的 bus 监听器对象 {eventName:fn}，stop 时统一 off，防内存泄漏
  }

  // ============================================================
  // 1. 启动服务（端口探测 → IP 枚举 → token 生成 → http/ws listen → 定时器 → bus 订阅）
  // 异常：ALL_PORTS_BUSY（28765-28774 全被占用）、NO_IP（未检测到可用局域网 IPv4）
  // ============================================================
  async start({ bus } = {}) {
    // 重复启动保护：已在运行则先停掉旧实例，保证端口干净
    if (this.server) {
      try { this.stop(); } catch (_) { /* 忽略 */ }
    }

    // ===== 1.1 枚举本机 IP（失败抛 NO_IP）=====
    this.ips = this._enumLocalIps();
    if (!this.ips || this.ips.length === 0) {
      const err = new Error('NO_IP');
      err.userMsg = '未检测到局域网连接，请连接 WiFi 后重试';
      throw err;
    }
    this.primaryIp = this.ips[0];

    // ===== 1.2 探测可用端口（失败抛 ALL_PORTS_BUSY）=====
    this.port = await this._bindPortRange(PORT_START, PORT_END);
    if (!this.port) {
      const err = new Error('ALL_PORTS_BUSY');
      err.userMsg = `端口 ${PORT_START}-${PORT_END} 被占用，请关闭其他程序后重试`;
      throw err;
    }

    // ===== 1.3 生成一次性 token =====
    this.token = 'IA-' + crypto.randomBytes(8).toString('hex').slice(0, 16);

    // ===== 1.4 创建正式 HTTP + WS 服务器（必须先 createServer，再显式 listen，确保 this.server 真正在处理请求）=====
    this.server = http.createServer((req, res) => {
      // 每个请求独立 try/catch，防止单次异常挂掉整个 HTTP 服务
      try {
        this._onHttpRequest(req, res);
      } catch (e) {
        console.error('[localHttpServer] HTTP 处理异常:', e.message);
        this._json(res, 500, { ok: false, error: 'internal', msg: e.message || '服务内部错误' });
      }
    });
    // ⚠️ 关键：显式调用 listen 绑定正式 server 到探测好的端口（_bindPortRange 已释放临时 server，所以这里不会冲突）
    await new Promise((resolve, reject) => {
      // 同时注册 error 和 listening 两个回调，保证 Promise 一定能 resolve/reject（避免像浏览器一样永远 pending）
      const onError = (err) => {
        reject(new Error(`正式 server listen ${this.port} 失败：${(err && err.message) || err}`));
      };
      this.server.once('error', onError);
      this.server.listen(this.port, BIND_ADDR, () => {
        this.server.off('error', onError); // 监听成功就移除 error 监听，避免后续错误抛到这里 reject Promise
        console.log(`[localHttpServer] ✅ 正式 HTTP server 已成功监听：${BIND_ADDR}:${this.port}`);
        resolve();
      });
    });

    // listen 成功之后再挂载 WS（WS 必须挂在已经监听的 server 上，否则 upgrade 请求接不到）
    if (WebSocketServerCtor) {
      this.wsServer = new WebSocketServerCtor({ server: this.server, path: '/ws' });
      this.wsServer.on('connection', (ws, req) => {
        try {
          this._onWsConnection(ws, req);
        } catch (e) {
          console.error('[localHttpServer] WS connection 异常:', e.message);
          try { ws.close(1011, 'internal'); } catch (_) { /* 忽略 */ }
        }
      });
      console.log(`[localHttpServer] ✅ WebSocket 已挂载：path=/ws`);
    } else {
      console.warn('[localHttpServer] ws 模块不可用，仅提供 HTTP 接口（小程序无法用 WS）');
    }

    // ===== 1.5 状态切换 =====
    this._setStatus('listening');
    this.lastPingAt = Date.now(); // 初始化 ping 参考点（避免刚启动就误判掉线）

    // ===== 1.6 启动定时器：心跳 10s + IP 监控 5s =====
    this._heartbeatTimer = setInterval(() => this._heartbeatTick(), HEARTBEAT_INTERVAL_MS);
    this._ipMonitorTimer = setInterval(() => this._ipMonitorTick(), IP_MONITOR_INTERVAL_MS);

    // ===== 1.7 订阅 app.bus（ASR / 答案 / 状态 → 推小程序）=====
    if (bus) {
      this.bus = bus;
      this._attachBus();
    }

    console.log(`[localHttpServer] 启动成功：监听 ${BIND_ADDR}:${this.port}，首选IP=${this.primaryIp}，token=${this.token.substring(0, 6)}***`);
    // ====== H5 调试增强：手机访问失败定位用（把完整 URL 打出来，可复制到电脑浏览器自测） ======
    const qrH5Url = `http://${this.primaryIp}:${this.port}/h5?token=${encodeURIComponent(this.token)}`;
    const localhostH5Url = `http://127.0.0.1:${this.port}/h5?token=${encodeURIComponent(this.token)}`;
    console.log('====================================================================');
    console.log('[H5-DEBUG] ✅ 本地 HTTP 服务已就绪，二维码/手机访问信息：');
    console.log(`[H5-DEBUG] ① 手机微信扫码目标 URL：${qrH5Url}`);
    console.log(`[H5-DEBUG] ② 电脑本机自测 URL（先复制到浏览器试，先排除手机侧问题）：${localhostH5Url}`);
    console.log(`[H5-DEBUG] ③ 健康检查（免 token）：http://127.0.0.1:${this.port}/health`);
    console.log('[H5-DEBUG] ⚠️  手机连不上 H5 的常见自查清单（按顺序）：');
    console.log('[H5-DEBUG]    1) 手机和电脑必须连 同一个 WiFi / 同一个局域网（不能是流量+有线不同网段）');
    console.log('[H5-DEBUG]    2) 首选 IP 是不是真 WiFi 网卡？看上方【网卡明细】，如果是「VMware/VMnet/Hyper-V/vEthernet/VirtualBox」就是虚拟网卡，手机连不上');
    console.log('[H5-DEBUG]    3) Windows 防火墙是否拦截 Node.js？首次访问会弹允许提示，要点「允许访问」（专用网络）');
    console.log('[H5-DEBUG]    4) 自测先用电脑本机浏览器打开 ②，若都打不开就是服务没起/端口被占；若电脑能打开手机不能就是网络层/防火墙问题');
    console.log('[H5-DEBUG]    5) 手机端打开后若返回 JSON {ok:false,msg:"token 无效…"}，说明网络通了，只是二维码过期（重新扫码）');
    console.log('====================================================================');
    return this.getStatus();
  }

  // ============================================================
  // 2. 停止服务（关 server / ws / 清定时器 / 取消 bus 订阅）
  // ============================================================
  stop() {
    // 清所有定时器（独立 try/catch，单项失败不影响其他）
    try { if (this._heartbeatTimer) { clearInterval(this._heartbeatTimer); this._heartbeatTimer = null; } } catch (_) {}
    try { if (this._ipMonitorTimer) { clearInterval(this._ipMonitorTimer); this._ipMonitorTimer = null; } } catch (_) {}
    try { if (this._interimThrottleTimer) { clearTimeout(this._interimThrottleTimer); this._interimThrottleTimer = null; } } catch (_) {}
    try { if (this._h5IdleTimer) { clearTimeout(this._h5IdleTimer); this._h5IdleTimer = null; } } catch (_) {}

    // 关闭当前小程序 WS 连接
    try {
      if (this.minSocket) {
        this.minSocket.close(1001, 'server_stop');
        this.minSocket = null;
      }
    } catch (_) { /* 忽略 */ }

    // 关闭 WS server
    try {
      if (this.wsServer) {
        this.wsServer.close();
        this.wsServer = null;
      }
    } catch (_) { /* 忽略 */ }

    // 关闭 HTTP server
    try {
      if (this.server) {
        this.server.close();
        this.server = null;
      }
    } catch (_) { /* 忽略 */ }

    // 取消 app.bus 订阅（防内存泄漏）
    this._detachBus();

    // 复位字段
    this.port = null;
    this.token = null;
    this.ips = [];
    this.primaryIp = null;
    this._lastIpsSignature = '';
    this._setStatus('idle');
    console.log('[localHttpServer] 已停止');
  }

  // ============================================================
  // 3. 当前状态快照（给 overlay 弹窗 / IPC 返回）
  // ============================================================
  getStatus() {
    // 小程序 WS 是否真的连上（readyState === 1 OPEN）
    const hasMinSocket = !!(this.minSocket && this.minSocket.readyState === 1);
    // lastPingAt 统一：小程序用 WS ping 时间，H5 用最后 HTTP 请求时间，哪个新取哪个（UI 显示 xxxs 前）
    const lastActive = Math.max(this.lastPingAt || 0, this.h5LastActiveAt || 0);
    return {
      status: this.status,
      port: this.port,
      token: this.token,
      ips: this.ips.slice(),
      primaryIp: this.primaryIp,
      // connected 两种模式都考虑：小程序已连 OR H5 活跃 → 都是"已连接"
      connected: hasMinSocket || !!this.h5Active,
      // 给 UI 判断当前是"微信小程序"还是"H5/手机浏览器"连上的
      wsConnected: hasMinSocket,
      h5Active: !!this.h5Active,
      h5LastActiveAt: this.h5LastActiveAt,
      // UI 显示"xxxs 前"使用统一取大后的活跃时间
      lastPingAt: lastActive,
      wsLastPingAt: this.lastPingAt,
      lastStatusAt: this.lastStatusAt,
      ts: Date.now(),
      // state 浅拷贝一份（避免外部改写内部对象）
      asrText: this.state.asrText,
      answerText: this.state.answerText,
      isRecording: this.state.isRecording,
      lastAnswerAt: this.state.lastAnswerAt,
    };
  }

  // ============================================================
  // 4. 二维码 payload（JSON 字符串 → qrcode 生成 dataUrl）
  // 字段：v / ip / altIps / port / token / ts
  // ============================================================
  getQRPayload() {
    if (this.status === 'idle') {
      throw new Error('SERVER_NOT_STARTED');
    }
    const payload = {
      v: 1,
      ip: this.primaryIp,
      altIps: this.ips.length > 1 ? this.ips.slice(1, 4) : [],
      port: this.port,
      token: this.token,
      ts: Date.now(),
    };
    return JSON.stringify(payload);
  }

  // ============================================================
  // 5. 外部（main.js 的 ASR 回调）调用：合并最新态快照
  // partial = { asrText, answerText, isRecording } 任意字段
  // ============================================================
  recordState(partial) {
    if (!partial) return;
    if ('asrText' in partial) this.state.asrText = String(partial.asrText || '');
    if ('answerText' in partial) {
      this.state.answerText = String(partial.answerText || '');
      if (partial.answerText) this.state.lastAnswerAt = Date.now();
    }
    if ('isRecording' in partial) this.state.isRecording = !!partial.isRecording;
  }

  // ============================================================
  // 6. 枚举本机 IPv4（非 internal，去重，按优先级排序）
  // 参数 quiet=false（默认）打印详细网卡明细；quiet=true 不打印明细，避免 IP 监控 tick 时反复刷屏
  // ============================================================
  _enumLocalIps(quiet = false) {
    const result = [];
    const seen = new Set();
    try {
      const ifaces = os.networkInterfaces();
      // 只在启动或网络变更时打印分隔条 + 明细；IP 监控 tick（quiet=true）不刷
      if (!quiet) {
        console.log('====================================================================');
        console.log('[H5-DEBUG] ===== IP 枚举明细（按网卡逐一枚举）=====');
      }
      Object.keys(ifaces || {}).forEach((name) => {
        const list = ifaces[name] || [];
        list.forEach((iface) => {
          // 详细打印每个网卡，让用户判断是不是 WiFi 网卡/是不是虚拟网卡
          const isIpv4 = iface && iface.family === 'IPv4';
          const isInternal = iface && !!iface.internal;
          const addr = iface && iface.address;
          // ⚠️ 关键改动：把网卡名 name 作为第二参数传进去，结合网卡名 + IP 段综合算优先级
          const prio = _ipPriorityClass(addr || '', name);
          if (!quiet) {
            console.log(`[H5-DEBUG]   网卡【${name}】 family=${iface?.family || '-'} internal=${isInternal} addr=${addr || '-'} 优先级(prio=${prio})`);
          }
          // 仅取 IPv4 + 非内部（排除 127.0.0.1）
          if (!isIpv4 || isInternal) return;
          if (!addr || seen.has(addr)) return;
          seen.add(addr);
          result.push({ addr, prio });
        });
      });
      // 按优先级升序（数字越小越优先）
      result.sort((a, b) => a.prio - b.prio);
      const finalList = result.map((x) => x.addr);
      if (!quiet) {
        console.log(`[H5-DEBUG] ===== 最终可用 IPv4（按优先级排序）：${finalList.join(', ') || '（空）'} =====`);
        console.log(`[H5-DEBUG] ===== 首选 IP（二维码用）：${finalList[0] || '（无，将抛 NO_IP）'} =====`);
        console.log('====================================================================');
      }
      return finalList;
    } catch (e) {
      console.error('[localHttpServer] _enumLocalIps 异常:', e.message);
      return [];
    }
  }

  // ============================================================
  // 7. 端口探测：从 start→end 依次 try listen，成功→立刻关临时 server，只把端口号 resolve 返回
  // 为什么不直接把监听好的 srv 赋给 this.server？
  //   因为 start() 后面会 this.server = http.createServer(handler) 重新创建带业务 handler 的正式 server，
  //   如果这里赋 this.server 会被覆盖 → 临时 server 仍在监听端口但无任何 request 处理器 → 请求进来永远 pending，浏览器一直转圈（就是用户遇到的现象）。
  //   正确做法：这里只"探测"可用性，用临时 server bind 后立刻 close，同一 tick 内不会被抢，外面的正式 server 再 listen 一次。
  // ============================================================
  _bindPortRange(start, end) {
    return new Promise((resolve) => {
      let port = start;
      console.log(`[H5-DEBUG] ===== 端口探测开始：${start}-${end}，绑定地址 BIND_ADDR=${BIND_ADDR} =====`);
      const tryNext = () => {
        if (port > end) {
          console.log(`[H5-DEBUG] ===== 端口探测失败：${start}-${end} 全部不可用（ALL_PORTS_BUSY） =====`);
          resolve(null);
          return;
        }
        const srv = http.createServer();
        srv.once('error', (err) => {
          // EADDRINUSE / EACCES 都视为端口不可用，试下一个
          try { srv.close(); } catch (_) { /* 忽略 */ }
          console.log(`[localHttpServer] 端口 ${port} 不可用：${err.code}，尝试下一个`);
          port += 1;
          tryNext();
        });
        srv.listen(port, BIND_ADDR, () => {
          // ✅ 关键修复：探测成功立刻关临时 server（释放端口），不赋值 this.server，避免后续被覆盖
          try { srv.close(); } catch (_) { /* 忽略 */ }
          console.log(`[localHttpServer] 端口 ${port} 空闲可用（bind=${BIND_ADDR}）→ 由正式 server 接管监听`);
          resolve(port);
        });
      };
      tryNext();
    });
  }

  // ============================================================
  // 8. WS 3s 认证超时 → close(4401)
  // ============================================================
  _sendWsAuthTimeout(ws) {
    const t = setTimeout(() => {
      try {
        if (!ws.authenticated) ws.close(4401, 'invalid token or auth timeout');
      } catch (_) { /* 忽略 */ }
    }, AUTH_TIMEOUT_MS);
    this._authTimers.set(ws, t);
  }
  _clearWsAuthTimeout(ws) {
    try {
      const t = this._authTimers.get(ws);
      if (t) { clearTimeout(t); this._authTimers.delete(ws); }
    } catch (_) { /* 忽略 */ }
  }

  // ============================================================
  // 9. 向当前已认证的小程序 WS 广播推送（readyState=1 才发）
  // ============================================================
  _broadcast(type, payload, extraFields = {}) {
    if (!this.minSocket) return false;
    try {
      if (this.minSocket.readyState !== 1) return false; // OPEN=1
      const msg = Object.assign({ type, ts: Date.now() }, extraFields);
      if (payload !== undefined) msg.payload = payload;
      this.minSocket.send(JSON.stringify(msg));
      return true;
    } catch (e) {
      console.warn('[localHttpServer] _broadcast 发送失败:', e.message);
      return false;
    }
  }

  // ============================================================
  // 10. 回复小程序请求（带同一 id 配对 request-response）
  // ============================================================
  _reply(ws, incomingMsg, responseType, responsePayload) {
    try {
      if (!ws || ws.readyState !== 1) return;
      const out = { type: responseType, ts: Date.now(), payload: responsePayload };
      if (incomingMsg && incomingMsg.id) out.id = String(incomingMsg.id);
      ws.send(JSON.stringify(out));
    } catch (e) {
      console.warn('[localHttpServer] _reply 发送失败:', e.message);
    }
  }

  // ============================================================
  // 11. 设置 status + 记录 lastStatusAt + 通知外部（app.bus emit local:status-changed）
  // ============================================================
  _setStatus(newStatus) {
    const changed = this.status !== newStatus;
    this.status = newStatus;
    this.lastStatusAt = Date.now();
    if (changed && this.bus) {
      try {
        this.bus.emit('local:status-changed', this.getStatus());
      } catch (e) {
        console.warn('[localHttpServer] bus.emit(local:status-changed) 失败:', e.message);
      }
    }
  }

  // ============================================================
  // 11.5 H5 移动端纯 HTTP 活跃状态管理（无 WebSocket 场景）
  // 目标：H5 只要有任何合法 token 请求（调 /api/*），服务端就进入 connected 态
  //       30s 内无请求 → 自动回 listening 态（不打断已连的小程序 socket）
  //       H5 手动点断开 → 立即回 listening（且清活跃时间戳）
  // ============================================================
  /**
   * H5 端每发一次合法 token 请求都调用本方法（在 /api 路由 token 校验通过后立即调用）
   * 作用：更新活跃时间 → 若当前未进入 connected → 升级到 connected → 重置 30s idle 定时器
   */
  _touchH5Active() {
    const now = Date.now();
    this.h5LastActiveAt = now;
    // 如果不是 active，就变 active，并可能升级 status 到 connected
    if (!this.h5Active) {
      this.h5Active = true;
      console.log(`[localHttpServer] H5 进入已连接态（首次活跃）`);
      // status 升级条件：没有已连接的小程序 socket 时，把 listening 升级为 connected
      // 如果此时 status 已经是 connected（小程序已连）→ 保持不动，不重复发事件
      const hasMinSocket = !!(this.minSocket && this.minSocket.readyState === 1);
      if (!hasMinSocket && (this.status === 'listening' || this.status === 'disconnected')) {
        this._setStatus('connected');
      }
    }
    // 每次活跃都重置 idle 定时器：30s 内无任何 token 请求 → 自动降级为 listening
    if (this._h5IdleTimer) { try { clearTimeout(this._h5IdleTimer); } catch (_) { /* 忽略 */ } }
    this._h5IdleTimer = setTimeout(() => this._checkDowngradeH5IfIdle(), this._H5_IDLE_TIMEOUT_MS);
  }

  /**
   * 30s idle 超时回调：如果 H5 超时无请求 + 没有小程序 socket，就把 status 降回 listening
   * （不影响小程序模式：如果有 minSocket，就算 H5 超时了，status 还是 connected）
   */
  _checkDowngradeH5IfIdle() {
    try {
      this._h5IdleTimer = null;
      const now = Date.now();
      const hasMinSocket = !!(this.minSocket && this.minSocket.readyState === 1);
      const idleTooLong = now - this.h5LastActiveAt >= this._H5_IDLE_TIMEOUT_MS;
      // 如果 H5 还在 active 标记，但超过了 timeout 且没有小程序 socket → 降级
      if (this.h5Active && idleTooLong && !hasMinSocket) {
        this.h5Active = false;
        console.log(`[localHttpServer] H5 ${Math.floor(this._H5_IDLE_TIMEOUT_MS / 1000)}s 无请求 → 回到等待连接状态`);
        if (this.status === 'connected') this._setStatus('listening');
      }
    } catch (e) {
      console.warn('[localHttpServer] _checkDowngradeH5IfIdle 异常:', e.message);
    }
  }

  /**
   * H5 手动点"断开连接"按钮时调用（走 /api/disconnect 路由）
   * 立即清 active + 回 listening（不打断已连的小程序 socket）
   */
  _h5ManualDisconnect() {
    try {
      if (this._h5IdleTimer) { try { clearTimeout(this._h5IdleTimer); } catch (_) { /* 忽略 */ } }
      this._h5IdleTimer = null;
      if (this.h5Active) {
        this.h5Active = false;
        this.h5LastActiveAt = 0;
        console.log(`[localHttpServer] H5 手动断开连接`);
        const hasMinSocket = !!(this.minSocket && this.minSocket.readyState === 1);
        // 没小程序 socket 时 → 把 connected 降回 listening
        if (!hasMinSocket && this.status === 'connected') this._setStatus('listening');
      }
    } catch (e) {
      console.warn('[localHttpServer] _h5ManualDisconnect 异常:', e.message);
    }
  }

  // ============================================================
  // 12. 心跳 tick（10s 一次）：超过 60s 无 ping → 主动 close(4408)
  // 兼容：如果此时 H5 还活跃，仅清 minSocket，status 保持 connected（由 H5 兜底保活）
  // ============================================================
  _heartbeatTick() {
    if (!this.minSocket) return;
    try {
      const now = Date.now();
      if (now - this.lastPingAt > HEARTBEAT_IDLE_MAX_MS) {
        console.log('[localHttpServer] 小程序 60s 无心跳，主动断开 (4408)');
        try { this.minSocket.close(4408, 'idle timeout (60s no ping)'); } catch (_) { /* 忽略 */ }
        this.minSocket = null;
        // 状态决策：H5 活跃 → 保持 connected；否则才变 disconnected
        if (this.h5Active) {
          this._setStatus('connected');
        } else {
          this._setStatus('disconnected');
        }
      }
    } catch (e) {
      console.warn('[localHttpServer] _heartbeatTick 异常:', e.message);
    }
  }

  // ============================================================
  // 13. IP 监控 tick（5s 一次）：换 WiFi 后 IP 列表变化 → network-changed
  // （overlay 收到后会提示用户重新扫码）
  // 优化：正常监控 tick 用 quiet=true 不打印明细，避免终端刷屏；只有检测到 IP 变化时才完整打印 + 通知外部
  // ============================================================
  _ipMonitorTick() {
    try {
      // quiet=true：不打印明细，仅算签名（每 5s 跑一次不刷屏）
      const fresh = this._enumLocalIps(true);
      const sig = fresh.join('|');
      if (this._lastIpsSignature && sig !== this._lastIpsSignature) {
        // ⚠️ 网络真的变了（换 WiFi / 插拔网线 / 虚拟网卡增减）→ 重新 quiet=false 枚举并打印完整明细，让用户看到新 IP
        console.log('====================================================================');
        console.log('[localHttpServer] ⚠️ 检测到网络/IP 变化，重新枚举详细网卡：');
        console.log('[localHttpServer]   原签名=', this._lastIpsSignature);
        console.log('[localHttpServer]   新签名=', sig);
        const withLogs = this._enumLocalIps(false); // 打印完整明细
        this.ips = withLogs;
        this.primaryIp = withLogs[0] || null;
        // 重新生成 token（旧二维码失效，安全 + 干净）
        this.token = 'IA-' + crypto.randomBytes(8).toString('hex').slice(0, 16);
        // 踢掉当前连接（IP 变了小程序也连不上了）
        if (this.minSocket) {
          try { this.minSocket.close(4001, 'network changed, new token'); } catch (_) { /* 忽略 */ }
          this.minSocket = null;
        }
        this._setStatus('disconnected');
        // bus 通知 overlay：需要重绘二维码 + 提示用户重新扫码
        if (this.bus) {
          try { this.bus.emit('local:network-changed', this.getStatus()); } catch (_) { /* 忽略 */ }
        }
        console.log('====================================================================');
        this._lastIpsSignature = withLogs.join('|');
        return;
      }
      this._lastIpsSignature = sig;
    } catch (e) {
      console.warn('[localHttpServer] _ipMonitorTick 异常:', e.message);
    }
  }

  // ============================================================
  // 14. 订阅 app.bus：ASR / 答案 / 状态 → WS 推送给小程序
  //     asr:interim 200ms 节流；其他事件立即推送
  // ============================================================
  _attachBus() {
    if (!this.bus) return;
    if (this._busHandlers) return; // 避免重复订阅

    const h = {};
    // ---- asr:interim（200ms 节流）----
    h['asr:interim'] = (text) => {
      this.recordState({ asrText: text });
      this._asrInterimThrottled(text);
    };
    // ---- asr:final（立即推送 + 覆盖 state.asrText）----
    h['asr:final'] = (text) => {
      this.recordState({ asrText: text });
      this._broadcast('asr:final', { text });
    };
    // ---- answer:start（AI 开始答题 → 小程序也显示 loading）----
    h['asr:answer-start'] = (question) => {
      this._broadcast('answer:start', { question: question || '' });
    };
    // ---- answer:generated（AI 答题完成 → 推答案文本 + 更新 state）----
    h['asr:answer-generated'] = (data) => {
      const text = typeof data === 'string' ? data : (data && data.text ? data.text : '');
      const question = data && data.question ? data.question : '';
      this.recordState({ answerText: text });
      this._broadcast('answer:generated', { text, question });
    };
    // ---- asr:recording-status（录制态 true/false）----
    h['asr:recording-status'] = (isRecording) => {
      this.recordState({ isRecording: !!isRecording });
      this._broadcast('status:change', { isRecording: !!isRecording, connected: !!(this.minSocket && this.minSocket.readyState === 1) });
    };

    // 挂载到 bus（每个独立 try/catch，一个失败不影响其他）
    Object.keys(h).forEach((evt) => {
      try { this.bus.on(evt, h[evt]); } catch (e) {
        console.error(`[localHttpServer] bus.on(${evt}) 失败:`, e.message);
      }
    });
    this._busHandlers = h;
  }

  // 取消订阅（stop 时调用，防内存泄漏）
  _detachBus() {
    if (!this.bus || !this._busHandlers) return;
    Object.keys(this._busHandlers).forEach((evt) => {
      try { this.bus.off(evt, this._busHandlers[evt]); } catch (_) { /* 忽略 */ }
    });
    this._busHandlers = null;
  }

  // asr:interim 200ms 节流：窗口内最新文本合并一次发送，避免小程序被刷屏
  _asrInterimThrottled(text) {
    this._interimPendingText = String(text || '');
    if (this._interimThrottleTimer) return; // 已有定时器等待触发
    this._interimThrottleTimer = setTimeout(() => {
      this._interimThrottleTimer = null;
      const t = this._interimPendingText;
      this._interimPendingText = '';
      this._broadcast('asr:interim', { text: t });
    }, ASR_INTERIM_THROTTLE_MS);
  }

  // ============================================================
  // 15. HTTP 路由分发（总入口）
  //   CORS：允许小程序 wx.request（任意 Origin，只允许 Header Authorization）
  // ============================================================
  _onHttpRequest(req, res) {
    // ====== H5 调试：记录每个请求开始（远程 IP / 方法 / 路径），手机一扫码终端立刻有反应 ======
    // 为什么需要这条日志？用户反馈"浏览器一直转圈"时：
    //   → 如果终端里没有 [HTTP-IN] 行：说明请求根本没到服务端（网络层/防火墙/端口没在 listen）
    //   → 如果有 [HTTP-IN] 但没有对应 [HTTP-OUT]：说明服务端处理时卡住（路由里没调用 res.end/json）
    //   → 两者都有，但浏览器不显示：浏览器端问题（证书/缓存/微信内核兼容）
    const _reqStartTs = Date.now();
    const _remoteIp = (req.socket && req.socket.remoteAddress) ? req.socket.remoteAddress.replace(/^::ffff:/, '') : 'unknown';
    const _method = req.method || '-';
    const _shortUrl = (req.url || '/').length > 120 ? (req.url.substring(0, 120) + '...') : (req.url || '/');
    console.log(`[HTTP-IN] ⬅️ ${_method} ${_shortUrl}  from=${_remoteIp}`);

    // CORS 预处理
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    };
    if (req.method === 'OPTIONS') {
      console.log(`[HTTP-OUT] ➡️ 204 CORS preflight  from=${_remoteIp}  cost=${Date.now() - _reqStartTs}ms`);
      res.writeHead(204, corsHeaders);
      res.end();
      return;
    }
    Object.keys(corsHeaders).forEach((k) => res.setHeader(k, corsHeaders[k]));

    // 解析 URL
    const parsed = url.parse(req.url, true);
    const pathname = parsed.pathname || '/';

    // /health 免鉴权
    if (pathname === '/health' && req.method === 'GET') {
      this._json(res, 200, { ok: true, v: 1 }, { _reqStartTs, _remoteIp, _method });
      return;
    }

    // 其他接口：校验 token
    const authErr = this._checkAuth(req, _remoteIp);
    if (authErr) {
      this._json(res, 401, { ok: false, error: 'unauthorized', msg: authErr }, { _reqStartTs, _remoteIp, _method });
      return;
    }

    // ---- 路由表 ----
    if (pathname === '/api/connect' && req.method === 'GET')     return this._routeApiConnect(req, res, parsed, { _reqStartTs, _remoteIp, _method });
    if (pathname === '/api/overlay/status' && req.method === 'GET') return this._routeApiOverlayStatus(req, res, parsed, { _reqStartTs, _remoteIp, _method });
    if (pathname === '/api/screenshot' && req.method === 'GET') return this._routeApiScreenshot(req, res, parsed, { _reqStartTs, _remoteIp, _method });
    if (pathname === '/api/answer/write' && req.method === 'POST') return this._routeApiAnswerWrite(req, res, { _reqStartTs, _remoteIp, _method });
    if (pathname === '/api/disconnect' && req.method === 'POST') return this._routeApiDisconnect(req, res, { _reqStartTs, _remoteIp, _method });
    // ---- 新增：H5 移动端页面入口（与 /h5 /h5/ /h5/index.html 都匹配，微信扫码 URL 直开）----
    if ((pathname === '/h5' || pathname === '/h5/' || pathname === '/h5/index.html') && req.method === 'GET') return this._routeH5(req, res, { _reqStartTs, _remoteIp, _method });
    // ---- 新增：H5 提交问题（纯文本或带截图）给 AI 生成答案，自动同步到电脑面板 ----
    if (pathname === '/api/answer/ask' && req.method === 'POST') return this._routeApiAnswerAsk(req, res, { _reqStartTs, _remoteIp, _method });

    // 404
    console.log(`[HTTP-OUT] ➡️ 404 NOT FOUND  ${_method} ${pathname}  from=${_remoteIp}  cost=${Date.now() - _reqStartTs}ms`);
    this._json(res, 404, { ok: false, error: 'not found' }, { _reqStartTs, _remoteIp, _method });
  }

  // 统一检查 token（先读 Header Authorization: Bearer xxx，再读 query.token 兜底）
  _checkAuth(req, _remoteIp) {
    const parsed = url.parse(req.url, true);
    let tok = null;
    // Header 优先
    try {
      const header = req.headers && req.headers['authorization'];
      if (header && /^Bearer\s+/i.test(header)) tok = header.replace(/^Bearer\s+/i, '').trim();
    } catch (_) { tok = null; }
    // 兜底 query.token
    if (!tok) {
      try { tok = (parsed.query && parsed.query.token) || null; } catch (_) { tok = null; }
    }
    const tokShort = tok ? (tok.substring(0, 6) + '***') : '(空)';
    const srvShort = this.token ? (this.token.substring(0, 6) + '***') : '(无token服务未启动)';
    if (!tok) {
      console.log(`[AUTH-ERR] 缺少 token  from=${_remoteIp}  req=${tokShort}  server=${srvShort}`);
      return '缺少 token（Header Authorization: Bearer 或 URL ?token=）';
    }
    if (tok !== this.token) {
      console.log(`[AUTH-ERR] token 不匹配  from=${_remoteIp}  req=${tokShort}  server=${srvShort}`);
      return 'token 无效或已过期，请重新扫码';
    }
    return null;
  }

  // 统一 JSON 响应
  _json(res, code, body, reqDebug) {
    const data = Buffer.from(JSON.stringify(body || {}), 'utf-8');
    // ====== H5 调试：打印响应码 + body 大小 + 耗时（与 [HTTP-IN] 成对出现）======
    if (reqDebug && reqDebug._method) {
      const cost = Date.now() - (reqDebug._reqStartTs || Date.now());
      const extra = (code !== 200 && body && body.msg) ? `  msg=${String(body.msg).substring(0, 60)}` : '';
      console.log(`[HTTP-OUT] ➡️ ${code} ${reqDebug._method}  bytes=${data.length}  from=${reqDebug._remoteIp || '-'}  cost=${cost}ms${extra}`);
    }
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': data.length,
    });
    res.end(data);
  }

  // 读 POST JSON body（限制 1MB，超时 10s）
  _readJsonBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      let done = false;
      const tm = setTimeout(() => {
        if (done) return;
        done = true;
        reject(new Error('body timeout'));
      }, 10000);
      req.on('data', (c) => {
        if (done) return;
        size += c.length;
        if (size > HTTP_BODY_LIMIT_BYTES) {
          done = true;
          clearTimeout(tm);
          reject(new Error('body too large'));
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (done) return;
        done = true;
        clearTimeout(tm);
        try {
          const raw = Buffer.concat(chunks).toString('utf-8');
          if (!raw) return resolve({});
          resolve(JSON.parse(raw));
        } catch (e) { reject(new Error('invalid json')); }
      });
      req.on('error', (e) => {
        if (done) return;
        done = true;
        clearTimeout(tm);
        reject(e);
      });
    });
  }

  // ---- GET /api/connect：下发 AI/OCR/面试配置（小程序可直接复用，避免用户在小程序端重复填 Key）----
  _routeApiConnect(req, res, parsed, reqDebug) {
    // H5 初始化连接 → 标记 H5 活跃（服务端 status 升级到 connected）
    this._touchH5Active();
    // loadConfig 由外部（main.js）attach 到 this 上；若没有则返回空字段，不 crash
    const cfg = (typeof this.loadConfigFn === 'function') ? this.loadConfigFn() : {};
    const interview = cfg || {};
    // AI 配置（小程序可选使用：共享 key 或用自己本地配置）
    const aiConfig = {
      baseUrl: interview.tongyiBaseUrl || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: interview.selectedModel || interview.tongyiModel || 'qwen-plus',
      // 下发空 key：默认小程序本地优先，用户也可在小程序设置中启用"共享电脑 Key"
      apiKey: interview.shareAiKeyToMiniapp ? (interview.tongyiApiKey || '') : '',
    };
    // OCR 配置（占位：默认 Provider 阿里云，accessKey 下发空，小程序可本地填）
    const ocrConfig = {
      provider: 'aliyun',
      accessKeyId: interview.shareOcrKeyToMiniapp ? (interview.ocrAccessKeyId || '') : '',
      accessKeySecret: interview.shareOcrKeyToMiniapp ? (interview.ocrAccessKeySecret || '') : '',
    };
    // 面试信息（用于 AI prompt 更贴合岗位）
    const interviewInfo = {
      type: interview.interviewType || '综合面试',
      position: interview.targetPosition || '',
      years: Number(interview.experienceYears) || 0,
    };
    this._json(res, 200, {
      ok: true,
      device: 'HireMe-Copilot',
      asrOn: !!this.state.isRecording,
      aiConfig,
      ocrConfig,
      interview: interviewInfo,
    }, reqDebug);
  }

  // ---- GET /api/overlay/status：兜底轮询最新态快照 ----
  _routeApiOverlayStatus(req, res, parsed, reqDebug) {
    this._json(res, 200, {
      ok: true,
      asrText: this.state.asrText,
      answerText: this.state.answerText,
      isRecording: this.state.isRecording,
      lastAnswerAt: this.state.lastAnswerAt,
    }, reqDebug);
  }

  // ---- GET /api/screenshot：HTTP 方式触发截图 ----
  async _routeApiScreenshot(req, res, parsed, reqDebug) {
    // H5 调截图 → 标记活跃（防 idle 30s 超时）
    this._touchH5Active();
    const q = (parsed && parsed.query) || {};
    const payload = {
      sourceId: q.sourceId || null,
      format: (q.format === 'png') ? 'png' : 'jpeg',
      quality: Number(q.quality) || 0.85,
      maxSize: Number(q.maxSize) || 1920,
    };
    try {
      const cap = await this._doCapture(payload);
      this._json(res, 200, {
        ok: true,
        data: cap.data,
        width: cap.width,
        height: cap.height,
        mime: cap.mime,
      }, reqDebug);
    } catch (e) {
      const code = (e && e.code) || 'internal';
      const msg = (e && e.userMsg) || e.message || '截图失败';
      const httpCode = (code === 'permission') ? 500 : (code === 'timeout') ? 408 : 500;
      this._json(res, httpCode, { ok: false, error: code, msg }, reqDebug);
    }
  }

  // ---- POST /api/answer/write：小程序答案回写 ----
  async _routeApiAnswerWrite(req, res, reqDebug) {
    // H5/小程序写答案 → 标记活跃
    this._touchH5Active();
    try {
      const body = await this._readJsonBody(req);
      const text = body && body.text ? String(body.text) : '';
      if (!text || !text.trim()) {
        this._json(res, 400, { ok: false, error: 'empty', msg: 'text 不能为空' }, reqDebug);
        return;
      }
      // 通知外部（main.js）：把答案写入 overlay 答题面板
      if (this.bus) {
        try { this.bus.emit('local:write-answer-from-outside', text); } catch (_) { /* 忽略 */ }
      }
      // 同步更新内部 state（下次 /api/overlay/status 会立刻返回最新答案）
      this.recordState({ answerText: text });
      const id = Date.now().toString(36);
      this._json(res, 200, { ok: true, id }, reqDebug);
    } catch (e) {
      this._json(res, 400, { ok: false, error: 'body_invalid', msg: '请求体非法：' + (e.message || '未知错误') }, reqDebug);
    }
  }

  // ---- POST /api/disconnect：主动断开当前小程序 WS 连接 / H5 手动断开 ----
  _routeApiDisconnect(req, res, reqDebug) {
    try {
      // 先处理 H5 手动断开：清活跃态，必要时 status 回 listening
      this._h5ManualDisconnect();
      // 再处理小程序 WS 断开（如果有）
      if (this.minSocket) {
        try { this.minSocket.close(4000, 'user disconnect via HTTP'); } catch (_) { /* 忽略 */ }
        this.minSocket = null;
        // 只有在 H5 也没活跃的情况下才变 disconnected（不然前面 _h5ManualDisconnect 已经降回 listening 了）
        if (!this.h5Active) this._setStatus('disconnected');
      }
      this._json(res, 200, { ok: true }, reqDebug);
    } catch (e) {
      this._json(res, 500, { ok: false, error: 'internal', msg: e.message || '断开失败' }, reqDebug);
    }
  }

  // ============================================================
  // 新增 A. GET /h5：返回移动端 H5 单文件（微信扫码后直接访问）
  //   token 通过 URL ?token= 传入（已在前面 _checkAuth 校验通过）
  //   首次读文件落盘缓存，后续直接内存返回；原生 fs.readFileSync（阶梯 3，无新依赖）
  // ============================================================
  _routeH5(req, res, reqDebug) {
    try {
      const _startTs = (reqDebug && reqDebug._reqStartTs) ? reqDebug._reqStartTs : Date.now();
      const _remoteIp = (reqDebug && reqDebug._remoteIp) ? reqDebug._remoteIp : '-';
      const _method = (reqDebug && reqDebug._method) ? reqDebug._method : 'GET';
      // 第一次请求：读文件并缓存；文件不存在时给出用户友好的中文报错，防止空白页
      let hitCache = !!this._h5HtmlCache;
      if (!this._h5HtmlCache) {
        try {
          if (!fs.existsSync(this._h5HtmlPath)) {
            const errBody = { ok: false, error: 'h5_missing', msg: `H5 页面文件不存在：${this._h5HtmlPath}` };
            console.log(`[HTTP-OUT] ➡️ 500 ${_method} 文件缺失  bytes=${Buffer.byteLength(JSON.stringify(errBody))}  from=${_remoteIp}  cost=${Date.now() - _startTs}ms  msg=H5 文件不存在`);
            this._json(res, 500, errBody, reqDebug);
            return;
          }
          this._h5HtmlCache = fs.readFileSync(this._h5HtmlPath, 'utf-8');
        } catch (readErr) {
          console.error('[localHttpServer] 读取 H5 文件失败:', readErr.message);
          const errBody = { ok: false, error: 'h5_read_fail', msg: 'H5 页面读取失败：' + readErr.message };
          this._json(res, 500, errBody, reqDebug);
          return;
        }
      }
      const data = Buffer.from(this._h5HtmlCache, 'utf-8');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': data.length,
        // 手机微信浏览器不缓存，每次打开 token 都是最新的（安全：避免二维码被他人复用旧 token）
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
        'Pragma': 'no-cache',
      });
      res.end(data);
      // 手动记录响应日志（非 _json 路径），统一前缀 [HTTP-OUT] 方便排查
      console.log(`[HTTP-OUT] ➡️ 200 ${_method} HTML  bytes=${data.length}  hitCache=${hitCache ? 'Y' : 'N'}  from=${_remoteIp}  cost=${Date.now() - _startTs}ms`);
    } catch (e) {
      console.error('[localHttpServer] _routeH5 异常:', e.message);
      const errBody = { ok: false, error: 'internal', msg: 'H5 服务异常：' + e.message };
      this._json(res, 500, errBody, reqDebug);
    }
  }

  // ============================================================
  // 新增 B. POST /api/answer/ask：H5 端提交问题 + 可选截图给 AI，自动同步面板
  //   body = { text?: string, imageDataUrl?: string }（至少一个非空）
  //   - 有截图 imageDataUrl → 调 aiService.callVisionModel（多模态 qwen-vl，阶梯 2 复用）
  //   - 无图仅文本    → 调 aiService.generateAnswer（纯文本，阶梯 2 复用）
  //   - 生成答案后：① bus.emit 通知电脑面板显示 ② recordState 更新 state，H5 轮询立刻可见
  // ============================================================
  async _routeApiAnswerAsk(req, res, reqDebug) {
    // H5 提交问题 → 标记活跃
    this._touchH5Active();
    try {
      // 前置校验：aiService 模块是否成功加载
      if (!aiService) {
        this._json(res, 500, { ok: false, error: 'ai_service_missing', msg: 'AI 服务未加载，请联系开发者' }, reqDebug);
        return;
      }
      const body = await this._readJsonBody(req);
      const text = body && body.text ? String(body.text).trim() : '';
      const imageDataUrl = body && body.imageDataUrl ? String(body.imageDataUrl).trim() : '';
      if (!text && !imageDataUrl) {
        this._json(res, 400, { ok: false, error: 'empty', msg: '问题文本(text)和截图(imageDataUrl)至少填写一个' }, reqDebug);
        return;
      }
      // 拿外部（main.js）attach 的配置（同 _routeApiConnect 逻辑）
      const cfg = (typeof this.loadConfigFn === 'function') ? this.loadConfigFn() : {};
      const service = (cfg && cfg.selectedService) ? cfg.selectedService : 'tongyi';
      // 面试场景信息（让 answer 更贴合岗位）
      const interviewScene = (cfg && cfg.interviewType) || '综合面试';
      // 【修复字段名不匹配】配置里简历字段是 resumeText（interview-config.js），兼容老写法 resumeContent
      const resumeContent = (cfg && (cfg.resumeContent || cfg.resumeText)) || '';
      const modelTier = cfg && cfg.modelTier;
      let answer = '';
      const startTs = Date.now();
      // 通知外部/面板：AI 开始生成（UI 可展示生成中指示器）
      if (this.bus) { try { this.bus.emit('asr:answer-start', { source: 'h5', ts: startTs }); } catch (_) { /* 忽略 */ } }
      if (imageDataUrl) {
        // 有截图 → 调用 aiService 真实存在的 callVision(prompt, imageDataUrl, service, config, model)
        //     注：之前写的 callVisionModel 方法不存在（aiService 里叫 callVision），且参数顺序也反了，导致 H5 报错 "aiService.callVisionModel is not a function"
        const defaultPrompt = '请识别这张图片中的面试问题或内容，给出专业简洁的解答。若是代码题，请给出解题思路+关键代码+复杂度分析；若是主观/设计题，请分点作答；若是代码报错，请分析原因并给出修复代码。';
        const userExtraPrompt = text ? ('\n\n【用户补充要求】\n' + text) : '';
        const resumePrompt = resumeContent ? ('\n\n【候选人简历背景（用于答题更贴合岗位）】\n' + resumeContent.substring(0, 3000)) : '';
        const fullPrompt = defaultPrompt + userExtraPrompt + resumePrompt;
        // callVision 真实签名：callVision(prompt, imageDataUrl, service, config, model)
        answer = await aiService.callVision(fullPrompt, imageDataUrl, service, cfg);
      } else {
        // 纯文本 → 用通用问答模型（签名已对齐，无需修改）
        answer = await aiService.generateAnswer(text, interviewScene, service, cfg, [], resumeContent, modelTier);
      }
      answer = String(answer || '').trim();
      // ① 写入电脑答题面板（复用 /api/answer/write 的 bus 事件，阶梯 2）
      if (this.bus && answer) {
        try { this.bus.emit('local:write-answer-from-outside', answer); } catch (_) { /* 忽略 */ }
      }
      // ② 同步 state（轮询接口 /api/overlay/status 会立刻返回最新答案）
      this.recordState({ answerText: answer });
      // 返回给 H5 调用方（H5 可以选择直接显示或继续走轮询）
      this._json(res, 200, {
        ok: true,
        id: Date.now().toString(36),
        costMs: Date.now() - startTs,
        withImage: !!imageDataUrl,
        answer,
      }, reqDebug);
    } catch (e) {
      // 打印完整错误栈（包含具体哪行、文件名，而不是只打印 e.message，方便下次快速定位问题）
      console.error('[localHttpServer] _routeApiAnswerAsk 失败: ' + (e && e.message) + '\n' + (e && e.stack ? e.stack : new Error().stack));
      const code = (e && e.code) || 'ai_error';
      const rawMsg = (e && e.userMsg) || e.message || '';
      // 对前端展示的错误信息做"友好降级"：内部错误(如 not a function)别把原始 JS 错误直接给用户看
      let friendly = 'AI 回答失败，请稍后重试';
      if (rawMsg) {
        if (/not a function|undefined|is not|cannot read/i.test(rawMsg)) {
          // 这类是代码内部错误 → 提示用户看终端日志
          friendly = 'AI 服务内部错误：' + rawMsg + '，请查看终端日志或告知开发者';
        } else if (/未知的AI服务|当前服务商不支持|key|token|api|401|403|429/i.test(rawMsg)) {
          // 配置/限流类 → 提示用户检查配置
          friendly = 'AI 调用异常：' + rawMsg + '，请检查设置中的服务商与密钥是否正确';
        } else {
          friendly = rawMsg;
        }
      }
      this._json(res, 500, { ok: false, error: code, msg: friendly }, reqDebug);
    }
  }

  // ============================================================
  // 15.5 截图自动解题闭环（面板/小程序/H5 截图通用入口）
  //   统一完成：① 写入面试官提问 → ② 调视觉模型解题 → ③ 写入AI答案
  //   参数说明：
  //     imageDataUrlOrBase64：可以是完整 data:image/xxx;base64,xxx，也可以是纯 base64
  //     mime：当入参是纯 base64 时必须提供，如 "image/jpeg"
  //     source：来源标识，用于日志 'panel' | 'miniapp' | 'h5'
  //     resumeContent / knowledgeBase：可选，由调用方（如面板 IPC）显式传入的上下文；
  //       传了就优先用（渲染层 getInterviewConfig 拿到的最新值），没传则回退读本地配置
  //   返回：{ success, answer? }
  // ============================================================
  async _autoSolveScreenshotAndSync({ imageDataUrlOrBase64, mime, source, resumeContent: extResume, knowledgeBase: extKb }) {
    try {
      // ---- 15.5.0 来源标签：在 try/catch 任何地方都可能用到，先定义好避免 ReferenceError ----
      //   用于：日志、诊断快照、错误信息（注意：变量名是 sourceLabel，不要写成 srcLabel！）
      const sourceLabel = (source === 'miniapp') ? '微信小程序'
        : (source === 'panel') ? '面板截图'
        : (source === 'h5') ? 'H5/手机端' : '外部';

      // ---- 15.5.1 参数归一化：保证得到标准 data:image/xxx;base64, ----
      let imageDataUrl = (imageDataUrlOrBase64 && typeof imageDataUrlOrBase64 === 'string') ? imageDataUrlOrBase64.trim() : '';
      if (!imageDataUrl) {
        console.warn(`[autoSolveScreenshot] 忽略：截图内容为空 source=${sourceLabel}`);
        return { success: false, error: 'empty_screenshot' };
      }
      // 如果没带 data: 前缀，则按 mime 拼前缀
      if (!/^data:image\//i.test(imageDataUrl)) {
        const useMime = (mime && typeof mime === 'string') ? mime : 'image/jpeg';
        imageDataUrl = `data:${useMime};base64,${imageDataUrl}`;
      }

      // ---- 15.5.1.5 【图片体积兜底】超过 9MB(base64) 时自动压缩，避免超过百炼/通义视觉模型 10MB 上限 ----
      //   面板链路已在 screenshot-screen IPC 压缩、小程序链路在 _doCapture 压缩，这里是最后一道防线（覆盖未来新增调用方）
      const IMG_SIZE_LIMIT = 9 * 1024 * 1024; // 9MB（留 1MB 余量给 HTTP 头/JSON 转义膨胀）
      if (imageDataUrl.length > IMG_SIZE_LIMIT) {
        try {
          // 延迟 require：localHttpServer 也可能被纯 Node 环境（dev-server）加载，require('electron') 失败时回退原图
          const { nativeImage } = require('electron');
          // 【修复】createFromDataURL 对超大 dataURL 会抛 "conversion failure"，
          //   改用 Buffer 解码（先剥离 data:image/xxx;base64, 前缀再 from(base64)）
          const b64 = imageDataUrl.replace(/^data:image\/[\w.+-]+;base64,/, '');
          let img = nativeImage.createFromBuffer(Buffer.from(b64, 'base64'));
          const sz = img.getSize();
          // 宽度超过 1600 则等比缩小（比常规 1920 再保守一点，确保压到限内）
          if (sz.width > 1600) img = img.resize({ width: 1600 });
          const jpegDataUrl = 'data:image/jpeg;base64,' + img.toJPEG(0.8).toString('base64');
          if (jpegDataUrl.length < imageDataUrl.length) {
            console.log(`[autoSolveScreenshot] 🗜️ 图片超限自动压缩 source=${sourceLabel}: ${(imageDataUrl.length / 1048576).toFixed(1)}MB(${sz.width}x${sz.height}) → ${(jpegDataUrl.length / 1048576).toFixed(1)}MB`);
            imageDataUrl = jpegDataUrl;
          } else {
            console.warn(`[autoSolveScreenshot] ⚠️ 图片超限且压缩无收益(${(jpegDataUrl.length / 1048576).toFixed(1)}MB)，仍用原图尝试 source=${sourceLabel}`);
          }
        } catch (ce) {
          console.warn(`[autoSolveScreenshot] ⚠️ 图片超限(${(imageDataUrl.length / 1048576).toFixed(1)}MB)且压缩失败(非Electron环境?)，直接用原图，视觉模型可能返回空答案:`, ce && ce.message);
        }
      }

      // ---- 15.5.2 组装面试官提问文字（体现来源，后续面板/轮询都可见）----
      const questionText =
`【面试官提问（${sourceLabel}·截图题）】
请观察下方截图中的面试问题或内容，结合岗位要求与候选人背景作答。
> （已截取屏幕画面，请AI识别其中的题目并给出专业解答）`;

      // ---- 15.5.3 第一步：写入「面试官」区（面板 + state 双写，保证H5轮询也可见）----
      //   注：payload 扩展为 { text, imageDataUrl }，面板端可据此展示"提问画面缩略图 + 文字提问"，字符串兼容兜底
      const qPayload = { text: questionText, imageDataUrl: imageDataUrl };
      if (this.bus) {
        try { this.bus.emit('local:write-question-from-outside', qPayload); }
        catch (_) { /* bus 订阅侧清理异常，忽略 */ }
      }
      this.recordState({ interimText: questionText });

      // ---- 15.5.4 通知面板：AI 开始答题（UI 展示 loading 指示器）----
      const startTs = Date.now();
      if (this.bus) {
        try { this.bus.emit('asr:answer-start', { source, ts: startTs }); }
        catch (_) { /* 忽略 */ }
      }

      // ---- 15.5.5 调视觉模型：复用 aiService.screenshotSolve（封装好 prompt + 简历/知识库融合）----
      if (!aiService) {
        throw new Error('AI 服务未加载(aiService missing)，请联系开发者');
      }
      const cfg = (typeof this.loadConfigFn === 'function') ? (this.loadConfigFn() || {}) : {};
      // 【修复字段名不匹配】配置结构(interview-config.js)里简历字段是 resumeText，不是 resumeContent；
      //   优先级：调用方显式传入(extResume) > cfg.resumeContent(老字段) > cfg.resumeText(现行字段)
      const resumeContent = (typeof extResume === 'string' && extResume.trim())
        ? extResume
        : ((cfg && (cfg.resumeContent || cfg.resumeText)) || '');
      // 知识库：优先外部传入，回退读配置
      const knowledgeBase = (typeof extKb === 'string' && extKb.trim())
        ? extKb
        : ((cfg && typeof cfg.knowledgeBase === 'string') ? cfg.knowledgeBase : '');

      // ===== 🔍 配置诊断日志（关键：截图解题 401/Key 为空时，直接看下面这行就知道是 .env 没读 还是 Key 配错）=====
      const _cfgSnapshot = {
        source: sourceLabel,
        selectedService: cfg.selectedService || '',
        tongyiApiKeyLen: (typeof cfg.tongyiApiKey === 'string') ? cfg.tongyiApiKey.length : 0,
        tongyiBaseUrl: cfg.tongyiBaseUrl || '',
        zhipuApiKeyLen: (typeof cfg.zhipuApiKey === 'string') ? cfg.zhipuApiKey.length : 0,
        wenxinApiKeyLen: (typeof cfg.wenxinApiKey === 'string') ? cfg.wenxinApiKey.length : 0,
        // process.env 直接快照（判断 dotenv 是否把 .env 加载进来了）
        env_IA_TONGYI_API_KEY_set: (typeof process.env === 'object' && process.env && typeof process.env.IA_TONGYI_API_KEY === 'string' && process.env.IA_TONGYI_API_KEY.trim().length > 0),
        env_IA_DEFAULT_SERVICE: (typeof process.env === 'object' && process.env) ? (process.env.IA_DEFAULT_SERVICE || '') : '',
      };
      console.log(`[autoSolveScreenshot] 🧪 配置快照 source=${sourceLabel}: ${JSON.stringify(_cfgSnapshot)}`);
      // 若 key 仍为空，给出明确操作指引（避免用户在设置面板和 .env 文件之间来回跳）
      if (!cfg.tongyiApiKey || (typeof cfg.tongyiApiKey === 'string' && cfg.tongyiApiKey.trim().length === 0)) {
        console.warn(
          '[autoSolveScreenshot] ⚠️ 通义 API Key 为空！可能原因：'
          + '1). .env 文件未放置在项目根目录（或 dotenv 未读取到，请检查启动终端 cwd 是否为项目根目录）；'
          + '2). 启动后才编辑的 .env 需要重启 npm start（dotenv 仅首次 require 时读取）；'
          + '3). 请在"设置面板-通义千问 API Key"里手动填写（面板写入优先级高于 .env，但环境变量会覆盖它）。'
          + ' 当前 cfg.selectedService=' + (cfg.selectedService || '')
          + ' | env_IA_TONGYI_API_KEY_set=' + _cfgSnapshot.env_IA_TONGYI_API_KEY_set
        );
      } else if (!cfg.selectedService) {
        console.warn('[autoSolveScreenshot] ⚠️ selectedService 为空，默认会用 tongyi，请确认 .env 里 IA_DEFAULT_SERVICE=tongyi');
      }

      // 注意：aiService.screenshotSolve 签名：(imageDataUrl, config, resumeContent, knowledgeBase)
      const answer = await aiService.screenshotSolve(imageDataUrl, cfg, resumeContent, knowledgeBase);
      const finalAnswer = String(answer || '').trim();

      // ---- 15.5.6 第二步：写入「AI 助手」区（面板 + state 双写，保证 H5 轮询也可见）----
      if (this.bus && finalAnswer) {
        try { this.bus.emit('local:write-answer-from-outside', finalAnswer); }
        catch (_) { /* 忽略 */ }
      }
      this.recordState({ answerText: finalAnswer });

      const cost = Date.now() - startTs;
      console.log(`[autoSolveScreenshot] ✅ 解题完成 source=${sourceLabel} costMs=${cost} answerLen=${finalAnswer.length}`);
      return { success: true, answer: finalAnswer, costMs: cost };
    } catch (e) {
      // 失败也要打完整错误栈，方便排查（模型调用/参数格式/网络等）
      const sourceLabelFallback = (source === 'miniapp') ? '微信小程序'
        : (source === 'panel') ? '面板截图'
        : (source === 'h5') ? 'H5/手机端' : (source || 'unknown');
      console.error(`[autoSolveScreenshot] ❌ 失败 source=${sourceLabelFallback}: ${(e && e.message) || e}\n${(e && e.stack) ? e.stack : new Error().stack}`);
      return {
        success: false,
        error: (e && e.code) || 'ai_error',
        message: (e && e.userMsg) || e.message || '截图解题失败，请查看终端日志',
      };
    }
  }

  // ============================================================
  // 16. WS connection 总入口：鉴权 → 消息分发 → close 清理
  // ============================================================
  _onWsConnection(ws, req) {
    // ===== H5-DEBUG：WS 连接日志（小程序 WS 通道）=====
    const _wsRemoteIp = (req.socket && req.socket.remoteAddress) ? req.socket.remoteAddress.replace(/^::ffff:/, '') : 'unknown';
    // 16.1 解析 URL，拿 query.token（小程序 ws.connectSocket 时传在 URL 上，避免首帧鉴权时序问题）
    let queryToken = null;
    try {
      const u = new URL(req.url, 'http://localhost');
      queryToken = u.searchParams.get('token') || null;
    } catch (_) { queryToken = null; }
    const tokShort = queryToken ? (queryToken.substring(0, 6) + '***') : '(空)';
    const srvShort = this.token ? (this.token.substring(0, 6) + '***') : '(无token)';
    const urlShort = (req.url || '/').length > 120 ? (req.url.substring(0, 120) + '...') : (req.url || '/');

    // 16.2 先立即设置 authenticated（若 token 已对），否则启动 3s 超时
    if (queryToken && queryToken === this.token) {
      ws.authenticated = true;
      console.log(`[WS] ✅ 新连接（认证通过） from=${_wsRemoteIp}  url=${urlShort}  reqToken=${tokShort}  server=${srvShort}`);
    } else {
      ws.authenticated = false;
      console.log(`[WS] ❌ 新连接（认证失败，3s 后断开） from=${_wsRemoteIp}  url=${urlShort}  reqToken=${tokShort}  server=${srvShort}`);
      this._sendWsAuthTimeout(ws);
    }

    // 16.3 已认证：单连接踢旧，换 minSocket
    if (ws.authenticated) this._promoteToMinSocket(ws);

    // 16.4 接收消息
    ws.on('message', (raw) => {
      let msg = null;
      // 解析消息 JSON（独立 try/catch，一个 bad packet 不崩连接）
      try {
        const str = Buffer.isBuffer(raw) ? raw.toString('utf-8') : String(raw || '');
        if (!str) return; // 空包静默忽略
        msg = JSON.parse(str);
      } catch (e) {
        this._reply(ws, { id: null }, 'error', { code: 'bad_json', msg: '消息非合法 JSON' });
        return;
      }
      this._dispatchWsMessage(ws, msg);
    });

    // 16.5 close 事件：清理 minSocket + 改状态（兼容 H5 活跃兜底）
    ws.on('close', () => {
      this._clearWsAuthTimeout(ws);
      if (this.minSocket === ws) {
        this.minSocket = null;
        // 状态决策：H5 还活跃 → 保持 connected；否则才变 disconnected
        if (this.h5Active) {
          this._setStatus('connected');
        } else {
          this._setStatus('disconnected');
        }
      }
    });

    // 16.6 error：打日志，不额外处理（close 会接着触发）
    ws.on('error', (e) => {
      console.warn('[localHttpServer] WS error:', e && e.message);
    });
  }

  // 把已认证的 ws 提升为当前 minSocket（单连接：踢旧 → 换指向 → 状态变 connected）
  _promoteToMinSocket(ws) {
    ws.authenticated = true;
    this._clearWsAuthTimeout(ws);
    // 踢旧
    if (this.minSocket && this.minSocket !== ws) {
      try { this.minSocket.close(4000, 'replaced by new connection'); } catch (_) { /* 忽略 */ }
    }
    this.minSocket = ws;
    this.lastPingAt = Date.now();
    this._setStatus('connected');
    console.log('[localHttpServer] 小程序已连接');
  }

  // ============================================================
  // 17. WS 消息分发（按 type → handler）
  // ============================================================
  _dispatchWsMessage(ws, msg) {
    if (!msg || typeof msg !== 'object') return;
    const type = String(msg.type || '');
    // ---- 未认证：只允许 auth 消息 ----
    if (!ws.authenticated) {
      if (type !== 'auth') {
        // 没认证还发别的 → 直接 4401
        try { ws.close(4401, 'auth required'); } catch (_) { /* 忽略 */ }
        return;
      }
      this._handleAuth(ws, msg);
      return;
    }
    // ---- 已认证：按 type 分发（每个 handler 独立 try/catch）----
    switch (type) {
      case 'ping':                   return this._handlePing(ws, msg);
      case 'screenshot:req':         return this._handleScreenshotReq(ws, msg);
      case 'overlay:write-answer':   return this._handleOverlayWriteAnswer(ws, msg);
      case 'overlay:pull':           return this._handleOverlayPull(ws, msg);
      default:
        this._reply(ws, msg, 'error', { code: 'unknown_type', msg: `未知消息类型: ${type}` });
    }
  }

  // auth 消息：允许小程序在 query.token 未传的情况下通过消息体补传 token
  _handleAuth(ws, msg) {
    const tok = (msg.payload && msg.payload.token) ? String(msg.payload.token) : '';
    if (tok && tok === this.token) {
      this._promoteToMinSocket(ws);
      this._reply(ws, msg, 'auth:ack', { ok: true });
    } else {
      try { ws.close(4401, 'invalid token'); } catch (_) { /* 忽略 */ }
    }
  }

  // ---- ping（心跳）----
  _handlePing(ws, msg) {
    this.lastPingAt = Date.now();
    this._reply(ws, msg, 'pong', {});
  }

  // ---- screenshot:req（电脑截图 → 压缩 → base64 返回）----
  _handleScreenshotReq(ws, msg) {
    const payload = (msg.payload && typeof msg.payload === 'object') ? msg.payload : {};
    const reqPayload = {
      sourceId: payload.sourceId || null,
      format: (payload.format === 'png') ? 'png' : 'jpeg',
      quality: Number(payload.quality) || 0.85,
      maxSize: Number(payload.maxSize) || 1920,
    };
    // 15s 超时保护
    let settled = false;
    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      this._reply(ws, msg, 'screenshot:res', { ok: false, error: 'timeout', msg: '截图超时 15s' });
    }, SCREENSHOT_TIMEOUT_MS);
    this._doCapture(reqPayload).then((cap) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      this._reply(ws, msg, 'screenshot:res', {
        ok: true,
        data: cap.data,
        width: cap.width,
        height: cap.height,
        mime: cap.mime,
        sources: cap.sources || [],
      });
      // 【新增】小程序截图成功后，异步触发"截图自动解题闭环"：把截图当作面试官题 → AI识图解题 → 面板显示问答
      //     异步执行不阻塞 screenshot:res 回传给小程序（避免小程序等待模型响应而超时）
      try {
        const fire = async () => {
          const r = await this._autoSolveScreenshotAndSync({
            imageDataUrlOrBase64: cap.data,
            mime: cap.mime || 'image/jpeg',
            source: 'miniapp',
          });
          // 可选：把解题结果也通过 WS 推送给小程序（小程序可选择展示或忽略）
          try {
            this._reply(ws, null, 'screenshot:solved', {
              ok: !!r.success,
              source: 'miniapp',
              costMs: r.costMs || 0,
              answer: r.success ? (r.answer || '') : '',
              error: r.success ? '' : (r.message || r.error || ''),
            });
          } catch (_) { /* 推送失败忽略（小程序端可通过轮询 /api/overlay/status 兜底） */ }
        };
        fire().catch((e) => console.warn('[miniapp-screenshot] 自动解题异步失败（已兜底忽略）:', e && e.message));
      } catch (outerE) {
        console.warn('[miniapp-screenshot] 启动自动解题异常:', outerE && outerE.message);
      }
    }).catch((e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      const code = (e && e.code) || 'internal';
      const userMsg = (e && e.userMsg) || e.message || '截图失败';
      this._reply(ws, msg, 'screenshot:res', { ok: false, error: code, msg: userMsg });
    });
  }

  // ---- overlay:write-answer（小程序答案回写到电脑 overlay 答题面板）----
  _handleOverlayWriteAnswer(ws, msg) {
    const text = (msg.payload && msg.payload.text) ? String(msg.payload.text) : '';
    if (!text || !text.trim()) {
      this._reply(ws, msg, 'overlay:write-answer-ack', { ok: false, error: 'empty', msg: '答案文本为空' });
      return;
    }
    // bus 通知 main.js 转发给 overlayWindow
    if (this.bus) {
      try { this.bus.emit('local:write-answer-from-outside', text); } catch (_) { /* 忽略 */ }
    }
    // 更新 state（供后续 pull / 轮询读取）
    this.recordState({ answerText: text });
    const id = Date.now().toString(36);
    this._reply(ws, msg, 'overlay:write-answer-ack', { ok: true, id });
  }

  // ---- overlay:pull（兜底拉取最新 ASR / 答案 / 状态）----
  _handleOverlayPull(ws, msg) {
    this._reply(ws, msg, 'overlay:pull-ack', {
      asrText: this.state.asrText,
      answerText: this.state.answerText,
      isRecording: this.state.isRecording,
      lastAnswerAt: this.state.lastAnswerAt,
    });
  }

  // ============================================================
  // 18. 截图核心：WS + HTTP 共用
  //   由外部（main.js）把 Electron 的 desktopCapturer attach 进来
  //   如果外部没 attach：返回 {error: 'unsupported'}，避免 require('electron') 在纯 Node 环境报错
  //   返回 Promise<{ data:base64, width, height, mime, sources? }>
  // ============================================================
  async _doCapture(payload) {
    const fmt = (payload && payload.format === 'png') ? 'png' : 'jpeg';
    const quality = Number(payload && payload.quality);
    const q = (quality > 0 && quality <= 1) ? quality : 0.85;
    const maxSize = Number(payload && payload.maxSize) || 1920;
    const sourceId = (payload && payload.sourceId) || null;

    if (typeof this.captureFn !== 'function') {
      const e = new Error('CAPTURE_UNSUPPORTED');
      e.code = 'unsupported';
      e.userMsg = '当前环境不支持截图';
      throw e;
    }

    try {
      return await this.captureFn({ format: fmt, quality: q, maxSize, sourceId });
    } catch (e) {
      // 统一包装错误码
      if (!e.code) {
        const m = (e.message || '').toLowerCase();
        if (m.includes('permission') || m.includes('denied') || m.includes('屏幕录制') || m.includes('录制')) {
          e.code = 'permission';
          e.userMsg = e.userMsg || '请允许电脑屏幕录制权限';
        } else if (m.includes('timeout')) {
          e.code = 'timeout';
          e.userMsg = e.userMsg || '截图超时';
        } else {
          e.code = 'internal';
          e.userMsg = e.userMsg || '截图失败：' + (e.message || '未知错误');
        }
      }
      throw e;
    }
  }

  // ============================================================
  // 19. 主动断开当前小程序连接（用户在二维码弹窗点"断开连接"）
  // ============================================================
  disconnectMiniapp() {
    if (!this.minSocket) return { success: true, reason: 'no_connection' };
    try {
      this.minSocket.close(4000, 'user disconnect');
    } catch (_) { /* 忽略 */ }
    this.minSocket = null;
    this._setStatus('disconnected');
    return { success: true };
  }
}

// 单例导出
module.exports = new LocalHttpServer();
