/** 零依赖测试骨架：test(name, fn) 注册，runAll() 汇总。 */
const cases = [];
export const test = (name, fn) => cases.push({ name, fn });

/** 依赖外部数据的用例在数据缺失时明确 skip —— 报"通过"是撒谎，报"失败"是噪音。 */
class Skipped extends Error {}
export const skip = (why) => { throw new Skipped(why); };

export const assert = {
  ok(v, msg) { if (!v) throw new Error(msg || `期望真值，得到 ${JSON.stringify(v)}`); },
  eq(a, b, msg) {
    if (a !== b) throw new Error(`${msg || '值不相等'}: 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
  },
  deep(a, b, msg) {
    const sa = JSON.stringify(a), sb = JSON.stringify(b);
    if (sa !== sb) throw new Error(`${msg || '结构不相等'}:\n  期望 ${sb}\n  实际 ${sa}`);
  },
  near(a, b, eps, msg) {
    if (Math.abs(a - b) > eps) throw new Error(`${msg || '超出容差'}: 期望≈${b}，实际 ${a}（容差 ${eps}）`);
  },
  throws(fn, match, msg) {
    try { fn(); } catch (e) {
      if (match && !String(e.message).includes(match)) throw new Error(`${msg || '报错文案不符'}: ${e.message}`);
      return;
    }
    throw new Error(msg || '期望抛错但没有');
  }
};

export async function runAll(label = '') {
  let pass = 0, fail = 0, skipped = 0;
  for (const c of cases) {
    try {
      await c.fn();
      pass++;
      process.stdout.write(`  \x1b[32m✓\x1b[0m ${c.name}\n`);
    } catch (e) {
      if (e instanceof Skipped) {
        skipped++;
        process.stdout.write(`  \x1b[33m○\x1b[0m ${c.name} \x1b[33m(skip: ${e.message})\x1b[0m\n`);
        continue;
      }
      fail++;
      process.stdout.write(`  \x1b[31m✗\x1b[0m ${c.name}\n      ${String(e.message).split('\n').join('\n      ')}\n`);
    }
  }
  process.stdout.write(`\n${label} ${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}\n`);
  return { pass, fail, skipped };
}
