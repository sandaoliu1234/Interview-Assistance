/**
 * services/mockInterviewAgents.js
 * ------------------------------------------------------------
 * 模拟面试（Mock Interview）多 Agent 拆分模块：
 *   1) QuestionAgent  出题 Agent：基于面试类型 + 职位/行业 + JD + 简历 + 语言 + 当前问答历史，
 *      决定下一道题（行为 / 技术 / 算法 / 压力），含题目提示、考察点、期望回答结构。
 *   2) FollowUpAgent  追问 Agent：基于候选人回答质量，判断是否需要追问（澄清/深度/纠正错误），
 *      返回 {needFollowup:boolean, question?:string, reason?:string}。
 *   3) FeedbackAgent  点评 Agent：对当前题目+回答给分（0-10）、亮点、不足、改进建议。
 *   4) ReviewAgent    复盘 Agent：整场合并后输出 Markdown 复盘报告。
 *   5) MockInterviewOrchestrator 编排器：把 4 个 Agent 按回合串起来，供 localHttpServer 调用。
 *
 * 所有 Agent 都通过 aiService.chat(prompt, config, tier) 调用 LLM，保持"轻量拆分 + 共享密钥/模型档位"。
 * 不产生任何测试文件；不引入模拟数据。
 * ------------------------------------------------------------
 */

// ============================================================
// 1. QuestionAgent：决定下一道面试题
// ============================================================
class QuestionAgent {
  constructor(aiService) {
    // aiService 是 services/aiService.js 的实例，提供 chat(prompt,cfg,tier)
    this.ai = aiService;
  }

  /**
   * 生成下一道题目
   * @param {Object} params
   * @param {'behavior'|'tech'|'coding'|'stress'|'technical'|'programming'|'comprehensive'} params.type    面试类型
   * @param {string} params.targetPosition    目标职位
   * @param {string} params.industry          行业/领域
   * @param {string} [params.jdText]          JD 文本（可为空）
   * @param {string} [params.resumeText]      简历文本（可为空）
   * @param {'zh'|'en'} [params.language]     面试语言
   * @param {number} params.questionIndex     第几个题目（从 1 开始）
   * @param {number} params.totalQuestions    总题数
   * @param {Array<{question:string,answer:string,score?:number,followups?:Array<{q:string,a:string}>}>} params.history 历史问答
   * @param {Object} params.config            用户配置（selectedService、密钥、模型档位）
   * @returns {Promise<{question:string, focus:string, expected:string}>}
   */
  async nextQuestion({ type, targetPosition, industry, jdText, resumeText, language = 'zh',
    questionIndex, totalQuestions, history, config }) {
    // 类型归一化：UI 端（HireMe）常见写法 technical→tech、programming→coding、comprehensive→behavior(兼顾STAR+压力小问)
    const rawType = String(type || '').toLowerCase();
    const NORMALIZE_MAP = {
      behavior: 'behavior',
      tech: 'tech',
      technical: 'tech',
      coding: 'coding',
      programming: 'coding',
      stress: 'stress',
      comprehensive: 'behavior'   // 综合面试用行为题打底
    };
    const normType = NORMALIZE_MAP[rawType] || 'behavior';
    // 拼 prompt：尽量结构化，让 LLM 输出 JSON 便于解析，失败回退整串当 question
    const lang = language === 'en' ? 'English' : '简体中文';
    const TYPE_LABEL = {
      behavior: '行为面试',
      tech: '技术面试',
      coding: '算法/编程面试',
      stress: '压力面试'
    };
    const typeCN = TYPE_LABEL[normType] || '综合面试';
    const progress = `（第 ${questionIndex} 题，共 ${totalQuestions} 题）`;

    let historyBlock = '';
    if (Array.isArray(history) && history.length) {
      historyBlock = `
--- 已完成问答历史（用于避免重复出题，并形成追问式连续对话）---
${history.map((h, i) => {
        const lines = [
          `【题目 ${i + 1}】${h.question || ''}`,
          `【候选人回答】${(h.answer || '').slice(0, 600)}${(h.answer || '').length > 600 ? '（已截断）' : ''}`
        ];
        if (h.followups && h.followups.length) {
          h.followups.forEach((f, k) => lines.push(`【追问 ${i + 1}-${k + 1}】${f.q || ''}\n【候选人回答】${(f.a || '').slice(0, 300)}`));
        }
        return lines.join('\n');
      }).join('\n\n')}
`;
    }

    const prompt = `
你是一名资深 ${typeCN} 面试官。请严格基于以下上下文输出"下一道面试题"${progress}。

【面试语言】必须使用：${lang}
【面试类型】${typeCN}（若 behavior 用 STAR / 若 tech 考察岗位核心栈 / 若 coding 给可编码题与输入输出示例 / 若 stress 给冲突、优先级、压力情景题）
【原始 UI 类型】${rawType}（仅参考：comprehensive 作为综合面试，建议 mix 行为+轻技术+压力小问的综合题）
【目标职位】${targetPosition || '未指定'}
【行业/领域】${industry || '未指定'}
【JD 描述】
${jdText ? jdText : '（无）'}
【候选人简历要点】
${resumeText ? resumeText : '（无）'}
${historyBlock}

【输出要求】严格只输出 JSON，不要 markdown，不要任何额外解释。字段：
{
  "question": "面试题目正文（语言=${lang}）",
  "focus": "本问题考察点（用 1-3 个短语说明，${lang}）",
  "expected": "面试官期望的回答结构 / 关键点（${lang}，不超过 3 条要点）"
}
`.trim();

    const raw = await this.ai.chat(prompt, config, 'advanced');
    return this._parseQuestionJSON(raw, { progress, lang });
  }

  // 解析 QuestionAgent 的 JSON 输出，失败时回退：整串作为 question
  _parseQuestionJSON(raw, fallback) {
    try {
      // 1) 直接尝试 parse
      let s = String(raw || '').trim();
      // 2) 去掉 ```json ... ```
      const m1 = s.match(/```(?:json)?([\s\S]*?)```/i);
      if (m1) s = m1[1].trim();
      // 3) 取首尾 {}
      const m2 = s.match(/\{[\s\S]*\}/);
      if (m2) s = m2[0];
      const obj = JSON.parse(s);
      return {
        question: String(obj.question || raw || `请继续下一题 ${fallback.progress || ''}`).trim(),
        focus: String(obj.focus || '综合考察').trim(),
        expected: String(obj.expected || '结构化回答 + 1~2 个实例').trim()
      };
    } catch (_) {
      return {
        question: String(raw || `请继续下一题 ${fallback.progress || ''}`).trim(),
        focus: '综合考察',
        expected: `用 ${fallback.lang} 结构化回答`
      };
    }
  }
}

// ============================================================
// 2. FollowUpAgent：判断是否需要追问
// ============================================================
class FollowUpAgent {
  constructor(aiService) {
    this.ai = aiService;
  }

  /**
   * 基于本轮答题判断是否追问
   * @param {Object} params
   * @param {'behavior'|'tech'|'coding'|'stress'} params.type
   * @param {string} params.question          当前题
   * @param {string} params.answer            候选人答案
   * @param {string} [params.resumeText]
   * @param {string} [params.jdText]
   * @param {'zh'|'en'} [params.language]
   * @param {number} params.currentFollowups  已追问次数（>=阈值时强制不再追问，避免死循环）
   * @param {number} [params.maxFollowups=2]  单题最多追问次数
   * @param {Object} params.config
   * @returns {Promise<{needFollowup:boolean, question?:string, reason?:string}>}
   */
  async decide({ type, question, answer, resumeText, jdText, language = 'zh',
    currentFollowups = 0, maxFollowups = 2, config }) {
    // 先做硬阈值：超过最大追问次数直接不再追问
    if (currentFollowups >= maxFollowups) {
      return { needFollowup: false, reason: `已达到单题最大追问次数(${maxFollowups})` };
    }
    // 回答过短时不追问，否则 LLM 会每次都追
    if (!answer || String(answer).trim().length < 10) {
      return { needFollowup: false, reason: '回答过短，直接进入点评' };
    }
    const lang = language === 'en' ? 'English' : '简体中文';
    const prompt = `
你是一名资深面试官。请判断当前回答是否需要"追问"（clarify / deep dive / 指出明显错误后让其修正）。

【面试类型】${type}
【语言】${lang}
【题目】${question}
【候选人回答】
${answer}
【JD】${jdText ? jdText : '（无）'}
【简历】${resumeText ? resumeText.slice(0, 800) : '（无）'}
【历史追问次数】${currentFollowups} / 最多 ${maxFollowups}

【判断标准】
- 明显缺 STAR 中的情境/动作/结果、或技术答案漏掉关键考点、或回答有事实错误 => needFollowup=true
- 回答基本完整、结构清晰 => needFollowup=false
- 严禁为了追问而追问，追问必须能明确提高回答质量

【输出要求】严格只输出 JSON，不要 markdown，不要任何额外解释。字段：
{
  "needFollowup": true|false,
  "question": "若为 true，则给一道追问题（语言=${lang}）；否则留空字符串",
  "reason": "为什么要追问/不追问（${lang}，一句话）"
}
`.trim();
    const raw = await this.ai.chat(prompt, config, 'standard');
    try {
      let s = String(raw || '').trim();
      const m1 = s.match(/```(?:json)?([\s\S]*?)```/i); if (m1) s = m1[1].trim();
      const m2 = s.match(/\{[\s\S]*\}/); if (m2) s = m2[0];
      const obj = JSON.parse(s);
      const need = !!obj.needFollowup;
      const q = String(obj.question || '').trim();
      return {
        needFollowup: need && !!q, // 没有追问题也视为不追问
        question: q,
        reason: String(obj.reason || (need ? '需要进一步澄清' : '回答基本完整')).trim()
      };
    } catch (_) {
      return { needFollowup: false, reason: '追问 Agent 解析失败，跳过追问' };
    }
  }
}

// ============================================================
// 3. FeedbackAgent：对单题进行点评 + 给分(0-10)
// ============================================================
class FeedbackAgent {
  constructor(aiService) {
    this.ai = aiService;
  }

  /**
   * @param {Object} p
   * @param {string} p.question
   * @param {string} p.answer
   * @param {Array<{q:string,a:string}>} [p.followups]
   * @param {'behavior'|'tech'|'coding'|'stress'} [p.type]
   * @param {'zh'|'en'} [p.language]
   * @param {Object} p.config
   * @returns {Promise<{score:number, highlights:string, improvements:string, summary:string}>}
   */
  async evaluate({ question, answer, followups = [], type = 'behavior', language = 'zh', config }) {
    const lang = language === 'en' ? 'English' : '简体中文';
    const fuBlock = followups && followups.length
      ? followups.map((f, i) => `【追问${i + 1}】${f.q}\n【回答${i + 1}】${f.a}`).join('\n\n')
      : '（无追问）';

    const prompt = `
你是一名资深面试官。请对以下回答打分并给出点评，语言使用：${lang}。

【面试类型】${type}
【题目】${question}
【候选人回答】
${answer}
【追问回合】
${fuBlock}

【打分规则】
- score: 0-10 整数
  - 9-10：结构完整、重点命中、语言精准、可直接作为示范答案
  - 7-8：回答良好、仅有少量细节可补
  - 5-6：有基本方向、但缺关键要点或逻辑不清
  - 0-4：答非所问、有明显事实错误、或回答极不完整
- highlights：亮点（2~3 条，${lang}）
- improvements：需要改进（2~3 条，${lang}）
- summary：一句话总结（${lang}）

【输出要求】严格只输出 JSON，不要 markdown，不要任何额外解释。字段：
{ "score": 7, "highlights": "...", "improvements": "...", "summary": "..." }
`.trim();
    const raw = await this.ai.chat(prompt, config, 'standard');
    try {
      let s = String(raw || '').trim();
      const m1 = s.match(/```(?:json)?([\s\S]*?)```/i); if (m1) s = m1[1].trim();
      const m2 = s.match(/\{[\s\S]*\}/); if (m2) s = m2[0];
      const obj = JSON.parse(s);
      const score = Math.max(0, Math.min(10, Number(obj.score) || 0));
      return {
        score,
        highlights: String(obj.highlights || '').trim() || '—',
        improvements: String(obj.improvements || '').trim() || '—',
        summary: String(obj.summary || '').trim() || '（未生成总结）'
      };
    } catch (_) {
      // 解析失败：保底给 6 分，把原文当 summary，避免流程中断
      return {
        score: 6,
        highlights: '—',
        improvements: '解析失败，请人工查看模型原始输出。',
        summary: String(raw || '（点评失败）').slice(0, 300)
      };
    }
  }
}

// ============================================================
// 4. ReviewAgent：整场复盘（复用 aiService.buildReviewPrompt）
// ============================================================
class ReviewAgent {
  constructor(aiService) {
    this.ai = aiService;
  }

  /**
   * @param {Array<{question:string,answer:string,followups?:any,score?:number,feedback?:any}>} history
   * @param {Object} config
   * @returns {Promise<string>} Markdown 复盘报告
   */
  async report(history, config) {
    // 先把 followups 也展开进 history 里，让复盘更完整
    const flat = (history || []).map(h => {
      const lines = [h.answer || ''];
      if (Array.isArray(h.followups)) h.followups.forEach(f => lines.push(`（追问：${f.q || ''}）${f.a || ''}`));
      return { question: h.question || '', answer: lines.join('\n\n') };
    });
    const prompt = this.ai.buildReviewPrompt(flat);
    // 复盘用更高档模型（advanced）
    return await this.ai.chat(prompt, config, 'advanced');
  }
}

// ============================================================
// 5. MockInterviewOrchestrator：对外暴露的回合编排器
//    - startRound(...)   产出当前回合题
//    - submitAnswer(...) 产出 {feedback, followup?}，若 followup 则进入追问
//    - submitFollowupAnswer(...) 收回追问答案，继续/结束该回合
//    - finalReview(...)  整场复盘
// ============================================================
class MockInterviewOrchestrator {
  constructor(aiService) {
    this.questionAgent = new QuestionAgent(aiService);
    this.followupAgent = new FollowUpAgent(aiService);
    this.feedbackAgent = new FeedbackAgent(aiService);
    this.reviewAgent = new ReviewAgent(aiService);
  }

  /** 生成当前回合（题目） */
  generateQuestion(ctx) { return this.questionAgent.nextQuestion(ctx); }

  /**
   * 把前端/UI 给出的 type 规范成后端路由 & QuestionAgent 都能接受的 4 大类：
   *   behavior/tech/coding/stress
   * 输入允许 technical→tech、programming→coding、comprehensive→behavior
   * @param {string} type
   * @returns {'behavior'|'tech'|'coding'|'stress'}
   */
  normalizeType(type) {
    const raw = String(type || '').toLowerCase();
    if (raw === 'tech' || raw === 'technical') return 'tech';
    if (raw === 'coding' || raw === 'programming') return 'coding';
    if (raw === 'stress') return 'stress';
    return 'behavior';
  }

  /** 提交候选人对主问题的回答，返回点评 + 是否要追问 */
  async submitAnswer(params) {
    const { type, question, answer, resumeText, jdText, language,
      followups = [], maxFollowups = 2, config } = params;
    // 先点评
    const feedback = await this.feedbackAgent.evaluate({
      question, answer, followups, type, language, config
    });
    // 再决定是否追问
    const followup = await this.followupAgent.decide({
      type, question, answer, resumeText, jdText, language,
      currentFollowups: followups.length, maxFollowups, config
    });
    return { feedback, followup };
  }

  /** 提交候选人对"追问"的回答：把本轮 followups 累加后重新走点评 + 是否继续追问 */
  async submitFollowupAnswer(params) {
    const { type, question, answer, resumeText, jdText, language,
      followups = [], lastFollowupQuestion, lastFollowupAnswer, maxFollowups = 2, config } = params;
    const fu = [...followups, { q: lastFollowupQuestion, a: lastFollowupAnswer }];
    const feedback = await this.feedbackAgent.evaluate({
      question, answer, followups: fu, type, language, config
    });
    const followup = await this.followupAgent.decide({
      type, question, answer, resumeText, jdText, language,
      currentFollowups: fu.length, maxFollowups, config
    });
    return { feedback, followup, followups: fu };
  }

  /** 整场复盘 */
  finalReview(history, config) { return this.reviewAgent.report(history, config); }
}

module.exports = {
  QuestionAgent,
  FollowUpAgent,
  FeedbackAgent,
  ReviewAgent,
  MockInterviewOrchestrator
};
