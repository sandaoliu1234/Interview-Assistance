const { ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

class AudioService {
  constructor() {
    this.isRecording = false;
    this.audioChunks = [];
    this.sampleRate = 16000;
    this.channels = 1;
    this.silenceThreshold = 200;
    this.silenceDuration = 1500;
    this.lastSoundTime = 0;
    this.isProcessing = false;
    this.detectionSensitivity = 5; // 默认灵敏度 1-10
  }

  /**
   * 开始持续监听
   */
  startListening(sensitivity = 5) {
    if (this.isRecording) {
      return { success: false, error: '已经在监听中' };
    }
    
    this.isRecording = true;
    this.audioChunks = [];
    this.lastSoundTime = Date.now();
    this.detectionSensitivity = sensitivity;
    
    console.log('开始持续监听... 灵敏度:', sensitivity);
    return { success: true };
  }

  /**
   * 添加音频数据
   */
  addAudioChunk(chunk) {
    if (!this.isRecording) return;
    
    this.audioChunks.push(chunk);
    
    // 检测声音活动
    const hasSound = this.detectVoiceActivity(chunk);
    if (hasSound) {
      this.lastSoundTime = Date.now();
    }
    
    return { needProcess: false };
  }

  /**
   * 检测音频中是否有声音活动
   */
  detectVoiceActivity(chunk) {
    if (!chunk || chunk.length === 0) return false;
    
    let sum = 0;
    const dataView = new DataView(chunk.buffer || chunk);
    for (let i = 0; i < chunk.length; i += 2) {
      const sample = dataView.getInt16(i, true);
      sum += sample * sample;
    }
    
    const energy = Math.sqrt(sum / chunk.length);
    return energy > this.silenceThreshold;
  }

  /**
   * 合并音频块
   */
  mergeAudioChunks() {
    const totalLength = this.audioChunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const merged = new Int16Array(totalLength);
    let offset = 0;
    
    for (const chunk of this.audioChunks) {
      const dataView = new DataView(chunk.buffer || chunk);
      for (let i = 0; i < chunk.length; i += 2) {
        merged[offset / 2] = dataView.getInt16(i, true);
        offset += 2;
      }
    }
    
    return this.createWavFile(merged);
  }

  /**
   * 创建WAV文件
   */
  createWavFile(samples) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);
    
    this.writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    this.writeString(view, 8, 'WAVE');
    this.writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, this.channels, true);
    view.setUint32(24, this.sampleRate, true);
    view.setUint32(28, this.sampleRate * 2 * this.channels, true);
    view.setUint16(32, 2 * this.channels, true);
    view.setUint16(34, 16, true);
    this.writeString(view, 36, 'data');
    view.setUint32(40, samples.length * 2, true);
    
    for (let i = 0; i < samples.length; i++) {
      view.setInt16(44 + i * 2, samples[i], true);
    }
    
    return buffer;
  }

  writeString(view, offset, string) {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  }

  /**
   * 停止监听
   */
  stopListening() {
    const remainingChunks = this.audioChunks.length > 0 ? this.mergeAudioChunks() : null;
    this.isRecording = false;
    this.audioChunks = [];
    console.log('停止监听');
    return { success: true, remainingAudio: remainingChunks };
  }

  /**
   * 检测文本是否包含问题 - 支持灵敏度设置
   * @param {string} text 待检测文本（通常是单句 ASR final 结果）
   * @param {number} sensitivity 灵敏度 1(最严)-10(最松)，默认 3（降低门槛，避免短提问误筛）
   * @returns {boolean} 是否判定为"潜在问题/面试触发句"
   */
  detectQuestion(text, sensitivity = 3) {
    if (!text || text.length < 2) return false;

    const trimmedText = text.trim();

    console.log('[detectQuestion] 输入:', trimmedText, '灵敏度:', sensitivity);

    // 1) 最小长度检查（根据灵敏度调整）
    //    公式：minLength = Math.max(3, 10 - sensitivity)
    //    - sensitivity=1(最严) → max(3,9)=9
    //    - sensitivity=3(默认) → max(3,7)=7  → "自我介绍一下。"(7字) 刚好通过
    //    - sensitivity=5 → max(3,5)=5
    //    - sensitivity=10(最松) → max(3,0)=3
    const minLength = Math.max(3, 10 - sensitivity);
    if (trimmedText.length < minLength) {
      console.log('[detectQuestion] 长度不足:', trimmedText.length, '<', minLength);
      return false;
    }

    // 2) 过滤常见的非问题短语（确认、回应、简单陈述）
    const excludePatterns = [
      /^(好的|没问题|行|可以|是|对|对呀|是的|嗯|嗯嗯|好的呀|OK)/i,
      /(不怕|没事|没关系|不用担心|不用谢|谢谢|不客气)/i,
      /^(那|那这|那那|然后|接着|再)/i,
      /^(这两|这几天|这两天的|这两天的)/i,
      /^(一二三|123|一二三四五)/i,
      /^(来去|来不去|去不去)/i,
      /^(啊啊|哦哦|嘿嘿|哈哈)/i,
      /^[\s，。！？!?，,。！!？?]*$/  // 纯标点
    ];
    if (excludePatterns.some(p => p.test(trimmedText))) {
      console.log('[detectQuestion] 被排除模式过滤');
      return false;
    }

    // 3) 文本质量检查：有效字符比例过低可能是误识别
    const validChars = trimmedText.replace(/[，。！？!?，,。！!？?\s]/g, '').length;
    if (validChars / trimmedText.length < 0.6) {
      console.log('[detectQuestion] 有效字符比例过低:', validChars / trimmedText.length);
      return false;
    }

    // 4) 疑问句式检测（高权重）
    const questionPatterns = [
      /[？?]$/,
      /^(什么|怎么|如何|为什么|能否|是否|有没有|可不可以)/i,
      /(请问|请教|帮我|你.*吗|你.*呢|为什么.*呢)/i,
      /(怎么样|如何看|怎么看|什么意思|什么情况)/i
    ];
    const hasQuestionPattern = questionPatterns.some(p => p.test(trimmedText));
    console.log('[detectQuestion] hasQuestionPattern:', hasQuestionPattern);

    // 5) 面试关键词检测（中等权重）
    const interviewKeywords = [
      '介绍', '经验', '项目', '技术', '问题', '解答', '代码',
      '算法', '设计', '系统', '架构', '经历', '工作', '实习',
      '职业', '规划', '期望', '薪资', '福利', '团队', '文化',
      'Java', 'Python', 'JavaScript', '前端', '后端', '数据库',
      'MySQL', 'Redis', 'MongoDB', 'Vue', 'React', 'Spring'
    ];
    const hasInterviewKeyword = interviewKeywords.some(k => trimmedText.includes(k));
    console.log('[detectQuestion] hasInterviewKeyword:', hasInterviewKeyword);

    // 6) 高优先级问句模式（高权重）
    const highPriorityKeywords = [
      '介绍一下', '你有什么', '你了解', '谈谈你', '你做过',
      '项目经验', '工作经历', '技术栈', '为什么', '怎么看',
      '你觉得', '你认为', '请说明', '请问你', '你能说说'
    ];
    const hasHighPriorityKeyword = highPriorityKeywords.some(k => trimmedText.includes(k));
    console.log('[detectQuestion] hasHighPriorityKeyword:', hasHighPriorityKeyword);

    // 7) 评分系统
    let score = 0;
    if (hasQuestionPattern) score += 4;
    if (hasInterviewKeyword) score += 2;
    if (hasHighPriorityKeyword) score += 4;

    console.log('[detectQuestion] 评分:', score);

    // 8) 阈值：有疑问句式时降低要求
    let threshold;
    if (hasQuestionPattern) {
      threshold = Math.max(2, 5 - sensitivity);
    } else {
      threshold = Math.max(4, 8 - sensitivity);
    }

    console.log('[detectQuestion] 阈值:', threshold, '结果:', score >= threshold);
    return score >= threshold;
  }
}

module.exports = new AudioService();
