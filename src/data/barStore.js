/**
 * barStore —— IndexedDB schema v2 + 三级缓存（内存 → IndexedDB → localStorage）
 *
 * v1（旧单文件版）：db 'FuturesReplayDB' v1，store 'kline_cache'，key = `EG0_daily`
 * v2（本文件）：        store 'bars'，key = `market:symbol:period:adjust`
 *                      另加 'symbols' / 'watchlist' / 'journals'（M3/M6 用，M1 先建好 schema）
 *
 * 迁移策略：onupgradeneeded(oldVersion<2) 时把 kline_cache 整表搬进 bars，
 * 旧 store **保留不删** —— 迁移出问题时用户仍然有原始数据，且能回滚到旧版页面。
 * 旧 key `EG0_daily` 推断为期货不复权（旧系统只有期货、且无复权概念）。
 *
 * 方法名沿用旧的 MarketDataCache（getCache/setCache/listCaches/clearAll），
 * 这样内联 UI 代码几乎不用改就能接上新 schema。
 */

import { attachDefaultMAs } from './indicators.js';

export const DB_NAME = 'FuturesReplayDB';
export const DB_VERSION = 2;
export const STORE_BARS = 'bars';
export const STORE_LEGACY = 'kline_cache';
export const STORE_SYMBOLS = 'symbols';
export const STORE_WATCHLIST = 'watchlist';
export const STORE_JOURNALS = 'journals';

/** v2 缓存键。symbol 统一大写，与旧版 `symbol.toUpperCase()` 行为一致。 */
export const barKey = (market, symbol, period = 'daily', adjust = 'none') =>
  `${market}:${String(symbol).toUpperCase()}:${period}:${adjust}`;

/** 旧 key → 新 key（`EG0_daily` → `futures:EG0:daily:none`）。已是新格式则原样返回。 */
export function upgradeLegacyKey(key) {
  if (String(key).includes(':')) return key;
  const [symbol, period] = String(key).split('_');
  return barKey('futures', symbol, period || 'daily', 'none');
}

const InMemoryFallback = {
  store: {},
  set(k, v) { this.store[k] = v; },
  get(k) { return this.store[k] || null; },
  list() { return Object.values(this.store); },
  clear() { this.store = {}; }
};

let dbHandle = null;
let dbPromise = null;

/** 打开一次并复用连接（旧版每次 getDB() 都新开连接且从不关闭）。 */
function openDB() {
  if (dbHandle) return Promise.resolve(dbHandle);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (!window.indexedDB) { dbPromise = null; storageHealth.idb = false; storageHealth.note = '浏览器未提供 IndexedDB'; resolve(null); return; }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        const from = e.oldVersion;
        if (!db.objectStoreNames.contains(STORE_BARS)) {
          db.createObjectStore(STORE_BARS, { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains(STORE_SYMBOLS)) {
          db.createObjectStore(STORE_SYMBOLS, { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains(STORE_WATCHLIST)) {
          db.createObjectStore(STORE_WATCHLIST, { keyPath: 'groupId' });
        }
        if (!db.objectStoreNames.contains(STORE_JOURNALS)) {
          db.createObjectStore(STORE_JOURNALS, { keyPath: 'id' });
        }
        // v1 → v2：把旧 kline_cache 迁进 bars（保留旧 store）
        if (from < 2 && db.objectStoreNames.contains(STORE_LEGACY)) {
          const tx = req.transaction;
          const read = tx.objectStore(STORE_LEGACY).getAll();
          read.onsuccess = () => {
            const rows = read.result || [];
            if (rows.length === 0) return;
            const out = tx.objectStore(STORE_BARS);
            for (const item of rows) {
              if (!item || !item.key) continue;
              const migrated = migrateLegacyRecord(item);
              out.put(migrated);
            }
            console.info(`[barStore] 已迁移 ${rows.length} 条 v1 缓存到 v2 bars（旧 store 保留）`);
          };
        }
      };
      req.onsuccess = (e) => { dbHandle = e.target.result; dbPromise = null; storageHealth.idb = true; resolve(dbHandle); };
      req.onerror = () => {
        dbPromise = null; storageHealth.idb = false;
        storageHealth.note = 'IndexedDB 打不开（' + ((req.error && req.error.name) || '未知') + '）';
        resolve(null);
      };
      /**
       * 另一个标签页攥着旧版本（尤其是拆模块之前的那份单文件版，它开的是 v1）时，
       * open 会一直挂着 —— 没有 onblocked 的话界面只表现为"空"，谁都不知道为什么，
       * 用户看到的就是"自选股保存不了"。
       */
      req.onblocked = () => {
        storageHealth.idb = false;
        storageHealth.note = 'IndexedDB 被其他页面占用（onblocked）';
        console.warn('[barStore] IndexedDB 打开被阻塞：请关掉旧版标签页（尤其 file:// 打开的那份单文件版）后刷新');
      };
      // 版本被别处升级时主动让位，否则新标签页永远打不开
      req.onversionchange = (e) => { try { if (e.target && e.target.result) e.target.result.close(); } catch (_) {} dbHandle = null; };
      dbHandle && dbHandle.version;
    } catch (err) {
      dbPromise = null;
      // 走到这里通常是 file:// 或隐私模式：window/IndexedDB 根本不存在。
      // 必须把原因记下来，否则界面只能显示"空的"，用户以为保存成功了。
      storageHealth.idb = false;
      storageHealth.note = 'IndexedDB 不可用：' + ((err && err.name) || '') + ' ' + ((err && err.message) || err);
      resolve(null);
    }
  });
  return dbPromise;
}

function migrateLegacyRecord(item) {
  const [legacySymbol, legacyPeriod] = String(item.key).split('_');
  const market = (item.meta && item.meta.market) || 'futures';
  const adjust = (item.meta && item.meta.adjust) || 'none';
  const period = legacyPeriod || 'daily';
  return {
    key: barKey(market, legacySymbol, period, adjust),
    market, symbol: String(legacySymbol).toUpperCase(), period, adjust,
    data: item.data, meta: { ...(item.meta || {}), migratedFrom: item.key },
    barCount: (item.data || []).length,
    lastDate: (item.data || []).slice(-1)[0]?.date || null,
    updateTime: item.updateTime
  };
}

const lsKey = (key) => 'kline_' + key;

/**
 * 存储健康状态：界面上必须能看见"这次到底存到哪了"。
 * 以前所有失败都被 resolve(null) / return false 咽掉，成功提示照样弹 ——
 * 用户只在刷新之后才发现自选股没了，而那时已经查不到是哪个环节掉的。
 */
export const storageHealth = { idb: null, ls: null, note: '' };

const WL_LS_KEY = 'frt.watchlist.v1';

/** localStorage 镜像：只给自选池用（品种代码很小），作为 IndexedDB 不可用时的兜底。 */
function lsReadMap() {
  try {
    if (typeof localStorage === 'undefined') { storageHealth.ls = false; return {}; }
    const raw = localStorage.getItem(WL_LS_KEY);
    storageHealth.ls = true;
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    storageHealth.ls = false;
    storageHealth.note = 'localStorage 不可用或已写满：' + (e && e.name || e);
    return {};
  }
}

function lsWriteMap(map) {
  try {
    if (typeof localStorage === 'undefined') return false;
    localStorage.setItem(WL_LS_KEY, JSON.stringify(map));
    storageHealth.ls = true;
    return true;
  } catch (e) {
    // 隐私模式 / 超配额都会走到这里；状态记下来，界面要说人话而不是假装成功
    storageHealth.ls = false;
    storageHealth.note = 'localStorage 写入失败（隐私模式或配额已满）：' + (e && e.name || e);
    return false;
  }
}

export const BarStore = {
  async setCache(key, data, meta = {}) {
    const record = {
      key, market: meta.market || 'futures', symbol: meta.symbol || key,
      period: meta.period || 'daily', adjust: meta.adjust || 'none',
      data, meta, barCount: (data || []).length,
      lastDate: (data || []).slice(-1)[0]?.date || null,
      updateTime: new Date().toLocaleString()
    };
    InMemoryFallback.set(key, record);
    try {
      const db = await openDB();
      if (db) {
        return await new Promise((resolve) => {
          const tx = db.transaction(STORE_BARS, 'readwrite');
          tx.objectStore(STORE_BARS).put(record);
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => resolve(false);
        });
      }
    } catch (e) { /* fall through to localStorage */ }
    try { localStorage.setItem(lsKey(key), JSON.stringify(record)); } catch (err) {}
    return true;
  },

  /**
   * 删掉一条缓存。三个落点都要删：内存兜底、IndexedDB、localStorage 镜像 ——
   * 少删一个，下一轮 getCache 就会从那个落点把坏数据又捞回来。
   * 用途：序列的 bar 间隔和所标周期对不上（上游静默降级过）时，必须能把它踢掉重取。
   */
  async deleteCache(key) {
    InMemoryFallback.set(key, null);
    try { localStorage.removeItem(lsKey(key)); } catch (e) {}
    try {
      const db = await openDB();
      if (db) {
        return await new Promise((resolve) => {
          const tx = db.transaction(STORE_BARS, 'readwrite');
          const k = upgradeLegacyKey(key);
          tx.objectStore(STORE_BARS).delete(k);
          tx.objectStore(STORE_BARS).delete(key);   // 旧键形态也一并删，别让迁移前的记录复活
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => resolve(false);
        });
      }
    } catch (e) {}
    return true;
  },

  async getCache(key) {
    const inMem = InMemoryFallback.get(key);
    if (inMem) return inMem;
    try {
      const db = await openDB();
      if (db) {
        const fromDb = await new Promise((resolve) => {
          const tx = db.transaction(STORE_BARS, 'readonly');
          const req = tx.objectStore(STORE_BARS).get(key);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => resolve(null);
        });
        if (fromDb) { InMemoryFallback.set(key, fromDb); return fromDb; }
      }
    } catch (e) {}
    try {
      const raw = localStorage.getItem(lsKey(key));
      if (raw) { const parsed = JSON.parse(raw); InMemoryFallback.set(key, parsed); return parsed; }
    } catch (err) {}
    // 兼容旧调用点传入的 v1 key
    if (!String(key).includes(':')) {
      const migrated = await this.getCache(upgradeLegacyKey(key));
      if (migrated) return migrated;
    }
    return null;
  },

  async listCaches() {
    const list = [...InMemoryFallback.list()];
    const pushUnique = (item) => {
      if (item && item.key && !list.find(x => x.key === item.key)) list.push(item);
    };
    try {
      const db = await openDB();
      if (db) {
        const dbList = await new Promise((resolve) => {
          const tx = db.transaction(STORE_BARS, 'readonly');
          const req = tx.objectStore(STORE_BARS).getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => resolve([]);
        });
        dbList.forEach(pushUnique);
      }
    } catch (e) {}
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('kline_')) {
          try { pushUnique(JSON.parse(localStorage.getItem(k))); } catch (err) {}
        }
      }
    } catch (err) {}
    return list;
  },

  async clearAll() {
    InMemoryFallback.clear();
    try {
      const db = await openDB();
      if (db) {
        const tx = db.transaction(STORE_BARS, 'readwrite');
        tx.objectStore(STORE_BARS).clear();
      }
    } catch (e) {}
    try {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('kline_')) keys.push(k);
      }
      keys.forEach(k => localStorage.removeItem(k));
    } catch (err) {}
  },

  // ---------- symbols / watchlist / journals（M1 建 schema，M3/M6 使用）----------
  async putSymbol(rec) {
    const record = { key: `${rec.market}:${String(rec.symbol).toUpperCase()}`, ...rec, updatedAt: new Date().toISOString() };
    try {
      const db = await openDB();
      if (!db) return false;
      return await new Promise((resolve) => {
        const tx = db.transaction(STORE_SYMBOLS, 'readwrite');
        tx.objectStore(STORE_SYMBOLS).put(record);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      });
    } catch (e) { return false; }
  },

  async listSymbols() {
    try {
      const db = await openDB();
      if (!db) return [];
      return await new Promise((resolve) => {
        const tx = db.transaction(STORE_SYMBOLS, 'readonly');
        const req = tx.objectStore(STORE_SYMBOLS).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      });
    } catch (e) { return []; }
  },

  /**
   * 保存自选分组，返回 {ok, where}：where = 'indexeddb' | 'localstorage' | 'none'。
   * 只要有一处落地就算 ok，但界面必须知道落在哪 —— IDB 被别的标签页攥住的时候，
   * 数据其实进了 localStorage 镜像；两处都失败才是真没存上，那时不能再弹"已保存"。
   */
  /** 存储现状：idb / ls 各为 true|false|null（null = 还没试过），note 是失败原因。 */
  storageStatus() { return { ...storageHealth }; },

  async putWatchlist(group) {
    const record = { ...group, updatedAt: new Date().toISOString() };
    let idbOk = false;
    try {
      const db = await openDB();
      if (db) {
        idbOk = await new Promise((resolve) => {
          const tx = db.transaction(STORE_WATCHLIST, 'readwrite');
          tx.objectStore(STORE_WATCHLIST).put(record);
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => resolve(false);
          tx.onabort = () => resolve(false);
        });
      }
    } catch (e) { idbOk = false; }
    const map = lsReadMap();
    const lsOk = lsWriteMap({ ...map, [record.groupId]: record });   // 镜像永远写一份
    return { ok: idbOk || lsOk, where: idbOk ? 'indexeddb' : (lsOk ? 'localstorage' : 'none') };
  },

  async listWatchlist() {
    let fromIdb = [];
    try {
      const db = await openDB();
      if (db) {
        fromIdb = await new Promise((resolve) => {
          const tx = db.transaction(STORE_WATCHLIST, 'readonly');
          const req = tx.objectStore(STORE_WATCHLIST).getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => resolve([]);
        });
      }
    } catch (e) { fromIdb = []; }
    const mirror = Object.values(lsReadMap());
    if (!mirror.length) return fromIdb;
    const seen = new Set(fromIdb.map(g => g && g.groupId));
    // 镜像里可能有 IDB 从没收到过的分组（第一次打开就被旧标签页阻塞的那阵子写的）。
    // 同一个 groupId 以 IndexedDB 为准 —— 那边是主存，镜像只是兜底。
    return fromIdb.concat(mirror.filter(g => g && !seen.has(g.groupId)));
  },

  /** 删除分组：自选池要能删，只给 put/list 等于给了个只能越堆越多的列表。 */
  async deleteWatchlist(groupId) {
    let idbOk = false;
    try {
      const db = await openDB();
      if (db) {
        idbOk = await new Promise((resolve) => {
          const tx = db.transaction(STORE_WATCHLIST, 'readwrite');
          tx.objectStore(STORE_WATCHLIST).delete(groupId);
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => resolve(false);
          tx.onabort = () => resolve(false);
        });
      }
    } catch (e) { idbOk = false; }
    // 镜像里要一起删：留着的话下次 list 会把已经删掉的分组又捞回来，像闹鬼
    const map = lsReadMap();
    if (map[groupId]) { delete map[groupId]; lsWriteMap(map); }
    return { ok: idbOk, where: idbOk ? 'indexeddb' : 'localstorage' };
  },

  async putJournal(entry) {
    const record = { id: entry.id || `j_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, ...entry };
    try {
      const db = await openDB();
      if (!db) return false;
      return await new Promise((resolve) => {
        const tx = db.transaction(STORE_JOURNALS, 'readwrite');
        tx.objectStore(STORE_JOURNALS).put(record);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      });
    } catch (e) { return false; }
  },

  async listJournals() {
    try {
      const db = await openDB();
      if (!db) return [];
      return await new Promise((resolve) => {
        const tx = db.transaction(STORE_JOURNALS, 'readonly');
        const req = tx.objectStore(STORE_JOURNALS).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      });
    } catch (e) { return []; }
  },

  /** 删除一条日志：只能写不能删的"笔记"会让人不敢下笔。 */
  async deleteJournal(id) {
    try {
      const db = await openDB();
      if (!db) return false;
      return await new Promise((resolve) => {
        const tx = db.transaction(STORE_JOURNALS, 'readwrite');
        tx.objectStore(STORE_JOURNALS).delete(id);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      });
    } catch (e) { return false; }
  }
};

/** 抓取后统一入口：打均线 + 落缓存。 */
export async function cacheBars(key, bars, meta) {
  attachDefaultMAs(bars);
  await BarStore.setCache(key, bars, meta);
  return bars;
}
