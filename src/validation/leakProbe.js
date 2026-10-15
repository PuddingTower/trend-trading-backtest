/**
 * 前视探针 —— 把因果性变成机器断言。
 *
 * 为什么要有这个文件：前视偏差不会报错，只会让回测变好看，而且比算错更难人眼发现
 * （分析层自己的注释就写过这句）。所以新增策略/引擎改动不许靠 review 兜底，必须过探针。
 *
 * 两条互补判据：
 *  1) 前缀一致性 signalPrefixProbe —— 把序列截到第 i 根重算，第 i 个信号必须与全序列下
 *     逐字段相等。凡是"要等后面几根才成立"的逻辑（ZigZag 枢轴、双侧/零相位滤波、
 *     用全序列 min/max/std 归一化）都过不了这一条。
 *  2) 未来不变性 futureInvarianceProbe —— 只改动某天之后的 bar（价格整体放大），
 *     这天之前的权益点与**开仓侧**成交不许有任何变化。抓的是引擎侧泄漏，
 *     例如"用全序列末尾 120 根算一次波动率再复用给每一天"这种策略层看不见的错。
 *     注意只比"切点前已整笔了结"的成交：入场在切点前、出场在切点后的那笔，出场价本来就该变。
 */

import { makeRng } from '../core/rng.js';

const dayKey = (d) => String(d || '').slice(0, 10);
const sameNum = (a, b) => a === b || (Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 5e-3);

/** 普通对象/数组的深比较，返回差异路径（探查用，不抛异常，最多 limit 条）。 */
export function structDiff(a, b, path = '$', out = [], limit = 12) {
  if (out.length >= limit) return out;
  if (a === b) return out;
  if (Number.isNaN(a) && Number.isNaN(b)) return out;
  const objBoth = a !== null && b !== null && typeof a === 'object' && typeof b === 'object';
  if (!objBoth) { out.push({ path, full: a, truncated: b }); return out; }
  const ka = Object.keys(a), kb = Object.keys(b);
  for (const k of ka) if (!(k in b)) out.push({ path: `${path}.${k}`, full: a[k], truncated: undefined });
  for (const k of kb) if (!(k in a)) out.push({ path: `${path}.${k}`, full: undefined, truncated: b[k] });
  for (const k of ka) if (k in b) structDiff(a[k], b[k], `${path}.${k}`, out, limit);
  return out;
}

/** 确定性抽查点：含暖机后第一根与最后一根，其余用固定种子随机取。 */
function checkpoints(n, count, seed) {
  const rng = makeRng(seed);
  const set = new Set();
  const warm = Math.min(80, Math.max(1, Math.floor(n * 0.06)));
  for (let g = 0; g < count * 20 && set.size < count; g++) set.add(Math.floor(rng() * n));
  set.add(n - 1);
  set.add(warm);
  set.add(Math.floor(n / 2));
  return [...set].filter(i => i >= 0 && i < n).sort((x, y) => x - y);
}

/**
 * 策略层前缀一致性。
 * @returns {{ok:boolean, checked:number, shapeBad:boolean, leaks:Array, note:string}}
 */
export function signalPrefixProbe(strategy, bars, params = {}, { count = 28, seed = 20261015 } = {}) {
  const full = strategy.signals(bars, params) || [];
  const res = { id: strategy.id, checked: 0, shapeBad: false, leaks: [], note: '' };
  // 引擎按 bars.length 对齐信号数组，长度不符本身就是契约违规
  if (full.length !== bars.length) {
    res.shapeBad = true; res.ok = false;
    res.note = `信号长度 ${full.length} ≠ bar 数 ${bars.length}（引擎按下标对齐，这会整体错位）`;
    return res;
  }
  const idxs = checkpoints(bars.length, count, seed);
  for (const i of idxs) {
    const trunc = (strategy.signals(bars.slice(0, i + 1), params) || [])[i];
    const d = structDiff(full[i], trunc, `sig[${i}]`);
    if (d.length) res.leaks.push({ i, date: dayKey(bars[i].date), diffs: d.slice(0, 3) });
  }
  res.checked = idxs.length;
  res.ok = res.leaks.length === 0;
  res.note = res.ok
    ? `${res.checked} 个抽查点上，截断重算与全序列逐字段一致`
    : `${res.leaks.length}/${res.checked} 个抽查点不一致，最早在 ${res.leaks[0].date}（第 ${res.leaks[0].i} 根）：`
      + res.leaks[0].diffs.map(x => `${x.path} 全序列=${x.full} 截断=${x.truncated}`).join('；')
      + ' —— 说明该信号用了这根之后的数据，或用了整段序列的长度/极值';
  return res;
}

/** 把 cutDate 之后的 bar 价格整体放大（只读复制，不改原数组）。
 *  局限：波动率/收益这类**比率型**依赖对同比例放大是不变的，只靠它做突变会漏报 ——
 *  要连收益路径一起改掉，请配合 rewriteBarsAfter 用。
 */
export function shockBarsAfter(bars, cutDate, factor = 3) {
  return (bars || []).map(b => {
    if (!(dayKey(b.date) > cutDate)) return b;
    const f = (v) => (Number.isFinite(v) ? v * factor : v);
    const out = { ...b, open: f(b.open), high: f(b.high), low: f(b.low), close: f(b.close) };
    if (Number.isFinite(out.prevClose)) out.prevClose = f(out.prevClose);
    return out;
  });
}

/** 用另一段确定性游走重写 cutDate 之后的 bar：改的是**收益路径**，不只是价位水平。
 *  这样"拿全序列算一次波动率再复用"这种比率型依赖才会露出来 —— 放大法对它免疫。
 */
export function rewriteBarsAfter(bars, cutDate, { seed = 99 } = {}) {
  const rng = makeRng(seed);
  const rr = (v) => Math.round(v * 100) / 100;
  const out = [];
  let last = null;
  for (const b of (bars || [])) {
    if (last === null || !(dayKey(b.date) > cutDate)) { out.push(b); last = b; continue; }
    const o = last.close;
    const drift = 0.0006 + 0.014 * ((rng() + rng() + rng() + rng() + rng() + rng() - 3) / 1.2);
    const c = o * (1 + drift);
    const nb = {
      ...b,
      open: rr(o), close: rr(c),
      high: rr(Math.max(o, c) * (1 + 0.005 * rng())),
      low: rr(Math.min(o, c) * (1 - 0.005 * rng()))
    };
    out.push(nb); last = nb;
  }
  return out;
}

/**
 * 引擎层未来不变性。run 自己决定怎么把 input 跑成 {equityCurve, trades}。
 * @returns {{ok:boolean, checkedEquity:number, checkedTrades:number, diffs:Array, note:string}}
 */
export function futureInvarianceProbe({ run, base, mutated, cutDate }) {
  const b = run(base) || {};
  const a = run(mutated) || {};
  const diffs = [];
  let checkedEquity = 0, checkedTrades = 0;

  const bc = b.equityCurve || [], ac = a.equityCurve || [];
  for (let i = 0; i < bc.length; i++) {
    if (dayKey(bc[i].date) > cutDate) break;
    checkedEquity++;
    const p = ac[i];
    if (!p || dayKey(p.date) !== dayKey(bc[i].date) || !sameNum(p.equity, bc[i].equity)) {
      diffs.push({ kind: 'equity', date: dayKey(bc[i].date), want: bc[i].equity, got: p ? p.equity : null });
    }
  }
  // 成交记录是按**平仓先后** push 的，不是按开仓。所以只比"切点前已整笔走完"那批：
  // 入场在切点前、出场在切点后的那笔，出场价本就该随被改动的未来变，硬按序号比会串位误报。
  const keyOfTrade = (t) => [t.symbol || '', dayKey(t.entryDate), dayKey(t.exitDate), t.dir, t.lots, t.entryPrice].join('|');
  const settled = (list) => (list || []).filter(t => dayKey(t.exitDate) <= cutDate && dayKey(t.entryDate) <= cutDate).map(keyOfTrade);
  const bt = settled(b.trades), at = settled(a.trades);
  checkedTrades = bt.length;
  for (let i = 0; i < Math.max(bt.length, at.length); i++) {
    if (bt[i] !== at[i]) {
      diffs.push({ kind: 'trade', date: (bt[i] || at[i] || '').split('|')[1] || '?',
                   want: bt[i] || '这笔不存在', got: at[i] || '这笔不存在' });
    }
  }
  return {
    cutDate, checkedEquity, checkedTrades, diffs: diffs.slice(0, 8), ok: diffs.length === 0,
    note: diffs.length === 0
      ? `改动 ${cutDate} 之后的行情：之前 ${checkedEquity} 个权益点与 ${checkedTrades} 笔已了结成交完全没变`
      : `${diffs.length} 处变化（示例 ${diffs[0].kind} ${diffs[0].date}：应为 ${diffs[0].want}，实际 ${diffs[0].got}）`
      + ' —— 未来的数据参与了过去某天的决策，这是前视泄漏'
  };
}

/** 一批策略的总览，测试与界面上报都用它。 */
export function auditStrategies(strategies, bars, opts = {}) {
  return (strategies || []).map(st => {
    try { return signalPrefixProbe(st, bars, st.params || {}, opts); }
    catch (e) { return { id: st.id, ok: false, checked: 0, leaks: [], note: `探针执行失败：${e.message}` }; }
  });
}
