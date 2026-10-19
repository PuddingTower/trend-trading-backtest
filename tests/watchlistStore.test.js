/**
 * 自选池存储层：降级路径与删除不复活。
 *
 * node 里没有 window.indexedDB，openDB 的 try 会走到 resolve(null) ——
 * 这正好复刻"浏览器不让用 IndexedDB"的真实处境（隐私模式、被别的标签页攥住、
 * file:// 打开），所以这条测试测的是那条最容易静默失联的路径。
 * localStorage 用内存 stub 顶上（模块只在函数内部访问它，动态 import 即可注入）。
 */
import { test, assert } from './harness.js';

function makeStorageStub() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; }
  };
}

globalThis.localStorage = makeStorageStub();
const { BarStore } = await import('../src/data/barStore.js');

const g = (groupId, name, items) => ({ groupId, name, items, createdAt: '2026-01-01T00:00:00.000Z' });

test('没有 IndexedDB 时：保存要落到 localStorage 并如实报 where', async () => {
  const r = await BarStore.putWatchlist(g('default', '默认分组', [{ symbol: '600519', name: '贵州茅台' }]));
  assert.eq(r.ok, true, `应当算保存成功（有兜底），实际 ${JSON.stringify(r)}`);
  assert.eq(r.where, 'localstorage', `没 IDB 就必须报降级，实际 ${JSON.stringify(r)}`);
  const st = BarStore.storageStatus();
  assert.eq(st.idb, false, `存储健康状态要记下 IndexedDB 不可用：${JSON.stringify(st)}`);
  assert.eq(st.ls, true, 'localStorage 这条兜底得是活的');
});

test('读回来：镜像里的分组不丢，字段完整', async () => {
  const list = await BarStore.listWatchlist();
  assert.eq(list.length, 1, `应读到 1 个分组，实际 ${list.length}`);
  assert.eq(list[0].groupId, 'default');
  assert.eq(list[0].items[0].symbol, '600519');
  assert.ok(typeof list[0].updatedAt === 'string' && list[0].updatedAt.length >= 20, 'updatedAt 要盖上，合并时靠它分主次');
});

test('删除：镜像里一起清掉，不许下次 list 又把它捞回来', async () => {
  await BarStore.putWatchlist(g('g_watch', '观察', [{ symbol: 'rbm' }]));
  assert.ok((await BarStore.listWatchlist()).some(x => x.groupId === 'g_watch'), '先要存上');
  await BarStore.deleteWatchlist('g_watch');
  const after = await BarStore.listWatchlist();
  assert.ok(!after.some(x => x.groupId === 'g_watch'), `删掉之后又复活了：${after.map(x => x.groupId).join(',')}`);
});

test('同组以 IndexedDB 为主：镜像只补 IDB 里没有的分组', async () => {
  // 先写一份"陈旧镜像"：同一个 default 组，但内容更旧
  const mapKey = 'frt.watchlist.v1';
  const stale = g('default', '默认分组', [{ symbol: '000001' }]);
  localStorage.setItem(mapKey, JSON.stringify({ default: stale }));
  const fresh = g('default', '默认分组', [{ symbol: '600519' }]);
  await BarStore.putWatchlist(fresh);
  const list = await BarStore.listWatchlist();
  const d = list.find(x => x.groupId === 'default');
  assert.eq(list.length, 1, `不该因为合并多出分组：${list.map(x => x.groupId).join(',')}`);
  assert.eq(d.items[0].symbol, '600519', '同一个 groupId 只能有一份，且以主存为准');
});

test('localStorage 也写不进（配额/隐私）时：必须报 ok:false，不能再弹"已保存"', async () => {
  const good = globalThis.localStorage;
  globalThis.localStorage = { getItem: () => { throw new Error('QuotaExceededError'); }, setItem: () => { throw new Error('QuotaExceededError'); } };
  const r = await BarStore.putWatchlist(g('g_ro', '只读', []));
  assert.eq(r.ok, false, `两处都失败就是没保存：${JSON.stringify(r)}`);
  assert.eq(r.where, 'none');
  globalThis.localStorage = good;
});

// ---------- 月份合约 → 主连（「日线只有一个月，没法回测」的正解） ----------
const { toDominant, toItem } = await import('../src/watchlist/store.js');

test('toDominant：截图里那批月份合约全部换成同品种主连', () => {
  const cases = [
    ['rb2701', '113.rbm'], ['i2701', '114.im'], ['SA701', '115.SAm'], ['FG701', '115.FGm'],
    ['TA701', '115.TAm'], ['MA701', '115.MAm'], ['fu2701', '113.fum'], ['p2701', '114.pm'],
    ['m2701', '114.mm'], ['lc2701', '225.lcm'], ['al2612', '113.alm']
  ];
  for (const [raw, want] of cases) {
    const src = toItem(raw, '');
    assert.ok(src.ok, `${raw} 本身就该能入池：${src.reason}`);
    const dom = toDominant(src.item);
    assert.ok(dom, `${raw} 应该能换成主连`);
    assert.eq(dom.secid, want, `${raw} 换出来的主连不对`);
    assert.eq(dom.isDominant, true, `${raw} → ${dom.openCode} 必须是主连，否则历史照样短`);
  }
});

test('toDominant：已经是主连的原样返回 null，不许把 rbm 再换一次换出个别的', () => {
  const dom = toItem('RB0', '');
  assert.ok(dom.ok && dom.item.isDominant);
  assert.eq(toDominant(dom.item), null);
});

test('toDominant：A股与解析不出品种的，返回 null 而不是硬凑一个代码', () => {
  assert.eq(toDominant({ market: 'ashare', symbol: '600519', openCode: '600519' }), null);
  assert.eq(toDominant({ market: 'futures', symbol: '???' }), null);
  assert.eq(toDominant(null), null);
});

test('openCode 回喂必须落回同一个 secid（铁矿石主连 im 会被判成中证1000，是这条的真实由来）', async () => {
  const { FUTURES_SPECS } = await import('../src/markets/contractSpecs.js');
  const { parseSymbol } = await import('../src/markets/symbolMeta.js');
  const bad = [];
  for (const variety of Object.keys(FUTURES_SPECS)) {
    const res = toItem(`${variety}0`, '');
    if (!res.ok) { bad.push(`${variety}0 解析失败：${res.reason}`); continue; }
    const back = parseSymbol(res.item.openCode);
    if (!back.ok || back.secid !== res.item.secid) {
      bad.push(`${variety}0 → openCode=${res.item.openCode} → 回喂成 ${back.ok ? back.secid + '(' + back.name + ')' : '失败'}`);
    }
  }
  assert.ok(!bad.length, `这些品种点「看盘」会打开另一个品种：\n        ${bad.join('\n        ')}`);
});
