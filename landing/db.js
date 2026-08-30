'use strict';

/**
 * landing/db.js —— SQLite 数据库初始化与连接管理模块
 *
 * 职责：
 *   1. 创建/打开 SQLite 数据库文件（WAL 模式，支持多进程并发读写）
 *   2. 执行建表 SQL（accounts / credit_balances / orders / credit_flows / web_sessions / packages）
 *   3. 创建所有索引
 *   4. 导出单例 db 实例供 shared.js / user-server.js / admin-server.js 共享
 *
 * 设计原则：
 *   - 使用 better-sqlite3 同步驱动，匹配现有同步代码风格
 *   - WAL 模式：读不阻塞写、写不阻塞读，解决跨进程并发问题
 *   - 外键约束：删除账号时级联清理余额/订单/流水/会话
 *   - 所有时间戳用 INTEGER 存毫秒，与现有 JSON 数据兼容
 *
 * 使用方式：
 *   const { db, DB_PATH } = require('./db.js');
 *   const row = db.prepare('SELECT * FROM accounts WHERE account_id = ?').get(id);
 */

const path = require('path');
const fs   = require('fs');

// ============================================================
// 🟢 统一数据源：三端共享项目根/data/hireme.db
//    路径解析使用 services/common-paths.js，保证桌面端/Landing/管理员端 三端一致
// ============================================================
const {
  DATA_ROOT,
  HIREME_DB_PATH,
  openUnifiedDatabase,
} = require('../services/common-paths.js');
const DB_PATH = HIREME_DB_PATH;

// data 目录存在性由 common-paths.js 保证（require 时就 mkdir）

// ============================================================
// 创建数据库连接（WAL + busy_timeout 等 PRAGMA 统一由 openUnifiedDatabase 处理）
// ============================================================
const Database = require('better-sqlite3');
const { db: _rawDb, ready } = openUnifiedDatabase(Database);

// 为兼容旧代码命名：还是叫 db
const db = _rawDb;
if (!ready) {
  throw new Error('[landing/db.js] ❌ openUnifiedDatabase 打开 hireme.db 失败，三端统一数据库未就绪');
}

// 额外 PRAGMA（只在 Landing 端需要：内存映射 256MB）
db.pragma('mmap_size = 268435456');

console.log(`[db] ✅ Landing 端已连接统一数据库：${DB_PATH} (WAL 模式)`);

// ============================================================
// 建表 SQL
// ============================================================

const CREATE_TABLES = `
-- ============================================================
-- 1. 用户账号表（替代 accounts.json）
-- ============================================================
CREATE TABLE IF NOT EXISTS accounts (
    account_id        TEXT PRIMARY KEY,            -- 账号ID，如 'acc_a1b2c3d4e5f6'
    normalized_email  TEXT NOT NULL UNIQUE,         -- 小写邮箱，用于唯一索引和登录查找
    display_email     TEXT NOT NULL,               -- 保留原始大小写的邮箱
    display_name      TEXT NOT NULL DEFAULT '',    -- 用户昵称
    avatar            TEXT NOT NULL DEFAULT '',    -- 头像URL
    is_admin          INTEGER NOT NULL DEFAULT 0,  -- 是否管理员（0=否，1=是）

    -- 密码哈希字段（PBKDF2）
    pwd_algo          TEXT NOT NULL DEFAULT 'sha256',  -- 哈希算法
    pwd_iter          INTEGER NOT NULL DEFAULT 100000,  -- 迭代次数
    pwd_salt          TEXT NOT NULL,               -- Salt（base64编码）
    pwd_hash          TEXT NOT NULL,               -- 密码哈希值（base64编码）

    -- 密码重置码（可选）
    reset_code        TEXT,                        -- 重置码，NULL表示无
    reset_expire_at   INTEGER,                     -- 重置码过期时间（毫秒时间戳）

    -- 外部ID（预留，从宣传网站同步的账号）
    ext_id            TEXT,

    created_at        INTEGER NOT NULL,             -- 创建时间（毫秒时间戳）
    last_login_ts     INTEGER NOT NULL DEFAULT 0,   -- 最近登录时间（毫秒时间戳）

    CHECK (is_admin IN (0, 1))
);

-- 索引：按邮箱快速查找（登录时使用，normalized_email 已有 UNIQUE 隐式索引）
-- 按管理员标记筛选（管理后台统计）
CREATE INDEX IF NOT EXISTS idx_accounts_is_admin ON accounts(is_admin);
-- 按创建时间排序（管理后台账号列表分页）
CREATE INDEX IF NOT EXISTS idx_accounts_created_at ON accounts(created_at DESC);

-- ============================================================
-- 2. 积分余额表（替代 credits.json）
-- ============================================================
CREATE TABLE IF NOT EXISTS credit_balances (
    account_id        TEXT PRIMARY KEY,             -- 账号ID（外键关联 accounts）
    balance           INTEGER NOT NULL DEFAULT 0,   -- 当前可用余额
    total_recharged   INTEGER NOT NULL DEFAULT 0,  -- 累计充值总额
    total_consumed    INTEGER NOT NULL DEFAULT 0,  -- 累计消耗总额
    updated_at        INTEGER NOT NULL DEFAULT 0,  -- 最后更新时间（毫秒时间戳）

    FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE,

    -- 约束：余额和累计值不能为负
    CHECK (balance >= 0),
    CHECK (total_recharged >= 0),
    CHECK (total_consumed >= 0)
);

-- PRIMARY KEY 已覆盖按 account_id 查询，无需额外索引

-- ============================================================
-- 3. 充值订单表（替代 orders.json）
-- ============================================================
CREATE TABLE IF NOT EXISTS orders (
    order_id          TEXT PRIMARY KEY,             -- 订单ID，如 'ORLX...'
    account_id        TEXT NOT NULL,               -- 所属账号ID（外键）
    package_id        TEXT NOT NULL,               -- 套餐ID，如 'pro'/'elite'/'max'
    package_name      TEXT NOT NULL DEFAULT '',     -- 套餐名称（冗余，方便查询展示）
    credits           INTEGER NOT NULL DEFAULT 0,   -- 套餐基础积分
    bonus             INTEGER NOT NULL DEFAULT 0,   -- 赠送积分
    price_cents       INTEGER NOT NULL DEFAULT 0,   -- 价格（分）
    status            TEXT NOT NULL DEFAULT 'pending', -- 状态：pending|paid|cancelled
    channel           TEXT NOT NULL DEFAULT '',     -- 支付渠道：mock|alipay|wechat
    created_at        INTEGER NOT NULL,              -- 创建时间
    paid_at           INTEGER NOT NULL DEFAULT 0,   -- 支付时间
    cancelled_at      INTEGER NOT NULL DEFAULT 0,   -- 取消时间
    meta              TEXT,                           -- 附加信息JSON（如 userAgent）

    FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE,

    CHECK (status IN ('pending', 'paid', 'cancelled')),
    CHECK (credits >= 0),
    CHECK (bonus >= 0),
    CHECK (price_cents >= 0)
);

-- 索引：按账号查询订单列表（控制台"我的订单"，按创建时间倒序）
CREATE INDEX IF NOT EXISTS idx_orders_account_created ON orders(account_id, created_at DESC);
-- 按状态筛选（管理后台"已付款订单"统计）
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
-- 按支付时间排序（管理后台收入统计）
CREATE INDEX IF NOT EXISTS idx_orders_paid_at ON orders(paid_at DESC);

-- ============================================================
-- 4. 积分流水表（替代 credit-flows/YYYY-MM.json）
--    取消按月分文件，改为统一表 + 月份索引
-- ============================================================
CREATE TABLE IF NOT EXISTS credit_flows (
    flow_id           TEXT PRIMARY KEY,             -- 流水ID，如 'fl_a1b2c3...'
    account_id        TEXT NOT NULL,               -- 所属账号ID（外键）
    type              TEXT NOT NULL,               -- 类型：charge|consume|refund|reward|adjust
    biz_type          TEXT NOT NULL DEFAULT '',     -- 业务类型：package|copilot|mock|resume|admin_manual
    biz_id            TEXT NOT NULL DEFAULT '',     -- 关联业务ID（如订单号）
    amount            INTEGER NOT NULL DEFAULT 0,  -- 变动金额（正数）
    delta             INTEGER NOT NULL,             -- 实际变动（正=充值，负=消耗）
    balance_after     INTEGER NOT NULL DEFAULT 0,  -- 变动后余额（用于审计对账）
    description       TEXT NOT NULL DEFAULT '',     -- 描述文字
    meta              TEXT,                          -- 附加JSON（如套餐详情、渠道信息）
    month_key         TEXT NOT NULL,                -- 月份标识 'YYYY-MM'

    -- 管理员调账专用字段
    operator_account_id TEXT,                        -- 操作者账号ID
    operator_email      TEXT,                        -- 操作者邮箱

    created_at        INTEGER NOT NULL,              -- 创建时间（毫秒时间戳）

    FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE,

    CHECK (type IN ('charge', 'consume', 'refund', 'reward', 'adjust'))
);

-- ★ 核心索引：按账号+时间倒序查询流水（控制台"最近活动"、管理后台"用户流水"）
CREATE INDEX IF NOT EXISTS idx_flows_account_time ON credit_flows(account_id, created_at DESC);
-- 按月份筛选（保留按月查询的兼容性）
CREATE INDEX IF NOT EXISTS idx_flows_month ON credit_flows(month_key);
-- 按类型筛选（管理后台统计"充值/消耗/调账"）
CREATE INDEX IF NOT EXISTS idx_flows_type ON credit_flows(type);
-- 按业务类型筛选（如只看 copilot 消耗记录）
CREATE INDEX IF NOT EXISTS idx_flows_biz_type ON credit_flows(biz_type);
-- 按创建时间排序（管理后台近30天流水统计）
CREATE INDEX IF NOT EXISTS idx_flows_created_at ON credit_flows(created_at);

-- ============================================================
-- 5. Web 会话表（替代 web-sessions.json）
-- ============================================================
CREATE TABLE IF NOT EXISTS web_sessions (
    sid               TEXT PRIMARY KEY,             -- 会话ID 'sess_xxx'
    account_id        TEXT NOT NULL,               -- 关联账号ID（外键）
    email             TEXT NOT NULL,               -- 登录时邮箱（冗余，方便展示）
    display_name      TEXT NOT NULL DEFAULT '',     -- 昵称（冗余）
    avatar            TEXT NOT NULL DEFAULT '',     -- 头像（冗余）
    is_admin          INTEGER NOT NULL DEFAULT 0,   -- 是否管理员会话
    created_at        INTEGER NOT NULL,             -- 创建时间
    expire_at         INTEGER NOT NULL,             -- 过期时间（毫秒时间戳）

    FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE,

    CHECK (is_admin IN (0, 1))
);

-- ★ 核心索引：按过期时间清理（定时任务每10分钟扫描删除过期会话）
CREATE INDEX IF NOT EXISTS idx_sessions_expire_at ON web_sessions(expire_at);
-- 按账号查询（可选：限制单用户最大会话数）
CREATE INDEX IF NOT EXISTS idx_sessions_account_id ON web_sessions(account_id);

-- ============================================================
-- 6. 套餐配置表（替代 shared.js 中的 CREDIT_PACKAGES 硬编码常量）
--    使管理后台可以动态管理套餐，无需改代码重启
-- ============================================================
CREATE TABLE IF NOT EXISTS packages (
    package_id        TEXT PRIMARY KEY,             -- 套餐ID：pico|pro|elite|max
    title             TEXT NOT NULL,               -- 套餐标题
    credits           INTEGER NOT NULL DEFAULT 0,   -- 基础积分
    bonus_credits     INTEGER NOT NULL DEFAULT 0,   -- 赠送积分
    price_cents       INTEGER NOT NULL DEFAULT 0,   -- 价格（分）
    tag               TEXT NOT NULL DEFAULT '',     -- 标签：新手首选|最受欢迎
    description       TEXT NOT NULL DEFAULT '',     -- 描述
    is_active         INTEGER NOT NULL DEFAULT 1,   -- 是否上架（0=下架，1=上架）
    sort_order        INTEGER NOT NULL DEFAULT 0,   -- 排序权重
    created_at        INTEGER NOT NULL,             -- 创建时间
    updated_at        INTEGER NOT NULL,             -- 更新时间

    CHECK (is_active IN (0, 1)),
    CHECK (credits >= 0),
    CHECK (bonus_credits >= 0),
    CHECK (price_cents >= 0)
);

-- ============================================================
-- 7. 签到记录表（每日签到奖励积分）
--    每个账号每天只能签到一次；连续签到 7 天一个周期，奖励递增
-- ============================================================
CREATE TABLE IF NOT EXISTS checkin_records (
    record_id         TEXT PRIMARY KEY,             -- 记录ID，如 'ck_xxx'
    account_id        TEXT NOT NULL,                -- 账号ID（外键）
    checkin_date      TEXT NOT NULL,                -- 签到日期 'YYYY-MM-DD'
    checkin_day_index INTEGER NOT NULL,             -- 本周期内第几天（1-7）
    reward_credits    INTEGER NOT NULL DEFAULT 0,   -- 奖励积分数
    flow_id           TEXT,                         -- 关联的积分流水ID（type=reward, bizType=checkin）
    created_at        INTEGER NOT NULL,             -- 签到时间（毫秒时间戳）

    FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE,

    -- 每个账号每天只能签到一次（account_id + checkin_date 唯一）
    UNIQUE (account_id, checkin_date),

    CHECK (checkin_day_index >= 1 AND checkin_day_index <= 7),
    CHECK (reward_credits >= 0)
);

-- 索引：按账号查询最近签到记录（计算连续签到天数）
CREATE INDEX IF NOT EXISTS idx_checkin_account_date ON checkin_records(account_id, checkin_date DESC);

-- ============================================================
-- 8. 邀请记录表（邀请好友奖励积分）
--    每个被邀请人只能被一个人邀请（invitee_account_id UNIQUE）
-- ============================================================
CREATE TABLE IF NOT EXISTS invite_records (
    record_id          TEXT PRIMARY KEY,             -- 记录ID，如 'inv_xxx'
    inviter_account_id TEXT NOT NULL,                -- 邀请人账号ID
    invitee_account_id TEXT NOT NULL UNIQUE,         -- 被邀请人账号ID（UNIQUE保证一个人只能被邀请一次）
    invite_code        TEXT NOT NULL,                -- 使用的邀请码
    inviter_reward     INTEGER NOT NULL DEFAULT 0,   -- 邀请人奖励积分
    invitee_reward     INTEGER NOT NULL DEFAULT 0,   -- 被邀请人奖励积分
    inviter_flow_id    TEXT,                         -- 邀请人积分流水ID
    invitee_flow_id    TEXT,                         -- 被邀请人积分流水ID
    created_at         INTEGER NOT NULL,             -- 邀请时间（毫秒时间戳）

    FOREIGN KEY (inviter_account_id) REFERENCES accounts(account_id) ON DELETE CASCADE,
    FOREIGN KEY (invitee_account_id) REFERENCES accounts(account_id) ON DELETE CASCADE,

    CHECK (inviter_reward >= 0),
    CHECK (invitee_reward >= 0)
);

-- 索引：按邀请人查询其所有邀请记录（统计邀请人数、总奖励）
CREATE INDEX IF NOT EXISTS idx_invite_inviter ON invite_records(inviter_account_id, created_at DESC);

-- ============================================================
-- 9. 兑换码表（管理员发放，用户兑换积分）
--    一个兑换码只能被使用一次；过期后不可使用
-- ============================================================
CREATE TABLE IF NOT EXISTS redeem_codes (
    code          TEXT PRIMARY KEY,             -- 兑换码（大写字母+数字，如 RCXXXXXX）
    credits       INTEGER NOT NULL,             -- 兑换积分数量
    batch_id      TEXT NOT NULL DEFAULT '',     -- 批次ID（管理端批量生成时用，如 batch_xxx）
    status        TEXT NOT NULL DEFAULT 'unused', -- 状态：unused|used|expired
    created_by    TEXT NOT NULL,                -- 创建者账号ID（管理员）
    created_at    INTEGER NOT NULL,             -- 创建时间（毫秒时间戳）
    used_by       TEXT,                          -- 使用者账号ID（NULL=未使用）
    used_at       INTEGER NOT NULL DEFAULT 0,   -- 使用时间（毫秒时间戳，0=未使用）
    expire_at     INTEGER NOT NULL DEFAULT 0,   -- 过期时间（毫秒时间戳，0=永不过期）
    note          TEXT NOT NULL DEFAULT '',     -- 备注（如"新年活动"）

    FOREIGN KEY (created_by) REFERENCES accounts(account_id) ON DELETE SET NULL,
    FOREIGN KEY (used_by) REFERENCES accounts(account_id) ON DELETE SET NULL,

    CHECK (credits > 0),
    CHECK (status IN ('unused', 'used', 'expired'))
);

-- 索引：按状态筛选（管理后台"未使用/已使用"统计）
CREATE INDEX IF NOT EXISTS idx_redeem_status ON redeem_codes(status);
-- 索引：按批次查询（管理后台按批次导出）
CREATE INDEX IF NOT EXISTS idx_redeem_batch ON redeem_codes(batch_id);
-- 索引：按创建时间排序（管理后台列表分页）
CREATE INDEX IF NOT EXISTS idx_redeem_created ON redeem_codes(created_at DESC);
-- 索引：按使用者查询（用户端"我的兑换记录"）
CREATE INDEX IF NOT EXISTS idx_redeem_used_by ON redeem_codes(used_by, used_at DESC);

-- ============================================================
-- 10. 系统公告表（管理后台发布，用户控制台查看）
-- ============================================================
CREATE TABLE IF NOT EXISTS news (
    news_id       TEXT PRIMARY KEY,             -- 公告ID，如 'news_xxx'
    title         TEXT NOT NULL,                -- 标题
    content       TEXT NOT NULL,               -- 正文（纯文本，前端按 \n 换行渲染）
    category      TEXT NOT NULL DEFAULT 'system', -- 分类：system|activity|update
    is_pinned     INTEGER NOT NULL DEFAULT 0,   -- 是否置顶（0=否，1=是）
    is_published  INTEGER NOT NULL DEFAULT 1,   -- 是否发布（0=草稿，1=已发布）
    view_count    INTEGER NOT NULL DEFAULT 0,   -- 浏览次数
    created_by    TEXT NOT NULL,                -- 创建者账号ID（管理员）
    created_at    INTEGER NOT NULL,             -- 创建时间（毫秒时间戳）
    updated_at    INTEGER NOT NULL,             -- 更新时间（毫秒时间戳）
    published_at  INTEGER NOT NULL DEFAULT 0,   -- 发布时间（毫秒时间戳）

    FOREIGN KEY (created_by) REFERENCES accounts(account_id) ON DELETE SET NULL,

    CHECK (is_pinned IN (0, 1)),
    CHECK (is_published IN (0, 1)),
    CHECK (category IN ('system', 'activity', 'update'))
);

-- （索引移到下面"安全补列"后再建，避免老库缺列导致 CREATE INDEX 失败）

-- ============================================================
-- 11. 面试会话主表 ia_sessions（从独立 interview.db 合并进来）
--      桌面端创建 + 修改；Landing 面试记录页只读
-- ============================================================
CREATE TABLE IF NOT EXISTS ia_sessions (
    id              TEXT PRIMARY KEY,
    account_id      TEXT NOT NULL DEFAULT '__guest__',
    category        TEXT NOT NULL DEFAULT 'copilot',
    title           TEXT NOT NULL DEFAULT '',
    target_company  TEXT NOT NULL DEFAULT '',
    target_position TEXT NOT NULL DEFAULT '',
    interview_type  TEXT NOT NULL DEFAULT '',
    status          TEXT NOT NULL DEFAULT 'active',
    started_at      INTEGER NOT NULL DEFAULT 0,
    ended_at        INTEGER NOT NULL DEFAULT 0,
    last_active_at  INTEGER NOT NULL DEFAULT 0,
    round_count     INTEGER NOT NULL DEFAULT 0,
    question_count  INTEGER NOT NULL DEFAULT 0,
    answered_count  INTEGER NOT NULL DEFAULT 0,
    error_count     INTEGER NOT NULL DEFAULT 0,
    duration_ms     INTEGER NOT NULL DEFAULT 0,
    jd_snapshot     TEXT NOT NULL DEFAULT '',
    resume_snapshot TEXT NOT NULL DEFAULT '',
    snippet         TEXT NOT NULL DEFAULT '',
    wav_path        TEXT,                          -- 原始 WAV 音频文件的相对路径（继续存文件系统，不入库）
    review_md       TEXT,                          -- AI 复盘报告 Markdown 原文（从 ses_xxx-review.md 挪进来）
    config_json     TEXT,                          -- 当时面试配置 JSON（公司/岗位/难度…，原在 ses_xxx.json 顶层）
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
    updated_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
    synced_at       INTEGER NOT NULL DEFAULT 0,
    -- ⬇️⬇️ 迁移脚本与桌面端扩展追加列 ⬇️⬇️ --
    job_title           TEXT    NOT NULL DEFAULT '',    -- 桌面端 config-manager：面试的目标岗位（与 resume.job_title 对齐）
    resume_id           TEXT    NOT NULL DEFAULT '',    -- 关联 resumes.resume_id
    interviewer_mode    TEXT    NOT NULL DEFAULT 'standard', -- 面试模式：standard/strict/warm 等
    total_score         REAL,                           -- 综合评分（0-100）
    total_rounds        INTEGER NOT NULL DEFAULT 0,     -- 实际完成轮次（≠ round_count=设计轮数）
    finished_at         INTEGER NOT NULL DEFAULT 0,     -- 面试结束时间
    recording_wav       TEXT,                           -- 合并后"整场"WAV 路径（saveRecording 写入）
    transcript_json     TEXT,                           -- 桌面端 saveSession：合并 transcript + rounds
    source              TEXT    NOT NULL DEFAULT 'unknown', -- 数据来源：landing.web / desktop.json / localHttp / migrate
    resume_snapshot_md  TEXT,                           -- 简历快照 Markdown（JD 对齐）
    job_desc_snapshot   TEXT                            -- JD 快照全文
);

-- ============================================================
-- 12. 面试问答轮次表 ia_rounds（从独立 interview.db 合并进来）
-- ============================================================
CREATE TABLE IF NOT EXISTS ia_rounds (
    id              TEXT PRIMARY KEY,
    session_id      TEXT NOT NULL,
    seq             INTEGER NOT NULL DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'asked',
    source          TEXT NOT NULL DEFAULT 'unknown',
    question_text   TEXT NOT NULL DEFAULT '',
    question_image  TEXT,
    answer_text     TEXT NOT NULL DEFAULT '',
    error_msg       TEXT NOT NULL DEFAULT '',
    created_at      INTEGER NOT NULL DEFAULT 0,
    answered_at     INTEGER NOT NULL DEFAULT 0,
    -- ⬇️⬇️ 迁移脚本与桌面端扩展追加列 ⬇️⬇️ --
    round_no            INTEGER NOT NULL DEFAULT 0,     -- 桌面端 round 序号（与 seq 含义一致，冗余对齐）
    round_id            TEXT    NOT NULL DEFAULT '',    -- 桌面端 roundId（与 id 含义一致，冗余对齐）
    question            TEXT    NOT NULL DEFAULT '',    -- 问题原文（冗余对齐）
    answer_markdown     TEXT,                           -- 回答 Markdown（比 answer_text 更富格式）
    audio_wav_path      TEXT,                           -- 本轮录音 WAV 路径
    score               REAL,                           -- 本轮 AI 打分（0-100）
    score_breakdown_json TEXT,                          -- 本轮评分细则 JSON
    duration_ms         INTEGER NOT NULL DEFAULT 0      -- 本轮实际耗时（ms）
);

-- ============================================================
-- 13. 桌面端配置表（替代 AppData 下 config.json，按账号隔离）
--     API Key、难度、语言风格、音频设备等都按账号分别保存
-- ============================================================
CREATE TABLE IF NOT EXISTS desktop_configs (
    account_id   TEXT NOT NULL,                          -- 账号ID，__guest__ 为游客
    config_key   TEXT NOT NULL DEFAULT 'main_config',    -- 配置键：main_config/ui_prefs/device...
    config_json  TEXT NOT NULL DEFAULT '{}',             -- 完整 config 对象 JSON
    updated_at   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (account_id, config_key)                 -- 复合主键：每账号可多组配置
);

-- ============================================================
-- 14. 简历表（替代 AppData/accounts/{id}/resume.md + resume_meta.json）
--     每账号一行，保存最新简历全文和元数据
-- ============================================================
CREATE TABLE IF NOT EXISTS resumes (
    resume_id    TEXT PRIMARY KEY,                       -- 主键：res_{aid}_{resume_key}（支持多简历）
    account_id   TEXT NOT NULL,                          -- 所属账号ID
    resume_key   TEXT NOT NULL DEFAULT 'default',        -- 简历语义键：default/backend/web...
    resume_name  TEXT NOT NULL DEFAULT '默认简历',        -- 简历展示名（如"后端主力版"）
    resume_md    TEXT NOT NULL DEFAULT '',               -- 简历 Markdown 原文
    resume_text  TEXT NOT NULL DEFAULT '',               -- 简历纯文本版本（用于 LLM prompt）
    source_file  TEXT,                                   -- 首次导入来源文件路径
    updated_at   INTEGER NOT NULL DEFAULT 0,
    content      TEXT NOT NULL DEFAULT '',               -- 向后兼容别名列（=resume_md，保证老代码 SELECT content 仍 OK）
    meta_json    TEXT,                                   -- 元信息 JSON（向后兼容）
    UNIQUE (account_id, resume_key)                      -- 同一账号下 resume_key 唯一
);

-- ============================================================
-- 15. 桌面端会话表（替代 auth-session.json，encToken 仍经 safeStorage 加密）
--     每账号一行（同一时间桌面端只允许有一个有效会话，和旧 auth-session.json 语义一致）
-- ============================================================
CREATE TABLE IF NOT EXISTS desktop_sessions (
    account_id   TEXT PRIMARY KEY,
    enc_token    TEXT NOT NULL DEFAULT '',             -- safeStorage 加密后的 token（JSON 化的加密对象）
    token_hash   TEXT NOT NULL DEFAULT '',             -- 明文 token 的 SHA256（用于登出比对，不参与解密）
    created_at   INTEGER NOT NULL DEFAULT 0,
    expire_at    INTEGER NOT NULL DEFAULT 0
);

-- ============================================================
-- 16. 对话消息表（替代 logs/ia-history-YYYYMMDD.jsonl 按日归档文件）
--     Copilot 实时对话里溢出历史的每条消息一行，便于以后检索
-- ============================================================
CREATE TABLE IF NOT EXISTS ia_dialog_messages (
    message_id   TEXT PRIMARY KEY,                    -- 原 JSONL 里的 id
    account_id   TEXT NOT NULL DEFAULT '__guest__',
    session_id   TEXT NOT NULL DEFAULT '',            -- 若绑定面试会话 = ia_sessions.id；否则 Copilot 独立对话为空
    day_key      TEXT NOT NULL DEFAULT '00000000',     -- 按天分：YYYYMMDD（保留原归档文件概念，方便按月查）
    role         TEXT NOT NULL DEFAULT 'user',         -- user / assistant / system
    content      TEXT NOT NULL DEFAULT '',
    status       TEXT NOT NULL DEFAULT 'ok',           -- ok / error
    created_at   INTEGER NOT NULL DEFAULT 0
);
`;

// ============================================================
// 执行建表（事务内执行，保证原子性）
// ============================================================
db.exec(CREATE_TABLES);
console.log('[db] 所有表和索引已创建/更新');

// ============================================================
// 安全添加新列（兼容已有数据库）
// SQLite ALTER TABLE ADD COLUMN 在列已存在时会报错，用 PRAGMA table_info 检查
// ============================================================
function _safeAddColumn(table, column, type, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === column)) {
    const sql = `ALTER TABLE ${table} ADD COLUMN ${column} ${type}${def !== undefined ? ` DEFAULT ${def}` : ''}`;
    db.exec(sql);
    console.log(`[db] 已添加列：${table}.${column}`);
  }
}

// ============ accounts 表 ============
_safeAddColumn('accounts', 'is_disabled', 'INTEGER', 0);
_safeAddColumn('accounts', 'disabled_reason', 'TEXT', "''");

// ============ news 表 ============
_safeAddColumn('news', 'category',     'TEXT',    "'system'");
_safeAddColumn('news', 'is_pinned',    'INTEGER', 0);
_safeAddColumn('news', 'is_published', 'INTEGER', 1);
_safeAddColumn('news', 'view_count',   'INTEGER', 0);
_safeAddColumn('news', 'published_at', 'INTEGER', 0);

// ============ ia_sessions 表 ============
_safeAddColumn('ia_sessions', 'account_id',      'TEXT',    "'__guest__'");
_safeAddColumn('ia_sessions', 'category',        'TEXT',    "'copilot'");
_safeAddColumn('ia_sessions', 'title',           'TEXT',    "''");
_safeAddColumn('ia_sessions', 'target_company',  'TEXT',    "''");
_safeAddColumn('ia_sessions', 'target_position', 'TEXT',    "''");
_safeAddColumn('ia_sessions', 'interview_type',  'TEXT',    "''");
_safeAddColumn('ia_sessions', 'status',          'TEXT',    "'active'");
_safeAddColumn('ia_sessions', 'started_at',      'INTEGER', 0);
_safeAddColumn('ia_sessions', 'ended_at',        'INTEGER', 0);
_safeAddColumn('ia_sessions', 'last_active_at',  'INTEGER', 0);
_safeAddColumn('ia_sessions', 'round_count',     'INTEGER', 0);
_safeAddColumn('ia_sessions', 'question_count',  'INTEGER', 0);
_safeAddColumn('ia_sessions', 'answered_count',  'INTEGER', 0);
_safeAddColumn('ia_sessions', 'error_count',     'INTEGER', 0);
_safeAddColumn('ia_sessions', 'duration_ms',     'INTEGER', 0);
_safeAddColumn('ia_sessions', 'jd_snapshot',     'TEXT',    "''");
_safeAddColumn('ia_sessions', 'resume_snapshot', 'TEXT',    "''");
_safeAddColumn('ia_sessions', 'snippet',         'TEXT',    "''");
_safeAddColumn('ia_sessions', 'wav_path',        'TEXT',    'NULL');
_safeAddColumn('ia_sessions', 'review_md',       'TEXT',    'NULL');
_safeAddColumn('ia_sessions', 'config_json',     'TEXT',    'NULL');
_safeAddColumn('ia_sessions', 'created_at',      'INTEGER', 0);
_safeAddColumn('ia_sessions', 'updated_at',      'INTEGER', 0);
_safeAddColumn('ia_sessions', 'synced_at',       'INTEGER', 0);
// ---- ia_sessions 桌面端扩展列 ----
_safeAddColumn('ia_sessions', 'job_title',         'TEXT',    "''");
_safeAddColumn('ia_sessions', 'resume_id',         'TEXT',    "''");
_safeAddColumn('ia_sessions', 'interviewer_mode',  'TEXT',    "'standard'");
_safeAddColumn('ia_sessions', 'total_score',       'REAL',    'NULL');
_safeAddColumn('ia_sessions', 'total_rounds',      'INTEGER', 0);
_safeAddColumn('ia_sessions', 'finished_at',       'INTEGER', 0);
_safeAddColumn('ia_sessions', 'recording_wav',     'TEXT',    'NULL');
_safeAddColumn('ia_sessions', 'transcript_json',   'TEXT',    'NULL');
_safeAddColumn('ia_sessions', 'source',            'TEXT',    "'unknown'");
_safeAddColumn('ia_sessions', 'resume_snapshot_md','TEXT',    'NULL');
_safeAddColumn('ia_sessions', 'job_desc_snapshot', 'TEXT',    'NULL');

// ============ ia_rounds 表 ============
_safeAddColumn('ia_rounds', 'session_id',     'TEXT',    "''");
_safeAddColumn('ia_rounds', 'seq',            'INTEGER', 0);
_safeAddColumn('ia_rounds', 'status',         'TEXT',    "'asked'");
_safeAddColumn('ia_rounds', 'source',         'TEXT',    "'unknown'");
_safeAddColumn('ia_rounds', 'question_text',  'TEXT',    "''");
_safeAddColumn('ia_rounds', 'question_image', 'TEXT',    'NULL');
_safeAddColumn('ia_rounds', 'answer_text',    'TEXT',    "''");
_safeAddColumn('ia_rounds', 'error_msg',      'TEXT',    "''");
_safeAddColumn('ia_rounds', 'created_at',     'INTEGER', 0);
_safeAddColumn('ia_rounds', 'answered_at',    'INTEGER', 0);
// ---- ia_rounds 桌面端扩展列 ----
_safeAddColumn('ia_rounds', 'round_no',             'INTEGER', 0);
_safeAddColumn('ia_rounds', 'round_id',             'TEXT',    "''");
_safeAddColumn('ia_rounds', 'question',             'TEXT',    "''");
_safeAddColumn('ia_rounds', 'answer_markdown',      'TEXT',    'NULL');
_safeAddColumn('ia_rounds', 'audio_wav_path',       'TEXT',    'NULL');
_safeAddColumn('ia_rounds', 'score',                'REAL',    'NULL');
_safeAddColumn('ia_rounds', 'score_breakdown_json', 'TEXT',    'NULL');
_safeAddColumn('ia_rounds', 'duration_ms',          'INTEGER', 0);

// ============ desktop_configs / resumes / desktop_sessions / ia_dialog_messages ============
// ---- desktop_configs：新版 PRIMARY KEY(account_id, config_key)，旧版只有 account_id ----
(function rebuildDesktopConfigsIfNeeded() {
  const cols = db.prepare('PRAGMA table_info(desktop_configs)').all();
  const hasConfigKey = cols.some(c => c.name === 'config_key');
  if (hasConfigKey) {
    // 新表：只需要保证列都齐
    _safeAddColumn('desktop_configs',  'config_json', 'TEXT',    "'{}'");
    _safeAddColumn('desktop_configs',  'updated_at',  'INTEGER', 0);
    return;
  }
  // 🔴 旧版：account_id PRIMARY KEY，需重建为复合主键
  console.log('[db] ⚠️ desktop_configs 为旧版单主键结构，正在升级为复合主键 (account_id, config_key)...');
  db.exec(`
    CREATE TABLE IF NOT EXISTS desktop_configs_new (
      account_id  TEXT NOT NULL,
      config_key  TEXT NOT NULL DEFAULT 'main_config',
      config_json TEXT NOT NULL DEFAULT '{}',
      updated_at  INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (account_id, config_key)
    );
    INSERT OR IGNORE INTO desktop_configs_new (account_id, config_key, config_json, updated_at)
      SELECT account_id, 'main_config', config_json, updated_at FROM desktop_configs;
    DROP TABLE desktop_configs;
    ALTER TABLE desktop_configs_new RENAME TO desktop_configs;
  `);
  console.log('[db] ✅ desktop_configs 升级完成（复合主键 + main_config 默认行）');
})();

// ---- resumes：新版 PRIMARY KEY(resume_id) + UNIQUE(account_id, resume_key)，旧版只有 account_id ----
(function rebuildResumesIfNeeded() {
  const cols = db.prepare('PRAGMA table_info(resumes)').all();
  const colNames = new Set(cols.map(c => c.name));
  const hasResumeId = colNames.has('resume_id');
  const hasResumeMd = colNames.has('resume_md');
  const hasResumeKey = colNames.has('resume_key');
  if (hasResumeId && hasResumeMd && hasResumeKey) {
    // 新表：只需要保证列齐
    _safeAddColumn('resumes', 'resume_id',    'TEXT',    "''");
    _safeAddColumn('resumes', 'account_id',   'TEXT',    "'__guest__'");
    _safeAddColumn('resumes', 'resume_key',   'TEXT',    "'default'");
    _safeAddColumn('resumes', 'resume_name',  'TEXT',    "'默认简历'");
    _safeAddColumn('resumes', 'resume_md',    'TEXT',    "''");
    _safeAddColumn('resumes', 'resume_text',  'TEXT',    "''");
    _safeAddColumn('resumes', 'source_file',  'TEXT',    'NULL');
    _safeAddColumn('resumes', 'content',      'TEXT',    "''");
    _safeAddColumn('resumes', 'meta_json',    'TEXT',    'NULL');
    _safeAddColumn('resumes', 'updated_at',   'INTEGER', 0);
    return;
  }
  // 🔴 旧版：account_id PRIMARY KEY，需重建（迁移 content → resume_md / resume_text / content 三列冗余保存）
  console.log('[db] ⚠️ resumes 为旧版结构，正在升级为多简历主键 (resume_id) + UNIQUE(account_id, resume_key)...');
  db.exec(`
    CREATE TABLE IF NOT EXISTS resumes_new (
      resume_id   TEXT PRIMARY KEY,
      account_id  TEXT NOT NULL,
      resume_key  TEXT NOT NULL DEFAULT 'default',
      resume_name TEXT NOT NULL DEFAULT '默认简历',
      resume_md   TEXT NOT NULL DEFAULT '',
      resume_text TEXT NOT NULL DEFAULT '',
      source_file TEXT,
      updated_at  INTEGER NOT NULL DEFAULT 0,
      content     TEXT NOT NULL DEFAULT '',
      meta_json   TEXT,
      UNIQUE (account_id, resume_key)
    );
    INSERT OR IGNORE INTO resumes_new
      (resume_id, account_id, resume_key, resume_name, resume_md, resume_text, source_file, updated_at, content, meta_json)
      SELECT 'res_' || account_id || '_default', account_id, 'default', '默认简历',
             COALESCE(content, ''), COALESCE(content, ''), NULL,
             COALESCE(updated_at, 0), COALESCE(content, ''), meta_json
        FROM resumes;
    DROP TABLE resumes;
    ALTER TABLE resumes_new RENAME TO resumes;
  `);
  console.log('[db] ✅ resumes 升级完成（旧 content→resume_md/resume_text/content 三列同步）');
})();

// ---- desktop_sessions / ia_dialog_messages 列结构与新表一致，只补列即可 ----
_safeAddColumn('desktop_sessions', 'enc_token',   'TEXT',    "''");
_safeAddColumn('desktop_sessions', 'token_hash',  'TEXT',    "''");
_safeAddColumn('desktop_sessions', 'created_at',  'INTEGER', 0);
_safeAddColumn('desktop_sessions', 'expire_at',   'INTEGER', 0);
_safeAddColumn('ia_dialog_messages', 'account_id', 'TEXT',   "'__guest__'");
_safeAddColumn('ia_dialog_messages', 'session_id', 'TEXT',   "''");
_safeAddColumn('ia_dialog_messages', 'day_key',    'TEXT',   "'00000000'");
_safeAddColumn('ia_dialog_messages', 'role',       'TEXT',   "'user'");
_safeAddColumn('ia_dialog_messages', 'content',    'TEXT',   "''");
_safeAddColumn('ia_dialog_messages', 'status',     'TEXT',   "'ok'");
_safeAddColumn('ia_dialog_messages', 'created_at', 'INTEGER', 0);

// ============================================================
// 所有索引（放在 _safeAddColumn 之后，避免老库缺列导致失败）
// ============================================================
const CREATE_INDEXES = [
  // accounts 相关
  'CREATE INDEX IF NOT EXISTS idx_accounts_is_disabled ON accounts(is_disabled)',
  // credit_flows 相关（原 CREATE_TABLES 里已有的索引）
  'CREATE INDEX IF NOT EXISTS idx_credit_flows_account_month ON credit_flows(account_id, month_key, flow_time DESC)',
  'CREATE INDEX IF NOT EXISTS idx_credit_flows_order ON credit_flows(order_id, flow_time DESC)',
  // orders 相关
  'CREATE INDEX IF NOT EXISTS idx_orders_account ON orders(account_id, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(pay_status, updated_at DESC)',
  // web_sessions 相关
  'CREATE INDEX IF NOT EXISTS idx_web_sessions_expire ON web_sessions(expire_at)',
  'CREATE INDEX IF NOT EXISTS idx_web_sessions_account ON web_sessions(account_id)',
  // checkin 相关
  'CREATE INDEX IF NOT EXISTS idx_checkin_account_day ON checkin_records(account_id, day_key)',
  // invite 相关
  'CREATE INDEX IF NOT EXISTS idx_invite_inviter ON invite_records(inviter_account_id, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_invite_invitee ON invite_records(invitee_account_id)',
  // redeem 相关
  'CREATE INDEX IF NOT EXISTS idx_redeem_code ON redeem_codes(code, is_used)',
  'CREATE INDEX IF NOT EXISTS idx_redeem_used_by ON redeem_codes(used_by, used_at DESC)',
  // news 相关
  'CREATE INDEX IF NOT EXISTS idx_news_published ON news(is_published, is_pinned DESC, published_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_news_category ON news(category, created_at DESC)',
  // ia_sessions 相关
  'CREATE INDEX IF NOT EXISTS idx_sessions_account_status ON ia_sessions(account_id, category, status, last_active_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_sessions_company ON ia_sessions(account_id, target_company)',
  'CREATE INDEX IF NOT EXISTS idx_sessions_started ON ia_sessions(started_at DESC)',
  // ia_rounds 相关
  'CREATE INDEX IF NOT EXISTS idx_rounds_session ON ia_rounds(session_id, seq ASC)',
  'CREATE INDEX IF NOT EXISTS idx_rounds_question_text ON ia_rounds(question_text)',
  // ia_dialog_messages 相关
  'CREATE INDEX IF NOT EXISTS idx_dialog_account_day ON ia_dialog_messages(account_id, day_key DESC)',
  'CREATE INDEX IF NOT EXISTS idx_dialog_session ON ia_dialog_messages(session_id, created_at ASC)',
];
for (const sql of CREATE_INDEXES) {
  try { db.exec(sql); } catch (e) {
    console.warn(`[db] ⚠️ 创建索引失败（忽略继续）：${sql.substring(0, 80)}… | ${e.message}`);
  }
}
console.log('[db] 所有索引已同步');

// ============================================================
// 初始化默认套餐数据（如果 packages 表为空则写入；非空则 UPSERT 到最新 5 档，保证与 UI 截图一致）
// ============================================================
const pkgCount = db.prepare('SELECT COUNT(*) AS cnt FROM packages').get();
// 新版 5 档积分套餐（与 console.html 充值积分页的 5 张卡片一一对应，同时保留老 4 档兼容旧订单）
const CREDIT_PACKAGES = [
  // === 新版 5 档（对应截图：首充/省10%/热门省15%/省20%/最划算省25%） ===
  { id: 'c120',  title: '体验版',  credits: 100, bonus: 20,  priceCents: 1000,
    tag: '首充',   desc: '120 积分：¥10，新用户首选' },
  { id: 'c520',  title: '基础版',  credits: 500, bonus: 20,  priceCents: 4500,
    tag: '省10%', desc: '520 积分：¥45（¥0.09/积分）' },
  { id: 'c1020', title: '进阶版',  credits: 1000,bonus: 20,  priceCents: 8500,
    tag: '热门',  desc: '1,020 积分：¥85（¥0.085/积分，热门推荐）' },
  { id: 'c2020', title: '求职版',  credits: 2000,bonus: 20,  priceCents: 16000,
    tag: '省20%', desc: '2,020 积分：¥160（¥0.08/积分，适合密集投递）' },
  { id: 'c5020', title: '旗舰版',  credits: 5000,bonus: 20,  priceCents: 37500,
    tag: '最划算',desc: '5,020 积分：¥375（¥0.075/积分，全年陪伴）' },
  // === 老 4 档兼容（保留 pico/pro/elite/max，防止历史订单/老用户看到异常） ===
  { id: 'pico',  title: '体验版',  credits: 50,   bonus: 0,   priceCents: 990,
    tag: '新手首选', desc: '适合先体验 1-2 场模拟面试 / 简历初评' },
  { id: 'pro',   title: '求职版',  credits: 200,  bonus: 20,  priceCents: 2990,
    tag: '最受欢迎', desc: '真实面试 Copilot + 模拟面试 10 场左右' },
  { id: 'elite', title: '冲刺版',  credits: 800,  bonus: 150, priceCents: 9900,
    tag: '多岗位冲刺', desc: '春招/秋招密集期，批量投递 + 多轮面试护航' },
  { id: 'max',   title: '终极版',  credits: 2000, bonus: 500, priceCents: 19900,
    tag: '全年陪伴', desc: '跳槽周期全程 + 社招大公司面试深度备战' },
];

const now = Date.now();
// UPSERT：存在则更新，不存在则插入，保证重启后永远是最新套餐
const upsertPkg = db.prepare(`
  INSERT INTO packages
    (package_id, title, credits, bonus_credits, price_cents, tag, description,
     is_active, sort_order, created_at, updated_at)
  VALUES (@id, @title, @credits, @bonus, @priceCents, @tag, @desc,
          1, @sortOrder, @now, @now)
  ON CONFLICT(package_id) DO UPDATE SET
    title         = excluded.title,
    credits       = excluded.credits,
    bonus_credits = excluded.bonus_credits,
    price_cents   = excluded.price_cents,
    tag           = excluded.tag,
    description   = excluded.description,
    is_active     = 1,
    sort_order    = excluded.sort_order,
    updated_at    = excluded.updated_at
`);

const upsertAll = db.transaction((pkgs) => {
  pkgs.forEach((p, i) => {
    upsertPkg.run({
      id: p.id, title: p.title, credits: p.credits, bonus: p.bonus,
      priceCents: p.priceCents, tag: p.tag, desc: p.desc,
      sortOrder: i, now,
    });
  });
});

upsertAll(CREDIT_PACKAGES);
if (pkgCount.cnt === 0) {
  console.log(`[db] 已初始化 ${CREDIT_PACKAGES.length} 个套餐（含 5 档新版）`);
} else {
  console.log(`[db] 已同步套餐表到最新 5 档（兼容老 4 档，共 ${CREDIT_PACKAGES.length} 条）`);
}

// ============================================================
// 导出模块
// ============================================================
module.exports = {
  db,        // better-sqlite3 数据库实例（单例）
  DB_PATH,   // 数据库文件路径
  DATA_ROOT, // 数据根目录
};
