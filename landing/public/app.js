/**
 * landing/public/app.js —— 宣传站点前端通用脚本
 *
 * 包含：
 *   1. Toast 工具（右上角轻提示，错误/成功/警告三类）
 *   2. 登录态查询：页面加载时调 GET /api/auth/me，
 *      根据结果替换导航栏按钮为"用户头像 + 登出"
 *   3. 登出处理：调 POST /api/auth/logout，清空会话并刷新页面
 *   4. 登录/注册页（login.html）使用：Tab 切换、表单校验、fetch 提交、错误展示
 *   5. 页脚年份自动填充
 */
'use strict';

(function () {
  // ------------------------------------------------------------
  // 通用 DOM 工具
  // ------------------------------------------------------------
  /** 根据 id 获取元素 */
  function $(id) { return document.getElementById(id); }
  /** 查询第一个元素 */
  function $q(sel, root) { return (root || document).querySelector(sel); }
  /** 查询所有元素，返回真数组 */
  function $qa(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  // ------------------------------------------------------------
  // 1. Toast 工具
  // ------------------------------------------------------------
  const Toast = {
    /** 取或创建 toast 容器 */
    _getWrap() {
      let w = $('toastWrap');
      if (w) return w;
      w = document.createElement('div');
      w.id = 'toastWrap';
      w.className = 'toast-wrap';
      w.setAttribute('role', 'status');
      w.setAttribute('aria-live', 'polite');
      document.body.appendChild(w);
      return w;
    },
    /**
     * 显示一条轻提示
     * @param {string} msg   文本
     * @param {'ok'|'error'|'warn'|''} [type]  类型
     * @param {number} [ttlMs]  停留毫秒，默认 2600
     */
    show(msg, type, ttlMs) {
      const wrap = this._getWrap();
      const el = document.createElement('div');
      el.className = 'toast' + (type === 'ok' ? ' ok' : type === 'error' ? ' error' : type === 'warn' ? ' warn' : '');
      el.textContent = String(msg || '');
      wrap.appendChild(el);
      setTimeout(() => {
        el.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
        el.style.opacity = '0';
        el.style.transform = 'translateX(20px)';
      }, (ttlMs || 2600) - 200);
      setTimeout(() => {
        if (el.parentNode) el.parentNode.removeChild(el);
      }, ttlMs || 2600);
    },
  };
  // 暴露到全局，方便 login.html 内联脚本也能用
  window.HireMeToast = Toast;

  // ------------------------------------------------------------
  // 2. HTTP 封装（统一 JSON + 错误处理 + 自动 Toast）
  // ------------------------------------------------------------
  const API = {
    /** 通用 fetch JSON 包装：返回 {ok, data, httpStatus, msg} */
    async call(path, options) {
      const opts = Object.assign({ credentials: 'same-origin', headers: {} }, options || {});
      if (opts.body && typeof opts.body !== 'string' && !(opts.body instanceof FormData)) {
        opts.body = JSON.stringify(opts.body);
        opts.headers['Content-Type'] = 'application/json';
      }
      let res;
      try {
        res = await fetch(path, opts);
      } catch (e) {
        return { ok: false, httpStatus: 0, msg: '网络异常，请检查连接：' + (e && e.message || e) };
      }
      let data = null;
      try { data = await res.json(); } catch (_) { data = null; }
      const result = {
        ok: !!(data && data.ok),
        httpStatus: res.status,
        data: data,
        msg: (data && data.msg) || (res.ok ? '成功' : `HTTP ${res.status}`),
      };
      return result;
    },
    register(payload) { return this.call('/api/auth/register', { method: 'POST', body: payload }); },
    login(payload)    { return this.call('/api/auth/login',    { method: 'POST', body: payload }); },
    logout()          { return this.call('/api/auth/logout',   { method: 'POST' }); },
    me()              { return this.call('/api/auth/me',       { method: 'GET' }); },
    // ---------- 控制台相关 ----------
    /** 公开：套餐列表 */
    getPackages()     { return this.call('/api/console/packages',   { method: 'GET' }); },
    /** 公开：功能单次消耗价目表 */
    getPriceList()    { return this.call('/api/console/price-list', { method: 'GET' }); },
    /** 需登录：当前用户积分余额 */
    getCredits()      { return this.call('/api/console/credits',    { method: 'GET' }); },
    /** 需登录：积分流水（opts: {type?, bizType?, fromMonth?, toMonth?, limit=100, desc=1}）*/
    getFlows(opts) {
      const q = new URLSearchParams();
      if (opts) {
        for (const k of ['type','bizType','fromMonth','toMonth']) {
          if (opts[k] != null && opts[k] !== '') q.set(k, String(opts[k]));
        }
        if (typeof opts.limit === 'number') q.set('limit', String(opts.limit));
        if (typeof opts.desc  === 'number') q.set('desc',  String(opts.desc));
        else if (opts.desc === true)        q.set('desc', '1');
      }
      const qs = q.toString();
      return this.call('/api/console/flows' + (qs ? ('?' + qs) : ''), { method: 'GET' });
    },
    /** 需登录：我的订单 */
    getOrders(limit) {
      const qs = typeof limit === 'number' ? ('?limit=' + limit) : '';
      return this.call('/api/console/orders' + qs, { method: 'GET' });
    },
    /** 需登录：创建购买订单 */
    createOrder(packageId) {
      return this.call('/api/console/orders/create', { method: 'POST', body: { packageId } });
    },
    /** 需登录：模拟支付（channel 默认 'mock'）*/
    payOrder(orderId, channel) {
      return this.call('/api/console/orders/pay', {
        method: 'POST', body: { orderId: orderId, channel: channel || 'mock' },
      });
    },
    /** 需登录：查询今日签到状态 */
    getCheckin()    { return this.call('/api/console/checkin', { method: 'GET' }); },
    /** 需登录：执行今日签到 */
    doCheckin()     { return this.call('/api/console/checkin', { method: 'POST' }); },
    /** 需登录：获取我的邀请码 + 邀请统计 + 邀请记录 */
    getInvite()     { return this.call('/api/console/invite', { method: 'GET' }); },
    /** 需登录：修改昵称 */
    updateProfile(displayName) {
      return this.call('/api/console/profile', { method: 'POST', body: { displayName } });
    },
    /** 需登录：修改密码 */
    changePassword(oldPassword, newPassword) {
      return this.call('/api/console/password', { method: 'POST', body: { oldPassword, newPassword } });
    },
    /** 需登录：兑换码兑换积分 */
    redeemCode(code) {
      return this.call('/api/console/redeem', { method: 'POST', body: { code } });
    },
    /** 需登录：我的兑换记录 */
    getRedeemRecords(page, limit) {
      const q = new URLSearchParams();
      if (typeof page === 'number') q.set('page', String(page));
      if (typeof limit === 'number') q.set('limit', String(limit));
      const qs = q.toString();
      return this.call('/api/console/redeem/records' + (qs ? ('?' + qs) : ''), { method: 'GET' });
    },
    /** 公开：已发布公告列表 */
    getNews(page, limit) {
      const q = new URLSearchParams();
      if (typeof page === 'number') q.set('page', String(page));
      if (typeof limit === 'number') q.set('limit', String(limit));
      const qs = q.toString();
      return this.call('/api/console/news' + (qs ? ('?' + qs) : ''), { method: 'GET' });
    },
    /** 公开：公告详情（newsId） */
    getNewsDetail(newsId) {
      return this.call('/api/console/news/' + encodeURIComponent(newsId), { method: 'GET' });
    },
  };
  window.HireMeAPI = API;

  // ------------------------------------------------------------
  // 3. 导航栏登录态渲染（登录成功 / 登出成功后都调用一次）
  // ------------------------------------------------------------
  /**
   * 根据当前登录态刷新 navActions：
   *   - 未登录：显示 [登录] [立即开始]
   *   - 已登录：显示 [头像+名字] [退出登录]
   * @param {Object|null} [userInfo] 若不传则调用 /api/auth/me 拉取
   */
  async function renderNavAuth(userInfo) {
    const navRoot = $('navActions');
    if (!navRoot) return; // 某些页面没有 navActions
    let user = null;
    if (userInfo && userInfo.loggedIn && userInfo.user) {
      user = userInfo.user;
    } else {
      const r = await API.me();
      if (r.ok && r.data && r.data.loggedIn && r.data.user) {
        user = r.data.user;
      }
    }

    if (!user) {
      // 未登录态
      navRoot.innerHTML =
        '<a href="/login.html?tab=login" class="btn btn-ghost">登录</a>' +
        '<a href="/login.html?tab=register" class="btn btn-primary">立即开始 →</a>';
      return;
    }
    // 已登录态：头像取自首字；无 name 则用邮箱前缀
    const avatarText = (user.displayName || user.email || 'U').trim().charAt(0).toUpperCase();
    const display = user.displayName || user.email || '';
    navRoot.innerHTML =
      `<div class="nav-user" title="${escapeAttr(user.email || '')}">` +
        `<span class="avatar">${escapeHtml(avatarText)}</span>` +
        `<span class="name">${escapeHtml(display)}</span>` +
      '</div>' +
      `<a href="/console.html" class="btn btn-ghost" id="navConsoleBtn" style="padding:8px 14px;">控制台</a>` +
      `<button type="button" class="btn btn-ghost" id="navLogoutBtn" style="padding:8px 14px;">退出登录</button>`;
    const btn = $('navLogoutBtn');
    if (btn) {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = '退出中…';
        const r = await API.logout();
        if (r.ok) {
          Toast.show('已退出登录', 'ok');
          setTimeout(() => { location.href = '/index.html'; }, 400);
        } else {
          Toast.show(r.msg || '退出失败', 'error');
          btn.disabled = false;
          btn.textContent = '退出登录';
        }
      });
    }
  }
  window.HireMeRenderNavAuth = renderNavAuth;

  // ------------------------------------------------------------
  // 4. 登录/注册页 (login.html) 交互
  //    这个文件会被 login.html 也引入，所以在检测到 #authBox 存在时启用。
  // ------------------------------------------------------------
  function initAuthPage() {
    const box = $('authBox');
    if (!box) return; // 非登录注册页，跳过

    // ---- URL tab 参数指定初始 Tab ----
    // ?tab=register  打开注册
    // ?tab=login     打开登录（默认）
    const params = new URLSearchParams(location.search || '');
    const initialTab = params.get('tab') === 'register' ? 'register' : 'login';

    const tabs = $qa('.auth-tab', box);
    const loginForm = $('loginForm');
    const registerForm = $('registerForm');
    const loginErr = $('loginErr');
    const regErr = $('registerErr');

    /** 切换 tab：切换 active class，显示/隐藏对应表单，清空错误 */
    function switchTab(name) {
      tabs.forEach((t) => {
        t.classList.toggle('active', t.getAttribute('data-tab') === name);
      });
      if (loginForm) loginForm.style.display = name === 'login' ? '' : 'none';
      if (registerForm) registerForm.style.display = name === 'register' ? '' : 'none';
      if (loginErr) loginErr.textContent = '';
      if (regErr) regErr.textContent = '';
      // 同步更新 URL query（不刷新页面），刷新后仍在同一个 tab
      try {
        const u = new URL(location.href);
        u.searchParams.set('tab', name);
        history.replaceState(null, '', u.toString());
      } catch (_) {}
      // 聚焦第一个输入框
      const first = (name === 'login' ? $('loginEmail') : $('registerEmail'));
      if (first) setTimeout(() => first.focus({ preventScroll: true }), 30);
    }

    tabs.forEach((t) => {
      t.addEventListener('click', () => switchTab(t.getAttribute('data-tab')));
    });

    // 表单里的"去登录 / 去注册"文字链接
    const gotoLogin = $('gotoLoginLink');
    const gotoRegister = $('gotoRegisterLink');
    if (gotoLogin) gotoLogin.addEventListener('click', () => switchTab('login'));
    if (gotoRegister) gotoRegister.addEventListener('click', () => switchTab('register'));

    // 初始 Tab
    switchTab(initialTab);

    // 从 URL 参数读取邀请码（如 ?invite=IA3K7QP），自动填充到注册表单并切换到注册 tab
    try {
      const params = new URLSearchParams(location.search);
      const inviteCode = params.get('invite') || params.get('ref') || '';
      if (inviteCode) {
        const inviteInput = $('registerInviteCode');
        if (inviteInput) inviteInput.value = inviteCode.toUpperCase();
        // 自动切换到注册 tab
        switchTab('register');
      }
    } catch (_) {}

    // ----------- 表单验证辅助 -----------
    /** 邮箱格式宽松校验（与后端 EMAIL_RE 对齐：非空 @ 非空 . 非空）*/
    function isEmail(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').trim()); }

    // ----------- 登录提交 -----------
    if (loginForm) {
      loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email    = ($('loginEmail')    || {}).value || '';
        const password = ($('loginPassword') || {}).value || '';
        const submitBtn = loginForm.querySelector('button[type="submit"]');

        if (loginErr) loginErr.textContent = '';
        if (!isEmail(email)) {
          if (loginErr) loginErr.textContent = '请输入正确的邮箱';
          Toast.show('请输入正确的邮箱', 'warn');
          return;
        }
        if (!password) {
          if (loginErr) loginErr.textContent = '请输入密码';
          Toast.show('请输入密码', 'warn');
          return;
        }

        if (submitBtn) { submitBtn.disabled = true; submitBtn.dataset.origin = submitBtn.textContent; submitBtn.textContent = '登录中…'; }
        try {
          const r = await API.login({ email, password });
          if (!r.ok) {
            if (loginErr) loginErr.textContent = r.msg || '登录失败';
            Toast.show(r.msg || '登录失败', 'error');
            return;
          }
          Toast.show('登录成功，正在跳转…', 'ok');
          // 同步导航栏状态后，跳回首页（或继续留在当前页由用户自己选）
          await renderNavAuth({ loggedIn: true, user: (r.data && r.data.user) || null });
          setTimeout(() => { location.href = '/index.html'; }, 500);
        } finally {
          if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = submitBtn.dataset.origin || '登录'; }
        }
      });
    }

    // ----------- 注册提交 -----------
    if (registerForm) {
      registerForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email        = ($('registerEmail')        || {}).value || '';
        const displayName  = ($('registerDisplayName')  || {}).value || '';
        const password     = ($('registerPassword')     || {}).value || '';
        const password2    = ($('registerPassword2')    || {}).value || '';
        const inviteCode   = ($('registerInviteCode')   || {}).value || '';
        const submitBtn = registerForm.querySelector('button[type="submit"]');

        if (regErr) regErr.textContent = '';
        if (!isEmail(email))              { if (regErr) regErr.textContent = '请输入正确的邮箱'; Toast.show('请输入正确的邮箱', 'warn'); return; }
        if (String(password).length < 6)  { if (regErr) regErr.textContent = '密码至少需要 6 个字符'; Toast.show('密码过短（至少 6 位）', 'warn'); return; }
        if (password !== password2)       { if (regErr) regErr.textContent = '两次输入的密码不一致'; Toast.show('两次密码不一致', 'warn'); return; }

        if (submitBtn) { submitBtn.disabled = true; submitBtn.dataset.origin = submitBtn.textContent; submitBtn.textContent = '创建中…'; }
        try {
          // 传 inviteCode 给后端（有值时后端会处理邀请奖励）
          const r = await API.register({ email, password, displayName, inviteCode });
          if (!r.ok) {
            if (regErr) regErr.textContent = r.msg || '注册失败';
            Toast.show(r.msg || '注册失败', 'error');
            return;
          }
          // 注册成功提示（含邀请奖励信息）
          const data = r.data || {};
          let msg = data.msg || '注册成功，已自动登录';
          if (data.inviteReward > 0) msg = `注册成功！受邀奖励 +${data.inviteReward} 积分已到账`;
          Toast.show(msg, 'ok');
          await renderNavAuth({ loggedIn: !!data.autoLogin, user: data.user || null });
          setTimeout(() => { location.href = '/index.html'; }, 600);
        } finally {
          if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = submitBtn.dataset.origin || '创建账号'; }
        }
      });
    }

    // 回车跳字段小优化：注册表单里 password2 回车则直接提交（浏览器默认为 submit，已正常）
  }

  // ------------------------------------------------------------
  // 7. 控制台页面（console.html）初始化
  // ------------------------------------------------------------
  function initConsolePage() {
    // 判断：必须有 #consoleMain / #consoleUnauth 才算控制台页面
    const mainEl  = $('consoleMain');
    const unauth  = $('consoleUnauth');
    if (!mainEl || !unauth) return;

    // 工具：隐藏某 DOM（classList 控制）
    function show(el) { if (el) { el.classList.remove('hidden'); el.style.display = ''; } }
    function hide(el) { if (el) { el.classList.add('hidden'); el.style.display = 'none'; } }

    /**
     * 设置指定 id 元素的文本内容
     * @param {string} id 元素 id
     * @param {string} val 要设置的文本值
     */
    function setText(id, val) {
      const el = $(id);
      if (el) el.textContent = String(val);
    }

    /**
     * 格式化日期时间字符串（用于活动列表时间显示）
     * @param {string|number} ts ISO 时间戳或毫秒数
     * @returns {string} 格式化后的日期
     */
    function formatDateTime(ts) {
      if (!ts) return '';
      const d = new Date(typeof ts === 'number' ? ts : ts.includes('T') ? ts : Number(ts));
      if (isNaN(d.getTime())) return String(ts);
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    // ---------- 签到配置（7天周期） ----------
    const CHECKIN_CONFIG = [
      { day: 1, reward: 50,  label: '1/7天' },
      { day: 2, reward: 10,  label: '' },
      { day: 3, reward: 15,  label: '' },
      { day: 4, reward: 20,  label: '' },
      { day: 5, reward: 30,  label: '' },
      { day: 6, reward: 50,  label: '' },
      { day: 7, reward: 100, label: '' },
    ];

    // ---------- 菜单交互 ----------
    function initMenuNavigation() {
      const menuItems = $qa('.menu-item');
      // 所有面板元素（用于切换显示/隐藏）
      const panels = {
        overview: $('overviewPanel'),
        credit:   $('creditPanel'),   // 充值积分面板
        invite:   $('invitePanel'),   // L434 新增：邀请有礼完整页面板
        flows:    $('flowsPanel'),
        orders:   $('ordersPanel'),
        settings: $('settingsPanel'),
        redeem:   $('redeemPanel'),
        news:     $('newsPanel'),
        copilot:  $('copilotPanel'),
        mock:     $('mockPanel'),
        resume:   $('resumePanel'),
        sessions: $('sessionsPanel'), // L14 新增：面试记录（桌面端 SQLite）面板
      };

      // 切换面板：隐藏所有面板，显示目标面板
      function switchPanel(name) {
        Object.values(panels).forEach(p => { if (p) p.classList.add('hidden'); });
        const target = panels[name];
        if (target) target.classList.remove('hidden');
        // 暴露给外部（供跨面板跳转，如 buyCreditsLink）
        window.HireMeSwitchPanel = switchPanel;
      }
      // 首次初始化也把切换函数暴露出去，避免 bindBuyCredits 调用时还没注册
      window.HireMeSwitchPanel = switchPanel;

      // 按 data-menu 激活某一项侧边栏菜单（用于总览按钮跳转时高亮充值积分菜单）
      function activateMenu(menuKey) {
        menuItems.forEach((m) => {
          m.classList.toggle('active', m.dataset.menu === menuKey);
        });
      }
      window.HireMeActivateMenu = activateMenu;

      menuItems.forEach((item) => {
        item.addEventListener('click', (e) => {
          e.preventDefault();
          menuItems.forEach((m) => m.classList.remove('active'));
          item.classList.add('active');
          const menu = item.dataset.menu;

          // 已实现的面板：切换显示
          if (menu === 'overview') { switchPanel('overview'); return; }
          if (menu === 'credit')   { switchPanel('credit');   bindCreditRecharge(); refreshCreditBalance(); return; }
          if (menu === 'flows')    { switchPanel('flows');    loadFlows(1); return; }
          if (menu === 'orders')   { switchPanel('orders');   loadOrders(); return; }
          if (menu === 'settings') { switchPanel('settings'); loadSettings(); return; }
          if (menu === 'invite')   { switchPanel('invite');   bindInvitePage(); loadInvitePageInfo(); return; }
          if (menu === 'redeem')   { switchPanel('redeem');   loadRedeemRecords(); bindRedeem(); return; }
          if (menu === 'news')     { switchPanel('news');     loadNews(1); return; }
          if (menu === 'copilot')  { switchPanel('copilot');  bindCopilot(); return; }
          if (menu === 'mock')     { switchPanel('mock');     initMockPanel(); return; }
          if (menu === 'resume')   { switchPanel('resume');   bindResume(); return; }
          if (menu === 'sessions') { switchPanel('sessions'); bindSessionsPanel(); return; }

          // 其他未实现功能
          Toast.show(`${item.querySelector('.menu-text')?.textContent || '该功能'} 即将上线`, 'ok');
          // 切回总览面板
          switchPanel('overview');
        });
      });

      // 顶部返回链接（充值积分页内的「← 返回控制台」）也支持 data-menu 触发切换
      const backLinks = $qa('.credit-back-link');
      backLinks.forEach(link => {
        link.addEventListener('click', (e) => {
          const menu = link.dataset.menu || 'overview';
          e.preventDefault();
          activateMenu(menu);
          switchPanel(menu);
        });
      });
    }

    // ---------- 渲染用户信息 ----------
    function renderUserInfo(user) {
      // 缓存用户信息，供个人设置页面使用
      window.HireMeCurrentUser = user;

      const avatar = $('userAvatar');
      const nameEl = $('userName');
      const emailEl = $('userEmail');
      const welcomeEl = $('welcomeTitle');

      if (avatar) {
        const firstChar = (user.displayName || user.email || 'U').charAt(0).toUpperCase();
        avatar.textContent = firstChar;
      }
      if (nameEl) {
        nameEl.textContent = user.displayName || user.email || '用户';
      }
      if (emailEl) {
        emailEl.textContent = user.email || 'user@example.com';
      }
      if (welcomeEl) {
        const hour = new Date().getHours();
        let greeting = '欢迎回来';
        if (hour < 6) greeting = '夜深了，注意休息';
        else if (hour < 12) greeting = '早上好';
        else if (hour < 18) greeting = '下午好';
        else greeting = '晚上好';
        welcomeEl.textContent = `${greeting}，${user.displayName || '同学'} 👋`;
      }
    }

    // ---------- 渲染积分信息 ----------
    function renderCredits(credits) {
      const amountEl = $('creditsAmount');
      const balance = Number(credits.balance) || 0;
      if (amountEl) {
        amountEl.textContent = balance;
      }
      // 计算可用次数（假设单次消耗：Copilot 5分、Mock 3分、简历 10分）
      const mockRemaining = Math.floor(balance / 3);
      const copilotRemaining = Math.floor(balance / 5);
      const resumeRemaining = Math.floor(balance / 10);
      setText('mockRemaining', String(mockRemaining));
      setText('copilotRemaining', String(copilotRemaining));
      setText('resumeRemaining', String(resumeRemaining));
    }

    // ---------- 渲染签到进度 ----------
    // status: { alreadyCheckedIn, currentDay, todayReward, continuousDays } 来自后端
    function renderCheckIn(status) {
      const bar = $('checkinBar');
      const rewards = $('checkinRewards');
      const progressText = $('checkinProgressText');
      const btn = $('checkinBtn');
      if (!bar || !rewards) return;

      // 兼容旧调用方式：传数字时按 currentDay 处理
      if (typeof status === 'number') {
        status = { alreadyCheckedIn: false, currentDay: status, todayReward: CHECKIN_CONFIG[status - 1]?.reward || 50 };
      }
      const currentDay = status.currentDay || 1;
      const alreadyCheckedIn = !!status.alreadyCheckedIn;

      // 渲染签到点和连接线
      let barHTML = '';
      let rewardsHTML = '';

      for (let i = 0; i < CHECKIN_CONFIG.length; i++) {
        const cfg = CHECKIN_CONFIG[i];
        // 已签到时，今天这一天也算 checked
        const isChecked = alreadyCheckedIn ? cfg.day <= currentDay : cfg.day < currentDay;
        const isCurrent = cfg.day === currentDay;

        // 连接线（第1个点之前没有线，其余点之前有一段线）
        if (i > 0) {
          barHTML += `<div class="checkin-segment ${cfg.day <= currentDay ? 'filled' : ''}"></div>`;
        }
        // 签到圆点
        barHTML += `<div class="checkin-dot ${isChecked ? 'checked' : ''} ${isCurrent ? 'current' : ''}"></div>`;

        // 奖励标签
        rewardsHTML += `
          <div class="checkin-reward">
            <span class="reward-amount ${isChecked ? 'done' : ''}">+${cfg.reward}</span>
            ${cfg.label ? `<span class="day-label">${cfg.label}</span>` : ''}
          </div>
        `;
      }

      bar.innerHTML = barHTML;
      rewards.innerHTML = rewardsHTML;

      // 更新进度提示文字 + 签到按钮状态
      if (progressText) {
        if (alreadyCheckedIn) {
          progressText.textContent = `今日已签到（连续第 ${currentDay} 天），明天再来！`;
        } else if (currentDay > CHECKIN_CONFIG.length) {
          progressText.textContent = '已完成全部签到，感谢你的坚持！';
        } else {
          progressText.textContent = `今日签到可获得 +${status.todayReward || CHECKIN_CONFIG[currentDay - 1].reward} 积分`;
        }
      }
      // 已签到则禁用按钮
      if (btn) {
        btn.disabled = alreadyCheckedIn;
        btn.textContent = alreadyCheckedIn ? '已签到' : '立即签到';
      }
    }

    // ---------- 渲染最近活动 ----------
    function renderActivities(flows) {
      const listEl = $('activityList');
      if (!listEl) return;

      if (!flows || flows.length === 0) {
        listEl.innerHTML = `
          <div class="activity-empty">
            <div style="font-size:40px;margin-bottom:8px;">📋</div>
            <p>还没有活动记录</p>
            <p style="color:var(--text-tertiary);margin-top:4px;">购买积分或使用桌面端后，这里会显示相关记录</p>
          </div>
        `;
        return;
      }

      // 取最近 5 条记录
      const recent = flows.slice(0, 5);
      listEl.innerHTML = recent.map((f) => {
        const iconMap = {
          charge: '💎', consume: '🎯', refund: '↩️', reward: '🎁', adjust: '🛠',
        };
        const icon = iconMap[f.type] || '📄';
        const count = f.type === 'charge' ? `+${Number(f.delta)}` : (f.delta >= 0 ? `+${Number(f.delta)}` : Number(f.delta));
        const dateStr = formatDateTime(f.createdAt);
        // 只显示日期部分（YYYY/MM/DD）
        const dateOnly = dateStr.split(' ')[0] || dateStr;
        return `
          <div class="activity-item">
            <div class="activity-icon">${icon}</div>
            <div class="activity-info">
              <div class="activity-title">${escapeHtml(f.desc || '积分变动')}</div>
              <div class="activity-meta">${escapeHtml(f.bizType || '')}${f.bizType ? ' · ' : ''}${dateOnly}</div>
            </div>
            <div class="activity-count">${count}</div>
            <div class="activity-date">${dateOnly}</div>
          </div>
        `;
      }).join('');
    }

    // ---------- 购买积分跳转（总览页 -> 充值积分面板） ----------
    function bindBuyCredits() {
      const link = $('buyCreditsLink');
      if (link) {
        link.addEventListener('click', (e) => {
          e.preventDefault();
          // 跳到充值积分面板：高亮菜单 + 切面板 + 刷新余额 + 绑定套餐卡片
          if (window.HireMeActivateMenu) window.HireMeActivateMenu('credit');
          if (window.HireMeSwitchPanel)  window.HireMeSwitchPanel('credit');
          bindCreditRecharge();
          refreshCreditBalance();
        });
      }
      // 订单页右上角的「购买积分」按钮同步改为跳转到充值面板
      const btn2 = $('buyCreditsBtn2');
      if (btn2) {
        btn2.onclick = (e) => {
          e.preventDefault();
          if (window.HireMeActivateMenu) window.HireMeActivateMenu('credit');
          if (window.HireMeSwitchPanel)  window.HireMeSwitchPanel('credit');
          bindCreditRecharge();
          refreshCreditBalance();
        };
      }
    }

    // ---------- 刷新充值页当前余额（与总览保持一致） ----------
    async function refreshCreditBalance() {
      const el = $('creditBalanceNum');
      if (!el) return;
      try {
        const r = await API.getCredits();
        const bal = Number(r && r.ok && r.data && r.data.credits && r.data.credits.balance) || 0;
        el.textContent = bal.toLocaleString();
      } catch (_e) {
        el.textContent = '0';
      }
    }
    window.HireMeRefreshCreditBalance = refreshCreditBalance;

    // ---------- 充值积分面板：套餐选中 & 下单支付 ----------
    let _creditRechargeBound = false;
    // 当前选中的套餐元数据（积分、价格、packageId、标题展示）
    let _currentPack = {
      packageId: 'c1020', priceYuan: 85,
      creditsText: '1,020 积分', creditsNum: 1020,
    };

    function bindCreditRecharge() {
      if (_creditRechargeBound) { updateCreditPaySummary(); return; }
      _creditRechargeBound = true;

      const packList = $('creditPackList');
      const summaryEl = $('creditPaySummary');
      const payBtn = $('creditPayBtn');
      if (!packList) return;

      // 5 档积分套餐定义（与 db.js packages 新增 5 条一致，同时兜底 HTML 里那 5 条）
      const PACK_META = {
        c120:  { packageId: 'c120',  priceYuan: 10,  creditsText: '120 积分',   creditsNum: 120 },
        c520:  { packageId: 'c520',  priceYuan: 45,  creditsText: '520 积分',   creditsNum: 520 },
        c1020: { packageId: 'c1020', priceYuan: 85,  creditsText: '1,020 积分', creditsNum: 1020 },
        c2020: { packageId: 'c2020', priceYuan: 160, creditsText: '2,020 积分', creditsNum: 2020 },
        c5020: { packageId: 'c5020', priceYuan: 375, creditsText: '5,020 积分', creditsNum: 5020 },
        // 兼容 DB 中已有老套餐（pico/pro/elite/max），让它们也可以走同一套选中态
        pico:  { packageId: 'pico',  priceYuan: 9.9,  creditsText: '50 积分',   creditsNum: 50 },
        pro:   { packageId: 'pro',   priceYuan: 29.9, creditsText: '220 积分',  creditsNum: 220 },
        elite: { packageId: 'elite', priceYuan: 99,   creditsText: '950 积分',  creditsNum: 950 },
        max:   { packageId: 'max',   priceYuan: 199,  creditsText: '2500 积分', creditsNum: 2500 },
      };

      // 根据 data-package-id 选中某张套餐卡片（更新 selected 样式 + 更新支付条）
      function selectCard(packageId) {
        const cards = packList.querySelectorAll('.credit-pack-card');
        let pickedMeta = PACK_META[packageId];
        cards.forEach(card => {
          const pid = card.dataset.packageId;
          const isSel = (pid === packageId);
          card.classList.toggle('selected', isSel);
          if (isSel && !pickedMeta) {
            // HTML 兜底数据驱动：从 card 本身提取元数据
            const priceYuan = Number(card.dataset.priceYuan) || 0;
            const title = card.querySelector('.credit-pack-main .title');
            const creditsText = (title ? title.childNodes[0]?.textContent?.trim() : '') || packageId;
            pickedMeta = { packageId: pid, priceYuan, creditsText, creditsNum: 0 };
          }
        });
        if (pickedMeta) {
          _currentPack = pickedMeta;
          updateCreditPaySummary();
        }
      }

      function updateCreditPaySummary() {
        if (!summaryEl) return;
        const { creditsText, priceYuan } = _currentPack;
        summaryEl.innerHTML = `${creditsText} · <span class="accent">¥${priceYuan}</span>`;
      }

      // 初始化默认选中
      const defaultSel = packList.querySelector('.credit-pack-card.selected');
      if (defaultSel && defaultSel.dataset.packageId) {
        selectCard(defaultSel.dataset.packageId);
      } else {
        updateCreditPaySummary();
      }

      // 点击卡片 -> 切换选中
      packList.addEventListener('click', (ev) => {
        const card = ev.target.closest('.credit-pack-card');
        if (!card || !card.dataset.packageId) return;
        selectCard(card.dataset.packageId);
      });

      // 点击支付按钮：调用 API.createOrder + payOrder（mock 支付）
      if (payBtn) {
        payBtn.addEventListener('click', async () => {
          const { packageId, creditsText, priceYuan } = _currentPack;
          if (!packageId) {
            Toast.show('请先选择套餐', 'error');
            return;
          }
          payBtn.disabled = true;
          const originalText = payBtn.textContent;
          payBtn.textContent = '支付中...';
          try {
            // 1. 创建订单（真实数据库订单）
            const orderR = await API.createOrder(packageId);
            if (!orderR || !orderR.ok || !orderR.data || !orderR.data.orderId) {
              Toast.show(`创建订单失败：${orderR?.msg || '未知错误'}`, 'error');
              return;
            }
            const orderId = orderR.data.orderId;
            // 2. 模拟支付（channel=mock），实际项目中可替换为微信/支付宝
            const payR = await API.payOrder(orderId, 'mock');
            if (payR && payR.ok) {
              Toast.show(`购买 ${creditsText}（¥${priceYuan}）成功！`, 'ok');
              // 购买完成后刷新：充值页余额 + 总览余额 + 订单列表
              await refreshCreditBalance();
              try {
                const cr = await API.getCredits();
                if (cr.ok && cr.data) renderCredits(cr.data.credits || { balance: 0 });
              } catch (_e) {}
            } else {
              Toast.show(`支付失败：${payR?.msg || '未知错误'}`, 'error');
            }
          } catch (err) {
            console.error('[credit-pay] 异常', err);
            Toast.show('支付过程异常，请稍后重试', 'error');
          } finally {
            payBtn.disabled = false;
            payBtn.textContent = originalText;
          }
        });
      }
    }
    window.HireMeBindCreditRecharge = bindCreditRecharge;

    // ---------- 快捷操作绑定（L832：download→面试Copilot，mock→模拟面试，resume→简历优化） ----------
    function bindQuickActions() {
      const actions = $qa('.action-card');
      actions.forEach((card) => {
        card.addEventListener('click', (e) => {
          e.preventDefault();
          const action = card.dataset.action;
          // 每个快捷操作映射到对应菜单面板（与侧边栏 data-menu 一致）
          const menuMap = {
            download: 'copilot',   // 下载 Copilot 桌面端 → 面试 Copilot 菜单
            mock:     'mock',      // 开始模拟面试 → 模拟面试 菜单
            resume:   'resume',    // 优化简历 → 简历优化 菜单
          };
          const menuKey = menuMap[action];
          if (!menuKey) return;
          // 1. 激活侧边栏对应菜单项的高亮
          if (window.HireMeActivateMenu) window.HireMeActivateMenu(menuKey);
          // 2. 切换到对应面板，并执行面板的初始化函数
          if (window.HireMeSwitchPanel) window.HireMeSwitchPanel(menuKey);
          if (menuKey === 'copilot') bindCopilot();
          if (menuKey === 'mock')    initMockPanel();
          if (menuKey === 'resume')  bindResume();
        });
      });
    }

    // ---------- 绑定退出登录 ----------
    function bindLogout() {
      const btn = $('logoutBtn');
      if (btn) {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          const originalText = btn.innerHTML;
          btn.innerHTML = '<span class="menu-icon">⏳</span><span>退出中...</span>';
          try {
            const r = await API.logout();
            if (r.ok) {
              Toast.show('已退出登录', 'ok');
              setTimeout(() => { location.href = '/index.html'; }, 500);
            } else {
              Toast.show(r.msg || '退出失败', 'error');
              btn.disabled = false;
              btn.innerHTML = originalText;
            }
          } catch (err) {
            Toast.show('网络异常，请重试', 'error');
            btn.disabled = false;
            btn.innerHTML = originalText;
          }
        });
      }
    }

    // ---------- 绑定反馈按钮 ----------
    function bindFeedback() {
      const btn = $('feedbackBtn');
      if (btn) {
        btn.addEventListener('click', () => {
          Toast.show('反馈功能即将上线', 'ok');
        });
      }
    }

    // ---------- 加载签到状态（从后端获取真实数据） ----------
    async function loadCheckinStatus() {
      try {
        const r = await API.getCheckin();
        if (r.ok && r.data && r.data.status) {
          renderCheckIn(r.data.status);
        } else {
          // 接口异常时回退到默认第1天
          renderCheckIn({ alreadyCheckedIn: false, currentDay: 1, todayReward: 50 });
        }
      } catch (e) {
        console.warn('[console] 加载签到状态失败：', e);
      }
    }

    // ---------- 执行今日签到（按钮点击触发） ----------
    async function doCheckinAction() {
      const btn = $('checkinBtn');
      if (btn) { btn.disabled = true; btn.textContent = '签到中...'; }
      try {
        const r = await API.doCheckin();
        if (r.ok && r.data) {
          const d = r.data;
          if (d.ok) {
            // 签到成功：提示 + 更新进度 + 刷新积分余额
            Toast.show(d.msg || '签到成功', 'ok');
            renderCheckIn({
              alreadyCheckedIn: true,
              currentDay: d.currentDay,
              todayReward: d.reward,
            });
            // 刷新积分余额显示
            const creditsR = await API.getCredits();
            if (creditsR.ok && creditsR.data && creditsR.data.credits) {
              renderCredits(creditsR.data.credits);
            }
            // 刷新最近活动列表（签到会产生新流水）
            const flowsR = await API.getFlows({ limit: 10, desc: 1 });
            if (flowsR.ok && flowsR.data) {
              renderActivities(flowsR.data.flows);
            }
          } else if (d.alreadyCheckedIn) {
            // 今日已签到
            Toast.show(d.msg || '今日已签到', 'ok');
            renderCheckIn({
              alreadyCheckedIn: true,
              currentDay: d.currentDay,
              todayReward: d.reward,
            });
          } else {
            Toast.show(d.msg || '签到失败', 'error');
            if (btn) { btn.disabled = false; btn.textContent = '立即签到'; }
          }
        } else {
          Toast.show((r.data && r.data.msg) || '签到失败，请稍后重试', 'error');
          if (btn) { btn.disabled = false; btn.textContent = '立即签到'; }
        }
      } catch (e) {
        console.error('[console] 签到异常：', e);
        Toast.show('签到失败，请稍后重试', 'error');
        if (btn) { btn.disabled = false; btn.textContent = '立即签到'; }
      }
    }
    // 暴露给 HTML onclick 调用
    window.HireMeDoCheckin = doCheckinAction;

    // ---------- 加载邀请好友信息（overview 横条版本保留，保证向后兼容） ----------
    async function loadInviteInfo() {
      // 现在总览的「邀请好友」已改为精简横条，不再需要旧卡片渲染；
      // 完整邀请信息改走 loadInvitePageInfo 填充 invitePanel 面板
    }

    // ---------- 总览横条 invitePromoBar → 点击跳转「邀请有礼」面板 ----------
    function bindInvitePromoBar() {
      const bar = $('invitePromoBar');
      if (!bar) return;
      bar.addEventListener('click', (e) => {
        e.preventDefault();
        // 与侧边栏「邀请有礼」按钮行为一致：高亮 + 切面板 + 拉数据
        if (window.HireMeActivateMenu) window.HireMeActivateMenu('invite');
        if (window.HireMeSwitchPanel)  window.HireMeSwitchPanel('invite');
        bindInvitePage();
        loadInvitePageInfo();
      });
    }

    // ---------- 邀请有礼完整页（invitePanel）：事件绑定 ----------
    let _invitePageBound = false;
    function bindInvitePage() {
      if (_invitePageBound) return;
      _invitePageBound = true;
      // 「📋 复制」邀请码按钮
      const codeBtn = $('invitePanelCopyCodeBtn');
      if (codeBtn) codeBtn.addEventListener('click', () => copyInviteContent('code'));
      // 「🔗 一键复制分享文案」按钮
      const shareBtn = $('invitePanelCopyShareBtn');
      if (shareBtn) shareBtn.addEventListener('click', () => copyInviteContent('share'));
    }

    // ---------- 邀请有礼完整页：拉取数据 + 渲染（余额、邀请码、分享链接、记录） ----------
    async function loadInvitePageInfo() {
      try {
        const r = await API.getInvite();
        if (!r.ok || !r.data || !r.data.invite) return;
        renderInvitePage(r.data.invite);
      } catch (e) {
        console.warn('[console] 邀请有礼页加载失败：', e);
      }
    }

    // ---------- 邀请有礼完整页：渲染函数 ----------
    function renderInvitePage(invite) {
      const code = invite.inviteCode || '';

      // 1) 你的邀请码大字
      const codeEl = $('invitePanelCodeValue');
      if (codeEl) codeEl.textContent = code || '—';

      // 2) 分享链接预览（把 YOURCODE 替换成真实邀请码）
      const linkEl = $('invitePanelShareLink');
      let linkText = (invite.inviteLink || '').trim();
      if (!linkText && code) {
        // 后端若没返回邀请链接，按与图 2 一致的路径拼接
        linkText = `https://interviewasssistant.com/zh/register?ref=${encodeURIComponent(code)}`;
      }
      if (linkEl) linkEl.textContent = linkText || '—';

      // 3) 推广余额条（左：余额 ¥69；右：已邀请/付费人数/赚了积分）
      //    后端目前返回 totalReward（赚了积分）和 totalInvited（已邀请人数）；
      //    付费人数/推广余额是扩展字段，缺省时用 0 或由积分折算（100积分≈¥1）展示
      const invitedNum = Number(invite.totalInvited || 0) || 0;
      const earnedCredits = Number(invite.totalReward || 0) || 0;
      const paidNum   = Number(invite.totalPaidCount || invite.paidCount || 0) || 0;
      // 推广余额：优先用后端 promoBalanceCents（分），否则按 100:1 粗略展示（¥ = 积分/100）
      let balanceYuan;
      if (typeof invite.promoBalanceYuan === 'number') {
        balanceYuan = invite.promoBalanceYuan;
      } else if (typeof invite.promoBalanceCents === 'number') {
        balanceYuan = Math.round(invite.promoBalanceCents) / 100;
      } else {
        // 兼容老数据：把赚到的积分当余额预览展示，保证数值不空（显示 2 位小数）
        balanceYuan = Math.round((earnedCredits / 100 + Number.EPSILON) * 100) / 100;
      }
      const bal = $('promoBalanceAmt');
      if (bal) bal.textContent = balanceYuan.toFixed(2);

      const invN = $('promoInvited'); if (invN) invN.textContent = invitedNum;
      const paidN = $('promoPaid');   if (paidN) paidN.textContent = paidNum;
      const earnN = $('promoEarned'); if (earnN) earnN.textContent = earnedCredits;

      // 4) 邀请记录列表（右侧状态徽章匹配图 2：已注册/已用桌面端/已付费/检测到风险）
      const listEl = $('invitePanelRecordsList');
      if (listEl) {
        const records = Array.isArray(invite.records) ? invite.records : [];
        if (records.length === 0) {
          listEl.innerHTML = `<div class="invite-records-empty">暂无邀请记录，快去邀请好友吧</div>`;
        } else {
          listEl.innerHTML = records.map(rec => {
            const email = rec.inviteeEmail || '未知用户';
            const date  = rec.createdAt ? formatDateTime(rec.createdAt) : '';
            // 状态推导：优先级 paid(已付费) > risk(检测到风险) > desktop(已用桌面端) > register(已注册)
            const paid    = Boolean(rec.hasPaid    || rec.status === 'paid');
            const risk    = Boolean(rec.hasRisk    || rec.status === 'risk' || rec.risky);
            const desktop = Boolean(rec.usedDesktop || rec.status === 'desktop' || rec.inviterReward >= 80);
            let badgeKind = 'register';
            let badgeText = '已注册';
            if (paid)    { badgeKind = 'paid';    badgeText = '✓ 已付费'; }
            else if (risk)    { badgeKind = 'risk';    badgeText = '⚠ 检测到风险'; }
            else if (desktop) { badgeKind = 'desktop'; badgeText = '✓ 已用桌面端'; }
            return `
              <div class="irf-record">
                <div class="irf-record-left">
                  <div class="irf-email">${email}</div>
                  <div class="irf-date">${date}</div>
                </div>
                <span class="irf-badge ${badgeKind}">${badgeText}</span>
              </div>
            `;
          }).join('');
        }
      }
    }

    // ---------- 旧 renderInvite（保留避免引用报错，内容已移到 renderInvitePage） ----------
    function renderInvite(_invite) { /* 空实现：总览旧卡片已移除，渲染移到 renderInvitePage */ }

    // ---------- 复制邀请码 / 邀请链接 / 完整分享文案（type: code / link / share） ----------
    async function copyInviteContent(type) {
      try {
        const r = await API.getInvite();
        if (!r.ok || !r.data || !r.data.invite) {
          Toast.show('获取邀请信息失败', 'error');
          return;
        }
        const inv = r.data.invite;
        const code = inv.inviteCode || '';
        let link = (inv.inviteLink || '').trim();
        if (!link && code) {
          link = `https://interviewasssistant.com/zh/register?ref=${encodeURIComponent(code)}`;
        }

        // 依据 type 生成要复制的文本内容
        let text, toastMsg;
        if (type === 'share') {
          text =
            `面试总被问到不会的问题？试试即答侠 — AI 实时面试助手，面试时在旁边悄悄提词，模拟面试、简历优化一站搞定，用了之后面试通过率直接翻倍 🚀\n` +
            `🔗 ${link}`;
          toastMsg = '分享文案已复制！快去发给好友吧 👭';
        } else if (type === 'link') {
          text = link;
          toastMsg = '邀请链接已复制！快去分享给好友吧';
        } else {
          text = code;
          toastMsg = '邀请码已复制！';
        }

        // 使用 Clipboard API 复制
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
        } else {
          // 兜底：创建临时 textarea 执行 execCommand
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
        }
        Toast.show(toastMsg, 'ok');
      } catch (e) {
        console.error('[console] 复制邀请码失败：', e);
        Toast.show('复制失败，请手动复制', 'error');
      }
    }
    // 暴露给 HTML onclick 调用
    window.HireMeCopyInvite = copyInviteContent;

    // ---------- 加载积分明细（分页流水） ----------
    async function loadFlows(page) {
      page = page || 1;
      const limit = 20;
      const offset = (page - 1) * limit;
      try {
        const r = await API.getFlows({ limit, offset, desc: 1 });
        if (r.ok && r.data) {
          renderFlows(r.data.flows || []);
          renderFlowsPagination(r.data.total || 0, page, limit);
        }
      } catch (e) {
        console.error('[console] 加载流水失败：', e);
        const tb = $('flowsTableBody');
        if (tb) tb.innerHTML = '<tr><td colspan="5" class="table-empty">加载失败</td></tr>';
      }
    }
    // 暴露给 HTML onclick 调用
    window.HireMeLoadFlows = loadFlows;

    // ---------- 渲染积分明细表格 ----------
    function renderFlows(flows) {
      const tb = $('flowsTableBody');
      if (!tb) return;
      if (!flows || flows.length === 0) {
        tb.innerHTML = '<tr><td colspan="5" class="table-empty">暂无积分流水</td></tr>';
        return;
      }
      // 映射流水类型为中文
      const typeMap = {
        recharge: '充值', consume: '消费', reward: '奖励',
        refund: '退款', adjust: '调账', admin: '管理',
      };
      tb.innerHTML = flows.map(f => {
        const date = formatDateTime(f.createdAt);
        const type = typeMap[f.type] || f.type || '—';
        const desc = f.desc || '—';
        const delta = f.delta;
        const deltaClass = delta > 0 ? 'positive' : 'negative';
        const deltaStr = delta > 0 ? `+${delta}` : `${delta}`;
        const balance = f.balanceAfter !== undefined ? f.balanceAfter : '—';
        return `<tr>
          <td>${date}</td>
          <td>${type}</td>
          <td>${desc}</td>
          <td class="flow-delta ${deltaClass}">${deltaStr}</td>
          <td>${balance}</td>
        </tr>`;
      }).join('');
    }

    // ---------- 渲染积分明细分页 ----------
    function renderFlowsPagination(total, currentPage, limit) {
      const el = $('flowsPagination');
      if (!el) return;
      const totalPages = Math.ceil(total / limit) || 1;
      if (totalPages <= 1) { el.innerHTML = ''; return; }
      let html = '';
      // 上一页
      html += `<button ${currentPage <= 1 ? 'disabled' : ''} onclick="window.HireMeLoadFlows(${currentPage - 1})">上一页</button>`;
      // 页码
      for (let i = 1; i <= totalPages; i++) {
        if (i === currentPage) {
          html += `<button class="active">${i}</button>`;
        } else if (Math.abs(i - currentPage) <= 2 || i === 1 || i === totalPages) {
          html += `<button onclick="window.HireMeLoadFlows(${i})">${i}</button>`;
        } else if (Math.abs(i - currentPage) === 3) {
          html += `<button disabled>...</button>`;
        }
      }
      // 下一页
      html += `<button ${currentPage >= totalPages ? 'disabled' : ''} onclick="window.HireMeLoadFlows(${currentPage + 1})">下一页</button>`;
      el.innerHTML = html;
    }

    // ---------- 加载我的订单 ----------
    async function loadOrders() {
      try {
        const r = await API.getOrders(50);
        if (r.ok && r.data) {
          renderOrders(r.data.orders || []);
        }
      } catch (e) {
        console.error('[console] 加载订单失败：', e);
        const tb = $('ordersTableBody');
        if (tb) tb.innerHTML = '<tr><td colspan="6" class="table-empty">加载失败</td></tr>';
      }
    }

    // ---------- 渲染订单表格 ----------
    function renderOrders(orders) {
      const tb = $('ordersTableBody');
      if (!tb) return;
      if (!orders || orders.length === 0) {
        tb.innerHTML = '<tr><td colspan="6" class="table-empty">暂无订单</td></tr>';
        return;
      }
      const statusMap = {
        paid: { label: '已支付', class: 'paid' },
        pending: { label: '待支付', class: 'pending' },
        cancelled: { label: '已取消', class: 'cancelled' },
      };
      tb.innerHTML = orders.map(o => {
        const date = formatDateTime(o.createdAt);
        const st = statusMap[o.status] || { label: o.status || '—', class: 'pending' };
        const pkg = o.packageName || o.packageId || '—';
        const amount = o.amount !== undefined ? `¥${o.amount}` : '—';
        const credits = o.credits !== undefined ? o.credits : '—';
        // 订单号截取显示（完整订单号太长）
        const shortId = o.orderId ? o.orderId.slice(0, 16) + '...' : '—';
        return `<tr>
          <td title="${o.orderId || ''}">${shortId}</td>
          <td>${pkg}</td>
          <td>${amount}</td>
          <td>${credits}</td>
          <td><span class="status-badge ${st.class}">${st.label}</span></td>
          <td>${date}</td>
        </tr>`;
      }).join('');
    }

    // ============================================================
    // 兑换码功能
    // ============================================================

    /** 加载我的兑换记录（调用 GET /api/console/redeem/records） */
    async function loadRedeemRecords() {
      const tb = $('redeemRecordsBody');
      try {
        const r = await API.getRedeemRecords(1, 50);
        if (r.ok && r.data) {
          renderRedeemRecords(r.data.items || []);
        } else {
          if (tb) tb.innerHTML = '<tr><td colspan="4" class="table-empty">加载失败</td></tr>';
        }
      } catch (e) {
        console.error('[console] 加载兑换记录失败：', e);
        if (tb) tb.innerHTML = '<tr><td colspan="4" class="table-empty">加载失败</td></tr>';
      }
    }

    /** 渲染兑换记录表格 */
    function renderRedeemRecords(items) {
      const tb = $('redeemRecordsBody');
      if (!tb) return;
      if (!items || items.length === 0) {
        tb.innerHTML = '<tr><td colspan="4" class="table-empty">暂无兑换记录</td></tr>';
        return;
      }
      tb.innerHTML = items.map(it => {
        const date = formatDateTime(it.usedAt);
        const note = it.note ? escapeHtml(it.note) : '—';
        return `<tr>
          <td><code style="font-family:monospace;color:#4f46e5;">${escapeHtml(it.code)}</code></td>
          <td>+${it.credits}</td>
          <td>${date}</td>
          <td>${note}</td>
        </tr>`;
      }).join('');
    }

    /** 标记是否已绑定兑换按钮（避免重复绑定） */
    let _redeemBound = false;
    /** 绑定兑换按钮点击事件 */
    function bindRedeem() {
      if (_redeemBound) return;
      _redeemBound = true;
      const btn = $('redeemSubmitBtn');
      const input = $('redeemCodeInput');
      const tip = $('redeemTip');
      if (!btn || !input) return;

      // 点击兑换按钮
      btn.addEventListener('click', async () => {
        const code = input.value.trim();
        if (!code) {
          if (tip) { tip.textContent = '请输入兑换码'; tip.style.color = '#dc2626'; }
          return;
        }
        btn.disabled = true;
        const oldText = btn.textContent;
        btn.textContent = '兑换中...';
        try {
          const r = await API.redeemCode(code);
          if (r.ok && r.data) {
            // 兑换成功：显示积分变化，清空输入框，刷新记录和余额
            if (tip) {
              tip.textContent = `🎉 兑换成功！获得 ${r.data.credits} 积分，当前余额 ${r.data.balance}`;
              tip.style.color = '#16a34a';
            }
            input.value = '';
            // 刷新兑换记录
            loadRedeemRecords();
            // 刷新总览页积分显示
            try {
              const cr = await API.getCredits();
              if (cr.ok && cr.data && cr.data.credits) {
                renderCredits(cr.data.credits);
              }
            } catch (_) {}
          } else {
            // 兑换失败：显示后端返回的中文错误信息
            if (tip) {
              tip.textContent = r.data && r.data.msg ? r.data.msg : (r.msg || '兑换失败');
              tip.style.color = '#dc2626';
            }
          }
        } catch (e) {
          if (tip) { tip.textContent = '网络异常，请稍后重试'; tip.style.color = '#dc2626'; }
        } finally {
          btn.disabled = false;
          btn.textContent = oldText;
        }
      });

      // 回车键提交
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); btn.click(); }
      });
    }

    // ============================================================
    // 面试 Copilot 功能
    // ============================================================

    let _copilotBound = false;
    let _copilotRecognition = null;
    let _copilotIsRecording = false;

    /** 绑定 Copilot 面板交互（新版样式：3 步引导 + 简历/JD 折叠 + 下载卡片 + 语言切换） */
    function bindCopilot() {
      if (_copilotBound) return;
      _copilotBound = true;

      // ============== 3 步引导：动态完成态（不再写死前两步绿色） ==============
      // 完成判定（和真实行为对齐）：
      //   step1=下载桌面端   → 点击了任一下载卡片
      //   step2=打开应用登录 → 能进到控制台就已登录，默认完成
      //   step3=开始面试     → 点击了「开始」按钮
      // 用 localStorage 持久化，下次进来仍保持真实完成进度
      const COPILOT_PROGRESS_KEY = 'hireme:copilot:progress:v1';
      const readProgress = () => {
        try {
          const raw = localStorage.getItem(COPILOT_PROGRESS_KEY);
          const obj = raw ? JSON.parse(raw) : {};
          return { s1: !!obj.s1, s2: true, s3: !!obj.s3 };
        } catch (_) {
          return { s1: false, s2: true, s3: false };
        }
      };
      const writeProgress = (p) => {
        try { localStorage.setItem(COPILOT_PROGRESS_KEY, JSON.stringify(p)); } catch (_) {}
      };
      /**
       * 标记某一步完成并刷新 UI
       * @param {1|2|3} n
       */
      const markStepDone = (n) => {
        const p = readProgress();
        if (n === 1) p.s1 = true;
        if (n === 2) p.s2 = true;
        if (n === 3) p.s3 = true;
        writeProgress(p);
        renderCopilotProgress(p);
      };
      /** 按进度对象重绘 3 步引导的图标 / 背景 / 进度条 */
      const renderCopilotProgress = (p) => {
        const steps = document.querySelectorAll('#copilotPanel .cop-step');
        steps.forEach((stepEl, idx) => {
          const n = idx + 1;
          const done = (n === 1 ? p.s1 : n === 2 ? p.s2 : p.s3);
          const icoEl = stepEl.querySelector('.cop-step-ico');
          if (icoEl) {
            icoEl.textContent = done ? '🟢' : '⚫';
            icoEl.classList.toggle('done', !!done);
          }
          // 完成/未完成两套样式（对应图中「前两步绿、第三步灰」）
          stepEl.classList.toggle('done', !!done);
          stepEl.classList.toggle('pending', !done);
        });
        // 进度条 = 完成步数 / 3
        const doneCount = [p.s1, p.s2, p.s3].filter(Boolean).length;
        const bar = $('copGuideProgressBar');
        if (bar) {
          const percent = Math.max(0, Math.min(100, Math.round((doneCount / 3) * 100)));
          bar.style.width = percent + '%';
        }
      };
      // 首次进入立即按当前进度绘制
      renderCopilotProgress(readProgress());

      // 1) 关闭 / 隐藏引导条（右上 × 和底部「隐藏引导」两个入口）
      const hideGuide = () => {
        const guide = $('copilotGuide');
        if (guide) guide.classList.add('hidden');
      };
      const closeBtn = $('copilotGuideClose');
      const hideBtn  = $('copilotHideGuideBtn');
      if (closeBtn) closeBtn.addEventListener('click', hideGuide);
      if (hideBtn)  hideBtn.addEventListener('click', hideGuide);

      // 2) 「添加简历 / JD」折叠条：已由原生 <details> / <summary> 接管，无需再绑定 click
      //    这里只保留旧 ID 兼容：copilotResumeToggle = <details>，copilotResumeSection = undefined（已移除）

      // 3) 语言选择下拉（中文 / English）—— 本地先同步到语音识别语言
      const langSel = $('copilotLangSelect');
      if (langSel) {
        langSel.addEventListener('change', () => {
          const v = String(langSel.value || 'zh').toLowerCase();
          if (v.startsWith('zh')) _copilotPrefLang = 'zh-CN';
          else if (v.startsWith('en')) _copilotPrefLang = 'en-US';
          else _copilotPrefLang = v;
        });
      }

      // 4) 旧 mic 按钮已移除（新版只保留「开始」按钮即启动；仍兼容存在时可点击）
      const micBtn = $('copilotMicBtn');
      if (micBtn) {
        micBtn.addEventListener('click', () => {
          if (_copilotIsRecording) stopCopilotRecognition();
          else startCopilotRecognition();
        });
      }

      // 5) 开始按钮（紫蓝渐变圆按钮）：标记第 3 步完成 + 收集简历/JD + 启动语音识别 + 模拟 AI 生成答案
      const startBtn = $('copilotStartBtn');
      if (startBtn) {
        startBtn.addEventListener('click', () => {
          markStepDone(3); // ✅ 点击开始 = 进入第 3 步（开始面试）
          // 拿到 JD 和简历（两个 textarea 都已重命名）
          const jdEl     = $('copilotJD');
          const resumeEl = $('copilotResumeText');
          const jd       = (jdEl     ? jdEl.value     : '').trim();
          const resume   = (resumeEl ? resumeEl.value : '').trim();

          if (!_copilotIsRecording) {
            startCopilotRecognition();
          }
          Toast.show(
            [
              resume ? '已读取你的简历内容' : null,
              jd     ? '已读取职位描述 (JD)'  : null,
              'AI 正在生成回答建议…',
            ].filter(Boolean).join('；'),
            'ok'
          );
          // 模拟 AI 回答（生产环境应调用后端 Copilot 生成接口：POST /api/copilot/generate）
          setTimeout(() => {
            Toast.show('回答建议已生成，可在下方查看要点。', 'ok');
          }, 2200);
        });
      }

      // 6) 下载桌面端卡片（新类名：cop-dl-card；同时兼容旧的 download-card）
      //    点击任意一张下载卡 → 标记第 1 步完成（下载桌面端）
      const attachDlCard = (card) => {
        card.addEventListener('click', () => {
          markStepDone(1); // ✅ 点击下载 = 完成第 1 步
          const os = card.dataset.os;
          const osNames = {
            'mac-silicon': 'macOS (Apple Silicon)',
            'mac-intel':   'macOS (Intel)',
            'windows':     'Windows (x64)',
          };
          Toast.show(`即将开始下载 ${osNames[os] || ''} 版本…`, 'ok');
        });
      };
      document.querySelectorAll('.cop-dl-card').forEach(attachDlCard);
      document.querySelectorAll('.download-card').forEach(attachDlCard);
    }

    // 用户偏好的 UI 语言（默认中文）；同时作为 Web Speech API 的 lang 兜底
    let _copilotPrefLang = 'zh-CN';

    /** 启动语音识别（默认使用用户在顶部选择的语言 zh-CN / en-US） */
    function startCopilotRecognition() {
      if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
        Toast.show('您的浏览器不支持语音识别，建议使用 Chrome', 'error');
        return;
      }
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      _copilotRecognition = new SpeechRecognition();
      _copilotRecognition.lang = _copilotPrefLang || 'zh-CN';
      _copilotRecognition.continuous = true;
      _copilotRecognition.interimResults = true;

      const micBtn = $('copilotMicBtn');
      const micStatus = $('copilotMicStatus');
      const textDisplay = $('copilotTextDisplay');

      _copilotRecognition.onstart = () => {
        _copilotIsRecording = true;
        if (micBtn) {
          micBtn.classList.remove('from-blue-500', 'to-indigo-600');
          micBtn.classList.add('from-red-500', 'to-pink-600');
        }
        if (micStatus) micStatus.textContent = '正在倾听... 点击停止';
        if (textDisplay) textDisplay.classList.remove('hidden');
      };

      _copilotRecognition.onresult = (event) => {
        let finalText = '';
        let interimText = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const transcript = event.results[i][0].transcript;
          if (event.results[i].isFinal) {
            finalText += transcript;
          } else {
            interimText += transcript;
          }
        }
        if (textDisplay && (finalText || interimText)) {
          textDisplay.textContent = finalText || interimText;
        }
      };

      _copilotRecognition.onerror = (event) => {
        console.error('语音识别错误:', event.error);
        Toast.show('语音识别出错：' + event.error, 'error');
        stopCopilotRecognition();
      };

      _copilotRecognition.onend = () => {
        if (_copilotIsRecording) {
          _copilotRecognition.start(); // 自动重启
        } else {
          if (micBtn) {
            micBtn.classList.add('from-blue-500', 'to-indigo-600');
            micBtn.classList.remove('from-red-500', 'to-pink-600');
          }
          if (micStatus) micStatus.textContent = '点击开始语音识别';
        }
      };

      _copilotRecognition.start();
    }

    /** 停止语音识别 */
    function stopCopilotRecognition() {
      _copilotIsRecording = false;
      if (_copilotRecognition) {
        try { _copilotRecognition.stop(); } catch (_) {}
      }
    }

    // ============================================================
    // 模拟面试功能
    // ============================================================

    const MOCK_JOBS = [
      { id: 'java', name: 'Java 后端', icon: '☕', iconColor: 'bg-orange-100 text-orange-600', questions: 20, users: '2,819' },
      { id: 'backend', name: '后端开发', icon: '🖥️', iconColor: 'bg-blue-100 text-blue-600', questions: 22, users: '2,329' },
      { id: 'test', name: '测试工程师', icon: '🧪', iconColor: 'bg-green-100 text-green-600', questions: 16, users: '2,441' },
      { id: 'frontend', name: '前端开发', icon: '💻', iconColor: 'bg-purple-100 text-purple-600', questions: 18, users: '2,131' },
      { id: 'ai', name: 'AI 工程师', icon: '🤖', iconColor: 'bg-red-100 text-red-600', questions: 18, users: '2,232' },
      { id: 'product', name: '产品经理', icon: '📱', iconColor: 'bg-pink-100 text-pink-600', questions: 16, users: '1,326' },
      { id: 'hardware', name: '硬件工程师', icon: '⚙️', iconColor: 'bg-indigo-100 text-indigo-600', questions: 14, users: '911' },
      { id: 'ops', name: '运维工程师', icon: '🔧', iconColor: 'bg-teal-100 text-teal-600', questions: 12, users: '898' },
      { id: 'project', name: '项目经理', icon: '📋', iconColor: 'bg-amber-100 text-amber-600', questions: 14, users: '652' },
    ];

    const MOCK_HISTORY = [
      { id: 'h1', job: 'java工程师', time: '07/07 12:52', questions: 1, score: 85 },
    ];

    let _mockInitialized = false;
    let _mockCurrentJob = null;
    let _mockQuestionCount = 0;
    let _mockTimerInterval = null;
    let _mockStartTime = null;

    /** 初始化 Mock 面板 */
    function initMockPanel() {
      if (_mockInitialized) return;
      _mockInitialized = true;
      renderMockJobList();
      renderMockHistory();
      bindMockCustomInput();
    }

    /** 渲染岗位列表 */
    function renderMockJobList() {
      const container = $('mockJobList');
      if (!container) return;
      container.innerHTML = MOCK_JOBS.map(job => `
        <div class="mock-job-card bg-white rounded-xl p-4 border border-gray-100 hover:border-green-400 hover:shadow-md cursor-pointer transition-all group" data-job-id="${job.id}">
          <div class="flex items-start justify-between">
            <div class="w-10 h-10 rounded-lg ${job.iconColor} flex items-center justify-center text-xl mb-3">
              ${job.icon}
            </div>
            <i class="fa-solid fa-chevron-right text-gray-300 group-hover:text-green-500 transition-colors"></i>
          </div>
          <div class="font-semibold text-gray-800 mb-1">${job.name}</div>
          <div class="text-xs text-gray-400 flex items-center gap-2">
            <i class="fa-solid fa-user"></i>
            <span>${job.users}</span>
            <span>·</span>
            <span>${job.questions} 题</span>
          </div>
        </div>
      `).join('');

      container.querySelectorAll('.mock-job-card').forEach(card => {
        card.addEventListener('click', () => {
          const jobId = card.dataset.jobId;
          const job = MOCK_JOBS.find(j => j.id === jobId);
          if (job) startMockInterview(job);
        });
      });
    }

    /** 渲染历史记录 */
    function renderMockHistory() {
      const container = $('mockHistoryList');
      if (!container) return;
      if (MOCK_HISTORY.length === 0) {
        container.innerHTML = '<div class="text-center py-6 text-gray-400 text-sm">暂无练习记录</div>';
        return;
      }
      container.innerHTML = MOCK_HISTORY.map(h => `
        <div class="flex items-center justify-between bg-white rounded-xl p-4 border border-gray-100 hover:shadow-sm transition-shadow">
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center text-blue-600 font-bold">
              ${h.questions}
            </div>
            <div>
              <div class="font-medium text-gray-800">${escapeHtml(h.job)}</div>
              <div class="text-xs text-gray-400">${h.time} · ${h.questions} 题</div>
            </div>
          </div>
          <button class="text-sm text-blue-600 hover:text-blue-700 transition-colors flex items-center gap-1">
            查看报告
            <i class="fa-solid fa-chevron-right text-xs"></i>
          </button>
        </div>
      `).join('');
    }

    /** 绑定自定义岗位输入 */
    function bindMockCustomInput() {
      const input = $('mockCustomJob');
      const btn = $('mockStartCustomBtn');
      if (!input || !btn) return;

      btn.addEventListener('click', () => {
        const jobName = input.value.trim();
        if (!jobName) {
          Toast.show('请输入岗位名称', 'warn');
          return;
        }
        startMockInterview({ id: 'custom', name: jobName, icon: '🎯', questions: 5 });
      });

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          btn.click();
        }
      });

      // 查看全部按钮
      const viewAllBtn = $('mockViewAllBtn');
      if (viewAllBtn) {
        viewAllBtn.addEventListener('click', () => {
          Toast.show('功能开发中', 'ok');
        });
      }
    }

    /** 开始模拟面试 */
    function startMockInterview(job) {
      _mockCurrentJob = job;
      _mockQuestionCount = 0;
      _mockStartTime = Date.now();

      const ui = $('mockInterviewUI');
      const title = $('mockJobTitle');
      const chatArea = $('mockChatArea');
      const countEl = $('mockQuestionCount');

      if (ui) ui.classList.remove('hidden');
      if (title) title.textContent = `${job.name} - AI 模拟面试`;
      if (chatArea) chatArea.innerHTML = '';

      // 模拟第一个问题
      setTimeout(() => {
        appendMockMessage('interviewer', `你好，我是今天的面试官。请简单介绍一下你自己，以及为什么对 ${job.name} 这个岗位感兴趣？`);
        updateMockCount();
      }, 500);

      // 启动计时器
      startMockTimer();

      // 绑定对话框交互
      bindMockChat();
    }

    /** 追加对话消息 */
    function appendMockMessage(role, text) {
      const chatArea = $('mockChatArea');
      if (!chatArea) return;
      const isInterviewer = role === 'interviewer';
      const msgDiv = document.createElement('div');
      msgDiv.className = `flex ${isInterviewer ? 'justify-start' : 'justify-end'}`;
      msgDiv.innerHTML = `
        <div class="max-w-[70%] ${isInterviewer ? 'bg-white border border-gray-100' : 'bg-green-600 text-white'} rounded-2xl px-4 py-3 shadow-sm">
          <p class="text-sm ${isInterviewer ? 'text-gray-800' : ''}">${escapeHtml(text)}</p>
        </div>
      `;
      chatArea.appendChild(msgDiv);
      chatArea.scrollTop = chatArea.scrollHeight;
    }

    /** 更新问题计数 */
    function updateMockCount() {
      _mockQuestionCount++;
      const countEl = $('mockQuestionCount');
      if (countEl) countEl.textContent = `问题 ${_mockQuestionCount}/5`;
    }

    /** 启动计时器 */
    function startMockTimer() {
      if (_mockTimerInterval) clearInterval(_mockTimerInterval);
      const timerEl = $('mockTimer');
      _mockTimerInterval = setInterval(() => {
        if (!_mockStartTime) return;
        const elapsed = Math.floor((Date.now() - _mockStartTime) / 1000);
        const mins = String(Math.floor(elapsed / 60)).padStart(2, '0');
        const secs = String(elapsed % 60).padStart(2, '0');
        if (timerEl) timerEl.textContent = `${mins}:${secs}`;
      }, 1000);
    }

    /** 绑定对话输入 */
    function bindMockChat() {
      const input = $('mockAnswerInput');
      const sendBtn = $('mockSendBtn');
      const exitBtn = $('mockExitInterview');
      const micBtn = $('mockMicBtn');

      if (sendBtn && input) {
        sendBtn.onclick = () => {
          const text = input.value.trim();
          if (!text) return;
          appendMockMessage('candidate', text);
          input.value = '';
          // 模拟 AI 追问
          setTimeout(() => {
            const replies = [
              '这是一个很好的开始。能具体说说你在这个项目中遇到的最大挑战是什么？',
              '我很感兴趣。你是如何解决这个问题的？请详细描述一下你的思考过程。',
              '不错的回答。如果让你重新做一次，你会做哪些不同的选择？',
              '你的经验很丰富。请分享一个你失败的经历，以及从中学到了什么。',
              '最后一个问题：你对我们公司有什么了解？为什么想加入？',
            ];
            if (_mockQuestionCount < 5) {
              appendMockMessage('interviewer', replies[_mockQuestionCount % replies.length]);
              updateMockCount();
            } else {
              endMockInterview();
            }
          }, 1000);
        };
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendBtn.click();
          }
        });
      }

      if (exitBtn) {
        exitBtn.onclick = () => {
          if (confirm('确定要结束本次模拟面试吗？')) {
            endMockInterview();
          }
        };
      }

      if (micBtn) {
        micBtn.onclick = () => {
          Toast.show('语音输入功能开发中，敬请期待', 'ok');
        };
      }
    }

    /** 结束模拟面试 */
    function endMockInterview() {
      const ui = $('mockInterviewUI');
      if (ui) ui.classList.add('hidden');
      if (_mockTimerInterval) clearInterval(_mockTimerInterval);
      _mockTimerInterval = null;
      _mockStartTime = null;
      Toast.show('模拟面试已结束，报告生成中...', 'ok');
    }

    // ============================================================
    // 简历优化功能
    // ============================================================

    let _resumeBound = false;
    let _resumeFileName = '';

    /** 绑定简历优化面板交互 */
    function bindResume() {
      if (_resumeBound) return;
      _resumeBound = true;

      const uploadBtn = $('resumeUploadBtn');
      const fileInput = $('resumeFileInput');
      const dropZone = $('resumeDropZone');
      const fileNameEl = $('resumeFileName');
      const textInput = $('resumeTextInput');
      const jdInput = $('resumeJDInput');
      const analyzeBtn = $('resumeAnalyzeBtn');
      const downloadBtn = $('resumeDownloadBtn');

      // 上传按钮
      if (uploadBtn && fileInput) {
        uploadBtn.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', (e) => {
          const file = e.target.files[0];
          if (file) {
            _resumeFileName = file.name;
            if (fileNameEl) {
              fileNameEl.textContent = `已选择：${file.name}`;
              fileNameEl.classList.remove('hidden');
            }
            // 读取文本文件内容
            const reader = new FileReader();
            reader.onload = (evt) => {
              const content = evt.target.result;
              if (textInput && (!textInput.value || textInput.value.trim() === '')) {
                textInput.value = content.slice(0, 50000); // 限制长度
                Toast.show('文件已读取到文本框', 'ok');
              }
            };
            reader.readAsText(file);
          }
        });
      }

      // 拖拽上传
      if (dropZone && fileInput) {
        dropZone.addEventListener('click', (e) => {
          if (e.target === dropZone || e.target.closest('.fa-cloud-arrow-up')) {
            fileInput.click();
          }
        });
        ['dragover', 'dragenter'].forEach(evt => {
          dropZone.addEventListener(evt, (e) => {
            e.preventDefault();
            dropZone.classList.add('border-purple-400', 'bg-purple-50');
          });
        });
        ['dragleave', 'drop'].forEach(evt => {
          dropZone.addEventListener(evt, (e) => {
            e.preventDefault();
            dropZone.classList.remove('border-purple-400', 'bg-purple-50');
          });
        });
        dropZone.addEventListener('drop', (e) => {
          const file = e.dataTransfer.files[0];
          if (file) {
            _resumeFileName = file.name;
            if (fileNameEl) {
              fileNameEl.textContent = `已选择：${file.name}`;
              fileNameEl.classList.remove('hidden');
            }
            const reader = new FileReader();
            reader.onload = (evt) => {
              const content = evt.target.result;
              if (textInput) textInput.value = content.slice(0, 50000);
            };
            reader.readAsText(file);
          }
        });
      }

      // 开始分析按钮
      if (analyzeBtn) {
        analyzeBtn.addEventListener('click', () => {
          const resumeText = textInput ? textInput.value.trim() : '';
          const jdText = jdInput ? jdInput.value.trim() : '';

          if (!resumeText) {
            Toast.show('请上传或粘贴简历内容', 'warn');
            return;
          }

          analyzeBtn.disabled = true;
          analyzeBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> AI 分析中...';

          // 模拟分析过程（实际应调用后端 API）
          setTimeout(() => {
            showResumeAnalysisResult(resumeText, jdText);
            analyzeBtn.disabled = false;
            analyzeBtn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> 开始 AI 分析优化';
            Toast.show('分析完成！', 'ok');
          }, 2500);
        });
      }

      // 下载按钮
      if (downloadBtn) {
        downloadBtn.addEventListener('click', () => {
          const afterText = $('resumeAfterText');
          if (afterText && afterText.textContent) {
            const blob = new Blob([afterText.textContent], { type: 'text/plain;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `优化版简历_${Date.now()}.txt`;
            a.click();
            URL.revokeObjectURL(url);
          }
        });
      }
    }

    /** 显示简历分析结果 */
    function showResumeAnalysisResult(resumeText, jdText) {
      const resultSection = $('resumeResultSection');
      const scoreEl = $('resumeScore');
      const issuesList = $('resumeIssuesList');
      const highlightsList = $('resumeHighlightsList');
      const suggestions = $('resumeSuggestions');
      const beforeText = $('resumeBeforeText');
      const afterText = $('resumeAfterText');

      if (!resultSection) return;
      resultSection.classList.remove('hidden');

      // 模拟评分
      const score = jdText ? 72 : 65;
      if (scoreEl) scoreEl.textContent = score;

      // 模拟问题列表
      if (issuesList) {
        const issues = [
          '缺少量化成果（建议添加具体数字和百分比）',
          '技术栈描述过于笼统（建议细化版本和使用场景）',
          '项目经验描述不够具体（建议遵循 STAR 法则）',
          jdText ? '与 JD 匹配度不足（建议增加关键词）' : null,
        ].filter(Boolean);
        issuesList.innerHTML = issues.map(i => `
          <li class="flex items-start gap-2">
            <i class="fa-solid fa-circle-exclamation text-red-400 mt-1 text-xs"></i>
            <span class="text-gray-600">${escapeHtml(i)}</span>
          </li>
        `).join('');
      }

      // 模拟亮点
      if (highlightsList) {
        highlightsList.innerHTML = [
          '教育背景清晰，专业相关度高',
          '工作经历有持续性和成长性',
          '技术栈覆盖面广',
        ].map(h => `
          <li class="flex items-start gap-2">
            <i class="fa-solid fa-circle-check text-green-500 mt-1 text-xs"></i>
            <span class="text-gray-600">${escapeHtml(h)}</span>
          </li>
        `).join('');
      }

      // 模拟优化建议
      if (suggestions) {
        const sugItems = [
          { icon: 'fa-solid fa-chart-bar', text: '在每个项目描述后添加 2-3 个量化成果，如"提升性能 40%"、"处理日均百万级请求"。' },
          { icon: 'fa-solid fa-code', text: '细化技术栈版本，如 "Java 17 / Spring Boot 3.x / Redis 7.x"，并说明使用场景。' },
          { icon: 'fa-solid fa-bullseye', text: '使用 STAR 法则（情境-任务-行动-结果）重写项目经验，让面试官更容易理解你的贡献。' },
          jdText ? { icon: 'fa-solid fa-key', text: `从 JD 中提取关键词并融入简历，如 "${jdText.slice(0, 30)}..." 等相关技能。` } : null,
        ].filter(Boolean);
        suggestions.innerHTML = sugItems.map((s, i) => `
          <div class="flex items-start gap-3 p-3 bg-gray-50 rounded-lg">
            <div class="w-8 h-8 rounded-full bg-purple-100 flex items-center justify-center text-purple-600 flex-shrink-0">
              <i class="${s.icon} text-sm"></i>
            </div>
            <p class="text-sm text-gray-600 leading-relaxed">
              <strong class="text-gray-800">建议 ${i + 1}：</strong>${escapeHtml(s.text)}
            </p>
          </div>
        `).join('');
      }

      // 优化前后对比
      if (beforeText) beforeText.textContent = resumeText.slice(0, 500) + '...';
      if (afterText) {
        const optimized = generateOptimizedResume(resumeText, jdText);
        afterText.textContent = optimized;
      }
    }

    /** 生成优化后的简历文本（模拟） */
    function generateOptimizedResume(resumeText, jdText) {
      let result = resumeText;
      // 添加一些优化标记
      if (!result.includes('【优化】')) {
        result = result.replace(/项目经验/g, '【优化】项目经验');
      }
      if (!result.includes('【量化】')) {
        result = result.replace(/负责|参与|开发/g, '【量化】$&');
      }
      return result.slice(0, 10000);
    }

    // ============================================================
    // 系统公告功能
    // ============================================================

    /** 加载已发布公告列表 */
    async function loadNews(page) {
      const wrap = $('newsListWrap');
      try {
        const r = await API.getNews(page || 1, 20);
        if (r.ok && r.data) {
          renderNewsList(r.data.items || []);
        } else {
          if (wrap) wrap.innerHTML = '<div class="table-empty">加载失败</div>';
        }
      } catch (e) {
        console.error('[console] 加载公告失败：', e);
        if (wrap) wrap.innerHTML = '<div class="table-empty">加载失败</div>';
      }
    }

    /** 渲染公告列表卡片 */
    function renderNewsList(items) {
      const wrap = $('newsListWrap');
      if (!wrap) return;
      if (!items || items.length === 0) {
        wrap.innerHTML = '<div class="table-empty">暂无公告</div>';
        return;
      }
      // 分类标签样式映射
      const catMap = {
        system:   { label: '系统', color: '#3b82f6' },
        activity: { label: '活动', color: '#f59e0b' },
        update:   { label: '更新', color: '#10b981' },
      };
      wrap.innerHTML = items.map(n => {
        const cat = catMap[n.category] || { label: n.category || '其他', color: '#6b7280' };
        const date = formatDateTime(n.publishedAt);
        const pinned = n.isPinned ? '<span style="color:#dc2626;font-size:12px;margin-right:6px;">📌 置顶</span>' : '';
        const summary = escapeHtml(n.summary || '');
        return `<div class="news-card" data-news-id="${escapeHtml(n.newsId)}" style="background:#fff;border:1px solid #eee;border-radius:8px;padding:16px 20px;cursor:pointer;transition:box-shadow .2s;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
            <h3 style="margin:0;font-size:16px;color:#1f2937;">${pinned}${escapeHtml(n.title)}</h3>
            <span style="font-size:11px;padding:2px 8px;border-radius:10px;background:${cat.color}20;color:${cat.color};">${cat.label}</span>
          </div>
          <p style="margin:0 0 8px;font-size:13px;color:#6b7280;line-height:1.6;">${summary}${n.summary && n.summary.length >= 120 ? '...' : ''}</p>
          <div style="font-size:12px;color:#9ca3af;">
            🕒 ${date} · 👁 ${n.viewCount || 0} 次浏览
          </div>
        </div>`;
      }).join('');
      // 绑定点击查看详情
      wrap.querySelectorAll('.news-card').forEach(card => {
        card.addEventListener('click', () => openNewsDetail(card.dataset.newsId));
      });
      // hover 阴影
      wrap.querySelectorAll('.news-card').forEach(card => {
        card.addEventListener('mouseenter', () => card.style.boxShadow = '0 4px 12px rgba(0,0,0,.08)');
        card.addEventListener('mouseleave', () => card.style.boxShadow = 'none');
      });
    }

    /** 打开公告详情弹窗 */
    async function openNewsDetail(newsId) {
      const modal = $('newsDetailModal');
      const titleEl = $('newsDetailTitle');
      const contentEl = $('newsDetailContent');
      const metaEl = $('newsDetailMeta');
      if (!modal || !newsId) return;
      // 显示弹窗 + loading
      modal.style.display = 'flex';
      if (titleEl) titleEl.textContent = '加载中...';
      if (contentEl) contentEl.textContent = '';
      if (metaEl) metaEl.textContent = '';
      try {
        const r = await API.getNewsDetail(newsId);
        if (r.ok && r.data && r.data.news) {
          const n = r.data.news;
          if (titleEl) titleEl.textContent = n.title;
          if (contentEl) contentEl.textContent = n.content;  // 纯文本，CSS white-space:pre-wrap 保留换行
          if (metaEl) metaEl.textContent = `发布时间：${formatDateTime(n.publishedAt)} · 浏览 ${n.viewCount || 0} 次`;
        } else {
          if (titleEl) titleEl.textContent = '加载失败';
          if (contentEl) contentEl.textContent = (r.data && r.data.msg) || r.msg || '获取详情失败';
        }
      } catch (e) {
        if (titleEl) titleEl.textContent = '加载异常';
        if (contentEl) contentEl.textContent = '网络异常，请稍后重试';
      }
    }

    /** 绑定公告详情弹窗关闭事件 */
    function bindNewsDetailClose() {
      const modal = $('newsDetailModal');
      const closeBtn = $('newsDetailClose');
      if (closeBtn) {
        closeBtn.addEventListener('click', () => { if (modal) modal.style.display = 'none'; });
      }
      // 点击遮罩关闭
      if (modal) {
        modal.addEventListener('click', (e) => {
          if (e.target === modal) modal.style.display = 'none';
        });
      }
    }

    // ---------- 加载个人设置 ----------
    function loadSettings() {
      // 从导航栏已缓存的用户信息填充
      const user = window.HireMeCurrentUser;
      const emailEl = $('settingsEmail');
      const nameEl = $('settingsDisplayName');
      if (emailEl && user) emailEl.value = user.email || '';
      if (nameEl && user) nameEl.value = user.displayName || '';
    }

    // ---------- 保存昵称 ----------
    async function saveProfile() {
      const nameEl = $('settingsDisplayName');
      if (!nameEl) return;
      const displayName = nameEl.value.trim();
      if (!displayName) { Toast.show('昵称不能为空', 'warn'); return; }
      if (displayName.length > 20) { Toast.show('昵称最多 20 个字符', 'warn'); return; }

      const btn = $('saveProfileBtn');
      if (btn) { btn.disabled = true; btn.textContent = '保存中...'; }
      try {
        const r = await API.updateProfile(displayName);
        if (r.ok) {
          Toast.show('昵称修改成功', 'ok');
          // 更新侧边栏和导航栏的昵称显示
          const navName = $('userName');
          if (navName) navName.textContent = displayName;
          if (window.HireMeCurrentUser) window.HireMeCurrentUser.displayName = displayName;
        } else {
          Toast.show(r.msg || '修改失败', 'error');
        }
      } catch (e) {
        Toast.show('修改失败', 'error');
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = '保存昵称'; }
      }
    }

    // ---------- 修改密码 ----------
    async function changePasswordAction() {
      const oldPw = ($('oldPassword') || {}).value || '';
      const newPw = ($('newPassword') || {}).value || '';
      const newPw2 = ($('newPassword2') || {}).value || '';
      if (!oldPw) { Toast.show('请输入当前密码', 'warn'); return; }
      if (!newPw || newPw.length < 6) { Toast.show('新密码至少 6 位', 'warn'); return; }
      if (newPw !== newPw2) { Toast.show('两次输入的新密码不一致', 'warn'); return; }

      const btn = $('changePasswordBtn');
      if (btn) { btn.disabled = true; btn.textContent = '修改中...'; }
      try {
        const r = await API.changePassword(oldPw, newPw);
        if (r.ok) {
          Toast.show('密码修改成功，请重新登录', 'ok');
          // 清空密码框
          ['oldPassword', 'newPassword', 'newPassword2'].forEach(id => { if ($(id)) $(id).value = ''; });
          // 延迟跳转到登录页
          setTimeout(() => { location.href = '/login.html'; }, 1500);
        } else {
          Toast.show(r.msg || '修改失败', 'error');
        }
      } catch (e) {
        Toast.show('修改失败', 'error');
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = '修改密码'; }
      }
    }

    // 绑定设置页面的按钮
    // ============================================================
    // ★ 面试记录模块：DesktopBridge
    //   - 【架构变更】不再需要启动桌面端 Electron 应用
    //   - Landing 后端 user-server.js 已直接连接项目根下的 data/interview.db（SQLite WAL 模式，与桌面端共享）
    //   - 直接使用同源相对路径 /api/db/sessions/* 调用 Landing 自己的 API，返回格式与桌面端 localHttpServer 完全兼容
    //   - 仍保留 desktopUnavailable / sqliteUnavailable 字段语义：sqliteUnavailable=true ⇒ 同时补 desktopUnavailable=true，保证前端空态逻辑 0 改动兼容
    // ============================================================
    const DesktopBridge = (function () {
      // 以下常量仅用于兼容旧 localStorage 缓存清理，不再实际扫描端口
      const PORT_START = 28765;
      const PORT_END   = 28774;
      const LS_KEY_BASE = 'hireme.desktop.baseUrl';
      const LS_KEY_TIME = 'hireme.desktop.lastSeenAt';
      let _cachedBaseUrl = null;

      /**
       * 对齐 desktop/localHttpServer 响应语义：
       *   若 sqliteUnavailable 为 true，补上 desktopUnavailable=true，
       *   让前端 "桌面端未启动" 与 "SQLite 不可用" 两种空态分支都能正确命中
       */
      function _normalizeResp(payload) {
        if (!payload) return payload;
        if (payload.sqliteUnavailable) {
          payload.desktopUnavailable = true;
        }
        return payload;
      }

      /**
       * 对外：返回当前页面 origin（不再探测桌面端端口；所有 API 走 Landing 同源路由）
       */
      async function getBaseUrl({ force = false } = {}) {
        if (typeof window !== 'undefined' && window.location && window.location.origin) {
          _cachedBaseUrl = window.location.origin;
          return _cachedBaseUrl;
        }
        _cachedBaseUrl = '';
        return _cachedBaseUrl;
      }

      /**
       * 调用面试记录 API（直接走 Landing 同源路由，无需启动桌面端）
       * @param {string} path - 原绝对路径，如 '/api/db/sessions/health' 或 '/api/db/sessions/list?...'
       * @param {{method?:string, body?:any}} [opts]
       */
      async function callApi(path, { method = 'GET', body = null } = {}) {
        // path 本身已形如 /api/db/sessions/...，直接作为同源 URL fetch
        const url = String(path || '');
        const opts = {
          method,
          headers: { 'Accept': 'application/json' },
          credentials: 'same-origin', // 自动携带 Web 会话 Cookie，用于账号隔离
        };
        if (body != null) {
          opts.headers['Content-Type'] = 'application/json';
          opts.body = typeof body === 'string' ? body : JSON.stringify(body);
        }
        try {
          const r = await fetch(url, opts);
          let payload = null;
          try { payload = await r.json(); } catch (_) { payload = null; }
          _normalizeResp(payload);
          if (r.ok && payload) return Object.assign({ ok: true }, payload);
          return Object.assign({ ok: false, status: r.status }, _normalizeResp(payload) || {});
        } catch (e) {
          // HTTP 层失败：降级为空态
          return {
            ok: false,
            sqliteUnavailable: true,
            desktopUnavailable: true,
            msg: (e && e.message) ? e.message : '请求面试记录接口失败',
          };
        }
      }

      /**
       * 重置缓存（用户点击 "重新连接桌面端" 按钮时触发，这里清掉旧端口缓存即可）
       */
      function resetCache() {
        _cachedBaseUrl = null;
        try {
          localStorage.removeItem(LS_KEY_BASE);
          localStorage.removeItem(LS_KEY_TIME);
        } catch (_) {}
      }

      return { getBaseUrl, callApi, resetCache };
    })();
    // 暴露给调试
    window.HireMeDesktopBridge = DesktopBridge;

    // ============================================================
    // ★ 面试记录面板渲染与事件绑定
    // ============================================================
    function bindSessionsPanel() {
      // —— 仅做一次绑定（重复点击菜单不重复绑） ——
      if (window.__hireme_sessions_bound) {
        refreshSessionsPanel(); // 重进面板时只刷新数据
        return;
      }
      window.__hireme_sessions_bound = true;

      // 面板状态（闭包内）
      const state = {
        category: '',       // 空=全部 / copilot / mock
        keyword: '',
        page: 1,
        pageSize: 9,
        total: 0,
      };

      // 取常用 DOM 引用
      const el = {
        status:    $('sessionsTopStatus'),
        badgeAll:  $('sessionsBadgeAll'),
        badgeCop:  $('sessionsBadgeCopilot'),
        badgeMock: $('sessionsBadgeMock'),
        menuBadge: $('menuSessionsBadge'),
        grid:      $('sessionsCardGrid'),
        pagerWrap: $('sessionsPagerWrap'),
        pagerInfo: $('sessionsPagerInfo'),
        pageText:  $('sessionsPageText'),
        prevBtn:   $('sessionsPrevBtn'),
        nextBtn:   $('sessionsNextBtn'),
        search:    $('sessionsSearchInput'),
        tabs:      $qa('.sess-tab'),
        // Modal
        modal:     $('sessionsDetailModal'),
        modClose:  $('sessModalCloseBtn'),
        modDel:    $('sessModalDeleteBtn'),
        modCat:    $('sessModalCatBadge'),
        modSta:    $('sessModalStatusBadge'),
        modTitle:  $('sessModalTitle'),
        modCmp:    $('sessModalCompany'),
        modPos:    $('sessModalPosition'),
        modDate:   $('sessModalDate'),
        modBody:   $('sessModalBody'),
      };
      // 记住当前打开的 session id（删除用）
      let _currentOpenId = null;

      // —— 工具：毫秒/秒 时间戳格式化 "YYYY-MM-DD HH:mm" ——
      function fmtTime(ts) {
        const n = Number(ts);
        if (!n) return '—';
        const d = new Date(n > 1e12 ? n : n * 1000); // 兼容 ms / s
        if (Number.isNaN(d.getTime())) return '—';
        const pad = (x) => String(x).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
      }
      // 工具：毫秒时长格式化 "1h23m" / "45m12s" / "<1m"
      function fmtDuration(ms) {
        const s = Math.max(0, Math.floor(Number(ms) / 1000));
        if (s < 60) return '< 1 分钟';
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sc = s % 60;
        if (h > 0) return `${h}小时${m}分`;
        if (m > 0) return `${m}分${sc}秒`;
        return `${sc}秒`;
      }
      // 工具：category → 标签（emoji + 文案 + 样式）
      function catBadge(cat) {
        if (cat === 'mock') return { icon:'🎯', text:'AI 模拟面试', cls:'bg-orange-50 text-orange-600' };
        return                 { icon:'💼', text:'真实面试',       cls:'bg-blue-50   text-blue-600' };
      }
      // 工具：status → 标签
      function stBadge(st) {
        if (st === 'ended') return { text:'已结束', cls:'bg-gray-100 text-gray-600' };
        return                 { text:'进行中', cls:'bg-green-50 text-green-600' };
      }

      // —— 设置顶栏状态条（颜色/文案） ——
      function setStatus(kind, text) {
        if (!el.status) return;
        el.status.textContent = text;
        el.status.className = 'text-xs px-3 py-1.5 rounded-full ' + ({
          loading: 'bg-gray-100 text-gray-500',
          ok:      'bg-green-50 text-green-600',
          warn:    'bg-amber-50 text-amber-700',
          err:     'bg-red-50 text-red-600',
        }[kind] || 'bg-gray-100 text-gray-500');
      }

      // —— 渲染 3 个数字徽章 ——
      function renderBadges(healthData) {
        const cp = Number(healthData && healthData.categories && healthData.categories.copilot) || 0;
        const mk = Number(healthData && healthData.categories && healthData.categories.mock)    || 0;
        const all = cp + mk;
        if (el.badgeAll) el.badgeAll.textContent = all;
        if (el.badgeCop) el.badgeCop.textContent = cp;
        if (el.badgeMock) el.badgeMock.textContent = mk;
        if (el.menuBadge) {
          el.menuBadge.textContent = all;
          el.menuBadge.style.display = all > 0 ? 'inline-block' : 'none';
        }
      }

      // —— 渲染 1 张卡片（HTML 字符串，避免大段 DOM API） ——
      //   字段双兼容说明：同时适配两种后端输出格式：
      //     • Landing 直连 sessions-db.js：用 company / position / rounds / answered / sessionId
      //     • 桌面端 localHttpServer：用 targetCompany / targetPosition / roundCount / answeredCount / id
      function renderCardHtml(s) {
        const cb = catBadge(s.category);
        const sb = stBadge(s.status);
        const title = escapeHtml(s.title || '未命名面试');
        // 双兼容读取：公司 / 岗位
        const companyRaw = 'company' in s ? (s.company || '') : (s.targetCompany || '');
        const positionRaw = 'position' in s ? (s.position || '') : (s.targetPosition || '');
        const company = companyRaw ? escapeHtml(companyRaw) : '未填写公司';
        const position = positionRaw ? escapeHtml(positionRaw) : '未填写岗位';
        const date = fmtTime(s.endedAt || s.lastActiveAt || s.startedAt);
        const dur = s.durationMs ? fmtDuration(s.durationMs) : (s.endedAt && s.startedAt ? fmtDuration(s.endedAt - s.startedAt) : '—');
        // 双兼容读取：问答轮数 / 已答题数（用 'in' 判断，避免数值 0 被误判为不存在）
        const rounds = ('rounds' in s) ? Number(s.rounds) : Number(s.roundCount);
        const roundsSafe = isNaN(rounds) ? 0 : rounds;
        const ans = ('answered' in s) ? Number(s.answered) : Number(s.answeredCount);
        const ansSafe = isNaN(ans) ? 0 : ans;
        const snippet = (s.snippet && String(s.snippet).trim()) ? escapeHtml(String(s.snippet).trim().slice(0, 80)) : '';
        // 双兼容读取：sessionId
        const idRaw = ('sessionId' in s && s.sessionId != null && s.sessionId !== '') ? s.sessionId : s.id;
        const id = String(idRaw || '');
        // 3 条统计卡底部指标
        return `
          <div class="sess-card bg-white rounded-xl border border-gray-100 p-4 shadow-sm hover:shadow-md hover:-translate-y-0.5 transition-all cursor-pointer" data-sess-id="${id}">
            <div class="flex items-start justify-between gap-2 mb-3">
              <div class="flex items-center gap-2">
                <span class="text-xs px-2 py-0.5 rounded-full font-medium ${cb.cls}">${cb.icon} ${cb.text}</span>
                <span class="text-xs px-2 py-0.5 rounded-full ${sb.cls}">${sb.text}</span>
              </div>
              <div class="text-[11px] text-gray-400 shrink-0">${date}</div>
            </div>
            <h4 class="font-semibold text-gray-800 mb-2 leading-snug line-clamp-2" style="display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;">${title}</h4>
            <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500 mb-3">
              <span class="inline-flex items-center gap-1"><i class="fa-solid fa-building text-[11px]"></i>${company}</span>
              <span class="inline-flex items-center gap-1"><i class="fa-solid fa-briefcase text-[11px]"></i>${position}</span>
            </div>
            ${snippet ? `<p class="text-xs text-gray-500 mb-3 leading-relaxed line-clamp-2" style="display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;">${snippet}</p>` : ''}
            <div class="grid grid-cols-3 gap-2 pt-3 border-t border-gray-50">
              <div class="text-center">
                <div class="text-[10px] text-gray-400 mb-0.5">问答轮数</div>
                <div class="font-semibold text-gray-700 text-sm">${roundsSafe}</div>
              </div>
              <div class="text-center">
                <div class="text-[10px] text-gray-400 mb-0.5">已答题</div>
                <div class="font-semibold text-green-600 text-sm">${ansSafe}</div>
              </div>
              <div class="text-center">
                <div class="text-[10px] text-gray-400 mb-0.5">时长</div>
                <div class="font-semibold text-gray-700 text-sm">${dur.split(' ')[0]}</div>
              </div>
            </div>
          </div>
        `;
      }

      // —— 渲染空态（桌面端未启动 / SQLite 没数据 / 搜索无结果 三种情形） ——
      function renderEmpty({ mode, reason }) {
        if (!el.grid) return;
        el.pagerWrap.style.display = 'none';
        const scenes = {
          // 1. 桌面端没启动 / 端口全不响应
          desktopOff: `
            <div class="col-span-full bg-white border border-gray-100 rounded-2xl p-10 text-center shadow-sm">
              <div class="w-16 h-16 mx-auto bg-gray-50 rounded-2xl flex items-center justify-center text-3xl mb-4">💻</div>
              <h4 class="font-bold text-gray-800 mb-2">桌面端未在本机运行</h4>
              <p class="text-sm text-gray-500 mb-4 max-w-md mx-auto leading-relaxed">
                面试记录存储在桌面端的本地 SQLite 中。请先用与本控制台<b>一致的账号</b>登录「即答侠桌面端」，
                然后点击下方按钮重新连接。
              </p>
              <div class="flex items-center justify-center gap-3">
                <button id="sessionsRetryDesktopBtn" type="button" class="px-5 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700">🔁 重新连接桌面端</button>
                <a href="#" class="menu-item-link px-5 py-2 text-sm rounded-lg border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 inline-flex items-center gap-1" data-menu="copilot">
                  📥 下载桌面端
                </a>
              </div>
            </div>`,
          // 2. 桌面端在，但 SQLite 还没初始化（比如 better-sqlite3 没装好）
          sqliteNo: `
            <div class="col-span-full bg-white border border-gray-100 rounded-2xl p-10 text-center shadow-sm">
              <div class="w-16 h-16 mx-auto bg-amber-50 rounded-2xl flex items-center justify-center text-3xl mb-4">⚠️</div>
              <h4 class="font-bold text-gray-800 mb-2">桌面端 SQLite 暂不可用</h4>
              <p class="text-sm text-gray-500 mb-2 max-w-md mx-auto">桌面端检测到存储异常。</p>
              <p class="text-xs text-amber-600 max-w-md mx-auto">${escapeHtml(reason || '')}</p>
            </div>`,
          // 3. 有连接但当前分类/关键字没数据
          noData: `
            <div class="col-span-full bg-white border border-gray-100 rounded-2xl p-10 text-center shadow-sm">
              <div class="w-16 h-16 mx-auto bg-gray-50 rounded-2xl flex items-center justify-center text-3xl mb-4">📭</div>
              <h4 class="font-bold text-gray-800 mb-2">暂无面试记录</h4>
              <p class="text-sm text-gray-500 mb-4 max-w-md mx-auto leading-relaxed">
                ${state.keyword ? '没有匹配关键字的记录，可以换个词再试。'
                              : '去桌面端开启第一场真实面试 Copilot 或 AI 模拟面试，记录会自动出现在这里。'}
              </p>
              <div class="flex items-center justify-center gap-3">
                <a href="#" class="menu-item-link px-5 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 inline-flex items-center gap-1" data-menu="copilot">💼 开始面试 Copilot</a>
                <a href="#" class="menu-item-link px-5 py-2 text-sm rounded-lg border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 inline-flex items-center gap-1" data-menu="mock">🎯 开始模拟面试</a>
              </div>
            </div>`,
        };
        el.grid.innerHTML = scenes[mode] || scenes.noData;
        // 绑定两个按钮（如果是空态模板里写了 id）
        const rBtn = $('sessionsRetryDesktopBtn');
        if (rBtn) {
          rBtn.addEventListener('click', () => {
            DesktopBridge.resetCache();
            refreshSessionsPanel();
          });
        }
        // 空态里两个 data-menu 链接 → 通过触发真实 .menu-item 跳转到对应面板（菜单 click 内已封装 activate + switchPanel + 面板初始化）
        $qa('.menu-item-link', el.grid).forEach(a => {
          a.addEventListener('click', (e) => {
            const m = a.dataset.menu;
            if (!m) return;
            e.preventDefault();
            const menuItem = Array.from(document.querySelectorAll('.menu-item')).find(i => i.dataset.menu === m);
            if (menuItem) {
              menuItem.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            }
          });
        });
      }

      // —— 渲染列表（含分页） ——
      function renderList(listResp) {
        const arr = (listResp && Array.isArray(listResp.sessions)) ? listResp.sessions : [];
        state.total = Number(listResp && listResp.total) || 0;
        const pageTotal = Math.max(1, Math.ceil(state.total / state.pageSize));
        if (state.page > pageTotal) state.page = pageTotal;

        // 卡片
        if (arr.length === 0) {
          renderEmpty({ mode: 'noData' });
          return;
        }
        el.grid.innerHTML = arr.map(renderCardHtml).join('');
        // 分页
        el.pagerWrap.style.display = state.total > state.pageSize ? 'flex' : 'none';
        if (state.total > state.pageSize) {
          if (el.pagerInfo) {
            const start = (state.page - 1) * state.pageSize + 1;
            const end = Math.min(state.page * state.pageSize, state.total);
            el.pagerInfo.textContent = `共 ${state.total} 条 · 显示 ${start}~${end}`;
          }
          if (el.pageText) el.pageText.textContent = `${state.page} / ${pageTotal}`;
          if (el.prevBtn) el.prevBtn.disabled = state.page <= 1;
          if (el.nextBtn) el.nextBtn.disabled = state.page >= pageTotal;
        }
        // 卡片点击 → 开详情
        $qa('.sess-card', el.grid).forEach(card => {
          card.addEventListener('click', () => openSessionDetail(card.dataset.sessId));
        });
      }

      // —— 刷新整个面板（health → 徽章 + list → 卡片/空态） ——
      async function refreshSessionsPanel() {
        setStatus('loading', '🔍 正在连接桌面端…');
        // 1) health
        const h = await DesktopBridge.callApi('/api/db/sessions/health');
        if (h.desktopUnavailable) {
          setStatus('warn', '⚠️ 未检测到桌面端');
          renderBadges({ categories: { copilot: 0, mock: 0 } });
          renderEmpty({ mode: 'desktopOff' });
          return;
        }
        if (h.sqliteUnavailable || !h.ready) {
          setStatus('warn', '⚠️ 桌面端存储异常');
          renderBadges({ categories: { copilot: 0, mock: 0 } });
          renderEmpty({ mode: 'sqliteNo', reason: h.msg || h.error || '' });
          return;
        }
        // 桌面端 + SQLite 都好
        setStatus('ok', `✅ 已连接（${h.sessionCount || 0} 场 · ${h.roundCount || 0} 轮）`);
        renderBadges(h);
        // 2) list
        const offset = (state.page - 1) * state.pageSize;
        const qs = new URLSearchParams();
        if (state.category) qs.set('category', state.category);
        if (state.keyword)  qs.set('keyword',  state.keyword);
        qs.set('limit',  String(state.pageSize));
        qs.set('offset', String(offset));
        const list = await DesktopBridge.callApi('/api/db/sessions/list?' + qs.toString());
        if (!list.ok && list.desktopUnavailable) {
          renderEmpty({ mode: 'desktopOff' });
          return;
        }
        renderList(list);
      }
      // 暴露给「重进面板只刷新」使用
      window.__hireme_refreshSessions = refreshSessionsPanel;

      // —— 打开详情弹窗 ——
      async function openSessionDetail(id) {
        if (!id) return;
        _currentOpenId = id;
        // 显示遮罩（flex 居中）
        el.modal.classList.remove('hidden');
        el.modal.classList.add('flex');
        el.modBody.innerHTML = `
          <div class="py-10 text-center text-sm text-gray-400">
            <div class="inline-block w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mb-3 align-middle"></div>
            <span class="align-middle ml-2">加载面试详情…</span>
          </div>`;
        const r = await DesktopBridge.callApi(`/api/db/sessions/${encodeURIComponent(id)}`);
        if (!r || !r.ok || !r.session) {
          const err = (r && r.error === 'not_found') ? '该面试记录已不存在' :
                      (r && r.error === 'forbidden') ? '该记录不属于当前登录账号' :
                      (r && (r.msg || r.error)) ? String(r.msg || r.error) : '加载失败';
          el.modBody.innerHTML = `
            <div class="py-10 text-center text-sm text-red-500 bg-red-50 rounded-xl">❌ ${escapeHtml(err)}</div>`;
          return;
        }
        const s = r.session;
        const rounds = Array.isArray(r.rounds) ? r.rounds : [];
        // 字段双兼容读取：同时适配 sessions-db.js（Landing 直连）和 localHttpServer（桌面端）两种格式
        const s_company  = ('company' in s) ? s.company : s.targetCompany;
        const s_position = ('position' in s) ? s.position : s.targetPosition;
        const s_rounds   = ('rounds' in s) ? s.rounds : s.roundCount;
        const s_answered = ('answered' in s) ? s.answered : s.answeredCount;
        const s_errors   = ('errors' in s) ? s.errors : s.errorCount;
        // 填充 Header
        const cb = catBadge(s.category);
        const sb = stBadge(s.status);
        el.modCat.textContent = `${cb.icon} ${cb.text}`;
        el.modCat.className = `text-xs px-2 py-0.5 rounded-full font-medium ${cb.cls}`;
        el.modSta.textContent = sb.text;
        el.modSta.className = `text-xs px-2 py-0.5 rounded-full ${sb.cls}`;
        el.modTitle.textContent = s.title || '未命名面试';
        el.modCmp.textContent   = s_company ? '🏢 ' + s_company : '';
        el.modPos.textContent   = s_position ? '💼 ' + s_position : '';
        const t1 = s.startedAt || s.lastActiveAt;
        const t2 = s.endedAt || s.lastActiveAt || s.startedAt;
        el.modDate.textContent = `🕒 ${fmtTime(t1)} ~ ${fmtTime(t2)}`;
        // 显示删除按钮（有合法 id 就显示）
        el.modDel.classList.remove('hidden');

        // Body：统计卡 + 最近 3 轮 rounds 列表 + 更多展开提示
        const dur = s.durationMs ? fmtDuration(s.durationMs) : (s.endedAt && s.startedAt ? fmtDuration(s.endedAt - s.startedAt) : '—');
        const roundsN = Number(s_rounds) || rounds.length || 0;
        const ansN    = Number(s_answered) || rounds.filter(x => x && x.status === 'answered').length;
        const errN    = Number(s_errors)   || rounds.filter(x => x && x.status === 'error').length;
        const statsHtml = `
          <div class="grid grid-cols-4 gap-3 mb-5">
            <div class="bg-blue-50 rounded-xl p-3 text-center"><div class="text-[11px] text-blue-500 mb-1">总轮数</div><div class="font-bold text-blue-700">${roundsN}</div></div>
            <div class="bg-green-50 rounded-xl p-3 text-center"><div class="text-[11px] text-green-600 mb-1">已答题</div><div class="font-bold text-green-700">${ansN}</div></div>
            <div class="bg-red-50 rounded-xl p-3 text-center"><div class="text-[11px] text-red-500 mb-1">异常</div><div class="font-bold text-red-600">${errN}</div></div>
            <div class="bg-gray-50 rounded-xl p-3 text-center"><div class="text-[11px] text-gray-500 mb-1">时长</div><div class="font-bold text-gray-700">${dur.split(' ')[0]}</div></div>
          </div>`;
        // Rounds 渲染（最多显示最新 6 轮，老的折叠隐藏 + 展开按钮）
        const sorted = rounds.slice().sort((a,b) => (Number(a.createdAt)||0) - (Number(b.createdAt)||0));
        const SHOW_N = 6;
        const shown = sorted.slice(-SHOW_N);
        const hiddenN = sorted.length - shown.length;
        const roundItemHtml = (rd, idx) => {
          // 双兼容读取轮次题目与答案：
          //   sessions-db.js：question / answer
          //   localHttpServer：questionText / answerText / aiAnswer
          const qRaw = ('question' in rd) ? rd.question : rd.questionText;
          const aRaw = ('answer' in rd && rd.answer)
            ? rd.answer
            : (rd && (rd.answerText || rd.aiAnswer));
          const q = escapeHtml((qRaw && String(qRaw)) || '（题目缺失）');
          const a = aRaw ? escapeHtml(String(aRaw)) : '';
          const stCls = (rd && rd.status === 'answered') ? 'bg-green-50 text-green-600'
                      : (rd && rd.status === 'error')    ? 'bg-red-50 text-red-600'
                      : 'bg-gray-50 text-gray-500';
          const stText = (rd && rd.status === 'answered') ? '已答题'
                      : (rd && rd.status === 'error')    ? '异常'
                      : (rd && rd.status === 'asked')    ? '已出题' : '进行中';
          // 时间戳：双兼容 createdAt（sessions-db.js）vs askedAt（桌面端出题时间）
          const t = fmtTime(rd && (rd.createdAt || rd.askedAt || rd.answeredAt));
          return `
            <div class="border border-gray-100 rounded-xl p-4 bg-white mb-3">
              <div class="flex items-center justify-between gap-3 mb-2">
                <div class="text-xs text-gray-500">第 ${idx + 1} 题 · ${t}</div>
                <span class="text-[11px] px-2 py-0.5 rounded-full ${stCls}">${stText}</span>
              </div>
              <div class="text-sm text-gray-800 mb-2 font-medium leading-relaxed">Q：${q}</div>
              ${a ? `<div class="text-sm text-gray-600 leading-relaxed whitespace-pre-wrap rounded-lg bg-gray-50 p-3"><span class="text-[11px] text-gray-400 mr-1.5 font-medium">A</span>${a.slice(0, 500)}${a.length > 500 ? '…' : ''}</div>` : ''}
            </div>`;
        };
        const roundsHtml = sorted.length === 0
          ? `<div class="text-sm text-gray-400 text-center py-6 bg-gray-50 rounded-xl">暂无问答轮次</div>`
          : shown.map((rd, i) => roundItemHtml(rd, i + Math.max(0, hiddenN))).join('')
            + (hiddenN > 0 ? `
                <div class="mt-2 text-center">
                  <button type="button" id="sessModalExpandMore" class="text-xs px-4 py-2 bg-gray-50 hover:bg-gray-100 text-gray-600 rounded-lg border border-gray-200">
                    ⬇ 显示更早的 ${hiddenN} 轮
                  </button>
                </div>
                <div id="sessModalHiddenRounds" style="display:none;">${sorted.slice(0, hiddenN).map((rd, i) => roundItemHtml(rd, i)).join('')}</div>` : '');
        // JD 快照（若有） + 简历快照（若有）
        const jdHtml = s.jdSnapshot ? `
          <details class="mb-3 border border-gray-100 rounded-xl p-4 bg-gray-50/40">
            <summary class="cursor-pointer text-xs font-semibold text-gray-700">📄 粘贴的 JD（面试开始时）</summary>
            <pre class="mt-2 text-xs text-gray-600 whitespace-pre-wrap leading-relaxed">${escapeHtml(String(s.jdSnapshot).slice(0, 2000))}</pre>
          </details>` : '';
        const cvHtml = s.resumeSnapshot ? `
          <details class="mb-3 border border-gray-100 rounded-xl p-4 bg-gray-50/40">
            <summary class="cursor-pointer text-xs font-semibold text-gray-700">📝 简历内容（面试开始时）</summary>
            <pre class="mt-2 text-xs text-gray-600 whitespace-pre-wrap leading-relaxed">${escapeHtml(String(s.resumeSnapshot).slice(0, 2000))}</pre>
          </details>` : '';
        el.modBody.innerHTML = statsHtml + jdHtml + cvHtml + `
          <div class="text-xs font-semibold text-gray-700 mb-2 mt-2">💬 问答轮次（新到旧，共 ${sorted.length} 轮）</div>
          <div id="sessModalRoundsWrap">${roundsHtml}</div>`;
        // 绑定"显示更多"按钮
        const exp = $('sessModalExpandMore');
        if (exp) {
          exp.addEventListener('click', () => {
            const h = $('sessModalHiddenRounds');
            if (h) { h.style.display = 'block'; }
            exp.style.display = 'none';
          });
        }
      }

      // —— 关闭弹窗 ——
      function closeModal() {
        _currentOpenId = null;
        el.modal.classList.add('hidden');
        el.modal.classList.remove('flex');
      }
      if (el.modClose) el.modClose.addEventListener('click', closeModal);
      // 点击遮罩空白处也关
      if (el.modal) el.modal.addEventListener('click', (e) => { if (e.target === el.modal) closeModal(); });
      // ESC 关
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && el.modal && !el.modal.classList.contains('hidden')) closeModal();
      });
      // 删除记录
      if (el.modDel) {
        el.modDel.addEventListener('click', async () => {
          if (!_currentOpenId) return;
          if (!confirm('确定删除该面试记录吗？删除后 rounds、JD、简历快照都会被清理且不可恢复。')) return;
          el.modDel.disabled = true;
          const bak = el.modDel.textContent;
          el.modDel.textContent = '删除中…';
          const r = await DesktopBridge.callApi(`/api/db/sessions/${encodeURIComponent(_currentOpenId)}`, { method: 'DELETE' });
          el.modDel.disabled = false;
          el.modDel.textContent = bak;
          if (r && r.ok) {
            Toast.show('删除成功', 'ok');
            closeModal();
            DesktopBridge.resetCache(); // 避免端口缓存
            state.page = 1;
            refreshSessionsPanel();
          } else {
            Toast.show('删除失败：' + ((r && (r.msg || r.error)) ? String(r.msg || r.error) : '未知原因'), 'error');
          }
        });
      }

      // —— Tab 切换（全部 / 💼真实 / 🎯模拟） ——
      if (el.tabs && el.tabs.length) {
        el.tabs.forEach(tab => {
          tab.addEventListener('click', () => {
            el.tabs.forEach(t => {
              t.classList.remove('bg-blue-600', 'text-white');
              t.classList.add('text-gray-600', 'hover:bg-gray-50');
            });
            tab.classList.add('bg-blue-600', 'text-white');
            tab.classList.remove('text-gray-600', 'hover:bg-gray-50');
            state.category = tab.dataset.sessCat || '';
            state.page = 1;
            refreshSessionsPanel();
          });
        });
      }

      // —— 搜索框：防抖 350ms ——
      if (el.search) {
        let _t = null;
        el.search.addEventListener('input', () => {
          if (_t) clearTimeout(_t);
          _t = setTimeout(() => {
            state.keyword = el.search.value.trim();
            state.page = 1;
            refreshSessionsPanel();
          }, 350);
        });
        el.search.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
      }

      // —— 分页上一页 / 下一页 ——
      if (el.prevBtn) el.prevBtn.addEventListener('click', () => {
        if (state.page <= 1) return;
        state.page--;
        refreshSessionsPanel();
      });
      if (el.nextBtn) el.nextBtn.addEventListener('click', () => {
        const pageTotal = Math.ceil(state.total / state.pageSize) || 1;
        if (state.page >= pageTotal) return;
        state.page++;
        refreshSessionsPanel();
      });

      // 初始刷一次数据
      refreshSessionsPanel();
    }
    // 把"重进面板只刷新"的函数名也改成跟上面赋值一致（避免引用 undefined）
    function refreshSessionsPanel() {
      if (typeof window.__hireme_refreshSessions === 'function') return window.__hireme_refreshSessions();
      // bindSessionsPanel 还没执行（没进过菜单）就先绑
      bindSessionsPanel();
    }

    function bindSettings() {
      const saveBtn = $('saveProfileBtn');
      if (saveBtn) saveBtn.addEventListener('click', saveProfile);
      const pwBtn = $('changePasswordBtn');
      if (pwBtn) pwBtn.addEventListener('click', changePasswordAction);
    }

    // ---------- 入口：启动控制台 ----------
    (async function bootConsole() {
      // 先验证登录状态
      const meR = await API.me();
      if (!meR.ok || !meR.data || !meR.data.loggedIn) {
        hide(mainEl);
        show(unauth);
        return;
      }

      // 显示主布局
      show(mainEl);
      hide(unauth);

      const user = meR.data.user || {};

      // 初始化菜单交互
      initMenuNavigation();

      // 绑定各种交互
      bindBuyCredits();
      bindQuickActions();
      bindLogout();
      bindFeedback();
      bindSettings();
      bindNewsDetailClose();
      bindInvitePromoBar(); // 总览「邀请好友，赚取积分」横条 → 跳转邀请有礼完整页

      // 渲染用户信息
      renderUserInfo(user);

      // 加载积分数据
      const creditsR = await API.getCredits();
      if (creditsR.ok && creditsR.data) {
        const credits = creditsR.data.credits || {};
        renderCredits(credits);
      } else {
        setText('creditsAmount', '0');
      }

      // 加载流水数据（用于最近活动）
      const flowsR = await API.getFlows({ limit: 10, desc: 1 });
      if (flowsR.ok && flowsR.data) {
        renderActivities(flowsR.data.flows);
      } else {
        renderActivities([]);
      }

      // 加载签到状态（从后端获取真实签到进度，替代原来写死的第1天）
      await loadCheckinStatus();

      // 加载邀请好友信息（邀请码、统计、记录）
      await loadInviteInfo();

    })().catch((e) => {
      console.error('[console] init 异常：', e);
      Toast.show('控制台初始化失败，请刷新', 'error');
    });
  }
  window.HireMeInitConsole = initConsolePage;

  // ------------------------------------------------------------
  // 5. 页脚年份
  // ------------------------------------------------------------
  function fillYear() {
    const el = $('yearNow');
    if (el) el.textContent = String(new Date().getFullYear());
  }

  // ------------------------------------------------------------
  // 6. 安全转义（内联 HTML 拼接使用，避免 XSS）
  // ------------------------------------------------------------
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function escapeAttr(s) { return escapeHtml(s); }

  // ------------------------------------------------------------
  // 入口：DOM Ready 执行
  // ------------------------------------------------------------
  function boot() {
    fillYear();
    // 导航栏是每一页都有的，所以一定尝试渲染登录态；失败静默
    renderNavAuth().catch((e) => {
      console.warn('[HireMe] 初始化登录态失败：', e);
    });
    // 如果当前在登录/注册页，初始化表单交互
    initAuthPage();
    // 如果当前是控制台页面，初始化控制台逻辑（拉积分+渲染购买/流水/订单）
    initConsolePage();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
