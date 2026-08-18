/**
 * overlay-renderer.js — 独立答题面板 BrowserWindow 的渲染脚本
 *
 * 功能（分模块独立 try/catch，单个失败不影响其他）：
 *   1. initFontZoom          从 localStorage 读取字体缩放（与主窗口保持一致）
 *   2. initDragHandle        把手双击关闭窗口（拖动交给 Electron -webkit-app-region:drag）
 *   3. initCloseBtn          右上角 × 按钮调用 close-overlay IPC
 *   4. initResizeHandles     8 向缩放手柄 → mousedown 记录 → mousemove 发 IPC resize-overlay
 *   5. initAsrAnswerRenderer 监听 asr/answer 主进程事件 → 写入面试官/AI 文本框 + 切换 loading/ready
 *   6. initStatusBadge       监听录制状态变化 → 更新徽章类名/文字
 *   7. initAnswerFromOutside 监听 IPC answer:write-from-outside（小程序回写答案）
 *   8. initQrToggleBtn       📱 按钮切换二维码弹窗
 *   9. initQrStatusListeners 连接状态四态渲染（idle/listening/connected/disconnected）+ IP/端口/WiFi
 *  10. initQrCopyBtn         复制 JSON 连接信息到剪贴板
 *  11. initQrDisconnectBtn   断开当前小程序连接
 *
 * Electron 环境下使用 window.electronAPI（preload 暴露）；
 * 浏览器模式（dev-server）使用 localStorage/fallback，保证 overlay.html 可独立打开查看样式。
 */

(function () {
  // ---------- 通用工具 ----------
  const FONT_ZOOM_KEY = 'hireme:fontZoom';
  const FONT_ZOOM_BASE = 16;      // 与主窗口保持一致
  const FONT_ZOOM_MIN = 0.8;      // 最小 80%
  const FONT_ZOOM_MAX = 1.5;      // 最大 150%
  const FONT_ZOOM_STEP = 0.1;     // 步长 10%（与主窗口 renderer.js 一致）

  /**
   * 安全拿到 DOM 元素，不存在返回 null（避免空引用）
   */
  const $ = (id) => document.getElementById(id);

  // ============================================================
  // ★★★ 轻量 Markdown → HTML 渲染器（无三方依赖、内置 XSS 转义）
  // 目标：正确显示 AI 输出的标题(###)、加粗(**)、斜体(*)、代码块(```)、行内代码(`)、
  //      有序/无序列表、引用(>)、分隔线(---)，而不是把 Markdown 语法符当纯文本显示。
  // 策略：先按行级块拆 → 逐块判定类型 → 行内再单独跑一次强调/链接/行内代码
  // ============================================================
  /** 第一步：把字符串中的 HTML 危险字符（< > & " '）转义为实体，避免 XSS 与标签渲染 */
  function _escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  /** 第二步：行内格式（强/斜/行内代码/删除线/链接），输入必须已 escape 过，否则链接会被吃掉 */
  function _renderInline(text) {
    // 先把行内代码段挑出来：`xxx` 用占位符暂存，避免其中的 * _ 被强调处理错
    const codeStore = [];
    const withCodeProtected = String(text || '').replace(/`([^`]+)`/g, (_m, code) => {
      const idx = codeStore.length;
      codeStore.push(code);
      // 用 \x00CODE:idx\x00 这种不会出现在正常文本里的占位
      return '\x00CODE:' + idx + '\x00';
    });
    let out = withCodeProtected;
    // 链接 [文字](地址)
    out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gi, (_m, lbl, url) => {
      const safeUrl = _escapeHtml(url);
      return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${lbl}</a>`;
    });
    // 加粗 **xxx** / __xxx__
    out = out.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/__([^_]+?)__/g, '<strong>$1</strong>');
    // 斜体 *xxx* / _xxx_（不要和加粗叠在一起）
    out = out.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>');
    out = out.replace(/(^|[^_])_([^_\n]+?)_(?!_)/g, '$1<em>$2</em>');
    // 删除线 ~~xxx~~
    out = out.replace(/~~([^~]+?)~~/g, '<del>$1</del>');
    // 行内代码还原：先把 placeholder 里的内容再 escape 一次再包 <code>
    out = out.replace(/\x00CODE:(\d+)\x00/g, (_m, idxStr) => {
      const code = codeStore[Number(idxStr)];
      const safe = _escapeHtml(code);
      return `<code class="inline-code">${safe}</code>`;
    });
    return out;
  }
  /** 主入口：完整 Markdown → HTML；不支持 HTML 输入（全转义），仅支持 Markdown 原语 */
  function renderMarkdown(md) {
    const raw = String(md == null ? '' : md);
    if (!raw) return '';
    // 统一换行（\r\n / \r → \n），按 \n\n 切成段落块；``` 代码块单独切出，避免被段落切错
    const normalized = raw.replace(/\r\n?/g, '\n');
    // 1. 先抓 ```fence ``` 代码块（含可选语言标记），用占位换掉，避免被按段落切
    const fenceStore = [];
    const noFence = normalized.replace(/```([\w+-]*)\n([\s\S]*?)\n?```/g, (_m, lang, body) => {
      const idx = fenceStore.length;
      // 代码体不做任何 markdown 解析，只做 HTML escape
      fenceStore.push({ lang: String(lang || '').trim(), html: _escapeHtml(body) });
      return '\n\x00FENCE:' + idx + '\x00\n';
    });
    // 2. 按 \n\n 切成块（空行分隔）；单个 \n 在 Markdown 里就是 <br/>（普通段落内换行）
    const blocks = noFence.split(/\n{2,}/).map((b) => String(b || '').trim()).filter((b) => !!b);
    const htmlParts = [];
    for (const block of blocks) {
      if (/^\x00FENCE:\d+\x00$/.test(block)) {
        const idxStr = block.slice(7, -1);
        const fence = fenceStore[Number(idxStr)];
        if (fence) {
          const langCls = fence.lang ? ` class="language-${_escapeHtml(fence.lang)}"` : '';
          htmlParts.push(`<pre><code${langCls}>${fence.html}</code></pre>`);
        }
        continue;
      }
      // --- 分隔线（独立段）
      if (/^\s*([-*_])\s*\1\s*\1[\s\S]*$/.test(block) && /^[\s*\-_]{3,}$/.test(block)) {
        htmlParts.push('<hr/>');
        continue;
      }
      // ### 标题（1~6 级）
      const h = block.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        const level = h[1].length;
        htmlParts.push(`<h${level}>${_renderInline(_escapeHtml(h[2]))}</h${level}>`);
        continue;
      }
      // > 引用（支持多行块级引用 > 开头）
      if (/^>\s?/m.test(block)) {
        const lines = block.split('\n').map((ln) => ln.replace(/^>\s?/, ''));
        htmlParts.push(`<blockquote>${_renderInline(_escapeHtml(lines.join('\n'))).replace(/\n/g, '<br/>')}</blockquote>`);
        continue;
      }
      // 有序列表 1. / 2.（块里每一行都是）
      const olLines = block.split('\n');
      if (olLines.every((ln) => /^\s*\d+\.\s+/.test(ln))) {
        const lis = olLines.map((ln) => `<li>${_renderInline(_escapeHtml(ln.replace(/^\s*\d+\.\s+/, '')))}</li>`);
        htmlParts.push(`<ol>${lis.join('')}</ol>`);
        continue;
      }
      // 无序列表 - / * / +
      if (olLines.every((ln) => /^\s*[-*+]\s+/.test(ln))) {
        const lis = olLines.map((ln) => `<li>${_renderInline(_escapeHtml(ln.replace(/^\s*[-*+]\s+/, '')))}</li>`);
        htmlParts.push(`<ul>${lis.join('')}</ul>`);
        continue;
      }
      // 默认普通段落：把单 \n 转 <br/>（gfm breaks），让 AI 的换行也可见
      htmlParts.push(`<p>${_renderInline(_escapeHtml(block)).replace(/\n/g, '<br/>')}</p>`);
    }
    return htmlParts.join('\n');
  }

  // ===== Toast：顶部轻提示（单例，DOM 节点 overlayToast 已在 overlay.html 预置）=====
  let _toastTimer = null;
  /**
   * 弹 Toast 提示，2.6s 后自动隐藏
   * @param {string} msg 提示文字（中文）
   * @param {'default'|'ok'|'error'|'warn'} type 视觉类型：默认灰 / 成功绿 / 错误红 / 警告黄
   */
  function showToast(msg, type) {
    try {
      const el = $('overlayToast');
      if (!el) return;
      const t = (type === 'ok' || type === 'error' || type === 'warn') ? type : 'default';
      el.className = 'overlay-toast show ' + t;
      el.textContent = String(msg || '');
      if (_toastTimer) clearTimeout(_toastTimer);
      _toastTimer = setTimeout(() => {
        el.className = 'overlay-toast';
      }, 2600);
    } catch (e) {
      // Toast 失败不能打断主流程，静默吞
      console.warn('[overlay] showToast 失败:', e.message);
    }
  }

  /**
   * 统一拿到 electronAPI 对象；浏览器模式返回 stub 对象，方便 UI 调试
   */
  function getApi() {
    if (typeof window !== 'undefined' && window.electronAPI) return window.electronAPI;
    // dev-server / 直接用浏览器打开 overlay.html 的兜底：返回空实现，不崩溃
    return {
      closeOverlay: () => Promise.resolve({ success: true }),
      resizeOverlay: () => Promise.resolve({ success: true }),
      generateQR: () => Promise.resolve({ success: false, error: 'not electron' }),
      getServerStatus: () => Promise.resolve({ success: false, status: 'idle' }),
      disconnectMiniapp: () => Promise.resolve({ success: true }),
      onAsrInterim: () => {},
      onAsrFinal: () => {},
      onAnswerStart: () => {},
      onAnswerGenerated: () => {},
      onRecordingStatus: () => {},
      onWriteFromOutside: () => {},
      onLocalStatusChanged: () => {},
    };
  }
  const api = getApi();

  // ============================================================
  // 1. 字体缩放（与主窗口读取同一 localStorage key，且提供 A⁻/百分比/A⁺ 按钮与主窗口一致的功能）
  //   与主窗口 renderer.js initFontZoom 功能对齐：
  //     - 按钮 A⁻：zoom -= 0.1（下限 0.8）；按钮 A⁺：zoom += 0.1（上限 1.5）
  //     - 中间显示百分比（80%~150%）
  //     - 写入 localStorage(FONT_ZOOM_KEY) 持久化
  //     - 监听 window 'storage' 事件：主窗口改了 zoom overlay 立刻同步（两窗口共享同一 storage）
  // ============================================================
  function initFontZoom() {
    try {
      const zoomOutBtn = $('fontZoomOut');   // A⁻
      const zoomInBtn = $('fontZoomIn');     // A⁺
      const zoomValLabel = $('fontZoomVal'); // 中间显示 100%
      // 三个按钮都有才走完整交互；只有任何一个缺失（比如 overlay.html 结构被改了）就只做读值应用，不抛错
      const hasButtons = !!(zoomOutBtn && zoomInBtn && zoomValLabel);

      // 当前缩放值缓存：模块级只保存一个变量，避免每次从 localStorage 解析
      let currentZoom = parseFloat(localStorage.getItem(FONT_ZOOM_KEY));
      if (!(currentZoom >= FONT_ZOOM_MIN && currentZoom <= FONT_ZOOM_MAX)) {
        currentZoom = 1;
      }

      /**
       * 统一应用缩放：
       *   1) 改 <html>.style.fontSize = BASE * zoom (px) → 所有 rem 字号联动放大/缩小
       *   2) 如果按钮存在，更新百分比显示 + 边界禁用按钮态
       */
      const applyZoom = () => {
        document.documentElement.style.fontSize = (FONT_ZOOM_BASE * currentZoom) + 'px';
        if (hasButtons) {
          zoomValLabel.textContent = Math.round(currentZoom * 100) + '%';
          zoomOutBtn.disabled = currentZoom <= FONT_ZOOM_MIN + 1e-9; // 到下边界禁用减号
          zoomInBtn.disabled  = currentZoom >= FONT_ZOOM_MAX - 1e-9;  // 到上边界禁用加号
        }
      };
      applyZoom();

      if (hasButtons) {
        // A⁻：缩小，步长 10%，四舍五入 2 位避免浮点 0.30000000000000004 问题
        zoomOutBtn.addEventListener('click', () => {
          currentZoom = Math.max(FONT_ZOOM_MIN, +(currentZoom - FONT_ZOOM_STEP).toFixed(2));
          localStorage.setItem(FONT_ZOOM_KEY, String(currentZoom));
          applyZoom();
        });
        // A⁺：放大
        zoomInBtn.addEventListener('click', () => {
          currentZoom = Math.min(FONT_ZOOM_MAX, +(currentZoom + FONT_ZOOM_STEP).toFixed(2));
          localStorage.setItem(FONT_ZOOM_KEY, String(currentZoom));
          applyZoom();
        });
        // 百分比双击 → 一键回到 100%（隐藏彩蛋：与主窗口用户体验一致，提升操作效率）
        zoomValLabel.style.cursor = 'pointer';
        zoomValLabel.title = '双击恢复 100%';
        zoomValLabel.addEventListener('dblclick', () => {
          currentZoom = 1;
          localStorage.setItem(FONT_ZOOM_KEY, String(currentZoom));
          applyZoom();
        });
      }

      // 跨窗口同步：主窗口 / 其他 BrowserWindow 修改了 storage 里的同一个 key，overlay 立刻 applyZoom
      //   注意：只有"非自身触发的 storage 事件"才会发（即来自其他窗口），所以不会出现自己触发自己的死循环
      window.addEventListener('storage', (e) => {
        if (e.key !== FONT_ZOOM_KEY) return;
        const z = parseFloat(e.newValue);
        if (z >= FONT_ZOOM_MIN && z <= FONT_ZOOM_MAX && Math.abs(z - currentZoom) > 1e-6) {
          currentZoom = z;
          applyZoom();
        }
      });

      console.log('[overlay] fontZoom 已应用:', currentZoom.toFixed(2), hasButtons ? '(可交互)' : '(只读模式)');
    } catch (e) {
      console.error('[overlay] initFontZoom 失败:', e.message);
    }
  }

  // ============================================================
  // 2. 拖动手柄：双击关闭面板窗口（拖动由 CSS -webkit-app-region 接管）
  // ============================================================
  function initDragHandle() {
    try {
      const handle = $('overlayDragHandle');
      if (!handle) return;
      // 双击：快速关闭
      handle.addEventListener('dblclick', () => {
        api.closeOverlay().catch((e) => console.error('[overlay] close dblclick:', e));
      });
    } catch (e) {
      console.error('[overlay] initDragHandle 失败:', e.message);
    }
  }

  // ============================================================
  // 3. 右上角 × 按钮：关闭答题面板
  //    健壮化：禁止单次点击后永久禁用（IPC 返回 success 但窗口没关的假成功）；
  //    真 Electron 环境下调用 IPC + 兜底 window.close；stub 模式仅回滚 disabled。
  // ============================================================
  function initCloseBtn() {
    try {
      const btn = $('closeOverlayBtn');
      if (!btn) return;
      const isElectron = typeof window !== 'undefined' && !!window.electronAPI;
      btn.addEventListener('click', () => {
        // 防抖：连续点击不重复触发
        if (btn.dataset.closing === '1') return;
        btn.dataset.closing = '1';
        btn.disabled = true;

        /** 失败兜底：回滚按钮状态，允许重试 */
        const rollback = () => {
          btn.disabled = false;
          btn.dataset.closing = '0';
        };

        // stub 模式（浏览器打开 overlay.html 预览）：没有真实窗口可关，仅回滚按钮，避免永久死锁
        if (!isElectron) {
          console.log('[overlay] 浏览器模式：closeOverlay 仅模拟成功，窗口不会真的关闭');
          rollback();
          return;
        }

        // 真 Electron 环境：先调 IPC 关闭
        const closeTimer = setTimeout(() => {
          // ★ 兜底：IPC 调用返回 success 但实际没关（例如 overlayWindow.close() 失败）
          // 300ms 后 DOM 还在，用 window.close() 再试一次，并回滚按钮允许再次点击
          try {
            if (document.body) {
              // 强制兜底关闭当前 BrowserWindow
              window.close();
            }
          } catch (_) { /* 忽略 */ }
          rollback();
        }, 300);

        api.closeOverlay()
          .then(() => {
            // 正常关闭：窗口会被销毁，所以之后的 timer 其实不会执行；
            // 如果 300ms 后没关闭（异常），上面的 setTimeout 会救场
            clearTimeout(closeTimer);
          })
          .catch((e) => {
            clearTimeout(closeTimer);
            console.error('[overlay] close btn 失败:', e);
            // IPC 抛错时再做一次 window.close 兜底
            try { window.close(); } catch (_) { /* 忽略 */ }
            rollback();
          });
      });
    } catch (e) {
      console.error('[overlay] initCloseBtn 失败:', e.message);
    }
  }

  // ============================================================
  // 4. 8 向缩放手柄：按下移动调 IPC，主进程 setBounds 完成缩放
  // ============================================================
  function initResizeHandles() {
    try {
      const handles = document.querySelectorAll('.overlay-resize-handle');
      if (!handles || handles.length === 0) return;

      handles.forEach((el) => {
        const direction = el.getAttribute('data-direction');
        if (!direction) return;

        let startX = 0;
        let startY = 0;
        let dragging = false;

        // 鼠标按下：记录起点；监听全局移动/松开
        el.addEventListener('mousedown', (e) => {
          // 阻止 drag-handle 的 app-region 冒泡（防止被当成拖动窗口）
          e.preventDefault();
          e.stopPropagation();
          dragging = true;
          startX = e.clientX;
          startY = e.clientY;
          document.body.style.cursor = el.style.cursor || 'nwse-resize';
        });

        // 全局 mousemove：计算 delta → 发 IPC（节流：每 16ms 一次，约 60fps）
        let lastAt = 0;
        const onMove = (e) => {
          if (!dragging) return;
          const now = Date.now();
          if (now - lastAt < 16) return;       // 节流 16ms
          lastAt = now;
          const dx = e.clientX - startX;
          const dy = e.clientY - startY;
          if (dx === 0 && dy === 0) return;
          startX = e.clientX;
          startY = e.clientY;
          // 异步发 IPC；不等待回包，确保下一帧继续算
          api.resizeOverlay(direction, dx, dy).catch((err) => {
            console.error('[overlay] resizeOverlay err:', err.message);
          });
        };

        const onUp = () => {
          if (!dragging) return;
          dragging = false;
          document.body.style.cursor = '';
        };

        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
      });
    } catch (e) {
      console.error('[overlay] initResizeHandles 失败:', e.message);
    }
  }

  // ============================================================
  // 5. ASR 文本 / AI 答案渲染
  // ============================================================
  function initAsrAnswerRenderer() {
    try {
      const interimEl = $('overlayInterimText');
      const answerEl = $('overlayAnswerText');
      const loadingEl = $('answerLoading');
      const readyEl = $('answerReady');
      if (!interimEl || !answerEl || !loadingEl || !readyEl) return;

      // 统一滚动容器（面试官 + AI 助手 + 状态）：滚动条统一放外层，外层滚到底即可让用户看到最新内容
      const scrollBody = $('panelScrollBody');
      // 辅助：外层容器滚到底（仅当外层存在且可用）
      const scrollToBottom = () => {
        try {
          if (scrollBody) {
            // smooth 平滑滚动体验更好；但要兼容无 scrollTo 场景时 fallback 给 scrollTop 直设
            if (typeof scrollBody.scrollTo === 'function') {
              scrollBody.scrollTo({ top: scrollBody.scrollHeight, behavior: 'smooth' });
            } else {
              scrollBody.scrollTop = scrollBody.scrollHeight;
            }
          }
        } catch (_) { /* 任何异常不影响主链路 */ }
      };

      /**
       * 辅助：切换 loading / ready 显示；loading 显示中隐藏 ready；ready 仅显示 2s 再隐藏
       */
      const showLoading = () => { loadingEl.style.display = 'block'; readyEl.style.display = 'none'; };
      const hideAll = () => { loadingEl.style.display = 'none'; readyEl.style.display = 'none'; };
      const flashReady = () => {
        loadingEl.style.display = 'none';
        readyEl.style.display = 'block';
        // 2s 后自动隐藏，保持面板干净
        setTimeout(() => { readyEl.style.display = 'none'; }, 2000);
      };

      // 监听 ASR 临时文本：高频刷新面试官区域
      if (typeof api.onAsrInterim === 'function') {
        api.onAsrInterim((text) => {
          interimEl.textContent = text || '';
        });
      }
      // 监听 ASR 最终文本：以与临时相同方式写入（最终覆盖，防止临时被清空后闪烁）
      if (typeof api.onAsrFinal === 'function') {
        api.onAsrFinal((text) => {
          interimEl.textContent = text || '';
        });
      }
      // 开始生成 → 显示 ⏳ 正在生成答案
      if (typeof api.onAnswerStart === 'function') {
        api.onAnswerStart((_question) => {
          showLoading();
        });
      }
      // 生成完成 → 写入答案区 → 显示 ✓ 2s
      // ★ AI 输出是 Markdown：不再用 textContent 把语法符原样显示，改为先 renderMarkdown → set innerHTML
      if (typeof api.onAnswerGenerated === 'function') {
        api.onAnswerGenerated(({ text }) => {
          answerEl.innerHTML = renderMarkdown(text || '');
          scrollToBottom();  // 外层滚动到底部（用户看到最新 AI 答案）
          flashReady();
        });
      }
      // 小程序侧回写答案（与上面 answerGenerated 相同视觉效果）
      if (typeof api.onWriteFromOutside === 'function') {
        api.onWriteFromOutside((text) => {
          answerEl.innerHTML = renderMarkdown(text || '');
          scrollToBottom();
          flashReady();
        });
      }
      // 【新增】外部写入面试官提问：H5/小程序/面板截图 写入「面试官」区 + 缩略图
      //   策略：
      //     - payload 支持对象 {text, imageDataUrl} 或纯字符串(旧版兼容)
      //     - 有 imageDataUrl：显示缩略图(点缩略图可新窗口放大) + 写文字
      //     - 无 imageDataUrl：隐藏缩略图容器 + 只写文字
      //     - 文字写入策略：原区域内容为空 → 直接写入；已有文字(如ASR识别) → 换行追加，不覆盖
      if (typeof api.onWriteQuestionFromOutside === 'function') {
        const shotWrap = $('interviewScreenshotWrap');
        const shotImg = $('interviewScreenshot');
        const shotCloseBtn = $('closeInterviewScreenshotBtn');
        // 绑定一次"关闭缩略图"按钮（只绑一次，避免重复绑定）
        if (shotCloseBtn && !shotCloseBtn._boundClose) {
          shotCloseBtn._boundClose = true;
          shotCloseBtn.addEventListener('click', () => {
            if (shotWrap) shotWrap.style.display = 'none';
          });
        }
        // 绑定一次"点击缩略图 → 新窗口打开原图放大查看"（只绑一次）
        if (shotImg && !shotImg._boundZoom) {
          shotImg._boundZoom = true;
          shotImg.addEventListener('click', () => {
            const src = shotImg.getAttribute('src');
            if (src && /^data:image\//i.test(src)) {
              // 新窗口打开原图（base64），方便看题目细节
              try {
                const w = window.open('', '_blank', 'noopener');
                if (w) {
                  w.document.write(`<!DOCTYPE html><html><head><title>面试题原图</title><style>body{margin:0;background:#1a1d25;display:flex;justify-content:center;align-items:center;min-height:100vh;}img{max-width:100%;max-height:100vh;box-shadow:0 8px 30px rgba(0,0,0,.6);border-radius:6px;}</style></head><body><img src="${src}" alt="面试题原图"></body></html>`);
                  w.document.close();
                }
              } catch (e) { console.warn('[overlay] 打开放大截图失败:', e.message); }
            }
          });
        }
        api.onWriteQuestionFromOutside((payload) => {
          // 归一化 payload：兼容对象 {text, imageDataUrl} 与字符串
          let text = '';
          let imageDataUrl = '';
          if (payload && typeof payload === 'object') {
            text = (typeof payload.text === 'string') ? payload.text.trim() : '';
            imageDataUrl = (typeof payload.imageDataUrl === 'string') ? payload.imageDataUrl.trim() : '';
          } else if (typeof payload === 'string') {
            text = payload.trim();
          }
        // ★ 用户不希望显示"题头提示词"，即"【面试官提问（xxx·截图题）】请观察..."这类包装文字。
        //   这里只保留截图图像（通过 imageDataUrl 下发），文字提示不在面试官区展示；
        //   后端 recordState 中的 interimText 仍保留 questionText（H5 轮询链路可见），
        //   但 overlay 面板端写入面试官文本时，如果判断是我们的"内部题头模板"就跳过写文本，直接写截图。
        // ---- 处理截图 ----
          if (shotWrap && shotImg) {
            if (imageDataUrl && /^data:image\//i.test(imageDataUrl)) {
              shotImg.src = imageDataUrl;
              shotWrap.style.display = 'block';
            } else {
              shotWrap.style.display = 'none';
              try { shotImg.removeAttribute('src'); } catch (_) {}
            }
          }
          // ---- 处理文字 ----
          // 用户要求：不要显示截图题的内部模板题头，所以如果 text 与我们 questionText 的模板高度相似，就跳过写入文字区。
          //   判断方式：text 以 "【面试官提问" 开头且包含"截图题）】" → 认为是 AI 内部提示词，不在面板展示。
          //   其他真实提问（ASR 识别、用户手动粘贴的题目）照常写入。
          const isInternalScreenshotHint = (
            typeof text === 'string' &&
            /^【面试官提问[\s\S]*截图题）】/.test(text)
          );
          if (!text || isInternalScreenshotHint) {
            // 无文字 / 内部截图题的题头 → 不写入面试官文本区（让截图更突出，UI更干净）
            // 还是滚到底部确保用户看到截图
            scrollToBottom();
            return;
          }
          const cur = (interimEl.textContent || '').trim();
          if (!cur) {
            interimEl.textContent = text;
          } else {
            const firstLine = text.split('\n')[0];
            if (cur.indexOf(firstLine) >= 0) return;
            interimEl.textContent = cur + '\n\n' + text;
          }
          // 外层统一容器滚到底部（用户看到最新面试官提问 + 截图画面）
          scrollToBottom();
        });
      }
    } catch (e) {
      console.error('[overlay] initAsrAnswerRenderer 失败:', e.message);
    }
  }

  // ============================================================
  // 6. 识别状态徽章（🎤 正在识别 / ⏸ 识别已暂停）
  // ============================================================
  function initStatusBadge() {
    try {
      const badge = $('statusBadge');
      if (!badge) return;
      const render = (isRecording) => {
        badge.classList.remove('recording', 'paused');
        if (isRecording) {
          badge.classList.add('recording');
          badge.textContent = '🎤 正在识别系统声音';
        } else {
          badge.classList.add('paused');
          badge.textContent = '⏸ 识别已暂停';
        }
      };
      // 初始默认 "正在识别"（用户点开始面试辅助后通常立刻进入识别态）
      render(true);
      if (typeof api.onRecordingStatus === 'function') {
        api.onRecordingStatus((isRecording) => {
          render(!!isRecording);
        });
      }
    } catch (e) {
      console.error('[overlay] initStatusBadge 失败:', e.message);
    }
  }

  // ============================================================
  // 7. 暴露给外部 IPC 直接调用的回写答案（与第 5 条的 onWriteFromOutside 形成双通道）
  // ============================================================
  function initAnswerFromOutside() {
    try {
      // 挂 window 上，主进程可直接调用；但通常 IPC 会走 preload 暴露的事件通道
      window.__overlayWriteAnswer = (text) => {
        const answerEl = $('overlayAnswerText');
        const readyEl = $('answerReady');
        const scrollBody = $('panelScrollBody');
        if (!answerEl) return;
        // ★ 外部回写答案也按 Markdown 渲染，避免 ### /*** 等语法以纯文本形式出现
        answerEl.innerHTML = renderMarkdown(text || '');
        // 外层统一滚动到底
        try { if (scrollBody) scrollBody.scrollTop = scrollBody.scrollHeight; } catch (_) { /* ignore */ }
        // 显示 ✓ 2s
        if (readyEl) {
          document.getElementById('answerLoading').style.display = 'none';
          readyEl.style.display = 'block';
          setTimeout(() => { readyEl.style.display = 'none'; }, 2000);
        }
      };
    } catch (e) {
      console.error('[overlay] initAnswerFromOutside 失败:', e.message);
    }
  }

  // ============================================================
  // 8. 📱 二维码按钮：切换二维码弹窗显示；显示时异步拿 dataURL 渲染
  // ============================================================
  function initQrToggleBtn() {
    try {
      const btn = $('qrToggleBtn');
      const modal = $('qrModal');
      if (!btn || !modal) return;
      btn.addEventListener('click', async () => {
        const willShow = !modal.classList.contains('show');
        modal.classList.toggle('show', willShow);
        if (willShow) {
          // ① 先给即时反馈：服务启动中，避免用户以为卡死
          renderQrStatus('starting', null);
          // 显示时立刻请求生成二维码（服务未启动会自动先启动）
          try {
            const res = await api.generateQR();
            renderQrResult(res);
            // 顺带刷新连接状态（仅当服务实际运行时刷新，避免用 idle 覆盖掉 generateQR 已设置的错误提示）
            try {
              const wrap = await api.getServerStatus();
              // get-server-status 返回 { ok, status: 状态对象 }，取内部 status 字段
              const st = (wrap && wrap.status) || null;
              // 关键：只有 st.status 非 idle（说明服务确实在运行或已连接）才更新；
              // 如果还是 idle，说明 generateQR 返回了错误，badge 上已经有中文错误字，不能覆盖
              if (st && st.status !== 'idle') renderQrStatus(st.status, st);
            } catch (_) { /* 状态刷新失败不影响二维码主流程，静默忽略 */ }
          } catch (e) {
            // IPC 通道级别异常（不是 return {ok:false}，而是 throw 出来，如 preload 未定义 / 主进程未注册 handler）
            console.error('[overlay] generateQR 失败:', e);
            const msg = (e && e.message) ? e.message : (String(e) || '未知错误');
            renderQrStatus('idle', null, msg);
            showToast('二维码启动失败：' + msg, 'error');
          }
        }
      });
    } catch (e) {
      console.error('[overlay] initQrToggleBtn 失败:', e.message);
      showToast('二维码按钮初始化失败：' + e.message, 'error');
    }
  }

  /**
   * 辅助：把 generateQR 返回值（含 dataUrl / ip / port 等）写入 qr-modal
   */
  function renderQrResult(res) {
    try {
      const img = $('qrImg');
      const ipEl = $('qrIp');
      const portEl = $('qrPort');
      const wifiEl = $('qrWifiName');
      // 兼容两种结构：{success} 或 {ok}，任一为真即可
      const isOk = !!(res && (res.success || res.ok));
      if (!isOk) {
        if (img) img.removeAttribute('src');
        // 显示错误：errMsg 取 msg（中文用户提示）→ error code → 兜底 "服务未启动"
        const errMsg = (res && (res.msg || res.error)) || '服务未启动';
        renderQrStatus('idle', null, errMsg);
        // 同时弹 Toast：错误信息一眼可见，不用用户自己去看 badge 小字
        showToast('无法生成二维码：' + errMsg, 'error');
        return;
      }
      if (img && res.dataUrl) img.src = res.dataUrl;
      if (ipEl) ipEl.textContent = res.primaryIp || res.payload?.ip || '-';
      if (portEl) portEl.textContent = res.port || '-';
      // WiFi 名：Windows 下 Electron 侧难拿，留占位（由后续主进程调 netsh wlan show interfaces 返回）
      if (wifiEl) wifiEl.textContent = res.wifiName || '(请确认连接同一局域网)';
      // 同时刷新状态：优先用 fullStatus（完整快照），其次用扁平字段拼
      const info = res.fullStatus || {
        status: res.status,
        primaryIp: res.primaryIp,
        port: res.port,
        lastPingAt: res.lastPingAt
      };
      renderQrStatus(res.status || 'listening', info);
    } catch (e) {
      console.error('[overlay] renderQrResult:', e);
      showToast('二维码渲染失败：' + (e.message || '未知错误'), 'error');
    }
  }

  // ============================================================
  // 9. 二维码连接状态四态渲染
  // ============================================================
  function initQrStatusListeners() {
    try {
      renderQrStatus('idle');     // 初始态
      if (typeof api.onLocalStatusChanged === 'function') {
        api.onLocalStatusChanged((statusObj) => {
          renderQrStatus(statusObj && statusObj.status, statusObj);
        });
      }
    } catch (e) {
      console.error('[overlay] initQrStatusListeners 失败:', e.message);
    }
  }

  /**
   * 将 status 写入 qr-modal 的徽章和信息行
   * @param {string} status idle | listening | connected | disconnected
   * @param {object} info 可选：{ ips, primaryIp, port, lastPingAt, lastStatusAt }
   * @param {string} errMsg 可选：写入 badge 尾部说明
   */
  function renderQrStatus(status, info, errMsg) {
    try {
      const label = $('qrStatusLabel');
      if (label) {
        label.classList.remove('idle', 'starting', 'listening', 'connected', 'disconnected');
        label.classList.add(status || 'idle');
        let text = '';
        switch (status) {
          case 'starting':    text = '🟡 启动服务中…'; break;
          case 'idle':        text = '🔴 未启动'; break;
          case 'listening':   text = '🟡 等待连接'; break;
          case 'connected': {
            // 根据 info（getStatus() 返回的快照）区分是哪种模式连上的：
            //   小程序 WS：wsConnected=true
            //   H5/手机浏览器：h5Active=true 且 wsConnected=false
            //   两者同时连：显示"多端"
            const wsOn = !!(info && info.wsConnected);
            const h5On = !!(info && info.h5Active);
            if (wsOn && h5On) text = '🟢 已连接（微信小程序 + H5 多端）';
            else if (h5On)     text = '🟢 已连接（H5/手机浏览器）';
            else               text = '🟢 已连接（微信设备）';
            break;
          }
          case 'disconnected':text = '🟠 连接异常'; break;
          default:            text = '🔴 未启动';
        }
        // 异常/说明文字附加（errMsg 可用于启动中提示、错误提示等）
        if (errMsg) text += `：${errMsg}`;
        // 最后通信时间（相对）
        if (info && info.lastPingAt && status !== 'disconnected') {
          const secs = Math.max(0, Math.floor((Date.now() - info.lastPingAt) / 1000));
          if (secs >= 30) text += ` · ${secs}s 前`;
        }
        // ========== 双保险：防止 idle 态无 errMsg 调用覆盖掉之前已显示的错误详情 ==========
        // 当调用方传 info 但没有传 errMsg，且新状态是 idle，且 DOM 上当前 label 已经带「：」错误说明，
        // 说明有人先 renderQrResult 写了错误，后 getServerStatus 调 renderQrStatus 想覆盖。
        // 此时我们保留原 DOM 文字（含错误详情），只写 class（颜色徽章），不丢错误信息。
        const keepOldErr = (!errMsg) && (status === 'idle' || !status) &&
                           typeof label.textContent === 'string' &&
                           label.textContent.indexOf('：') !== -1;
        if (!keepOldErr) label.textContent = text;
      }
      // IP/端口/WiFi 更新：有 info 就取真实值；无 info 但有错误时给用户指引
      const ipEl = $('qrIp');
      const portEl = $('qrPort');
      if (info) {
        if (ipEl) ipEl.textContent = info.primaryIp || info.payload?.ip || ipEl.textContent;
        if (portEl) portEl.textContent = info.port || portEl.textContent;
      } else if (errMsg && status !== 'starting') {
        // 启动失败/未启动场景：让用户不要盯 IP，去看 badge 上的错误说明
        if (ipEl) ipEl.textContent = '（查看上方状态说明）';
        if (portEl) portEl.textContent = '—';
      }
    } catch (e) {
      console.error('[overlay] renderQrStatus 失败:', e);
    }
  }

  // ============================================================
  // 10. 复制连接信息按钮：把 payload JSON 复制到剪贴板
  // ============================================================
  function initQrCopyBtn() {
    try {
      const btn = $('qrCopyBtn');
      if (!btn) return;
      btn.addEventListener('click', async () => {
        try {
          const wrap = await api.getServerStatus();
          // get-server-status 返回 { ok, status: {primaryIp,ips,port,token,...} }
          const st = (wrap && wrap.status) || {};
          // 拼连接 JSON：二维码里同样的结构
          const payload = {
            v: 1,
            ip: st.primaryIp || '',
            altIps: st.ips || [],
            port: st.port || 0,
            token: st.token || '',
            ts: Date.now()
          };
          const text = JSON.stringify(payload, null, 2);
          if (navigator && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            await navigator.clipboard.writeText(text);
          } else {
            // 老浏览器兜底：textarea + execCommand
            const ta = document.createElement('textarea');
            ta.value = text; document.body.appendChild(ta);
            ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
          }
          const oldText = btn.textContent;
          btn.textContent = '✓ 已复制';
          btn.disabled = true;
          setTimeout(() => { btn.textContent = oldText; btn.disabled = false; }, 2000);
        } catch (e) {
          console.error('[overlay] 复制连接失败:', e);
          btn.textContent = '复制失败';
          setTimeout(() => { btn.textContent = '复制连接信息'; }, 2000);
        }
      });
    } catch (e) {
      console.error('[overlay] initQrCopyBtn 失败:', e.message);
    }
  }

  // ============================================================
  // 11. 断开连接按钮：通知主进程踢掉当前 WS
  // ============================================================
  function initQrDisconnectBtn() {
    try {
      const btn = $('qrDisconnectBtn');
      if (!btn) return;
      btn.addEventListener('click', async () => {
        try {
          await api.disconnectMiniapp();
          // 断开后手动刷新状态
          renderQrStatus('disconnected', null, '用户主动断开');
        } catch (e) {
          console.error('[overlay] disconnectMiniapp 失败:', e);
        }
      });
    } catch (e) {
      console.error('[overlay] initQrDisconnectBtn 失败:', e.message);
    }
  }

  // ============================================================
  // 12. 全屏截图选区 overlay：在截图上拖框，返回裁剪后的 data URL；取消返回 null。
  // ============================================================
  /**
   * 在当前 overlay 页面上覆盖一层全屏半透明遮罩，让用户拖框选择题目区域
   * @param {string} dataUrl 全屏截图的 data URL
   * @returns {Promise<string|null>} 裁剪后的图片 dataURL，用户取消返回 null
   */
  function pickRegionFromImage(dataUrl) {
    return new Promise((resolve) => {
      // 创建遮罩层：z-index 高，半透明黑背景，十字光标
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,0.55);cursor:crosshair;-webkit-app-region:no-drag;';
      overlay.innerHTML = `
        <div style="position:absolute;top:16px;left:50%;transform:translateX(-50%);color:#fff;background:rgba(0,0,0,0.6);padding:8px 16px;border-radius:6px;font-size:14px;z-index:1;">按住鼠标拖选题目区域，松开即解题（Esc 取消）</div>
        <img style="position:absolute;inset:0;width:100%;height:100%;object-fit:contain;user-select:none;-webkit-user-drag:none;">
        <canvas style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none;"></canvas>`;
      document.body.appendChild(overlay);
      const img = overlay.querySelector('img');
      img.src = dataUrl;
      const canvas = overlay.querySelector('canvas');

      let startX = 0, startY = 0, dragging = false;
      // 获取图片显示的矩形（因为 object-fit:contain，显示区域不一定覆盖整个窗口）
      const rectOf = () => img.getBoundingClientRect();

      // 取消逻辑：ESC 或点空白区未拖动
      const cancel = () => {
        try { document.body.removeChild(overlay); } catch (_) {}
        resolve(null);
      };

      // 监听 ESC 取消
      const onKey = (e) => { if (e.key === 'Escape') { document.removeEventListener('keydown', onKey); cancel(); } };
      document.addEventListener('keydown', onKey);

      overlay.addEventListener('mousedown', (e) => {
        dragging = true;
        startX = e.clientX; startY = e.clientY;
      });
      overlay.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const r = rectOf();
        const ctx = canvas.getContext('2d');
        canvas.width = r.width; canvas.height = r.height;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.strokeStyle = '#3b82f6'; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
        // 坐标转换到 canvas 坐标系（以图片显示区域左上角为原点）
        const x = Math.min(startX, e.clientX) - r.left;
        const y = Math.min(startY, e.clientY) - r.top;
        const w = Math.abs(e.clientX - startX);
        const h = Math.abs(e.clientY - startY);
        ctx.strokeRect(x, y, w, h);
        ctx.fillStyle = 'rgba(59,130,246,0.15)';
        ctx.fillRect(x, y, w, h);
      });
      overlay.addEventListener('mouseup', (e) => {
        if (!dragging) return;
        dragging = false;
        const r = rectOf();
        const x = Math.min(startX, e.clientX) - r.left;
        const y = Math.min(startY, e.clientY) - r.top;
        const w = Math.abs(e.clientX - startX);
        const h = Math.abs(e.clientY - startY);
        // 选区过小视为取消（防误点）
        if (w < 8 || h < 8) { cancel(); return; }
        try {
          // 读取图片真实像素尺寸，按显示区域比例换算裁剪框，然后画到新 canvas 导出 dataURL
          const realW = img.naturalWidth;
          const realH = img.naturalHeight;
          if (realW <= 0 || realH <= 0) { cancel(); return; }
          const scaleX = realW / r.width;
          const scaleY = realH / r.height;
          const cx = Math.max(0, x * scaleX);
          const cy = Math.max(0, y * scaleY);
          const cw = Math.min(realW - cx, w * scaleX);
          const ch = Math.min(realH - cy, h * scaleY);
          if (cw < 2 || ch < 2) { cancel(); return; }
          const cutCanvas = document.createElement('canvas');
          cutCanvas.width = Math.floor(cw);
          cutCanvas.height = Math.floor(ch);
          const cctx = cutCanvas.getContext('2d');
          cctx.drawImage(img, cx, cy, cw, ch, 0, 0, cutCanvas.width, cutCanvas.height);
          const url = cutCanvas.toDataURL('image/jpeg', 0.9);
          try { document.body.removeChild(overlay); } catch (_) {}
          resolve(url);
        } catch (err) {
          console.error('[overlay] 裁剪选区失败:', err);
          cancel();
        }
      });
    });
  }

  // ============================================================
  // 13. 截图解题主流程：截主屏（全屏直用，不再拖框）→ 视觉模型 → 写入答题面板答案区
  // ============================================================
  /**
   * 触发截图解题流程：
   *   1) 调 IPC 截取主屏全屏图
   *   2) 【优化】直接使用全屏截图，不再弹选区让用户拖框（链路一用户要求）
   *   3) 调视觉模型解答（结合简历/知识库上下文）
   *   4) 答案写入「AI 助手」文本区，闪烁「已生成」指示
   */
  async function startScreenshotSolve() {
    // 状态 DOM 引用（与 initAsrAnswerRenderer 中同一批元素）
    const answerEl = $('overlayAnswerText');
    const loadingEl = $('answerLoading');
    const readyEl = $('answerReady');
    const interimEl = $('overlayInterimText');
    const btn = $('solveToggleBtn');
    try {
      if (!api || typeof api.screenshotScreen !== 'function') {
        alert('当前环境不支持截图，请在 Electron 中使用此功能');
        return;
      }
      // 1. 截取主屏全屏
      const shot = await api.screenshotScreen();
      if (!shot || !shot.success || !shot.dataUrl) {
        alert('截屏失败：' + (shot && shot.error ? shot.error : '未知错误'));
        return;
      }
      // 2. 直接使用全屏截图：跳过 pickRegionFromImage 拖框步骤，直传全屏 dataURL 给视觉模型
      const fullDataUrl = shot.dataUrl;
      // ★ 用户不希望在面板上显示"【面试官提问（面板截图·截图题）】"这段提示词，
      //   所以这里仅写入截图画面、不写入任何文字占位；题头文字只发给 AI 作为 prompt，不在面板展示。
      try {
        const shotWrap = $('interviewScreenshotWrap');
        const shotImg = $('interviewScreenshot');
        if (shotWrap && shotImg && /^data:image\//i.test(fullDataUrl)) {
          shotImg.src = fullDataUrl;
          shotWrap.style.display = 'block';
          // 新窗口放大图：点图看细节（只绑一次）
          if (!shotImg._boundZoom) {
            shotImg._boundZoom = true;
            shotImg.addEventListener('click', () => {
              const src = shotImg.getAttribute('src');
              if (src && /^data:image\//i.test(src)) {
                try {
                  const w = window.open('', '_blank', 'noopener');
                  if (w) {
                    w.document.write(`<!DOCTYPE html><html><head><title>面试题原图</title><style>body{margin:0;background:#1a1d25;display:flex;justify-content:center;align-items:center;min-height:100vh;}img{max-width:100%;max-height:100vh;box-shadow:0 8px 30px rgba(0,0,0,.6);border-radius:6px;}</style></head><body><img src="${src}" alt="面试题原图"></body></html>`);
                    w.document.close();
                  }
                } catch (e) { console.warn('[overlay] 打开放大截图失败:', e.message); }
              }
            });
          }
        }
        // 收起按钮（只绑一次）
        const closeBtn = $('closeInterviewScreenshotBtn');
        if (closeBtn && !closeBtn._boundClose && shotWrap) {
          closeBtn._boundClose = true;
          closeBtn.addEventListener('click', () => { shotWrap.style.display = 'none'; });
        }
        // 注：不再写面试官文字占位；AI 生成答案时只显示截图 + 答案，视觉更干净
        // 立刻滚到底，让用户看到"截图画面"（因为面试官文字已去掉，用户的主要期望是看到题目图）
        try {
          const sb = $('panelScrollBody');
          if (sb) sb.scrollTop = sb.scrollHeight;
        } catch (_) { /* ignore */ }
      } catch (_) { /* UI 兜底失败不影响 AI 解题主流程 */ }
      // 3. 调视觉模型解题：先拿当前配置（含 resume/知识库）
      if (btn) { btn.disabled = true; btn.title = '解题中…'; }
      // 显示 ⏳ 正在生成答案（和 ASR/AI 答题通道共用同一套 UI）
      if (loadingEl) { loadingEl.style.display = 'block'; }
      if (readyEl)   { readyEl.style.display = 'none'; }
      let c = {};
      try {
        if (typeof api.getInterviewConfig === 'function') c = (await api.getInterviewConfig()) || {};
      } catch (_) { c = {}; }
      const resumeText = (typeof c.resumeText === 'string') ? c.resumeText : '';
      const knowledgeBase = (typeof c.knowledgeBase === 'string') ? c.knowledgeBase : '';
      // 调视觉模型（直传全屏截图 dataURL）
      const res = await api.screenshotSolve(fullDataUrl, c, resumeText, knowledgeBase);
      if (btn) { btn.disabled = false; btn.title = '全屏截图并解答'; }
      if (!res || !res.success) {
        if (loadingEl) loadingEl.style.display = 'none';
        alert('解题失败：' + (res && res.error ? res.error : '未知错误'));
        return;
      }
      // 4. 写入答案区 → 显示 ✓ 2s → 自动滚到底部
      //   注：后端也会通过 asr:question-write-from-outside 写「面试官」区（text + 截图），
      //   但是前端拿到截图时直接显式地先把截图/提问写进面试官区，避免事件竞态导致用户看不到截图。
      if (answerEl) {
        // ★ AI 答案 Markdown 渲染
        answerEl.innerHTML = renderMarkdown((res.answer || '').trim() || '（未生成答案）');
        // 外层统一滚动到底
        try {
          const sb = $('panelScrollBody');
          if (sb) sb.scrollTop = sb.scrollHeight;
        } catch (_) { /* ignore */ }
      }
      // 闪烁「✓ 已生成」2 秒后自动隐藏
      if (loadingEl) loadingEl.style.display = 'none';
      if (readyEl) {
        readyEl.style.display = 'block';
        setTimeout(() => { readyEl.style.display = 'none'; }, 2000);
      }
    } catch (e) {
      console.error('[overlay] 截图解题异常:', e);
      if (btn) { btn.disabled = false; btn.title = '全屏截图并解答'; }
      if (loadingEl) loadingEl.style.display = 'none';
      alert('截图解题异常：' + e.message);
    }
  }

  // ============================================================
  // 14. 初始化截图解题按钮：绑定点击事件 → 触发 startScreenshotSolve
  // ============================================================
  function initSolveBtn() {
    try {
      const btn = $('solveToggleBtn');
      if (!btn) return;
      btn.addEventListener('click', () => {
        // 点击即触发，内部函数自己处理 try/catch 与按钮 loading 态
        startScreenshotSolve();
      });
    } catch (e) {
      console.error('[overlay] initSolveBtn 失败:', e.message);
    }
  }

  // ============================================================
  // 15. 二维码弹窗右上角 × 关闭按钮：点击取消（仅隐藏弹窗，不关闭连接）
  // ============================================================
  function initQrCloseBtn() {
    try {
      const modal = $('qrModal');
      const closeBtn = $('qrCloseBtn');
      if (!modal || !closeBtn) return;
      closeBtn.addEventListener('click', () => {
        // 移除 show 类，隐藏弹窗；保留连接状态，下次打开按钮仍显示当前状态
        modal.classList.remove('show');
      });
    } catch (e) {
      console.error('[overlay] initQrCloseBtn 失败:', e.message);
    }
  }

  // ============================================================
  // 16. 二维码弹窗 DOM 级拖拽：扩大可拖区域到整个 header 条（包含标题文字）
  //     仅在 data-drag-handle 区域按下才触发；按钮点击不触发拖拽
  // ============================================================
  function initQrModalDrag() {
    try {
      const modal = $('qrModal');
      if (!modal) return;
      // 拖拽触发区：整个 header 条（含标题文字）
      const dragHandle = modal.querySelector('[data-drag-handle="1"]');
      if (!dragHandle) return;

      let dragging = false;
      let startMouseX = 0;          // 按下时鼠标在视口的 X
      let startMouseY = 0;          // 按下时鼠标在视口的 Y
      let startLeft = 0;            // 按下时 modal 的 left（像素）
      let startTop = 0;             // 按下时 modal 的 top（像素）
      const DRAG_THRESHOLD = 3;     // 像素阈值：移动超过 3px 才真正进入拖拽态，避免单击标题触发拖动

      /** 把 modal 的 right/bottom 定位转换为 left/top（便于增量更新） */
      function ensureLeftTopMode() {
        const parent = modal.parentElement;
        if (!parent) return;
        const mRect = modal.getBoundingClientRect();
        const pRect = parent.getBoundingClientRect();
        // 如果已经设置过 left/top（非空），直接返回现有的数值
        if (modal.style.left && modal.style.left.endsWith('px')) {
          startLeft = parseFloat(modal.style.left);
          startTop = parseFloat(modal.style.top);
          return;
        }
        // 否则以当前相对父容器的位置作为起点，并清除 right/bottom，避免两套定位冲突
        startLeft = mRect.left - pRect.left;
        startTop = mRect.top - pRect.top;
        modal.style.right = 'auto';
        modal.style.bottom = 'auto';
        modal.style.left = startLeft + 'px';
        modal.style.top = startTop + 'px';
      }

      /** 在父容器范围内夹取 left/top，防止拖出答题面板边界 */
      function clampPosition(left, top) {
        const parent = modal.parentElement;
        if (!parent) return { left, top };
        const mRect = modal.getBoundingClientRect();
        const pRect = parent.getBoundingClientRect();
        const maxLeft = Math.max(0, pRect.width - mRect.width);
        const maxTop = Math.max(0, pRect.height - mRect.height);
        return {
          left: Math.min(Math.max(0, left), maxLeft),
          top:  Math.min(Math.max(0, top),  maxTop),
        };
      }

      /** 鼠标按下：判断是否在可拖区（不是关闭按钮），记录起点 */
      dragHandle.addEventListener('mousedown', (e) => {
        // 如果点在关闭按钮（×）上，不进入拖拽，交给按钮自己的 click 处理
        if (e.target.closest('#qrCloseBtn')) return;
        // 仅鼠标左键允许拖动（button=0）
        if (e.button !== 0) return;

        ensureLeftTopMode();
        dragging = false;                       // 先置 false，等超过阈值再标记
        startMouseX = e.clientX;
        startMouseY = e.clientY;
        // 选中起点时的 left/top（ensureLeftTopMode 已写入 startLeft/startTop）
        // 这里再记录一次初始值，后续与鼠标移动距离做差
        const baseLeft = startLeft;
        const baseTop = startTop;

        /** 鼠标移动：累计位移，超过阈值后真正进入 dragging */
        function onMove(moveEvt) {
          const dx = moveEvt.clientX - startMouseX;
          const dy = moveEvt.clientY - startMouseY;
          // 阈值判断：防止轻点标题文字被误认为拖动
          if (!dragging && (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD)) return;
          dragging = true;

          const newPos = clampPosition(baseLeft + dx, baseTop + dy);
          modal.style.left = newPos.left + 'px';
          modal.style.top  = newPos.top  + 'px';
        }

        /** 鼠标抬起：解绑全局移动/抬起，清理状态 */
        function onUp() {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          dragging = false;
        }

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        // 防止拖动时选中标题文字（浏览器默认拖拽文本）
        e.preventDefault();
      });
    } catch (e) {
      console.error('[overlay] initQrModalDrag 失败:', e.message);
    }
  }

  // ============================================================
  // 入口：DOMContentLoaded 后逐个初始化（每个都独立 try/catch）
  // ============================================================
  document.addEventListener('DOMContentLoaded', () => {
    const inits = [
      ['字体缩放', initFontZoom],
      ['拖动手柄', initDragHandle],
      ['关闭按钮', initCloseBtn],
      ['缩放手柄', initResizeHandles],
      ['ASR/答案渲染', initAsrAnswerRenderer],
      ['状态徽章', initStatusBadge],
      ['外部回写答案', initAnswerFromOutside],
      ['二维码按钮', initQrToggleBtn],
      ['连接状态监听', initQrStatusListeners],
      ['复制连接按钮', initQrCopyBtn],
      ['断开连接按钮', initQrDisconnectBtn],
      ['二维码弹窗关闭按钮', initQrCloseBtn],
      ['二维码弹窗拖拽', initQrModalDrag],
      ['截图解题按钮', initSolveBtn],
    ];
    inits.forEach(([name, fn]) => {
      try { fn(); console.log(`[overlay] ✔ ${name}`); }
      catch (e) { console.error(`[overlay] ❌ ${name}:`, e.message); }
    });
  });
})();
