/**
 * 自选池存储层。
 *
 * M1 就把 watchlist / symbols 两个 store 建进了 IndexedDB v2，BarStore 里的
 * putWatchlist / listWatchlist 也一并写完了 —— 但前端从来没有一处调用它们，
 * 于是「自选池」这个功能一直等于不存在（线上、本地都没有）。这一层补上业务形状
 * 与增删改，不做渲染，也不碰网络。
 *
 * 全部走浏览器 API（IndexedDB + 代码表 JSONP），所以线上版与本地版行为一致。
 *
 * 分组记录：{ groupId, name, items: [{ secid, symbol, name, market, kind, board,
 * exchange, isDominant }], createdAt, updatedAt }
 */

import { BarStore } from '../data/barStore.js';
import { parseSymbol } from '../markets/symbolMeta.js';

export const DEFAULT_GROUP_ID = 'default';

const nowISO = () => new Date().toISOString();

export function makeGroup(name = '新分组', groupId) {
  return {
    groupId: groupId || `g_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    name: String(name).trim().slice(0, 24) || '未命名',
    items: [],
    createdAt: nowISO(),
    updatedAt: nowISO()
  };
}

/** 一条候选文本 → 可直接入库的品种项。解析权全交给 symbolMeta，这里不写正则。 */
export function toItem(rawCode, nameHint = '') {
  const parsed = parseSymbol(String(rawCode || '').trim(), nameHint);
  if (!parsed.ok) return { ok: false, reason: parsed.reason || '无法解析', input: rawCode };
  // 存一份「再次打开时该喂什么」的原文：000001 直接回喂会被重新判成沪市指数，
  // 同码多义的品种必须带上交易所前缀才能稳定回到用户当初确认的那一个。
  const openCode = parsed.market === 'ashare' && parsed.ambiguous && parsed.exchange
    ? `${String(parsed.exchange).toLowerCase()}${parsed.code}`
    : (parsed.code || parsed.contractCode);
  return {
    ok: true,
    item: {
      secid: parsed.secid,
      symbol: parsed.code || parsed.contractCode,
      openCode,
      name: parsed.name || (nameHint ? String(nameHint).trim() : ''),
      market: parsed.market,
      kind: parsed.kind || (parsed.market === 'futures' ? 'futures' : undefined),
      board: parsed.board,
      exchange: parsed.exchange,
      isDominant: parsed.isDominant,
      // 新浪那条兜底通道只认 <品种>0，跟东财的 <品种>m 不通用，所以入池时就存下来
      sinaCode: parsed.sinaCode,
      ambiguous: parsed.ambiguous || undefined
    }
  };
}

/**
 * 加入品种。重复的按 secid 判重 —— 同一个「螺纹钢主连」写成 rbm / RB0 / 螺纹钢主连
 * 解析结果都是 113.rbm，按原文判重会放进一堆同一个品种。
 */
export function addItem(group, rawCode, nameHint = '') {
  const res = toItem(rawCode, nameHint);
  if (!res.ok) return res;
  const exists = (group.items || []).some(i => i.secid === res.item.secid);
  if (exists) return { ok: false, reason: `已在分组里（${res.item.secid}）`, duplicate: true, input: rawCode };
  group.items = (group.items || []).concat([res.item]);
  group.updatedAt = nowISO();
  return { ok: true, item: res.item };
}

export function removeItem(group, secid) {
  const before = (group.items || []).length;
  group.items = (group.items || []).filter(i => i.secid !== secid);
  group.updatedAt = nowISO();
  return before !== (group.items || []).length;
}

/** 列表永远至少有一个可写的分组，否则新用户进来无处可加。 */
export async function listGroups() {
  const raw = (await BarStore.listWatchlist()) || [];
  const groups = raw.map(g => ({ ...makeGroup(g.name, g.groupId), ...g, items: Array.isArray(g.items) ? g.items : [] }));
  if (!groups.some(g => g.groupId === DEFAULT_GROUP_ID)) groups.unshift(makeGroup('默认分组', DEFAULT_GROUP_ID));
  return groups.sort((a, b) => (a.groupId === DEFAULT_GROUP_ID ? -1 : b.groupId === DEFAULT_GROUP_ID ? 1
    : String(a.createdAt).localeCompare(String(b.createdAt))));
}

export function getGroup(groups, groupId) {
  return groups.find(g => g.groupId === groupId) || groups[0] || makeGroup('默认分组', DEFAULT_GROUP_ID);
}

/** 保存分组：把「存到哪了」如实带回给界面，成功提示不许无条件弹。 */
export async function saveGroup(group) {
  const r = await BarStore.putWatchlist({ ...group, updatedAt: nowISO() });
  return r && typeof r === 'object' ? r : { ok: !!r, where: r ? 'indexeddb' : 'none' };
}

/** 存储现状（IndexedDB / localStorage 兜底 / 失败原因）。 */
export function storageStatus() {
  return typeof BarStore.storageStatus === 'function'
    ? BarStore.storageStatus() : { idb: null, ls: null, note: '存储层未提供状态' };
}

export async function deleteGroup(groupId) {
  if (groupId === DEFAULT_GROUP_ID) return { ok: false, reason: '默认分组不可删除（可以清空它的品种）' };
  await BarStore.deleteWatchlist(groupId);
  return { ok: true };
}

/** 批量入池：逐条给结果，失败的绝不静默丢 —— 错代码入池比不入更糟。 */
export async function addMany(groupId, entries) {
  const groups = await listGroups();
  const group = getGroup(groups, groupId);
  const results = [];
  for (const e of entries) {
    const raw = typeof e === 'string' ? e : e.code;
    const hint = typeof e === 'string' ? '' : (e.name || '');
    const r = addItem(group, raw, hint);
    results.push({ input: raw, name: hint, ok: r.ok, reason: r.reason, item: r.item });
  }
  if (results.some(r => r.ok)) await saveGroup(group);
  return { group, results, added: results.filter(r => r.ok).length };
}
