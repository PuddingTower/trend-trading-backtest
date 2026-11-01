/**
 * 界面接线守卫：壳与面板里用到的每个 class 都必须能在 theme.css 找到规则。
 *
 * 这套界面由 bootPage 把 shell.html 注入 #app-root，再靠 body→壳→.workspace 的
 * flex 链把高度传下去。少一条规则不会报错，只会安静地画歪 —— 之前 #app-root 没有
 * 样式导致成交量整块掉到视口外、backtestPanel 写 kpi-label 而主题里只有 kpi-title，
 * 都属于"没有异常、只有难看"这一类，只能靠这种静态对账拦下来。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, assert } from './harness.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

const css = read('assets', 'theme.css');
const styledClasses = new Set([...css.matchAll(/\.([A-Za-z_][\w-]*)/g)].map(m => m[1]));

/** 只做样式钩子的类名：JS 用它们选元素，外观由别的规则负责。 */
const BEHAVIOR_ONLY = new Set(['rsPortPick']);

const TOKEN = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** 从 HTML 片段里取类名；带字符串拼接或模板插值的属性值跳过（不是静态类名）。 */
const classNamesIn = (text) => {
  const out = new Set();
  for (const m of text.matchAll(/class="([^"]*)"/g)) {
    const raw = m[1];
    if (/[$'"`+]/.test(raw)) continue;
    for (const c of raw.split(/\s+/)) if (TOKEN.test(c)) out.add(c);
  }
  // 只取第一个实参：toggle('market-futures', cond) 的第二个参数是条件表达式，不是类名
  for (const m of text.matchAll(/classList\.(?:add|remove|toggle)\(\s*['"`]([^'"`\s]+)['"`]/g))
    if (TOKEN.test(m[1])) out.add(m[1]);
  return out;
};

const uiFiles = [
  path.join('src', 'app', 'shell.html'),
  ...fs.readdirSync(path.join(root, 'src', 'ui')).map(f => path.join('src', 'ui', f)),
  ...fs.readdirSync(path.join(root, 'src', 'app')).filter(f => f.endsWith('.js')).map(f => path.join('src', 'app', f)),
];

test('壳与面板用到的每个 class 都在 theme.css 里有规则', () => {
  const dangling = [];
  for (const rel of uiFiles) {
    for (const cls of classNamesIn(read(rel))) {
      if (!styledClasses.has(cls) && !BEHAVIOR_ONLY.has(cls)) dangling.push(`${cls} (${rel})`);
    }
  }
  assert.eq(dangling.length, 0, '这些类名没有任何样式：' + dangling.join('、'));
});

test('注入壳的 #app-root 带 flex 链（缺了它成交量会掉到视口外）', () => {
  const block = css.match(/(?:^|\n)#app-root\s*\{([^}]*)\}/);
  assert.ok(block, 'theme.css 里没有 #app-root 规则');
  for (const prop of ['display', 'flex-direction', 'flex', 'min-height']) {
    assert.ok(block[1].includes(prop), `#app-root 缺少 ${prop}：body→壳→workspace 的高度链会断`);
  }
});

test('工作台入口页都指向 bootPage，且声明了 data-market', () => {
  for (const page of ['futures.html', 'ashare.html']) {
    const html = read(page);
    assert.ok(html.includes('id="app-root"'), `${page} 没有 #app-root 挂载点`);
    assert.ok(/data-market="(futures|ashare)"/.test(html), `${page} 缺 data-market`);
    assert.ok(html.includes('bootPage.js'), `${page} 没挂 bootPage`);
  }
});
