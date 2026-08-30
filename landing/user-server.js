/**
 * landing/user-server.js —— 用户端独立 HTTP 服务
 *
 * 职责：
 *   1. 静态托管 landing/public 下的用户页面（index.html, console.html, login.html）
 *   2. 处理 /api/auth/*（注册/登录/登出/me）
 *   3. 处理 /api/console/*（积分查询/流水/订单/扣费）
 *   4. 处理 /api/sessions/*（面试记录查询/删除，直连桌面端共享的 interview.db）
 *
 * 启动：
 *   node user-server.js   # 监听 http://localhost:3000
 */
'use strict';

const http = require('http');
const os   = require('os');
const urlLib = require('url');

/** 引入共享模块，获取所有工具函数 */
const S = require('./shared.js');

/** 面试记录 DB（直连项目根 data/interview.db，无需启动桌面端） */
const SessionsDB = require('./sessions-db.js');

const PORT = S.USER_PORT;
const HOST = process.env.LANDING_HOST || '0.0.0.0';

// ============================================================
// API：认证相关
// ============================================================

/**
 * /api/auth/* 统一入口
 * @param {{method:string,pathname:string,body:any,query:any}} ctx 请求上下文
 * @param {http.IncomingMessage} req 请求对象
 * @param {http.ServerResponse} res 响应对象
 */
async function handleAuthApi(ctx, req, res) {
  const { method, pathname, body } = ctx;

  // ----- /api/auth/register -----
  if (method === 'POST' && pathname === '/api/auth/register') {
    try {
      const email       = String((body && body.email)       || '').trim();
      const password    = String((body && body.password)    || '');
      const displayName = String((body && body.displayName) || '').trim();
      const inviteCode  = String((body && body.inviteCode)  || '').trim().toUpperCase();
      if (!email)    return S.sendJSON(res, 400, { ok: false, msg: '请填写邮箱' });
      if (!password) return S.sendJSON(res, 400, { ok: false, msg: '请填写密码' });

      const r = S.auth.createAccount({ email, password, displayName, isAdmin: false });
      if (!r.ok) {
        const [msg, code] = S.ERROR_TEXT[r.error] || ['注册失败，请稍后再试', 500];
        return S.sendJSON(res, code, { ok: false, msg, code: r.error });
      }

      // 如果填了邀请码，在注册成功后处理邀请奖励（不影响注册流程本身）
      let inviteResult = null;
      if (inviteCode) {
        try {
          // 按邀请码查询邀请人账号
          const inviter = S.DAL.getInviterByCode(inviteCode);
          if (inviter && inviter.account_id !== r.accountId) {
            // 处理邀请奖励（事务：插入邀请记录 + 双方加积分 + 双方流水）
            inviteResult = S.DAL.processInviteReward(
              inviter.account_id, r.accountId, inviteCode
            );
          }
        } catch (e) {
          console.error('[user-server][register] 邀请奖励处理失败：', e);
          // 邀请码处理失败不影响注册成功
        }
      }

      const v = S.auth.verifyPassword(email, password);
      if (!v.ok) {
        return S.sendJSON(res, 201, {
          ok: true, autoLogin: false,
          msg: inviteResult && inviteResult.ok
            ? '注册成功，受邀奖励 +50 积分已到账，请登录'
            : '注册成功，请登录',
          inviteReward: (inviteResult && inviteResult.ok) ? inviteResult.inviteeReward : 0,
        });
      }
      const { sid, expireAt } = await S.createWebSession({
        accountId: v.accountId, displayEmail: v.email,
        displayName: v.displayName, avatar: v.avatar,
        isAdmin: false,
      });
      S.setSessionCookie(res, sid, expireAt);
      return S.sendJSON(res, 201, {
        ok: true, autoLogin: true,
        msg: inviteResult && inviteResult.ok
          ? '注册成功，受邀奖励 +50 积分已到账'
          : '注册成功，已自动登录',
        sessionId: sid, expireAt,
        inviteReward: (inviteResult && inviteResult.ok) ? inviteResult.inviteeReward : 0,
        user: {
          accountId: v.accountId, email: v.email,
          displayName: v.displayName, avatar: v.avatar || '',
          isAdmin: false,
        },
      });
    } catch (e) {
      console.error('[user-server][register] 异常：', e);
      return S.sendJSON(res, 500, { ok: false, msg: '服务器异常：' + (e.message || '未知错误') });
    }
  }

  // ----- /api/auth/login -----
  if (method === 'POST' && pathname === '/api/auth/login') {
    try {
      const email    = String((body && body.email)    || '').trim();
      const password = String((body && body.password) || '');
      if (!email)    return S.sendJSON(res, 400, { ok: false, msg: '请填写邮箱' });
      if (!password) return S.sendJSON(res, 400, { ok: false, msg: '请填写密码' });

      const v = S.auth.verifyPassword(email, password);
      if (!v.ok) {
        const [msg, code] = S.ERROR_TEXT[v.error] || ['登录失败，请稍后再试', 500];
        return S.sendJSON(res, code, { ok: false, msg, code: v.error });
      }
      // verifyPassword 返回值已包含 isAdmin（从 SQLite 账号表读取），无需再读 accounts.json
      const isAdmin = !!v.isAdmin;

      // 权限分离：管理员账号不允许在用户端登录，需引导至管理后台
      if (isAdmin) {
        return S.sendJSON(res, 403, {
          ok: false,
          msg: '此账号为管理员账号，请从管理后台登录',
          code: 'ADMIN_NOT_ALLOWED',
          adminUrl: 'http://localhost:3001',
        });
      }

      const { sid, expireAt } = await S.createWebSession({
        accountId: v.accountId, displayEmail: v.email,
        displayName: v.displayName, avatar: v.avatar,
        isAdmin,
      });
      S.setSessionCookie(res, sid, expireAt);
      return S.sendJSON(res, 200, {
        ok: true, msg: '登录成功',
        sessionId: sid, expireAt,
        user: {
          accountId: v.accountId, email: v.email,
          displayName: v.displayName, avatar: v.avatar || '',
          createdAt: v.createdAt, lastLoginTs: v.lastLoginTs,
          isAdmin,
        },
      });
    } catch (e) {
      console.error('[user-server][login] 异常：', e);
      return S.sendJSON(res, 500, { ok: false, msg: '服务器异常：' + (e.message || '未知错误') });
    }
  }

  // ----- /api/auth/me -----
  if (method === 'GET' && pathname === '/api/auth/me') {
    try {
      const sid  = S.extractSid(req);
      const sess = await S.verifyWebSession(sid);
      if (!sess) {
        S.clearSessionCookie(res);
        return S.sendJSON(res, 200, { ok: true, loggedIn: false, user: null });
      }
      let isAdmin = !!sess.isAdmin;
      // 通过 AuthDB 从 SQLite 实时查询账号 isAdmin 状态（替代 accounts.json 读取）
      try {
        const acc = S.auth.getAccount(sess.accountId);
        if (acc) isAdmin = !!acc.isAdmin;
      } catch (_) {}

      return S.sendJSON(res, 200, {
        ok: true, loggedIn: true,
        user: {
          accountId: sess.accountId, email: sess.email,
          displayName: sess.displayName, avatar: sess.avatar,
          createdAt: sess.createdAt, sessionExpireAt: sess.expireAt,
          isAdmin,
        },
      });
    } catch (e) {
      console.error('[user-server][me] 异常：', e);
      return S.sendJSON(res, 500, { ok: false, msg: '服务器异常' });
    }
  }

  // ----- /api/auth/logout -----
  if (method === 'POST' && pathname === '/api/auth/logout') {
    try {
      const sid = S.extractSid(req);
      await S.destroyWebSession(sid);
      S.clearSessionCookie(res);
      return S.sendJSON(res, 200, { ok: true, msg: '已退出登录' });
    } catch (e) {
      console.error('[user-server][logout] 异常：', e);
      return S.sendJSON(res, 500, { ok: false, msg: '服务器异常' });
    }
  }

  return S.sendJSON(res, 404, { ok: false, msg: 'API 不存在' });
}

// ============================================================
// 控制台 API：积分查询 / 流水 / 订单 / 扣费
// ============================================================

/**
 * /api/console/* 统一入口
 */
async function handleConsoleApi(ctx, req, res) {
  const { method, pathname, body, query } = ctx;

  // ---------- 公开接口：套餐列表 ----------
  if (method === 'GET' && pathname === '/api/console/packages') {
    const list = S.CREDIT_PACKAGES.map((p) => Object.assign({}, p, {
      priceYuan: (p.priceCents / 100).toFixed(2),
      totalCredits: p.credits + p.bonus,
    }));
    return S.sendJSON(res, 200, { ok: true, packages: list });
  }

  // ---------- 公开接口：功能消耗价目表 ----------
  if (method === 'GET' && pathname === '/api/console/price-list') {
    return S.sendJSON(res, 200, {
      ok: true,
      items: [
        { key: 'copilot_session', name: '真实面试 · Copilot（每场）', credits: S.CREDIT_PRICE_LIST.COPILOT_PER_SESSION,
          desc: '30 分钟内同一场面试不重复扣费' },
        { key: 'mock_round',      name: 'AI 模拟面试（每轮问答）',   credits: S.CREDIT_PRICE_LIST.MOCK_PER_ROUND,
          desc: '1 轮 = 面试官 1 题 + 你回答 + AI 点评' },
        { key: 'resume_optimize', name: '简历优化（每次）',         credits: S.CREDIT_PRICE_LIST.RESUME_OPTIMIZE,
          desc: '含 ATS 评分 + 缺失关键词 + STAR 改写 + 量化建议' },
      ],
    });
  }

  // ---------- 公开接口：已发布公告列表（未登录也可查看，用于宣传） ----------
  if (method === 'GET' && pathname === '/api/console/news') {
    try {
      const limit = Math.min(50, Math.max(1, Number(query.limit) || 20));
      const page = Math.max(1, Number(query.page) || 1);
      const offset = (page - 1) * limit;
      const items = S.DAL.listPublishedNews(limit, offset);
      const total = S.DAL.countPublishedNews();
      return S.sendJSON(res, 200, {
        ok: true, total, page, limit,
        items: items.map(n => ({
          newsId: n.newsId,
          title: n.title,
          category: n.category,
          isPinned: n.isPinned,
          viewCount: n.viewCount,
          publishedAt: n.publishedAt,
          // 列表只返回摘要（前 120 字），完整内容需查详情
          summary: (n.content || '').slice(0, 120),
        })),
      });
    } catch (e) {
      console.error('[console][news] 异常：', e);
      return S.sendJSON(res, 500, { ok: false, msg: '获取公告失败：' + (e.message || '') });
    }
  }

  // ---------- 公开接口：公告详情（按 news_id 查询，浏览数 +1） ----------
  if (method === 'GET' && pathname.startsWith('/api/console/news/')) {
    try {
      const newsId = decodeURIComponent(pathname.slice('/api/console/news/'.length));
      if (!newsId) return S.sendJSON(res, 400, { ok: false, msg: '公告ID不能为空' });
      const news = S.DAL.getNewsById(newsId);
      if (!news) return S.sendJSON(res, 404, { ok: false, msg: '公告不存在或已下架' });
      if (!news.isPublished) return S.sendJSON(res, 404, { ok: false, msg: '公告不存在或已下架' });
      // 浏览数 +1（异步统计，不影响返回）
      try { S.DAL.incrNewsView(newsId); } catch (_) {}
      return S.sendJSON(res, 200, { ok: true, news });
    } catch (e) {
      console.error('[console][news-detail] 异常：', e);
      return S.sendJSON(res, 500, { ok: false, msg: '获取详情失败：' + (e.message || '') });
    }
  }

  // ---------- 以下接口都需要登录 ----------
  const auth = await S._requireLogin(req, res);
  if (!auth) return;
  const { accountId, sess } = auth;

  // ---------- GET /api/console/credits ----------
  if (method === 'GET' && pathname === '/api/console/credits') {
    try {
      const b = S.readBalance(accountId);
      return S.sendJSON(res, 200, {
        ok: true,
        credits: b,
        user: {
          accountId:   sess.accountId,
          email:       sess.email,
          displayName: sess.displayName,
          avatar:      sess.avatar || '',
        },
      });
    } catch (e) {
      console.error('[console][credits] 异常：', e);
      return S.sendJSON(res, 500, { ok: false, msg: '读取积分失败：' + (e.message || '') });
    }
  }

  // ---------- GET /api/console/flows ----------
  if (method === 'GET' && pathname === '/api/console/flows') {
    try {
      const fromMonth = query && typeof query.fromMonth === 'string' ? query.fromMonth : null;
      const toMonth   = query && typeof query.toMonth   === 'string' ? query.toMonth   : null;
      const type      = query && typeof query.type      === 'string' ? query.type      : null;
      const bizType   = query && typeof query.bizType   === 'string' ? query.bizType   : null;
      const limit     = Number(query && query.limit) || 100;
      const offset    = Number(query && query.offset) || 0;
      const desc      = Number(query && query.desc) !== 0;
      const list = S.listCreditFlows(accountId, fromMonth, toMonth, { type, bizType, limit, offset, desc });
      // 查询真实总数（用于分页）
      const total = S.countCreditFlows(accountId, fromMonth, toMonth, { type, bizType });
      const safe = list.map((f) => ({
        flowId:   f.flowId,
        type:     f.type,
        bizType:  f.bizType,
        bizId:    f.bizId || '',
        amount:   Number(f.amount) || 0,
        delta:    Number(f.delta)  || 0,
        balanceAfter: Number(f.balanceAfter) || 0,
        desc:     f.desc || '',
        month:    f.month || '',
        createdAt: Number(f.createdAt) || 0,
      }));
      return S.sendJSON(res, 200, { ok: true, flows: safe, total });
    } catch (e) {
      console.error('[console][flows] 异常：', e);
      return S.sendJSON(res, 500, { ok: false, msg: '读取流水失败：' + (e.message || '') });
    }
  }

  // ---------- GET /api/console/orders ----------
  if (method === 'GET' && pathname === '/api/console/orders') {
    try {
      const limit = Number(query && query.limit) || 50;
      const raw = S.listOrdersByAccount(accountId, limit);
      const safe = raw.map((o) => ({
        orderId:    o.orderId,
        packageId:  o.packageId,
        packageName:o.packageName || '',
        credits:    Number(o.credits) || 0,
        bonus:      Number(o.bonus)   || 0,
        priceYuan:  (Number(o.priceCents) / 100).toFixed(2),
        status:     o.status,
        channel:    o.channel || '',
        createdAt:  Number(o.createdAt) || 0,
        paidAt:     Number(o.paidAt)    || 0,
      }));
      return S.sendJSON(res, 200, { ok: true, orders: safe });
    } catch (e) {
      console.error('[console][ordersList] 异常：', e);
      return S.sendJSON(res, 500, { ok: false, msg: '读取订单失败：' + (e.message || '') });
    }
  }

  // ---------- POST /api/console/orders/create ----------
  if (method === 'POST' && pathname === '/api/console/orders/create') {
    try {
      const packageId = String((body && body.packageId) || '').trim();
      if (!packageId) {
        return S.sendJSON(res, 400, { ok: false, msg: '请选择要购买的套餐', code: 'MISSING_PACKAGE' });
      }
      const pkg = S.CREDIT_PACKAGES.find((p) => p.id === packageId);
      if (!pkg) {
        return S.sendJSON(res, 400, { ok: false, msg: '套餐不存在，请刷新重试', code: 'BAD_PACKAGE' });
      }
      const orderId = 'OR' + Date.now().toString(36).toUpperCase()
                        + require('crypto').randomBytes(3).toString('hex').toUpperCase();
      const now = Date.now();
      const order = {
        orderId,
        accountId,
        packageId: pkg.id,
        packageName: pkg.title,
        credits: pkg.credits,
        bonus: pkg.bonus,
        priceCents: pkg.priceCents,
        status: 'pending',
        channel: '',
        createdAt: now,
        paidAt: 0,
        cancelledAt: 0,
        meta: { userAgent: String(req.headers['user-agent'] || '') },
      };
      await S.upsertOrder(order);
      return S.sendJSON(res, 200, {
        ok: true,
        order: {
          orderId,
          packageId:   pkg.id,
          packageName: pkg.title,
          credits:     pkg.credits,
          bonus:       pkg.bonus,
          priceYuan:   (pkg.priceCents / 100).toFixed(2),
          status:      'pending',
          createdAt:   now,
        },
      });
    } catch (e) {
      console.error('[console][orderCreate] 异常：', e);
      return S.sendJSON(res, 500, { ok: false, msg: '创建订单失败：' + (e.message || '') });
    }
  }

  // ---------- POST /api/console/orders/pay ----------
  if (method === 'POST' && pathname === '/api/console/orders/pay') {
    try {
      const orderId = String((body && body.orderId) || '').trim();
      const channel = String((body && body.channel) || 'mock').trim();
      if (!orderId) {
        return S.sendJSON(res, 400, { ok: false, msg: '缺少订单号', code: 'MISSING_ORDER' });
      }
      // 从 SQLite 查询订单
      const order = S.getOrder(orderId);
      if (!order) {
        return S.sendJSON(res, 404, { ok: false, msg: '订单不存在，请重新下单', code: 'ORDER_NOT_FOUND' });
      }
      if (order.accountId !== accountId) {
        return S.sendJSON(res, 403, { ok: false, msg: '无权操作他人订单', code: 'FORBIDDEN' });
      }
      if (order.status === 'paid') {
        return S.sendJSON(res, 200, { ok: true, alreadyPaid: true, msg: '该订单已支付，积分已到账', orderId });
      }
      if (order.status !== 'pending') {
        return S.sendJSON(res, 400, { ok: false, msg: `当前订单状态为 ${order.status}，无法支付`, code: 'BAD_STATUS' });
      }
      const pkg = S.CREDIT_PACKAGES.find((p) => p.id === order.packageId);
      if (!pkg) {
        return S.sendJSON(res, 400, { ok: false, msg: '套餐已下架，请重新选择后下单', code: 'PKG_GONE' });
      }

      const totalCredits = pkg.credits + pkg.bonus;

      // 使用 DAL 事务：原子更新订单状态 + 增加余额 + 写流水
      // WHERE status='pending' 防止并发重复支付
      const result = S.payOrder({
        orderId,
        accountId,
        channel,
        totalCredits,
        desc: `购买「${pkg.title}」套餐，+${pkg.credits} 积分` + (pkg.bonus > 0 ? `（送 ${pkg.bonus}）` : ''),
        meta: { packageId: pkg.id, baseCredits: pkg.credits, bonusCredits: pkg.bonus, priceCents: pkg.priceCents, channel },
      });

      if (result.alreadyPaid) {
        return S.sendJSON(res, 200, { ok: true, alreadyPaid: true, msg: '该订单已支付，积分已到账', orderId });
      }

      return S.sendJSON(res, 200, {
        ok: true,
        msg: '支付成功，积分已到账',
        orderId,
        balance:    result.balance,
        flowId:     result.flowId,
        paidCredits: totalCredits,
      });
    } catch (e) {
      console.error('[console][orderPay] 异常：', e);
      return S.sendJSON(res, 500, { ok: false, msg: '支付失败：' + (e.message || '') });
    }
  }

  // ---------- POST /api/console/consume（通用扣积分） ----------
  if (method === 'POST' && pathname === '/api/console/consume') {
    try {
      const rawCredits = (body && body.credits) ?? (body && body.amount);
      const credits    = Number(rawCredits);
      if (!Number.isSafeInteger(credits) || credits <= 0) {
        return S.sendJSON(res, 400, { ok: false, msg: '非法的消耗积分数量（必须为正整数）', code: 'BAD_CREDITS' });
      }
      const bizType = String((body && body.bizType) || '').trim() || 'consume';
      const bizId   = String((body && body.bizId)   || '').trim().slice(0, 64);
      const desc    = String((body && body.desc)    || '').trim().slice(0, 200);

      // 使用 DAL 事务：原子检查余额 + 扣减 + 写流水
      // WHERE balance >= ? 防止并发超扣
      const result = S.consumeCredits({
        accountId,
        credits,
        bizType,
        bizId,
        desc,
      });

      if (result && result.insufficient) {
        return S.sendJSON(res, 400, {
          ok: false, code: 'INSUFFICIENT_CREDITS',
          msg: `积分不足：当前 ${result.balance}，本次需要 ${credits}，还差 ${credits - result.balance}`,
          current: result.balance, required: credits, missing: credits - result.balance,
        });
      }

      return S.sendJSON(res, 200, {
        ok: true,
        msg: '扣费成功',
        creditsConsumed: credits,
        balance:        result.balance,
        balanceAfter:   result.balance,
        flowId:         result.flow.flowId,
        totalConsumed:  result.totalConsumed,
      });
    } catch (e) {
      console.error('[console][consume] 异常：', e);
      return S.sendJSON(res, 500, { ok: false, msg: '扣费失败：' + (e.message || '') });
    }
  }

  // ---------- GET /api/console/checkin（查询今日签到状态） ----------
  if (method === 'GET' && pathname === '/api/console/checkin') {
    try {
      // 从 DAL 查询签到状态（已签到天数、今日奖励、历史记录）
      const status = S.DAL.getCheckinStatus(accountId);
      return S.sendJSON(res, 200, { ok: true, status });
    } catch (e) {
      console.error('[console][checkin-get] 异常：', e);
      return S.sendJSON(res, 500, { ok: false, msg: '查询签到状态失败：' + (e.message || '') });
    }
  }

  // ---------- POST /api/console/checkin（执行今日签到） ----------
  if (method === 'POST' && pathname === '/api/console/checkin') {
    try {
      // DAL.doCheckin 内部用事务保证：签到记录 + 余额增加 + 流水写入 原子完成
      const result = S.DAL.doCheckin(accountId);

      // 今日已签到
      if (!result.ok && result.alreadyCheckedIn) {
        return S.sendJSON(res, 200, {
          ok: false,
          alreadyCheckedIn: true,
          msg: '今日已签到，明天再来吧',
          currentDay: result.currentDay,
          reward: result.reward,
          balance: result.balance,
        });
      }

      return S.sendJSON(res, 200, {
        ok: true,
        msg: `签到成功！连续第 ${result.currentDay} 天，获得 +${result.reward} 积分`,
        currentDay: result.currentDay,
        reward: result.reward,
        balance: result.balance,
        continuousDays: result.continuousDays,
      });
    } catch (e) {
      console.error('[console][checkin-post] 异常：', e);
      return S.sendJSON(res, 500, { ok: false, msg: '签到失败：' + (e.message || '') });
    }
  }

  // ---------- GET /api/console/invite（获取我的邀请码 + 邀请统计 + 邀请记录） ----------
  if (method === 'GET' && pathname === '/api/console/invite') {
    try {
      // 获取或生成当前用户的专属邀请码（首次调用自动生成）
      const inviteCode = S.DAL.getOrGenerateInviteCode(accountId);
      // 统计已邀请总人数和总奖励积分
      const stats = S.DAL.getInviteStats(accountId);
      // 查询最近 20 条邀请记录
      const records = S.DAL.listInviteRecords(accountId, 20, 0);
      // 构造邀请链接（用户可分享给好友）
      const inviteLink = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host || 'localhost:3000'}/login.html?invite=${inviteCode}`;

      return S.sendJSON(res, 200, {
        ok: true,
        invite: {
          inviteCode,
          inviteLink,
          totalInvited: stats.totalInvited,
          totalReward: stats.totalReward,
          inviterReward: 50,  // 邀请人奖励规则
          inviteeReward: 50,  // 被邀请人奖励规则
          records,
        },
      });
    } catch (e) {
      console.error('[console][invite] 异常：', e);
      return S.sendJSON(res, 500, { ok: false, msg: '获取邀请信息失败：' + (e.message || '') });
    }
  }

  // ---------- POST /api/console/profile（修改昵称） ----------
  if (method === 'POST' && pathname === '/api/console/profile') {
    try {
      const displayName = String((body && body.displayName) || '').trim();
      if (!displayName) return S.sendJSON(res, 400, { ok: false, msg: '昵称不能为空' });
      if (displayName.length > 20) return S.sendJSON(res, 400, { ok: false, msg: '昵称最多 20 个字符' });

      // 调用 auth-db 的 updateProfile 更新昵称
      const r = S.auth.updateProfile(accountId, { displayName });
      if (!r || !r.ok) {
        return S.sendJSON(res, 400, { ok: false, msg: (r && r.error) || '修改失败' });
      }
      return S.sendJSON(res, 200, { ok: true, msg: '昵称修改成功', displayName });
    } catch (e) {
      console.error('[console][profile] 异常：', e);
      return S.sendJSON(res, 500, { ok: false, msg: '修改失败：' + (e.message || '') });
    }
  }

  // ---------- POST /api/console/password（修改密码） ----------
  if (method === 'POST' && pathname === '/api/console/password') {
    try {
      const oldPassword = String((body && body.oldPassword) || '');
      const newPassword = String((body && body.newPassword) || '');
      if (!oldPassword) return S.sendJSON(res, 400, { ok: false, msg: '请输入当前密码' });
      if (!newPassword || newPassword.length < 6) return S.sendJSON(res, 400, { ok: false, msg: '新密码至少 6 位' });

      // 调用 auth-db 的 changePassword 修改密码（内部会校验旧密码）
      const r = S.auth.changePassword(accountId, oldPassword, newPassword);
      if (!r || !r.ok) {
        const msg = r && r.error === 'BAD_OLD_PASSWORD' ? '当前密码不正确'
          : r && r.error === 'WEAK_PASSWORD' ? '新密码至少 6 位'
          : '修改失败';
        return S.sendJSON(res, 400, { ok: false, msg, code: r && r.error });
      }
      return S.sendJSON(res, 200, { ok: true, msg: '密码修改成功，请重新登录' });
    } catch (e) {
      console.error('[console][password] 异常：', e);
      return S.sendJSON(res, 500, { ok: false, msg: '修改失败：' + (e.message || '') });
    }
  }

  // ---------- POST /api/console/redeem（兑换码兑换积分） ----------
  if (method === 'POST' && pathname === '/api/console/redeem') {
    try {
      const code = String((body && body.code) || '').trim();
      if (!code) return S.sendJSON(res, 400, { ok: false, msg: '请输入兑换码' });

      // 调用 DAL 的 useRedeemCode（事务内完成：占用 + 加余额 + 写流水）
      const r = S.DAL.useRedeemCode({ code, accountId });
      if (!r.ok) {
        // 错误码到中文提示的映射
        const msgMap = {
          EMPTY_CODE:   '请输入兑换码',
          NO_ACCOUNT:   '账号异常，请重新登录',
          NOT_FOUND:    '兑换码不存在',
          ALREADY_USED: '兑换码已被使用',
          EXPIRED:      '兑换码已过期',
        };
        return S.sendJSON(res, 400, { ok: false, msg: msgMap[r.error] || '兑换失败', code: r.error });
      }
      return S.sendJSON(res, 200, {
        ok: true,
        msg: `兑换成功！获得 ${r.credits} 积分`,
        credits: r.credits,
        balance: r.balance,
        code: r.code,
        flowId: r.flowId,
      });
    } catch (e) {
      console.error('[console][redeem] 异常：', e);
      return S.sendJSON(res, 500, { ok: false, msg: '兑换失败：' + (e.message || '') });
    }
  }

  // ---------- GET /api/console/redeem/records（我的兑换记录） ----------
  if (method === 'GET' && pathname === '/api/console/redeem/records') {
    try {
      const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
      const page = Math.max(1, Number(query.page) || 1);
      const offset = (page - 1) * limit;
      const items = S.DAL.listMyRedeemedCodes(accountId, limit, offset);
      const total = S.DAL.countMyRedeemedCodes(accountId);
      return S.sendJSON(res, 200, { ok: true, total, page, limit, items });
    } catch (e) {
      console.error('[console][redeem-records] 异常：', e);
      return S.sendJSON(res, 500, { ok: false, msg: '获取记录失败：' + (e.message || '') });
    }
  }

  return S.sendJSON(res, 404, { ok: false, msg: '控制台 API 不存在' });
}

// ============================================================
// 面试记录 API：直连桌面端共享的 interview.db（无需启动桌面端）
//   返回格式与 services/localHttpServer.js 完全兼容，前端 DesktopBridge 0 改动
//   - GET  /api/db/sessions/health          → 健康检查+分类计数
//   - GET  /api/db/sessions/list            → 分页列表
//   - GET  /api/db/sessions/:id             → 单条详情+轮次
//   - DELETE /api/db/sessions/:id           → 删除会话
// 同时兼容不带 /db 的路径 /api/sessions/*
// ============================================================
/**
 * 面试记录 API 统一入口
 * @param {{method:string,pathname:string,body:any,query:any}} ctx
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 */
async function handleSessionsApi(ctx, req, res) {
  const { method, pathname, query } = ctx;

  // —— 规范化路径：把 /api/sessions/xxx 与 /api/db/sessions/xxx 统一成相对子路径 /xxx
  let sub = pathname;
  if (sub.startsWith('/api/db/sessions')) sub = sub.substring('/api/db/sessions'.length);
  else if (sub.startsWith('/api/sessions')) sub = sub.substring('/api/sessions'.length);
  if (!sub.startsWith('/')) sub = '/' + sub;

  // —— 登录态：尽量从 Cookie 获取（用于账号隔离），但不强制登录（health 可以匿名访问用于端口探测降级判定）
  let currentAccountId = null;
  try {
    const sid = S.extractSid(req);
    const sess = await S.verifyWebSession(sid);
    if (sess && sess.accountId) currentAccountId = sess.accountId;
  } catch (_) { currentAccountId = null; }

  // ---------- GET /health：健康检查（SQLite不可用也返回200，前端按 sqliteUnavailable 降级） ----------
  if (method === 'GET' && sub === '/health') {
    const r = SessionsDB.health(currentAccountId);
    // 字段与 localHttpServer 完全一致：{ok,ready,sessionCount,roundCount,categories,dbPath,sqliteUnavailable,msg}
    return S.sendJSON(res, 200, r);
  }

  // ---------- GET /list：分页列表 ----------
  if (method === 'GET' && sub === '/list') {
    // 🟢 严格账号隔离：列表接口必须登录，避免未登录时返回全局会话
    if (!currentAccountId) {
      return S.sendJSON(res, 401, { ok: false, error: 'unauthorized', msg: '请先登录' });
    }
    const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || Number(query.limit) || 9));
    const page     = Math.max(1, Number(query.page) || (Number(query.offset) >= 0 ? (Math.floor(Number(query.offset) / pageSize) + 1) : 1));
    const r = SessionsDB.listSessions({
      accountId: currentAccountId,
      category:  query.category,
      keyword:   query.keyword,
      page, pageSize,
    });
    return S.sendJSON(res, 200, r);
  }

  // ---------- GET /:id：详情 ----------
  if (method === 'GET' && /^\/[^/]+$/.test(sub) && sub !== '/health' && sub !== '/list') {
    const id = decodeURIComponent(sub.substring(1));
    // 详情需要登录：避免别人用 ID 猜
    if (!currentAccountId) {
      return S.sendJSON(res, 401, { ok: false, error: 'unauthorized', msg: '请先登录' });
    }
    const r = SessionsDB.getSessionDetail(id, currentAccountId);
    if (r.ok) return S.sendJSON(res, 200, r);
    if (r.error === 'not_found') return S.sendJSON(res, 404, r);
    if (r.error === 'forbidden') return S.sendJSON(res, 403, r);
    if (r.error === 'invalid')   return S.sendJSON(res, 400, r);
    if (r.sqliteUnavailable)     return S.sendJSON(res, 200, r);
    return S.sendJSON(res, 500, r);
  }

  // ---------- DELETE /:id：删除 ----------
  if (method === 'DELETE' && /^\/[^/]+$/.test(sub)) {
    if (!currentAccountId) {
      return S.sendJSON(res, 401, { ok: false, error: 'unauthorized', msg: '请先登录' });
    }
    const id = decodeURIComponent(sub.substring(1));
    const r = SessionsDB.deleteSession(id, currentAccountId);
    if (r.ok) return S.sendJSON(res, 200, r);
    if (r.error === 'not_found') return S.sendJSON(res, 404, r);
    if (r.error === 'forbidden') return S.sendJSON(res, 403, r);
    if (r.error === 'invalid')   return S.sendJSON(res, 400, r);
    if (r.sqliteUnavailable)     return S.sendJSON(res, 200, r);
    return S.sendJSON(res, 500, r);
  }

  return S.sendJSON(res, 404, { ok: false, msg: '面试记录 API 不存在' });
}

// ============================================================
// HTTP Server 主入口
// ============================================================
const server = http.createServer(async (req, res) => {
  const parsed = urlLib.parse(req.url || '/', true);
  const method   = (req.method || 'GET').toUpperCase();
  const pathname = parsed.pathname || '/';
  const query    = parsed.query || {};

  try {
    // -------- API --------
    if (pathname.startsWith('/api/')) {
      let body = {};
      if (method !== 'GET' && method !== 'HEAD') {
        try {
          body = await S.parseBody(req);
        } catch (e) {
          const code = (e && e.code === 'BODY_TOO_BIG') ? 413
                     : (e && e.code === 'BAD_BODY')     ? 400 : 400;
          return S.sendJSON(res, code, { ok: false, msg: e.message || '请求体解析失败' });
        }
      }
      if (pathname.startsWith('/api/auth/')) {
        return await handleAuthApi({ method, pathname, body, query }, req, res);
      }
      if (pathname.startsWith('/api/console/')) {
        return await handleConsoleApi({ method, pathname, body, query }, req, res);
      }
      // ★ 面试记录接口：直连桌面端共享的 interview.db，不需要启动桌面端 Electron
      //   - URL 命名：/api/db/sessions/*（与本地 HTTP 服务保持完全一致，前端 DesktopBridge 调用路径不变）
      //   - 或同时兼容两种：/api/sessions/* 与 /api/db/sessions/*
      if (pathname.startsWith('/api/db/sessions') || pathname.startsWith('/api/sessions')) {
        return await handleSessionsApi({ method, pathname, body, query }, req, res);
      }
      return S.sendJSON(res, 404, { ok: false, msg: 'API 不存在' });
    }

    // -------- 静态资源 --------
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' });
      return res.end('405 - 方法不允许');
    }
    const filePath = S.safeResolveStatic(pathname, S.PUBLIC_DIR);
    if (!filePath) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('400 - 非法路径');
    }
    return S.sendStatic(res, filePath, S.PUBLIC_DIR);
  } catch (topErr) {
    console.error('[user-server] 未捕获异常：', topErr);
    try {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, msg: '服务器异常：' + (topErr && topErr.message || '') }));
    } catch (_) {}
  }
});

// 启动
server.listen(PORT, HOST, () => {
  console.log('');
  console.log('==============================================');
  console.log('   HireMe AI 面试助手 · 用户端服务已启动');
  console.log('==============================================');
  console.log(`   用户端：   http://localhost:${PORT}`);
  try {
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const n of (nets[name] || [])) {
        if (n.family === 'IPv4' && !n.internal) {
          console.log(`   局域网：   http://${n.address}:${PORT}`);
        }
      }
    }
  } catch (_) {}
  console.log(`   数据目录：${S.DATA_ROOT}`);
  console.log('   停止：Ctrl + C');
  console.log('==============================================');
});

process.on('uncaughtException', (e) => {
  console.error('[user-server] uncaughtException：', e.message, e.stack);
});
process.on('unhandledRejection', (e) => {
  console.error('[user-server] unhandledRejection：', e && e.message ? e.message : e);
});