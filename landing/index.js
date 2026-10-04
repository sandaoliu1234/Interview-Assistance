/**
 * landing/index.js —— 双服务主入口
 *
 * 同时启动：
 *   1. 用户端服务 (port 3000) —— user-server.js
 *      处理 index.html / console.html / login.html + /api/auth/* + /api/console/*
 *   2. 管理员端服务 (port 3001) —— admin-server.js
 *      处理 admin.html + /api/auth/* + /api/admin/*
 *
 * 启动：
 *   node index.js
 *
 * 也可单独启动：
 *   node user-server.js   # 仅用户端
 *   node admin-server.js  # 仅管理员端
 */
'use strict';

const path = require('path');

console.log('');
console.log('╔══════════════════════════════════════════════╗');
console.log('║   Interview Assist AI 面试助手 · 双服务统一启动器       ║');
console.log('║                                              ║');
console.log('║   用户端:  http://localhost:3000             ║');
console.log('║   管理端:  http://localhost:3001             ║');
console.log('╚══════════════════════════════════════════════╝');
console.log('');

// 动态 require 两个子服务（它们各自会绑定端口并打印启动信息）
// 使用 require 而非 fork，便于在同一进程内共享 AuthService 和文件句柄
// 注意：两个服务共享同一份 data/ 目录下的 JSON 文件，
//       但串行写队列 (enqueueWriteAtomic) 是 shared.js 模块级的，
//       由于 Node.js 的 require 缓存，两个服务器实例会共享同一个写队列，
//       保证跨服务的并发写入安全。

require('./user-server.js');
// user-server.js 在 require 时就开始监听端口并打印启动信息
// 由于 require 是同步的，user-server 先初始化，admin-server 紧随其后
// 两个服务器独立运行互不干扰

require('./admin-server.js');

console.log('');
console.log('[index] 两个服务均已启动，正在监听请求...');
console.log('[index] 数据目录: 共享 ' + path.resolve(__dirname, 'data'));
console.log('[index] 提示: 管理员端需要单独登录 (管理员账号)');
console.log('[index] 停止: Ctrl + C (同时终止两个服务)');

// 当进程退出时优雅关闭
process.on('SIGINT', () => {
  console.log('\n[index] 收到 SIGINT，正在关闭...');
  process.exit(0);
});
process.on('SIGTERM', () => {
  console.log('\n[index] 收到 SIGTERM，正在关闭...');
  process.exit(0);
});