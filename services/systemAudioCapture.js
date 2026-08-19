/**
 * WASAPI 系统音频采集服务（CJS 封装）
 *
 * 直接加载 native_audio.node 原生二进制，提供与 native-audio-node
 * 的 SystemAudioRecorder 等效的 API，无需 npm 安装。
 *
 * 原生二进制来源：@native-audio-node/win32-x64 v0.3.3
 * 功能：Windows WASAPI Loopback Capture（系统声音回环捕获）
 *
 * 核心流程：
 *   start() → native.startSystemAudio() → 10ms 轮询 processEvents()
 *     → emit('data', { data: Buffer }) → 喂给 ASR
 *   stop()  → native.stop() → 停止轮询
 */

const EventEmitter = require('events');
const path = require('path');

class SystemAudioCapture extends EventEmitter {
  constructor() {
    super();
    this.native = null;          // 原生 AudioRecorderNative 实例
    this.running = false;       // 是否正在采集
    this.pollInterval = null;   // 轮询定时器 ID
    this.metadata = null;       // 音频元数据（采样率、声道、位深等）
    // ===== 调试计数器（解决 peak=0 时无法定位"是 native 没出数据，还是喂 ASR 时丢了"）=====
    this._debugFrameIdx = 0;     // 自增的 data 事件帧号（从 1 开始，第 N 块 chunk）
    this._debugPeakMaxRaw = 0;   // 启动到现在，raw event.data 的 PCM16 峰值
  }

  /**
   * 加载原生二进制模块
   * @returns {Object} 原生模块导出（含 AudioRecorderNative 类）
   */
  static loadNative() {
    // 按优先级尝试多个路径（Electron 打包后路径会变化）
    const candidates = [
      // 开发环境：项目根目录下的 native/ 文件夹
      path.join(__dirname, '..', 'native', 'native_audio.node'),
      // 打包后 asar.unpacked 路径
      path.join(process.resourcesPath || '', 'native', 'native_audio.node'),
      // 直接从 node_modules 加载（如果安装了 @native-audio-node/win32-x64）
      '@native-audio-node/win32-x64'
    ];

    for (const p of candidates) {
      try {
        const mod = typeof p === 'string' && !p.includes('.node')
          ? require(p)  // npm 包名
          : require(p);  // 文件路径
        if (mod && (mod.AudioRecorderNative || mod)) {
          console.log('[systemAudioCapture] 原生模块加载成功:', p);
          return mod.AudioRecorderNative ? mod : { AudioRecorderNative: mod };
        }
      } catch (e) {
        // 静默失败，继续尝试下一个
      }
    }
    throw new Error('无法加载 native_audio.node。请确保 native/native_audio.node 文件存在。');
  }

  /**
   * 开始采集系统音频（WASAPI Loopback）
   * @param {Object} options 采集选项
   * @param {number} options.sampleRate 采样率（默认 16000，百度 ASR 要求）
   * @param {number} options.chunkDurationMs 每块时长（ms，默认 128）
   * @param {boolean} options.mute 是否静音系统输出（默认 false）
   * @param {boolean} options.stereo 是否立体声（默认 false，单声道）
   * @param {boolean} options.emitSilence 是否发射静音块（默认 true）
   * @param {string}  options.deviceId 可选。要回录的"音频输出端点"（扬声器/耳机/HDMI）的 Endpoint ID。
   *                                   不传时，自动取 Windows 当前默认播放设备（由 getDefaultOutputDevice() 返回）。
   *                                   ⚠️ 经验：显式传比不传更可靠——有些 Realtek/HDMI 声卡下，不传时
   *                                   native 会抓 eRender 枚举里的第一个端点，而不是用户真正在出声的
   *                                   "默认播放设备"，导致 peak 永远 0、ASR 报 -3005。
   * @param {string[]|null} options.includeProcesses 仅采集白名单进程产生的音频（默认 null=不限制）
   * @param {string[]|null} options.excludeProcesses 排除黑名单进程产生的音频（默认 null=不限制）
   * @returns {Promise<void>}
   */
  async start(options = {}) {
    // 防止重复启动
    if (this.running) {
      throw new Error('SystemAudioCapture 已在运行中');
    }

    // 加载原生模块（首次调用时）
    if (!this.native) {
      const mod = SystemAudioCapture.loadNative();
      const NativeClass = mod.AudioRecorderNative || mod;
      this.native = new NativeClass();
      // 缓存"模块级根对象"，便于静态方法 listDevices/getDefaultOutputDevice 调用。
      // loadNative 返回的 mod 在两种情况下等效：
      //   - npm 包：mod.AudioRecorderNative / mod.listDevices 都在同一对象上；
      //   - .node 文件：AudioRecorderNative 就是 module.exports 自身，但 listDevices 等静态方法挂在 AudioRecorderNative.__proto__.constructor 外层，需要通过 mod.getParent() 不可行，
      //     所以直接把加载时的真实 mod 保存下来最稳。
      this._nativeMod = mod;
    }

    // 确定目标 deviceId：显式指定 > 默认输出设备 > 空（交由 native 兜底）
    let targetDeviceId = String(options.deviceId || '').trim();
    let targetDeviceName = '';
    let outputDevices = [];
    try {
      const mod = this._nativeMod;
      // 枚举所有 WASAPI 端点（输出 + 输入）
      const allDevs = (mod && typeof mod.listDevices === 'function') ? mod.listDevices() : null;
      if (Array.isArray(allDevs)) {
        // 输出设备（扬声器/HDMI/蓝牙耳机/便携屏声卡等）
        outputDevices = allDevs.filter((d) => d && d.isOutput === true);
        // 如果用户没显式指定 deviceId，取 Windows 默认播放设备
        if (!targetDeviceId && typeof mod.getDefaultOutputDevice === 'function') {
          try {
            targetDeviceId = String(mod.getDefaultOutputDevice() || '').trim();
          } catch (e) {
            console.warn('[systemAudioCapture] getDefaultOutputDevice 异常（仍继续，交由 native 兜底）:', e && e.message);
          }
        }
        // 把 id 翻译成人类可读的名字，便于日志核对
        const hit = outputDevices.find((d) => d && String(d.id) === targetDeviceId);
        if (hit) targetDeviceName = String(hit.name || (hit.manufacturer ? `${hit.manufacturer} (${hit.id.slice(0, 20)}…)` : ''));
      }
    } catch (e) {
      console.warn('[systemAudioCapture] 枚举音频设备异常（仍继续，交由 native 兜底）:', e && e.message);
    }

    // 启动 WASAPI Loopback 采集（显式带 deviceId）
    const params = {
      sampleRate: options.sampleRate || 16000,
      chunkDurationMs: options.chunkDurationMs || 128,
      mute: options.mute ?? false,
      stereo: options.stereo ?? false,
      emitSilence: options.emitSilence ?? true,
      includeProcesses: options.includeProcesses || null,
      excludeProcesses: options.excludeProcesses || null,
      // 关键修复：显式传默认输出设备 id，避免 native 内部挑错端点导致 peak 恒为 0
      deviceId: targetDeviceId || undefined,
    };

    // ====== 调试信息：把"目标设备对象的完整字段"以及"传给 native 的全部参数"打出来 ======
    // 用来确认：① listDevices 是否返回了采样率 / 位深 / isFloat 等格式信息；
    //          ② native 启动的参数是否与声卡兼容（Realtek 部分声卡 Loopback 不支持 16kHz，必须 48kHz）。
    let targetDeviceDump = null;
    try {
      const mod = this._nativeMod;
      const allDevs2 = (mod && typeof mod.listDevices === 'function') ? mod.listDevices() : null;
      if (Array.isArray(allDevs2)) {
        const tgt = allDevs2.find((d) => d && (String(d.id) === targetDeviceId));
        if (tgt) {
          targetDeviceDump = JSON.stringify(tgt, (k, v) => (typeof v === 'string' && v.length > 80 ? v.slice(0, 80) + '…' : v), 2);
        } else if (Array.isArray(outputDevices) && outputDevices[0]) {
          // 如果 targetDeviceId 没命中（例如 native 自己兜底了一个），就把第 1 个输出设备的字段打出来。
          targetDeviceDump = JSON.stringify(outputDevices[0], (k, v) => (typeof v === 'string' && v.length > 80 ? v.slice(0, 80) + '…' : v), 2);
        }
      }
    } catch (_) { targetDeviceDump = null; }
    const paramsDump = JSON.stringify(params, null, 2);
    console.log('[systemAudioCapture][debug] startSystemAudio 参数:\n' + paramsDump);
    if (targetDeviceDump) {
      console.log('[systemAudioCapture][debug] 目标设备 listDevices() 完整字段（用于核对默认采样率/位深/是否isFloat）:\n' + targetDeviceDump);
    } else {
      console.log('[systemAudioCapture][debug] 无法从 listDevices() 定位目标设备字段（可能是 native 版本差异），后面会用 metadata 事件补报格式。');
    }

    try {
      this.native.startSystemAudio(params);
      this.running = true;
      // 启动后把调试计数器重置，保证每"次"启动都是干净的
      this._debugFrameIdx = 0;
      this._debugPeakMaxRaw = 0;
      // 启动 10ms 轮询，拉取原生事件队列
      this._startPolling();
      // 日志打"设备名 + ID + 同机器上所有输出设备列表"，用户肉眼一眼就能核对是否抓错了设备
      const devNameLine = targetDeviceName ? `设备名="${targetDeviceName}"` : (targetDeviceId ? `deviceId="${targetDeviceId}"` : '(未指定，native 兜底)');
      console.log('[systemAudioCapture] WASAPI 采集已启动:', devNameLine);
      if (Array.isArray(outputDevices) && outputDevices.length > 0) {
        // 只把输出设备列出来（麦克风之类的输入设备与 Loopback 无关，不列）
        const lines = outputDevices.map((d) => {
          const defTag = (d && d.isDefault) ? ' [默认输出]' : '';
          const curTag = (targetDeviceId && d && String(d.id) === targetDeviceId) ? ' ⭐ 正在采集' : '';
          return `    - ${escapeLog(d && d.name) || '(无名称)'}${defTag}${curTag}  id=${escapeLog(String((d && d.id) || '').slice(0, 40))}`;
        });
        console.log(`[systemAudioCapture] 本机可用的"音频输出设备"（共 ${outputDevices.length} 个）：\n${lines.join('\n')}`);
        if (targetDeviceId && !outputDevices.some((d) => d && String(d.id) === targetDeviceId)) {
          console.warn('[systemAudioCapture] ⚠️ 传入的 deviceId 在 outputDevices 列表中找不到，请检查是否换了耳机/HDMI/便携屏后没切默认设备');
        }
      }
    } catch (e) {
      throw new Error(`WASAPI 采集启动失败: ${e.message}`);
    }
  }

  /**
   * 停止采集
   * @returns {Promise<void>}
   */
  async stop() {
    if (!this.running) return;

    // 停止轮询
    this._stopPolling();
    // 最后一次拉取残留事件
    this._processEvents();
    // 调用原生 stop
    try { this.native.stop(); } catch (e) { /* 忽略 */ }
    this.running = false;
    console.log('[systemAudioCapture] WASAPI 采集已停止');
  }

  /**
   * 是否正在采集
   * @returns {boolean}
   */
  isActive() {
    return this.running;
  }

  /**
   * 获取音频元数据
   * @returns {Object|null}
   */
  getMetadata() {
    return this.metadata;
  }

  // ==================== 内部方法 ====================

  /**
   * 启动 10ms 轮询，从原生模块事件队列拉取数据
   */
  _startPolling() {
    this.pollInterval = setInterval(() => {
      if (this.running) {
        this._processEvents();
      }
    }, 10); // 10ms 轮询，与 HireMe 保持一致
  }

  /**
   * 停止轮询
   */
  _stopPolling() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  /**
   * 处理原生事件队列
   * 事件类型：
   *   0 = data（音频数据块，Buffer/PCM16）
   *   1 = start（采集开始）
   *   2 = stop（采集停止）
   *   3 = error（错误）
   *   4 = metadata（音频元数据）
   */
  _processEvents() {
    if (!this.native) return;

    let events;
    try {
      events = this.native.processEvents();
    } catch (e) {
      this.emit('error', new Error(`processEvents 失败: ${e.message}`));
      return;
    }

    if (!events || events.length === 0) return;

    for (const event of events) {
      switch (event.type) {
        case 0:
          // 音频数据块：data 是 PCM16 Buffer
          if (event.data) {
            this._debugFrameIdx++;
            // ===== 调试：每 25 帧算一次 raw chunk 的 peak，和 asrPipeline 里 [peak-snap] 对齐对比 =====
            //   - 如果这里 rawPeak 也永远 = 0 → 是 native 采集层 / 声卡 Loopback / 采样率兼容问题
            //   - 如果这里 rawPeak > 0 但 asrPipeline 的 feedPeak = 0 → 是中间转换 / emit 丢失的 bug
            let rawPeak = 0;
            try {
              const db = (event.data instanceof Buffer) ? event.data : Buffer.from(event.data);
              const dlen = db.length;
              if (dlen >= 2) {
                for (let k = 0; k < dlen; k += 2) {
                  const dv = Math.abs(db.readInt16LE(k));
                  if (dv > rawPeak) rawPeak = dv;
                }
              }
            } catch (_) { rawPeak = 0; }
            if (rawPeak > this._debugPeakMaxRaw) this._debugPeakMaxRaw = rawPeak;
            if (this._debugFrameIdx === 1 || this._debugFrameIdx % 25 === 0) {
              console.log('[systemAudioCapture][raw-peak] frame#%d | rawPeak=%d | max=%d | bytes=%d | dataProto=%s',
                this._debugFrameIdx, rawPeak, this._debugPeakMaxRaw,
                event.data ? (event.data.length || event.data.byteLength || 0) : 0,
                event.data ? Object.prototype.toString.call(event.data) : 'null');
            }

            this.emit('data', { data: event.data });
          }
          break;
        case 1:
          // 采集开始
          this.emit('start');
          break;
        case 2:
          // 采集停止
          this.emit('stop');
          break;
        case 3:
          // 错误
          this.emit('error', new Error(event.message || 'Unknown native error'));
          break;
        case 4:
          // 元数据
          this.metadata = {
            sampleRate: event.sampleRate,
            channelsPerFrame: event.channelsPerFrame,
            bitsPerChannel: event.bitsPerChannel,
            isFloat: event.isFloat,
            encoding: event.encoding
          };
          // ⭐ 格式调试：如果 native 实际给的是 float32 / 24bit / 48kHz 而不是我们要的 16bit 16kHz，
          //    那 PCM 解析就会错（之前 asrPipeline 里把 float32 当 int16 读 → peak 永远接近 0）。
          console.log('[systemAudioCapture][debug] metadata 事件触发（native 实际输出格式，不是我们请求的）:',
            JSON.stringify(this.metadata));
          if (this.metadata && this.metadata.isFloat) {
            console.warn('[systemAudioCapture] ⚠️ native 实际输出的是【浮点PCM（isFloat=true）】，当前 asrPipeline/_feedAudioToASR 只按 Int16LE 解析，会导致 peak 永远 0 且识别失败。后面会尝试切换到 sampleRate=48000 / 或手动转 int16。');
          }
          if (this.metadata && this.metadata.bitsPerChannel && this.metadata.bitsPerChannel !== 16) {
            console.warn('[systemAudioCapture] ⚠️ native 实际位深 bitsPerChannel=%d（不是 16），当前代码按 16-bit 解析会出错。',
              this.metadata.bitsPerChannel);
          }
          if (this.metadata && this.metadata.sampleRate && this.metadata.sampleRate !== 16000 && this.metadata.sampleRate !== 48000 && this.metadata.sampleRate !== 44100) {
            console.warn('[systemAudioCapture] ⚠️ native 实际采样率=%d（非标准 16k/44.1k/48k），喂给百度 ASR 时可能导致识别速度异常或无结果。',
              this.metadata.sampleRate);
          }
          this.emit('metadata', this.metadata);
          break;
      }
    }
  }
}

/**
 * 极简日志文本转义：避免设备名/ID 中含换行或控制字符时把日志打坏。
 * @param {*} v 原始值
 * @returns {string} 可安全打印到日志的字符串
 */
function escapeLog(v) {
  const s = String(v == null ? '' : v);
  return s.replace(/[\r\n\t\v\f]/g, ' ').replace(/\x00/g, '');
}

module.exports = SystemAudioCapture;
