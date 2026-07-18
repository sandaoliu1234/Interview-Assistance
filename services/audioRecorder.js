const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

class AudioRecorder {
  constructor() {
    this.recordingProcess = null;
    this.audioChunks = [];
    this.isRecording = false;
  }

  // 检查是否有可用的录音工具
  checkRecordingTool() {
    try {
      // 优先尝试使用系统自带的录音工具
      // Windows下可以使用powershell的录音功能，或者ffmpeg
      // 这里简化处理，先提供一个基础版本
      return true;
    } catch (e) {
      console.error('检查录音工具失败:', e);
      return false;
    }
  }

  // 开始录音 - 使用Web Audio API在前端实现会更好
  // 这里我们提供一个简化的后端录音接口，实际录音主要在前端完成
  async startRecording() {
    if (this.isRecording) {
      throw new Error('已经在录音中');
    }

    this.audioChunks = [];
    this.isRecording = true;
    console.log('开始录音...');
  }

  // 添加音频数据
  addAudioChunk(chunk) {
    if (this.isRecording) {
      this.audioChunks.push(chunk);
    }
  }

  // 停止录音
  async stopRecording() {
    if (!this.isRecording) {
      throw new Error('没有在录音');
    }

    this.isRecording = false;
    console.log('停止录音');

    // 将音频数据合并
    if (this.audioChunks.length > 0) {
      const audioBuffer = Buffer.concat(this.audioChunks);
      this.audioChunks = [];
      return audioBuffer;
    }

    return null;
  }

  // 保存音频到文件
  saveAudioToFile(audioBuffer, filePath) {
    try {
      fs.writeFileSync(filePath, audioBuffer);
      console.log('音频保存到:', filePath);
      return filePath;
    } catch (e) {
      console.error('保存音频失败:', e);
      throw e;
    }
  }

  // 清理资源
  cleanup() {
    this.audioChunks = [];
    this.isRecording = false;
    if (this.recordingProcess) {
      this.recordingProcess.kill();
      this.recordingProcess = null;
    }
  }
}

module.exports = new AudioRecorder();
