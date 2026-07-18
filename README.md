# 面试助手 - Interview Assistant

一款智能面试辅助工具，实时提供答题思路，支持多种面试场景。

## 功能特点

- 🎯 **多场景支持**：行为面试、技术面试、编程面试
- 🎤 **语音识别**：自动将面试官的语音转为文字
- 🤖 **AI智能答题**：基于国内大语言模型生成专业答题思路
- 📱 **桌面应用**：基于Electron开发的Windows桌面应用
- 📝 **历史记录**：保存面试记录，方便复盘
- 🎨 **美观界面**：简洁现代的用户界面
- 🔝 **窗口置顶**：面试时始终保持在最上层

## 技术栈

- **前端框架**：Electron + HTML/CSS/JavaScript
- **语音识别**：百度语音识别 API
- **AI服务**：
  - 文心一言
  - 智谱AI
  - 通义千问

## 安装步骤

1. 克隆或下载项目
2. 安装依赖：
   ```bash
   npm install
   ```

3. 配置API密钥：
   - 启动应用后点击设置按钮
   - 配置百度语音识别的API Key和Secret Key
   - 配置至少一个AI服务的API密钥

## 使用说明

### 1. 启动应用

```bash
npm start
```

### 2. 配置API

首次使用需要配置：
- **百度语音识别**：用于语音转文字
- **AI服务**：选择一个国内大语言模型（文心一言/智谱AI/通义千问）

### 3. 开始使用

1. 选择面试场景（行为/技术/编程）
2. 点击"开始录音"按钮，录制面试官的问题
3. 停止录音后，系统会自动识别语音
4. 点击"生成答题思路"获取AI建议
5. 查看并参考答题内容

## 项目结构

```
Interview Assistance/
├── main.js              # Electron主进程
├── renderer.js          # 渲染进程逻辑
├── index.html           # 主页面
├── styles.css           # 样式文件
├── package.json         # 项目配置
├── services/
│   ├── speechService.js # 语音识别服务
│   ├── aiService.js     # AI答题服务
│   └── audioRecorder.js # 录音服务
└── assets/              # 资源文件
```

## 开发模式

启动开发模式（会自动打开开发者工具）：

```bash
npm run dev
```

## 打包应用

打包成Windows安装包：

```bash
npm run build
```

## API申请指南

### 百度语音识别

1. 访问 [百度智能云](https://cloud.baidu.com/)
2. 注册账号并登录
3. 开通"语音识别"服务
4. 创建应用获取API Key和Secret Key

### 文心一言

1. 访问 [百度智能云千帆平台](https://cloud.baidu.com/product/wenxinworkshop)
2. 开通服务并创建应用
3. 获取API Key

### 智谱AI

1. 访问 [智谱AI开放平台](https://open.bigmodel.cn/)
2. 注册账号并登录
3. 创建API Key

### 通义千问

1. 访问 [阿里云百炼平台](https://bailian.console.aliyun.com/)
2. 开通服务并创建API Key

## 注意事项

- 请确保网络连接正常，需要调用云端API
- 录音功能需要麦克风权限
- 建议在安静环境下使用以获得更好的识别效果
- API密钥请妥善保管，不要分享给他人

## 许可证

MIT License
