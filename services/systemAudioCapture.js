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
    }

    // 启动 WASAPI Loopback 采集
    const params = {
      sampleRate: options.sampleRate || 16000,
      chunkDurationMs: options.chunkDurationMs || 128,
      mute: options.mute ?? false,
      stereo: options.stereo ?? false,
      emitSilence: options.emitSilence ?? true,
      includeProcesses: options.includeProcesses || null,
      excludeProcesses: options.excludeProcesses || null
    };

    try {
      this.native.startSystemAudio(params);
      this.running = true;
      // 启动 10ms 轮询，拉取原生事件队列
      this._startPolling();
      console.log('[systemAudioCapture] WASAPI 采集已启动:', params);
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
          this.emit('metadata', this.metadata);
          break;
      }
    }
  }
}

module.exports = SystemAudioCapture;
