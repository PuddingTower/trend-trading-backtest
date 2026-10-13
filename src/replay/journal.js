/**
 * 交易日志（计划 M6）。
 *
 * 目标不是"记流水"，而是把亏损归到可改的类别上：突破追高、止损放太紧、拿不住、
 * 逆势加仓…… 只有按标签聚合出胜率和盈亏，才知道该改的是哪一个动作。
 *
 * 存储用 IndexedDB 的 journals store（M1 已建好 schema 与 putJournal/listJournals）。
 * 纯统计部分（groupStats / reconcile）不碰存储，所以能离线单测 ——
 * 其中「分组统计必须与交易明细对得上账」是这一层唯一的验收线。
 */

import { BarStore } from '../data/barStore.js';

export const TAG_GROUPS = ['setup', '失误', '情绪', '市场环境'];

export const DEFAULT_TAGS = {
  setup: ['趋势跟随', '突破', '回调', '区间', '反转'],
  '失误': ['追高', '止损过紧', '提前离场', '逆势加仓', '重仓', '未按计划'],
  情绪: ['犹豫', '贪婪', '恐惧', '冷静'],
  市场环境: ['震荡', '单边', '高波动', '低波动']
};

/** 一条笔记。id 用交易的唯一标识，保证同一笔交易重复编辑不会产生两条记录。 */
export function makeEntry(trade, { note = '', tags = {}, symbol = '', screenshot = null } = {}) {
  const id = journalId(trade);
  return {
    id,
    tradeId: trade.id ?? null,
    symbol: symbol || trade.symbol || '',
    dir: trade.dir || trade.direction || '',
    entryDate: trade.entryDate || trade.entryTime || null,
    exitDate: trade.exitDate || trade.exitTime || null,
    netPnL: Number(trade.netPnL) || 0,
    holdingBars: Number(trade.holdingBars) || 0,
    note: String(note).slice(0, 4000),
    tags: normalizeTags(tags),
    screenshot,
    updatedAt: new Date().toISOString()
  };
}

export function journalId(trade) {
  const sym = trade.symbol || 'pos';
  const ex = trade.exitDate || trade.exitTime || trade.id || '';
  return `jr_${sym}_${ex}_${trade.id ?? 0}`;
}

function normalizeTags(tags) {
  const out = {};
  for (const g of TAG_GROUPS) {
    const v = tags && tags[g];
    out[g] = (Array.isArray(v) ? v : v ? [v] : []).map(x => String(x).trim()).filter(Boolean).slice(0, 6);
  }
  return out;
}

/** 存一条笔记（按 id 覆盖）。 */
export async function saveEntry(entry) {
  return BarStore.putJournal(entry);
}

export async function listEntries() {
  return (await BarStore.listJournals()) || [];
}

export async function deleteEntry(id) {
  return BarStore.deleteJournal(id);
}

/**
 * 给交易挂上已有笔记（按 id 匹配）。
 * 匹配不上就不挂，而不是造一条空的 —— 空笔记会污染分组统计（"未标注"这一类本来就该单独统计）。
 */
export function attachNotes(trades, entries) {
  const byId = new Map((entries || []).map(e => [e.tradeId, e]));
  const byKey = new Map((entries || []).map(e => [e.id, e]));
  return (trades || []).map(t => {
    const entry = byId.get(t.id) || byKey.get(journalId(t)) || null;
    return {
      ...t,
      journal: entry,                        // 整条笔记（含截图、更新时间）
      note: entry ? entry.note : '',         // 只有文本，方便列表里直接显示
      tags: entry ? entry.tags : normalizeTags({}),
      hasNote: !!entry
    };
  });
}

/**
 * 按维度聚合。返回每一组的笔数 / 胜率 / 总盈亏 / 单笔均额 / 盈亏比。
 *
 * 每组都带 `pnl`，且所有组之和必须等于明细总盈亏 —— 这是本模块的验收线（reconcile 就是查这个）。
 * 聚合口径一旦和明细对不上，用户看到的"追高亏 8000"就是假的，而这种假会直接引导他改错地方。
 */
export function groupStats(trades, dim) {
  const acc = new Map();
  const keyOf = (t) => {
    switch (dim) {
      case 'tag': return (t.tags?.setup || []).concat(t.tags?.['失误'] || [], t.tags?.情绪 || [], t.tags?.市场环境 || []);
      case 'symbol': return [t.symbol || '未知'];
      case 'direction': return [t.dir || t.direction || '未知'];
      case 'month': return [String(t.exitDate || t.exitTime || '').slice(0, 7) || '未知'];
      case 'holding': {
        const h = Number(t.holdingBars) || 0;
        return [h <= 2 ? '≤2根' : h <= 5 ? '3-5根' : h <= 10 ? '6-10根' : h <= 20 ? '11-20根' : '>20根'];
      }
      default: return ['全部'];
    }
  };
  for (const t of trades || []) {
    const keys = keyOf(t);
    if (!keys.length) continue;
    for (const k of keys) {
      const cur = acc.get(k) || { key: k, n: 0, pnl: 0, wins: 0, losses: 0, grossWin: 0, grossLoss: 0, holding: 0 };
      const p = Number(t.netPnL) || 0;
      cur.n++; cur.pnl += p; cur.holding += Number(t.holdingBars) || 0;
      if (p > 0) { cur.wins++; cur.grossWin += p; } else { cur.losses++; cur.grossLoss += Math.abs(p); }
      acc.set(k, cur);
    }
  }
  return [...acc.values()].map(v => ({
    key: v.key, n: v.n, pnl: Math.round(v.pnl * 100) / 100,
    winRate: v.n ? v.wins / v.n : 0,
    avg: v.n ? Math.round((v.pnl / v.n) * 100) / 100 : 0,
    avgWin: v.wins ? Math.round((v.grossWin / v.wins) * 100) / 100 : 0,
    avgLoss: v.losses ? Math.round((v.grossLoss / v.losses) * 100) / 100 : 0,
    payoff: v.losses && v.grossLoss > 0 && v.wins ? (v.grossWin / v.wins) / (v.grossLoss / v.losses) : null,
    avgHolding: v.n ? v.holding / v.n : 0,
    wins: v.wins, losses: v.losses
  })).sort((a, b) => b.pnl - a.pnl);
}

/**
 * 对账：分组统计之和 是否等于 明细总盈亏。
 * 返回 ok=false 说明聚合写错了 —— 这时界面上的每一个数字都不可信。
 * 按标签维度时必须允许多计（一笔交易可以带多个标签，所以每组之和会大于总额），
 * 因此只对"一笔只落一组"的维度做严格对账。
 */
export function reconcile(trades, dims = ['symbol', 'direction', 'month', 'holding']) {
  const total = Math.round((trades || []).reduce((s, t) => s + (Number(t.netPnL) || 0), 0) * 100) / 100;
  const rows = [];
  let ok = true;
  for (const d of dims) {
    const groups = groupStats(trades, d);
    const sum = Math.round(groups.reduce((s, g) => s + g.pnl, 0) * 100) / 100;
    const pass = Math.abs(sum - total) < 0.5;
    if (!pass) ok = false;
    rows.push({ dim: d, sum, diff: Math.round((sum - total) * 100) / 100, pass, groups: groups.length });
  }
  const tagGroups = groupStats(trades, 'tag');
  const tagSum = Math.round(tagGroups.reduce((s, g) => s + g.pnl, 0) * 100) / 100;
  return { ok, total, rows, tagSum, tagMultiCounted: tagSum !== total, trades: (trades || []).length };
}

/** 复盘检查清单（M6 的"检查清单"项）。状态存在 journal 的一条特殊记录里。 */
export const CHECKLIST = [
  { id: 'plan', text: '开仓前写下计划：入场理由、止损位、目标位' },
  { id: 'level', text: '入场位置是否在关键位附近（不是半山腰）' },
  { id: 'risk', text: '单笔风险是否 ≤ 账户的既定比例' },
  { id: 'stop', text: '止损有没有因为"感觉还能回来"而移动' },
  { id: 'trend', text: '这一笔是顺大趋势还是逆大趋势' },
  { id: 'emotion', text: '有没有因为连亏/连赢而改变仓位' },
  { id: 'journal', text: '每一笔都打了标签并写了至少一句复盘' }
];

export async function saveChecklist(state) {
  return BarStore.putJournal({ id: 'checklist', kind: 'checklist', state, updatedAt: new Date().toISOString() });
}

export async function loadChecklist() {
  const all = await listEntries();
  const rec = (all || []).find(e => e && e.kind === 'checklist');
  return rec ? rec.state : null;
}
