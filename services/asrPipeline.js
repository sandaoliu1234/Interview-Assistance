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
    this.config = null;               // 面试配置（含 baiduApiKey, baiduSecretKey, baiduAppId 等）
    this.isRunning = false;            // 管线是否运行中
    this.isGenerating = false;         // 是否正在生成 AI 答案
    this.lastInterim = '';             // 最近一次临时识别文本
    // ★ P1-4 用户要求：让 AI"基于完整的识别文字自己判断哪部分是真正的提问"，
    //   因此这里累积最近若干句 ASR final，整段传给 AI。默认最近 8 句 / 最多 3000 字，
    //   避免窗口太大造成 AI 上下文污染。
    this._recentFinalBuffer = [];      // 最近几句 ASR final 文本（用于 AI 判断真正提问）
    this._recentFinalMaxSentences = 8;
    this._recentFinalMaxChars = 3000;
    this._lastQuestion = '';           // P1-2：本轮触发 AI 的原始问题句（onAnswer 回调时携带）
    this.conversationHistory = [];     // 本管线自维护对话历史（兜底）
    // ★ P3-2：可选外部注入 —— 取"跨入口共享上下文"（localHttpServer state.history 最近 5 轮）
    //   main.js start-asr-pipeline 回调里会赋值这个函数
    this.getSharedContext = null;
    this.onInterim = null;            // 回调：临时识别文本
    this.onFinal = null;               // 回调：最终识别文本
    this.onAnswer = null;              // 回调：AI 答案（现在是对象 { text, question, durationMs, error }）
    this.onBeforeAnswer = null;       // 回调：问题检测完成后、AI 开始答题前（question）
    this.onError = null;               // 回调：错误
    this.onStatus = null;              // 回调：状态变化
    // ★ P1-1/P3-1：可选外部 bus 引用（main.js 注入），用于在主线内直接发 bus 事件
    //   - asr:question-asked：显式创建 asked 轮
    //   - asr:answer-generated：完成/失败 → 结算 history（失败写 status=error）
    this.emitBus = null;
  }

  /**
   * 启动 ASR 管线
   * @param {Object} config 面试配置（含 baiduApiKey, baiduSecretKey, baiduAppId 等）
   * @param {boolean} [config.transcribeOnly] 纯转写模式（模拟面试浮窗用）：
   *        true 时只出 interim/final 转写事件，跳过问题检测与 AI 答题，
   *        且 final 文本不写 bus（不污染主面板 Copilot 会话 history）。
   * @param {string} [config.inputSource] 音频输入源：'mic'=麦克风采集（模拟面试），
   *        缺省='system'=WASAPI Loopback 回录系统声音（Copilot 面试辅助）。
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
    // ★ 回调赋值策略：**只在 callbacks 传入有效函数时覆盖，否则保留现有值**
    //   原因：main.js 中会先于 start() 调用给 asrPipeline.onInterim/onFinal/onAnswer
    //   等注入"broadcastToAllViews 广播回调"，再调用 start(mergedConfig, {})。
    //   如果这里用 `|| (() => {})` 强制赋值，callbacks={} 时会把外部已注入的
    //   广播函数**清空成空函数**，导致浮窗/主窗口永远收不到 ASR 文本/答案。
    if (typeof callbacks.onInterim === 'function') this.onInterim = callbacks.onInterim;
    else if (typeof this.onInterim !== 'function') this.onInterim = () => {};
    if (typeof callbacks.onFinal === 'function') this.onFinal = callbacks.onFinal;
    else if (typeof this.onFinal !== 'function') this.onFinal = () => {};
    if (typeof callbacks.onAnswer === 'function') this.onAnswer = callbacks.onAnswer;
    else if (typeof this.onAnswer !== 'function') this.onAnswer = () => {};
    // ★ 新增回调：问题检测完成后、AI 开始答题前触发（Overlay 上用于显示"正在生成答案…"）
    if (typeof callbacks.onBeforeAnswer === 'function') this.onBeforeAnswer = callbacks.onBeforeAnswer;
    else if (typeof this.onBeforeAnswer !== 'function') this.onBeforeAnswer = () => {};
    if (typeof callbacks.onError === 'function') this.onError = callbacks.onError;
    else if (typeof this.onError !== 'function') this.onError = () => {};
    if (typeof callbacks.onStatus === 'function') this.onStatus = callbacks.onStatus;
    else if (typeof this.onStatus !== 'function') this.onStatus = () => {};

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

      // ★ 根据 native 实际输出格式，做"类型归一化 + 智能转码"（核心修复）：
      //   native_audio.node 的 startSystemAudio 即便我们传了 sampleRate=16000，
      //   它仍然会通过 metadata(type=4) 事件告知我们真实输出格式 = pcm_f32le（Float32LE, 32-bit）。
      //   之前 _feedAudioToASR 一律当 Int16LE Buffer → 把 float 的字节"按 int16"读，
      //   字节解释错误导致 peak 计算恒为 0、-3005 全程静音。
      //   解决：先监听 capture 的 metadata，记录 isFloat / bitsPerChannel / sampleRate，
      //         再在 data 回调里按"真实格式"把 bytes 正确转成 Float32Array（归一化 [-1, 1]），
      //         最后把 Float32Array 喂给 RealtimeSpeechService.sendAudio —— sendAudio 里本来就有
      //         Float32 → Int16 的分支（含 boost* 放大 + 限幅），这才是正确链路。
      this._captureFormat = {
        known: false,        // 是否已收到 metadata(type=4) 事件
        isFloat: false,      // 是否浮点 PCM（pcm_f32le）
        bitsPerChannel: 16,  // 位深
        sampleRate: 16000,   // 采样率（调试用，不直接重采样）
      };
      // metadata 事件优先于 data 事件触发（native 设计如此），所以不会漏第一个 data
      this.capture.on('metadata', (meta) => {
        if (!meta) return;
        this._captureFormat = {
          known: true,
          isFloat: !!meta.isFloat,
          bitsPerChannel: Number(meta.bitsPerChannel) || (meta.isFloat ? 32 : 16),
          sampleRate: Number(meta.sampleRate) || 16000,
        };
        console.log('[asrPipeline] ⭐ capture 格式归一化：_captureFormat=%s', JSON.stringify(this._captureFormat));
      });
      // 兜底：10s 还没收到 metadata（极端情况），就手动查一次 capture.getMetadata()
      this._formatFallbackTimer = setTimeout(() => {
        if (!this._captureFormat.known && this.capture && typeof this.capture.getMetadata === 'function') {
          const m = this.capture.getMetadata();
          if (m) {
            this._captureFormat = {
              known: true,
              isFloat: !!m.isFloat,
              bitsPerChannel: Number(m.bitsPerChannel) || (m.isFloat ? 32 : 16),
              sampleRate: Number(m.sampleRate) || 16000,
            };
            console.log('[asrPipeline] capture 格式归一化（兜底 10s）：_captureFormat=%s', JSON.stringify(this._captureFormat));
          }
        }
      }, 10000);

      // 启动后前 120 帧（约 120 * 128ms ≈ 15s）监测"是否没抓到有效电平"，
      // 一旦连续 120 帧的 peak 都 < 200 时给出中文告警，让用户一眼明白：
      //   "不是百度/ASR 连不上，是采集端本身没抓任何声音"
      this._silenceWatch = {
        frames: 0,                    // 已采样计数
        maxFrames: 120,               // 最多看 120 帧后退出看门狗
        warnThr: 200,                 // peak 绝对值阈值（16-bit PCM max=32768；<200 ≈ 实际音量<0.6%）
        consecutive: 0,               // 连续低于阈值的帧数
        consecThr: 30,                // 连续 30 帧（约 3.8s）就告警一次
        nextWarnAt: 30,               // 下次告警的 consecutive 阈值
        didFinalWarn: false,          // 120 帧看完时，是否已经给了总结性告警
        hadValidPeak: false,          // ⭐ 看门狗周期内是否出现过任何一帧 peak>=warnThr（用于最终"通过/失败"判定）
        runningPeakMax: 0,            // ⭐ 看门狗周期内的 peak 最大值（调试用）
      };

      // 音频数据 → 喂给 ASR
      this.capture.on('data', ({ data }) => {
        // ===== 静音看门狗（启动后约 15s 内有效）=====
        const sw = this._silenceWatch;
        if (sw && sw.frames < sw.maxFrames) {
          sw.frames++;
          let peak = 0;
          try {
            // 计算这一帧的 16-bit PCM 峰值（绝对值最大）
            const buf = (data instanceof Buffer) ? data : Buffer.from(data);
            const len = buf.length;
            if (len >= 2) {
              for (let i = 0; i < len; i += 2) {
                const v = Math.abs(buf.readInt16LE(i));
                if (v > peak) peak = v;
              }
            }
          } catch (_) { peak = 0; }

          // 调试快照：每 25 帧（约 3.2s）打一行"看门狗自己算的 peak"，
          // 注意：这里是 boost 之前的原始值；下面 realtime-speech.sendAudio 里打印的 peak 是 *boost 之后的值。
          // 对应关系大致是：realtimePeak ≈ thisPeak * boost（默认 boost=50）。
          if (sw.frames === 1 || sw.frames % 25 === 0) {
            console.log('[asrPipeline][peak-snap] frame#%d | feedPeak(preBoost)=%d | runningMax=%d | bytes=%d',
              sw.frames, peak, sw.runningPeakMax,
              data ? (data.length || (data.byteLength) || 0) : 0);
          }

          if (peak > sw.runningPeakMax) sw.runningPeakMax = peak;
          if (peak >= sw.warnThr) {
            sw.hadValidPeak = true;
            sw.consecutive = 0;
          } else {
            sw.consecutive++;
            if (sw.consecutive > 0 && sw.consecutive >= sw.nextWarnAt) {
              sw.nextWarnAt = sw.consecutive + 60;
              console.warn('[asrPipeline] ⚠️ 静音告警：连续 %d 帧（约 %.0fs）检测到 PCM 峰值仅 %d（阈值 %d，120帧内历史峰值=%d）。\n    常见原因：\n      ① 你没有播放任何带人声的视频/会议声音（WASAPI Loopback 只抓"扬声器"，不抓麦克风）\n      ② 声音走了蓝牙耳机/HDMI 显示器/便携屏声卡，但被采集的不是这条输出设备（看上面 systemAudioCapture 打印的设备列表里 ⭐ 是否是你正在出声的那个）\n      ③ 系统音量太小或 Realtek 声卡电平偏低 → 把设置里的 audioBoost 从 50 调到 150-200 再试\n      ④ （调试新增）该声卡的 Loopback 可能不支持 16kHz 采样 → 代码里会再尝试 48kHz/44.1kHz',
                sw.consecutive, sw.consecutive * 0.128, peak, sw.warnThr, sw.runningPeakMax);
            }
          }
          // 120 帧总结：用 hadValidPeak 做最终判定（修之前的逻辑误报 bug：consecutive 中途被重置为 0 就不告警了）
          if (sw.frames >= sw.maxFrames && !sw.didFinalWarn) {
            sw.didFinalWarn = true;
            if (!sw.hadValidPeak) {
              console.warn('[asrPipeline] ❌ 启动阶段约 %.0fs 内【全程】未检测到有效音频（runningPeakMax=%d < 阈值=%d，共采样 %d 帧）。\n    🔧 处理建议（按可能性排序）：\n      [1] 先开一段带真人说话的视频/会议回放，音量调到 >30，确保自己耳朵能听到（Loopback 不回放任何声音时就是 0 电平，正常）\n      [2] 查看 systemAudioCapture 日志最后一行"本机输出设备列表"里 ⭐ 那一行是否带 [默认输出] 标记、且就是你"听到声音的那条"\n      [3] 查看 systemAudioCapture [raw-peak] 日志：如果它也全程=0，说明是 native 采集层没拿到数据（声卡 Loopback / 采样率不兼容）→ 下面会自动尝试 48kHz 重启\n      [4] 如果 systemAudioCapture raw-peak>0 但 feedPeak=0 → 是 asrPipeline buffer 解析 bug（请把 peak-snap 日志贴出来）\n      [5] 系统音量太小 / Realtek 电平低 → audioBoost 调到 150-200（最大 500）',
                sw.maxFrames * 0.128, sw.runningPeakMax, sw.warnThr, sw.maxFrames);
            } else {
              console.log('[asrPipeline] ✓ 启动阶段静音看门狗通过（120帧内 runningPeakMax=%d >= 阈值 %d）',
                sw.runningPeakMax, sw.warnThr);
            }
          }
        }

        // 正常喂给 ASR
        this._feedAudioToASR(data);
      });

      // 采集错误
      this.capture.on('error', (e) => {
        console.error('[asrPipeline] WASAPI 采集错误:', e.message);
        this._emitError(`系统音频采集错误: ${e.message}`);
      });

      // ⭐ 透传 deviceId / includeProcesses / excludeProcesses / inputSource：
      //   - inputSource='mic'（模拟面试浮窗）：采集麦克风（用户对着麦克风回答），
      //     此时 loopbackDeviceId/includeProcesses/excludeProcesses 均不适用（传 undefined）；
      //   - 默认（Copilot 模式）：WASAPI Loopback 回录系统声音：
      //     如果主窗口设置了 loopbackDeviceId，就用它（可支持非默认端点的专项采集）；
      //     否则，让 SystemAudioCapture 自己在内部调 getDefaultOutputDevice() 拿默认输出设备的 id。
      const useMicInput = !!(config && config.inputSource === 'mic');
      await this.capture.start({
        sampleRate: 16000,
        chunkDurationMs: 128,
        stereo: false,
        emitSilence: true,
        // ★ 输入源：'mic'=麦克风采集（模拟面试）；缺省='system'（WASAPI 回环，Copilot）
        inputSource: useMicInput ? 'mic' : 'system',
        deviceId: !useMicInput && config && typeof config.loopbackDeviceId === 'string' && config.loopbackDeviceId.trim()
          ? config.loopbackDeviceId.trim()
          : undefined,
        includeProcesses: !useMicInput && Array.isArray(config && config.includeProcesses) ? config.includeProcesses : null,
        excludeProcesses: !useMicInput && Array.isArray(config && config.excludeProcesses) ? config.excludeProcesses : null,
      });
      console.log(`[asrPipeline] ✓ ${useMicInput ? '麦克风' : 'WASAPI 系统音频'}采集已启动`);
    } catch (e) {
      // 采集失败，关闭 ASR 连接
      this._closeASR();
      this._emitError(`${config && config.inputSource === 'mic' ? '麦克风' : 'WASAPI'} 采集启动失败: ${e.message}`);
      throw e;
    }

    this.isRunning = true;
    this._emitStatus('listening');
    console.log(`[asrPipeline] 🚀 管线全部就绪：${config && config.transcribeOnly ? '麦克风 → 百度ASR → 纯转写（不触发 AI 答题）' : 'WASAPI → 百度ASR → 问题检测 → AI答题'}`);
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

    // 清理 metadata 兜底计时器
    if (this._formatFallbackTimer) {
      clearTimeout(this._formatFallbackTimer);
      this._formatFallbackTimer = null;
    }
    this._captureFormat = { known: false, isFloat: false, bitsPerChannel: 16, sampleRate: 16000 };

    // 关闭 ASR WebSocket
    this._closeASR();

    this.isGenerating = false;
    this.lastInterim = '';
    // 清理启动阶段的静音看门狗（如还在跑），避免 stop 后定时器仍然累积并发警告。
    if (this._silenceWatch) {
      this._silenceWatch.frames = 99999; // 用极大值让 data 回调里的看门狗立刻停止
      this._silenceWatch = null;
    }
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

    // 最终识别结果 → 先写 bus/localHttpServer（面板面试官区立即显示全部文字）→ 再走问题检测/AI答题
    this.asr.on('final', ({ text }) => {
      console.log('[asrPipeline] ASR 最终结果:', text);
      // ★ transcribeOnly 纯转写模式（模拟面试浮窗）：
      //   麦克风识别到的是"用户自己的回答"，绝不能写进 bus 的 asr:final——
      //   否则 localHttpServer 会把用户回答当成"面试官说的话"写进主面板 history（污染 Copilot 会话）。
      //   此模式只走 onFinal 回调（main.js 里会广播给浮窗 textarea），bus 完全旁路。
      const transcribeOnly = !!(this.config && this.config.transcribeOnly);
      // ====== 新增：把这句 final 文本立刻 emit 到 bus，让 localHttpServer 写进 history.questionText ======
      //   保证：不管 detectQuestion 是否命中、AI 是否开始作答，面板/H5 的面试官区都能看到 ASR 识别出的"全部文字"
      //   对应 localHttpServer._bindBusHandlers 里 h['asr:final'] 的处理逻辑（追加/复用 asked 轮）
      if (!transcribeOnly) {
        try {
          if (typeof this.emitBus === 'function') {
            this.emitBus('asr:final', text);
            console.log(`[asrPipeline] → bus.emit('asr:final') 已发送，len=${(text||'').length}`);
          } else {
            console.warn('[asrPipeline] ⚠ this.emitBus 未注入（null/非函数），bus.asr:final 不会发 → 面试官区不会实时显示。请检查 main.js start-asr-pipeline 是否赋值 emitBus=appBus.emit。');
          }
        } catch (e) {
          // bus 异常不能吞掉答题流程，仅记录
          console.warn('[asrPipeline] emitBus(asr:final) 发送异常（已兜底忽略）：', (e && e.message) || e);
        }
      }
      // ====== 兼容回调（旧入口/主窗口临时文本显示；transcribeOnly 模式下这是浮窗拿转写文本的唯一通道）======
      this.onFinal(text);
      // ====== 进入"粗筛 → AI 识别真正提问 → 答题"流程（transcribeOnly 模式内部会直接 return）======
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
   * 将 WASAPI 采集到的字节 Buffer 按"native 实际输出格式"正确归一化后，喂给百度 ASR。
   *   关键：native_audio.node 在 16kHz/48kHz 等模式下，实际输出是 pcm_f32le（Float32LE / 32-bit / [-1,1] 归一化），
   *        绝不是我们之前默认的 Int16LE。把 float 的字节当 int16 解析 → 样本值几乎都 < 1，
   *        导致所有链路的 peak 计算都是 0、百度 VAD 无法激活 → -3005 全程静音。
   *
   * 分发策略（基于 this._captureFormat.isFloat / bitsPerChannel）：
   *   - isFloat=true / bits=32 : Buffer 里是 Float32LE，直接用 DataView 解成 Float32Array（[-1,1]）喂 sendAudio
   *   - isFloat=true / bits=64 : 极少出现的 Float64LE，按比例归一化到 [-1,1] 转 Float32Array
   *   - bitsPerChannel=16     : 老版本 native 直接给 Int16LE，就用原来的 Int16Array 视图
   *   - bitsPerChannel=24     : 24-bit 整数（packed 3-byte），解成 Int32 再归一化到 [-1,1] 转 Float32Array
   *   - 其他/未知             : 报错并用 Int16LE 兜底（给一次中文告警，方便后续补支持）
   *
   * @param {Buffer} data native processEvents(type=0) 发来的原始字节块
   */
  _feedAudioToASR(data) {
    if (!this.asr || !this.asr.isOpen) return;
    if (!data) return;

    // 统一把 data 转成 Buffer + 拿到底层 ArrayBuffer（带 byteOffset/byteLength，保证不是 node Buffer 的共享切片）
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const byteLen = buf.length;
    if (byteLen === 0) return;
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + byteLen);
    const fmt = this._captureFormat;

    // --- 按格式分发 ---
    let samples;                  // 最终喂给 sendAudio 的：Float32Array 或 Int16Array
    let formatTag = 'unknown';    // 调试用，打印在看门狗快照里

    if (fmt.isFloat) {
      // ===== 浮点 PCM（Float32LE 32-bit 最常见；Float64LE 64-bit 兜底）=====
      formatTag = fmt.bitsPerChannel === 64 ? 'F64' : 'F32';
      const bytesPerSamp = fmt.bitsPerChannel === 64 ? 8 : 4;
      if (byteLen % bytesPerSamp !== 0) {
        // 字节不对齐：按"少算最后几个残片"处理，避免 DataView 越界
        console.warn('[asrPipeline] ⚠️ _feedAudioToASR：浮点块字节数 %d 与 %d 不对齐，将截断处理（format=%s）',
          byteLen, bytesPerSamp, formatTag);
      }
      const count = Math.floor(byteLen / bytesPerSamp);
      const f32 = new Float32Array(count);
      const dv = new DataView(ab);
      for (let i = 0; i < count; i++) {
        let v;
        if (bytesPerSamp === 8) v = dv.getFloat64(i * 8, true); else v = dv.getFloat32(i * 4, true);
        // 安全：万一 native 给的值轻微超过 [-1,1]（例如 -1.00002），先轻微裁剪，保证 sendAudio 里 *BOOST 后不会爆
        if (v > 1) v = 1; else if (v < -1) v = -1;
        f32[i] = v;
      }
      samples = f32;
    } else if (fmt.bitsPerChannel === 16) {
      // ===== 整数 PCM / Int16LE（老版本 native 会用这种格式）=====
      formatTag = 'I16';
      if (byteLen % 2 !== 0) {
        console.warn('[asrPipeline] ⚠️ _feedAudioToASR：16-bit 块字节数 %d 不对齐，将截断处理', byteLen);
      }
      const count = Math.floor(byteLen / 2);
      samples = new Int16Array(ab, 0, count);
    } else if (fmt.bitsPerChannel === 24) {
      // ===== 24-bit 整数 PCM（packed 3-byte LE）：转成 [-1,1] Float32 =====
      formatTag = 'I24';
      if (byteLen % 3 !== 0) {
        console.warn('[asrPipeline] ⚠️ _feedAudioToASR：24-bit 块字节数 %d 不对齐，将截断处理', byteLen);
      }
      const count = Math.floor(byteLen / 3);
      const f32 = new Float32Array(count);
      const dv = new DataView(ab);
      const SCALE = 1 / 0x7FFFFF;    // 24-bit 归一化系数：/ 8,388,607
      for (let i = 0; i < count; i++) {
        const off = i * 3;
        // 24-bit LE → 读 3 字节，符号扩展到 32 位整数
        let b24 = dv.getUint8(off) | (dv.getUint8(off + 1) << 8) | (dv.getUint8(off + 2) << 16);
        if (b24 & 0x800000) b24 |= ~0xFFFFFF;   // 符号扩展：24 位有符号补码 → JS 32 位有符号
        f32[i] = b24 < 0 ? (b24 * SCALE) : (b24 * SCALE);
        // 最后一次裁剪，避免浮点误差
        if (f32[i] > 1) f32[i] = 1; else if (f32[i] < -1) f32[i] = -1;
      }
      samples = f32;
    } else {
      // ===== 未知格式 → 按 Int16LE 兜底，并打一次告警方便我们后续增加专门分支 =====
      formatTag = 'UNK16';
      if (byteLen % 2 !== 0) {
        console.warn('[asrPipeline] ⚠️ _feedAudioToASR：未知格式（bitsPerChannel=%s, isFloat=%s）按 Int16LE 兜底时字节不对齐，将截断。',
          fmt.bitsPerChannel, fmt.isFloat);
      }
      const count = Math.floor(byteLen / 2);
      samples = new Int16Array(ab, 0, count);
      // 这种兜底只会发生一次
      if (!this._feedFormatWarned) {
        this._feedFormatWarned = true;
        console.warn('[asrPipeline] ❌ _feedAudioToASR：未支持的 native 输出格式 bitsPerChannel=%d isFloat=%s → 已按 Int16LE 兜底，ASR 结果大概率错误或静音。请把 systemAudioCapture 上面打印的 metadata 行贴出来，我加专门支持。',
          fmt.bitsPerChannel, fmt.isFloat);
      }
    }

    // ⭐ 调试：每次看门狗打快照时，把当前格式 + 最终 sample 视图类型 + 样本数打出来
    if (this._silenceWatch && (this._silenceWatch.frames === 0 || (this._silenceWatch.frames + 1) % 25 === 1)) {
      const viewTag = (samples instanceof Float32Array) ? 'Float32Array'
        : (samples instanceof Int16Array ? 'Int16Array' : Object.prototype.toString.call(samples));
      console.log('[asrPipeline][fmt-snap] formatTag=%s view=%s len=%d bytes=%d',
        formatTag, viewTag, samples.length, byteLen);
    }

    // 发送给 ASR（RealtimeSpeechService.sendAudio 同时接受 Int16Array 与 Float32Array）
    this.asr.sendAudio(samples);
  }

  /**
   * 处理 ASR 最终文本：
   *   1) 追加到最近 N 句的"整段 ASR 识别文字"缓冲（用户要求：面试官区显示全部文字，AI 从整段里自己识别真正提问）
   *   2) audioService.detectQuestion 做"粗筛触发"，触发后把整段缓冲 + 当前句喂给 AI，并加系统提示词让 AI 自己从完整文本中抽面试官提问再作答
   *   3) 答题前先 emit('asr:question-asked') 让 localHttpServer 创建 status=asked 轮，面板立刻显示 ⏳
   *   4) 成功/失败都通过 onAnswer（对象）回调出去，并 emit('asr:answer-generated', {text, question, error}) 结算 history
   *
   * @param {string} text 识别到的完整句子
   */
  async _handleFinalText(text) {
    if (!text || text.trim().length === 0) return;
    const finalSentence = String(text).trim();

    // ====== ★ 步骤 0：transcribeOnly 纯转写模式（模拟面试浮窗专用）—— 直接短路 ======
    //   模拟面试里麦克风识别的是"用户自己的回答"，不是面试官提问：
    //   若继续走下面的问题检测/AI 兜底判定/AI 答题，用户每说一句话都会被误判为
    //   "面试官提问"而触发 AI 抢答（且会烧 LLM tokens）。此模式下只出转写文本：
    //   final 文本已通过上方 onFinal 回调 → main.js broadcastToAllViews → 浮窗 textarea。
    if (this.config && this.config.transcribeOnly) {
      console.log(`[asrPipeline] 纯转写模式（transcribeOnly=true）：跳过问题检测/AI 答题，句长=${finalSentence.length}`);
      return;
    }

    // ====== 步骤 A：更新"最近 N 句 ASR final 缓冲"（整段识别文字，给 AI 看上下文）======
    this._recentFinalBuffer.push(finalSentence);
    while (this._recentFinalBuffer.length > this._recentFinalMaxSentences) {
      this._recentFinalBuffer.shift();
    }
    // 截断总字数（避免太长）
    let recentJoined = this._recentFinalBuffer.join('\n');
    if (recentJoined.length > this._recentFinalMaxChars) {
      recentJoined = recentJoined.slice(recentJoined.length - this._recentFinalMaxChars);
    }

    // ====== 步骤 B：粗筛（启发式），决定是否调用 AI ======
    //   ★ 灵敏度默认从 5 调到 3，长度公式也已下调到 Math.max(3, 12-sensitivity)，
    //     让"自我介绍一下。"这类 7 字短提问能通过粗筛，真正的"问题抽取"交给 AI 在步骤 G 里完成。
    //   ★ 即使粗筛仍没过，下面也会走 AI 兜底扫描（见 !isQuestion 分支），不会漏判。
    const sensitivity = this.config.detectionSensitivity || 3;
    const isQuestion = audioService.detectQuestion(finalSentence, sensitivity);
    console.log(`[asrPipeline] 问题检测: ${isQuestion ? '✓ 是问题' : '✗ 不是问题(粗筛)'} (灵敏度=${sensitivity}) 句长=${finalSentence.length}`);

    // ====== 步骤 B'：粗筛未命中 时的 AI 兜底判定（P1-4 阶段4要求，必须由 AI 识别真正提问）======
    //   为什么不能直接 return？——"自我介绍一下。"这种短问句、或 ASR 漏了问号/关键词时，启发式会误判，
    //   结果是：面试官原文已经显示（靠 asr:final 写 bus），但 AI 永远不答题 → 用户看到的就是"只有文字没有答案"。
    //   兜底策略（低成本优先）：
    //     a. 最近缓冲字数 < 20 且 总句数 < 3 → 还在开场，先不触发 AI（避免每句都调用浪费钱），等下一句再说。
    //     b. 否则调用一次 AI 做"问题抽取判定"：系统提示词只允许回答 YES/NO + 抽取出的问题；
    //        若 AI 回复 YES，则把抽取的问题作为 triggerQuestion 走正常答题流程。
    //     c. AI 判定 NO / 抛错 → 本次不触发答题（但面试官原文已通过 asr:final 显示，不影响用户看到识别文字）。
    let triggerQuestion = finalSentence; // 粗筛命中时直接用这一句，兜底命中时用 AI 抽的
    let needAiJudge = false;
    if (!isQuestion) {
      const sentenceCount = this._recentFinalBuffer.length;
      const totalChars = (recentJoined || '').length;
      // 太短就等一等（还没展开对话，没必要每句都调用一次 AI）
      const tooShortForAiJudge = totalChars < 20 && sentenceCount < 3;
      if (tooShortForAiJudge) {
        console.log(`[asrPipeline] 粗筛未命中，但缓冲太短（句=${sentenceCount} 字=${totalChars}），跳过 AI 兜底，等待后续句子。`);
        return;
      }
      // isGenerating 也在这里先兜住（和下面的统一分支一致），避免撞题
      if (this.isGenerating) {
        console.log('[asrPipeline] AI 兜底：上一题仍在生成中，跳过。');
        return;
      }
      needAiJudge = true;
      console.log(`[asrPipeline] → 触发 AI 兜底抽取问题（句=${sentenceCount} 字=${totalChars}）…`);
    }

    // ====== 步骤 C：AI 去重保护（上一题还在生成中 → 跳过）======
    if (this.isGenerating) {
      console.log('[asrPipeline] 上一题正在生成中，跳过（但已把本句追加进面试官区文字缓冲）');
      return;
    }

    // ====== 步骤 C'：AI 兜底判定（仅 needAiJudge 时）======
    //   先做一次轻量判定：让 AI 只输出 YES|NO\t抽取的问题，长度可控、成本低
    if (needAiJudge) {
      try {
        const judgePrompt =
`你是面试问题抽取器。请判断下面最近的面试识别文本中，是否包含面试官的"有效提问/指令类题目"（如"请做自我介绍"、"介绍一下你的项目"、"为什么跳槽"等）。
忽略寒暄、候选人的回答、过渡语如"好那我们开始"、"下一个问题"等本身不带题面的内容。

【最近识别段落】
${recentJoined}
【本句】
${finalSentence}

【严格输出格式】仅一行，不要任何解释或 Markdown：
- 如果判定为有有效提问：YES\t抽取出的问题原文（越简洁越好，只保留真正的提问句）
- 如果判定为没有有效提问：NO`;
        const rawJudge = await aiService.generateAnswer(
          judgePrompt,
          'behavioral',
          this.config.selectedService || 'tongyi',
          this.config,
          [], // 判定阶段不需要上下文
          '', // 判定阶段不需要简历
          'lite' // 走便宜/快的 tier，避免每次兜底都用大模型
        );
        const judgeLine = String(rawJudge || '').trim().split('\n')[0] || '';
        console.log(`[asrPipeline] AI 兜底判定原始输出：[${judgeLine.substring(0, 160)}]`);
        if (/^YES\b/i.test(judgeLine)) {
          // 抽取 "YES\t问题" 或 "YES 问题" 后面的部分
          const extracted = judgeLine.replace(/^YES[\s\t]*/i, '').trim();
          if (extracted && extracted.length > 0) {
            triggerQuestion = extracted;
            console.log(`[asrPipeline] AI 兜底判定: YES，抽取问题="${triggerQuestion.substring(0, 80)}" → 进入答题流程`);
          } else {
            // YES 但没抽出问题，兜底用当前句（多半是模型抽风格式不对）
            console.log('[asrPipeline] AI 兜底判定: YES，但未抽取到问题文本，兜底使用当前句作为 trigger。');
          }
        } else {
          // NO 或其他格式 → 不答题
          console.log('[asrPipeline] AI 兜底判定: NO / 格式异常 → 不触发答题（面试官原文已显示）。');
          return;
        }
      } catch (e) {
        // AI 兜底判定抛错 → 安全起见不触发答题，只记录
        console.warn('[asrPipeline] AI 兜底判定调用异常（已兜底忽略，不答题）：', (e && e.message) || e);
        return;
      }
    }

    // ====== 步骤 D：记录本轮"触发问题句"，给 history / 回调携带使用 ======
    //   注意：这里 triggerQuestion 可能来自粗筛命中句，也可能来自 AI 兜底抽取的问句
    this._lastQuestion = triggerQuestion;
    const triggerSourceTag = needAiJudge ? 'asr-ai-judge' : 'asr-panel';

    // ====== 步骤 E：显式创建提问轮（asr:question-asked）—— 面板/H5 立刻显示 ⏳ ======
    //   注：即使 detectQuestion 只命中了这一句，也会在 bus 订阅者侧把最近的面试官区文字（上面 final 已写）合并展示
    try {
      if (typeof this.emitBus === 'function') {
        this.emitBus('asr:question-asked', { question: triggerQuestion, source: triggerSourceTag });
      }
    } catch (_) { /* bus 异常不影响答题 */ }

    // 答题前：通知外部开始生成（overlay 显示 ⏳ 徽标）
    try { this.onBeforeAnswer(triggerQuestion); } catch (_) { /* 回调异常不影响答题 */ }

    this.isGenerating = true;
    this._emitStatus('generating');
    const startTime = Date.now();
    try {
      // ====== 步骤 F：组装跨入口上下文（H5/截图 也贡献对话历史）—— P3-2 共享上下文 ======
      //   优先级：外部注入 getSharedContext() → 本管线自维护 conversationHistory
      let sharedCtx = [];
      if (typeof this.getSharedContext === 'function') {
        try {
          const arr = await Promise.resolve(this.getSharedContext());
          if (Array.isArray(arr)) sharedCtx = arr.slice(0, 10); // 最近 10 条消息
        } catch (_) { sharedCtx = []; }
      }
      // 如果没有共享上下文，用管线自维护的兜底
      const ctxBase = (sharedCtx && sharedCtx.length) ? sharedCtx : this.conversationHistory;

      // ====== 步骤 G：构造让 AI 自己识别真正提问的输入 —— P1-4 ======
      //   策略：传"最近 N 句整段 ASR 识别文字"给 AI，并加系统指令，让 AI 再次确认/抽取真正的提问再作答
      //   说明：triggerQuestion 是粗筛或兜底抽的"候选问句"，这里仍然把整段上下文喂给 AI，让它做最终判断。
      const triggerDesc = needAiJudge
        ? `【AI 兜底抽取的触发问句】：${triggerQuestion}`
        : `【面试官刚说的一句（被粗筛判定为问题）】：${triggerQuestion}`;
      const aiPromptWrapper =
`【识别出的完整面试对话段落（最近${this._recentFinalMaxSentences}句 / 共${recentJoined.length}字）】
${recentJoined}

【系统指令】
你是专业的面试助手。请先"从上面完整面试对话段落中识别出面试官的真实提问"：
  - 忽略候选人的回答、寒暄、"嗯/好的/谢谢"等无意义语气词；
  - 忽略"下面我们来聊聊...那"等过渡性语句，抓出真正的问题本身；
  - 如果整段里没有明确提问，请直接输出"【未识别到面试官有效提问，请等待下一句。】"，不要编造问题。
识别出提问后，请结合你的专业能力与候选人简历上下文，输出精炼、高质量、结构化的回答要点。
（注意：你的最终输出在面试助手面板上直接给候选人看，不要输出"我识别到的问题是…"这类元说明，直接输出回答正文即可。）

${triggerDesc}
【请开始作答】`;

      const answer = await aiService.generateAnswer(
        aiPromptWrapper,                // 用包装后的整段作为输入
        this.config.interviewScene || 'behavioral',
        this.config.selectedService || 'tongyi',
        this.config,
        ctxBase,                         // P3-2：跨入口共享上下文（或兜底自维护）
        this.config.resumeText || '',
        this.config.modelTier || 'standard'
      );
      const durationMs = Date.now() - startTime;

      // 记录到管线自维护对话历史（兜底 + 兼容旧逻辑）—— 以 AI 最终看到的 triggerQuestion 作为 user 消息归档
      this.conversationHistory.push({ role: 'user', content: triggerQuestion });
      this.conversationHistory.push({ role: 'assistant', content: answer });

      // P1-2：回传对象，携带 question（triggerQuestion）、answer、耗时
      const payload = { text: answer, question: triggerQuestion, durationMs, error: '' };
      try { this.onAnswer(payload); } catch (_) { /* 回调异常忽略 */ }
      // 同步发 bus（localHttpServer 结算 history.status=answered）
      try {
        if (typeof this.emitBus === 'function') this.emitBus('asr:answer-generated', payload);
      } catch (_) { /* ignore */ }
      console.log(`[asrPipeline] ✓ AI 答案已生成: ${(answer || '').substring(0, 50)}... (耗时 ${durationMs}ms)`);
    } catch (e) {
      const durationMs = Date.now() - startTime;
      console.error('[asrPipeline] AI 答题失败:', e.message);
      // P3-1：失败场景也写 history.status=error（带错误信息，避免 UI 永远 ⏳）
      const errPayload = {
        text: '',
        question: triggerQuestion,
        durationMs,
        error: `AI 生成失败：${e.message || '未知错误'}`,
      };
      try { this.onAnswer(errPayload); } catch (_) { /* ignore */ }
      try {
        if (typeof this.emitBus === 'function') this.emitBus('asr:answer-generated', errPayload);
      } catch (_) { /* ignore */ }
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
