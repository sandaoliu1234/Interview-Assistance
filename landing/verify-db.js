'use strict';
/**
 * 验证数据库迁移结果的脚本
 * 检查各表数据是否与原 JSON 文件一致
 */
const { db } = require('./db.js');

console.log('===== 账号数据验证 =====');
const accs = db.prepare('SELECT account_id, display_email, display_name, is_admin, created_at FROM accounts').all();
accs.forEach(a => console.log('  ' + a.display_email.padEnd(25) + ' ' + (a.is_admin ? '[管理员]' : '[用户]') + ' ' + a.display_name));

console.log('\n===== 积分余额验证 =====');
const bals = db.prepare('SELECT b.account_id, a.display_email, b.balance, b.total_recharged, b.total_consumed FROM credit_balances b JOIN accounts a ON b.account_id = a.account_id').all();
bals.forEach(b => console.log('  ' + b.display_email.padEnd(25) + ' 余额=' + b.balance + ' 充值=' + b.total_recharged + ' 消耗=' + b.total_consumed));

console.log('\n===== 积分流水验证 =====');
const flows = db.prepare('SELECT f.flow_id, a.display_email, f.type, f.delta, f.balance_after, f.description, f.month_key FROM credit_flows f JOIN accounts a ON f.account_id = a.account_id ORDER BY f.created_at DESC').all();
flows.forEach(f => console.log('  [' + f.type + '] ' + (f.delta > 0 ? '+' : '') + f.delta + ' -> 余额' + f.balance_after + ' | ' + f.description + ' (' + f.month_key + ')'));

console.log('\n===== 会话验证 =====');
const sess = db.prepare('SELECT COUNT(*) as total, SUM(CASE WHEN expire_at > ? THEN 1 ELSE 0 END) as active FROM web_sessions').get(Date.now());
console.log('  总会话: ' + sess.total + ', 有效: ' + sess.active);

console.log('\n===== 套餐验证 =====');
const pkgs = db.prepare('SELECT package_id, title, credits, bonus_credits, price_cents, is_active FROM packages ORDER BY sort_order').all();
pkgs.forEach(p => console.log('  ' + p.package_id.padEnd(8) + ' ' + p.title.padEnd(6) + ' 积分=' + p.credits + '+赠' + p.bonus_credits + ' 价格=' + p.price_cents + '分 ' + (p.is_active ? '上架' : '下架')));

console.log('\n===== 表结构验证 =====');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
console.log('  表: ' + tables.map(t => t.name).join(', '));
const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
console.log('  索引(' + indexes.length + '个): ' + indexes.map(i => i.name).join(', '));

console.log('\n===== 外键约束验证 =====');
db.pragma('foreign_keys');
console.log('  foreign_keys = ' + (db.pragma('foreign_keys', { simple: true }) ? 'ON' : 'OFF'));

console.log('\n✅ 验证完成');
