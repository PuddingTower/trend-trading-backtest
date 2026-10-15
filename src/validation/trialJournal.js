/**
 * 试验日志（trial journal）。
 *
 * DSR 里的 N 是整个防过拟合体系里最容易作假的一个数：填 `plans.length`（网格格数）
 * 会让 DSR 假得离谱，因为 slow=60 与 slow=62 根本不是两次独立试验；反过来只填 1
 * 又等于没扣挑选偏差。所以 N 必须来自"历史上真的做过几个不同的决策"，而且要可追溯。
 *
 * 口径（写死，别改来改去）：
 *  - raw      = 去重后的 (策略 + 量化参数桶) 组合数。完全重复的同一组参数只算一次。
 *  - effective = 量化到"决策桶"后的不同桶数：每个数值参数按 log2 切成若干档，
 *                相邻档之间算同一个决策。这是粗尺度近似，故意的 ——
 *                没有任何理论能精确给出螺纹 20 日均线与 21 日均线之间的相关系数。
 *  - 每次记录都带 dataHash：换数据区间等于换一场考试，跨数据算 N 会低估偏差。
 */

const round2 = (v) => Math.round(v * 100) / 100;

/** 数值参数的决策桶：按 log2 尺度取整（负数按绝对值分档并保留符号）。 */
function bucketOf(v, digits) {
  if (!Number.isFinite(v)) return 'na';
  if (v === 0) return '0';
  const sign = v < 0 ? '-' : '';
  const a = Math.abs(v);
  const mag = Math.floor(Math.log2(a));
  // 每档宽度约为该量级的 1/2^digits：digits=3 时 slow=60 与 slow=62 落进同一桶，
  // 但 slow=60 与 slow=80 不会 —— 这正是"相邻参数不算两次独立试验"的意思
  const step = Math.pow(2, mag - digits);
  const q = Math.floor(a / step) * step;
  return `${sign}${Number(q.toFixed(6))}`;
}

/** 把参数压成"决策级"的键：顺序稳定、数值分档。 */
export function paramKey(strategyId, params, { digits = 3 } = {}) {
  const keys = Object.keys(params || {}).sort();
  const parts = keys.map(k => {
    const v = params[k];
    if (typeof v === 'number') return `${k}=${bucketOf(v, digits)}`;
    return `${k}=${String(v)}`;
  });
  return `${strategyId}|${parts.join(',')}`;
}

/** 原始参数键（不合并相邻档），用于"完全重复的参数只算一次"。 */
export function exactKey(strategyId, params) {
  const keys = Object.keys(params || {}).sort();
  const body = keys.map(k => `${k}=${typeof params[k] === 'number' ? round2(params[k]) : String(params[k])}`).join(',');
  return `${strategyId}|${body}`;
}

/**
 * @param {Array} entries 已记录的试验 [{id, strategy, params, objective, value, dataHash, at}]
 */
export function createJournal(entries = []) {
  const list = Array.isArray(entries) ? entries.slice() : [];

  const api = {
    entries: () => list.slice(),
    get size() { return list.length; },

    /** 记一次试验。同一次搜索里成千上万格，去重在这里做，不在调用方做。 */
    record({ strategy, params, objective = 'sharpe', value = null, dataHash = 'unknown', at = null, source = 'grid' }) {
      const key = exactKey(strategy, params);
      const dup = list.find(e => e.key === key && e.dataHash === dataHash);
      if (dup) return { entry: dup, added: false };
      const entry = {
        key, strategy, params: { ...(params || {}) }, objective, value, dataHash, source,
        at: at || new Date().toISOString()
      };
      list.push(entry);
      return { entry, added: true };
    },

    /** 批量记录（网格跑一次就是一批），返回新增数。 */
    recordMany(runs, ctx = {}) {
      let added = 0;
      for (const r of runs || []) {
        const res = api.record({ ...ctx, params: r.params, value: r.value ?? null, strategy: ctx.strategy || r.strategy });
        if (res.added) added++;
      }
      return added;
    },

    /**
     * N 的两个口径。
     * @returns {{raw:number, effective:number, byStrategy:Array, byData:Array}}
     */
    counts({ digits = 3 } = {}) {
      const raw = new Set(list.map(e => `${e.dataHash}#${e.key}`)).size;
      const buckets = new Set();
      const byStrategy = new Map();
      const byData = new Map();
      for (const e of list) {
        buckets.add(`${e.dataHash}#${e.strategy}#${paramKey(e.strategy, e.params, { digits })}`);
        byStrategy.set(e.strategy, (byStrategy.get(e.strategy) || 0) + 1);
        byData.set(e.dataHash, (byData.get(e.dataHash) || 0) + 1);
      }
      return {
        raw,
        effective: buckets.size,
        byStrategy: [...byStrategy.entries()].map(([strategy, n]) => ({ strategy, n })).sort((a, b) => b.n - a.n),
        byData: [...byData.entries()].map(([dataHash, n]) => ({ dataHash, n })).sort((a, b) => b.n - a.n)
      };
    },

    /** 给 DSR 用的 N：同一批试验要按同一份数据算。 */
    nFor({ strategy, dataHash }) {
      const hits = list.filter(e => (!strategy || e.strategy === strategy) && (!dataHash || e.dataHash === dataHash));
      const set = new Set(hits.map(e => paramKey(e.strategy, e.params)));
      return { raw: new Set(hits.map(e => e.key)).size, effective: set.size || hits.length };
    },

    toJSON: () => JSON.parse(JSON.stringify(list)),
    toJSONString: () => JSON.stringify(list),
    clear: () => { list.length = 0; return api; }
  };

  // 恢复历史：缺 key 的旧条目按当前口径补上，避免同一次试验被记两遍
  for (const e of list) if (!e.key) e.key = exactKey(e.strategy, e.params);
  return api;
}
