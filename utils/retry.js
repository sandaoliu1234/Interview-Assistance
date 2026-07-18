/**
 * 通用重试工具
 */

/**
 * 带重试机制的异步执行
 * @param {Function} fn - 要执行的异步函数
 * @param {Object} options - 配置选项
 * @returns {Promise<any>} 执行结果
 */
async function withRetry(fn, options = {}) {
  const {
    maxRetries = 3,           // 最大重试次数
    initialDelay = 1000,      // 初始延迟（毫秒）
    maxDelay = 30000,         // 最大延迟
    backoff = 'exponential',  // 退避策略: 'linear' | 'exponential'
    shouldRetry = null,       // 自定义重试条件函数
    onRetry = null            // 重试回调
  } = options;

  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // 最后一次失败，不再重试
      if (attempt === maxRetries) {
        throw error;
      }

      // 检查是否应该重试
      if (shouldRetry && !shouldRetry(error, attempt)) {
        throw error;
      }

      // 计算延迟时间
      let delay;
      if (backoff === 'exponential') {
        delay = Math.min(initialDelay * Math.pow(2, attempt), maxDelay);
      } else {
        delay = Math.min(initialDelay * (attempt + 1), maxDelay);
      }

      // 添加随机抖动（避免雷群效应）
      delay = delay + Math.random() * 500;

      // 调用重试回调
      if (onRetry) {
        onRetry(error, attempt + 1, delay);
      }

      // 等待后重试
      await sleep(delay);
    }
  }
}

/**
 * 延迟函数
 * @param {number} ms - 延迟毫秒数
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  withRetry,
  sleep
};