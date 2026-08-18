/**
 * 状态持久化管理
 * 定期保存应用状态，支持崩溃恢复
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

class StateManager {
  constructor(userDataPath) {
    this.userDataPath = userDataPath;
    this.statePath = path.join(userDataPath, 'state.json');
    this.state = {
      version: 1,
      lastSaved: null,
      resume: {
        content: '',
        filePath: null,
        lastModified: null
      },
      conversation: {
        history: [],
        currentTurns: 0
      },
      session: {
        isActive: false,
        startTime: null,
        endTime: null,
        questionCount: 0
      },
      audio: {
        isListening: false,
        source: null,
        lastActivity: null
      }
    };
    this.autoSaveInterval = null;
    this.autoSaveEnabled = false;
  }

  /**
   * 启动自动保存
   * @param {number} interval - 保存间隔（毫秒），默认 30 秒
   */
  startAutoSave(interval = 30000) {
    if (this.autoSaveInterval) {
      this.stopAutoSave();
    }

    this.autoSaveEnabled = true;
    this.autoSaveInterval = setInterval(() => {
      this.save();
    }, interval);

    console.log('[StateManager] 自动保存已启动，间隔:', interval);
  }

  /**
   * 停止自动保存
   */
  stopAutoSave() {
    if (this.autoSaveInterval) {
      clearInterval(this.autoSaveInterval);
      this.autoSaveInterval = null;
      console.log('[StateManager] 自动保存已停止');
    }
    this.autoSaveEnabled = false;
  }

  /**
   * 更新状态
   * @param {string} key - 状态键路径（如 'resume.content'）
   * @param {any} value - 状态值
   */
  update(key, value) {
    const keys = key.split('.');
    let current = this.state;

    for (let i = 0; i < keys.length - 1; i++) {
      if (!current[keys[i]]) {
        current[keys[i]] = {};
      }
      current = current[keys[i]];
    }

    current[keys[keys.length - 1]] = value;
    this.state.lastSaved = Date.now();
  }

  /**
   * 获取状态
   * @param {string} key - 状态键路径
   * @returns {any} 状态值
   */
  get(key) {
    const keys = key.split('.');
    let current = this.state;

    for (const k of keys) {
      if (current && current[k] !== undefined) {
        current = current[k];
      } else {
        return undefined;
      }
    }

    return current;
  }

  /**
   * 批量更新状态
   * @param {Object} updates - 要更新的键值对
   */
  batchUpdate(updates) {
    for (const [key, value] of Object.entries(updates)) {
      this.update(key, value);
    }
  }

  /**
   * 保存状态到文件
   */
  save() {
    try {
      this.state.lastSaved = Date.now();
      const data = JSON.stringify(this.state, null, 2);
      fs.writeFileSync(this.statePath, data, 'utf-8');
      // 注意：此处不再使用模板字符串拼接对象，getStateSummary() 已返回 JSON 字符串
      console.log('[StateManager] 状态已保存:', this.getStateSummary());
      return { success: true };
    } catch (error) {
      console.error('[StateManager] 保存失败:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 从文件加载状态
   */
  load() {
    try {
      if (fs.existsSync(this.statePath)) {
        const data = fs.readFileSync(this.statePath, 'utf-8');
        const loadedState = JSON.parse(data);

        // 合并加载的状态，保留当前结构
        this.state = {
          ...this.state,
          ...loadedState,
          version: loadedState.version || 1
        };

        console.log('[StateManager] 状态已加载:', this.getStateSummary());
        return { success: true, state: this.state };
      }
      return { success: false, error: '状态文件不存在' };
    } catch (error) {
      console.error('[StateManager] 加载失败:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 清空状态
   */
  clear() {
    this.state.session.isActive = false;
    this.state.session.startTime = null;
    this.state.session.questionCount = 0;
    this.state.conversation.history = [];
    this.state.conversation.currentTurns = 0;
    this.state.audio.isListening = false;
    this.state.audio.source = null;
    this.state.lastSaved = Date.now();
    this.save();
    console.log('[StateManager] 状态已清空');
  }

  /**
   * 检查是否有未完成的会话
   */
  hasUnfinishedSession() {
    return this.state.session.isActive && this.state.session.startTime;
  }

  /**
   * 获取状态摘要（用于日志）
   * @returns {string} 摘要 JSON 字符串，避免模板字符串中出现 [object Object]
   */
  getStateSummary() {
    const summary = {
      会话活跃: this.state.session.isActive,
      问题数: this.state.session.questionCount,
      对话轮数: this.state.conversation.currentTurns,
      简历长度: this.state.resume.content?.length || 0,
      监听中: this.state.audio.isListening
    };
    return JSON.stringify(summary);
  }

  /**
   * 获取恢复所需的数据
   */
  getRecoveryData() {
    return {
      session: this.state.session,
      conversation: this.state.conversation,
      resume: this.state.resume,
      hasUnfinished: this.hasUnfinishedSession()
    };
  }
}

module.exports = StateManager;