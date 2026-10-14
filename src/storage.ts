/**
 * IndexedDB 存储层 —— 数据完全存在浏览器本地，没有任何服务器。
 *
 * 两个存储：
 *   kv    : 键值对（书架、阅读进度、设置、书源）—— 存 JSON 字符串
 *   blobs : 二进制（书籍文件本身）—— 存 Uint8Array
 *
 * 为什么用 IndexedDB 而不是 localStorage：
 *   localStorage 只有约 5MB，且只能存字符串（二进制要 base64，体积涨 33%）。
 *   IndexedDB 可以存几 GB 的二进制，且是异步的（不卡界面）。
 */

const DB_NAME = 'reader-static';
const DB_VERSION = 1;
const KV_STORE = 'kv';
const BLOB_STORE = 'blobs';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(KV_STORE)) db.createObjectStore(KV_STORE);
      if (!db.objectStoreNames.contains(BLOB_STORE)) db.createObjectStore(BLOB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('无法打开 IndexedDB'));
  });
  return dbPromise;
}

/** 用 Promise 包一层 IndexedDB 的事务回调风格。 */
async function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest,
): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB 操作失败'));
  });
}

/** 批量写入（一个事务里做完，中途失败会整体回滚）。 */
async function txMany(store: string, ops: Array<(s: IDBObjectStore) => void>): Promise<void> {
  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const t = db.transaction(store, 'readwrite');
    const s = t.objectStore(store);
    for (const op of ops) op(s);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error ?? new Error('IndexedDB 批量写入失败'));
    t.onabort = () => reject(t.error ?? new Error('IndexedDB 事务被中止'));
  });
}

// ---------------------------------------------------------------------------
// 键值存储
// ---------------------------------------------------------------------------

export async function kvGet<T>(key: string): Promise<T | null> {
  const raw = await tx<string | undefined>(KV_STORE, 'readonly', s => s.get(key));
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    // 数据损坏时不要抛异常把界面卡死，当作没有这条记录
    console.warn('kvGet: 无法解析', key);
    return null;
  }
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  await tx(KV_STORE, 'readwrite', s => s.put(JSON.stringify(value), key));
}

export async function kvRemove(key: string): Promise<void> {
  await tx(KV_STORE, 'readwrite', s => s.delete(key));
}

export async function kvKeys(): Promise<string[]> {
  const keys = await tx<IDBValidKey[]>(KV_STORE, 'readonly', s => s.getAllKeys());
  return keys.map(String);
}

// ---------------------------------------------------------------------------
// 二进制存储（书籍文件）
// ---------------------------------------------------------------------------

export async function blobGet(key: string): Promise<Uint8Array | null> {
  const v = await tx<Uint8Array | undefined>(BLOB_STORE, 'readonly', s => s.get(key));
  return v ?? null;
}

export async function blobPut(key: string, bytes: Uint8Array): Promise<void> {
  // 存副本：调用方之后可能复用这个 buffer，IndexedDB 存的是引用语义容易踩坑
  await tx(BLOB_STORE, 'readwrite', s => s.put(bytes.slice(), key));
}

export async function blobRemove(key: string): Promise<void> {
  await tx(BLOB_STORE, 'readwrite', s => s.delete(key));
}

export async function blobList(): Promise<string[]> {
  const keys = await tx<IDBValidKey[]>(BLOB_STORE, 'readonly', s => s.getAllKeys());
  return keys.map(String);
}

export async function blobSize(key: string): Promise<number> {
  const v = await blobGet(key);
  return v ? v.byteLength : 0;
}

/** 所有书占用的总字节数。 */
export async function totalUsage(): Promise<number> {
  const keys = await blobList();
  let sum = 0;
  for (const k of keys) sum += await blobSize(k);
  return sum;
}

/**
 * 向浏览器申请"持久化存储"。
 *
 * 默认情况下浏览器可能在磁盘紧张时清掉你的数据。调用这个之后，
 * 浏览器会尽量保留（Chrome 不会自动清理，Safari 也需用户手动清）。
 * 返回 true 表示已获得持久化许可。
 */
export async function requestPersistence(): Promise<boolean> {
  if (!navigator.storage?.persist) return false;
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

/** 查询浏览器给这个站点分配了多少配额、已用多少。 */
export async function storageEstimate(): Promise<{ usage: number; quota: number }> {
  if (!navigator.storage?.estimate) return { usage: 0, quota: 0 };
  try {
    const e = await navigator.storage.estimate();
    return { usage: e.usage ?? 0, quota: e.quota ?? 0 };
  } catch {
    return { usage: 0, quota: 0 };
  }
}

/** 清空全部本地数据（危险操作，界面上要二次确认）。 */
export async function wipeAll(): Promise<void> {
  await txMany(KV_STORE, [s => s.clear()]);
  await txMany(BLOB_STORE, [s => s.clear()]);
}

/**
 * 导出全部数据为可下载的备份文件。
 * 纯本地存储没有云端备份，这是用户唯一的救命稻草。
 */
export async function exportAll(): Promise<Blob> {
  const keys = await kvKeys();
  const kv: Record<string, string> = {};
  for (const k of keys) {
    const raw = await tx<string | undefined>(KV_STORE, 'readonly', s => s.get(k));
    if (raw != null) kv[k] = raw;
  }
  const blobKeys = await blobList();
  const blobs: Record<string, string> = {};
  for (const k of blobKeys) {
    const bytes = await blobGet(k);
    if (!bytes) continue;
    // base64 —— 换取 JSON 单文件的可移植性
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    blobs[k] = btoa(bin);
  }
  const payload = { version: 1, exportedAt: Date.now(), kv, blobs };
  return new Blob([JSON.stringify(payload)], { type: 'application/json' });
}

/** 从备份文件恢复。 */
export async function importAll(file: File): Promise<{ books: number }> {
  const text = await file.text();
  const data = JSON.parse(text) as {
    version?: number;
    kv?: Record<string, string>;
    blobs?: Record<string, string>;
  };
  if (!data.kv && !data.blobs) throw new Error('备份文件格式不正确');

  const kvOps: Array<(s: IDBObjectStore) => void> = [];
  for (const [k, v] of Object.entries(data.kv ?? {})) kvOps.push(s => s.put(v, k));
  if (kvOps.length) await txMany(KV_STORE, kvOps);

  const blobOps: Array<(s: IDBObjectStore) => void> = [];
  for (const [k, b64] of Object.entries(data.blobs ?? {})) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    blobOps.push(s => s.put(bytes, k));
  }
  if (blobOps.length) await txMany(BLOB_STORE, blobOps);

  return { books: Object.keys(data.blobs ?? {}).length };
}
