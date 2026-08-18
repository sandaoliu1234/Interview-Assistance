/**
 * 面试助手统一配置模型（对应 HireMe Copilot 页面的全部表单字段）。
 * 集中定义默认配置、字段说明与旧版配置迁移逻辑。
 *
 * 安全约定：本文件【不写死任何密钥】。所有 API Key 必须由用户
 * 在设置面板填写，或从环境变量（运行时注入）读取。
 */

/**
 * 回答字数档位 -> 目标字数（用于 prompt 约束与 max_tokens 估算）。
 */
const ANSWER_LENGTH_MAP = {
  short: 100,     // 简洁：约 100 字
  standard: 200,  // 标准：约 200 字
  detailed: 400   // 详细：约 400 字
};

/**
 * 模型档位 -> 模型标识。
 */
const MODEL_TIERS = {
  standard:   { label: '标准', model: 'qwen-turbo' },
  advanced:   { label: '进阶', model: 'qwen-plus' },
  deep:       { label: '深度', model: 'qwen-max' },
  programming:{ label: '编程', model: 'deepseek-coder' }
};

/**
 * 面试类型 -> 场景提示词标签。
 */
const INTERVIEW_TYPES = {
  comprehensive: '综合面试',
  behavior:      '行为面试',
  technical:     '技术面试',
  programming:   '编程面试'
};

/**
 * AI 自定义指令风格 -> 描述（用于拼装 system prompt）。
 */
const INSTRUCTION_STYLES = {
  oral:       '口语化、像真人临场作答',
  concise:    '简洁精炼、直击要点',
  technical:  '技术深度、含关键技术点',
  achievement:'突出个人成果与量化贡献'
};

/**
 * 生成一套干净的默认配置。
 * 注意：所有密钥字段均为空字符串，必须由用户或环境变量注入。
 * @returns {Object} 默认配置对象
 */
function defaultInterviewConfig() {
  return {
    // ===== 面试类型 =====
    type: 'behavior',                 // comprehensive | behavior | technical | programming

    // ===== 简历 & 知识库 =====
    resumeText: '',                  // 纯文本简历（由 PDF/DOCX 解析后写入）
    resumeFilePath: null,            // 最近一次导入的简历路径
    knowledgeBase: '',               // 话术 / FAQ / 公司资料等补充材料

    // ===== AI 自定义指令 & 热词 =====
    instructionStyle: 'oral',        // oral | concise | technical | achievement
    customInstruction: '',           // 用户自定义 system prompt 片段
    hotWords: [],                    // ASR 热词表，提高专名识别准确率

    // ===== 目标岗位 =====
    targetCompany: '',               // 目标公司
    targetPosition: '',              // 目标职位
    jobDescription: '',              // JD 文本

    // ===== 音频采集 =====
    audioMode: 'system',             // system | microphone | mixed
    realtimeMode: 'websocket',       // websocket（低延迟） | rest（兜底）

    // ===== 视线检测（对齐 HireMe gaze；默认关闭，启用需摄像头权限）=====
    gazeEnabled: false,              // 是否启用「无人脸自动隐藏 overlay」

    // ===== 回答 & 模型 =====
    answerLength: 'standard',        // short | standard | detailed
    modelTier: 'standard',           // standard | advanced | deep | programming
    cutoffMode: 'auto',              // auto（AI 判断） | manual（快捷键触发）

    // ===== 视觉（多模态）模型（截图解题 / H5 / 小程序截图题目识别用）=====
    //   通义：qvq-plus（qwen-vl-plus 已于近期下线，qvq-plus 是其新一代替代模型，效果更优、延迟更低）
    //        可选 qvq-plus / qvq-max / qwen-vl-max（老模型兼容）
    tongyiVisionModel: 'qvq-plus',
    //   智谱：glm-4v-flash / glm-4v-plus / glm-4v（默认 glm-4v）
    zhipuVisionModel: 'glm-4v',

    // ===== 窗口 & 快捷键（兼容旧版） =====
    alwaysOnTop: true,
    windowOpacity: 0.95,
    windowWidth: 400,
    windowHeight: 600,
    hotkey: 'CommandOrControl+Shift+H',

    // ===== 兼容旧版 ASR/LLM 字段（密钥一律为空，需用户填写或通过 env 注入） =====
    baiduAppId: '',
    baiduApiKey: '',
    baiduSecretKey: '',
    wenxinApiKey: '',
    zhipuApiKey: '',
    tongyiApiKey: '',
    // 通义千问自定义 BaseURL：
    //   公共版默认：https://dashscope.aliyuncs.com/api/v1
    //   百炼私有工作空间：从 CSV 的 dashScope 字段复制（例：https://llm-xxx.cn-beijing.maas.aliyuncs.com/api/v1）
    tongyiBaseUrl: 'https://dashscope.aliyuncs.com/api/v1',
    selectedService: 'tongyi',       // wenxin | zhipu | tongyi

    // ===== 兼容旧版字段（主进程 generateAnswer / 设置面板依赖） =====
    interviewScene: 'behavior',      // behavioral | technical | coding（由 type 映射）
    detectionSensitivity: 5,         // 问题检测灵敏度 1-10
    processingInterval: 3000,        // 音频处理间隔（ms）
    audioBoost: 50,                  // 音频增益倍数
    autoSaveHistory: true
  };
}

/**
 * 将旧版 config.json 字段迁移到新的统一配置模型。
 * 关键：旧版默认值里写死的密钥（baiduAppId/baiduApiKey/tongyiApiKey 等）
 * 一律丢弃，不继承到新模型，避免把泄露密钥带入新结构。
 * @param {Object} old 旧版配置对象
 * @returns {Object} 迁移后的新配置
 */
function migrateLegacyConfig(old) {
  if (!old || typeof old !== 'object') {
    return defaultInterviewConfig();
  }
  const merged = defaultInterviewConfig();

  // 只迁移「语义仍然有效、且非密钥」的字段，避免泄露密钥被保留
  const safeCopy = [
    'type', 'interviewScene', 'instructionStyle', 'customInstruction',
    'targetCompany', 'targetPosition', 'jobDescription', 'knowledgeBase',
    'audioMode', 'realtimeMode', 'gazeEnabled', 'answerLength', 'modelTier', 'cutoffMode',
    'alwaysOnTop', 'windowOpacity', 'windowWidth', 'windowHeight', 'hotkey',
    'selectedService', 'resumeText', 'resumeFilePath', 'hotWords',
    'detectionSensitivity', 'processingInterval', 'audioBoost', 'autoSaveHistory',
    'tongyiBaseUrl',
    'tongyiVisionModel', 'zhipuVisionModel'   // 视觉模型选择（qvq-plus / qvq-max / glm-4v 等）
  ];
  for (const key of safeCopy) {
    if (old[key] !== undefined && old[key] !== null && old[key] !== '') {
      merged[key] = old[key];
    }
  }

  // 旧版的 interviewScene（behavioral/technical/coding）映射到新版的 type
  if (old.interviewScene && !old.type) {
    const sceneMap = { behavioral: 'behavior', technical: 'technical', coding: 'programming' };
    if (sceneMap[old.interviewScene]) {
      merged.type = sceneMap[old.interviewScene];
    }
  }

  // 反向映射：由新版 type 推导 interviewScene（主进程 generateAnswer 依赖该字段）
  if (!merged.interviewScene || merged.interviewScene === 'behavior') {
    const typeToScene = { behavior: 'behavioral', technical: 'technical', programming: 'coding', comprehensive: 'behavioral' };
    if (typeToScene[merged.type]) {
      merged.interviewScene = typeToScene[merged.type];
    }
  }

  // 旧版热词可能是逗号分隔字符串，统一转成数组
  if (typeof merged.hotWords === 'string') {
    merged.hotWords = merged.hotWords.split(',').map(s => s.trim()).filter(Boolean);
  }
  if (!Array.isArray(merged.hotWords)) {
    merged.hotWords = [];
  }

  return merged;
}

module.exports = {
  ANSWER_LENGTH_MAP,
  MODEL_TIERS,
  INTERVIEW_TYPES,
  INSTRUCTION_STYLES,
  defaultInterviewConfig,
  migrateLegacyConfig
};
