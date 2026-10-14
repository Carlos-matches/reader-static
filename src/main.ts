/**
 * 应用主入口：一个极简的本地阅读器。
 *
 * 全部数据（书、进度、书源）都存在浏览器 IndexedDB，没有任何服务器。
 * Netlify 只托管静态文件 + 一个转发书源请求的无状态函数。
 */

import './style.css';
import {
  type Book,
  formatSize,
  getProgress,
  importFiles,
  listBooks,
  listProgress,
  readBookText,
  removeBook,
  saveProgress,
  getBook,
} from './library.ts';
import {
  blobSize,
  exportAll,
  importAll,
  requestPersistence,
  storageEstimate,
  totalUsage,
  wipeAll,
} from './storage.ts';
import {
  type BookSource,
  type SearchResult,
  listSources,
  parseSources,
  saveSources,
  searchAll,
} from './sources.ts';

const app = document.getElementById('app')!;

type View = 'shelf' | 'read' | 'search' | 'sources' | 'settings';
let view: View = 'shelf';
let currentBook: Book | null = null;
let currentText = '';
let searchResults: SearchResult[] = [];
let searchErrors: Array<{ source: string; reason: string }> = [];
let searching = false;

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s.replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

function toast(msg: string, kind: 'info' | 'error' = 'info'): void {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), kind === 'error' ? 5000 : 2600);
}

// ---------------------------------------------------------------------------
// 书架
// ---------------------------------------------------------------------------

async function renderShelf(): Promise<void> {
  const [books, progress, used, est] = await Promise.all([
    listBooks(),
    listProgress(),
    totalUsage(),
    storageEstimate(),
  ]);

  const quotaText = est.quota
    ? `已用 ${formatSize(used)} / 可用约 ${formatSize(est.quota)}`
    : `已用 ${formatSize(used)}`;

  const cards = await Promise.all(
    books.map(async b => {
      const p = progress[b.id];
      const pct = p ? Math.round(p.fraction * 100) : 0;
      const lbl = p && pct > 0 ? `${pct}%` : '未读';
      return `
        <div class="card" data-open="${esc(b.id)}">
          <div class="cover">
            ${b.cover ? `<img src="${b.cover}" alt="">` : `<span class="ph">${esc(b.format.toUpperCase())}</span>`}
          </div>
          <div class="card-body">
            <div class="title">${esc(b.title)}</div>
            <div class="meta">${b.author ? esc(b.author) + ' · ' : ''}${formatSize(b.size)} · ${lbl}</div>
            <div class="bar"><i style="width:${pct}%"></i></div>
          </div>
          <button class="del" data-del="${esc(b.id)}" title="删除">×</button>
        </div>`;
    }),
  );

  app.innerHTML = `
    <header>
      <h1>我的书架</h1>
      <nav>
        <button data-view="search">搜书</button>
        <button data-view="sources">书源</button>
        <button data-view="settings">设置</button>
      </nav>
    </header>
    <main>
      <div class="dropzone" id="drop">
        <p><strong>点击选择</strong> 或把书籍文件拖到这里</p>
        <p class="hint">支持 TXT / EPUB 　·　${esc(quotaText)}</p>
        <input type="file" id="file" multiple accept=".txt,.epub" hidden />
      </div>
      ${books.length ? `<div class="grid">${cards.join('')}</div>` : `<p class="empty">书架还是空的，先导入一本书吧</p>`}
    </main>
  `;

  // 事件绑定
  const dz = document.getElementById('drop')!;
  const input = document.getElementById('file') as HTMLInputElement;
  dz.onclick = () => input.click();
  input.onchange = () => void doImport([...(input.files ?? [])]);

  dz.ondragover = e => {
    e.preventDefault();
    dz.classList.add('over');
  };
  dz.ondragleave = () => dz.classList.remove('over');
  dz.ondrop = e => {
    e.preventDefault();
    dz.classList.remove('over');
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length) void doImport(files);
  };

  app.querySelectorAll('[data-view]').forEach(b => {
    (b as HTMLElement).onclick = () => {
      view = (b as HTMLElement).dataset.view as View;
      void render();
    };
  });

  app.querySelectorAll('[data-open]').forEach(el => {
    (el as HTMLElement).onclick = ev => {
      if ((ev.target as HTMLElement).dataset.del) return;
      void openBook((el as HTMLElement).dataset.open!);
    };
  });

  app.querySelectorAll('[data-del]').forEach(el => {
    (el as HTMLElement).onclick = async ev => {
      ev.stopPropagation();
      const id = (el as HTMLElement).dataset.del!;
      const b = books.find(x => x.id === id);
      if (!b) return;
      if (!confirm(`删除《${b.title}》？此操作不可恢复。`)) return;
      await removeBook(id);
      toast('已删除');
      void render();
    };
  });
}

async function doImport(files: File[]): Promise<void> {
  const dz = document.getElementById('drop');
  const setStatus = (t: string) => {
    if (dz) dz.innerHTML = `<p><strong>${esc(t)}</strong></p>`;
  };
  setStatus(`正在导入 0/${files.length}…`);

  const res = await importFiles(files, (done, total, name) => {
    setStatus(`正在导入 ${done}/${total}：${name}`);
  });

  if (res.ok.length) toast(`成功导入 ${res.ok.length} 本`);
  if (res.failed.length) {
    toast(`${res.failed.length} 本失败：${res.failed.map(f => f.name).join('、')}`, 'error');
  }
  void render();
}

// ---------------------------------------------------------------------------
// 阅读
// ---------------------------------------------------------------------------

async function openBook(id: string): Promise<void> {
  const book = await getBook(id);
  if (!book) return;
  currentBook = book;
  view = 'read';
  app.innerHTML = `<div class="loading">正在打开《${esc(book.title)}》…</div>`;
  try {
    currentText = await readBookText(book);
    await renderReader();
  } catch (err) {
    app.innerHTML = `<div class="loading">打开失败：${esc(err instanceof Error ? err.message : '未知错误')}</div>`;
  }
}

async function renderReader(): Promise<void> {
  if (!currentBook) return;
  const p = await getProgress(currentBook.id);
  const start = p ? Number(p.locator) || 0 : 0;

  // 按段落切分，便于分页/定位
  const paragraphs = currentText.split(/\n+/).filter(x => x.trim());

  app.innerHTML = `
    <header class="reader-head">
      <button id="back">← 返回</button>
      <span class="rt">${esc(currentBook.title)}</span>
      <span class="rp" id="pct"></span>
    </header>
    <div class="reader" id="reader">
      ${paragraphs.map((t, i) => `<p data-i="${i}">${esc(t)}</p>`).join('')}
    </div>
    <div class="reader-foot">
      <button id="font-">A-</button>
      <button id="font+">A+</button>
      <button id="top">回到顶部</button>
    </div>
  `;

  const reader = document.getElementById('reader')!;
  const pctEl = document.getElementById('pct')!;

  // 恢复位置
  requestAnimationFrame(() => {
    if (start > 0) reader.scrollTop = start;
  });

  // 字号
  let fontSize = Number(localStorage.getItem('reader.fontSize') ?? 18);
  const applyFont = () => {
    reader.style.fontSize = `${fontSize}px`;
    localStorage.setItem('reader.fontSize', String(fontSize));
  };
  applyFont();
  document.getElementById('font-')!.onclick = () => {
    fontSize = Math.max(12, fontSize - 2);
    applyFont();
  };
  document.getElementById('font+')!.onclick = () => {
    fontSize = Math.min(32, fontSize + 2);
    applyFont();
  };
  document.getElementById('top')!.onclick = () => reader.scrollTo({ top: 0, behavior: 'smooth' });

  // 保存进度（节流，避免滚动时疯狂写盘）
  let saveTimer: number | undefined;
  const persist = () => {
    const max = reader.scrollHeight - reader.clientHeight;
    const frac = max > 0 ? Math.min(1, reader.scrollTop / max) : 0;
    pctEl.textContent = `${Math.round(frac * 100)}%`;
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      void saveProgress({
        bookId: currentBook!.id,
        fraction: frac,
        locator: String(Math.round(reader.scrollTop)),
        updatedAt: Date.now(),
      });
    }, 400);
  };
  reader.onscroll = persist;
  persist();

  document.getElementById('back')!.onclick = () => {
    view = 'shelf';
    void render();
  };
}

// ---------------------------------------------------------------------------
// 搜书
// ---------------------------------------------------------------------------

async function renderSearch(): Promise<void> {
  const sources = await listSources();
  const enabled = sources.filter(s => s.enabled).length;

  const rows = searchResults
    .map(
      (r, i) => `
      <div class="result">
        <div class="rname">${esc(r.name)}</div>
        <div class="rmeta">${esc(r.author || '佚名')} · ${esc(r.source)}</div>
        ${r.lastChapter ? `<div class="rlast">${esc(r.lastChapter)}</div>` : ''}
        <button class="copy" data-copy="${i}">复制书名</button>
      </div>`,
    )
    .join('');

  const errHtml = searchErrors.length
    ? `<div class="errs">${searchErrors.map(e => `<div>✗ ${esc(e.source)}：${esc(e.reason)}</div>`).join('')}</div>`
    : '';

  app.innerHTML = `
    <header>
      <button id="back">← 返回</button>
      <h1>搜书</h1>
    </header>
    <main>
      <div class="searchbar">
        <input id="kw" placeholder="输入书名或作者" />
        <button id="go" ${searching ? 'disabled' : ''}>${searching ? '搜索中…' : '搜索'}</button>
      </div>
      <p class="hint">
        已启用 ${enabled} 个书源。
        ${enabled === 0 ? '<a href="#" id="toSources">去添加书源 →</a>' : ''}
      </p>
      <p class="hint">提示：搜索走 Netlify 函数转发（绕过浏览器跨域限制）。书源失效是常态，多准备几个。</p>
      ${errHtml}
      <div class="results">${rows || (searching ? '' : '<p class="empty">还没有结果</p>')}</div>
    </main>
  `;

  document.getElementById('back')!.onclick = () => {
    view = 'shelf';
    void render();
  };
  const toS = document.getElementById('toSources');
  if (toS) {
    toS.onclick = e => {
      e.preventDefault();
      view = 'sources';
      void render();
    };
  }

  const kw = document.getElementById('kw') as HTMLInputElement;
  kw.value = sessionStorage.getItem('reader.lastKw') ?? '';
  const go = async () => {
    const q = kw.value.trim();
    if (!q) return;
    sessionStorage.setItem('reader.lastKw', q);
    searching = true;
    searchResults = [];
    searchErrors = [];
    await renderSearch();
    const all = await listSources();
    const agg = await searchAll(all, q, partial => {
      searchResults = partial;
      void renderSearch();
    });
    searchResults = agg.results;
    searchErrors = agg.errors;
    searching = false;
    await renderSearch();
    if (!agg.results.length && !agg.errors.length) toast('没有结果，可能是书源未启用或已失效', 'error');
  };
  document.getElementById('go')!.onclick = () => void go();
  kw.onkeydown = e => {
    if (e.key === 'Enter') void go();
  };

  app.querySelectorAll('[data-copy]').forEach(el => {
    (el as HTMLElement).onclick = () => {
      const r = searchResults[Number((el as HTMLElement).dataset.copy)];
      if (!r) return;
      void navigator.clipboard.writeText(r.name).then(
        () => toast('已复制书名'),
        () => toast('复制失败，请手动选择', 'error'),
      );
    };
  });
}

// ---------------------------------------------------------------------------
// 书源
// ---------------------------------------------------------------------------

async function renderSources(): Promise<void> {
  const sources = await listSources();
  const rows = sources
    .map(
      s => `
      <div class="src">
        <label>
          <input type="checkbox" data-tog="${esc(s.id)}" ${s.enabled ? 'checked' : ''} />
          <span class="sname">${esc(s.name)}</span>
        </label>
        <button class="del" data-rm="${esc(s.id)}">×</button>
      </div>`,
    )
    .join('');

  app.innerHTML = `
    <header>
      <button id="back">← 返回</button>
      <h1>书源管理</h1>
    </header>
    <main>
      <p class="hint">
        书源决定你能搜到哪些书。勾选启用后即可在「搜书」页使用。
        书源失效很常见，建议多导入几个。
      </p>
      <div class="import-box">
        <textarea id="json" placeholder='粘贴书源 JSON，例如：&#10;[{"name":"我的源","searchUrl":"https://xxx.com/api.php/provide/vod/?ac=videolist&wd={keyword}"}]'></textarea>
        <div class="row">
          <button id="add">添加</button>
          <label class="filebtn">从文件导入<input type="file" id="srcfile" accept=".json,.txt" hidden /></label>
        </div>
      </div>
      ${sources.length ? `<div class="srclist">${rows}</div>` : '<p class="empty">还没有书源</p>'}
    </main>
  `;

  document.getElementById('back')!.onclick = () => {
    view = 'shelf';
    void render();
  };

  document.getElementById('add')!.onclick = async () => {
    const ta = document.getElementById('json') as HTMLTextAreaElement;
    const txt = ta.value.trim();
    if (!txt) return toast('请先粘贴内容', 'error');
    try {
      const parsed = parseSources(txt);
      if (!parsed.length) return toast('没有解析到有效书源', 'error');
      // 合并去重（按名字）
      const cur = await listSources();
      const names = new Set(cur.map(s => s.name));
      const merged = [...cur, ...parsed.filter(p => !names.has(p.name))];
      await saveSources(merged);
      toast(`添加了 ${merged.length - cur.length} 个书源`);
      void renderSources();
    } catch {
      toast('JSON 格式不正确', 'error');
    }
  };

  const sf = document.getElementById('srcfile') as HTMLInputElement;
  sf.onchange = async () => {
    const f = sf.files?.[0];
    if (!f) return;
    try {
      const parsed = parseSources(await f.text());
      const cur = await listSources();
      const names = new Set(cur.map(s => s.name));
      const merged = [...cur, ...parsed.filter(p => !names.has(p.name))];
      await saveSources(merged);
      toast(`从文件添加了 ${merged.length - cur.length} 个书源`);
      void renderSources();
    } catch {
      toast('文件解析失败', 'error');
    }
  };

  app.querySelectorAll('[data-tog]').forEach(el => {
    (el as HTMLInputElement).onchange = async () => {
      const id = (el as HTMLElement).dataset.tog!;
      const cur = await listSources();
      const next = cur.map(s => (s.id === id ? { ...s, enabled: (el as HTMLInputElement).checked } : s));
      await saveSources(next);
    };
  });

  app.querySelectorAll('[data-rm]').forEach(el => {
    (el as HTMLElement).onclick = async () => {
      const id = (el as HTMLElement).dataset.rm!;
      const cur = await listSources();
      await saveSources(cur.filter(s => s.id !== id));
      void renderSources();
    };
  });
}

// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------

async function renderSettings(): Promise<void> {
  const [used, est] = await Promise.all([totalUsage(), storageEstimate()]);
  const persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : false;

  app.innerHTML = `
    <header>
      <button id="back">← 返回</button>
      <h1>设置</h1>
    </header>
    <main>
      <section class="box">
        <h2>本地存储</h2>
        <p>数据全部保存在这个浏览器里，没有上传到任何服务器。</p>
        <ul class="stats">
          <li>书籍占用：<strong>${formatSize(used)}</strong></li>
          <li>浏览器配额：<strong>${est.quota ? formatSize(est.quota) : '未知'}</strong></li>
          <li>持久化保护：<strong>${persisted ? '已开启 ✅' : '未开启'}</strong></li>
        </ul>
        ${persisted ? '' : '<button id="persist">申请持久化（防止浏览器自动清理）</button>'}
      </section>

      <section class="box">
        <h2>备份（重要）</h2>
        <p class="warn">
          ⚠️ 本地存储没有云端备份。清除浏览器数据、换手机、重装系统都会导致
          <strong>书籍和进度全部丢失</strong>。请定期导出备份。
        </p>
        <div class="row">
          <button id="export">导出备份</button>
          <label class="filebtn">导入备份<input type="file" id="imp" accept=".json" hidden /></label>
        </div>
      </section>

      <section class="box danger">
        <h2>危险操作</h2>
        <button id="wipe">清空全部数据</button>
      </section>
    </main>
  `;

  document.getElementById('back')!.onclick = () => {
    view = 'shelf';
    void render();
  };

  const pb = document.getElementById('persist');
  if (pb) {
    pb.onclick = async () => {
      const ok = await requestPersistence();
      toast(ok ? '已获得持久化保护' : '浏览器拒绝了持久化请求', ok ? 'info' : 'error');
      void renderSettings();
    };
  }

  document.getElementById('export')!.onclick = async () => {
    toast('正在打包…');
    const blob = await exportAll();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `reader-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast('备份已下载');
  };

  const imp = document.getElementById('imp') as HTMLInputElement;
  imp.onchange = async () => {
    const f = imp.files?.[0];
    if (!f) return;
    if (!confirm('导入会与现有数据合并，同名书籍可能重复。继续？')) return;
    try {
      const r = await importAll(f);
      toast(`已恢复 ${r.books} 本书`);
      void renderSettings();
    } catch {
      toast('备份文件无法解析', 'error');
    }
  };

  document.getElementById('wipe')!.onclick = async () => {
    if (!confirm('这会删除全部书籍、进度和书源，且无法撤销。确定？')) return;
    if (!confirm('最后确认：真的要清空所有本地数据吗？')) return;
    await wipeAll();
    toast('已清空');
    view = 'shelf';
    void render();
  };
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

async function render(): Promise<void> {
  switch (view) {
    case 'shelf':
      return renderShelf();
    case 'read':
      return renderReader();
    case 'search':
      return renderSearch();
    case 'sources':
      return renderSources();
    case 'settings':
      return renderSettings();
  }
}

// 启动：申请持久化存储（越早越好，降低数据被清理的概率）
void requestPersistence().then(ok => {
  if (!ok) console.info('未获得持久化存储许可，浏览器可能在空间紧张时清理数据');
});

app.innerHTML = '<div class="loading">加载中…</div>';
void render();
