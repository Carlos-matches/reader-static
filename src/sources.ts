/**
 * 书源搜索。
 *
 * 【为什么需要代理】
 * 浏览器有同源策略：网页直接请求第三方书源网站会被 CORS 拦截，
 * 因为那些网站不会返回 Access-Control-Allow-Origin 头。
 *
 * 所以请求先发到 Netlify 函数（同源，不受限），由它转发到书源网站，
 * 再把结果带回来。这就是 MoonTV 的做法。
 *
 * 【开发环境】
 * vite 的 dev server 配了 /api/proxy 转发，见 vite.config.ts。
 */

import { kvGet, kvSet } from './storage.ts';

export interface SearchResult {
  /** 书源名 */
  source: string;
  name: string;
  author: string;
  /** 详情页地址（相对书源） */
  url: string;
  cover?: string;
  intro?: string;
  kind?: string;
  lastChapter?: string;
}
export interface BookSource {
  id: string;
  name: string;
  /** 搜索接口，{keyword} 会被替换 */
  searchUrl: string;
  /** 详情页前缀（有些书源返回相对路径） */
  baseUrl?: string;
  enabled: boolean;
}

const SOURCES_KEY = 'reader.sources.v1';

/** 内置几个公开的「苹果 CMS V10」格式书源，开箱可用。 */
export const BUILTIN_SOURCES: BookSource[] = [
  {
    id: 'builtin-1',
    name: '示例源（苹果CMS格式）',
    searchUrl: 'https://www.example-cms.com/api.php/provide/vod/?ac=videolist&wd={keyword}',
    enabled: false,
  },
];

export async function listSources(): Promise<BookSource[]> {
  const raw = await kvGet<BookSource[]>(SOURCES_KEY);
  return raw ?? [];
}

export async function saveSources(sources: BookSource[]): Promise<void> {
  await kvSet(SOURCES_KEY, sources);
}

// ---------------------------------------------------------------------------
// 代理
// ---------------------------------------------------------------------------

/**
 * 开发环境直接走 vite 代理；生产环境走 Netlify 函数。
 * 两者路径都统一成 /api/proxy?url=...
 */
function proxyUrl(target: string): string {
  return `/api/proxy?url=${encodeURIComponent(target)}`;
}

/** 带超时和重试的抓取。 */
async function fetchWithRetry(
  url: string,
  { timeoutMs = 12000, retries = 2 }: { timeoutMs?: number; retries?: number } = {},
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(proxyUrl(url), { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      // 最后一次失败就不用再等了
      if (attempt < retries) await new Promise(r => setTimeout(r, 600 * (attempt + 1)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('请求失败');
}

// ---------------------------------------------------------------------------
// 搜索
// ---------------------------------------------------------------------------

/** 搜索单个书源。 */
export async function searchSource(source: BookSource, keyword: string): Promise<SearchResult[]> {
  const url = source.searchUrl.replace('{keyword}', encodeURIComponent(keyword));
  const res = await fetchWithRetry(url);
  const text = await res.text();

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('书源返回的不是 JSON（可能已失效）');
  }

  const list = (data as { list?: unknown[] })?.list;
  if (!Array.isArray(list)) {
    // 有些书源直接返回数组
    if (Array.isArray(data)) return normalize(data as unknown[], source);
    throw new Error('书源返回格式无法识别');
  }
  return normalize(list, source);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalize(items: any[], source: BookSource): SearchResult[] {
  const out: SearchResult[] = [];
  for (const item of items) {
    const name = String(item?.vod_name ?? item?.name ?? '').trim();
    if (!name) continue;
    out.push({
      source: source.name,
      name,
      author: String(item.vod_actor ?? item.author ?? '').trim(),
      url: String(item.vod_id ?? item.url ?? ''),
      cover: String(item.vod_pic ?? item.cover ?? '') || undefined,
      intro:
        String(item.vod_content ?? item.intro ?? '')
          .replace(/<[^>]+>/g, '')
          .slice(0, 200) || undefined,
      kind: String(item.vod_class ?? item.kind ?? '') || undefined,
      lastChapter: String(item.vod_remarks ?? item.lastChapter ?? '') || undefined,
    });
  }
  return out;
}

export interface AggregatedSearch {
  results: SearchResult[];
  errors: Array<{ source: string; reason: string }>;
}

/**
 * 并发搜索多个书源。
 *
 * 用「谁先返回谁先上」的方式：每个源完成就立刻回调，而不是等全部完成。
 * 书源经常有慢的或挂掉的，等最慢的会让用户以为界面卡死。
 */
export async function searchAll(
  sources: BookSource[],
  keyword: string,
  onPartial?: (r: SearchResult[]) => void,
): Promise<AggregatedSearch> {
  const enabled = sources.filter(s => s.enabled);
  const results: SearchResult[] = [];
  const errors: AggregatedSearch['errors'] = [];

  await Promise.all(
    enabled.map(async source => {
      try {
        const r = await searchSource(source, keyword);
        if (r.length) {
          results.push(...r);
          onPartial?.([...results]);
        }
      } catch (err) {
        errors.push({ source: source.name, reason: err instanceof Error ? err.message : '失败' });
      }
    }),
  );

  return { results, errors };
}

// ---------------------------------------------------------------------------
// 书源导入 / 导出
// ---------------------------------------------------------------------------

/**
 * 从 JSON 导入书源。
 *
 * 兼容两种常见格式：
 *   1. reader/legado 导出的书源（字段多，取 bookSourceName / bookSourceUrl）
 *   2. 本项目的简洁格式
 */
export function parseSources(json: string): BookSource[] {
  const data = JSON.parse(json);
  const arr = Array.isArray(data) ? data : [data];
  const out: BookSource[] = [];

  arr.forEach((raw, i) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = raw as any;
    if (!s) return;

    // legado 格式
    if (s.bookSourceUrl) {
      const base = String(s.bookSourceUrl);
      out.push({
        id: `imported-${Date.now()}-${i}`,
        name: String(s.bookSourceName ?? `书源${i + 1}`),
        searchUrl: base.includes('{keyword}')
          ? base
          : base.replace(/\/+$/, '') + '/api.php/provide/vod/?ac=videolist&wd={keyword}',
        baseUrl: base,
        enabled: false,
      });
      return;
    }

    // 简洁格式
    if (s.name && s.searchUrl) {
      out.push({
        id: String(s.id ?? `imported-${Date.now()}-${i}`),
        name: String(s.name),
        searchUrl: String(s.searchUrl),
        baseUrl: s.baseUrl ? String(s.baseUrl) : undefined,
        enabled: s.enabled === true,
      });
    }
  });

  return out;
}
