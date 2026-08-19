/**
 * services/resumeOptAgents.js
 * ------------------------------------------------------------
 * 简历优化（Resume Optimization）多 Agent 拆分模块：
 *   1) ATSScoringAgent     ATS 评分 Agent：从"可解析性、结构、动词、量化、关键词密度、长度/语法"等维度
 *      输出 0-100 分 + 每维度分数 + 可操作的改进建议（纯文本 Markdown）。
 *   2) KeywordMatchAgent   关键词匹配 Agent：从 JD 中抽取硬技能/软技能/学历/经验关键词，
 *      对比简历中的命中情况，生成【已命中/未命中/建议补入位置】列表。
 *   3) ContentOptAgent     内容优化 Agent：把简历全文逐条重写为更专业的表述（行动动词开头、
 *      量化结果、STAR/XYZ 结构），同时保留真实信息，不捏造。输出"优化后全文"+"改动要点"。
 *   4) ResumeOptPipeline   编排器：把 3 个 Agent 顺序执行（并行不安全：Keyword/Content 依赖 ATSScoring
 *      的维度判定会更好，因此串行；若后续需要可切为 ATS+关键词 并行，再 Content）。
 *
 * 所有 Agent 都通过 aiService.chat(prompt, config, tier) 调用 LLM，共享"密钥 + 模型档位"。
 * 不产生任何测试文件；不引入模拟数据。
 * ------------------------------------------------------------
 */

// 辅助：从模型输出中捕获首尾 JSON（有 ```json 包裹时优先）
function captureJSON(raw, fallback = {}) {
  try {
    let s = String(raw || '').trim();
    const m1 = s.match(/```(?:json)?([\s\S]*?)```/i);
    if (m1) s = m1[1].trim();
    const m2 = s.match(/\{[\s\S]*\}/);
    if (m2) s = m2[0];
    const obj = JSON.parse(s);
    return Object.assign({}, fallback, obj);
  } catch (_) {
    // 解析失败：把原文塞到 __raw 里供渲染层保底展示
    return Object.assign({}, fallback, { __raw: String(raw || '') });
  }
}

// ============================================================
// 1. ATS 评分 Agent
// ============================================================
class ATSScoringAgent {
  constructor(aiService) {
    this.ai = aiService;
  }

  /**
   * @param {Object} p
   * @param {string} p.resumeText  简历文本
   * @param {string} [p.jdText]    JD 文本（有则附加"与岗位匹配"维度）
   * @param {string} [p.language]  'zh'|'en'，影响输出语言与关键词语言
   * @param {Object} p.config      用户配置
   * @returns {Promise<{
   *   overall:number,
   *   dimensions:Array<{name:string, score:number, comment:string}>,
   *   suggestions:Array<string>,
   *   markdown:string
   * }>}
   */
  async score({ resumeText, jdText, language = 'zh', config }) {
    if (!resumeText || String(resumeText).trim().length < 50) {
      return this._emptyResult('简历文本过短，无法进行 ATS 评分（至少 50 字）。');
    }
    const lang = language === 'en' ? 'English' : '简体中文';
    const dimPrompt = jdText ? `、"与岗位 JD 的核心职责重合度"` : '';
    const prompt = `
你是一名资深 ATS（申请人跟踪系统）简历解析顾问。请对下面这份简历给出 0-100 的 ATS 评分，并从以下维度逐一打分：
【维度】可解析性（格式/字符/无文本框/表格）、结构与分区（个人信息/经历/技能/教育）、行动动词使用、数据化与可量化、关键词密度与相关性${dimPrompt}、长度与冗余、语法与拼写、可读性。
【输出语言】必须使用：${lang}
【注意】打分要严格、实事求是，不要夸大 90+。

【简历】
${resumeText}
${jdText ? `【JD】\n${jdText}\n` : ''}

【输出要求】严格只输出 JSON，不要 markdown，不要任何额外解释。字段：
{
  "overall": 78,
  "dimensions": [
    {"name":"可解析性","score":80,"comment":"避免使用图片、复杂表头与文本框。"},
    {"name":"行动动词使用","score":70,"comment":"仍有大量"负责/参与"，建议替换为"主导/推动/设计/优化/落地"等动词。"}
  ],
  "suggestions": [
    "建议 1：把 3 处扁平的"负责 XX 项目"改为 STAR/XYZ 结构并量化结果。",
    "建议 2：技能区使用与 JD 一致的关键词（含大小写/别名），提升匹配度。"
  ]
}
`.trim();

    const raw = await this.ai.chat(prompt, config, 'advanced');
    const obj = captureJSON(raw, { overall: 60, dimensions: [], suggestions: [] });
    if (obj.__raw && (!obj.dimensions || !obj.dimensions.length)) {
      // 解析失败：把 raw 当作 markdown 返回
      return {
        overall: Number(obj.overall) || 60,
        dimensions: [{ name: '解析失败', score: 0, comment: '模型输出非 JSON，已回退为原始文本展示。' }],
        suggestions: [],
        markdown: String(obj.__raw || '').trim()
      };
    }
    // 保证 overall 为 0-100
    const overall = Math.max(0, Math.min(100, Number(obj.overall) || 0));
    const dimensions = Array.isArray(obj.dimensions) ? obj.dimensions.map(d => ({
      name: String(d.name || '维度').trim(),
      score: Math.max(0, Math.min(100, Number(d.score) || 0)),
      comment: String(d.comment || '').trim()
    })) : [];
    const suggestions = Array.isArray(obj.suggestions)
      ? obj.suggestions.map(s => String(s).trim()).filter(Boolean)
      : [];
    // 构造渲染用 Markdown 卡片内容
    const markdown = this._buildMarkdown(overall, dimensions, suggestions, lang);
    return { overall, dimensions, suggestions, markdown };
  }

  _emptyResult(reason) {
    return {
      overall: 0,
      dimensions: [{ name: '数据不足', score: 0, comment: reason }],
      suggestions: [reason],
      markdown: `### ATS 评分：无法评估\n\n- **分数**：0/100\n- **原因**：${reason}\n\n建议粘贴完整简历后再次尝试。`
    };
  }

  _buildMarkdown(overall, dimensions, suggestions, lang) {
    const cn = lang.toLowerCase().includes('chinese') || !lang.toLowerCase().includes('english');
    const head = cn
      ? `### ATS 评分：**${overall}/100**`
      : `### ATS Score: **${overall}/100**`;
    const dimTitle = cn ? '#### 维度得分' : '#### Dimension scores';
    const dims = dimensions.map(d => `- **${d.name}** ${d.score}/100 — ${d.comment}`).join('\n');
    const sugTitle = cn ? '#### 改进建议' : '#### Suggestions';
    const sugs = suggestions.length
      ? suggestions.map((s, i) => `${i + 1}. ${s}`).join('\n')
      : (cn ? '- 暂无（得分已较高，可关注细节打磨）' : '- None');
    return `${head}\n\n${dimTitle}\n${dims}\n\n${sugTitle}\n${sugs}`;
  }
}

// ============================================================
// 2. 关键词匹配 Agent
// ============================================================
class KeywordMatchAgent {
  constructor(aiService) {
    this.ai = aiService;
  }

  /**
   * @param {Object} p
   * @param {string} p.resumeText
   * @param {string} p.jdText          若为空则退化为"从简历抽取关键词并建议补全通用关键词"
   * @param {'zh'|'en'} [p.language]
   * @param {Object} p.config
   * @returns {Promise<{
   *   extracted:Array<{keyword:string, category:string, priority:'high'|'medium'|'low'}>,
   *   hits:Array<{keyword:string, category:string, priority:string, found:boolean, evidence?:string, suggestSection?:string}>,
   *   summary:string,
   *   markdown:string
   * }>}
   */
  async match({ resumeText, jdText, language = 'zh', config }) {
    const lang = language === 'en' ? 'English' : '简体中文';
    if (!jdText || String(jdText).trim().length < 20) {
      // 无 JD：退化为简历自身关键词抽取 + 通用补全建议
      return this._noJDFallback(resumeText, lang, config);
    }
    const prompt = `
你是一名招聘/HR 岗位关键词分析师。请先从 JD 抽取关键词，再对比简历判定是否命中，并给出补入建议。输出语言：${lang}。

【关键词分类】硬技能(技术栈/工具/框架)、软技能(沟通/协作/项目管理等)、学历要求、经验年限、行业/业务领域、证书/资质、加分项。
【优先级】high：JD 明确写"必须/熟练/3年以上"等；medium：常见期望；low：加分项。

【JD】
${jdText}
【简历】
${resumeText}

【输出要求】严格只输出 JSON。字段：
{
  "extracted": [
    {"keyword":"Java","category":"硬技能","priority":"high"}
  ],
  "hits": [
    {"keyword":"Java","category":"硬技能","priority":"high","found":true,"evidence":"简历经历第 2 段：主导 Java 微服务改造...","suggestSection":""},
    {"keyword":"Kubernetes","category":"硬技能","priority":"medium","found":false,"evidence":"","suggestSection":"在『技能栈』或对应项目段落补入 K8s 相关部署经验（如有）。"}
  ],
  "summary": "一句话总结：JD 共 X 个关键词，简历命中 Y 个（Z%），建议重点补入 AAA、BBB。"
}
`.trim();
    const raw = await this.ai.chat(prompt, config, 'advanced');
    const obj = captureJSON(raw, { extracted: [], hits: [], summary: '' });
    if (obj.__raw && (!obj.hits || !obj.hits.length)) {
      return {
        extracted: [],
        hits: [],
        summary: '关键词 Agent 解析失败',
        markdown: String(obj.__raw || '').trim()
      };
    }
    const extracted = Array.isArray(obj.extracted) ? obj.extracted : [];
    const hits = Array.isArray(obj.hits) ? obj.hits : [];
    const summary = String(obj.summary || this._autoSummary(hits, lang)).trim();
    return {
      extracted, hits, summary,
      markdown: this._buildMatchMarkdown(extracted, hits, summary, lang)
    };
  }

  _autoSummary(hits, lang) {
    const total = hits.length;
    const found = hits.filter(h => h && h.found).length;
    const pct = total ? Math.round(found / total * 100) : 0;
    return lang === 'English'
      ? `Extracted ${total} keywords, matched ${found} (${pct}%). Focus on the missing high-priority items.`
      : `共抽取 ${total} 个关键词，简历命中 ${found} 个（${pct}%）。请优先补齐未命中的 high 级关键词。`;
  }

  _buildMatchMarkdown(extracted, hits, summary, lang) {
    const cn = lang !== 'English';
    const title = cn ? `### 关键词匹配：${summary}` : `### Keyword Match: ${summary}`;
    const highHits = hits.filter(h => h && h.priority === 'high');
    const other = hits.filter(h => h && h.priority !== 'high');
    const render = (arr, level) => arr.map(h => {
      const tag = h.found
        ? (cn ? '✅ 已命中' : '✅ Hit')
        : (cn ? '❌ 缺失' : '❌ Missing');
      const ev = h.evidence ? (cn ? `，证据：${h.evidence}` : `, evidence: ${h.evidence}`) : '';
      const sug = !h.found && h.suggestSection ? (cn ? `，建议补入：${h.suggestSection}` : `, suggest: ${h.suggestSection}`) : '';
      return `- **${h.keyword}** [${h.category}/${level}] ${tag}${ev}${sug}`;
    }).join('\n');
    const h1 = highHits.length ? `#### ${cn ? '高优先级关键词 (High)' : 'High priority'}\n${render(highHits, 'high')}\n\n` : '';
    const h2 = other.length ? `#### ${cn ? '中/低优先级' : 'Medium/Low'}\n${render(other, 'med')}\n\n` : '';
    const stats = cn
      ? `- 共抽取 **${extracted.length}** 个关键词，比对 **${hits.length}** 条。`
      : `- Extracted **${extracted.length}** keywords, compared **${hits.length}** items.`;
    return `${title}\n\n${stats}\n\n${h1}${h2}`;
  }

  async _noJDFallback(resumeText, lang, config) {
    const prompt = `
请先从简历中抽取结构化关键词，再按"常见岗位招聘"给出建议补充的 10-15 个通用关键词，并说明建议插入位置。输出语言：${lang}。

【简历】
${resumeText}

【输出 JSON】
{
  "extracted": [{"keyword":"Vue3","category":"硬技能","priority":"high"}],
  "hits": [
    {"keyword":"Vue3","category":"硬技能","priority":"high","found":true,"evidence":"简历技能区列出 Vue3","suggestSection":""},
    {"keyword":"TypeScript","category":"硬技能","priority":"high","found":false,"evidence":"","suggestSection":"技能区：如确实掌握建议加入 TS 类型实践。"}
  ],
  "summary":"未提供 JD，已基于通用岗位经验提供关键词补全建议。"
}
`.trim();
    const raw = await this.ai.chat(prompt, config, 'standard');
    const obj = captureJSON(raw, { extracted: [], hits: [], summary: '' });
    return {
      extracted: Array.isArray(obj.extracted) ? obj.extracted : [],
      hits: Array.isArray(obj.hits) ? obj.hits : [],
      summary: String(obj.summary || (lang === 'English' ? 'No JD provided.' : '未提供 JD，已给出通用补全建议。')).trim(),
      markdown: this._buildMatchMarkdown(
        Array.isArray(obj.extracted) ? obj.extracted : [],
        Array.isArray(obj.hits) ? obj.hits : [],
        String(obj.summary || '').trim(),
        lang
      )
    };
  }
}

// ============================================================
// 3. 内容优化 Agent：输出优化后全文 + 改动要点
// ============================================================
class ContentOptAgent {
  constructor(aiService) {
    this.ai = aiService;
  }

  /**
   * @param {Object} p
   * @param {string} p.resumeText
   * @param {string} [p.jdText]
   * @param {string} [p.language]
   * @param {Object} p.config
   * @returns {Promise<{
   *   optimizedFullText:string,
   *   changes:Array<{section:string, original:string, improved:string, reason:string}>,
   *   markdown:string
   * }>}
   */
  async optimize({ resumeText, jdText, language = 'zh', config }) {
    if (!resumeText || String(resumeText).trim().length < 50) {
      return {
        optimizedFullText: resumeText || '',
        changes: [],
        markdown: '### 内容优化\n\n简历文本过短，无法执行内容优化（至少 50 字）。'
      };
    }
    const lang = language === 'en' ? 'English' : '简体中文';
    const prompt = `
你是一名资深简历润色专家。请基于 JD（若有）把简历全文优化为：
- 每段经历以强行动动词开头（主导/推动/设计/优化/落地/搭建/重构/拓展等，英文用 Led/Designed/Optimized/Built/Scaled 等）
- 每个 bullet 尽量量化：规模、耗时、提升比例、成本下降、用户增长、QPS、DAU、ROI 等
- 结构采用 STAR / XYZ 思路（背景 X → 动作 Y → 量化结果 Z）
- 严禁捏造经历、证书、学历、数字；只能在候选人文本语义范围内"改写得更专业、更量化、更贴合 JD"
- 保持原文的分区顺序：个人信息 → 工作经历 → 项目经历 → 教育经历 → 技能证书 → 其他
- 输出语言：${lang}（若简历混合中英，保持与原文主体一致，不要强行翻译）

【简历原文】
${resumeText}
${jdText ? `【JD（优化参考）】\n${jdText}\n` : ''}

【输出要求】严格只输出 JSON：
{
  "optimizedFullText": "完整优化后简历全文（包含所有区块，保留分段与列表）",
  "changes": [
    {
      "section": "工作经历 / XX公司 / 第 2 条",
      "original": "负责公司官网的前端开发，参与功能迭代。",
      "improved": "主导公司官网前端架构升级（Vue2→Vue3 + TS），推动页面首屏加载从 3.2s 降至 1.1s（-66%），支撑 80+ 活动页的统一研发规范落地。",
      "reason": "使用强动词+量化，把扁平描述升级为 XYZ。"
    }
  ]
}
注意：如果原文某段已经足够专业，可跳过（不列入 changes），但 optimizedFullText 仍需包含全文。
`.trim();

    const raw = await this.ai.chat(prompt, config, 'deep'); // 内容改写用 deep 档位
    const obj = captureJSON(raw, { optimizedFullText: resumeText, changes: [] });
    const text = String(obj.optimizedFullText || resumeText || '').trim();
    const changes = Array.isArray(obj.changes) ? obj.changes.map(c => ({
      section: String(c.section || '段落').trim(),
      original: String(c.original || '').trim(),
      improved: String(c.improved || '').trim(),
      reason: String(c.reason || '').trim()
    })).filter(c => c.improved) : [];

    const cn = lang !== 'English';
    const title = cn ? '### 内容优化：改写前后对比（核心改动）' : '### Content Optimization: Key changes';
    const list = changes.length
      ? changes.map((c, i) => `**${i + 1}. [${c.section}]**\n- 原文：${c.original}\n- 改写：${c.improved}\n- 原因：${c.reason}`).join('\n\n')
      : (cn ? '- 简历内容已较专业，暂未生成大幅改写条目。可结合 ATS 与关键词建议做局部微调。'
        : '- Resume content is already professional. Minor tweaks via ATS & keyword suggestions are recommended.');
    const tail = cn
      ? `\n\n---\n**优化后全文**（可直接用于『导出 DOCX』）：\n\n${text}`
      : `\n\n---\n**Optimized Full Text** (ready for 'Export DOCX'):\n\n${text}`;
    return {
      optimizedFullText: text,
      changes,
      markdown: `${title}\n\n${list}${tail}`
    };
  }
}

// ============================================================
// 4. ResumeOptPipeline：编排（ATS → 关键词 → 内容优化 串行）
//    调用方（localHttpServer/main.js/renderer）统一拿到：
//    {atsScore, keywordMatch, contentOpt, totalMarkdown, elapsedMs}
// ============================================================
class ResumeOptPipeline {
  constructor(aiService) {
    this.ats = new ATSScoringAgent(aiService);
    this.kw = new KeywordMatchAgent(aiService);
    this.copt = new ContentOptAgent(aiService);
  }

  /**
   * 单阶段：ATS 评分（独立路由 /resume-opt/ats 会直接调用）。
   * 对外返回与 Agent 保持一致：{overall, dimensions, suggestions, markdown}。
   */
  async runATS({ resumeText, jdText, language = 'zh', config }) {
    return await this.ats.score({ resumeText, jdText, language, config });
  }

  /**
   * 单阶段：关键词匹配（独立路由 /resume-opt/keywords 会直接调用）。
   */
  async runKeywords({ resumeText, jdText, language = 'zh', config }) {
    return await this.kw.match({ resumeText, jdText, language, config });
  }

  /**
   * 单阶段：内容优化（独立路由 /resume-opt/content 会直接调用）。
   */
  async runContent({ resumeText, jdText, language = 'zh', config }) {
    return await this.copt.optimize({ resumeText, jdText, language, config });
  }

  /**
   * 串行执行三个 Agent，累计耗时以 ms 返回。
   * @param {Object} p
   * @param {string} p.resumeText
   * @param {string} [p.jdText]
   * @param {'zh'|'en'} [p.language]
   * @param {Object} p.config
   * @param {(stage:string, payload:any)=>void} [onStage] 可选：每完成一个阶段回调
   * @returns {Promise<{
   *   atsScore:any, keywordMatch:any, contentOpt:any,
   *   totalMarkdown:string, elapsedMs:number
   * }>}
   */
  async run({ resumeText, jdText, language = 'zh', config }, onStage) {
    const start = Date.now();
    const cn = language === 'en' ? false : true;

    // Stage 1: ATS 评分（复用 runATS，保证独立路由与综合 run 的结果一致）
    const atsScore = await this.runATS({ resumeText, jdText, language, config });
    if (typeof onStage === 'function') onStage('ats', atsScore);

    // Stage 2: 关键词匹配
    const keywordMatch = await this.runKeywords({ resumeText, jdText, language, config });
    if (typeof onStage === 'function') onStage('keywords', keywordMatch);

    // Stage 3: 内容优化
    const contentOpt = await this.runContent({ resumeText, jdText, language, config });
    if (typeof onStage === 'function') onStage('content', contentOpt);

    // 总 Markdown（用于详情页或用户整体查看）
    const h1 = cn ? '# 简历 AI 优化报告' : '# Resume AI Optimization Report';
    const h2a = cn ? '## 1. ATS 评分' : '## 1. ATS Score';
    const h2b = cn ? '## 2. 关键词匹配' : '## 2. Keyword Match';
    const h2c = cn ? '## 3. 内容优化' : '## 3. Content Optimization';
    const totalMarkdown = [
      h1, '',
      h2a, atsScore.markdown, '',
      h2b, keywordMatch.markdown, '',
      h2c, contentOpt.markdown
    ].join('\n');

    return {
      atsScore,
      keywordMatch,
      contentOpt,
      totalMarkdown,
      elapsedMs: Date.now() - start
    };
  }
}

module.exports = {
  ATSScoringAgent,
  KeywordMatchAgent,
  ContentOptAgent,
  ResumeOptPipeline
};
