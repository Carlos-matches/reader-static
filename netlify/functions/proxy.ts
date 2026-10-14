/**
 * Netlify 函数：CORS 代理。
 *
 * 【为什么必须有这个】
 * 浏览器同源策略会拦截网页对第三方书源站点的请求，因为对方不返回
 * Access-Control-Allow-Origin。这个函数运行在 Netlify 的服务器上，
 * 不受同源策略限制，由它代为请求，再把结果原样带回浏览器。
 *
 * 【安全限制（重要）】
 * 这是一个开放代理，如果不加限制，可能被人用来当成跳板攻击其他站点。
 * 所以这里做了三件事：
 *   1. 只允许 GET
 *   2. 只允许 http/https 协议
 *   3. 拒绝指向内网/本机的地址（防 SSRF）
 *
 * 【无状态】
 * Netlify 函数是无状态的：它不保存任何数据，只是转发。
 * 所有用户数据都存在浏览器 IndexedDB 里。
 */

const MAX_BYTES = 5 * 1024 * 1024; // 单个响应最大 5MB，防止被大文件拖垮
const TIMEOUT_MS = 15000;

/**
 * 判断目标地址是否是内网/本机。
 * 防止有人用 ?url=http://169.254.169.254/... 去读云厂商的元数据接口。
 */
function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (h === 'localhost' || h === '0.0.0.0' || h.endsWith('.localhost')) return true;
  if (h === '::1' || h === '::') return true;
  // IPv6 私有段
  if (h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true;

  // IPv4 字面量
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10) return true;                        // 10.0.0.0/8
    if (a === 127) return true;                       // 回环
    if (a === 169 && b === 254) return true;          // 链路本地 / 云元数据
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true;          // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true;// 运营商级 NAT
    if (a === 0) return true;
  }
  return false;
}

export default async function handler(req: Request): Promise<Response> {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }
  if (req.method !== 'GET') {
    return Response.json({ error: '只支持 GET' }, { status: 405, headers: cors });
  }

  const target = new URL(req.url).searchParams.get('url');
  if (!target) {
    return Response.json({ error: '缺少 url 参数' }, { status: 400, headers: cors });
  }

  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return Response.json({ error: 'url 格式不正确' }, { status: 400, headers: cors });
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return Response.json({ error: '只支持 http/https' }, { status: 400, headers: cors });
  }
  if (isBlockedHost(parsed.hostname)) {
    return Response.json({ error: '不允许访问内网地址' }, { status: 403, headers: cors });
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const upstream = await fetch(parsed.toString(), {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        // 很多书源会检查 UA/Referer，伪装成普通浏览器请求
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        Referer: `${parsed.protocol}//${parsed.host}/`,
      },
    });

    // 限制响应体积
    const len = Number(upstream.headers.get('content-length') ?? 0);
    if (len > MAX_BYTES) {
      return Response.json(
        { error: `响应过大（${Math.round(len / 1024 / 1024)}MB）` },
        { status: 413, headers: cors },
      );
    }

    const body = await upstream.arrayBuffer();
    if (body.byteLength > MAX_BYTES) {
      return Response.json({ error: '响应过大' }, { status: 413, headers: cors });
    }

    return new Response(body, {
      status: upstream.status,
      headers: {
        ...cors,
        'Content-Type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
        // 书源搜索结果缓存 5 分钟，减少重复请求
        'Cache-Control': 'public, max-age=300',
      },
    });
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    return Response.json(
      { error: aborted ? `请求超时（${TIMEOUT_MS / 1000}秒）` : '代理请求失败' },
      { status: aborted ? 504 : 502, headers: cors },
    );
  } finally {
    clearTimeout(timer);
  }
}

export const config = { path: '/api/proxy' };
