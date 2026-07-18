/**
 * 百度实时 ASR WebSocket 客户端
 *
 * 流程（严格按照官方文档 https://cloud.baidu.com/doc/SPEECH/s/jlbxejt2i）：
 *   1) connect({ accessToken, appId, appKey, devPid })
 *      - URL: wss://vop.baidu.com/realtime_asr?sn=<uuid>&access_token=<token>
 *      - 第一帧发 START 文本帧：
 *        {
 *          "type": "START",
 *          "data": {
 *            "appid": <int>,           // 控制台 AppID（数字！）
 *            "appkey": "<string>",     // 控制台 API Key（必填！）
 *            "dev_pid": <int>,         // 1537/15372/1737 等模型（必填！）
 *            "cuid": "<string>",
 *            "format": "pcm",          // 固定 pcm
 *            "sample": 16000           // 固定 16000
 *          }
 *        }
 *   2) 持续 sendAudio(int16Array) 发二进制 PCM（16kHz / 16-bit / 单声道）
 *      - 文档建议每帧 160ms = 5120 字节；接受 20-200ms
 *      - 帧间隔 100-200ms
 *      - 5s 内无数据服务端会断开 → 必要时发 HEARTBEAT
 *   3) 服务端推送：
 *      - MID_TEXT：临时识别结果（中间识别）
 *      - FIN_TEXT：最终结果（一句结束），err_no!=0 表示本句识别错误
 *      - HEARTBEAT：服务端心跳（5s 一次），忽略
 *   4) finish() 发 FINISH 文本帧：{ "type": "FINISH" }
 *
 * 鉴权（关键！）：
 *   - access_token 通过 URL query 传递
 *   - appid + appkey 通过 START.data 传递（不能用 access_token 代替 appkey！）
 */

const REALTIME_URL = 'wss://vop.baidu.com/realtime_asr';
const DEFAULT_DEV_PID = 15372;        // 中文普通话+加强标点

class RealtimeSpeechService {
  constructor() {
    this.ws = null;
    this.sessionId = null;
    this.handlers = {};               // onInterim / onFinal / onError / onOpen
    this.isOpen = false;
    this.lastDataAt = 0;              // 上次发音频时间（用于 5s 检测）
    this.heartbeatTimer = null;       // 心跳定时器
    this.boost = 50;                  // 音频增益倍数（默认 50x，可通过 setBoost 调整）
  }

  /**
   * 设置音频增益倍数（针对 native-audio-node 在某些声卡上电平偏低的问题）
   */
  setBoost(boost) {
    const n = parseInt(boost, 10);
    if (!isNaN(n) && n >= 1 && n <= 500) {
      this.boost = n;
      console.log(`[realtime-speech] boost 已更新为 ${n}x`);
    }
  }

  _emit(type, payload) {
    const fn = this.handlers[type];
    if (typeof fn === 'function') {
      try {
        // ★ 调试日志：确认事件被触发
        if (type === 'interim' || type === 'final' || type === 'error') {
          console.log(`[realtime-speech] _emit('${type}'):`, type === 'interim' || type === 'final' ? `"${payload.text}"` : payload.message);
        }
        fn(payload);
      } catch (e) { console.error(`[realtime-speech] handler ${type} threw:`, e); }
    } else {
      // ★ 没有监听器：可能事件名不匹配
      if (type === 'interim' || type === 'final') {
        console.warn(`[realtime-speech] _emit('${type}') 但无监听器！text="${payload.text}"`);
      }
    }
  }

  on(event, fn) { this.handlers[event] = fn; }

  async connect({ accessToken, appId, appKey, devPid = DEFAULT_DEV_PID } = {}) {
    // ★ 入口日志：确认函数被调用
    console.log('[realtime-speech] ▶ connect() 被调用', { hasToken: !!accessToken, hasAppId: !!appId, hasAppKey: !!appKey });

    if (!accessToken) throw new Error('缺少 accessToken');
    if (!appId) throw new Error('缺少 appid（请到百度智能云控制台语音技术项目里查看）');
    if (!appKey) throw new Error('缺少 appkey（请到设置里填 API Key）');

    // 用 UUID 风格生成 sn（[a-zA-Z0-9-_]{1,128}）
    this.sessionId = `ia-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

    // 浏览器 WebSocket 不支持自定义 header；access_token 走 URL query
    // dev_pid 不放 URL（文档没要求，文档说放 START.data）
    const url = `${REALTIME_URL}?sn=${encodeURIComponent(this.sessionId)}&access_token=${encodeURIComponent(accessToken)}`;
    console.log('[realtime-speech] WS URL 构建完成，长度 =', url.length);

    // 优先用浏览器原生 WebSocket；Node 环境没有此对象
    const WS = typeof WebSocket !== 'undefined' ? WebSocket : null;
    if (!WS) {
      throw new Error('当前环境不支持 WebSocket（Node 端请安装 ws 包）');
    }
    console.log('[realtime-speech] WebSocket 类可用，准备创建实例');

    return new Promise((resolve, reject) => {
      console.log('[realtime-speech] ▶ 进入 Promise executor，准备 new WS()');
      let ws;
      try {
        ws = new WS(url);
      } catch (e) {
        console.error('[realtime-speech] new WS 失败:', e.message);
        reject(e);
        return;
      }
      console.log('[realtime-speech] ✓ WebSocket 实例已创建，等待 onopen/onerror...');

      ws.onopen = () => {
        console.log('[realtime-speech] ★ onopen 触发！');
        this.ws = ws;
        this.isOpen = true;
        this.lastDataAt = Date.now();

        // ★ 严格按照官方文档的 START 帧结构（type + data 嵌套）
        // appid 必须是数字（不是字符串！）
        const startFrame = {
          type: 'START',
          data: {
            appid: parseInt(appId, 10),     // 数字！parseInt 强制转 int
            appkey: appKey,                  // API Key（必填！）
            dev_pid: devPid,                 // 模型 ID（必填！）
            cuid: 'interview-assistant',
            format: 'pcm',                   // 固定 pcm
            sample: 16000                    // 固定 16000
          }
        };
        console.log('[realtime-speech] START 帧:', JSON.stringify(startFrame));
        try {
          ws.send(JSON.stringify(startFrame));
          console.log('[realtime-speech] START 帧已发送');
        } catch (e) {
          console.error('[realtime-speech] START 帧发送失败:', e.message);
        }
        this._emit('open', { sessionId: this.sessionId });

        // 启动心跳监控：4s 内无数据发 HEARTBEAT（防止 5s 超时断开）
        this._startHeartbeat();

        resolve(ws);
      };

      ws.onmessage = (event) => {
        console.log('[realtime-speech] 收到消息:', (event.data || '').toString().substring(0, 200));
        let msg;
        try {
          msg = JSON.parse(typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data));
        } catch (e) {
          console.warn('[realtime-speech] 收到非 JSON 帧:', event.data);
          return;
        }
        // 忽略服务端 HEARTBEAT（文档：5s 一次，收到后忽略）
        if (msg.type === 'HEARTBEAT') return;

        if (msg.type === 'MID_TEXT') {
          this._emit('interim', { text: msg.result || '', sn: msg.sn });
          return;
        }
        if (msg.type === 'FIN_TEXT') {
          // ★ 错误也通过 FIN_TEXT 返回（err_no != 0），不是单独的 ERROR 类型
          if (msg.err_no && msg.err_no !== 0) {
            console.log('[realtime-speech] FIN_TEXT 错误:', msg.err_no, msg.err_msg);
            this._emit('error', {
              code: msg.err_no,
              message: msg.err_msg || 'FIN_TEXT 错误',
              raw: msg
            });
          } else {
            console.log('[realtime-speech] FIN_TEXT 结果:', msg.result);
            this._emit('final', {
              text: msg.result || '',
              sn: msg.sn,
              startTime: msg.start_time,
              endTime: msg.end_time
            });
          }
          return;
        }
        // 其它类型忽略
      };

      ws.onerror = (e) => {
        console.error('[realtime-speech] onerror 触发:', e?.message || e);
        this._stopHeartbeat();
        this._emit('error', { code: -1, message: e?.message || 'WebSocket 连接错误', raw: e });
        if (!this.isOpen) reject(new Error('WebSocket 连接失败（请检查网络 / appid / appkey）'));
      };

      ws.onclose = (e) => {
        console.log('[realtime-speech] onclose 触发: code=' + e?.code + ' reason=' + e?.reason);
        this.isOpen = false;
        this._stopHeartbeat();
        this._emit('close', { code: e?.code, reason: e?.reason });
        // 如果 promise 还没 resolve（即还没成功 open 过），让它 reject 出去
        if (!this.isOpen) reject(new Error('WebSocket 在 open 前就关闭: code=' + e?.code));
      };
    });
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || !this.isOpen) return;
      const now = Date.now();
      // 4s 内没发过音频数据，发 HEARTBEAT 防 5s 超时断开
      if (now - this.lastDataAt > 4000) {
        try {
          this.ws.send(JSON.stringify({ type: 'HEARTBEAT' }));
          console.log('[realtime-speech] 已发 HEARTBEAT（防止 5s 超时）');
        } catch (e) {}
      }
    }, 2000);
  }

  _stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * 发送一帧音频数据（Int16Array / Float32Array 都接受）
   * 百度要求 16-bit PCM，单声道，16kHz
   * - Int16 直接发
   * - Float32 转 Int16（×32767）
   * 帧大小：建议 100-200ms = 1600-3200 样本 @16kHz
   *
   * ★ 默认 boost = 50x，因为 native-audio-node 在某些 Windows + Realtek 配置下
   *   抓到的音频电平异常低（peak=255），需要大幅放大才能让 Baidu VAD 触发
   *   用户可在设置中调整
   */
  sendAudio(samples) {
    if (!this.ws || !this.isOpen) return;
    this.lastDataAt = Date.now();

    let int16;
    let peak = 0;
    if (samples instanceof Int16Array) {
      int16 = samples;
    } else {
      // Float32 → Int16 转换
      const BOOST = this.boost;     // ★ 使用动态 boost（默认 50x）
      int16 = new Int16Array(samples.length);
      for (let i = 0; i < samples.length; i++) {
        let v = samples[i] * BOOST;
        if (v > 1) v = 1; else if (v < -1) v = -1;     // 限幅防溢出
        int16[i] = v < 0 ? Math.round(v * 32768) : Math.round(v * 32767);
        const a = Math.abs(int16[i]);
        if (a > peak) peak = a;
      }
    }

    // 每 25 帧（约 5 秒）打印一次
    if (!this._sendLogCount) this._sendLogCount = 0;
    this._sendLogCount++;
    if (this._sendLogCount % 25 === 1) {
      console.log(`[realtime-speech] sendAudio #${this._sendLogCount}: ${samples.length} 样本, peak=${peak} (boost=${this.boost}x, max=32768)`);
    }

    this.ws.send(int16.buffer.slice(int16.byteOffset, int16.byteOffset + int16.byteLength));
  }

  finish() {
    if (!this.ws || !this.isOpen) return;
    this._stopHeartbeat();
    // 结束帧：严格按文档只发 type
    try { this.ws.send(JSON.stringify({ type: 'FINISH' })); } catch (e) {}
  }

  close() {
    this._stopHeartbeat();
    try { this.finish(); } catch (e) {}
    if (this.ws) {
      try { this.ws.close(); } catch (_) {}
      this.ws = null;
    }
    this.isOpen = false;
  }
}

module.exports = RealtimeSpeechService;
