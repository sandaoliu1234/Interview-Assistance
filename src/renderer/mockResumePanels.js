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
  // 0.1 Electron IPC 双通道封装（解决『window.electronAPI 部分字段缺失』导致的功能完全不可用）
  //   - 通道 A：window.electronAPI.<camelName>(...)   // preload.js contextBridge / 兜底赋值
  //   - 通道 B：ipcRenderer.invoke('<kebab-channel>',  // nodeIntegration=true 时一定可用（主窗口 webPreferences 配置了）
  //   - 设计：永远先尝试通道 A，字段不存在 / 抛错 / 返回 falsy 时，自动走通道 B；B 也不可用才抛错
  // ------------------------------------------------------------
  /**
   * 打开模拟面试浮动面板
   * @param {object} params 启动参数（answerMode / totalQuestions / serverInfo 等）
   * @returns {Promise<{success:boolean, status?:object}>}
   */
  async function ipc_openMockFloatWin(params) {
    // 通道 A：preload bridge
    if (window.electronAPI && typeof window.electronAPI.openMockInterviewFloatWin === 'function') {
      try { return await window.electronAPI.openMockInterviewFloatWin(params || {}); }
      catch (e) { console.warn('[ipc-fallback] electronAPI.openMockInterviewFloatWin 异常，退回 ipcRenderer.invoke：', e.message); }
    }
    // 通道 B：ipcRenderer 直连（主窗口 nodeIntegration=true，一定能拿到）
    const ipc = getIPC();
    if (!ipc) throw new Error('Electron IPC 不可用：请在 Electron 窗口环境中使用该功能。');
    return ipc.invoke('open-mock-interview-floatwin', params || {});
  }
  /**
   * 查询模拟面试浮动面板是否存在 + bounds
   * @returns {Promise<{exists:boolean, bounds:object|null}>}
   */
  async function ipc_getMockFloatStatus() {
    if (window.electronAPI && typeof window.electronAPI.mockInterviewFloatStatus === 'function') {
      try { return await window.electronAPI.mockInterviewFloatStatus(); }
      catch (e) { console.warn('[ipc-fallback] electronAPI.mockInterviewFloatStatus 异常，退回 ipcRenderer.invoke：', e.message); }
    }
    const ipc = getIPC();
    if (!ipc) return { exists: false, bounds: null };
    try { return await ipc.invoke('mock-interview-floatwin-status'); }
    catch (_) { return { exists: false, bounds: null }; }
  }
  /**
   * 获取本地 HTTP/WS 服务状态快照（含 port / token / baseUrl / ip 列表）
   * @returns {Promise<object|null>}
   */
  async function ipc_getServerStatus() {
    if (window.electronAPI && typeof window.electronAPI.getServerStatus === 'function') {
      try { return await window.electronAPI.getServerStatus(); }
      catch (e) { console.warn('[ipc-fallback] electronAPI.getServerStatus 异常，退回 ipcRenderer.invoke：', e.message); }
    }
    const ipc = getIPC();
    if (!ipc) return null;
    try { return await ipc.invoke('get-server-status'); }
    catch (_) { return null; }
  }
  /**
   * 获取 HTTP 客户端专用『扁平结构』基础信息：{ok, port, token, baseUrl, isRunning}
   *   - 对应 main.js 的 get-server-http-info：若服务未启动会自动启动；返回值扁平，无嵌套，避免 status.status.port 层级错读
   *   - 模拟面试 startParams.serverInfo 推荐用此函数（稳定、字段对齐、无需解包 status 层）
   * @returns {Promise<{ok:boolean, port:number, token:string, baseUrl:string, isRunning:boolean, status?:object}|null>}
   */
  async function ipc_getHttpInfo() {
    // 通道 A：preload bridge（若存在）—— preload.js _apiImpl 中含 getServerStatus，但没有 getHttpInfo；此处统一走双通道封装，缺失时自动回退
    if (window.electronAPI && typeof window.electronAPI.getHttpInfo === 'function') {
      try { return await window.electronAPI.getHttpInfo(); }
      catch (e) { console.warn('[ipc-fallback] electronAPI.getHttpInfo 异常，退回 ipcRenderer.invoke：', e.message); }
    }
    const ipc = getIPC();
    if (!ipc) return null;
    try { return await ipc.invoke('get-server-http-info'); }
    catch (_) { return null; }
  }

  /** 取文件扩展名（小写，不带点），用于解析器分派 & accept 匹配。 */
  function getExt(filePathOrName) {
    const s = String(filePathOrName || '').trim();
    const idx = s.lastIndexOf('.');
    if (idx < 0 || idx === s.length - 1) return '';
    return s.slice(idx + 1).toLowerCase();
  }
  /** 把浏览器 File 对象（来自 <input type=file>）转成 dataURL / base64 字符串，供 /api/resume-opt/parse-file 的 fileBase64 参数使用。
   *  返回值不带 data:xxx;base64, 前缀（只返回纯 base64 正文），服务端要求这种形式。 */
  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      if (!file) { reject(new Error('文件为空')); return; }
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('读取文件失败'));
      reader.onload = () => {
        const result = String(reader.result || '');
        // 去掉 data:application/pdf;base64, 这种前缀，保留纯 base64 正文
        const comma = result.indexOf(',');
        resolve(comma >= 0 ? result.slice(comma + 1) : result);
      };
      reader.readAsDataURL(file);
    });
  }
  /** 简历优化面板：通用简历上传入口（IPC 对话框 优先生效；没有 IPC 时退回原生 <input> 系统选择）。
   *  上传成功后，调用 /api/resume-opt/parse-file 接口解析 docx/pdf/txt，并把结果写入 resumeOptEditor，同步状态和字数。 */
  async function pickResumeViaIPC() {
    const ACCEPT_EXT = ['docx', 'pdf', 'txt', 'md', 'doc'];
    const ipc = getIPC();
    // ---- 路径 A：Electron IPC 打开系统选文件对话框 ----
    if (ipc) {
      try {
        const r = await ipc.invoke('open-file-dialog', {
          title: '选择简历文件（简历优化用）',
          filters: [
            { name: '简历文件', extensions: ACCEPT_EXT },
            { name: '所有文件', extensions: ['*'] }
          ]
        });
        if (!r || !r.success) return; // 用户取消对话框，静默不报错
        try {
          toast('正在解析简历文件…', 'info', 1800);
          const ext = getExt(r.filePath) || 'txt';
          const resp = await apiFetch('/api/resume-opt/parse-file', { ext, filePath: r.filePath });
          writeResumeText(resp && resp.text ? resp.text : '',
            resp && resp.ok
              ? `已加载 · ${resp.parser || 'utf8'} · ${Math.round(Number(resp.sizeKB) || 0)}KB`
              : `已回退 · ${resp && resp.msg ? resp.msg : 'utf8'}`);
          if (resp && resp.ok) toast('简历解析成功', 'success', 3000);
          else toast('解析：' + ((resp && resp.msg) || '已回退纯 UTF-8'), 'warn', 4200);
          return;
        } catch (e) {
          toast('解析简历文件失败：' + (e.message || ''), 'error', 4200);
          return;
        }
      } catch (e) {
        // IPC 调不起（比如 dev-server 但代码误判 hasIPC），降级为路径 B
        console.warn('[resumeOpt] IPC 上传不可用，退回原生 input 模式：', e.message);
      }
    }
    // ---- 路径 B：无 IPC / 浏览器模式：触发 HTML 里已有的隐藏 <input id="resumeFileInput"> 打开系统选文件 ----
    const hiddenInput = document.getElementById('resumeFileInput');
    if (!hiddenInput) {
      toast('当前环境缺少文件选择控件，请先手动粘贴文本或使用 Electron 模式。', 'warn', 4200);
      return;
    }
    // 如果 <input> 已经被用户选过同一个路径再次点不上（浏览器限制 change 不触发），这里清空 value 保证每次都能弹
    try { hiddenInput.value = ''; } catch (_) { /* ignore */ }
    // 监听一次性 change：用户选完后自动解析
    const resolveOnce = (file) => {
      if (file) parseResumeFileInputToOptEditor(file);
    };
    const changeHandler = (e) => {
      const files = e.target && e.target.files;
      const f = files && files[0];
      resolveOnce(f);
      hiddenInput.removeEventListener('change', changeHandler);
    };
    hiddenInput.addEventListener('change', changeHandler);
    try {
      hiddenInput.click();
    } catch (e) {
      toast('无法弹出文件选择框：' + (e.message || ''), 'error', 3600);
      hiddenInput.removeEventListener('change', changeHandler);
    }
  }
  /** 简历优化面板：刷新右上角字数标签 + 状态卡片。
   *  - 每次从 resumeOptEditor 真实 value 计算，避免被内部缓存蒙混
   *  - 若传入 noteText（如"已加载"/"已清空"）会同时改 resumeOptStatus
   */
  function syncResumeOptCharCount(noteText) {
    const ta = document.getElementById('resumeOptEditor');
    const cc = document.getElementById('resumeOptCharCount');
    const st = document.getElementById('resumeOptStatus');
    const len = ta && ta.value ? ta.value.length : 0;
    if (cc) cc.textContent = String(len);
    if (st && typeof noteText === 'string' && noteText) st.textContent = noteText;
  }
  /** 简历优化面板：DOM 就绪后的一次性引导。
   *  - 立即刷新一次字数（防止用户"先看到 0，粘贴后不变"的视觉不一致）
   *  - 如果本地 cfg.resumeText 存在且编辑器为空，自动回填已保存简历（与 resumeOptUseSavedBtn 行为一致，但不弹成功 toast 避免打扰） */
  async function bootResumeOptUI() {
    // 先做一次计数兜底（即使编辑器完全空，也要保证字符数真实是 0，不是残留的脏值）
    syncResumeOptCharCount();
    const ta = document.getElementById('resumeOptEditor');
    if (ta && ta.value) return; // 用户已粘贴或之前 boot 过，不再覆盖
    try {
      const ipc = getIPC();
      const cfg = ipc ? (await ipc.invoke('get-config')) : null;
      // 兼容两种字段名：resumeContent / resumeText（项目约束）
      const saved = cfg && (cfg.resumeContent || cfg.resumeText);
      if (saved) {
        writeResumeText(saved, `已自动加载 · ${saved.length} 字`);
      }
    } catch (_) { /* boot 过程读取失败不影响用户手动粘贴 */ }
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

  /** 面试类型 code → 中文显示标签映射（浮窗 miTypeBadge 用） */
  function _interviewTypeLabel(typeCode) {
    const map = { behavior: '行为面', technical: '技术面', programming: '编程面', comprehensive: '综合面' };
    return map[typeCode] || String(typeCode || '综合');
  }

  // 主：启动模拟面试 —— 【新版浮动面板模式】
  // 流程：collectForm → 校验 → /session 启动会话 → 构建 startParams →
  //       electronAPI.openMockInterviewFloatWin(params) → 锁定主窗口表单 →
  //       启动浮窗状态轮询（关闭后自动解锁）
  // 主窗口内不再显示 mockRunCard（run-card 仅浮窗渲染）；
  // 若浮窗已存在则不重复开新会话，仅提示用户"前往浮窗"。
  async function startMockInterview() {
    try {
      const btn = $('#mockStartBtn');
      // ========== 前置：若浮窗已存在（进行中）→ 不再重复启动，仅 toast 引导用户前往 ==========
      //   使用双通道封装（ipc_*）：优先 electronAPI bridge，失败自动退回 ipcRenderer.invoke，彻底避免"字段不存在"报错
      const floatSt0 = await ipc_getMockFloatStatus();
      if (floatSt0 && floatSt0.exists) {
        // 浮窗已存在：把它重新 show+focus（main.js 内 openMockInterviewFloatWin 幂等，已存在只 show）
        try { await ipc_openMockFloatWin({}); } catch (_) { /* ignore */ }
        toast('模拟面试进行中，已切换到浮动面板窗口作答。', 'info', 2800);
        return;
      }
      // ========== 启动前：清理主窗口上一场的语音缓存（跨会话串字兜底） ==========
      try { await resetMockVoiceRecording(); } catch (_) { /* ignore */ }
      if (btn) { btn.disabled = true; btn.innerHTML = '<span>&#9889;</span> 正在启动模拟面试…'; }
      // ========== 收集表单 + 校验 ==========
      const form = collectMockForm();
      const invalidMsg = validateMockForm(form);
      if (invalidMsg) { toast(invalidMsg, 'warn'); throw new Error(invalidMsg); }
      // ========== 1. 调 /session 启动会话（初始化 mi history / session 归档 / agents 上下文） ==========
      const sessionRes = await apiFetch('/api/mock-interview/session', form);
      MockState.totalQuestions = Number(form.totalQuestions) || 5;
      MockState.answeredCount = 0;
      MockState.answerMode = form.answerMode; // 确保启动后与表单一致
      toast('模拟面试会话已启动，正在打开浮动面板…', 'info', 2400);

      // ========== 2. 构建 serverInfo（传递给浮窗，让浮窗直接用 baseUrl+token 调用 HTTP，不再走 getServerStatus 兜底） ==========
      //    - 用『ipc_getHttpInfo』（对应 main.js get-server-http-info）：若 server 未启动会自动启动 + 返回扁平 {ok,port,token,baseUrl}
      //      （不再用 ipc_getServerStatus，其返回结构是嵌套 {ok, status:{port,token,...}}，容易发生 st.status.port 层级错读导致 port=0）
      let serverInfo = { port: 0, token: '', baseUrl: '' };
      try {
        // ensureHTTP：先让主窗口的 _httpInfo 缓存被填充（如果失败会被下一行 ipc_getHttpInfo 再次尝试，双重保障）
        await ensureHTTP().catch(() => null);
        const info = await ipc_getHttpInfo();
        if (info && info.ok && Number(info.port) > 0 && String(info.token || '').length > 0) {
          serverInfo = {
            port: Number(info.port) || 0,
            token: String(info.token || ''),
            baseUrl: String(info.baseUrl || `http://127.0.0.1:${Number(info.port) || 0}`)
          };
        }
      } catch (e) {
        console.warn('[mock-interview][start] ipc_getHttpInfo 失败（主进程会再注入一次真实值，非致命）：', e && e.message);
      }

      // ========== 3. 组装浮窗启动参数（严格对齐 mockInterviewFloatRenderer.js bootMockInterviewFloat 期望） ==========
      const startParams = {
        answerMode: form.answerMode === 'voice' ? 'voice' : 'text',
        totalQuestions: MockState.totalQuestions,
        language: form.language === 'en' ? 'en' : 'zh',
        interviewType: form.type,
        typeLabel: _interviewTypeLabel(form.type),
        positionLabel: form.targetPosition,
        industryLabel: form.industry,
        serverInfo
      };

      // ========== 4. 打开浮动面板：双通道 IPC（优先 electronAPI bridge，失败自动退回 ipcRenderer.invoke） ==========
      //   不再有"electronAPI.xxx 不可用"的硬错误——只要主窗口在 Electron 中，nodeIntegration=true 一定能通过 ipcRenderer.invoke 成功
      const openRes = await ipc_openMockFloatWin(startParams);
      if (!openRes || !openRes.success) {
        throw new Error((openRes && openRes.msg) || '浮动面板打开失败');
      }

      // ========== 5. 主窗口：隐藏主窗口 run-card（避免冲突）+ 锁定表单 + 启动轮询 ==========
      hideMockRunCard();
      setMockFormLocked(true);
      startMockFloatWinStatusPoller();
      toast(`已打开浮动面板（${form.answerMode === 'voice' ? '语音作答' : '文字作答'}，共 ${MockState.totalQuestions} 题，模式已锁定）。`, 'success', 4200);
    } catch (e) {
      toast('启动失败：' + (e.message || '未知错误'), 'error', 4200);
      console.error('[mock-interview] start 异常：', e);
      // 失败：解锁表单，还原按钮文案
      setMockFormLocked(false);
    } finally {
      // finally 只还原按钮 disabled（文案由 setMockFormLocked 控制，避免"锁定时被 finally 覆盖回『开始模拟面试』"）
      const btn = $('#mockStartBtn');
      if (btn) btn.disabled = false;
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
      // 用户要求：点击按钮 → 打开面试记录页，并自动切到『🎯 模拟面试』分类 Tab（查看所有模拟面试记录）
      // 派发自定义事件，外层 renderer.js 负责路由 + Tab 切换（保持此处与 renderer 内部解耦）
      window.dispatchEvent(new CustomEvent('hireme:open-session-detail', {
        detail: { category: 'mock', source: 'mockInterview' }
      }));
      toast('已切换到『🎯 模拟面试』记录列表。', 'success', 2800);
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

  // 导出 Markdown：先弹 Electron 保存框拿 savePath，再调 HTTP 路由统一落盘；
  //   - 非 Electron 模式：退回为浏览器 Blob 下载（用 <a download>）
  async function exportOptimizedMarkdown() {
    const ta = $('#resumeOptOutput');
    const content = (ta && ta.value && ta.value.trim()) ? ta.value.trim() : ResumeState.lastOptimizedText;
    if (!content) { toast('暂无优化后全文：请先执行『AI 分析与优化』。', 'warn'); return; }
    const ipc = getIPC();

    // ---- 路径 A：Electron 环境，走 save-file-dialog + HTTP export-md（优先，有真实系统文件权限）
    if (ipc) {
      try {
        const save = await ipc.invoke('save-file-dialog', {
          title: '导出优化后简历为 Markdown',
          defaultPath: '优化后简历.md',
          filters: [
            { name: 'Markdown 文档', extensions: ['md', 'markdown'] },
            { name: '纯文本', extensions: ['txt'] },
            { name: '所有文件', extensions: ['*'] }
          ]
        });
        if (!save || !save.success) return; // 用户取消
        // 调 HTTP /api/resume-opt/export-md 统一写盘；默认不附加 front-matter，保证"所见即所得"
        const r = await apiFetch('/api/resume-opt/export-md', {
          content,
          savePath: save.filePath,
          addFrontMatter: false,
          normalizeEol: true
        });
        toast(`已导出：${save.filePath}（${(r.bytes / 1024).toFixed(1)} KB）`, 'success', 5200);
        return;
      } catch (e) {
        toast('导出 Markdown 失败：' + (e.message || ''), 'error', 5200);
        return;
      }
    }

    // ---- 路径 B：浏览器降级方案，用 Blob + <a download> 触发下载（Electron 模式一般用不到，兜底）
    try {
      const mime = 'text/markdown;charset=utf-8';
      const blob = new Blob([content.replace(/\r\n|\r(?!\n)/g, '\n')], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = '优化后简历.md';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        try { document.body.removeChild(a); } catch (_) { /* ignore */ }
        try { URL.revokeObjectURL(url); } catch (_) { /* ignore */ }
      }, 0);
      toast('浏览器模式：已触发下载', 'success', 3000);
    } catch (e) {
      toast('浏览器下载失败：' + (e.message || ''), 'error', 4200);
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
  // 3.9 模拟面试浮动面板：模式锁定 + 浮窗状态轮询
  //      需求：开始模拟面试后，主窗口的作答方式按钮（文字/语音）不可切换；
  //            浮窗关闭后，自动恢复按钮可用 + CTA 按钮文案。
  // ------------------------------------------------------------
  /** 浮窗状态轮询句柄（全局仅一个，避免多轮 setInterval 叠加） */
  let _mockFloatPollTimer = null;

  /**
   * 锁/解锁『作答方式切换』控件 + 面试类型 + 题目数 + 语言 + CTA。
   * - 开始面试（locked=true）：禁止用户在主窗口再改作答方式 / 类型 / 题数等
   * - 浮窗关闭后（locked=false）：恢复可编辑，并把 mockStartBtn 文案还原
   * @param {boolean} locked
   */
  function setMockFormLocked(locked) {
    const lock = !!locked;
    // 3.9.1 作答方式：mock-ans-mode 按钮组（核心锁：用户要求"开始面试后不能切换作答方式"）
    $$('.mock-ans-mode').forEach(btn => {
      btn.style.pointerEvents = lock ? 'none' : '';
      btn.style.opacity = lock ? '0.55' : '';
      if (lock) btn.setAttribute('title', '模拟面试进行中，作答方式已锁定');
      else btn.removeAttribute('title');
    });
    // 3.9.2 面试类型卡片：进行中不可再改（避免"类型与实际会话不一致"）
    $$('#mockInterviewTypeGrid .mock-type').forEach(btn => {
      btn.style.pointerEvents = lock ? 'none' : '';
      btn.style.opacity = lock ? '0.6' : '';
    });
    // 3.9.3 输入类控件：目标职位 / 行业 / JD / 简历 / 题数 / 语言
    const inputIds = ['mockTargetPosition', 'mockTargetIndustry', 'mockJobDesc', 'mockResumeEditor', 'mockQuestionCount', 'mockLanguage'];
    inputIds.forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      if (lock) {
        el.setAttribute('disabled', 'disabled');
        el.style.opacity = '0.7';
      } else {
        // select/input/textarea 的 disabled 语义不同：textarea 只读更合适？
        // 用户没明确要求"内容清空时不能改"，统一用 disabled；简历编辑器用 readonly 防止内容被误清空
        if (id === 'mockResumeEditor') { el.removeAttribute('disabled'); el.removeAttribute('readonly'); }
        else el.removeAttribute('disabled');
        el.style.opacity = '';
      }
    });
    const resumeTa = $('#mockResumeEditor');
    if (resumeTa) {
      if (lock) { resumeTa.setAttribute('readonly', 'readonly'); resumeTa.style.opacity = '0.7'; }
      else { resumeTa.removeAttribute('readonly'); resumeTa.style.opacity = ''; }
    }
    // 3.9.4 CTA 按钮：开始面试进行中 → 改为"面试中…打开浮动面板"文案，disabled=false 但点击会切 focus 到浮窗（下方 startMockInterview 里处理）
    const cta = $('#mockStartBtn');
    if (cta) {
      if (lock) {
        cta.disabled = false;
        cta.innerHTML = '<span>&#9889;</span> 模拟面试进行中（点击前往浮动面板）';
      } else {
        cta.disabled = false;
        cta.innerHTML = '<span>&#9889;</span> 开始模拟面试<span class="mock-cta-arrow">&#10140;</span>';
      }
    }
  }

  /**
   * 开启浮窗状态轮询（每 600ms 查一次 mockInterviewFloatStatus）：
   *   - 浮窗存在：保持 setMockFormLocked(true)
   *   - 浮窗不存在（用户点 × 关闭 / 生成报告后点关闭）：setMockFormLocked(false) + 清定时器 + hideMockRunCard
   * 说明：不用主进程推事件（因为当前没有 overlay:closed 类似的通道给 mock-floatwin），
   *      轮询 600ms 足够省电且响应及时；全局单例，保证不叠加。
   */
  function startMockFloatWinStatusPoller() {
    if (_mockFloatPollTimer) { clearInterval(_mockFloatPollTimer); _mockFloatPollTimer = null; }
    // ✅ 改用双通道封装 ipc_getMockFloatStatus()：不再依赖 window.electronAPI 的字段完整性；
    //    即使 electronAPI 桥接缺字段，也能通过 ipcRenderer.invoke 直连（主窗口 nodeIntegration=true 一定可行）。
    if (!hasIPC()) {
      // 纯浏览器环境（dev-server）：没有 IPC，浮窗也开不了 → 解除表单锁定
      setTimeout(() => setMockFormLocked(false), 200);
      return;
    }
    _mockFloatPollTimer = setInterval(async () => {
      try {
        const st = await ipc_getMockFloatStatus();  // 双通道：优先 electronAPI，失败自动退回 ipcRenderer.invoke
        const exists = !!(st && st.exists);
        // 主窗口里 mockRunCard：浮窗模式下应该始终隐藏（避免"主窗口还显示旧面试进行中"的误导）
        if (exists) {
          // 浮窗还开着 → 锁定表单 + 隐藏主窗口 run-card（防止两个地方同时显示"进行中"冲突）
          setMockFormLocked(true);
          hideMockRunCard();
        } else {
          // 浮窗已关闭 → 解锁表单 + 停轮询
          setMockFormLocked(false);
          if (_mockFloatPollTimer) { clearInterval(_mockFloatPollTimer); _mockFloatPollTimer = null; }
          toast('浮动面板已关闭，可重新配置表单开始下一场模拟面试。', 'info', 3200);
        }
      } catch (e) {
        // 轮询失败不打紧：只打日志，不影响 UI
        console.warn('[mock-interview][poll] status 轮询异常：', e && e.message);
      }
    }, 600);
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
          // 兼容两种字段名：resumeContent / resumeText（项目约束）
          const src = cfg && (cfg.resumeContent || cfg.resumeText) ? (cfg.resumeContent || cfg.resumeText) : '';
          writeResumeText(src, src ? `已加载（${src.length} 字）` : '尚未保存');
          syncResumeOptCharCount();
          toast(src ? '已加载已保存简历' : '当前未保存简历，请粘贴或上传。', src ? 'success' : 'warn', 2600);
        } catch (e) {
          toast('读取已保存简历失败：' + (e.message || ''), 'error');
        }
      });
    }
    if ($('#resumeOptClearBtn')) {
      $('#resumeOptClearBtn').addEventListener('click', () => {
        // 清空简历内容，同时：① 重置状态文本 ② 把字数显示清零 ③ 聚焦编辑器便于立刻粘贴
        writeResumeText('', '已清空');
        syncResumeOptCharCount('已清空');
        const ta = $('#resumeOptEditor');
        if (ta) ta.focus();
        toast('已清空简历内容', 'info', 2000);
      });
    }

    // 4.8 简历优化：字数实时计数（同时兼容 input/change/paste/cut 四类触发：
    //   - input：用户手工打字；- change：失焦后有改动（兜底）；- paste/cut：粘贴/剪切剪贴板内容
    //   注意：IE 等古浏览器会因 addEventListener 不存在直接跳过，由 wrap 的 try 兜底）
    if ($('#resumeOptEditor')) {
      const countUpdater = () => syncResumeOptCharCount();
      ['input', 'change', 'paste', 'cut', 'drop'].forEach(evt => {
        try {
          $('#resumeOptEditor').addEventListener(evt, () => {
            // paste/cut/drop 等事件是异步写入，稍等一帧让 DOM value 真正写入后再计数
            if (evt === 'input' || evt === 'change') countUpdater();
            else setTimeout(countUpdater, 0);
          });
        } catch (_) { /* 单个事件绑定失败不影响其它事件 */ }
      });
      // 初始化即刻把字数正确设置（避免粘贴前字数显示与真实内容不一致）
      countUpdater();
    }

    // 4.9 简历优化：CTA + 导出 + 复制
    if ($('#resumeOptStartBtn')) $('#resumeOptStartBtn').addEventListener('click', runResumeOptimize);
    if ($('#resumeOptExportMdBtn')) $('#resumeOptExportMdBtn').addEventListener('click', exportOptimizedMarkdown);
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
      syncResumeOptCharCount();
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

  /** 启动整个 mock+resume 面板：先绑定所有 DOM 事件，再做一次 UI 引导 boot（字数刷新 + 可选自动回填已保存简历） */
  async function initMockAndResumeUI() {
    try {
      bindEvents();
    } catch (e) {
      console.error('[mockResumePanels] bindEvents 失败:', e.message);
    }
    try {
      await bootResumeOptUI();
    } catch (e) {
      console.warn('[mockResumePanels] bootResumeOptUI 未完成:', e.message);
    }
  }

  // 初始化：DOM 就绪即绑定 + 引导 boot（注意 DOMContentLoaded 只会触发一次，不会因为 copilot.js 又触发一次而重复绑定）
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initMockAndResumeUI);
  } else {
    initMockAndResumeUI();
  }

  // 暴露少量 API 给外层（如未来想通过控制台调试）
  window.HireMeMockResume = {
    state: { MockState, ResumeState },
    startMockInterview, submitMockAnswer, submitMockFollowupAnswer, nextMockQuestion, finalMockReview,
    runResumeOptimize, exportOptimizedDOCX, exportOptimizedMarkdown,
    pickResumeViaIPC, parseResumeFileInputToOptEditor, syncResumeOptCharCount, writeResumeText
  };
})();
