/**
 * 书库：书籍的导入、解析、书架与阅读进度。
 *
 * 全部数据存在浏览器 IndexedDB（见 storage.ts），没有任何服务器。
 */

import {
  blobGet,
  blobPut,
  blobRemove,
  kvGet,
  kvSet,
} from './storage.ts';

export interface Book {
  id: string;
  title: string;
  author: string;
  format: 'txt' | 'epub' | 'unknown';
  /** blobs 里的键 */
  blobKey: string;
  size: number;
  addedAt: number;
  /** 封面（可选，base64 data URL） */
  cover?: string;
}

export interface Progress {
  bookId: string;
  /** 0..1 的阅读百分比，用于书架排序与显示 */
  fraction: number;
  /** 定位信息：TXT 用字符偏移，EPUB 用章节索引 */
  locator: string;
  updatedAt: number;
}

const BOOKS_KEY = 'reader.books.v1';
const PROGRESS_KEY = 'reader.progress.v1';

// ---------------------------------------------------------------------------
// 书架
// ---------------------------------------------------------------------------

export async function listBooks(): Promise<Book[]> {
  const books = await kvGet<Book[]>(BOOKS_KEY);
  return books ?? [];
}

export async function saveBooks(books: Book[]): Promise<void> {
  await kvSet(BOOKS_KEY, books);
}

export async function getBook(id: string): Promise<Book | undefined> {
  const books = await listBooks();
  return books.find(b => b.id === id);
}

export async function removeBook(id: string): Promise<void> {
  const books = await listBooks();
  const target = books.find(b => b.id === id);
  await saveBooks(books.filter(b => b.id !== id));
  if (target) await blobRemove(target.blobKey);
  const prog = await listProgress();
  delete prog[id];
  await kvSet(PROGRESS_KEY, prog);
}

// ---------------------------------------------------------------------------
// 阅读进度
// ---------------------------------------------------------------------------

export async function listProgress(): Promise<Record<string, Progress>> {
  return (await kvGet<Record<string, Progress>>(PROGRESS_KEY)) ?? {};
}

export async function getProgress(bookId: string): Promise<Progress | undefined> {
  return (await listProgress())[bookId];
}

export async function saveProgress(p: Progress): Promise<void> {
  const all = await listProgress();
  all[p.bookId] = p;
  await kvSet(PROGRESS_KEY, all);
}

// ---------------------------------------------------------------------------
// 导入
// ---------------------------------------------------------------------------

/** 从文件名猜标题（去掉扩展名与常见的下载后缀）。 */
function guessTitle(filename: string): string {
  let name = filename.replace(/\.[^.]+$/, '');
  // 去掉常见的下载站后缀，例如 "书名 (作者) - xxx.com"
  name = name.replace(/\s*[\(\（][^)\）]*[\)\）]\s*$/, '');
  name = name.replace(/[-_]\s*(www\.|http).*$/i, '');
  return name.trim() || filename;
}

/** 判断格式。目前支持 TXT 与 EPUB（EPUB 需要 jszip 解压）。 */
function detectFormat(filename: string, bytes: Uint8Array): Book['format'] {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.epub')) return 'epub';
  if (lower.endsWith('.txt')) return 'txt';
  // EPUB 本质是 ZIP，头两字节是 PK
  if (bytes.length > 2 && bytes[0] === 0x50 && bytes[1] === 0x4b) return 'epub';
  return 'unknown';
}

export interface ImportResult {
  ok: Book[];
  failed: Array<{ name: string; reason: string }>;
}

/**
 * 导入一批文件到本地书库。
 *
 * 逐个处理并收集失败项，而不是遇到一个错误就整体中断 —— 用户一次拖 20 本，
 * 不该因为其中一本格式不对就全部白费。
 */
export async function importFiles(
  files: File[],
  onProgress?: (done: number, total: number, name: string) => void,
): Promise<ImportResult> {
  const books = await listBooks();
  const ok: Book[] = [];
  const failed: ImportResult['failed'] = [];

  let done = 0;
  for (const file of files) {
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      const format = detectFormat(file.name, buf);
      if (format === 'unknown') {
        failed.push({ name: file.name, reason: '不支持的格式（目前支持 TXT / EPUB）' });
        done++;
        onProgress?.(done, files.length, file.name);
        continue;
      }

      const id = crypto.randomUUID();
      const blobKey = `book:${id}`;
      await blobPut(blobKey, buf);

      const book: Book = {
        id,
        title: guessTitle(file.name),
        author: '',
        format,
        blobKey,
        size: buf.byteLength,
        addedAt: Date.now(),
      };

      // EPUB 尝试读取元数据（标题/作者/封面）
      if (format === 'epub') {
        try {
          const meta = await readEpubMeta(buf);
          if (meta.title) book.title = meta.title;
          if (meta.author) book.author = meta.author;
          if (meta.cover) book.cover = meta.cover;
        } catch {
          // 元数据读不出来不影响阅读，继续
        }
      }

      books.push(book);
      ok.push(book);
    } catch (err) {
      failed.push({ name: file.name, reason: err instanceof Error ? err.message : '读取失败' });
    }
    done++;
    onProgress?.(done, files.length, file.name);
  }

  await saveBooks(books);
  return { ok, failed };
}

// ---------------------------------------------------------------------------
// EPUB 解析
// ---------------------------------------------------------------------------

interface EpubMeta {
  title?: string;
  author?: string;
  cover?: string;
}

/** 解析 EPUB 的 container.xml → OPF，取出标题、作者、封面。 */
async function readEpubMeta(bytes: Uint8Array): Promise<EpubMeta> {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(bytes);

  const containerFile = zip.file('META-INF/container.xml');
  if (!containerFile) throw new Error('不是有效的 EPUB');
  const container = await containerFile.async('string');
  const opfPath = /full-path="([^"]+)"/.exec(container)?.[1];
  if (!opfPath) throw new Error('EPUB 缺少 OPF 路径');

  const opfFile = zip.file(opfPath);
  if (!opfFile) throw new Error('EPUB 缺少 OPF 文件');
  const opf = await opfFile.async('string');

  const meta: EpubMeta = {};
  meta.title = /<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i.exec(opf)?.[1]?.trim();
  meta.author = /<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i.exec(opf)?.[1]?.trim();

  // 封面：优先找 properties="cover-image" 的 item
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  let coverHref = /<item[^>]*properties="[^"]*cover-image[^"]*"[^>]*href="([^"]+)"/i.exec(opf)?.[1];
  if (!coverHref) {
    // 退化：通过 <meta name="cover" content="id"> 找
    const coverId = /<meta[^>]*name="cover"[^>]*content="([^"]+)"/i.exec(opf)?.[1];
    if (coverId) {
      const re = new RegExp(`<item[^>]*id="${coverId}"[^>]*href="([^"]+)"`, 'i');
      coverHref = re.exec(opf)?.[1];
    }
  }
  if (coverHref) {
    const coverFile = zip.file(opfDir + decodeURIComponent(coverHref));
    if (coverFile) {
      const base64 = await coverFile.async('base64');
      const ext = coverHref.split('.').pop()?.toLowerCase() ?? 'jpeg';
      const mime = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : 'image/jpeg';
      meta.cover = `data:${mime};base64,${base64}`;
    }
  }
  return meta;
}

/**
 * 读取一本书的正文内容。
 * TXT 直接按编码解码；EPUB 这里只取纯文本（阅读界面要排版另做）。
 */
export async function readBookText(book: Book): Promise<string> {
  const bytes = await blobGet(book.blobKey);
  if (!bytes) throw new Error('书籍文件已丢失');

  if (book.format === 'txt') return decodeText(bytes);
  if (book.format === 'epub') return extractEpubText(bytes);
  throw new Error('不支持的格式');
}

/**
 * 解码 TXT。
 *
 * 中文电子书大量是 GBK 编码，而浏览器默认按 UTF-8 解，会全是乱码。
 * 这里先按 UTF-8 试解，发现替换字符（U+FFFD）就改用 GBK。
 */
function decodeText(bytes: Uint8Array): string {
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  const bad = (utf8.match(/\uFFFD/g) ?? []).length;
  // 少量替换字符可能只是原文如此；比例超过 1% 就认为是编码判断错了
  if (bad > 0 && bad / Math.max(1, utf8.length) > 0.01) {
    for (const enc of ['gbk', 'gb18030', 'big5']) {
      try {
        const alt = new TextDecoder(enc, { fatal: false }).decode(bytes);
        const altBad = (alt.match(/\uFFFD/g) ?? []).length;
        if (altBad < bad) return alt;
      } catch {
        // 浏览器不支持这个编码，试下一个
      }
    }
  }
  return utf8;
}

/** 从 EPUB 里提取纯文本。 */
async function extractEpubText(bytes: Uint8Array): Promise<string> {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(bytes);

  const containerFile = zip.file('META-INF/container.xml');
  if (!containerFile) throw new Error('不是有效的 EPUB');
  const opfPath = /full-path="([^"]+)"/.exec(await containerFile.async('string'))?.[1];
  if (!opfPath) throw new Error('EPUB 缺少 OPF 路径');
  const opfFile = zip.file(opfPath);
  if (!opfFile) throw new Error('EPUB 缺少 OPF 文件');
  const opf = await opfFile.async('string');

  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';

  // 按 spine 顺序取出章节文件
  const manifest = new Map<string, string>();
  for (const m of opf.matchAll(/<item\b[^>]*>/gi)) {
    const tag = m[0];
    const id = /\bid="([^"]+)"/.exec(tag)?.[1];
    const href = /\bhref="([^"]+)"/.exec(tag)?.[1];
    if (id && href) manifest.set(id, href);
  }
  const order: string[] = [];
  for (const m of opf.matchAll(/<itemref\b[^>]*idref="([^"]+)"/gi)) {
    const idref = m[1];
    if (!idref) continue;
    const href = manifest.get(idref);
    if (href) order.push(href);
  }
  if (order.length === 0) order.push(...manifest.values());

  const parts: string[] = [];
  for (const href of order) {
    const f = zip.file(opfDir + decodeURIComponent(href));
    if (!f) continue;
    const html = await f.async('string');
    parts.push(htmlToText(html));
  }
  return parts.join('\n\n');
}

/** 极简 HTML → 纯文本（保留段落换行）。 */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/li)\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 人类可读的体积。 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
