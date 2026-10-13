import { test, assert } from './harness.js';
import { rowsFromBlocks, rowsFromText, extractCandidates, judge, analyzeLine, analyzeLines, crossCheck, parseTsv } from '../src/watchlist/imageImport.js';
import { makeGroup, addItem, removeItem, toItem, DEFAULT_GROUP_ID } from '../src/watchlist/store.js';

// ---------- OCR 块 → 行 ----------
test('rowsFromBlocks：同一行的散块按 y 聚回一行，并按 x 排序', () => {
  const blocks = [
    { text: '600519', bbox: [10, 10, 70, 26], score: 0.99 },
    { text: '贵州茅台', bbox: [80, 11, 150, 27], score: 0.95 },
    { text: '1685.00', bbox: [160, 9, 220, 25], score: 0.9 },
    { text: 'rb2610', bbox: [10, 40, 70, 56], score: 0.98 },
    { text: '螺纹钢2610', bbox: [80, 41, 170, 57], score: 0.9 }
  ];
  const rows = rowsFromBlocks(blocks);
  assert.eq(rows.length, 2, `应聚成 2 行，实际 ${rows.length}`);
  assert.ok(rows[0].text.indexOf('600519') < rows[0].text.indexOf('贵州茅台'), '行内必须按 x 排序');
  assert.ok(/rb2610/.test(rows[1].text) && /螺纹钢2610/.test(rows[1].text));
  assert.eq(rows[0].score, 0.99, '行得分取块内最高');
});

test('rowsFromBlocks：空输入/无 bbox 不崩', () => {
  assert.eq(rowsFromBlocks([]).length, 0);
  assert.eq(rowsFromBlocks(null).length, 0);
  assert.eq(rowsFromBlocks([{ text: '' }, { text: 'x' }]).length, 0, '没有 bbox 的块无法定位，只能丢弃');
});

// ---------- 抠代码 ----------
test('extractCandidates：6 位码、期货合约、主力写法都能抠出，日期/时间/百分比不会误伤', () => {
  const codes = (line) => extractCandidates(line).map(c => c.code);
  assert.ok(codes('600519 贵州茅台 1685.00 +1.20%').includes('600519'));
  assert.ok(codes('rb2610 3860 0.00%').includes('rb2610'), '期货合约');
  assert.ok(codes('SR609 郑商所').some(c => /^SR/.test(c)), '郑商所 3 位月份码');
  assert.ok(codes('RB0 螺纹钢主连').some(c => /RB0|主连/.test(c)), '主力写法');
  assert.eq(codes('2026-10-14 10:30').length, 0, '日期时间行不该产码');
  assert.eq(codes('4274838').length, 0, '7 位成交量不该被当成 6 位代码');
  assert.eq(codes('1685.00').length, 0, '带小数的价格不是代码');
});

test('extractCandidates：中文品种名+月份按整体抠，不让 2610 被数字规则截走', () => {
  const c = extractCandidates('螺纹钢2610 3860');
  assert.ok(c.some(x => x.code === '螺纹钢2610'), `应保留带品种名的完整写法，实际 ${JSON.stringify(c)}`);
  assert.ok(!c.some(x => x.code === '2610'), '孤立的 2610 不是代码');
});

test('judge：能解析的给 secid，同码多义标 needsReview 而不是自己猜一个', () => {
  const ok = judge({ code: '600519', nameHint: '' });
  assert.ok(ok.ok && ok.secid === '1.600519', `茅台应解析成 1.600519，实际 ${ok.secid}`);
  assert.eq(ok.needsReview, false);

  const amb = judge({ code: '000001', nameHint: '' });
  assert.ok(amb.ok, '000001 本身是能解析的');
  assert.eq(amb.needsReview, true, '000001 平安银行/上证指数同码多义，必须人工确认');

  const bad = judge({ code: '999999', nameHint: '' });
  assert.eq(bad.ok, false, '不存在的代码段必须判失败');
  assert.eq(bad.needsReview, true);
  assert.ok(bad.reason, '失败要给原因，不能只给个空行');
});

test('crossCheck：名称能对上代码表才清掉 needsReview；对不上就留着让人确认', async () => {
  const table = {
    '000001': [
      { code: '000001', name: '平安银行', secid: '0.000001' },
      { code: '000001', name: '上证指数', secid: '1.000001' }
    ]
  };
  const resolve = async (q) => table[q] || [];
  const byName = await crossCheck({ raw: 'x', ...judge({ code: '000001', nameHint: '平安银行' }) }, resolve);
  assert.ok(byName.tableMatch, '名称命中应给出表内匹配');
  assert.eq(byName.tableMatch.secid, '0.000001');
  assert.eq(byName.needsReview, false, '名称交叉校验通过 → 可以自动勾上');

  const mismatch = await crossCheck({ raw: 'x', ...judge({ code: '000001', nameHint: '某某银行' }) }, resolve);
  assert.eq(mismatch.needsReview, true, '名称对不上绝不能自动入池');

  const noTable = await crossCheck({ raw: 'x', ...judge({ code: '600519', nameHint: '' }) }, async () => []);
  assert.eq(noTable.resolvedCount, 0, '检索不可用时如实报告，不假装校验通过');

  // A股名称不在本地规格表里，代码表唯一命中时要回填到名称列，否则预览表全是空名字
  const sole = await crossCheck({ raw: 'x', ...judge({ code: '600519', nameHint: '' }) },
    async () => [{ code: '600519', name: '贵州茅台', secid: '1.600519' }]);
  assert.eq(sole.displayName, '贵州茅台', '唯一命中应回填名称');
  assert.eq(sole.needsReview, false);

  const multi = await crossCheck({ raw: 'x', ...judge({ code: '600519', nameHint: '' }) },
    async () => [{ code: '600519', name: '贵州茅台' }, { code: '600519', name: '另一只' }]);
  assert.eq(multi.displayName, '', '多条命中且没有名称线索时不猜第一个');
});

test('analyzeLine：一行给主选 + 全部备选，未识别行标原因', async () => {
  const row = await analyzeLine('600519 贵州茅台 1685.00');
  assert.eq(row.ok, true);
  assert.eq(row.code, '600519');
  assert.ok(row.options.length >= 1);

  const none = await analyzeLine('成交量 4274838');
  assert.eq(none.ok, false);
  assert.ok(/未识别/.test(none.reason));

  assert.eq(await analyzeLine('   '), null, '空行返回 null，别混进预览表');
});

test('rowsFromText + analyzeLine：模拟 tesseract 的多行输出整条跑通', async () => {
  const ocrText = '600519 贵州茅台 1685.00\n000001 平安银行 11.20\nrb2610 3860\n2026-10-14 10:30\n';
  const rows = rowsFromText(ocrText);
  assert.eq(rows.length, 4);
  const judged = [];
  for (const r of rows) { const a = await analyzeLine(r.text); if (a) judged.push(a); }
  assert.eq(judged.filter(r => r.ok).length, 3, '三行有代码，日期行不该算');
  assert.ok(judged.some(r => r.needsReview), '000001 那行要留在待确认');
});

test('analyzeLines：一行多码全部展开，不吞掉后面的代码', async () => {
  // 实测过的场景：合成截图 OCR 文本完好为两行六码，旧逻辑每行只取第一个 → 预览只剩 2 条
  const lines = ['600519 510300 rb2610', '159915 688981 000700', '2026-10-14 3860'];
  const rows = await analyzeLines(lines, { resolve: null });
  const codes = rows.filter(r => r.ok).map(r => r.code);
  assert.eq(codes.length, 6, `六个代码都该出现，实际 ${codes.join(',')}`);
  for (const c of ['600519', '510300', 'rb2610', '159915', '688981', '000700']) {
    assert.ok(codes.includes(c), `${c} 被吞了`);
  }
  assert.ok(rows.some(r => !r.ok && /未识别/.test(r.reason)), '日期行仍要如实标未识别');
  // 勾选默认值按语义给：唯一可判的默认勾上；同码多义（000700 既是深市股票也是上证指数段）
  // 与未识别的默认不勾 —— 让它进池的必须是用户的手。
  for (const r of rows.filter(x => x.ok && !x.needsReview)) assert.eq(r.checked, true, `${r.code} 应默认勾上`);
  for (const r of rows.filter(x => !x.ok || x.needsReview)) assert.eq(r.checked, false, `${r.code || r.raw} 不该默认勾上`);

  const dup = await analyzeLines(['600519 贵州茅台', '600519 重复行'], { resolve: null });
  assert.eq(dup.filter(r => r.code === '600519').length, 1, '跨行重复代码只保留第一次');

  const named = await analyzeLines(['600519 贵州茅台'], { resolve: null });
  assert.eq(named[0].nameHint, '贵州茅台', '一行一码一名称时可以认定归属');
  const multiNamed = await analyzeLines(['600519 510300 茅台'], { resolve: null });
  assert.eq(multiNamed[0].nameHint, '', '一行多码时名称不能随便归属给第一个');
});

// ---------- 兜底：文本粘贴 ----------
test('parseTsv：行情软件复制的表格直接可入池（零 OCR 依赖）', () => {
  const rows = parseTsv('600519\t贵州茅台\n000001\t平安银行\nrb2610\t螺纹钢2610\n');
  assert.eq(rows.length, 3);
  assert.ok(rows.every(r => r.ok), `每行都应解析成功：${rows.map(r => r.reason).join('/')}`);
  assert.eq(rows[0].secid, '1.600519');
  assert.eq(rows[2].market, 'futures');
  const odd = parseTsv('600519 贵州茅台\n');
  assert.eq(odd[0].code, '600519', '空格分隔也要能吃');
});

// ---------- 自选池业务层 ----------
test('自选池：按 secid 判重，同品种不同写法不算两个', () => {
  const g = makeGroup('我的持仓', 'g1');
  assert.eq(addItem(g, '600519').ok, true);
  assert.eq(addItem(g, 'sh600519').duplicate, true, '显式前缀写法解析出的还是同一个 secid');
  assert.eq(g.items.length, 1);
  assert.eq(addItem(g, '999999').ok, false, '非法代码拒绝入池');
  assert.eq(addItem(g, '600519').reason.includes('已在分组里'), true);
  assert.eq(removeItem(g, '1.600519'), true);
  assert.eq(g.items.length, 0);
});

test('自选池：期货三种写法都归到同一个主连 secid', () => {
  const items = ['rbm', 'RB0', '螺纹钢主连'].map(c => toItem(c));
  assert.ok(items.every(i => i.ok), '三种写法都必须能解析');
  assert.eq(new Set(items.map(i => i.item.secid)).size, 1, `应归一到同一 secid，实际 ${items.map(i => i.item.secid).join(',')}`);
  assert.eq(items[0].item.isDominant, true);
});

test('toItem：不认识的品种给明确原因，不返回半成品', () => {
  const bad = toItem('ZZZZ9999');
  assert.eq(bad.ok, false);
  assert.ok(bad.reason && bad.reason.length > 0);
  assert.eq(bad.item, undefined, '解析失败时不能带出一个缺字段的 item');
});

test('makeGroup 默认分组常量与 toItem 字段完整', () => {
  const g = makeGroup('  测试  ');
  assert.eq(g.name, '测试', '首尾空白要清掉');
  assert.eq(g.items.length, 0);
  assert.eq(DEFAULT_GROUP_ID, 'default');
  const it = toItem('510300').item;
  for (const k of ['secid', 'symbol', 'market']) assert.ok(it[k], `入库项必须有 ${k}`);
});
