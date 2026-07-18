/**
 * 隐私审计服务
 * 记录所有网络请求和数据传输
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

class PrivacyAudit {
  constructor(userDataPath) {
    this.auditPath = path.join(userDataPath, 'audit.log');
    this.auditLogPath = path.join(userDataPath, 'audit-summary.json');
    this.auditLog = [];
    this.maxLogSize = 10 * 1024 * 1024; // 10MB
    this.maxSummarySize = 50 * 1024; // 50KB
  }

  /**
   * 记录审计事件
   * @param {Object} event - 审计事件
   */
  log(event) {
    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp,
      ...event
    };

    // 写入日志文件
    this.appendToLog(JSON.stringify(logEntry));

    // 更新摘要
    this.updateSummary(event);

    // 更新内存日志（用于实时查看）
    this.auditLog.push(logEntry);
    if (this.auditLog.length > 1000) {
      this.auditLog.shift(); // 保留最近 1000 条
    }
  }

  /**
   * 记录网络请求
   * @param {string} url - 请求 URL
   * @param {string} method - HTTP 方法
   * @param {string} dataType - 数据类型
   * @param {number} dataSize - 数据大小（字节）
   * @param {string} metadata - 额外元数据
   */
  logNetworkRequest(url, method, dataType, dataSize, metadata = {}) {
    // 脱敏 URL
    const safeUrl = this.sanitizeUrl(url);

    this.log({
      type: 'network',
      action: 'request',
      url: safeUrl,
      method,
      dataType,
      dataSize,
      dataSizeHuman: this.formatBytes(dataSize),
      metadata
    });
  }

  /**
   * 记录 API 响应
   * @param {string} url - 请求 URL
   * @param {number} dataSize - 响应数据大小
   * @param {number} duration - 请求耗时（毫秒）
   * @param {boolean} success - 是否成功
   */
  logNetworkResponse(url, dataSize, duration, success) {
    const safeUrl = this.sanitizeUrl(url);

    this.log({
      type: 'network',
      action: 'response',
      url: safeUrl,
      dataSize,
      dataSizeHuman: this.formatBytes(dataSize),
      duration,
      durationHuman: duration + 'ms',
      success
    });
  }

  /**
   * 记录数据存储操作
   * @param {string} dataType - 数据类型
   * @param {string} operation - 操作类型（save/load/delete）
   * @param {number} dataSize - 数据大小
   */
  logDataOperation(dataType, operation, dataSize) {
    this.log({
      type: 'data',
      action: operation,
      dataType,
      dataSize,
      dataSizeHuman: this.formatBytes(dataSize),
      storage: 'local'
    });
  }

  /**
   * 记录敏感信息检测
   * @param {string} dataType - 数据类型
   * @param {string} detectedType - 检测到的敏感信息类型
   * @param {string} location - 位置描述
   */
  logSensitiveData(dataType, detectedType, location) {
    this.log({
      type: 'privacy',
      action: 'sensitive_detected',
      dataType,
      detectedType,
      location,
      severity: 'warning'
    });
  }

  /**
   * 追加到日志文件
   */
  appendToLog(line) {
    try {
      const timestamp = new Date().toISOString();
      fs.appendFileSync(this.auditPath, `[${timestamp}] ${line}\n`, 'utf-8');

      // 检查日志文件大小
      const stats = fs.statSync(this.auditPath);
      if (stats.size > this.maxLogSize) {
        // 日志文件过大，轮转
        this.rotateLog();
      }
    } catch (error) {
      // 静默失败，避免循环
    }
  }

  /**
   * 日志轮转
   */
  rotateLog() {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const oldPath = this.auditPath + '.' + timestamp;
      fs.renameSync(this.auditPath, oldPath);

      // 保留最近 5 个日志文件
      this.cleanOldLogs();
    } catch (error) {
      console.error('[PrivacyAudit] 日志轮转失败:', error);
    }
  }

  /**
   * 清理旧日志
   */
  cleanOldLogs() {
    try {
      const dir = path.dirname(this.auditPath);
      const files = fs.readdirSync(dir)
        .filter(f => f.startsWith('audit.log.'))
        .map(f => ({
          name: f,
          path: path.join(dir, f),
          time: fs.statSync(path.join(dir, f)).mtimeMs
        }))
        .sort((a, b) => b.time - a.time);

      // 保留最近 5 个
      files.slice(5).forEach(file => {
        fs.unlinkSync(file.path);
      });
    } catch (error) {
      console.error('[PrivacyAudit] 清理旧日志失败:', error);
    }
  }

  /**
   * 更新审计摘要
   */
  updateSummary(event) {
    try {
      let summary = {};

      if (fs.existsSync(this.auditLogPath)) {
        summary = JSON.parse(fs.readFileSync(this.auditLogPath, 'utf-8'));
      }

      // 更新统计
      summary.lastActivity = new Date().toISOString();
      summary.totalEvents = (summary.totalEvents || 0) + 1;

      // 网络请求统计
      if (!summary.network) summary.network = { total: 0, byType: {} };
      if (event.type === 'network') {
        summary.network.total++;
        if (event.dataType) {
          summary.network.byType[event.dataType] =
            (summary.network.byType[event.dataType] || 0) + 1;
        }
        if (event.dataSize) {
          summary.network.totalBytes = (summary.network.totalBytes || 0) + event.dataSize;
        }
      }

      // 数据操作统计
      if (!summary.data) summary.data = { total: 0, byType: {} };
      if (event.type === 'data') {
        summary.data.total++;
        if (event.dataType) {
          summary.data.byType[event.dataType] =
            (summary.data.byType[event.dataType] || 0) + 1;
        }
      }

      // 隐私统计
      if (!summary.privacy) summary.privacy = { total: 0, byType: {} };
      if (event.type === 'privacy') {
        summary.privacy.total++;
        if (event.detectedType) {
          summary.privacy.byType[event.detectedType] =
            (summary.privacy.byType[event.detectedType] || 0) + 1;
        }
      }

      // 保存摘要
      const data = JSON.stringify(summary, null, 2);
      fs.writeFileSync(this.auditLogPath, data, 'utf-8');
    } catch (error) {
      console.error('[PrivacyAudit] 更新摘要失败:', error);
    }
  }

  /**
   * 获取审计摘要
   */
  getSummary() {
    try {
      if (fs.existsSync(this.auditLogPath)) {
        return JSON.parse(fs.readFileSync(this.auditLogPath, 'utf-8'));
      }
      return {};
    } catch (error) {
      return {};
    }
  }

  /**
   * 获取最近的审计日志
   * @param {number} limit - 数量限制
   */
  getRecentLogs(limit = 100) {
    return this.auditLog.slice(-limit);
  }

  /**
   * 导出审计报告
   */
  exportReport() {
    const summary = this.getSummary();
    const recentLogs = this.getRecentLogs(200);

    return {
      summary,
      recentLogs,
      generatedAt: new Date().toISOString(),
      systemInfo: {
        platform: os.platform(),
        arch: os.arch(),
        version: app.getVersion()
      }
    };
  }

  /**
   * 清空审计日志
   */
  clear() {
    try {
      if (fs.existsSync(this.auditPath)) {
        fs.unlinkSync(this.auditPath);
      }
      if (fs.existsSync(this.auditLogPath)) {
        fs.unlinkSync(this.auditLogPath);
      }
      this.auditLog = [];
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * 脱敏 URL
   */
  sanitizeUrl(url) {
    try {
      const urlObj = new URL(url);
      // 脱敏 query 参数
      urlObj.searchParams.forEach((value, key) => {
        if (key.toLowerCase().includes('key') || key.toLowerCase().includes('token')) {
          urlObj.searchParams.set(key, '***');
        } else {
          urlObj.searchParams.set(key, this.truncate(value, 20));
        }
      });
      return urlObj.toString();
    } catch (error) {
      return url.substring(0, 100) + '...';
    }
  }

  /**
   * 截断字符串
   */
  truncate(str, maxLength) {
    if (str.length <= maxLength) return str;
    return str.substring(0, maxLength) + '...';
  }

  /**
   * 格式化字节数
   */
  formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  /**
   * 敏感信息检测模式
   */
  getSensitivePatterns() {
    return {
      idCard: /\d{15}|\d{18}/g,
      phone: /1[3-9]\d{9}/g,
      bankCard: /\d{16,19}/g,
      email: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
      ssn: /\d{3}-\d{2}-\d{4}/g
    };
  }

  /**
   * 检测敏感信息
   * @param {string} text - 要检测的文本
   * @returns {Array} 检测到的敏感信息
   */
  detectSensitiveInfo(text) {
    const patterns = this.getSensitivePatterns();
    const results = [];

    for (const [type, pattern] of Object.entries(patterns)) {
      const matches = text.match(pattern);
      if (matches) {
        results.push({
          type,
          count: matches.length,
          samples: matches.slice(0, 3).map(m => this.truncate(m, 10))
        });
      }
    }

    return results;
  }
}

module.exports = PrivacyAudit;