/**
 * ASR 管线服务 —— 面试辅助核心引擎
 *
 * 完整流程：
 *   WASAPI 系统音频采集 → 百度实时 ASR (WebSocket) → 问题检测 → AI 答题
 *
 * 架构（全部在 Electron 主进程运行，不依赖渲染层 getDisplayMedia）：
 *
 *   ┌─ SystemAudioCapture (native_audio.node / WASAPI Loopback)
 *   │    ↓ data 事件 (Buffer, PCM16, 16kHz, 128ms 块)
 *   ├─ RealtimeSpeechService (百度 ASR WebSocket)
 *   │    ↓ interim/final 事件 (文本)
 *   ├─ AudioService.detectQuestion() (问题检测)
 *   │    ↓ isQuestion = true
 *   └─ aiService.generateAnswer() (AI 答题)
 *        ↓ answer
 *   → 通过回调通知主进程 → IPC 广播到渲染层
 */

const SystemAudioCapture = require('./systemAudioCapture');
const RealtimeSpeechService = require('./realtimeSpeechService');
const audioService = require('./audioService');  // 单例实例（audioService.js exports new AudioService()）
const speechService = require('./speechService');
const aiService = require('./aiService');

class ASRPipeline {
  constructor() {
    this.capture = null;              // SystemAudioCapture 实例
    this.asr = null;                   // RealtimeSpeechService 实例
    this.audioService = null;          // 不再单独实例化，直接用 audioService 单例
    this.config = null;               // 面试配置（API Key、模型等）
    this.isRunning = false;            // 管线是否运行中
    this.isGenerating = false;         // 是否正在生成 AI 答案
    this.lastInterim = '';             // 最近一次临时识别文本
    this.conversationHistory = [];     // 对话历史
    this.onInterim = null;            // 回调：临时识别文本
    this.onFinal = null;               // 回调：最终识别文本
    this.onAnswer = null;              // 回调：AI 答案
    this.onError = null;               // 回调：错误
    this.onStatus = null;              // 回调：状态变化
  }

  /**
   * 启动 ASR 管线
   * @param {Object} config 面试配置（含 baiduApiKey, baiduSecretKey, baiduAppId 等）
   * @param {Object} callbacks 回调函数集合
   * @param {Function} callbacks.onInterim 临时识别文本回调 (text)
   * @param {Function} callbacks.onFinal 最终识别文本回调 (text)
   * @param {Function} callbacks.onAnswer AI 答案回调 (text)
   * @param {Function} callbacks.onError 错误回调 (message)
   * @param {Function} callbacks.onStatus 状态回调 (status)
   */
  async start(config, callbacks = {}) {
    if (this.isRunning) {
      throw new Error('ASR 管线已在运行中');
    }

    this.config = config;
    this.onInterim = callbacks.onInterim || (() => {});
    this.onFinal = callbacks.onFinal || (() => {});
    this.onAnswer = callbacks.onAnswer || (() => {});
    // ★ 新增回调：问题检测完成后、AI 开始答题前触发（Overlay 上用于显示"正在生成答案…"）
    this.onBeforeAnswer = callbacks.onBeforeAnswer || (() => {});
    this.onError = callbacks.onError || (() => {});
    this.onStatus = callbacks.onStatus || (() => {});

    // 校验百度 API 配置
    const apiKey = config.baiduApiKey || process.env.BAIDU_API_KEY;
    const secretKey = config.baiduSecretKey || process.env.BAIDU_SECRET_KEY;
    const appId = config.baiduAppId;
    if (!apiKey || !secretKey) {
      throw new Error('缺少百度语音 API Key / Secret Key，请在 .env 或设置中配置');
    }
    if (!appId) {
      throw new Error('缺少百度 App ID，请在设置中配置');
    }

    this._emitStatus('connecting');

    // 步骤 1/3：获取百度 access_token
    let accessToken;
    try {
      accessToken = await speechService.getBaiduAccessToken(apiKey, secretKey);
      console.log('[asrPipeline] ✓ 百度 access_token 获取成功');
    } catch (e) {
      this._emitError(`获取百度 access_token 失败: ${e.message}`);
      throw e;
    }

    // 步骤 2/3：连接百度实时 ASR WebSocket
    try {
      await this._connectASR(accessToken, appId, apiKey);
      console.log('[asrPipeline] ✓ 百度 ASR WebSocket 已连接');
    } catch (e) {
      this._emitError(`ASR WebSocket 连接失败: ${e.message}`);
      throw e;
    }

    // 步骤 3/3：启动 WASAPI 系统音频采集
    try {
      this.capture = new SystemAudioCapture();

      // 音频数据 → 喂给 ASR
      this.capture.on('data', ({ data }) => {
        this._feedAudioToASR(data);
      });

      // 采集错误
      this.capture.on('error', (e) => {
        console.error('[asrPipeline] WASAPI 采集错误:', e.message);
        this._emitError(`系统音频采集错误: ${e.message}`);
      });

      await this.capture.start({
        sampleRate: 16000,
        chunkDurationMs: 128,
        stereo: false,
        emitSilence: true
      });
      console.log('[asrPipeline] ✓ WASAPI 系统音频采集已启动');
    } catch (e) {
      // 采集失败，关闭 ASR 连接
      this._closeASR();
      this._emitError(`WASAPI 采集启动失败: ${e.message}`);
      throw e;
    }

    this.isRunning = true;
    this._emitStatus('listening');
    console.log('[asrPipeline] 🚀 管线全部就绪：WASAPI → 百度ASR → 问题检测 → AI答题');
  }

  /**
   * 停止 ASR 管线
   */
  async stop() {
    if (!this.isRunning) return;
    this.isRunning = false;
    this._emitStatus('stopping');

    // 停止 WASAPI 采集
    if (this.capture) {
      try { await this.capture.stop(); } catch (e) { /* 忽略 */ }
      this.capture = null;
    }

    // 关闭 ASR WebSocket
    this._closeASR();

    this.isGenerating = false;
    this.lastInterim = '';
    this._emitStatus('stopped');
    console.log('[asrPipeline] 🛑 管线已停止');
  }

  // ==================== 内部方法 ====================

  /**
   * 连接百度实时 ASR WebSocket
   */
  async _connectASR(accessToken, appId, appKey, devPid) {
    this.asr = new RealtimeSpeechService();

    // 设置音频增益（native-audio-node 电平偏低，默认 50x）
    this.asr.setBoost(this.config.audioBoost || 50);

    // 临时识别结果
    this.asr.on('interim', ({ text }) => {
      this.lastInterim = text;
      this.onInterim(text);
    });

    // 最终识别结果 → 问题检测 → AI 答题
    this.asr.on('final', ({ text }) => {
      console.log('[asrPipeline] ASR 最终结果:', text);
      this.onFinal(text);
      this._handleFinalText(text);
    });

    // ASR 错误
    this.asr.on('error', ({ message }) => {
      console.error('[asrPipeline] ASR 错误:', message);
      this._emitError(`语音识别错误: ${message}`);
    });

    // ASR 连接关闭
    this.asr.on('close', ({ code, reason }) => {
      console.log(`[asrPipeline] ASR WebSocket 关闭: code=${code} reason=${reason}`);
      if (this.isRunning) {
        this._emitStatus('disconnected');
      }
    });

    // 连接
    await this.asr.connect({
      accessToken,
      appId: String(appId),
      appKey: appKey,
      devPid: devPid || 15372  // 15372 = 中文普通话+加强标点
    });
  }

  /**
   * 关闭 ASR WebSocket 连接
   */
  _closeASR() {
    if (this.asr) {
      try { this.asr.close(); } catch (e) { /* 忽略 */ }
      this.asr = null;
    }
  }

  /**
   * 将 WASAPI 采集到的 PCM16 数据喂给百度 ASR
   * @param {Buffer} data PCM16 音频数据
   */
  _feedAudioToASR(data) {
    if (!this.asr || !this.asr.isOpen) return;

    // 将 Buffer 转为 Int16Array
    const int16 = new Int16Array(
      data.buffer,
      data.byteOffset,
      data.byteLength / 2
    );

    // 发送给 ASR（RealtimeSpeechService.sendAudio 接受 Int16Array）
    this.asr.sendAudio(int16);
  }

  /**
   * 处理 ASR 最终文本：问题检测 → AI 答题
   * @param {string} text 识别到的完整句子
   */
  async _handleFinalText(text) {
    if (!text || text.trim().length === 0) return;

    // 问题检测（使用 audioService 单例）
    const sensitivity = this.config.detectionSensitivity || 5;
    const isQuestion = audioService.detectQuestion(text, sensitivity);
    console.log(`[asrPipeline] 问题检测: ${isQuestion ? '✓ 是问题' : '✗ 不是问题'} (灵敏度=${sensitivity})`);

    if (!isQuestion) return;

    // 答题前：通知外部开始生成（overlay 显示 ⏳）
    try { this.onBeforeAnswer(text); } catch (_) { /* 回调异常不影响答题 */ }

    // AI 答题
    if (this.isGenerating) {
      console.log('[asrPipeline] 上一题正在生成中，跳过');
      return;
    }

    this.isGenerating = true;
    this._emitStatus('generating');
    try {
      const answer = await aiService.generateAnswer(
        text,
        this.config.interviewScene || 'behavioral',
        this.config.selectedService || 'tongyi',
        this.config,
        this.conversationHistory,
        this.config.resumeText || '',
        this.config.modelTier || 'standard'
      );

      // 记录对话历史
      this.conversationHistory.push({ role: 'user', content: text });
      this.conversationHistory.push({ role: 'assistant', content: answer });

      this.onAnswer(answer);
      console.log('[asrPipeline] ✓ AI 答案已生成:', answer.substring(0, 50) + '...');
    } catch (e) {
      console.error('[asrPipeline] AI 答题失败:', e.message);
      this._emitError(`AI 答题失败: ${e.message}`);
    } finally {
      this.isGenerating = false;
      if (this.isRunning) {
        this._emitStatus('listening');
      }
    }
  }

  /**
   * 发送错误通知
   */
  _emitError(message) {
    if (typeof this.onError === 'function') {
      this.onError(message);
    }
  }

  /**
   * 发送状态变化通知
   */
  _emitStatus(status) {
    if (typeof this.onStatus === 'function') {
      this.onStatus(status);
    }
  }
}

module.exports = ASRPipeline;
