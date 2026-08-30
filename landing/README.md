# 即答侠 HireMe AI 面试助手 · 宣传站点 + 用户控制台 + 管理后台

基于 Node.js 原生 HTTP 模块 + SQLite 的双服务 Web 应用，对外提供：

- **用户端**（端口 3000）：**宣传站点**（品牌宣传首页 + 定价页 + 登录注册）+ 用户控制台（积分、套餐、模拟面试、简历优化）
- **管理端**（端口 3001）：独立的管理后台（总览看板、用户管理、调账、套餐）

数据存储全部使用 **SQLite**（WAL 模式 + 预编译语句 + 事务），不依赖任何 JSON 文件。

---

## 宣传站点（前端页面）

品牌名：**即答侠 HireMe AI** —— 一款「实时面试 Copilot」产品，卖点是 **700ms 内生成结构化回答要点 + 隐身浮窗（屏幕共享/录屏不可见）+ 覆盖任意会议软件**。三大产品能力：

| 能力                    | 说明                                                                                                              |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 🎧 面试实时辅助 Copilot | 后台静默捕获面试官语音，700ms 内弹出结构化 STAR 回答要点，隐身浮窗面试官完全无感                                  |
| 🎯 AI 模拟面试          | AI 担任面试官，按简历 + 目标 JD 出题，从「内容相关性 / 逻辑结构 / 专业深度 / 表达沟通」四维度实时打分并给改进建议 |
| 📄 智能简历优化         | ATS 兼容性评分、对照 JD 检测缺失关键词、逐条改写为成果导向表达，支持一键导出 DOCX                                 |

宣传站点各页面：

- **`index.html` 宣传首页** —— 完整营销着陆页，板块依次为：
  1. Hero：标题 + 双 CTA（免费体验 / 下载桌面端）+ 3 组数据统计（75,000+ 用户 / 270,000+ 面试辅助 / 680万+ AI 实时回答）+ 右侧 Copilot 隐身浮窗动画演示
  2. 三大核心能力：`#copilot` 实时辅助 Copilot（4 个亮点卡）、AI 模拟面试（分数面板 + 四维度拆解）、智能简历优化（ATS 匹配 + 关键词 + AI 建议 + 改写前后对比）
  3. `#scenes` 适用场景：6 大场景卡片（技术/算法、产品/数据分析、行为/高管、咨询/投行/四大、外企/海外 FAANG、HR 初筛/跨境视频）
  4. 题库板块：1100+ 篇精编面试题答案模板（行为面 / 系统设计 / 产品 / Java / 前端 / Case）
  5. `#download` 下载桌面端：Windows / macOS 双平台（当前 v0.3.44 STABLE），附浏览器「保留文件」操作提示
  6. CTA 行动区 + 四列页脚（产品 / 资源 / 关于）
- **`pricing.html` 定价页** —— 三档套餐 + 按量付费横幅 + Offer 奖学金横幅：
  - 免费版 ¥0（永久）：3 次模拟面试/月、1 次简历分析、1 次 Copilot 体验（30分钟）
  - 基础版 ¥69/月（求职季卡 ¥159/季，省 23%）：无限模拟面试、完整简历优化、5 次 Copilot/月、完整题库、面试记录回放
  - 专业版 ¥129/月（季卡 ¥289/季，省 25%，Most Popular）：Copilot 不限次数、模拟面试/简历不限次数、长面试不中断、详细分析报告、专属客服
  - 购买按钮跳转 `console.html?goto=orders&pkg=<id>&price=<价>` 自动创建订单
- **`login.html` 登录 / 注册页** —— 标签页切换，登录后自动同步套餐、积分与 Copilot
- **`console.html` 用户控制台** —— 左侧菜单 + 顶部积分条 + 各功能面板：
  - 首页概览：积分余额、签到（+50 积分）、模拟面试/简历分析剩余次数、邀请好友赚积分
  - 模拟面试面板（AI 出题、实时打分）、简历优化面板（简历/JD 双栏）
  - 充值积分、我的订单、积分明细
- **`admin.html` 管理后台** —— 独立管理页面（总览看板、用户管理、手工调账、套餐管理）

> 前端统一复用 `public/styles.css` 的深色主题 + CSS 变量体系（`--bg-*` / `--accent` / `--text-*`），交互逻辑集中在 `public/app.js`（登录态渲染、Toast 提示、订单流程 `initOrderFlowFromQuery()` 等）。

---

## 目录结构

```
landing/
├── index.js               # 双服务统一启动器（同时拉起用户端 + 管理端）
├── user-server.js         # 用户端 HTTP 服务（端口 3000）
├── admin-server.js        # 管理端 HTTP 服务（端口 3001）
├── shared.js              # 共享模块（路径常量、HTTP 工具、鉴权、套餐、委托 DAL）
├── auth-db.js             # 账号鉴权（SQLite 版，替代原 authService.js）
├── db.js                  # SQLite 初始化（建表、索引、WAL、外键）
├── db-layer.js            # 数据访问层 DAL（积分/订单/流水/会话/套餐）
├── migrate-json-to-db.js  # 一次性迁移脚本（JSON → SQLite）
├── verify-db.js           # 数据库验证脚本（检查各表数据）
├── package.json
├── public/                # 静态前端资源（宣传站点 + 控制台 + 管理后台）
│   ├── index.html         # 宣传首页（着陆页，见上方「宣传站点」）
│   ├── pricing.html       # 定价页（三档套餐 + 按量付费 + Offer 奖学金）
│   ├── login.html         # 登录/注册页
│   ├── console.html       # 用户控制台
│   ├── admin.html         # 管理后台页面
│   ├── app.js             # 前端逻辑（登录态、Toast、订单流程）
│   └── styles.css         # 全局样式（深色主题 CSS 变量体系）
└── data/                  # 数据目录（由 db.js 自动创建）
    ├── hireme.db          # SQLite 主数据库
    ├── hireme.db-wal      # WAL 日志
    ├── hireme.db-shm      # 共享内存
    └── json-backup-*/     # 迁移前 JSON 文件备份（可选，可删）
```

---

## 快速启动

### 1. 安装依赖

```bash
cd landing
npm install
```

> `better-sqlite3` 是唯一必需依赖。Windows 下若预编译版本不兼容，使用：
> `npm install better-sqlite3 --build-from-source=false`

### 2. 启动双服务

```bash
npm start
# 或：node index.js
```

启动后访问：

- 用户端（宣传站 + 控制台）：http://localhost:3000
- 管理端：http://localhost:3001

默认管理员账号：`15376110673@163.com` / `123456`（首次启动自动预置到 SQLite）

### 3. 单独启动某一端

```bash
npm run user      # 仅用户端
npm run admin     # 仅管理端
```

---

## 数据存储

所有业务数据存储在 `data/hireme.db`（SQLite），包含以下表：

| 表名                | 用途                                             | 替代的旧 JSON 文件           |
| ------------------- | ------------------------------------------------ | ---------------------------- |
| `accounts`        | 用户账号（邮箱、密码哈希、昵称、isAdmin）        | accounts.json                |
| `credit_balances` | 积分余额（balance/totalRecharged/totalConsumed） | credits.json                 |
| `credit_flows`    | 积分流水（按月份分区键索引）                     | credit-flows/YYYY-MM.json    |
| `orders`          | 充值订单                                         | orders.json                  |
| `web_sessions`    | Web 登录会话                                     | web-sessions.json            |
| `packages`        | 套餐配置                                         | （代码常量 CREDIT_PACKAGES） |

### SQLite 配置

- **WAL 模式**：多读单写，读写不互锁
- **busy_timeout=5000**：跨进程写冲突时等待 5 秒
- **外键约束**：ON（账号删除时余额/流水/订单级联）
- **预编译语句（prepared statements）**：所有高频查询预编译，避免 SQL 注入 + 提升性能

---

## 从旧 JSON 迁移

如果项目历史上有 `accounts.json` / `credits.json` / `orders.json` / `web-sessions.json` / `credit-flows/*.json`，运行一次迁移脚本：

```bash
npm run migrate
# 或：node migrate-json-to-db.js
```

迁移后可用 `node verify-db.js` 验证数据完整性。

> 迁移脚本只读取 JSON 文件写入 SQLite，不会删除原 JSON 文件。迁移完成后可手动清理或备份到 `data/json-backup-*/`。

---

## API 概览

### 用户端（http://localhost:3000）

| 方法 | 路径                      | 说明             |
| ---- | ------------------------- | ---------------- |
| POST | `/api/auth/register`    | 注册（自动登录） |
| POST | `/api/auth/login`       | 登录             |
| POST | `/api/auth/logout`      | 登出             |
| GET  | `/api/auth/me`          | 当前登录用户     |
| GET  | `/api/console/credits`  | 查询积分余额     |
| GET  | `/api/console/flows`    | 查询积分流水     |
| GET  | `/api/console/orders`   | 查询订单         |
| GET  | `/api/console/packages` | 查询套餐列表     |
| POST | `/api/console/pay`      | 模拟支付下单     |
| GET  | `/api/console/checkin`  | 每日签到         |

### 管理端（http://localhost:3001）

| 方法 | 路径                               | 说明                          |
| ---- | ---------------------------------- | ----------------------------- |
| POST | `/api/auth/login`                | 管理员登录                    |
| GET  | `/api/auth/me`                   | 当前管理员                    |
| GET  | `/api/admin/overview`            | 总览看板                      |
| GET  | `/api/admin/accounts`            | 账号列表（支持 keyword 搜索） |
| GET  | `/api/admin/accounts/:id`        | 账号详情                      |
| POST | `/api/admin/accounts/:id/adjust` | 手工调账                      |
| GET  | `/api/admin/accounts/:id/flows`  | 某账号流水                    |
| GET  | `/api/admin/accounts/:id/orders` | 某账号订单                    |
| GET  | `/api/admin/packages`            | 套餐列表                      |

> 管理端所有 `/api/admin/*` 接口需要管理员会话（Cookie `hireme_sid`），非管理员返回 403。

---

## 环境变量

可通过 `.env` 文件或系统环境变量配置（前缀 `IA_` 也可）：

| 变量                    | 默认值  | 说明       |
| ----------------------- | ------- | ---------- |
| `LANDING_PORT`        | 3000    | 用户端端口 |
| `ADMIN_PORT`          | 3001    | 管理端端口 |
| `LANDING_AUTH_ROOT`   | ./data  | 数据目录   |
| `LANDING_SESSION_TTL` | 7（天） | 会话有效期 |
| `LANDING_HOST`        | 0.0.0.0 | 监听地址   |

---

## 安全说明

- 密码哈希：PBKDF2-SHA256，10 万次迭代，16 字节随机 salt
- 会话：HttpOnly + SameSite=Lax Cookie，7 天 TTL
- SQL 注入：全部使用参数化预编译语句
- 管理员鉴权：每次请求实时从 SQLite 查询 `is_admin`，不依赖会话缓存
