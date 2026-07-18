const axios = require('axios');
const { withRetry } = require('../utils/retry');
const { PrivacyAudit } = require('./privacyAudit');

// 创建隐私审计实例（懒加载，避免循环依赖）
let privacyAudit = null;
function getPrivacyAudit() {
  if (!privacyAudit) {
    // 需要传入 userDataPath，这里简化处理
    privacyAudit = {
      log: () => {}  // 简化，避免循环依赖
    };
  }
  return privacyAudit;
}

class AIService {
  constructor() {
    this.scenePrompts = {
      behavioral: `你是一位专业的面试辅导助手。针对以下面试问题，请提供：

1. 直接可用的完整回答（300-500字）

要求：
- 回答要简洁、实用、适合面试场景直接使用
- 基于候选人简历（如有）提供个性化建议
- 避免使用"答题思路"、"答题框架"等教学式语言

问题：`,
      technical: `你是一位资深的技术专家。针对以下技术面试问题，请提供：

1. 直接可用的技术解答（200-400字）
2. 3-5个关键技术点（简短有力）

要求：
- 回答要专业、准确，直接回答问题核心
- 基于候选人简历（如有）关联其实际经验
- 技术点要具体，避免泛泛而谈
- 避免使用"核心概念"、"解题思路"等教学式语言

问题：`,
      coding: `你是一位资深的软件开发工程师。针对以下编程面试问题，请提供：

1. 直接可用的代码实现
2. 代码简要说明（100字内）
3. 2-3个关键优化点（简短有力）

要求：
- 代码要完整可运行，有良好注释
- 使用常见的编程语言（JavaScript/Python/Java）
- 基于候选人简历（如有）选择其擅长的语言
- 避免使用"题目分析"、"解题思路"等教学式语言

问题：`
    };
  }

  // 文心一言API
  async callWenxin(prompt, apiKey) {
    return withRetry(
      async () => {
        const response = await axios.post(
          'https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop/chat/completions_pro',
          {
            messages: [
              {
                role: 'user',
                content: prompt
              }
            ],
            temperature: 0.7,
            top_p: 0.8,
            penalty_score: 1.0
          },
          {
            params: {
              access_token: apiKey
            },
            headers: {
              'Content-Type': 'application/json'
            }
          }
        );

        if (response.data.result) {
          return response.data.result;
        } else {
          throw new Error('文心一言API返回错误');
        }
      },
      {
        maxRetries: 3,
        initialDelay: 1000,
        onRetry: (error, attempt, delay) => {
          console.error(`[wenxin] 第 ${attempt} 次重试，${delay}ms 后...`);
        }
      }
    );
  }

  // 智谱AI API
  async callZhipu(prompt, apiKey) {
    return withRetry(
      async () => {
        const response = await axios.post(
          'https://open.bigmodel.cn/api/paas/v4/chat/completions',
          {
            model: 'glm-4',
            messages: [
              {
                role: 'user',
                content: prompt
              }
            ],
            temperature: 0.7,
            stream: false
          },
          {
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${apiKey}`
            }
          }
        );

        if (response.data.choices && response.data.choices[0] && response.data.choices[0].message) {
          return response.data.choices[0].message.content;
        } else {
          throw new Error('智谱AI API返回错误');
        }
      },
      {
        maxRetries: 3,
        initialDelay: 1000,
        onRetry: (error, attempt, delay) => {
          console.error(`[zhipu] 第 ${attempt} 次重试，${delay}ms 后...`);
        }
      }
    );
  }

  // 通义千问API
  async callTongyi(prompt, apiKey) {
    return withRetry(
      async () => {
        const response = await axios.post(
          'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation',
          {
            model: 'qwen-turbo',
            input: {
              messages: [
                {
                  role: 'user',
                  content: prompt
                }
              ]
            },
            parameters: {
              temperature: 0.7,
              top_p: 0.8
            }
          },
          {
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${apiKey}`
            }
          }
        );

        if (response.data.output && response.data.output.text) {
          return response.data.output.text;
        } else {
          throw new Error('通义千问API返回错误');
        }
      },
      {
        maxRetries: 3,
        initialDelay: 1000,
        onRetry: (error, attempt, delay) => {
          console.error(`[tongyi] 第 ${attempt} 次重试，${delay}ms 后...`);
        }
      }
    );
  }

  // 构建提示词（用于审计和实际调用）
  buildPrompt(question, scene, conversationHistory = [], resumeContent = '') {
    let prompt = this.scenePrompts[scene];

    // 添加简历内容
    if (resumeContent && resumeContent.trim()) {
      prompt += '\n\n【候选人简历】\n' + resumeContent;
    }

    // 添加对话历史
    if (conversationHistory && conversationHistory.length > 0) {
      prompt += '\n\n【对话历史】\n';
      conversationHistory.forEach((item, index) => {
        const roleLabel = item.role === 'interviewer' ? '面试官' : item.role === 'assistant' ? '参考答案' : '用户';
        prompt += `${roleLabel}: ${item.content}\n`;
      });
    }

    prompt += '\n\n问题：' + question;

    return prompt;
  }

  // 根据场景生成答题思路
  async generateAnswer(question, scene, service, config, conversationHistory = [], resumeContent = '') {
    const prompt = this.buildPrompt(question, scene, conversationHistory, resumeContent);

    let result;
    switch (service) {
      case 'wenxin':
        result = await this.callWenxin(prompt, config.wenxinApiKey);
        break;
      case 'zhipu':
        result = await this.callZhipu(prompt, config.zhipuApiKey);
        break;
      case 'tongyi':
        result = await this.callTongyi(prompt, config.tongyiApiKey);
        break;
      default:
        throw new Error('未知的AI服务');
    }

    return result;
  }
}

module.exports = new AIService();
