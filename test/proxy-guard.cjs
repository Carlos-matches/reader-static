/**
 * 测试代理函数的 SSRF 防护逻辑。
 *
 * 内网地址必须拦截（否则可能被当成跳板读取云元数据），
 * 公网地址必须放行（否则书源搜不了）。
 */

const path = require('node:path');
const fs = require('node:fs');

// 从 proxy.ts 里抽出 isBlockedHost 的实现来测（避免复制一份导致不同步）
const src = fs.readFileSync(path.join(__dirname, '..', 'netlify', 'functions', 'proxy.ts'), 'utf8');
const start = src.indexOf('function isBlockedHost');
const end = src.indexOf('\n}', start) + 2;
if (start < 0 || end < 2) {
  console.error('❌ 无法从 proxy.ts 中提取 isBlockedHost');
  process.exit(1);
}
const body = src
  .slice(start, end)
  // 源码是 TypeScript，这里剥掉类型标注，好在纯 Node 里执行；
  // 这样测的就是 proxy.ts 里的真实实现，不会出现两份逻辑不同步。
  .replace(/\(hostname: string\): boolean/, '(hostname)');

// 用 Function 构造出来（源码是纯函数，无外部依赖）
const isBlockedHost = new Function(`${body}; return isBlockedHost;`)();

const mustBlock = [
  ['localhost', '本机名'],
  ['127.0.0.1', 'IPv4 回环'],
  ['10.0.0.5', '私有段 10/8'],
  ['172.16.0.1', '私有段 172.16/12'],
  ['172.31.255.254', '私有段 172.16/12 上界'],
  ['192.168.1.1', '私有段 192.168/16'],
  ['169.254.169.254', '云元数据服务（关键）'],
  ['0.0.0.0', '通配地址'],
  ['::1', 'IPv6 回环'],
  ['[::1]', 'IPv6 回环（带方括号）'],
  ['100.64.0.1', '运营商级 NAT'],
  ['fe80::1', 'IPv6 链路本地'],
  ['fc00::1', 'IPv6 唯一本地'],
  ['foo.localhost', 'localhost 子域'],
];

const mustAllow = [
  ['example.com', '普通域名'],
  ['www.baidu.com', '国内域名'],
  ['8.8.8.8', '公网 IP'],
  ['api.example.org', '普通域名'],
  ['172.32.0.1', '172.32 不在私有段内'],
  ['192.169.1.1', '192.169 不在私有段内'],
];

let failed = 0;

console.log('=== 必须拦截（内网/危险）===');
for (const [host, why] of mustBlock) {
  const blocked = isBlockedHost(host);
  if (!blocked) failed++;
  console.log(`  ${blocked ? '✅' : '❌'} ${host.padEnd(20)} ${why}`);
}

console.log('\n=== 必须放行（公网）===');
for (const [host, why] of mustAllow) {
  const blocked = isBlockedHost(host);
  if (blocked) failed++;
  console.log(`  ${blocked ? '❌' : '✅'} ${host.padEnd(20)} ${why}`);
}

console.log('');
if (failed === 0) {
  console.log(`✅ SSRF 防护正确：拦截 ${mustBlock.length} 项，放行 ${mustAllow.length} 项`);
  process.exit(0);
}
console.log(`❌ ${failed} 项判定错误`);
process.exit(1);
