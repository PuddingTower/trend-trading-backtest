import { test, assert } from './harness.js';
import { makeRng, pickBlindSegment, canReveal, blindBadge, segmentFingerprint } from '../src/replay/blind.js';
import { makeEntry, journalId, attachNotes, groupStats, reconcile, CHECKLIST, TAG_GROUPS, DEFAULT_TAGS } from '../src/replay/journal.js';

const mk = (date, o, h, l, c, v = 1000) => ({ date, open: o, high: h, low: l, close: c, volume: v });
function series(n, start = 100) {
  return Array.from({ length: n }, (_, i) => mk(`2024-01-${String(i + 1).padStart(2, '0')}`, start + i, start + i + 1, start + i - 1, start + i + 0.5));
}

// ---------- 随机与可复现 ----------
test('makeRng：同种子必须给出同一序列（抽题要能重放）', () => {
  const a = makeRng(12345), b = makeRng(12345);
  const xs = Array.from({ length: 8 }, () => a());
  const ys = Array.from({ length: 8 }, () => b());
  assert.eq(xs.join(','), ys.join(','), '同种子应逐值相同');
  assert.ok(xs.every(x => x >= 0 && x < 1), '取值必须在 [0,1)');
  assert.ok(makeRng(1)() !== makeRng(2)(), '不同种子不该给出同一个首值');
});

// ---------- 抽题与防泄露 ----------
test('pickBlindSegment：只交出抽取区间，之后的 bar 一律不在返回值里', () => {
  const pool = [
    { name: '螺纹钢主连', bars: series(300) },
    { name: '贵州茅台', bars: series(260) }
  ];
  const s = pickBlindSegment(pool, { rangeLen: 120, seed: 42 });
  assert.ok(s, '应能抽到题');
  assert.eq(s.bars.length, 120, '交出的 bar 数必须正好是区间长度');
  assert.eq(s.revealIdx, 0, '揭示点必须在区间第一根，不能从中间开始看');
  assert.ok(s.endIdx < 300 && s.startIdx >= 0);
  // 这是"真的没有"而不是"藏起来"：后面 180 根根本不在对象里
  assert.ok(!('allBars' in s) && !('future' in s), '返回值里不许夹带区间外的数据');
  const srcTotal = pool.find(p => p.name === s.label).bars.length;
  assert.ok(s.startIdx + s.bars.length <= srcTotal, '抽取区间必须落在原序列内');
});

test('pickBlindSegment：同种子复现同一道题，不同种子换题', () => {
  const pool = [{ name: 'A', bars: series(400) }, { name: 'B', bars: series(400) }];
  const s1 = pickBlindSegment(pool, { rangeLen: 100, seed: 999 });
  const s2 = pickBlindSegment(pool, { rangeLen: 100, seed: 999 });
  assert.eq(s1.startIdx, s2.startIdx, '同种子必须抽到同一起点');
  assert.eq(s1.pick.name, s2.pick.name, '同种子必须抽到同一品种');
  assert.eq(segmentFingerprint(s1.bars), segmentFingerprint(s2.bars));
  const other = pickBlindSegment(pool, { rangeLen: 100, seed: 1000 });
  assert.ok(other.startIdx !== s1.startIdx || other.pick.name !== s1.pick.name, '换种子应该换题');
});

test('pickBlindSegment：池子为空或长度不够时返回 null 而不是硬抽', () => {
  assert.eq(pickBlindSegment([], { rangeLen: 100 }), null);
  assert.eq(pickBlindSegment(null, { rangeLen: 100 }), null);
  assert.eq(pickBlindSegment([{ name: '短', bars: series(50) }], { rangeLen: 120 }), null, '不足 rangeLen 的品种不能入选');
});

test('canReveal / blindBadge：推进到区间末尾之前不给答案', () => {
  const s = pickBlindSegment([{ name: '沪深300ETF', bars: series(200) }], { rangeLen: 100, seed: 5 });
  assert.eq(canReveal(s, 10), false, '刚看 10 根不许揭示');
  assert.eq(canReveal(s, s.bars.length - 1), false, '差一根也不许揭示');
  assert.eq(canReveal(s, s.bars.length), true);
  const early = blindBadge(s, 10);
  assert.eq(early.answer, null, '遮罩里不许提前漏出品种名');
  assert.ok(/隐藏品种/.test(early.symbolText));
  assert.eq(early.dateText, '第 10 / 100 根');
  const late = blindBadge(s, 100);
  assert.eq(late.answer, '沪深300ETF', '看完才给答案');
  assert.eq(blindBadge(null, 1), null, '不在盲复盘中时返回 null');
});

test('segmentFingerprint：同段稳定、不同段可区分', () => {
  const s = series(200);
  const a = s.slice(0, 100), b = s.slice(0, 100), c = s.slice(50, 150);
  assert.eq(segmentFingerprint(a), segmentFingerprint(b), '同一段必须给同一个指纹（题目去重用）');
  assert.ok(segmentFingerprint(a) !== segmentFingerprint(c), '不同区间应给不同指纹');
  assert.eq(segmentFingerprint([]), '');
});

// ---------- 日志笔记 ----------
const trades = [
  { id: 1, symbol: 'rbm', dir: 'long', netPnL: 1200, holdingBars: 3, entryDate: '2024-03-01', exitDate: '2024-03-04' },
  { id: 2, symbol: 'rbm', dir: 'short', netPnL: -600, holdingBars: 9, entryDate: '2024-03-05', exitDate: '2024-03-14' },
  { id: 3, symbol: '600519', dir: 'long', netPnL: 4300, holdingBars: 40, entryDate: '2024-04-01', exitDate: '2024-06-10' },
  { id: 4, symbol: '600519', dir: 'long', netPnL: -1500, holdingBars: 2, entryDate: '2024-06-11', exitDate: '2024-06-13' }
];

test('makeEntry：同一笔交易的 id 稳定，重复编辑覆盖而不是新增', () => {
  const e1 = makeEntry(trades[0], { note: '突破跟进', tags: { setup: ['突破'], '失误': ['追高'] } });
  const e2 = makeEntry(trades[0], { note: '改一下', tags: { setup: ['趋势跟随'] } });
  assert.eq(e1.id, e2.id, '笔记 id 必须由交易本身决定');
  assert.eq(e1.tradeId, 1);
  assert.eq(e2.note, '改一下');
  assert.ok(Array.isArray(e2.tags.setup) && e2.tags.setup[0] === '趋势跟随');
  assert.eq(e2.tags['失误'].length, 0, '没给的标签组要给空数组，不然统计端要到处判空');
  const long = makeEntry(trades[0], { note: 'x'.repeat(9000) });
  assert.ok(long.note.length <= 4000, '笔记要有上限，否则一次误粘贴就写爆 IndexedDB');
});

test('makeEntry：一笔带多个标签时按组归一，并限制每组条数', () => {
  const e = makeEntry(trades[1], { tags: { setup: ['突破', ' 回调 ', ''], 情绪: ['贪婪', '冷静', '犹豫', '恐惧', 'a', 'b', 'c'] } });
  assert.eq(e.tags.setup.join(','), '突破,回调', '要去空白去空项');
  assert.eq(e.tags.情绪.length, 6, '每组最多 6 个，防止把整段心得塞进标签');
  for (const g of TAG_GROUPS) assert.ok(g in e.tags, `缺了标签组 ${g}`);
});

test('attachNotes：按 tradeId 挂上笔记，挂不上的不造假笔记', () => {
  const notes = [makeEntry(trades[0], { note: 'ok', tags: { setup: ['突破'] } })];
  const merged = attachNotes(trades, notes);
  assert.eq(merged.length, 4);
  assert.eq(merged[0].hasNote, true);
  assert.eq(merged[0].note, 'ok', 'note 必须是笔记正文，不是整条记录');
  assert.eq(merged[0].journal.tradeId, 1, '整条原始记录放在 journal 字段上');
  assert.eq(merged[1].hasNote, false, '没写过的交易不该被造出一条空笔记');
  assert.eq(merged[1].tags.setup.length, 0);
});

// ---------- 分组统计与对账 ----------
test('groupStats：按品种/方向/月份/持仓时长聚合出笔数、胜率、盈亏与盈亏比', () => {
  const merged = attachNotes(trades, [makeEntry(trades[0], { tags: { setup: ['突破'] } })]);
  const bySym = groupStats(merged, 'symbol');
  const rbm = bySym.find(g => g.key === 'rbm');
  assert.eq(rbm.n, 2);
  assert.eq(rbm.pnl, 600, '1200 - 600');
  assert.eq(rbm.winRate, 0.5);
  assert.near(rbm.payoff, (1200 / 1) / (600 / 1), 1e-9, '盈亏比 = 平均盈利 / 平均亏损');
  const byDir = groupStats(merged, 'direction');
  assert.eq(byDir.find(g => g.key === 'long').n, 3);
  const byMonth = groupStats(merged, 'month');
  assert.ok(byMonth.some(g => g.key === '2024-03'));
  const byHold = groupStats(merged, 'holding');
  assert.ok(byHold.some(g => g.key === '≤2根') && byHold.some(g => g.key === '>20根'));
  assert.eq(groupStats([], 'symbol').length, 0, '空明细不能崩');
});

test('reconcile：分组统计之和必须与交易明细总盈亏对得上账（M6 验收线）', () => {
  const rec = reconcile(trades);
  assert.eq(rec.total, 3400, '1200-600+4300-1500');
  assert.eq(rec.ok, true, `对账必须通过：${JSON.stringify(rec.rows)}`);
  for (const row of rec.rows) {
    assert.eq(row.pass, true, `${row.dim} 维度分组的盈亏之和与明细不等：sum=${row.sum} 期望 ${rec.total}`);
    assert.eq(row.diff, 0);
  }
  assert.ok(DEFAULT_TAGS.setup.length > 0, '默认标签集要能直接给 UI 用');
});

test('reconcile：一笔多标签会让标签维度的和多于总额，这是如实标注而不是 bug', () => {
  const tagged = attachNotes(trades, [
    makeEntry(trades[0], { tags: { setup: ['突破'], '失误': ['追高'], 情绪: ['贪婪'] } })
  ]);
  const rec = reconcile(tagged);
  const oneTrade = groupStats(tagged, 'tag').find(g => g.key === '突破');
  assert.eq(oneTrade.pnl, 1200, '同一笔盈亏要落进它的每一个标签组');
  assert.eq(rec.tagMultiCounted, true, '标签维度天然多计，必须显式说明');
  assert.eq(rec.ok, true, '严格对账只对"一笔只落一组"的维度做，标签不参与');
  const empty = reconcile([]);
  assert.eq(empty.ok, true, '空明细对账为 0 = 0');
  assert.eq(empty.total, 0);
});

test('CHECKLIST 项都有 id 且文案非空（复盘检查清单要能勾选）', () => {
  assert.ok(CHECKLIST.length >= 5);
  const ids = CHECKLIST.map(c => c.id);
  assert.eq(new Set(ids).size, ids.length, '检查项 id 不能重复');
  assert.ok(CHECKLIST.every(c => c.text && c.text.length > 4));
});
