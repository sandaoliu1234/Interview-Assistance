const axios = require('axios');
const { withRetry } = require('../utils/retry');
const { PrivacyAudit } = require('./privacyAudit');

// ============================================================
// 通用工具：URL / 字符串 防御性清理
//   场景：用户从 Markdown/文档 复制 URL 时，常附带 `..."..."` / '...' 包裹；
//        config.json 里也可能残留了之前操作时带的包裹字符。
//        这里在「发送 HTTP 请求前」再清一次，作为最后一道防线。
//   反引号字符使用 \x60（十六进制 ASCII 码 96），绝对避免与 JS 模板字符串的 ` 冲突。
//   额外覆盖：全角引号 『』「】【】（）《》、弯引号 “”‘’、全角 `｀`(U+FF40) 等
// ============================================================
function _cleanUrl(u) {
  if (typeof u !== 'string') return '';
  let x = u;
  // 字符类中包含的包裹字符：
  //   \s          - ASCII 空白
  //   \u3000      - 全角空格（ideographic space）
  //   \x60        - ASCII 反引号 `
  //   \uFF40      - 全角反引号 ｀
  //   ' "         - ASCII 单/双引号
  //   \u201C\u201D - 弯双引号 “ ”
  //   \u2018\u2019 - 弯单引号 ‘ ’
  //   \u300C\u300D - 日文角括号 「 」
  //   \u300E\u300F - 日文白角括号 『 』
  //   \u3010\u3011 - 全角方头括号 【 】
  //   \uFF08\uFF09 - 全角圆括号 （ ）
  //   \u300A\u300B - 书名号 《 》
  const WRAP = '\\s\\u3000\\x60\\uFF40\'"\\u201C\\u201D\\u2018\\u2019\\u300C\\u300D\\u300E\\u300F\\u3010\\u3011\\uFF08\\uFF09\\u300A\\u300B';
  const reHead = new RegExp('^[' + WRAP + ']+');
  const reTail = new RegExp('[' + WRAP + ']+$');
  // 最多 12 轮：清理首尾包裹字符 + 去掉尾部斜杠
  for (let i = 0; i < 12; i++) {
    const before = x;
    x = x.replace(reHead, '').replace(reTail, '').replace(/\/+$/, '');
    if (x === before) break;
  }
  return x;
}
// 字符串（非 URL）防御性清理：只去首尾包裹字符，不删 /
function _cleanStr(s) {
  if (typeof s !== 'string') return '';
  let x = s;
  const WRAP = '\\s\\u3000\\x60\\uFF40\'"\\u201C\\u201D\\u2018\\u2019\\u300C\\u300D\\u300E\\u300F\\u3010\\u3011\\uFF08\\uFF09\\u300A\\u300B';
  const reHead = new RegExp('^[' + WRAP + ']+');
  const reTail = new RegExp('[' + WRAP + ']+$');
  for (let i = 0; i < 12; i++) {
    const before = x;
    x = x.replace(reHead, '').replace(reTail, '');
    if (x === before) break;
  }
  return x;
}

// ============================================================
// 通用工具：从 OpenAI 兼容响应的 message.content 中提取纯文本
//   兼容格式：
//     (a) 字符串  —— 直接返回
//     (b) 数组 [{type:"text", text:"..."}, ...]  —— 拼接所有 text 字段
//     (c) 数组 [{type:"text", content:"..."}, ...]  —— 兼容 content 字段
//   若提取结果为空，返回空字符串，调用方负责打日志抛错
// ============================================================
function _extractChatContent(content, _debugTag) {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((seg) => {
      if (!seg || typeof seg !== 'object') return '';
      const t = seg.text || seg.content || '';
      return typeof t === 'string' ? t : String(t || '');
    }).join('');
  }
  // 兜底：其他对象转字符串
  try {
    return String(content);
  } catch (_) {
    return '';
  }
}

// ============================================================
// 通用工具：消费 OpenAI 兼容的 SSE 流式响应
//   背景：qvq-plus / qwen3 等"深度思考模型"在百炼必须流式调用（stream:true）——
//         非流式时思考内容被丢弃、content 返回空字符串
//         （实测 rawData：completion_tokens=1447 但 choices[0].message.content=""）
//   解析规则：逐行读取 "data: {...}" 事件直到 [DONE]；拼接 delta.content（最终答案）
//         与 delta.reasoning_content（思考过程，作为 content 为空时的兜底）
//   返回：{ content, reasoning, errMsg }
// ============================================================
function _consumeSseStream(stream) {
  return new Promise((resolve, reject) => {
    let buf = '';        // 跨 chunk 的半行缓冲
    let content = '';    // 最终答案（delta.content 拼接）
    let reasoning = '';  // 思考过程（delta.reasoning_content 拼接）
    let errMsg = '';     // 流中携带的错误信息（百炼会把 {"error":{...}} 作为事件下发）
    // 处理单个 SSE 行：只认 data: 前缀，忽略 event:/id:/注释行
    const handleLine = (line) => {
      const s = String(line || '').replace(/\r$/, '');
      if (!s.startsWith('data:')) return;
      const payload = s.slice(5).trim();
      if (!payload || payload === '[DONE]') return; // 空事件 / 流结束标记
      try {
        const j = JSON.parse(payload);
        if (j && j.error) errMsg = (typeof j.error === 'object') ? JSON.stringify(j.error) : String(j.error);
        const delta = j && j.choices && j.choices[0] && j.choices[0].delta;
        if (delta) {
          if (typeof delta.content === 'string') content += delta.content;
          if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
        }
      } catch (_) { /* 半包/非 JSON 行：留在缓冲等下一个 chunk 拼完整，忽略 */ }
    };
    stream.on('data', (chunk) => {
      // chunk 可能是 Buffer 或 string，统一转 utf8 字符串追加到缓冲
      buf += (typeof chunk === 'string') ? chunk : chunk.toString('utf8');
      let idx;
      // 按换行切分：SSE 每个事件行独立完整，剩余半行留在 buf 等下一个 chunk
      while ((idx = buf.indexOf('\n')) >= 0) {
        handleLine(buf.slice(0, idx));
        buf = buf.slice(idx + 1);
      }
    });
    stream.on('end', () => resolve({ content, reasoning, errMsg }));
    stream.on('error', reject);
  });
}

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

  // 文心一言API（支持按 modelTier 选择模型：3.5 / 4.0）
  async callWenxin(prompt, apiKey, model = 'ernie-4.0-8k') {
    return withRetry(
      async () => {
        // 4.0 走 completions_pro 专属端点；3.5 走通用 chat/completions 并带 model 字段
        const isV4 = String(model).includes('4.0');
        const url = isV4
          ? 'https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop/chat/completions_pro'
          : 'https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop/chat/completions';
        // 请求体：3.5 需要显式传 model，4.0 由端点决定无需传
        const body = {
          messages: [
            {
              role: 'user',
              content: prompt
            }
          ],
          temperature: 0.7,
          top_p: 0.8,
          penalty_score: 1.0
        };
        if (!isV4) body.model = model;
        const response = await axios.post(
          url,
          body,
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

  // 智谱AI API（支持 modelTier 选择模型：glm-4-flash / air / plus）
  async callZhipu(prompt, apiKey, model = 'glm-4') {
    return withRetry(
      async () => {
        const response = await axios.post(
          'https://open.bigmodel.cn/api/paas/v4/chat/completions',
          {
            model: model,
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

  // 通义千问API（支持 modelTier 选择模型：qwen-turbo / plus / max）
  // @param {string} prompt           提问词
  // @param {string} apiKey           通义 / 百炼 API Key
  // @param {string} model            模型名（qwen-turbo / qwen-plus / qwen-max / deepseek-coder 等）
  // @param {string} [baseUrl]        自定义 BaseURL：
  //                                     默认公共版 'https://dashscope.aliyuncs.com/api/v1'，
  //                                     百炼私有空间形如 'https://llm-xxx.cn-beijing.maas.aliyuncs.com/api/v1'
  //                                     （注：百炼私有空间走 OpenAI 兼容接口，公共版走 DashScope 原生接口，二者完全不同！）
  async callTongyi(prompt, apiKey, model = 'qwen-turbo', baseUrl) {
    // 1) 参数防御性清理：最后一道关口，去掉首尾包裹字符（反引号/单引号/双引号/全角空格/半角空格）
    //    原因：用户从 Markdown/CSV/我的日志里复制粘贴时，常带上 `https://...` 或 "https://..." 格式
    const key = _cleanStr(apiKey);
    // 2) 统一去掉尾部斜杠，并使用 _cleanUrl 做 URL 专用清理（去包裹+去尾斜杠）
    const base = _cleanUrl(baseUrl || 'https://dashscope.aliyuncs.com/api/v1') || 'https://dashscope.aliyuncs.com/api/v1';
    // 【关键路由】判断是否是百炼私有工作空间（域名包含 maas.aliyuncs.com 则为百炼私有 MaaS）
    //   百炼私有空间：必须走 CSV 中 openAiCompatible 字段给出的「兼容模式端点」/compatible-mode/v1/chat/completions
    //     1) 若用户填的是 dashScope 字段（/api/v1 结尾）→ 自动替换为 /compatible-mode/v1
    //     2) 若用户填的是 openAiCompatible 字段（已带 /compatible-mode/v1）→ 直接使用
    //   公共 DashScope：走原生 POST /services/aigc/text-generation/generation
    const isBailianPrivate = /maas\.aliyuncs\.com/i.test(base);
    const bailianCompatibleBase = isBailianPrivate
      ? _cleanUrl(base.replace(/\/api\/v1$/i, '/compatible-mode/v1'))
      : base;
    const authHeader = `Bearer ${key}`;
    console.log(`[callTongyi] 路由判定：baseUrl=${JSON.stringify(base)} → ${isBailianPrivate ? '百炼私有空间(OpenAI兼容)' : '公共DashScope(原生)'} | ${isBailianPrivate ? ('兼容端点=' + JSON.stringify(bailianCompatibleBase)) : ('原生端点头尾')} | model=${model}`);
    return withRetry(
      async () => {
        if (isBailianPrivate) {
          // 百炼私有空间：OpenAI 兼容模式（/compatible-mode/v1/chat/completions，CSV openAiCompatible 字段）
          const url = `${bailianCompatibleBase}/chat/completions`;
          const response = await axios.post(
            url,
            {
              model: model,
              messages: [{ role: 'user', content: prompt }],
              temperature: 0.7,
              top_p: 0.8,
              stream: false
            },
            { headers: { 'Content-Type': 'application/json', 'Authorization': authHeader } }
          );
          const rawData = response.data;
          const choices = rawData && rawData.choices;
          if (choices && choices[0] && choices[0].message) {
            // 【answerLen=0 诊断】百炼兼容端点的 content 可能是数组 [{text:"..."},...] 或字符串
            const msgObj = choices[0].message;
            const answer = _extractChatContent(msgObj.content);
            if (!answer) {
              // 内容为空时，打印完整响应体便于定位（可能是 reasoning_content 写在其他字段、或 output 在外层）
              console.error(`[callTongyi] ❌ [百炼私有] 响应解析失败：choices[0].message 存在，但内容为空。\n  url=${url}\n  model=${model}\n  msgObj.keys=${Object.keys(msgObj).join(',')}\n  msgObj=${JSON.stringify(msgObj).substring(0, 500)}\n  rawData=${JSON.stringify(rawData).substring(0, 1500)}`);
              // 尝试从常见备选位置取值（reasoning_content / rawData.output.text 等）
              const fallback = (msgObj.reasoning_content ? String(msgObj.reasoning_content) : '')
                || (rawData && rawData.output && typeof rawData.output.text === 'string' ? rawData.output.text : '');
              if (fallback) {
                console.log(`[callTongyi] ⚠️ [百炼私有] 使用备用字段取到答案，长度=${fallback.length}。请留意模型返回格式变化。`);
                return fallback;
              }
              throw new Error(`通义千问(百炼私有, ${model})返回空内容。请检查终端日志，若 rawData 里有具体错误，按错误提示处理。`);
            }
            console.log(`[callTongyi] ✅ [百炼私有] 返回答案长度=${answer.length}`);
            return answer;
          }
          throw new Error('通义千问(百炼私有)返回错误：' + (rawData ? JSON.stringify(rawData).substring(0, 500) : '无响应体'));
        }
        // 公共 DashScope：原生 aigc/text-generation/generation 端点
        const response = await axios.post(
          `${base}/services/aigc/text-generation/generation`,
          {
            model: model,
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
              'Authorization': authHeader
            }
          }
        );

        if (response.data.output && response.data.output.text) {
          return response.data.output.text;
        } else {
          throw new Error('通义千问(DashScope公共版)API返回错误');
        }
      },
      {
        maxRetries: 3,
        initialDelay: 1000,
        onRetry: (error, attempt, delay) => {
          console.error(`[tongyi] ${isBailianPrivate ? '[百炼私有]' : '[DashScope公共]'} 第 ${attempt} 次重试，${delay}ms 后...`);
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

  // 根据服务商与档位（标准/进阶/深度/编程）映射实际模型名
  getModelByTier(service, tier) {
    // 各服务商的档位 -> 模型名映射（均为已验证的稳定模型 id）
    const map = {
      // 文心：3.5 为快速版，4.0 为最强版（callWenxin 内部按 4.0 走专属端点）
      wenxin: { standard: 'ernie-3.5-8k', advanced: 'ernie-3.5-8k', deep: 'ernie-4.0-8k', programming: 'ernie-4.0-8k' },
      // 智谱：flash 最快、air 均衡、plus 最强
      zhipu:  { standard: 'glm-4-flash',  advanced: 'glm-4-air',   deep: 'glm-4-plus',   programming: 'glm-4-plus' },
      // 通义：turbo 最快、plus 均衡、max 最强
      tongyi: { standard: 'qwen-turbo',   advanced: 'qwen-plus',   deep: 'qwen-max',      programming: 'qwen-max' }
    };
    const byService = map[service];
    if (!byService) return 'qwen-turbo';
    return byService[tier] || byService.standard;
  }

  // 根据场景 + 模型档位生成答题思路
  // @param {string} modelTier 模型档位（standard/advanced/deep/programming）
  // @param {boolean} applyTierScene 是否允许「编程档位」自动切换到 coding 场景提示词（简历优化等自定义提示词传 false）
  async generateAnswer(question, scene, service, config = {}, conversationHistory = [], resumeContent = '', modelTier, applyTierScene = true) {
    // 解析档位：优先用显式传入值，否则取配置里的 modelTier
    const tier = modelTier || (config && config.modelTier) || 'standard';
    // 编程档位：改用编程场景提示词，更贴合代码题
    const effScene = (applyTierScene && tier === 'programming') ? 'coding' : scene;
    const prompt = this.buildPrompt(question, effScene, conversationHistory, resumeContent);

    // 按档位映射具体模型
    const model = this.getModelByTier(service, tier);

    let result;
    switch (service) {
      case 'wenxin':
        result = await this.callWenxin(prompt, config.wenxinApiKey, model);
        break;
      case 'zhipu':
        result = await this.callZhipu(prompt, config.zhipuApiKey, model);
        break;
      case 'tongyi':
        result = await this.callTongyi(prompt, config.tongyiApiKey, model, config.tongyiBaseUrl);
        break;
      default:
        throw new Error('未知的AI服务');
    }

    return result;
  }

  // 构建面试复盘 prompt：把问答记录整理成结构化文本，要求 LLM 输出复盘报告
  buildReviewPrompt(history) {
    let prompt = `你是一位资深面试教练。以下是候选人本次面试的问答记录，请生成一份详细的复盘报告，包含：

1. 整体表现评价（回答质量、表达逻辑、完整性）
2. 各问题回答的优点与不足
3. 知识盲点与需补强的领域
4. 针对性改进建议（可操作的下一步行动）

请用 Markdown 格式输出。

===== 问答记录 =====`;
    (history || []).forEach((item, i) => {
      prompt += `\n\nQ${i + 1}: ${item.question || ''}\nA${i + 1}: ${item.answer || ''}`;
    });
    return prompt;
  }

  // 生成面试复盘报告：复用各服务商调用 + 档位模型映射
  // @param {Array<{question:string,answer:string}>} history 问答历史
  // @param {string} service wenxin|zhipu|tongyi
  // @param {Object} config 含各服务商密钥
  // @param {string} modelTier 模型档位
  async generateReview(history, service, config = {}, modelTier) {
    const tier = modelTier || (config && config.modelTier) || 'standard';
    const prompt = this.buildReviewPrompt(history);
    const model = this.getModelByTier(service, tier);
    switch (service) {
      case 'wenxin':
        return await this.callWenxin(prompt, config.wenxinApiKey, model);
      case 'zhipu':
        return await this.callZhipu(prompt, config.zhipuApiKey, model);
      case 'tongyi':
        return await this.callTongyi(prompt, config.tongyiApiKey, model, config.tongyiBaseUrl);
      default:
        throw new Error('未知的AI服务');
    }
  }

  // 多模态视觉模型调用：通义 qvq / 智谱 glm-4v（文心暂未接入 VL）
  // 注意：qwen-vl-plus 已下线，通义默认使用 qvq-plus（新一代视觉推理模型，效果更优、延迟更低）
  // @param {string} prompt 文本指令
  // @param {string} imageDataUrl 图片 data URL（data:image/png;base64,...）
  // @param {string} service tongyi | zhipu
  // @param {Object} config 含密钥 + tongyiVisionModel / zhipuVisionModel
  // @param {string} model 显式指定模型名（优先级最高，覆盖 config.visionModel / 默认值）
  async callVision(prompt, imageDataUrl, service, config = {}, model) {
    if (service === 'tongyi') {
      // 通义视觉模型优先级：显式 model 参数 > config.tongyiVisionModel > 默认 qvq-plus（qwen-vl-plus 已下线）
      // 支持模型名：qvq-plus（默认，平衡效果与速度） / qvq-max（最强视觉推理） / qwen-vl-max（兼容老模型）
      const defaultVision = (config && config.tongyiVisionModel) ? _cleanStr(config.tongyiVisionModel) : 'qvq-plus';
      const md = _cleanStr(model || defaultVision) || 'qvq-plus';
      // ---- 清理前后对比日志（定位 baseUrl 仍带反引号的问题）----
      const rawBase = (config && typeof config.tongyiBaseUrl === 'string') ? config.tongyiBaseUrl : '';
      const rawKey  = (config && typeof config.tongyiApiKey === 'string')  ? config.tongyiApiKey  : '';
      // 防御性清理：最后一关去掉首尾包裹字符（反引号/单引号/双引号）—— 防止 config.json 或复制粘贴时带残留
      const tongyiKey = _cleanStr(rawKey || '');
      const base = _cleanUrl(rawBase || 'https://dashscope.aliyuncs.com/api/v1') || 'https://dashscope.aliyuncs.com/api/v1';
      // 如果清理后仍有变化，打印对比（便于用户看到确实生效了）
      if (rawBase && rawBase !== base) {
        console.log(`[callVision/tongyi] 🧹 tongyiBaseUrl 清理生效：raw=${JSON.stringify(rawBase)} → clean=${JSON.stringify(base)}`);
      }
      if (rawKey && rawKey !== tongyiKey) {
        console.log(`[callVision/tongyi] 🧹 tongyiApiKey 清理生效（首尾包裹字符已去掉）：rawLen=${rawKey.length} → cleanLen=${tongyiKey.length}`);
      }
      // 【关键路由】百炼私有工作空间走 /compatible-mode/v1/chat/completions（同 CSV openAiCompatible），公共 DashScope 走原生
      //   注意：百炼兼容模式必须用 /compatible-mode/v1 前缀，若用户填了 dashScope 字段（/api/v1 结尾）会自动替换为 compatible
      const isBailianPrivate = /maas\.aliyuncs\.com/i.test(base);
      const bailianCompatibleBase = isBailianPrivate
        ? _cleanUrl(base.replace(/\/api\/v1$/i, '/compatible-mode/v1'))
        : base;
      const authHeader = `Bearer ${tongyiKey}`;
      // 前置检查：API Key 为空时直接抛错，避免无意义的 401
      if (!tongyiKey) {
        throw new Error(`通义( ${isBailianPrivate ? '百炼私有' : 'DashScope'} ) API Key 为空，请在设置中填写 tongyiApiKey（视觉模型 ${md} 需要，qwen-vl-plus 已下线，推荐使用 qvq-plus / qvq-max）`);
      }
      console.log(`[callVision/tongyi] 路由判定：baseUrl=${JSON.stringify(base)} → ${isBailianPrivate ? '百炼私有空间(OpenAI兼容多模态)' : '公共DashScope(原生multimodal)'} | ${isBailianPrivate ? ('兼容端点=' + JSON.stringify(bailianCompatibleBase)) : ''} | model=${md}`);
      return withRetry(async () => {
        try {
          if (isBailianPrivate) {
            // 百炼私有空间：OpenAI 兼容多模态 /compatible-mode/v1/chat/completions
            // 【关键修复】qvq 系列是"深度思考模型"，百炼要求必须流式调用（stream:true）：
            //   非流式时思考内容(thinking)被丢弃、content 返回空字符串
            //   （实测：completion_tokens=1447、finish_reason=stop，但 content=""）
            //   流式下同时接收 delta.content（最终答案）与 delta.reasoning_content（思考过程）；
            //   非思考模型（qwen-vl-max 等）走流式同样兼容，无副作用。
            const url = `${bailianCompatibleBase}/chat/completions`;
            const resp = await axios.post(
              url,
              {
                model: md,
                messages: [{
                  role: 'user',
                  content: [
                    { type: 'text', text: prompt },
                    { type: 'image_url', image_url: { url: imageDataUrl } }
                  ]
                }],
                temperature: 0.5,
                stream: true // 思考模型必须流式；SSE 解析见 _consumeSseStream
              },
              { headers: { 'Content-Type': 'application/json', 'Authorization': authHeader }, responseType: 'stream' }
            );
            const { content, reasoning, errMsg } = await _consumeSseStream(resp.data);
            // 流中下发了明确错误（如额度不足/模型未开通/图片超限）→ 直接抛给上层提示用户
            if (errMsg) {
              throw new Error(`通义视觉模型(百炼私有, ${md})流式返回错误：${errMsg}`);
            }
            if (content) {
              console.log(`[callVision/tongyi] ✅ [百炼私有] 视觉返回答案长度=${content.length}（思考过程 ${reasoning.length} 字符已丢弃）`);
              return content;
            }
            // content 为空但思考过程有内容：该部署可能把最终答案也写进了思考通道，降级使用
            if (reasoning) {
              console.warn(`[callVision/tongyi] ⚠️ [百炼私有] content 为空，降级使用 reasoning_content（长度=${reasoning.length}）`);
              return reasoning;
            }
            throw new Error(`通义视觉模型(百炼私有, ${md})流式返回为空（content 与 reasoning 均为空），请确认该模型支持图片输入且账号有额度`);
          }
          // 公共 DashScope：原生 /services/aigc/multimodal-generation/generation
          const url = `${base}/services/aigc/multimodal-generation/generation`;
          const resp = await axios.post(
            url,
            {
              model: md,
              input: {
                messages: [{
                  role: 'user',
                  content: [{ image: imageDataUrl }, { text: prompt }]
                }]
              }
            },
            { headers: { 'Content-Type': 'application/json', 'Authorization': authHeader } }
          );
          // 返回结构：data.output.choices[0].message.content（数组或字符串）
          const rawData = resp.data;
          const choices = rawData && rawData.output && rawData.output.choices;
          if (choices && choices[0] && choices[0].message) {
            const c = choices[0].message.content;
            const answer = Array.isArray(c) ? c.map((x) => x.text || x.content || '').join('') : (typeof c === 'string' ? c : _extractChatContent(c));
            if (!answer) {
              console.error(`[callVision/tongyi] ❌ [DashScope公共] 视觉响应解析失败：choices[0].message 存在，但内容为空。\n  url=${url}\n  model=${md}\n  rawData=${JSON.stringify(rawData).substring(0, 2000)}`);
              throw new Error(`通义视觉模型(DashScope公共, ${md})返回空内容。请检查终端日志 rawData 字段，若有明确错误码/消息，按提示处理。`);
            }
            console.log(`[callVision/tongyi] ✅ [DashScope公共] 视觉返回答案长度=${answer.length}`);
            return answer;
          }
          throw new Error(`通义视觉模型(DashScope公共, ${md})返回错误：` + (rawData ? JSON.stringify(rawData).substring(0, 500) : '无响应体'));
        } catch (e) {
          // 【401 诊断增强】打印完整 HTTP 错误细节（DashScope/百炼 对 401/403/429 都有明确中文 code/message 写在响应体里）
          const url = isBailianPrivate ? `${bailianCompatibleBase}/chat/completions` : `${base}/services/aigc/multimodal-generation/generation`;
          const status = e && e.response && e.response.status ? e.response.status : 'no-status';
          const respBody = e && e.response && e.response.data ? e.response.data : null;
          const errMsg = (e && e.message) ? e.message : String(e);
          const authHeaderPreview = `Authorization: Bearer ${tongyiKey ? (tongyiKey.substring(0, 6) + '***') : '(空)'}`;
          // 注意：百炼分支现在是流式调用，出错时 respBody 是 stream 对象而非 JSON，直接打印无意义
          const respBodyStr = (respBody && typeof respBody.on === 'function')
            ? '(流式响应体，错误详情见上方流解析结果)'
            : (respBody ? (typeof respBody === 'string' ? respBody : JSON.stringify(respBody)) : '(无响应体)');
          console.error(`[AIService.callVision/tongyi] ${isBailianPrivate ? '[百炼私有]' : '[DashScope公共]'} 请求失败 url=${url} status=${status}\n  Header预览: ${authHeaderPreview}\n  model=${md}\n  Axios: ${errMsg}\n  响应体: ${respBodyStr}`);
          // 如果是 401/403 给出用户可读提示，避免用户只看到 401 不知道怎么修
          if (status === 401 || status === 403) {
            const detail = (respBody && typeof respBody === 'object') ? (respBody.message || respBody.msg || respBody.code || respBody.error || '') : '';
            if (isBailianPrivate) {
              throw new Error(`通义(百炼私有MaaS)视觉模型鉴权失败(HTTP${status}, model=${md})：${detail || errMsg}。请检查：1) tongyiApiKey 是否是从对应百炼工作空间「API Key管理」创建的（不是公共DashScope Key）；2) 是否已在百炼控制台给该工作空间开通 ${md} 视觉模型（qwen-vl-plus 已下线，请切换为 qvq-plus 或 qvq-max）；3) IA_TONGYI_BASE_URL 推荐填 CSV 里的 openAiCompatible 字段（/compatible-mode/v1 结尾），当前兼容端点=${bailianCompatibleBase}`);
            }
            throw new Error(`通义视觉模型(DashScope公共)鉴权失败(HTTP${status}, model=${md})：${detail || errMsg}。请检查：1) tongyiApiKey 是否正确且未过期；2) 是否已在 DashScope 控制台开通 ${md} 模型服务（qwen-vl-plus 已下线，推荐 qvq-plus / qvq-max）；3) 账号是否有剩余额度`);
          }
          throw e;
        }
      }, { maxRetries: 2, initialDelay: 1000 });
    }
    if (service === 'zhipu') {
      // 智谱视觉模型优先级：显式 model 参数 > config.zhipuVisionModel > 默认 glm-4v
      // 可选：glm-4v-flash（最快）/ glm-4v-plus（均衡）/ glm-4v（最强）
      const defaultVision = (config && config.zhipuVisionModel) ? _cleanStr(config.zhipuVisionModel) : 'glm-4v';
      const md = _cleanStr(model || defaultVision) || 'glm-4v';
      const rawZhipuKey = (config && typeof config.zhipuApiKey === 'string') ? config.zhipuApiKey : '';
      const zhipuKey = _cleanStr(rawZhipuKey || '');
      // 前置检查：API Key 为空时直接抛错
      if (!zhipuKey) {
        throw new Error(`智谱( BigModel ) API Key 为空，请在设置中填写 zhipuApiKey（视觉模型 ${md} 需要）`);
      }
      if (rawZhipuKey && rawZhipuKey !== zhipuKey) {
        console.log(`[callVision/zhipu] 🧹 zhipuApiKey 清理生效：rawLen=${rawZhipuKey.length} → cleanLen=${zhipuKey.length}`);
      }
      console.log(`[callVision/zhipu] 使用视觉模型 model=${md}`);
      return withRetry(async () => {
        try {
          const resp = await axios.post(
            'https://open.bigmodel.cn/api/paas/v4/chat/completions',
            {
              model: md,
              messages: [{
                role: 'user',
                content: [
                  { type: 'text', text: prompt },
                  { type: 'image_url', image_url: { url: imageDataUrl } }
                ]
              }],
              temperature: 0.5
            },
            { headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${zhipuKey}` } }
          );
          const rawData = resp.data;
          const choices = rawData && rawData.choices;
          if (choices && choices[0] && choices[0].message) {
            const msgObj = choices[0].message;
            const answer = _extractChatContent(msgObj.content);
            if (!answer) {
              console.error(`[callVision/zhipu] ❌ 视觉响应解析失败：choices[0].message 存在，但内容为空。\n  model=${md}\n  msgObj.keys=${Object.keys(msgObj).join(',')}\n  msgObj=${JSON.stringify(msgObj).substring(0, 500)}\n  rawData=${JSON.stringify(rawData).substring(0, 2000)}`);
              const fallback = (msgObj.reasoning_content ? String(msgObj.reasoning_content) : '');
              if (fallback) {
                console.log(`[callVision/zhipu] ⚠️ 使用备用字段(reasoning_content)取到答案，长度=${fallback.length}`);
                return fallback;
              }
              throw new Error(`智谱视觉模型(${md})返回空内容。请检查终端日志 rawData 字段：若写了错误码/消息（如余额不足、模型未开通等），请按提示处理。`);
            }
            console.log(`[callVision/zhipu] ✅ 视觉返回答案长度=${answer.length}`);
            return answer;
          }
          throw new Error(`智谱视觉模型(${md})返回错误：` + (rawData ? JSON.stringify(rawData).substring(0, 500) : '无响应体'));
        } catch (e) {
          // 【401 诊断增强】打印完整 HTTP 错误细节（智谱开放平台同样会在响应体里写明确 code/message）
          const url = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
          const status = e && e.response && e.response.status ? e.response.status : 'no-status';
          const respBody = e && e.response && e.response.data ? e.response.data : null;
          const errMsg = (e && e.message) ? e.message : String(e);
          const authHeaderPreview = `Authorization: Bearer ${zhipuKey ? (zhipuKey.substring(0, 6) + '***') : '(空)'}`;
          console.error(`[AIService.callVision/zhipu] 请求失败 url=${url} status=${status}\n  Header预览: ${authHeaderPreview}\n  model=${md}\n  Axios: ${errMsg}\n  响应体: ${respBody ? (typeof respBody === 'string' ? respBody : JSON.stringify(respBody)) : '(无响应体)'}`);
          if (status === 401 || status === 403) {
            const detail = (respBody && typeof respBody === 'object') ? (respBody.message || respBody.msg || respBody.code || '') : '';
            throw new Error(`智谱视觉模型鉴权失败(HTTP${status}, model=${md})：${detail || errMsg}。请检查：1) zhipuApiKey 是否正确(带 Bearer)且未过期；2) 是否在智谱开放平台开通 ${md} 模型；3) 账号是否有剩余额度`);
          }
          throw e;
        }
      }, { maxRetries: 2, initialDelay: 1000 });
    }
    // 文心 ERNIE-VL 接入方式不同，暂不支持
    throw new Error('当前服务商不支持视觉模型（仅通义 qvq/qwen-vl 系列 / 智谱 glm-4v 系列），请在设置中切换');
  }

  // 截图解题：把截图 + 简历/知识库上下文发给视觉模型，返回解答
  async screenshotSolve(imageDataUrl, config = {}, resumeContent = '', knowledgeBase = '') {
    const service = (config && config.selectedService) || 'tongyi';
    let prompt = `你是一位面试解题助手。请仔细观察图片中的面试题目，给出准确、完整的解答。

要求：
- 直接给出解答，清晰有条理
- 若是代码题，给出可运行代码与简要说明
- 若是设计/系统题，给出方案与关键点`;
    if (resumeContent && resumeContent.trim()) {
      prompt += '\n\n【候选人简历（用于个性化）】\n' + resumeContent;
    }
    if (knowledgeBase && knowledgeBase.trim()) {
      prompt += '\n\n【参考资料】\n' + knowledgeBase;
    }
    return await this.callVision(prompt, imageDataUrl, service, config);
  }
}

module.exports = new AIService();
