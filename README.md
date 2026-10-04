# Interview Assist AI 面试助手 · 桌面端（Electron）

Electron 桌面客户端，是「Interview Assist AI 面试助手」三大产品能力（**实时面试 Copilot / AI 模拟面试 / 智能简历优化**）的桌面载体，用于在真实面试场景中提供**实时听题出答案 + 隐身浮窗**能力。

- **主进程**：`main.js`（音频采集、ASR 管线、AI 答题、隐身边窗、托盘、快捷键、本地伴生服务）
- **渲染层**：`index.html` + `renderer.js`（Copilot / 模拟面试 / 简历优化三模式界面）
- **隐身答题面板**：`overlay.html` + `overlay-renderer.js`（独立置顶窗口，屏幕共享/录屏不可见）
- **数据存储**：SQLite（`data/hireme.db`），与 `landing/` 宣传站点、管理后台共用同一份数据库（三端统一数据源）

---

## 目录结构

```
Interview Assistance/
├── main.js                  # Electron 主进程（启动兜底、ASR 管线、窗口/托盘/快捷键、IPC）
├── preload.js               # 预加载脚本（contextBridge 安全 IPC 桥 → window.electronAPI）
├── renderer.js              # 渲染层逻辑（Electron / 浏览器 双入口）
├── index.html               # 主界面（Copilot / 模拟面试 / 简历优化）
├── styles.css               # 主界面样式
├── overlay.html             # 隐身答题面板（独立窗口）
├── overlay-renderer.js      # 答题面板渲染逻辑
├── overlay.css              # 答题面板样式
├── mockInterviewFloat.html  # 模拟面试浮动面板
├── dev-server.js            # 浏览器开发模式（零依赖，端口 5173）
├── package.json
├── .env                     # 环境变量/密钥（已 gitignore，勿提交）
├── services/                # 主进程业务服务
│   ├── aiService.js         # LLM 引擎（百度文心 / 通义千问 / 智谱 多服务商）
│   ├── asrPipeline.js       # ASR 管线（系统音频 → 语音识别 → 问题检测 → AI 答题）
│   ├── systemAudioCapture.js# WASAPI 系统音频采集（native_audio.node 封装）
│   ├── audioService.js      # 音频工具
│   ├── speechService.js     # 语音合成/转写辅助
│   ├── realtimeSpeechService.js
│   ├── mockInterviewAgents.js  # AI 模拟面试 Agent（出题、打分）
│   ├── resumeOptAgents.js      # 简历优化 Agent（ATS 分析、逐条改写）
│   ├── authService.js       # 本地账号鉴权 + 会话加密（safeStorage）
│   ├── session-repo.js      # 面试会话存储（SQLite）
│   ├── localHttpServer.js   # 本地伴生服务（HTTP + SSE + WebSocket，小程序联动）
│   ├── stateManager.js      # 本地状态管理
│   ├── privacyAudit.js      # 隐私审计
│   └── common-paths.js      # 三端统一数据路径解析（指向同一份 data/hireme.db）
├── src/
│   ├── main/
│   │   ├── capture-exclusion.js  # 窗口捕获排除（WDA_EXCLUDEFROMCAPTURE，koffi 调 Win32）
│   │   ├── config-manager.js     # 配置持久化
│   │   └── relay-server.js       # 本地中继服务
│   ├── renderer/
│   │   ├── copilot.js            # Copilot 业务层
│   │   ├── gaze-controller.js    # 视线控制
│   │   ├── mockInterviewFloatRenderer.js
│   │   └── mockResumePanels.js
│   └── shared/
│       └── interview-config.js
├── native/
│   └── native_audio.node         # 原生音频采集模块（koffi 绑定）
├── assets/                       # 模型与图标（face_landmarker.task、icons）
├── public/h5/                    # H5 页面资源
├── data/                         # 数据目录
│   └── hireme.db                 # 统一 SQLite 数据库（桌面端 / landing / 管理端共用）
├── scripts/                      # 数据迁移脚本
├── utils/retry.js                # 重试工具
├── logs/                         # 运行日志 / 崩溃日志 / 会话录音
└── landing/                      # 宣传站点 + 控制台 + 管理后台（见 landing/README.md）
```

---

## 核心能力

### 1. 实时面试 Copilot（ASR 管线）
1. **系统音频采集**：WASAPI 捕获面试官声音（`systemAudioCapture.js` + `native/native_audio.node`）
2. **语音识别（ASR）**：百度语音识别，实时识别面试官问题（`asrPipeline.js`）
3. **AI 答题**：识别到问题后，用 LLM 生成结构化回答要点（STAR 结构），约 700ms 出答案
4. **隐身浮窗**：答案显示在独立置顶的 `overlay` 窗口中，屏幕共享/录屏**完全不可见**

### 2. 隐身模式（截图/录屏不可见）
- 通过 `src/main/capture-exclusion.js`（koffi 调 Win32 `WDA_EXCLUDEFROMCAPTURE`）对**全部顶层窗口**统一施加"从捕获排除"——本地可见，但截屏 / 录屏 / 屏幕共享的捕获端看不到。
- 隐身模式还支持鼠标穿透 + 跳过任务栏，配合全局快捷键快速进出。

### 3. AI 模拟面试
- `mockInterviewAgents.js`：AI 担任面试官，按简历 + 目标 JD 出题，从「内容相关性 / 逻辑结构 / 专业深度 / 表达沟通」四维度实时打分并给改进建议。
- 独立浮动面板 `mockInterviewFloat.html` 锁死作答流程。

### 4. 智能简历优化
- `resumeOptAgents.js`：ATS 兼容性评分、对照 JD 检测缺失关键词、逐条改写为成果导向表达，支持导出 DOCX（`docx` 库）与解析 PDF / Word（`pdf-parse` / `mammoth`）。

### 5. 本地伴生服务（小程序联动）
- `localHttpServer.js`：本地 HTTP + SSE + WebSocket 服务，支持移动端小程序截图、答案回写、ASR 实时推送、二维码登录等联动场景。

### 6. 与宣传站点（landing）联动
- 登录：邮箱 + 密码 → 调 landing `/api/auth/login` → 保存远端会话到 `remote-session.json`
- 积分消费：走 landing `/api/console/consume`，服务端原子写余额 + 流水
- 充值引导：`shell.openExternal(LANDING_BASE_URL/console.html)`
- **离线兜底**：landing 未启动时全部接口自动 fallback 本地账号 + 离线允许使用，本地不崩。

---

## 快速开始

### 环境要求

- Node.js `>=20.17.0 <23.0.0`（推荐按 `.nvmrc` 使用 **20.18.1**）
- npm `>=10.0.0 <12.0.0`（`.npmrc` 已开启 `engine-strict=true`）
- Windows 10+ / macOS（`native_audio.node` 为 Windows 原生模块，macOS 需另行构建）

### 1. 安装依赖

```bash
npm install
```

> 原生模块（`better-sqlite3` / `koffi` / `native_audio.node`）在 Windows 下若预编译版本不兼容，使用：
> ```bash
> npm install better-sqlite3 --build-from-source=false
> ```

### 2. 配置环境变量

复制 `.env`（密钥已在 `.gitignore` 中，禁止提交），填入你的服务密钥：

| 变量 | 说明 |
|------|------|
| `IA_BAIDU_APP_ID` / `IA_BAIDU_API_KEY` / `IA_BAIDU_SECRET_KEY` | 百度语音识别（ASR），控制台：console.bce.baidu.com/ai |
| `IA_TONGYI_API_KEY` / `IA_TONGYI_BASE_URL` | 通义千问（DashScope / 百炼私有空间），模型：qwen-turbo / qwen-plus / qwen-max |
| `IA_WENXIN_API_KEY` | 文心一言（千帆大模型，可选） |
| `IA_ZHIPU_API_KEY` | 智谱 AI（清言，可选） |
| `IA_DEFAULT_SERVICE` | 默认 LLM 服务：`wenxin` \| `zhipu` \| `tongyi` |
| `LANDING_BASE_URL` | 宣传站点地址（默认 `http://localhost:3000`，生产改指向公网） |

**配置优先级**：系统 Shell 变量 > `.env` 文件 > 应用内设置面板（`config-manager`）> 默认值。

### 3. 启动

```bash
npm start              # 以 Electron 桌面端启动
npm run dev            # 浏览器开发模式（node dev-server.js，http://localhost:5173，UI 秒级刷新）
npm run dev:electron   # Electron + --inspect 调试
```

> 浏览器开发模式（`dev-server.js`）零依赖，仅用 Node 内置模块，复用 `aiService.js` 与 `config-manager.js`，
> 并通过 REST 通道 `/ipc/:channel` 暴露与 Electron IPC 同名的接口，`copilot.js` 业务层零修改即可运行。

---

## 打包 / 构建

```bash
npm run build        # electron-builder 打包（按当前平台）
npm run build:win    # Windows x64
npm run build:mac    # macOS arm64
npm run build:linux  # Linux x64
npm run dist         # electron-builder 发行构建
```

> 目前 `package.json` 尚未配置 `build` 字段（appId / productName / 图标 / 安装包格式等），
> 打包前需补充 electron-builder 配置（可在 package.json `build` 字段或独立 `electron-builder.yml` 中声明）。

---

## 数据存储（SQLite 统一数据源）

三端（桌面端 / landing 用户端 :3000 / 管理端 :3001）通过 `services/common-paths.js` 定位**同一份** `data/hireme.db`：

- **路径解析优先级**：`HIREME_DB_PATH`（显式覆盖）→ `IA_DATA_ROOT/hireme.db` → `cwd/data/hireme.db` → `__dirname` 上溯兜底
- **统一 PRAGMA**：WAL 模式 / `busy_timeout=5000` / 外键约束 ON
- **表**：`accounts`（账号）、`credit_balances`（积分）、`credit_flows`（流水）、`orders`（订单）、`web_sessions`（会话）、`packages`（套餐）等

> 历史 JSON 数据迁移脚本见 `scripts/`（`migrate-sessions-to-sqlite.js`、`migrate-unified-hireme.js`）。

---

## 安全与稳定性

- **崩溃兜底**：启动时对未捕获异常 / 未处理 Promise 拒绝 / 进程退出全部同步写入 `logs/crashes/desktop-crash-*.log`，并设置 `disable-gpu` / `disable-crashpad` / `no-sandbox` 等 Chromium 参数，解决 Windows 秒退 / crashpad 问题。
- **子进程守卫**：monkey-patch 全部 6 个 `child_process` 创建入口，禁止二次拉起 electron.exe GUI（防 "Unable to find Electron app" 阻塞），需要纯 Node 模式必须显式 `ELECTRON_RUN_AS_NODE=1`。
- **IPC 安全**：`preload.js` 用 `contextBridge` 暴露受控的 `window.electronAPI`，收敛 `ipcRenderer` 通道。
- **密码与会话**：本地账号密码哈希，会话用 Electron `safeStorage` 加密。
- **密钥管理**：全部通过 `.env` / 环境变量注入，不再写死在代码中；`.env` 已被 gitignore。

---

## 常见问题

**Q：启动秒退 / 崩溃？**
查看 `logs/crashes/desktop-crash-*.log` 定位原因；Windows 非管理员 + 老显卡场景已内置 Chromium 兜底参数。

**Q：ASR 无法识别 / 收不到声音？**
确认已配置百度语音密钥（`IA_BAIDU_*`），并在系统音频设置中允许应用采集；音频采集走 WASAPI 系统音频。

**Q：屏幕共享时浮窗可见？**
隐身捕获排除（`capture-exclusion`）只对 Windows 生效（依赖 Win32 `WDA_EXCLUDEFROMCAPTURE`），macOS 暂不支持系统级排除。

**Q：与宣传站点如何联动？**
先启动 `landing/`（`npm start`，端口 3000），桌面端登录即走远端账号 + 积分体系；landing 未启动时自动降级为本地离线使用。

---

## 相关文档

- `landing/README.md` —— 宣传站点 + 用户控制台 + 管理后台（双服务 + SQLite）
- `assets/README.md` —— 前端资产说明
