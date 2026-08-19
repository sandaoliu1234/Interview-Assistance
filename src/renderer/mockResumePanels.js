/**
 * src/renderer/mockResumePanels.js
 * ------------------------------------------------------------
 * 渲染层：模拟面试 panel + 简历优化 panel 的"功能逻辑 + 事件绑定 + UI 状态更新"。
 * 所有功能都走：
 *   ① IPC 取 baseUrl + token（必要时自动启动 localHttpServer）
 *   ② fetch('/api/xxx') 调用 localHttpServer 里的多 Agent 路由
 *   ③ 把返回结果填回 DOM（index.html 里已有的卡片/徽章/评分/进行中 run-card 等）
 *
 * 不生成任何测试文件；不新增模拟数据。
 * 每个函数都有中文注释说明其作用。
 * ------------------------------------------------------------
 */
(function () {
  'use strict';

  // ------------------------------------------------------------
  // 0. 基础工具
  // ------------------------------------------------------------
  // 安全地取 DOM 元素（避免页面结构变动导致 crash）
  const $ = (sel) => (sel && document.querySelector ? document.querySelector(sel) : null);
  const $$ = (sel) => (sel && document.querySelectorAll ? Array.from(document.querySelectorAll(sel)) : []);

  // 简易 toast（浮现在页面右上角），用于提示用户"启动中/上传失败/导出成功"等
  function toast(msg, type = 'info', ms = 2600) {
    try {
      let box = $('#hireme-toast-box');
      if (!box) {
        box = document.createElement('div');
        box.id = 'hireme-toast-box';
        Object.assign(box.style, {
          position: 'fixed', top: '16px', right: '16px', zIndex: 99999,
          display: 'flex', flexDirection: 'column', gap: '8px', pointerEvents: 'none'
        });
        document.body.appendChild(box);
      }
      const el = document.createElement('div');
      const colorMap = { info: '#3b82f6', success: '#10b981', warn: '#f59e0b', error: '#ef4444' };
      const bg = colorMap[type] || colorMap.info;
      Object.assign(el.style, {
        minWidth: '200px', maxWidth: '380px', padding: '10px 14px', borderRadius: '10px',
        background: 'rgba(17, 24, 39, 0.94)', backdropFilter: 'blur(6px)',
        color: '#e5e7eb', fontSize: '13px', lineHeight: 1.5,
        border: `1px solid ${bg}66`, boxShadow: `0 8px 24px rgba(0,0,0,0.25), 0 0 0 1px ${bg}22 inset`,
        pointerEvents: 'auto'
      });
      el.innerHTML = `<span style="display:inline-block;min-width:8px;height:8px;border-radius:50%;background:${bg};margin-right:8px;vertical-align:middle;"></span>${String(msg).replace(/</g, '&lt;')}`;
      box.appendChild(el);
      setTimeout(() => {
        el.style.transition = 'opacity .3s ease, transform .3s ease';
        el.style.opacity = '0';
        el.style.transform = 'translateY(-6px)';
        setTimeout(() => { try { box.removeChild(el); } catch (_) { /* ignore */ } }, 320);
      }, ms);
    } catch (_) { /* 即使 toast 出错也不影响主流程 */ }
  }

  // 统一：把 Markdown 字符串做"极轻量化"HTML 渲染（不需要引入 markdown 库）
  //   - 转义 &<>"'；- 标题、粗体、列表、换行
  function lightMarkdown(md) {
    const s = String(md || '');
    const esc = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    // 代码块（```）先占位避免被换行切
    const codeBlocks = [];
    let withCode = esc.replace(/```([\s\S]*?)```/g, (_m, body) => {
      codeBlocks.push(body); return `\u0000CODE${codeBlocks.length - 1}\u0000`;
    });
    let html = withCode
      .replace(/^######\s*(.+)$/gm, '<h6>$1</h6>')
      .replace(/^#####\s*(.+)$/gm, '<h5>$1</h5>')
      .replace(/^####\s*(.+)$/gm, '<h4>$1</h4>')
      .replace(/^###\s*(.+)$/gm, '<h3>$1</h3>')
      .replace(/^##\s*(.+)$/gm, '<h2>$1</h2>')
      .replace(/^#\s*(.+)$/gm, '<h1>$1</h1>')
      .replace(/^\s*[-*•]\s+(.+)$/gm, '<li>$1</li>')
      .replace(/^\s*\d+[\.、)）]\s+(.+)$/gm, '<li>$1</li>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\n{2,}/g, '</p><p>')
      .replace(/\n/g, '<br/>');
    html = `<p>${html}</p>`;
    html = html.replace(/<\/li><br\/?><li>/g, '</li><li>');
    html = html.replace(/(<li>[^<]+<\/li>(\s*<br\/?>\s*<li>[^<]+<\/li>)+)/g, '<ul>$1</ul>');
    html = html.replace(/\u0000CODE(\d+)\u0000/g, (_m, idx) => `<pre><code>${codeBlocks[Number(idx)] || ''}</code></pre>`);
    return html;
  }

  // 判断当前环境是否有 ipcRenderer（Electron）
  function hasIPC() {
    try { return !!(window && window.__INITIAL_STATE__ !== undefined ? true : (window.ipcRenderer || (window.require && window.require('electron').ipcRenderer))); } catch (_) { return false; }
  }
  function getIPC() {
    if (window.ipcRenderer) return window.ipcRenderer;
    try {
      if (window.require) return window.require('electron').ipcRenderer;
    } catch (_) { /* ignore */ }
    return null;
  }

  // ------------------------------------------------------------
  // 1. 通用 HTTP 客户端（带自动拉取 baseUrl/token）
  // ------------------------------------------------------------
  let _httpInfo = null; // 缓存：{baseUrl,token}
  async function ensureHTTP() {
    if (_httpInfo && _httpInfo.baseUrl && _httpInfo.token) return _httpInfo;
    const ipc = getIPC();
    if (!ipc) throw new Error('当前环境不支持 IPC，无法启动本地服务。');
    const info = await ipc.invoke('get-server-http-info');
    if (!info || !info.ok || !info.baseUrl) throw new Error((info && info.msg) || '本地 HTTP 服务启动失败');
    _httpInfo = { baseUrl: info.baseUrl, token: info.token };
    return _httpInfo;
  }
  async function apiFetch(path, payload) {
    const info = await ensureHTTP();
    const url = info.baseUrl + path;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json;charset=utf-8',
        'Authorization': `Bearer ${info.token}`
      },
      body: JSON.stringify(payload || {})
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.ok) {
      const msg = (json && (json.msg || json.error)) || `HTTP ${res.status}`;
      const err = new Error(msg);
      err.payload = json;
      throw err;
    }
    return json;
  }

  // ------------------------------------------------------------
  // 2. 模拟面试 Panel：状态 + 事件绑定 + UI 更新
  //    注意：实际 DOM id / data-type 来自 index.html（HireMe 风格），这里做"以 HTML 为准"的绑定：
  //    - 面试类型 data-type：behavior / technical / programming / comprehensive（后端会再归一）
  //    - 职位：mockTargetPosition；行业：mockTargetIndustry；JD：mockJobDesc；简历：mockResumeEditor
  //    - 作答方式：mock-ans-mode 的 seg-btn data-mode=voice|text
  //    - 题目数：mockQuestionCount；面试语言：mockLanguage (select)
  //    - 开始按钮：mockStartBtn；记录按钮：mockViewHistoryBtn
  //    - 进行中卡片：mockRunCard、mockProgress、mockRunStatus、mockQuestionText、mockAnswerEditor、
  //                   mockSubmitAnswerBtn、mockHintBtn、mockEndBtn、mockFeedbackBox、mockFeedbackBody
  // ------------------------------------------------------------
  const MockState = {
    type: 'comprehensive',      // 与 HTML 里默认选中的 comprehensive 保持一致
    currentQuestion: null,      // {question,focus,expected,index,total}
    pendingFollowup: null,      // 当前追问题（如有）
    answeredCount: 0,           // 已完成题数（不含当前）
    totalQuestions: 8,
    averageScore: 0,
    answerMode: 'text',
    language: 'zh',
    // 语音作答：仅 answerMode=voice 时激活；与『当前题目』生命周期一致，切题/结束面试会重置
    voice: {
      ctrl: null,               // window.HireMeCore.startMockInterviewVoiceAnswer 返回的 {stop,isRunning}
      stateLabel: '',           // 展示给用户的状态文案（录音中/连接中/已停止…）
      finalText: '',            // 已落定的识别文本（合并到编辑器）
      interimText: '',          // 当前"识别中…"草稿（仅显示，不参与提交）
      uiMounted: false,         // 是否已在 mockSubmitAnswerBtn 前插入了麦克风按钮与状态徽章容器
      errors: []                // 最近一次错误信息小栈（仅用于 toast），用于避免重复弹同一个错误
    }
  };

  // 设置面试类型卡片选中态（HTML 默认 comprehensive active，这里 class 名以 HTML 为准）
  function setMockInterviewType(type) {
    const allow = ['behavior', 'technical', 'programming', 'comprehensive'];
    if (allow.indexOf(type) === -1) return;
    MockState.type = type;
    $$('#mockInterviewTypeGrid .mock-type').forEach(btn => {
      const t = btn.getAttribute('data-type');
      if (t === type) {
        btn.classList.add('active');
        // 兼容旧样式 selected
        try { btn.classList.add('selected'); } catch (_) { /* ignore */ }
      } else {
        btn.classList.remove('active');
        try { btn.classList.remove('selected'); } catch (_) { /* ignore */ }
      }
    });
  }

  // 设置作答方式按钮（voice/text）的 active 态，并同步 MockState.answerMode
  // - 切到 voice：首次在 mockSubmitAnswerBtn 左侧插入麦克风按钮 + 状态徽章；并更新提示文案
  // - 切到 text：隐藏语音 UI（不移除 DOM，避免重绑定丢失）；并停止当前正在进行的录音
  function setMockAnswerMode(mode) {
    if (mode !== 'voice' && mode !== 'text') return;
    MockState.answerMode = mode;
    $$('.mock-ans-mode').forEach(btn => {
      const m = btn.getAttribute('data-mode');
      if (m === mode) btn.classList.add('active'); else btn.classList.remove('active');
    });
    const label = $('#mockAnswerHintLabel');
    if (label) {
      label.textContent = mode === 'voice'
        ? '（语音作答：点击麦克风按钮开始讲话，识别结果会自动填入；按 Ctrl+Enter 可快速提交）'
        : '（文字作答：输入后按 Ctrl+Enter 或点『提交回答』）';
    }
    // 切到 text 模式：如果还在录音，立即停止；同时把语音按钮隐藏
    if (mode === 'text') {
      if (MockState.voice.ctrl && typeof MockState.voice.ctrl.stop === 'function') {
        try { MockState.voice.ctrl.stop().catch(() => {}); } catch (_) { /* ignore */ }
      }
      MockState.voice.ctrl = null;
      MockState.voice.stateLabel = '';
      const vBtn = $('#mockVoiceAnswerBtn');
      const vBadge = $('#mockVoiceStateBadge');
      if (vBtn) vBtn.style.display = 'none';
      if (vBadge) vBadge.style.display = 'none';
      // 把 textarea 里 interim/final 生成的语音文本保留（用户可能想基于它再修改）
      return;
    }
    // 切到 voice：首次在提交按钮左侧插入『麦克风按钮 + 状态徽章』（仅插入一次）
    if (!MockState.voice.uiMounted) {
      const submitBtn = $('#mockSubmitAnswerBtn');
      if (submitBtn && submitBtn.parentNode) {
        const wrap = document.createElement('div');
        wrap.className = 'mock-voice-wrap';
        wrap.style.display = 'inline-flex';
        wrap.style.alignItems = 'center';
        wrap.style.gap = '8px';
        wrap.style.flex = '0 0 auto';
        // 把 wrap 插到 submitBtn 之前
        submitBtn.parentNode.insertBefore(wrap, submitBtn);
        // 1) 麦克风按钮
        const voiceBtn = document.createElement('button');
        voiceBtn.id = 'mockVoiceAnswerBtn';
        voiceBtn.className = 'start-interview-btn mock-voice-btn';
        voiceBtn.type = 'button';
        voiceBtn.innerHTML = '<span>&#127908;</span> 开始录音';
        voiceBtn.title = '开始/停止语音作答（百度ASR：实时WS或1.5s REST兜底）';
        voiceBtn.addEventListener('click', toggleVoiceRecording);
        wrap.appendChild(voiceBtn);
        // 2) 状态徽章（初始隐藏）
        const badge = document.createElement('div');
        badge.id = 'mockVoiceStateBadge';
        badge.className = 'mock-voice-state-badge';
        badge.style.display = 'none';
        badge.textContent = '准备中…';
        wrap.appendChild(badge);
        MockState.voice.uiMounted = true;
      }
    } else {
      // 已经插过：切到 voice 时再次显示
      const vBtn = $('#mockVoiceAnswerBtn');
      const vBadge = $('#mockVoiceStateBadge');
      if (vBtn) vBtn.style.display = '';
      if (vBadge) vBadge.style.display = '';
    }
  }

  // 同步语音识别结果到编辑器：
  // - finalText 是已落定文本（会作为提交答案的真实内容）
  // - interimText 是临时草稿（仅视觉显示，提交时不会被单独拿出来）
  // 为避免重置用户光标，这里用 value 直接合并；光标位置由后续用户打字自然恢复
  function updateVoiceAnswerDisplay() {
    const ansEl = $('#mockAnswerEditor');
    if (!ansEl) return;
    ansEl.value = MockState.voice.finalText + MockState.voice.interimText;
  }

  // 开始/停止语音录音（toggle）：
  // - 未在录音 → 初始化回调 → 调用 window.HireMeCore.startMockInterviewVoiceAnswer
  // - 正在录音 → 调 ctrl.stop()，按钮回到『开始录音』
  async function toggleVoiceRecording() {
    const btn = $('#mockVoiceAnswerBtn');
    const badge = $('#mockVoiceStateBadge');
    if (!btn) return;

    // Case A：正在录音 → 停止
    if (MockState.voice.ctrl && typeof MockState.voice.ctrl.isRunning === 'function'
        && MockState.voice.ctrl.isRunning()) {
      try {
        if (typeof MockState.voice.ctrl.stop === 'function') await MockState.voice.ctrl.stop();
      } catch (_) { /* ignore */ }
      MockState.voice.ctrl = null;
      MockState.voice.stateLabel = '已停止录音';
      btn.innerHTML = '<span>&#127908;</span> 开始录音';
      btn.classList.remove('recording');
      if (badge) {
        badge.classList.remove('listening', 'connecting');
        badge.style.display = 'none';
      }
      toast('已停止语音识别，可在下方编辑或直接提交。', 'info', 1800);
      return;
    }

    // Case B：未在录音 → 启动
    // 先清空之前合并出来的"上一题"残留（仅清空 finalText，interimText 自然会再生成）
    //   注意：不要清空 textarea 现有文字——用户可能已部分打字 + 语音合并作答
    //   这里只清空语音内部缓存的 final/interim，接下来的 interim/final 会基于这个新基线累加
    MockState.voice.finalText = '';
    MockState.voice.interimText = '';
    // 如果当前 textarea 已经有内容，把它视为"已存在文本"，合并到 finalText 基线
    const ansEl = $('#mockAnswerEditor');
    if (ansEl && String(ansEl.value).trim()) {
      MockState.voice.finalText = ansEl.value + (/\s$/.test(ansEl.value) ? '' : ' ');
    }

    // 检查是否存在全局入口（浏览器模式下可能没有）
    const starter = window.HireMeCore && window.HireMeCore.startMockInterviewVoiceAnswer;
    if (typeof starter !== 'function') {
      toast('当前环境不支持语音作答：缺少 HireMeCore ASR 桥接（请在 Electron 主应用中使用）。', 'warn', 5000);
      MockState.voice.stateLabel = 'ASR 入口不可用';
      if (badge) { badge.style.display = ''; badge.textContent = '⚠️ ASR 不可用'; badge.classList.add('connecting'); }
      return;
    }

    // 显示状态徽章 + 按钮切换为『停止录音』
    if (badge) { badge.style.display = ''; badge.textContent = '准备中…'; badge.classList.remove('listening'); badge.classList.add('connecting'); }
    btn.innerHTML = '<span>&#128264;</span> 停止录音';
    btn.classList.add('recording');

    // 回调：interim/final/error/stateChange 全部落到 MockState.voice 与 UI 控件上
    const callbacks = {
      // interim：临时识别结果，仅显示不参与"落定文本"
      onInterim: (text) => {
        MockState.voice.interimText = String(text || '');
        updateVoiceAnswerDisplay();
      },
      // final：已落定识别结果，合并到 finalText
      onFinal: (text) => {
        const t = String(text || '').trim();
        if (!t) { MockState.voice.interimText = ''; updateVoiceAnswerDisplay(); return; }
        MockState.voice.finalText += (MockState.voice.finalText && !/\s$/.test(MockState.voice.finalText) ? ' ' : '') + t + ' ';
        MockState.voice.interimText = '';
        updateVoiceAnswerDisplay();
      },
      // error：错误提示，优先去重，避免被 1.5s REST 循环刷屏
      onError: (msg) => {
        const m = String(msg || '').trim();
        if (!m) return;
        const recent = MockState.voice.errors;
        const last = recent.length ? recent[recent.length - 1] : '';
        if (last === m) return; // 去重
        recent.push(m);
        if (recent.length > 5) recent.shift();
        toast('语音识别：' + m, 'warn', 3600);
        // 徽章文案同步一次（保留最后一次错误）
        const b = $('#mockVoiceStateBadge');
        if (b) { b.style.display = ''; b.textContent = '⚠ ' + (m.length > 18 ? m.slice(0, 17) + '…' : m); b.classList.remove('listening'); b.classList.add('connecting'); }
      },
      // stateChange：更新状态徽章 & 按钮 title
      onStateChange: (state) => {
        const map = {
          'idle': '就绪',
          'starting': '准备中…',
          'mic': '麦克风已就绪…',
          'connecting': '连接识别服务…',
          'listening': '正在聆听…',
          'stopped': '已停止'
        };
        const label = map[state] || state;
        MockState.voice.stateLabel = label;
        btn.title = '语音作答状态：' + label;
        const b = $('#mockVoiceStateBadge');
        if (b) {
          if (state === 'stopped') {
            b.style.display = 'none';
          } else {
            b.style.display = '';
            b.textContent = label;
            if (state === 'listening') { b.classList.add('listening'); b.classList.remove('connecting'); }
            else { b.classList.add('connecting'); b.classList.remove('listening'); }
          }
        }
      }
    };

    try {
      const ctrl = await starter(callbacks);
      MockState.voice.ctrl = ctrl || null;
      // 如果 starter 内部立即失败（如麦克风授权失败），把按钮恢复成『开始录音』
      if (!ctrl || (typeof ctrl.isRunning === 'function' && !ctrl.isRunning())) {
        btn.innerHTML = '<span>&#127908;</span> 开始录音';
        btn.classList.remove('recording');
        if (badge && String(badge.textContent).indexOf('⚠') === -1) { badge.style.display = 'none'; }
      }
    } catch (e) {
      toast('启动语音作答失败：' + (e.message || e), 'error', 4200);
      MockState.voice.ctrl = null;
      btn.innerHTML = '<span>&#127908;</span> 开始录音';
      btn.classList.remove('recording');
      if (badge) { badge.style.display = ''; badge.textContent = '⚠ ' + (e.message || '启动失败'); badge.classList.add('connecting'); }
    }
  }

  // 工具：重置语音作答状态（切题 / 提交答案 / 结束面试 前调用）：
  //   - 若正在录音，先停（不阻塞，失败静默）
  //   - 清空 final/interim 缓存（但保留 textarea 原文字；调用方若要清 textarea 自行处理）
  //   - 按钮 UI 回到『开始录音』+ 隐藏徽章
  async function resetMockVoiceRecording(/* opts = { clearEditor:false } */) {
    try {
      if (MockState.voice.ctrl && typeof MockState.voice.ctrl.stop === 'function') {
        try { await MockState.voice.ctrl.stop(); } catch (_) { /* ignore */ }
      }
    } catch (_) { /* ignore */ }
    MockState.voice.ctrl = null;
    MockState.voice.interimText = '';
    MockState.voice.finalText = '';
    MockState.voice.stateLabel = '';
    const btn = $('#mockVoiceAnswerBtn');
    const badge = $('#mockVoiceStateBadge');
    if (btn) { btn.innerHTML = '<span>&#127908;</span> 开始录音'; btn.classList.remove('recording'); }
    if (badge) { badge.style.display = 'none'; badge.classList.remove('listening', 'connecting'); }
  }

  // 设置简历优化语言 seg 按钮的 active 态，并同步 ResumeState.language
  function setResumeLang(lang) {
    if (lang !== 'zh' && lang !== 'en') return;
    ResumeState.language = lang;
    $$('.resume-lang-btn').forEach(btn => {
      const l = btn.getAttribute('data-lang');
      if (l === lang) btn.classList.add('active'); else btn.classList.remove('active');
    });
  }

  // 收集模拟面试表单数据（严格以 index.html 当前的 id 命名为准）
  function collectMockForm() {
    const targetPosition = ( $('#mockTargetPosition') && $('#mockTargetPosition').value) || '';
    const industry = ( $('#mockTargetIndustry') && $('#mockTargetIndustry').value) || '';
    const jdText = ( $('#mockJobDesc') && $('#mockJobDesc').value) || '';
    const resumeText = ( $('#mockResumeEditor') && $('#mockResumeEditor').value) || '';
    const totalQuestions = Number(( $('#mockQuestionCount') && $('#mockQuestionCount').value) || 8);
    const answerMode = MockState.answerMode; // seg-btn 点选后已缓存
    const language = ( $('#mockLanguage') && $('#mockLanguage').value === 'en') ? 'en' : 'zh';
    return { type: MockState.type, targetPosition, industry, jdText, resumeText,
      totalQuestions, answerMode, language, maxFollowups: 2 };
  }

  // 基础校验
  function validateMockForm(form) {
    const allow = ['behavior', 'technical', 'programming', 'comprehensive'];
    if (!form.type || allow.indexOf(form.type) === -1) return '请选择面试类型（行为/技术/编程/综合）';
    if (!String(form.targetPosition).trim()) return '请填写目标职位（必填）';
    if (!String(form.industry).trim()) return '请填写行业/领域（必填）';
    if (!Number.isFinite(form.totalQuestions) || form.totalQuestions < 1) return '请选择题目数量';
    return '';
  }

  // 渲染进行中 run-card：顶部进度、状态、题目文本、追问题
  function renderMockRunCard(partial) {
    const box = $('#mockRunCard');
    if (!box) return;
    box.style.display = '';
    box.classList.remove('hidden');
    // 进度徽章
    const idx = (partial && Number.isFinite(partial.questionIndex)) ? partial.questionIndex
      : (MockState.currentQuestion ? MockState.currentQuestion.index : 1);
    const total = (partial && Number.isFinite(partial.totalQuestions)) ? partial.totalQuestions : MockState.totalQuestions;
    const prog = $('#mockProgress');
    if (prog) prog.textContent = `第 ${idx} / ${total} 题`;
    // 状态文本
    const status = $('#mockRunStatus');
    if (status) status.textContent = (partial && partial.done) ? '已完成全部题目' : '请作答';

    if (partial && partial.question) {
      MockState.currentQuestion = {
        index: idx, total,
        question: partial.question,
        focus: partial.focus || '',
        expected: partial.expected || ''
      };
    }
    const qText = $('#mockQuestionText');
    if (qText) {
      qText.textContent = (MockState.currentQuestion && MockState.currentQuestion.question)
        ? MockState.currentQuestion.question
        : '正在生成第一道题目…';
      // focus/expected 若存在则作为 title 悬浮（HTML 没单独字段），避免破坏截图样式
      const tip = [MockState.currentQuestion && MockState.currentQuestion.focus,
        MockState.currentQuestion && MockState.currentQuestion.expected]
        .filter(Boolean).join(' · ');
      if (tip) qText.setAttribute('title', tip); else qText.removeAttribute('title');
    }

    // 追问：HTML 没单独字段；若需要追问，把追问题以"题目下一行"的方式追加展示（通过 mockQuestionText 的 innerHTML）
    if (partial && partial.followup && partial.followup.needFollowup && partial.followup.question) {
      MockState.pendingFollowup = { question: partial.followup.question, reason: partial.followup.reason || '' };
    }
    // 如果存在 pendingFollowup 且有独立追问题展示区（老版本 mockResumePanels 用的 followup block），这里兼容：
    const fuBox = document.querySelector('[id*="Followup"]');
    if (fuBox) {
      if (MockState.pendingFollowup && MockState.pendingFollowup.question) {
        fuBox.classList.remove('hidden');
      } else {
        fuBox.classList.add('hidden');
      }
    }
    // 把"追问题"作为提示直接追加在：现有 mockFeedbackBox 之上（如果没有独立 followup 区）
    const qt = $('#mockQuestionText');
    if (qt && MockState.pendingFollowup && MockState.pendingFollowup.question) {
      const html =
        `<div style="margin-bottom:8px;">${String(qt.textContent).replace(/</g,'&lt;')}</div>` +
        `<div style="padding:8px 10px;border-radius:8px;border:1px dashed rgba(249,115,22,.55);color:#fbbf24;font-size:13px;">` +
        `➡️ 面试官追问：${String(MockState.pendingFollowup.question).replace(/</g,'&lt;')}</div>`;
      qt.innerHTML = html;
    }
  }

  function hideMockRunCard() {
    const box = $('#mockRunCard');
    if (box) { box.classList.add('hidden'); box.style.display = 'none'; }
  }

  // 渲染点评结果：写入 mockFeedbackBody（Markdown 轻量渲染），同时展示得分
  function renderMockFeedback(fb) {
    if (!fb) return;
    const box = $('#mockFeedbackBox');
    if (box) box.classList.remove('hidden');
    const body = $('#mockFeedbackBody');
    if (!body) return;
    const md =
      `**本轮得分：${Number(fb.score) || 0}/10**\n` +
      `**一句话：** ${fb.summary || ''}\n\n` +
      `**亮点：**\n${fb.highlights || '- 暂无'}\n\n` +
      `**改进：**\n${fb.improvements || '- 暂无'}`;
    body.innerHTML = lightMarkdown(md);
  }

  // 最终复盘报告：以"追加在 classicPanel 末尾的一段 review 卡片"形式展示（不引入新 ID，避免 crash）
  function renderMockFinalReview(data) {
    const classicPanel = $('#classicPanel');
    if (!classicPanel) return;
    let card = $('#mockFinalReviewCard');
    if (!card) {
      card = document.createElement('section');
      card.id = 'mockFinalReviewCard';
      card.className = 'copilot-card resume-result-card';
      card.style.marginTop = '20px';
      card.innerHTML = `
        <div class="resume-result-head">
          <div class="resume-result-title" id="mockFinalReviewHead">&#127942; 模拟面试复盘报告</div>
          <div class="resume-result-actions">
            <button id="mockFinalReviewCloseBtn" class="tool-btn" type="button">关闭</button>
          </div>
        </div>
        <div id="mockFinalReviewBody" style="color:#d1d5db;line-height:1.75;font-size:14px;"></div>
      `;
      classicPanel.appendChild(card);
      const closeBtn = $('#mockFinalReviewCloseBtn');
      if (closeBtn) closeBtn.addEventListener('click', () => {
        if (card && card.parentNode) card.parentNode.removeChild(card);
      });
    }
    const head = $('#mockFinalReviewHead');
    const body = $('#mockFinalReviewBody');
    if (head) {
      const avg = Number(data && data.averageScore) || 0;
      const total = Number(data && data.totalQuestions) || 0;
      const done = Number(data && data.answeredCount) || 0;
      head.textContent = `🏆 复盘报告：平均分 ${avg}/10 · 完成 ${done}/${total} 题`;
    }
    if (body) body.innerHTML = lightMarkdown((data && data.review) || '暂无复盘内容。');
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // 主：启动模拟面试 session 并自动出第 1 题
  // 绑定的 DOM 按钮为 mockStartBtn（对应 index.html 的模拟面试 CTA）。
  async function startMockInterview() {
    try {
      // 启动前：清理上一场的语音缓存（避免跨会话串字）
      try { await resetMockVoiceRecording(); } catch (_) { /* ignore */ }
      const btn = $('#mockStartBtn');
      if (btn) { btn.disabled = true; btn.innerHTML = '<span>&#9889;</span> 正在启动模拟面试…'; }
      const form = collectMockForm();
      const invalidMsg = validateMockForm(form);
      if (invalidMsg) { toast(invalidMsg, 'warn'); throw new Error(invalidMsg); }
      // 启动 session
      const sessionRes = await apiFetch('/api/mock-interview/session', form);
      MockState.totalQuestions = Number(form.totalQuestions) || 5;
      MockState.answeredCount = 0;
      toast('模拟面试已启动，正在生成第 1 题…', 'info');

      // 出第 1 题
      const qRes = await apiFetch('/api/mock-interview/next-question', {});
      if (qRes.done) {
        toast(qRes.message || '已完成题目', 'warn');
      } else {
        renderMockRunCard(qRes);
      }
    } catch (e) {
      toast('启动失败：' + (e.message || '未知错误'), 'error', 4200);
      console.error('[mock-interview] start 异常：', e);
    } finally {
      const btn = $('#mockStartBtn');
      if (btn) { btn.disabled = false; btn.innerHTML = '<span>&#9889;</span> 开始模拟面试<span class="mock-cta-arrow">&#10140;</span>'; }
    }
  }

  // 提交主问题答案
  async function submitMockAnswer() {
    try {
      const ansEl = $('#mockRunAnswerTextarea');
      const answer = ansEl ? ansEl.value : '';
      if (!String(answer).trim()) { toast('请先输入回答', 'warn'); return; }
      const btn = $('#mockRunSubmitAnswerBtn');
      if (btn) { btn.disabled = true; btn.textContent = '正在点评…'; }
      const r = await apiFetch('/api/mock-interview/submit-answer', { answer });
      MockState.answeredCount = Number(r.currentIndex) || MockState.answeredCount;
      renderMockFeedback(r.feedback);
      // 如果要追问，UI 会显示追问区，按钮文字切换
      if (r.followup && r.followup.needFollowup) {
        renderMockRunCard({ followup: r.followup });
        toast('面试官想进一步追问，请在下方回答追问题。', 'info', 3200);
      } else {
        toast('点评完成：' + (r.feedback && r.feedback.summary ? r.feedback.summary : ''), 'success', 3600);
      }
      if (ansEl) ansEl.value = '';
    } catch (e) {
      toast('提交回答失败：' + (e.message || ''), 'error', 4200);
    } finally {
      const btn = $('#mockRunSubmitAnswerBtn');
      if (btn) { btn.disabled = false; btn.textContent = '提交回答 / 等待追问'; }
    }
  }

  // 提交追问答案（可能会连续再追问，直到 needContinue=false）
  async function submitMockFollowupAnswer() {
    try {
      const ansEl = $('#mockRunFollowupAnswerTextarea');
      const followupAnswer = ansEl ? ansEl.value : '';
      if (!String(followupAnswer).trim()) { toast('请先输入追问回答', 'warn'); return; }
      const btn = $('#mockRunSubmitFollowupBtn');
      if (btn) { btn.disabled = true; btn.textContent = '正在综合点评…'; }
      const r = await apiFetch('/api/mock-interview/submit-followup', { followupAnswer });
      renderMockFeedback(r.feedback);
      if (r.needContinue) {
        // 继续：更新追问题
        MockState.pendingFollowup = { question: (r.followup && r.followup.question) || '', reason: (r.followup && r.followup.reason) || '' };
        renderMockRunCard({ followup: MockState.pendingFollowup });
        toast('还有追问，请继续作答。', 'info', 3000);
      } else {
        // 本题彻底结束：清 pending，自动给出下一题
        MockState.pendingFollowup = null;
        renderMockRunCard({}); // 清追问块
        toast('本题已完成，正在出下一题…', 'success', 2600);
        const qRes = await apiFetch('/api/mock-interview/next-question', {});
        if (qRes && qRes.done) {
          toast(qRes.message || '题目已完成，请生成复盘。', 'warn');
          hideMockRunCard();
        } else if (qRes) {
          renderMockRunCard(qRes);
        }
      }
      if (ansEl) ansEl.value = '';
    } catch (e) {
      toast('提交追问失败：' + (e.message || ''), 'error', 4200);
    } finally {
      const btn = $('#mockRunSubmitFollowupBtn');
      if (btn) { btn.disabled = false; btn.textContent = '提交追问回答'; }
    }
  }

  // 手动出下一题（用户想跳过当前题时使用）
  //   - 出下一题前先停语音：避免上一题还在录音 → 识别文字串到下一题
  async function nextMockQuestion() {
    try {
      try { await resetMockVoiceRecording(); } catch (_) { /* ignore */ }
      const ansEl = $('#mockAnswerEditor');
      if (ansEl) ansEl.value = '';
      const qRes = await apiFetch('/api/mock-interview/next-question', {});
      if (qRes.done) { toast(qRes.message || '已完成全部题目', 'warn'); hideMockRunCard(); return; }
      renderMockRunCard(qRes);
    } catch (e) {
      toast('出下一题失败：' + (e.message || ''), 'error', 4200);
    }
  }

  // 结束并生成复盘报告
  //   - 复盘前先停语音：保证后续复盘生成阶段不会再往文本框塞识别结果
  async function finalMockReview() {
    try {
      try { await resetMockVoiceRecording(); } catch (_) { /* ignore */ }
      // index.html 中的结束按钮 id 是 mockEndBtn（旧版脚本还写过 mockEndInterviewBtn，这里兼容两种）
      const btn = $('#mockEndBtn') || $('#mockEndInterviewBtn');
      if (btn) { btn.disabled = true; btn.textContent = '正在生成复盘…'; }
      const r = await apiFetch('/api/mock-interview/final-review', {});
      MockState.averageScore = Number(r.averageScore) || 0;
      renderMockFinalReview(r);
      toast(`复盘已生成（平均分 ${MockState.averageScore}），可在面试记录中查看。`, 'success', 5000);
      hideMockRunCard();
    } catch (e) {
      toast('复盘失败：' + (e.message || ''), 'error', 4200);
    } finally {
      const btn = $('#mockEndBtn') || $('#mockEndInterviewBtn');
      if (btn) { btn.disabled = false; btn.textContent = '结束并生成复盘报告'; }
    }
  }

  // 模拟面试记录：调主进程拿最近/进行中 session，然后切到"面试记录"tab 并打开对应详情
  async function openMockInterviewRecords() {
    try {
      const ipc = getIPC();
      if (!ipc) { toast('非 Electron 环境，无法跳转面试记录', 'error'); return; }
      const info = await ipc.invoke('mock-interview-last-session');
      // 通知外层 renderer 去切 tab（用自定义事件，避免耦合 renderer.js 里的函数名）
      window.dispatchEvent(new CustomEvent('hireme:open-session-detail', {
        detail: { activeId: info.activeId, lastId: info.lastId, firstId: info.firstId, source: 'mockInterview' }
      }));
      toast(info && (info.activeId || info.lastId) ? '已切换到面试记录详情' : '暂无记录：完成一次模拟面试后会自动归档。',
        (info && (info.activeId || info.lastId)) ? 'success' : 'warn', 3600);
    } catch (e) {
      toast('打开模拟面试记录失败：' + (e.message || ''), 'error', 4200);
    }
  }

  // ------------------------------------------------------------
  // 3. 简历优化 Panel：状态 + 事件绑定 + UI 更新
  //    实际 DOM id / class 来自 index.html（HireMe 风格），这里严格以其为准：
  //    - resumeFileInput (hidden，与 resumeDropzone 绑定)、resumeOptEditor、resumeOptStatus、
  //      resumeOptCharCount、resumeOptJobEditor、resumeOptStartBtn、resumeOptUploadBtn、
  //      resumeOptClearBtn、resumeOptUseSavedBtn、resumeDropzone、resumeFileInput、
  //      resumeResultCard、scAtsValue、scAtsBody、scKwValue、scKwBody、scContentTitle、scContentBody、
  //      resumeOptOutput、resumeOptExportDocxBtn、resumeOptCopyBtn、resume-lang-btn
  // ------------------------------------------------------------
  const ResumeState = {
    lastOptimizedText: '',   // 内容优化给出的"优化后全文"
    cachedResult: null,      // 最近一次 /api/resume-opt/run 返回
    language: 'zh'           // 简历优化 seg 按钮控制
  };

  // 把 ATS/关键词/内容 三个结果渲染到面板的"3 张评分卡" + 输出区。
  // 兼容 partial 模式：只有对应阶段结果存在时，才会更新该卡片；避免阶段 1 完成就把阶段 2/3 的卡片覆盖成"暂无结果"。
  function renderResumeOptResult(result) {
    const isPartial = !!(result && result.partial);
    ResumeState.cachedResult = result || null;
    // contentOpt 为 null 时不要清掉上次（一般是 partial=kw/ats 阶段）。
    if (result && result.contentOpt && result.contentOpt.optimizedFullText) {
      ResumeState.lastOptimizedText = result.contentOpt.optimizedFullText;
    }
    const ats = result && result.atsScore;
    const kw = result && result.keywordMatch;
    const co = result && result.contentOpt;

    // 显示结果区
    const card = $('#resumeResultCard');
    if (card) card.classList.remove('hidden');

    // 1) ATS 卡（只有传入 atsScore 才更新）
    if (ats) {
      const atsValue = $('#scAtsValue');
      if (atsValue) atsValue.textContent = `${Number(ats.overall) || 0}`;
      const atsBody = $('#scAtsBody');
      if (atsBody) atsBody.innerHTML = lightMarkdown(ats.markdown || '暂无 ATS 评分结果。');
    }

    // 2) 关键词卡：scKwValue 放"命中数/抽取数"，scKwBody 放 markdown（只有传入 keywordMatch 才更新）
    if (kw) {
      const hits = Array.isArray(kw.hits) ? kw.hits : [];
      const found = hits.filter(h => h && h.found).length;
      const kwValue = $('#scKwValue');
      if (kwValue) kwValue.textContent = `${found}/${hits.length}`;
      const kwBody = $('#scKwBody');
      if (kwBody) kwBody.innerHTML = lightMarkdown(kw.markdown || '暂无关键词匹配结果。');
    }

    // 3) 内容优化卡：scContentTitle 放改动条 + 亮点摘要，scContentBody 放 markdown（只有传入 contentOpt 才更新）
    if (co) {
      const coTitle = $('#scContentTitle');
      if (coTitle) {
        const changeCount = Array.isArray(co.changes) ? co.changes.length : 0;
        coTitle.textContent = changeCount ? `已改写 ${changeCount} 处` : '内容已较专业';
      }
      const coBody = $('#scContentBody');
      if (coBody) coBody.innerHTML = lightMarkdown(co.markdown || '暂无内容优化结果。');
      // 4) 优化全文（仅内容优化完成后写入，避免 partial 清空）
      const output = $('#resumeOptOutput');
      if (output && ResumeState.lastOptimizedText) output.value = ResumeState.lastOptimizedText;
    }

    // 5) 在 result-title 上追加耗时（partial 时显示"第 X 阶段完成"，全部完成才显示"分析完成"）
    const titleEl = document.querySelector('#resumeResultCard .resume-result-title');
    if (titleEl) {
      const ms = Number(result && result.elapsedMs) || 0;
      if (isPartial) {
        const partMap = [];
        if (ats) partMap.push('ATS');
        if (kw) partMap.push('关键词');
        if (co) partMap.push('内容');
        titleEl.textContent = `⚙️ 已完成阶段：${partMap.join(' / ')}（${(ms / 1000).toFixed(1)}s）`;
      } else {
        titleEl.textContent = `✅ 分析完成（${(ms / 1000).toFixed(1)}s）`;
        // 只有整体完成才 toast（避免每个阶段都弹一次）
        toast('简历优化已完成，可在下方直接查看并导出 DOCX。', 'success', 4200);
        card && card.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }
  }

  // 单阶段进度提示：直接把阶段信息写到简历 Hero 的副标题（不动原 DOM 结构）
  function setResumeStage(stage) {
    const sub = document.querySelector('#resumePanel .resume-hero-sub');
    if (!sub) return;
    const map = {
      ats: 'ATS 评分 Agent 分析中…',
      keywords: '关键词匹配 Agent 对比中…',
      content: '内容优化 Agent 润色中…'
    };
    // 若原来有原始文案，先缓存一次（只缓存第一次）
    if (typeof sub._origin !== 'string') sub._origin = sub.textContent;
    sub.textContent = `${sub._origin || ''}  ·  ${map[stage] || '处理中…'}`;
  }
  // 收尾：恢复 hero sub 原文
  function clearResumeStage() {
    const sub = document.querySelector('#resumePanel .resume-hero-sub');
    if (sub && typeof sub._origin === 'string') sub.textContent = sub._origin;
  }

  // 工具：把"简历解析结果"写到 resumeOptEditor，并同步状态 + 字数
  function writeResumeText(txt, parserNote) {
    const ta = $('#resumeOptEditor');
    if (!ta) return;
    ta.value = String(txt || '');
    // 状态 + 字数
    const st = $('#resumeOptStatus');
    if (st) st.textContent = parserNote || '已加载';
    const cc = $('#resumeOptCharCount');
    if (cc) cc.textContent = String(ta.value.length);
  }

  // 启动简历优化：串行调用三条独立路由（ATS → 关键词 → 内容），每完成一张卡真实渲染一张。
  // 为什么拆三条路由而不是一次性 /run：
  //   1) 进度感知更真实（用户看到 ATS 先出卡、再关键词、再内容，不再是"一个进度条 + 等很久突然三张一起出"）；
  //   2) 其中一步失败时，已完成的卡片仍可见，便于用户定位问题；
  //   3) 老入口 /run 仍保留在后端，给详情页/未来批量任务兜底。
  async function runResumeOptimize() {
    const resumeEl = $('#resumeOptEditor');
    const resumeText = resumeEl ? resumeEl.value : '';
    if (String(resumeText).trim().length < 50) { toast('简历文本过短（至少 50 字），请先上传/粘贴。', 'warn'); return; }
    const jdEl = $('#resumeOptJobEditor');
    const jdText = jdEl ? jdEl.value : '';
    const language = ResumeState.language;

    // 每次重新开始：先清掉缓存 + 清空三张卡，避免叠加旧结果
    ResumeState.cachedResult = null;
    ResumeState.lastOptimizedText = '';
    const atsBody = $('#scAtsBody'), atsValue = $('#scAtsValue');
    const kwBody = $('#scKwBody'), kwValue = $('#scKwValue');
    const ctBody = $('#scContentBody'), ctTitle = $('#scContentTitle');
    const output = $('#resumeOptOutput');
    const card = $('#resumeResultCard');
    const titleEl = document.querySelector('#resumeResultCard .resume-result-title');
    [atsValue, kwValue].forEach(el => el && (el.textContent = '—'));
    [atsBody, kwBody, ctBody].forEach(el => el && (el.innerHTML = '<div style="opacity:.6;font-size:13px;">等待分析…</div>'));
    if (ctTitle) ctTitle.textContent = '—';
    if (output) output.value = '';
    if (card) card.classList.remove('hidden');

    try {
      const btn = $('#resumeOptStartBtn');
      if (btn) { btn.disabled = true; btn.innerHTML = '<span>&#9889;</span> AI 分析优化中…'; }

      const startedAt = Date.now();

      // Stage 1：ATS
      setResumeStage('ats');
      let ats = null, kw = null, co = null;
      try {
        const r1 = await apiFetch('/api/resume-opt/ats', { resumeText, jdText, language });
        ats = r1 && r1.result;
        // 用局部结果只渲染 ATS 卡（渲染函数内部要兼容"缺 kw/co"）
        renderResumeOptResult({ atsScore: ats, keywordMatch: null, contentOpt: null, elapsedMs: Date.now() - startedAt, partial: true });
      } catch (e) {
        // ATS 失败：不要中断，给卡片一个错误提示，并继续后续阶段（用户可看关键词/内容的输出）
        if (atsValue) atsValue.textContent = '✖';
        if (atsBody) atsBody.innerHTML = `<div style="color:#f87171;font-size:13px;">ATS 阶段失败：${String(e.message || e).replace(/</g, '&lt;')}</div>`;
        toast('ATS 评分阶段失败：' + (e.message || ''), 'warn', 4200);
      }

      // Stage 2：关键词
      setResumeStage('keywords');
      try {
        const r2 = await apiFetch('/api/resume-opt/keywords', { resumeText, jdText, language });
        kw = r2 && r2.result;
        renderResumeOptResult({ atsScore: ats, keywordMatch: kw, contentOpt: null, elapsedMs: Date.now() - startedAt, partial: true });
      } catch (e) {
        if (kwValue) kwValue.textContent = '✖';
        if (kwBody) kwBody.innerHTML = `<div style="color:#f87171;font-size:13px;">关键词阶段失败：${String(e.message || e).replace(/</g, '&lt;')}</div>`;
        toast('关键词匹配阶段失败：' + (e.message || ''), 'warn', 4200);
      }

      // Stage 3：内容优化
      setResumeStage('content');
      try {
        const r3 = await apiFetch('/api/resume-opt/content', { resumeText, jdText, language });
        co = r3 && r3.result;
        // 最后一次用完整结果渲染：3 卡 + 全文 + 标题完成标记
        renderResumeOptResult({ atsScore: ats, keywordMatch: kw, contentOpt: co, elapsedMs: Date.now() - startedAt });
      } catch (e) {
        if (ctTitle) ctTitle.textContent = '内容优化失败';
        if (ctBody) ctBody.innerHTML = `<div style="color:#f87171;font-size:13px;">内容优化阶段失败：${String(e.message || e).replace(/</g, '&lt;')}</div>`;
        toast('内容优化阶段失败：' + (e.message || ''), 'warn', 4200);
        // 仍然把已完成的 ATS + 关键词卡片保留，并让用户知道整体完成
        if (titleEl) titleEl.textContent = `⚠️ 分析完成，但内容优化失败（${((Date.now() - startedAt) / 1000).toFixed(1)}s）`;
        card && card.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    } catch (e) {
      toast('简历优化失败：' + (e.message || ''), 'error', 5200);
    } finally {
      clearResumeStage();
      const btn = $('#resumeOptStartBtn');
      if (btn) { btn.disabled = false; btn.innerHTML = '<span>&#9889;</span> 开始分析优化<span class="rcta-arrow">&#10140;</span>'; }
    }
  }

  // 导出 DOCX：先弹保存框拿 savePath，再调 HTTP 路由生成 docx 写入磁盘
  async function exportOptimizedDOCX() {
    const ipc = getIPC();
    if (!ipc) { toast('非 Electron 环境，无法导出 DOCX', 'error'); return; }
    const ta = $('#resumeOptOutput');
    const content = (ta && ta.value && ta.value.trim()) ? ta.value.trim() : ResumeState.lastOptimizedText;
    if (!content) { toast('暂无优化后全文：请先执行『AI 分析与优化』。', 'warn'); return; }
    try {
      const save = await ipc.invoke('save-file-dialog', {
        title: '导出优化后简历为 DOCX',
        defaultPath: '优化后简历.docx',
        filters: [{ name: 'Word 文档', extensions: ['docx'] }, { name: '所有文件', extensions: ['*'] }]
      });
      if (!save || !save.success) return; // 用户取消
      const r = await apiFetch('/api/resume-opt/export-docx', { content, savePath: save.filePath });
      toast(`已导出：${save.filePath}（${(r.bytes / 1024).toFixed(1)} KB）`, 'success', 5200);
    } catch (e) {
      toast('导出 DOCX 失败：' + (e.message || ''), 'error', 5200);
    }
  }

  // 复制优化版内容（浏览器 API）
  async function copyOptimizedText() {
    const ta = $('#resumeOptOutput');
    const content = (ta && ta.value) ? ta.value : ResumeState.lastOptimizedText;
    if (!content) { toast('暂无可复制内容', 'warn'); return; }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(content);
      } else {
        if (ta) { ta.select(); document.execCommand('copy'); }
      }
      toast('已复制优化版内容到剪贴板', 'success', 2400);
    } catch (e) {
      toast('复制失败：' + (e.message || ''), 'error');
    }
  }

  // ------------------------------------------------------------
  // 4. 绑定事件：严格以 index.html 当前的 id / class 为准
  // ------------------------------------------------------------
  function bindEvents() {
    // 4.1 模拟面试类型卡片（单选）
    $$('#mockInterviewTypeGrid .mock-type').forEach(btn => {
      btn.addEventListener('click', () => setMockInterviewType(btn.getAttribute('data-type')));
    });
    // 初始化：先根据 DOM 里带 active 的类型来设（若无，则默认 comprehensive）
    const firstActive = document.querySelector('#mockInterviewTypeGrid .mock-type.active');
    setMockInterviewType(firstActive ? firstActive.getAttribute('data-type') : MockState.type);

    // 4.2 模拟面试：作答方式按钮
    $$('.mock-ans-mode').forEach(btn => {
      btn.addEventListener('click', () => setMockAnswerMode(btn.getAttribute('data-mode')));
    });
    // 初始化作答方式（根据 DOM active）
    const ansActive = document.querySelector('.mock-ans-mode.active');
    setMockAnswerMode(ansActive ? ansActive.getAttribute('data-mode') : 'text');

    // 4.3 模拟面试主按钮 / 进行中按钮 / 记录按钮
    if ($('#mockStartBtn')) $('#mockStartBtn').addEventListener('click', startMockInterview);
    if ($('#mockSubmitAnswerBtn')) $('#mockSubmitAnswerBtn').addEventListener('click', submitMockAnswer);
    if ($('#mockEndBtn')) $('#mockEndBtn').addEventListener('click', finalMockReview);
    if ($('#mockViewHistoryBtn')) $('#mockViewHistoryBtn').addEventListener('click', openMockInterviewRecords);
    // 可选：存在 mockHintBtn 时，作为"出下一题（跳过点评继续）"
    if ($('#mockHintBtn')) $('#mockHintBtn').addEventListener('click', () => {
      // 先用一个轻提示：若当前 pendingFollowup，则把当前输入框当作追问回答提交；否则下一题
      if (MockState.pendingFollowup && MockState.pendingFollowup.question) {
        submitMockAnswerOrFollowupAuto();
      } else {
        nextMockQuestion();
      }
    });
    // 回车键提交（在 mockAnswerEditor 里回车）
    if ($('#mockAnswerEditor')) {
      $('#mockAnswerEditor').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          submitMockAnswerOrFollowupAuto();
        }
      });
    }

    // 4.4 模拟面试：简历入口
    // mockPasteResumeBtn：点击即聚焦编辑器并提示粘贴
    if ($('#mockPasteResumeBtn')) {
      $('#mockPasteResumeBtn').addEventListener('click', () => {
        const dst = $('#mockResumeEditor');
        if (dst) { dst.focus(); toast('请使用 Ctrl+V 粘贴简历文本', 'info', 2000); }
      });
    }
    // mockUseSavedResumeBtn：如果有"已保存简历"（renderer.js 里通常存在 appState.config.resumeText），直接把它同步过来
    if ($('#mockUseSavedResumeBtn')) {
      $('#mockUseSavedResumeBtn').addEventListener('click', async () => {
        try {
          const ipc = getIPC();
          const cfg = ipc ? (await ipc.invoke('get-config')) : null;
          const src = (cfg && cfg.resumeText) ? cfg.resumeText : '';
          const dst = $('#mockResumeEditor');
          if (dst) dst.value = src;
          const box = $('#mockResumeLoadedBody');
          if (box) box.textContent = src ? `已加载（${src.length} 字）` : '—';
          toast(src ? '已加载已保存简历' : '当前未保存简历，请直接粘贴或上传。', src ? 'success' : 'warn', 2600);
        } catch (e) {
          toast('读取已保存简历失败：' + (e.message || ''), 'error');
        }
      });
    }
    // mockUploadResumeBtn：IPC 对话框上传 + 解析，结果写入 mockResumeEditor
    if ($('#mockUploadResumeBtn')) {
      $('#mockUploadResumeBtn').addEventListener('click', async () => {
        const ipc = getIPC();
        if (!ipc) return;
        const r = await ipc.invoke('open-file-dialog', {
          title: '选择简历文件（模拟面试用）',
          filters: [
            { name: '简历文件', extensions: ['docx', 'pdf', 'txt', 'md'] },
            { name: '所有文件', extensions: ['*'] }
          ]
        });
        if (!r || !r.success) return;
        try {
          toast('正在解析简历…', 'info', 1600);
          const ext = getExt(r.filePath);
          const resp = await apiFetch('/api/resume-opt/parse-file', { ext, filePath: r.filePath });
          const ta = $('#mockResumeEditor');
          if (ta) ta.value = (resp && resp.text) ? resp.text : '';
          const box = $('#mockResumeLoadedBody');
          if (box) box.textContent = resp && resp.text ? `已加载（${resp.text.length} 字，解析器=${resp.parser || 'raw'}）` : '—';
          if (resp && resp.ok) toast('简历解析完成', 'success');
          else toast('解析：' + (resp.msg || '已回退纯 UTF-8'), 'warn', 4000);
        } catch (e) {
          toast('上传简历失败：' + (e.message || ''), 'error');
        }
      });
    }

    // 4.5 简历优化：seg 按钮（zh/en）
    $$('.resume-lang-btn').forEach(btn => {
      btn.addEventListener('click', () => setResumeLang(btn.getAttribute('data-lang')));
    });
    const firstLang = document.querySelector('.resume-lang-btn.active');
    setResumeLang(firstLang ? firstLang.getAttribute('data-lang') : 'zh');

    // 4.6 简历优化：上传 PDF/DOCX 按钮 / dropzone / 隐藏 input
    if ($('#resumeOptUploadBtn')) $('#resumeOptUploadBtn').addEventListener('click', pickResumeViaIPC);
    if ($('#resumeDropzone')) {
      // dropzone 是 <label for=resumeFileInput>，点击即触发隐藏 input 的系统文件选择；这里再额外绑定 IPC 更顺手
      $('#resumeDropzone').addEventListener('click', async (e) => {
        const ipc = getIPC();
        if (!ipc) return; // Electron 环境才接管，否则走原生 label->input
        e.preventDefault();
        await pickResumeViaIPC();
      });
    }
    if ($('#resumeFileInput')) {
      $('#resumeFileInput').addEventListener('change', (e) => {
        const files = e.target && e.target.files;
        if (files && files[0]) parseResumeFileInputToOptEditor(files[0]);
      });
    }

    // 4.7 简历优化：使用已保存 / 清空
    if ($('#resumeOptUseSavedBtn')) {
      $('#resumeOptUseSavedBtn').addEventListener('click', async () => {
        try {
          const ipc = getIPC();
          const cfg = ipc ? (await ipc.invoke('get-config')) : null;
          const src = (cfg && cfg.resumeText) ? cfg.resumeText : '';
          writeResumeText(src, src ? `已加载（${src.length} 字）` : '尚未保存');
          toast(src ? '已加载已保存简历' : '当前未保存简历，请粘贴或上传。', src ? 'success' : 'warn', 2600);
        } catch (e) {
          toast('读取已保存简历失败：' + (e.message || ''), 'error');
        }
      });
    }
    if ($('#resumeOptClearBtn')) {
      $('#resumeOptClearBtn').addEventListener('click', () => {
        writeResumeText('', '已清空');
      });
    }

    // 4.8 简历优化：字数实时计数
    if ($('#resumeOptEditor')) {
      $('#resumeOptEditor').addEventListener('input', (e) => {
        const cc = $('#resumeOptCharCount');
        if (cc) cc.textContent = String((e.target && e.target.value && e.target.value.length) || 0);
      });
    }

    // 4.9 简历优化：CTA + 导出 + 复制
    if ($('#resumeOptStartBtn')) $('#resumeOptStartBtn').addEventListener('click', runResumeOptimize);
    if ($('#resumeOptExportDocxBtn')) $('#resumeOptExportDocxBtn').addEventListener('click', exportOptimizedDOCX);
    if ($('#resumeOptCopyBtn')) $('#resumeOptCopyBtn').addEventListener('click', copyOptimizedText);
  }

  // 辅助：模拟面试里"用户同时用一个输入框回答主问题和追问"的智能提交
  //   提交流程：停录音 → 提交当前答案 → 如果不需要追问则出下一题 → 清空输入框
  async function submitMockAnswerOrFollowupAuto() {
    try {
      // 提交前先停语音录音：保证 finalText 全量落定、文本框内容不再被 interim 覆盖
      try { await resetMockVoiceRecording(); } catch (_) { /* ignore */ }
      const ansEl = $('#mockAnswerEditor');
      const text = ansEl ? ansEl.value : '';
      if (!String(text).trim()) { toast('请先输入回答或追问回答', 'warn'); return; }
      if (MockState.pendingFollowup && MockState.pendingFollowup.question) {
        // 有 pendingFollowup → 走 submit-followup
        const ans = text;
        MockState.pendingFollowup && (MockState.pendingFollowup.curAnswer = ans); // 仅调试
        const r = await apiFetch('/api/mock-interview/submit-followup', { followupAnswer: ans });
        renderMockFeedback(r.feedback);
        if (r.needContinue) {
          // 还有连续追问：保留输入框，用户继续在下一轮追问作答
          MockState.pendingFollowup = { question: (r.followup && r.followup.question) || '', reason: (r.followup && r.followup.reason) || '' };
          renderMockRunCard({ followup: MockState.pendingFollowup });
          toast('还有追问，请继续作答。', 'info', 3000);
        } else {
          MockState.pendingFollowup = null;
          renderMockRunCard({}); // 清追问
          toast('本题已完成，正在出下一题…', 'success', 2600);
          // 出下一题前先清输入框 + 额外一次语音重置（双重保险）
          if (ansEl) ansEl.value = '';
          try { await resetMockVoiceRecording(); } catch (_) { /* ignore */ }
          const qRes = await apiFetch('/api/mock-interview/next-question', {});
          if (qRes && qRes.done) { toast(qRes.message || '题目已完成，请点击结束生成复盘', 'warn'); hideMockRunCard(); }
          else if (qRes) renderMockRunCard(qRes);
        }
        if (ansEl) ansEl.value = '';
      } else {
        // 无 pendingFollowup → 走 submit-answer（主答案提交）
        await submitMockAnswer();
        // 提交完回答，若此时需要追问，仍保留同一输入框（用户自然继续在其内打字作答即可）
      }
    } catch (e) {
      toast('提交失败：' + (e.message || ''), 'error', 4200);
    }
  }

  // 辅助：文件 input → 解析 → 写入 resumeOptEditor（对应 index.html：resumeFileInput）
  async function parseResumeFileInputToOptEditor(file) {
    if (!file) return;
    const ext = getExt(file.name) || 'txt';
    if (!['docx', 'pdf', 'txt', 'md', 'doc'].includes(ext)) {
      toast('暂不支持该格式，可选 DOCX / PDF / TXT', 'warn'); return;
    }
    try {
      toast('正在解析简历文件…', 'info', 1800);
      const b64 = await fileToBase64(file);
      const r = await apiFetch('/api/resume-opt/parse-file', { ext, fileBase64: b64 });
      writeResumeText(r && r.text ? r.text : '', r.ok
        ? `已加载 · ${r.parser || 'utf8'} · ${Math.round(Number(r.sizeKB) || 0)}KB`
        : `已回退 · ${r.msg || 'utf8'}`);
      if (r.ok) toast('简历解析成功', 'success', 3000);
      else toast('解析：' + (r.msg || '已回退纯 UTF-8'), 'warn', 4200);
    } catch (e) {
      toast('解析简历失败：' + (e.message || ''), 'error', 4200);
    }
  }

  // 覆盖 submitMockAnswer / submitMockFollowupAnswer 的入口 DOM 选择：直接改成 mock 实际 DOM 的 id
  // 原因：旧 submitMockAnswer 读的是旧 id；现在统一用 mockAnswerEditor + 智能提交函数
  //   - 提交前先停语音（resetMockVoiceRecording），保证 textarea 里 interim/final 全部合并后再提交
  async function submitMockAnswer() {
    try {
      // 先停语音：让 ASR 的最后一段 final 落定，避免提交后的内容还会被 interim 修改
      try { await resetMockVoiceRecording(); } catch (_) { /* ignore */ }
      const ansEl = $('#mockAnswerEditor');
      const answer = ansEl ? ansEl.value : '';
      if (!String(answer).trim()) { toast('请先输入回答', 'warn'); return; }
      const btn = $('#mockSubmitAnswerBtn');
      if (btn) { btn.disabled = true; btn.textContent = '正在点评…'; }
      const r = await apiFetch('/api/mock-interview/submit-answer', { answer });
      MockState.answeredCount = Number(r.currentIndex) || MockState.answeredCount;
      renderMockFeedback(r.feedback);
      if (r.followup && r.followup.needFollowup) {
        renderMockRunCard({ followup: r.followup });
        toast('面试官想进一步追问，请在同一输入框再次输入后按 Ctrl+Enter 提交。', 'info', 3600);
      } else {
        toast('点评完成：' + (r.feedback && r.feedback.summary ? r.feedback.summary : ''), 'success', 3600);
      }
      if (ansEl) ansEl.value = '';
    } catch (e) {
      toast('提交回答失败：' + (e.message || ''), 'error', 4200);
    } finally {
      const btn = $('#mockSubmitAnswerBtn');
      if (btn) { btn.disabled = false; btn.textContent = '提交回答'; }
    }
  }

  async function submitMockFollowupAnswer() {
    // 实际入口已统一合并到 Ctrl+Enter，但为 window.HireMeMockResume 暴露保留一个实现
    return submitMockAnswerOrFollowupAuto();
  }

  // 初始化：DOM 就绪即绑定
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindEvents);
  } else {
    bindEvents();
  }

  // 暴露少量 API 给外层（如未来想通过控制台调试）
  window.HireMeMockResume = {
    state: { MockState, ResumeState },
    startMockInterview, submitMockAnswer, submitMockFollowupAnswer, nextMockQuestion, finalMockReview,
    runResumeOptimize, exportOptimizedDOCX
  };
})();
