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
