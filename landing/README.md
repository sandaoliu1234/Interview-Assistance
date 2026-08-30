# HireMe AI 面试助手 · 宣传站点 + 控制台 + 管理后台

基于 Node.js 原生 HTTP 模块 + SQLite 的双服务 Web 应用，提供：

- **用户端**（端口 3000）：项目宣传页 / 登录注册 / 用户控制台（积分、套餐、活动记录）
- **管理端**（端口 3001）：独立的管理后台（总览看板、用户管理、调账、套餐）

数据存储全部使用 **SQLite**（WAL 模式 + 预编译语句 + 事务），不依赖任何 JSON 文件。

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
├── public/                # 静态前端资源
│   ├── index.html         # 宣传首页
│   ├── login.html         # 登录/注册页
│   ├── console.html       # 用户控制台
│   ├── admin.html         # 管理后台页面
│   ├── app.js             # 前端逻辑
│   └── styles.css         # 样式
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

- 用户端：http://localhost:3000
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

| 表名 | 用途 | 替代的旧 JSON 文件 |
|------|------|---------------------|
| `accounts` | 用户账号（邮箱、密码哈希、昵称、isAdmin） | accounts.json |
| `credit_balances` | 积分余额（balance/totalRecharged/totalConsumed） | credits.json |
| `credit_flows` | 积分流水（按月份分区键索引） | credit-flows/YYYY-MM.json |
| `orders` | 充值订单 | orders.json |
| `web_sessions` | Web 登录会话 | web-sessions.json |
| `packages` | 套餐配置 | （代码常量 CREDIT_PACKAGES） |

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

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/auth/register` | 注册（自动登录） |
| POST | `/api/auth/login` | 登录 |
| POST | `/api/auth/logout` | 登出 |
| GET  | `/api/auth/me` | 当前登录用户 |
| GET  | `/api/console/credits` | 查询积分余额 |
| GET  | `/api/console/flows` | 查询积分流水 |
| GET  | `/api/console/orders` | 查询订单 |
| GET  | `/api/console/packages` | 查询套餐列表 |
| POST | `/api/console/pay` | 模拟支付下单 |
| GET  | `/api/console/checkin` | 每日签到 |

### 管理端（http://localhost:3001）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/auth/login` | 管理员登录 |
| GET  | `/api/auth/me` | 当前管理员 |
| GET  | `/api/admin/overview` | 总览看板 |
| GET  | `/api/admin/accounts` | 账号列表（支持 keyword 搜索） |
| GET  | `/api/admin/accounts/:id` | 账号详情 |
| POST | `/api/admin/accounts/:id/adjust` | 手工调账 |
| GET  | `/api/admin/accounts/:id/flows` | 某账号流水 |
| GET  | `/api/admin/accounts/:id/orders` | 某账号订单 |
| GET  | `/api/admin/packages` | 套餐列表 |

> 管理端所有 `/api/admin/*` 接口需要管理员会话（Cookie `hireme_sid`），非管理员返回 403。

---

## 环境变量

可通过 `.env` 文件或系统环境变量配置（前缀 `IA_` 也可）：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `LANDING_PORT` | 3000 | 用户端端口 |
| `ADMIN_PORT` | 3001 | 管理端端口 |
| `LANDING_AUTH_ROOT` | ./data | 数据目录 |
| `LANDING_SESSION_TTL` | 7（天） | 会话有效期 |
| `LANDING_HOST` | 0.0.0.0 | 监听地址 |

---

## 安全说明

- 密码哈希：PBKDF2-SHA256，10 万次迭代，16 字节随机 salt
- 会话：HttpOnly + SameSite=Lax Cookie，7 天 TTL
- SQL 注入：全部使用参数化预编译语句
- 管理员鉴权：每次请求实时从 SQLite 查询 `is_admin`，不依赖会话缓存
