/**
 * 本地伴生设备中继服务（对齐参考实现的 localServer + relay）。
 *
 * 提供三条通道，供手机/iPad 等伴生设备实时查看面试转写与 AI 建议：
 *   1) GET /events  —— SSE 流，主进程通过 broadcast 推送实时转写/答案
 *   2) WS  /relay   —— WebSocket 双向通道（伴生端可发送请求，如触发解题）
 *   3) GET /        —— 伴生页 HTML（手机浏览器打开即可订阅 SSE）
 *
 * 依赖：Node 内置 http + 项目已安装的 ws。
 */

const http = require('http');
const { WebSocketServer } = require('ws');

/** 伴生页 HTML：订阅 SSE、渲染实时转写与答案 */
const COMPANION_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Interview Assist 伴生</title>
<style>
  body{margin:0;padding:16px;font-family:-apple-system,sans-serif;background:#0f172a;color:#e2e8f0;}
  h2{font-size:18px;margin:0 0 12px;}
  .item{background:#1e293b;border-radius:8px;padding:12px;margin-bottom:10px;}
  .q{color:#93c5fd;font-size:13px;}
  .a{color:#e2e8f0;font-size:14px;white-space:pre-wrap;margin-top:6px;}
  .hint{color:#64748b;font-size:12px;}
</style>
</head>
<body>
  <h2>🎧 Interview Assist 伴生设备</h2>
  <div class="hint" id="status">连接中…</div>
  <div id="list"></div>
  <script>
    var es = new EventSource('/events');
    es.onopen = function(){ document.getElementById('status').textContent='已连接，等待面试内容…'; };
    es.onerror = function(){ document.getElementById('status').textContent='连接断开，重连中…'; };
    es.onmessage = function(e){
      try {
        var d = JSON.parse(e.data);
        if (d.type === 'connected') return;
        var list = document.getElementById('list');
        var div = document.createElement('div');
        div.className = 'item';
        var q = document.createElement('div'); q.className='q'; q.textContent = (d.question || '');
        var a = document.createElement('div'); a.className='a'; a.textContent = (d.answer || d.text || '');
        if (d.question) div.appendChild(q);
        div.appendChild(a);
        list.insertBefore(div, list.firstChild);
      } catch(_) {}
    };
  </script>
</body>
</html>`;

class RelayServer {
  constructor() {
    this.server = null;          // http.Server
    this.wss = null;             // WebSocketServer
    this.sseClients = new Set(); // SSE 响应对象集合
    this.port = 0;
  }

  /**
   * 启动中继服务。
   * @param {number} port 监听端口（默认 9876，0=随机）
   * @returns {Promise<{success:boolean,port:number}>}
   */
  start(port = 9876) {
    if (this.server) return Promise.resolve({ success: true, port: this.port });
    this.server = http.createServer((req, res) => this._handle(req, res));
    // WebSocket 通道：/relay
    this.wss = new WebSocketServer({ server: this.server, path: '/relay' });
    this.wss.on('connection', (ws) => {
      // 伴生端可发消息（预留：触发解题等）
      ws.on('message', (msg) => {
        // 目前仅回执，未联动主流程
        try { ws.send(JSON.stringify({ type: 'ack', echo: JSON.parse(msg.toString()) })); } catch (_) {}
      });
    });
    return new Promise((resolve) => {
      this.server.on('error', (e) => resolve({ success: false, error: e.message }));
      this.server.listen(port, () => {
        this.port = this.server.address().port;
        resolve({ success: true, port: this.port });
      });
    });
  }

  /**
   * 停止中继服务并释放端口。
   */
  stop() {
    if (this.wss) { try { this.wss.close(); } catch (_) {} this.wss = null; }
    if (this.server) { try { this.server.close(); } catch (_) {} this.server = null; }
    this.sseClients.forEach((res) => { try { res.end(); } catch (_) {} });
    this.sseClients.clear();
    this.port = 0;
  }

  /** 当前是否在运行 */
  isRunning() {
    return !!this.server && this.server.listening;
  }

  /**
   * HTTP 请求分发。
   */
  _handle(req, res) {
    // CORS（便于手机浏览器跨设备访问）
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.url.startsWith('/events')) {
      // SSE 流
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });
      res.write('data: ' + JSON.stringify({ type: 'connected' }) + '\n\n');
      this.sseClients.add(res);
      req.on('close', () => this.sseClients.delete(res));
      return;
    }
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(COMPANION_HTML);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }

  /**
   * 向所有伴生设备广播一条消息（SSE + WebSocket 双通道）。
   * @param {Object} payload {type:'answer'|'transcript', question?, answer?, text?}
   */
  broadcast(payload) {
    if (!this.server) return;
    const line = 'data: ' + JSON.stringify(payload) + '\n\n';
    this.sseClients.forEach((res) => { try { res.write(line); } catch (_) {} });
    if (this.wss) {
      this.wss.clients.forEach((ws) => {
        if (ws.readyState === 1) { try { ws.send(line); } catch (_) {} }
      });
    }
  }
}

module.exports = new RelayServer();
