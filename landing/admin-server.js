/**
 * landing/admin-server.js —— 管理员端独立 HTTP 服务
 *
 * 职责：
 *   1. 静态托管 landing/public/admin.html（仅管理后台页面）
 *   2. 处理 /api/auth/*（管理员登录/登出/me）
 *   3. 处理 /api/admin/*（总览/用户管理/套餐管理/调账等）
 *
 * 启动：
 *   node admin-server.js   # 监听 http://localhost:3001
 */
'use strict';

const http  = require('http');
const os    = require('os');
const urlLib = require('url');
const crypto = require('crypto');

/** 引入共享模块 */
const S = require('./shared.js');

const PORT = S.ADMIN_PORT;
const HOST = process.env.LANDING_HOST || '0.0.0.0';

// ============================================================
// 管理员专用 API：/api/auth/*（管理员也需要登录）
// ============================================================

/**
 * /api/auth/* 统一入口（管理员端用的认证接口）
 */
async function handleAuthApi(ctx, req, res) {
  const { method, pathname, body } = ctx;

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

      // 权限分离：非管理员账号不允许登录管理后台
      if (!isAdmin) {
        return S.sendJSON(res, 403, {
          ok: false,
          msg: '此账号无管理员权限，请从用户端登录',
          code: 'NOT_ADMIN',
          userUrl: 'http://localhost:3000',
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
      console.error('[admin-server][login] 异常：', e);
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
      console.error('[admin-server][me] 异常：', e);
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
      console.error('[admin-server][logout] 异常：', e);
      return S.sendJSON(res, 500, { ok: false, msg: '服务器异常' });
    }
  }

  return S.sendJSON(res, 404, { ok: false, msg: 'API 不存在' });
}

// ============================================================
// 管理后台 API
// ============================================================

/**
 * /api/admin/* 统一入口
 */
async function handleAdminApi({ method, pathname, body, query }, req, res) {
  const admin = await S._requireAdmin(req, res);
  if (!admin) return;

  // ---------- GET /api/admin/overview 总览看板 ----------
  if (method === 'GET' && pathname === '/api/admin/overview') {
    try {
      const now = Date.now();
      const DAY = 24 * 3600 * 1000;

      // 从 SQLite 查询账号统计
      const accounts = S.DAL.listAllAccounts('', 10000, 0);
      let adminCount = 0, disabledCount = 0;
      let gBalance = 0, gTotalRecharged = 0, gTotalConsumed = 0;
      for (const a of accounts) {
        if (a.isAdmin) adminCount++;
        if (a.isDisabled) disabledCount++;
        gBalance += a.credits.balance;
        gTotalRecharged += a.credits.totalRecharged;
        gTotalConsumed += a.credits.totalConsumed;
      }

      // 从 SQLite 查询最近30天流水数
      const recent30FlowCount = S.DAL.countFlowsSince(now - 30 * DAY);

      // 从 SQLite 查询订单统计
      const allOrders = S.DAL.listAllOrders(10000, 0);
      let paidOrderCount = 0, paidAmountCents = 0, paidCreditsSum = 0;
      for (const o of allOrders) {
        if (o.status !== 'paid') continue;
        paidOrderCount++;
        paidAmountCents += (o.priceCents || 0);
        paidCreditsSum += (o.paidCredits || 0);
      }

      return S.sendJSON(res, 200, {
        ok: true,
        overview: {
          accounts: { total: accounts.length, admins: adminCount, disabled: disabledCount },
          credits:  { totalBalance: gBalance, totalRecharged: gTotalRecharged, totalConsumed: gTotalConsumed },
          orders:   { total: allOrders.length, paid: paidOrderCount,
                      paidAmountCents, paidAmountYuan: Number((paidAmountCents / 100).toFixed(2)),
                      paidCreditsSum },
          flows30:  recent30FlowCount,
          generatedAt: now,
        },
      });
    } catch (e) {
      console.error('[admin][overview] 异常：', e);
      return S.sendJSON(res, 500, { ok: false, msg: '服务器异常：' + (e.message || '') });
    }
  }

  // ---------- GET /api/admin/accounts 账号列表 ----------
  if (method === 'GET' && pathname === '/api/admin/accounts') {
    try {
      const kw = String((query && query.keyword) || '').trim();
      const limit = Math.min(500, Math.max(1, Number((query && query.limit) || 200)));
      const offset = Number((query && query.offset) || 0);
      // 从 SQLite 查询账号列表（支持搜索 + 分页）
      const items = S.DAL.listAllAccounts(kw, limit, offset);
      const total = S.DAL.countAllAccounts(kw);
      return S.sendJSON(res, 200, { ok: true, total, items });
    } catch (e) {
      console.error('[admin][accounts] 异常：', e);
      return S.sendJSON(res, 500, { ok: false, msg: '服务器异常：' + (e.message || '') });
    }
  }

  // ---------- POST /api/admin/accounts/:id/adjust 手工调账 ----------
  if (method === 'POST' && pathname.startsWith('/api/admin/accounts/') && pathname.endsWith('/adjust')) {
    try {
      const prefix = '/api/admin/accounts/';
      const targetId = pathname.substring(prefix.length, pathname.length - '/adjust'.length);
      const accountsDoc = S._readAccountsRawSafe();
      const accountMap = (accountsDoc && (accountsDoc.accounts || accountsDoc.accountsById)) || {};
      const targetAcc = accountMap[targetId];
      if (!targetAcc) return S.sendJSON(res, 404, { ok: false, msg: '目标账号不存在', code: 'NOT_FOUND' });

      const delta  = Number((body && body.delta) ?? (body && body.credits));
      const reason = String((body && body.reason) || '').trim().slice(0, 200);
      if (!Number.isSafeInteger(delta) || delta === 0) {
        return S.sendJSON(res, 400, { ok: false, msg: 'delta 必须是非零整数', code: 'BAD_DELTA' });
      }
      if (!reason) {
        return S.sendJSON(res, 400, { ok: false, msg: '请填写调整原因（reason，用于审计）', code: 'REASON_REQUIRED' });
      }

      // 使用 DAL 事务：原子更新余额 + 写流水（含操作者审计字段）
      const operatorEmail = admin && admin.account && (admin.account.email || admin.account.emailHash || admin.accountId);
      const result = S.adminAdjust({
        targetAccountId: targetId,
        delta,
        reason,
        operatorAccountId: admin.accountId,
        operatorEmail,
      });

      if (result.insufficient) {
        return S.sendJSON(res, 400, {
          ok: false, code: 'INSUFFICIENT_CREDITS',
          msg: `调整失败：当前余额 ${result.balance}，要扣 ${-delta}，扣完后会变成负数。请先核实`,
          balance: result.balance, delta,
        });
      }

      return S.sendJSON(res, 200, {
        ok: true, msg: '调整成功',
        delta, balance: result.balance,
        totalRecharged: result.totalRecharged, totalConsumed: result.totalConsumed,
        flowId: result.flowId,
      });
    } catch (e) {
      console.error('[admin][adjust] 异常：', e);
      return S.sendJSON(res, 500, { ok: false, msg: '调整失败：' + (e.message || '') });
    }
  }

  // ---------- GET /api/admin/accounts/:id/flows ----------
  if (method === 'GET' && pathname.startsWith('/api/admin/accounts/') && pathname.endsWith('/flows')) {
    try {
      const targetId = pathname.substring('/api/admin/accounts/'.length, pathname.length - '/flows'.length);
      const fromMonth = query && typeof query.fromMonth === 'string' ? query.fromMonth : null;
      const toMonth   = query && typeof query.toMonth   === 'string' ? query.toMonth   : null;
      const type      = query && typeof query.type      === 'string' ? query.type      : null;
      const bizType   = query && typeof query.bizType   === 'string' ? query.bizType   : null;
      const limit     = Math.min(500, Math.max(1, Number(query && query.limit) || 200));
      const desc      = Number(query && query.desc) !== 0;
      const raw = S.listCreditFlows(targetId, fromMonth, toMonth, { type, bizType, limit, desc });
      const safe = raw.map((f) => ({
        flowId:         f.flowId,
        type:           f.type,
        bizType:        f.bizType,
        bizId:          f.bizId || '',
        delta:          Number(f.delta)  || 0,
        balanceAfter:   Number(f.balanceAfter) || 0,
        desc:           f.desc || '',
        operatorEmail:  f.operatorEmail || undefined,
        month:          f.month || '',
        createdAt:      Number(f.createdAt) || 0,
      }));
      return S.sendJSON(res, 200, { ok: true, accountId: targetId, items: safe, total: safe.length });
    } catch (e) {
      console.error('[admin][accountFlows] 异常：', e);
      return S.sendJSON(res, 500, { ok: false, msg: '服务器异常：' + (e.message || '') });
    }
  }

  // ---------- GET /api/admin/accounts/:id/orders ----------
  if (method === 'GET' && pathname.startsWith('/api/admin/accounts/') && pathname.endsWith('/orders')) {
    try {
      const targetId = pathname.substring('/api/admin/accounts/'.length, pathname.length - '/orders'.length);
      const orders = S.listOrdersByAccount(targetId, (query && query.limit) || 50);
      return S.sendJSON(res, 200, { ok: true, accountId: targetId, items: orders });
    } catch (e) {
      console.error('[admin][accountOrders] 异常：', e);
      return S.sendJSON(res, 500, { ok: false, msg: '服务器异常：' + (e.message || '') });
    }
  }

  // ---------- GET /api/admin/accounts/:id 单账号详情 ----------
  if (method === 'GET' && pathname.startsWith('/api/admin/accounts/')) {
    try {
      const targetId = pathname.substring('/api/admin/accounts/'.length);
      // 从 SQLite 查询账号信息
      const a = S.DAL.getAccountById(targetId);
      if (!a) return S.sendJSON(res, 404, { ok: false, msg: '账号不存在', code: 'NOT_FOUND' });
      // 从 SQLite 查询积分余额
      const bal = S.DAL.readBalance(targetId) || { balance: 0, totalRecharged: 0, totalConsumed: 0 };
      return S.sendJSON(res, 200, {
        ok: true,
        account: {
          accountId: a.accountId, email: a.displayEmail,
          displayName: a.displayName, avatar: a.avatar || '',
          isAdmin: a.isAdmin,
          isDisabled: a.isDisabled,
          disabledReason: a.disabledReason,
          inviteCode: a.extId || '',
          createdAt: a.createdAt, lastLoginTs: a.lastLoginTs,
        },
        credits: {
          balance: bal.balance || 0,
          totalRecharged: bal.totalRecharged || 0,
          totalConsumed: bal.totalConsumed || 0,
        },
      });
    } catch (e) {
      console.error('[admin][accountDetail] 异常：', e);
      return S.sendJSON(res, 500, { ok: false, msg: '服务器异常：' + (e.message || '') });
    }
  }

  // ---------- GET /api/admin/orders 全局订单列表 ----------
  if (method === 'GET' && pathname === '/api/admin/orders') {
    try {
      const limit = Math.min(500, Number(query && query.limit) || 50);
      const offset = Number(query && query.offset) || 0;
      const items = S.DAL.listAllOrders(limit, offset);
      const total = S.DAL.countAllOrders();
      return S.sendJSON(res, 200, { ok: true, total, items });
    } catch (e) {
      console.error('[admin][orders] 异常：', e);
      return S.sendJSON(res, 500, { ok: false, msg: '服务器异常：' + (e.message || '') });
    }
  }

  // ---------- GET /api/admin/packages 全部套餐（含下架） ----------
  if (method === 'GET' && pathname === '/api/admin/packages') {
    return S.sendJSON(res, 200, { ok: true, items: S.DAL.listAllPackages() });
  }

  // ---------- POST /api/admin/packages/create 新增套餐 ----------
  if (method === 'POST' && pathname === '/api/admin/packages/create') {
    try {
      const data = {
        packageId: String((body && body.packageId) || '').trim(),
        title: String((body && body.title) || '').trim(),
        credits: Number(body && body.credits) || 0,
        bonusCredits: Number(body && body.bonusCredits) || 0,
        priceCents: Math.round((Number(body && body.priceYuan) || 0) * 100),
        tag: String((body && body.tag) || '').trim(),
        description: String((body && body.description) || '').trim(),
        isActive: body && body.isActive === false ? false : true,
        sortOrder: Number(body && body.sortOrder) || 0,
      };
      if (!data.title) return S.sendJSON(res, 400, { ok: false, msg: '请填写套餐标题' });
      if (data.credits <= 0) return S.sendJSON(res, 400, { ok: false, msg: '积分数必须大于 0' });
      if (data.priceCents <= 0) return S.sendJSON(res, 400, { ok: false, msg: '价格必须大于 0' });

      const r = S.DAL.insertPackage(data);
      if (!r.ok) return S.sendJSON(res, 400, { ok: false, msg: '套餐ID已存在', code: r.error });
      return S.sendJSON(res, 201, { ok: true, msg: '套餐创建成功', packageId: r.packageId });
    } catch (e) {
      console.error('[admin][pkg-create] 异常：', e);
      return S.sendJSON(res, 500, { ok: false, msg: '创建失败：' + (e.message || '') });
    }
  }

  // ---------- POST /api/admin/packages/:id/update 更新套餐 ----------
  if (method === 'POST' && pathname.startsWith('/api/admin/packages/') && pathname.endsWith('/update')) {
    try {
      const pkgId = pathname.substring('/api/admin/packages/'.length, pathname.length - '/update'.length);
      const data = {
        title: String((body && body.title) || '').trim(),
        credits: Number(body && body.credits) || 0,
        bonusCredits: Number(body && body.bonusCredits) || 0,
        priceCents: Math.round((Number(body && body.priceYuan) || 0) * 100),
        tag: String((body && body.tag) || '').trim(),
        description: String((body && body.description) || '').trim(),
        isActive: body && body.isActive === false ? false : true,
        sortOrder: Number(body && body.sortOrder) || 0,
      };
      const r = S.DAL.updatePackage(pkgId, data);
      if (!r.ok) return S.sendJSON(res, 404, { ok: false, msg: '套餐不存在' });
      return S.sendJSON(res, 200, { ok: true, msg: '套餐更新成功' });
    } catch (e) {
      console.error('[admin][pkg-update] 异常：', e);
      return S.sendJSON(res, 500, { ok: false, msg: '更新失败：' + (e.message || '') });
    }
  }

  // ---------- POST /api/admin/packages/:id/delete 删除套餐 ----------
  if (method === 'POST' && pathname.startsWith('/api/admin/packages/') && pathname.endsWith('/delete')) {
    try {
      const pkgId = pathname.substring('/api/admin/packages/'.length, pathname.length - '/delete'.length);
      const r = S.DAL.deletePackage(pkgId);
      if (!r.ok) return S.sendJSON(res, 404, { ok: false, msg: '套餐不存在' });
      return S.sendJSON(res, 200, { ok: true, msg: '套餐已删除' });
    } catch (e) {
      console.error('[admin][pkg-delete] 异常：', e);
      return S.sendJSON(res, 500, { ok: false, msg: '删除失败：' + (e.message || '') });
    }
  }

  // ---------- POST /api/admin/accounts/:id/disable 禁用/启用账号 ----------
  if (method === 'POST' && pathname.startsWith('/api/admin/accounts/') && pathname.endsWith('/disable')) {
    try {
      const targetId = pathname.substring('/api/admin/accounts/'.length, pathname.length - '/disable'.length);
      const disabled = !!(body && body.disabled);
      const reason = String((body && body.reason) || '').trim();
      if (disabled && !reason) return S.sendJSON(res, 400, { ok: false, msg: '请填写禁用原因' });

      // 不能禁用自己
      if (targetId === admin.accountId) return S.sendJSON(res, 400, { ok: false, msg: '不能禁用自己的账号' });

      const r = S.DAL.toggleAccountDisabled(targetId, disabled, reason);
      if (!r.ok) return S.sendJSON(res, 404, { ok: false, msg: '账号不存在' });
      return S.sendJSON(res, 200, { ok: true, msg: disabled ? '账号已禁用' : '账号已启用' });
    } catch (e) {
      console.error('[admin][disable] 异常：', e);
      return S.sendJSON(res, 500, { ok: false, msg: '操作失败：' + (e.message || '') });
    }
  }

  // ---------- POST /api/admin/accounts/:id/reset-password 重置密码 ----------
  if (method === 'POST' && pathname.startsWith('/api/admin/accounts/') && pathname.endsWith('/reset-password')) {
    try {
      const targetId = pathname.substring('/api/admin/accounts/'.length, pathname.length - '/reset-password'.length);
      const newPassword = String((body && body.newPassword) || '');
      if (!newPassword || newPassword.length < 6) return S.sendJSON(res, 400, { ok: false, msg: '新密码至少 6 位' });

      const r = S.DAL.adminResetPassword(targetId, newPassword);
      if (!r.ok) return S.sendJSON(res, 404, { ok: false, msg: '账号不存在' });
      return S.sendJSON(res, 200, { ok: true, msg: '密码已重置' });
    } catch (e) {
      console.error('[admin][reset-pw] 异常：', e);
      return S.sendJSON(res, 500, { ok: false, msg: '操作失败：' + (e.message || '') });
    }
  }

  // ---------- POST /api/admin/accounts/:id/set-admin 设置管理员 ----------
  if (method === 'POST' && pathname.startsWith('/api/admin/accounts/') && pathname.endsWith('/set-admin')) {
    try {
      const targetId = pathname.substring('/api/admin/accounts/'.length, pathname.length - '/set-admin'.length);
      const isAdmin = !!(body && body.isAdmin);
      // 不能取消自己的管理员权限
      if (targetId === admin.accountId && !isAdmin) return S.sendJSON(res, 400, { ok: false, msg: '不能取消自己的管理员权限' });

      const r = S.DAL.setAdmin(targetId, isAdmin);
      if (!r.ok) return S.sendJSON(res, 404, { ok: false, msg: '账号不存在' });
      return S.sendJSON(res, 200, { ok: true, msg: isAdmin ? '已设为管理员' : '已取消管理员' });
    } catch (e) {
      console.error('[admin][set-admin] 异常：', e);
      return S.sendJSON(res, 500, { ok: false, msg: '操作失败：' + (e.message || '') });
    }
  }

  // ============================================================
  // 兑换码管理
  // ============================================================

  // ---------- POST /api/admin/redeem/create 批量生成兑换码 ----------
  if (method === 'POST' && pathname === '/api/admin/redeem/create') {
    try {
      const count = Math.min(500, Math.max(1, Number(body && body.count) || 1));
      const credits = Number(body && body.credits) || 0;
      const expireDays = Math.max(0, Number(body && body.expireDays) || 0);
      const note = String((body && body.note) || '').slice(0, 200);

      if (credits <= 0) return S.sendJSON(res, 400, { ok: false, msg: '积分数必须大于 0' });
      if (credits > 100000) return S.sendJSON(res, 400, { ok: false, msg: '单个兑换码积分不能超过 10 万' });

      const r = S.DAL.generateRedeemCodes({
        count, credits, expireDays, note, createdBy: admin.accountId,
      });
      return S.sendJSON(res, 201, {
        ok: true, msg: `成功生成 ${r.count} 个兑换码`,
        batchId: r.batchId, codes: r.codes, count: r.count,
      });
    } catch (e) {
      console.error('[admin][redeem-create] 异常：', e);
      return S.sendJSON(res, 500, { ok: false, msg: '生成失败：' + (e.message || '') });
    }
  }

  // ---------- GET /api/admin/redeem/list 兑换码列表 ----------
  if (method === 'GET' && pathname === '/api/admin/redeem/list') {
    try {
      const limit = Math.min(500, Math.max(1, Number(query.limit) || 50));
      const page = Math.max(1, Number(query.page) || 1);
      const offset = (page - 1) * limit;
      const status = String(query.status || '').trim();  // '' | 'unused' | 'used' | 'expired'
      const batchId = String(query.batchId || '').trim();

      const items = S.DAL.listAllRedeemCodes({ status, batchId, limit, offset });
      const total = S.DAL.countAllRedeemCodes({ status, batchId });
      return S.sendJSON(res, 200, { ok: true, total, page, limit, items });
    } catch (e) {
      console.error('[admin][redeem-list] 异常：', e);
      return S.sendJSON(res, 500, { ok: false, msg: '查询失败：' + (e.message || '') });
    }
  }

  // ---------- GET /api/admin/redeem/stats 兑换码状态统计 ----------
  if (method === 'GET' && pathname === '/api/admin/redeem/stats') {
    try {
      const stats = S.DAL.getRedeemStats();
      return S.sendJSON(res, 200, { ok: true, stats });
    } catch (e) {
      console.error('[admin][redeem-stats] 异常：', e);
      return S.sendJSON(res, 500, { ok: false, msg: '统计失败：' + (e.message || '') });
    }
  }

  // ---------- POST /api/admin/redeem/delete 删除兑换码 ----------
  if (method === 'POST' && pathname === '/api/admin/redeem/delete') {
    try {
      const code = String((body && body.code) || '').trim();
      if (!code) return S.sendJSON(res, 400, { ok: false, msg: '请填写兑换码' });
      const r = S.DAL.deleteRedeemCode(code);
      if (!r.ok) return S.sendJSON(res, 400, { ok: false, msg: '删除失败：兑换码不存在或已被使用' });
      return S.sendJSON(res, 200, { ok: true, msg: '已删除兑换码 ' + code });
    } catch (e) {
      console.error('[admin][redeem-delete] 异常：', e);
      return S.sendJSON(res, 500, { ok: false, msg: '删除失败：' + (e.message || '') });
    }
  }

  // ============================================================
  // 公告管理
  // ============================================================

  // ---------- POST /api/admin/news/create 新增公告 ----------
  if (method === 'POST' && pathname === '/api/admin/news/create') {
    try {
      const title = String((body && body.title) || '').trim();
      const content = String((body && body.content) || '');
      if (!title) return S.sendJSON(res, 400, { ok: false, msg: '请填写标题' });
      if (!content) return S.sendJSON(res, 400, { ok: false, msg: '请填写正文' });
      if (title.length > 100) return S.sendJSON(res, 400, { ok: false, msg: '标题最多 100 字' });

      const r = S.DAL.createNews({
        title, content,
        category: body && body.category,
        isPinned: !!(body && body.isPinned),
        isPublished: body && body.isPublished === false ? false : true,
        createdBy: admin.accountId,
      });
      return S.sendJSON(res, 201, { ok: true, msg: '公告已创建', newsId: r.newsId });
    } catch (e) {
      console.error('[admin][news-create] 异常：', e);
      return S.sendJSON(res, 500, { ok: false, msg: '创建失败：' + (e.message || '') });
    }
  }

  // ---------- POST /api/admin/news/update 更新公告 ----------
  if (method === 'POST' && pathname === '/api/admin/news/update') {
    try {
      const newsId = String((body && body.newsId) || '').trim();
      if (!newsId) return S.sendJSON(res, 400, { ok: false, msg: '请填写公告ID' });
      const title = String((body && body.title) || '').trim();
      const content = String((body && body.content) || '');
      if (!title) return S.sendJSON(res, 400, { ok: false, msg: '请填写标题' });
      if (!content) return S.sendJSON(res, 400, { ok: false, msg: '请填写正文' });

      const r = S.DAL.updateNews(newsId, {
        title, content,
        category: body && body.category,
        isPinned: !!(body && body.isPinned),
        isPublished: body && body.isPublished === false ? false : true,
      });
      if (!r.ok) return S.sendJSON(res, 404, { ok: false, msg: '公告不存在' });
      return S.sendJSON(res, 200, { ok: true, msg: '公告已更新' });
    } catch (e) {
      console.error('[admin][news-update] 异常：', e);
      return S.sendJSON(res, 500, { ok: false, msg: '更新失败：' + (e.message || '') });
    }
  }

  // ---------- POST /api/admin/news/delete 删除公告 ----------
  if (method === 'POST' && pathname === '/api/admin/news/delete') {
    try {
      const newsId = String((body && body.newsId) || '').trim();
      if (!newsId) return S.sendJSON(res, 400, { ok: false, msg: '请填写公告ID' });
      const r = S.DAL.deleteNews(newsId);
      if (!r.ok) return S.sendJSON(res, 404, { ok: false, msg: '公告不存在' });
      return S.sendJSON(res, 200, { ok: true, msg: '公告已删除' });
    } catch (e) {
      console.error('[admin][news-delete] 异常：', e);
      return S.sendJSON(res, 500, { ok: false, msg: '删除失败：' + (e.message || '') });
    }
  }

  // ---------- GET /api/admin/news/list 公告列表（含草稿） ----------
  if (method === 'GET' && pathname === '/api/admin/news/list') {
    try {
      const limit = Math.min(200, Math.max(1, Number(query.limit) || 50));
      const page = Math.max(1, Number(query.page) || 1);
      const offset = (page - 1) * limit;
      const items = S.DAL.listAllNews(limit, offset);
      const total = S.DAL.countAllNews();
      return S.sendJSON(res, 200, { ok: true, total, page, limit, items });
    } catch (e) {
      console.error('[admin][news-list] 异常：', e);
      return S.sendJSON(res, 500, { ok: false, msg: '查询失败：' + (e.message || '') });
    }
  }

  // ---------- GET /api/admin/news/get?newsId=xxx 公告详情 ----------
  if (method === 'GET' && pathname === '/api/admin/news/get') {
    try {
      const newsId = String(query.newsId || '').trim();
      if (!newsId) return S.sendJSON(res, 400, { ok: false, msg: '请填写 newsId' });
      const news = S.DAL.getNewsById(newsId);
      if (!news) return S.sendJSON(res, 404, { ok: false, msg: '公告不存在' });
      return S.sendJSON(res, 200, { ok: true, news });
    } catch (e) {
      console.error('[admin][news-get] 异常：', e);
      return S.sendJSON(res, 500, { ok: false, msg: '查询失败：' + (e.message || '') });
    }
  }

  return S.sendJSON(res, 404, { ok: false, msg: '管理端 API 不存在' });
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
      if (pathname.startsWith('/api/admin/')) {
        return await handleAdminApi({ method, pathname, body, query }, req, res);
      }
      return S.sendJSON(res, 404, { ok: false, msg: 'API 不存在' });
    }

    // -------- 静态资源（仅 admin.html + 引用的静态文件） --------
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' });
      return res.end('405 - 方法不允许');
    }
    const filePath = S.safeResolveStatic(pathname, S.PUBLIC_DIR);
    if (!filePath) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('400 - 非法路径');
    }
    // 管理端只允许访问 admin.html 及其依赖的静态资源
    const relPath = filePath.substring(S.PUBLIC_DIR.length + 1).replace(/\\/g, '/');
    const isAdminPage = relPath === 'admin.html' || relPath === '' || relPath === 'index.html';
    const isStaticAsset = /\.(css|js|png|jpg|jpeg|gif|svg|ico|woff2?|ttf)$/i.test(relPath);
    if (!isAdminPage && !isStaticAsset) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('403 - 管理员端仅可访问管理后台页面');
    }
    // 默认路径重定向到 admin.html
    if (relPath === '' || relPath === 'index.html') {
      return S.sendStatic(res, require('path').join(S.PUBLIC_DIR, 'admin.html'), S.PUBLIC_DIR);
    }
    return S.sendStatic(res, filePath, S.PUBLIC_DIR);
  } catch (topErr) {
    console.error('[admin-server] 未捕获异常：', topErr);
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
  console.log('   HireMe AI 面试助手 · 管理员端服务已启动');
  console.log('==============================================');
  console.log(`   管理端：   http://localhost:${PORT}`);
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
  console.log('   管理员账号：15376110673@163.com / 123456');
  console.log('   停止：Ctrl + C');
  console.log('==============================================');
});

process.on('uncaughtException', (e) => {
  console.error('[admin-server] uncaughtException：', e.message, e.stack);
});
process.on('unhandledRejection', (e) => {
  console.error('[admin-server] unhandledRejection：', e && e.message ? e.message : e);
});