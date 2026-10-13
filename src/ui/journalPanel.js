/**
 * 交易日志面板（计划 M6）。
 *
 * 三个部分：逐笔笔记与标签、按标签/品种/方向/月份/持仓时长的分组统计、复盘检查清单。
 * 统计全部走 replay/journal.js 的纯函数，面板只负责展示与输入 ——
 * 「分组之和必须等于明细总盈亏」是这一层的验收线，写在纯函数里才测得住。
 */

import { makeEntry, attachNotes, groupStats, reconcile, saveEntry, listEntries, deleteEntry, CHECKLIST, DEFAULT_TAGS, TAG_GROUPS, saveChecklist, loadChecklist } from '../replay/journal.js';

const esc = (s) => String(s === null || s === undefined ? '' : s)
  .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = (v, d = 1) => (v === null || v === undefined || !Number.isFinite(v)) ? '—' : Number(v).toFixed(d);
const pc = (v, d = 0) => (v === null || v === undefined || !Number.isFinite(v)) ? '—' : (v * 100).toFixed(d) + '%';
const BTN = 'background:var(--bg-tertiary);color:var(--text-main);border:1px solid var(--border-color);padding:5px 9px;border-radius:4px;font-size:12px;cursor:pointer;min-height:30px;';
const INP = 'background:var(--bg-tertiary);color:#fff;border:1px solid var(--border-color);padding:4px 6px;border-radius:4px;font-size:12px;';
const DIMS = [['tag', '按标签'], ['symbol', '按品种'], ['direction', '按方向'], ['month', '按月份'], ['holding', '按持仓时长']];

export class JournalPanel {
  constructor(rootId, api) {
    this.root = document.getElementById(rootId);
    this.api = api || {};
    this.dim = 'tag';
    this.entries = [];
    this.checklist = {};
    this.openTradeId = null;
    this.bind();
    this.reload();
  }

  get trades() { return this.api.trades?.() || []; }

  async reload() {
    this.entries = await listEntries();
    this.checklist = (await loadChecklist()) || {};
    this.render();
  }

  bind() {
    this.root.addEventListener('click', async (e) => {
      const el = e.target.closest('[data-jn]');
      if (!el) return;
      const act = el.dataset.jn;
      if (act === 'dim') { this.dim = el.dataset.dim; this.render(); }
      else if (act === 'expand') { this.openTradeId = String(this.openTradeId) === String(el.dataset.id) ? null : el.dataset.id; this.render(); }
      else if (act === 'save') await this.saveFromForm(Number(el.dataset.idx));
      else if (act === 'snap') await this.snapshot(Number(el.dataset.idx));
      else if (act === 'del') { await deleteEntry(el.dataset.entryId); await this.reload(); }
      else if (act === 'chk') {
        this.checklist[el.dataset.item] = el.dataset.on === '1';
        await saveChecklist(this.checklist);
        this.render();
      } else if (act === 'export') this.exportMd();
    });
  }

  render() {
    if (!this.root) return;
    const merged = attachNotes(this.trades, this.entries);
    this.merged = merged;
    const rec = reconcile(merged);
    this.root.innerHTML = `
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px;font-size:12px;">
        <b style="color:var(--text-white);">交易日志</b>
        <span style="color:var(--text-muted);">共 ${merged.length} 笔已平仓 · 已标注 ${merged.filter(t => t.hasNote).length} 笔</span>
        ${DIMS.map(([k, l]) => `<button class="btn btn-sm" data-jn="dim" data-dim="${k}" style="${BTN}${this.dim === k ? 'border-color:var(--accent-blue);color:#93c5fd;' : ''}">${l}</button>`).join('')}
        <button class="btn btn-sm" data-jn="export" style="${BTN}">⬇ 导出复盘纪要</button>
      </div>
      ${this.statsHtml(merged)}
      ${this.checklistHtml()}
      ${this.listHtml(merged)}
      <div style="font-size:11px;color:var(--text-muted);margin-top:8px;line-height:1.8;">
        对账：明细总盈亏 <b>${nf(rec.total)} 元</b>；
        ${rec.rows.map(r => `${r.dim} 合计 ${nf(r.sum)}${r.pass ? '✓' : '✗ 差 ' + nf(r.diff)}`).join('　')}
        ${rec.ok ? '<span style="color:var(--down-color);">　分组与明细对得上账</span>'
                 : '<span style="color:var(--up-color);">　⚠ 分组与明细对不上，下面的统计数字不可信</span>'}
        ${rec.tagMultiCounted ? `<br>标签维度按"一笔多标签"分别计入（合计 ${nf(rec.tagSum)} ≠ 总额），看的是相对占比而不是加总。` : ''}
      </div>`;
  }

  statsHtml(merged) {
    const groups = groupStats(merged, this.dim);
    if (!groups.length) return '';
    const label = (DIMS.find(d => d[0] === this.dim) || [])[1] || this.dim;
    return `<div style="overflow:auto;border:1px solid var(--border-color);border-radius:6px;margin-bottom:10px;">
      <table style="width:100%;border-collapse:collapse;font-size:12px;">
        <thead><tr style="background:var(--bg-tertiary);"><th style="text-align:left;padding:4px 7px;">${esc(label)}</th>
          <th>笔数</th><th>胜率</th><th>总盈亏</th><th>单笔均额</th><th>平均盈利</th><th>平均亏损</th><th>盈亏比</th><th>平均持仓</th></tr></thead>
        <tbody>${groups.map(g => `<tr style="border-top:1px solid var(--border-color);">
          <td style="text-align:left;padding:4px 7px;">${esc(g.key)}</td>
          <td>${g.n}</td><td>${pc(g.winRate)}</td>
          <td style="color:${g.pnl >= 0 ? 'var(--up-color)' : 'var(--down-color)'};">${nf(g.pnl)}</td>
          <td>${nf(g.avg)}</td><td>${nf(g.avgWin)}</td><td>${nf(g.avgLoss)}</td>
          <td>${g.payoff === null ? '—' : nf(g.payoff, 2)}</td><td>${nf(g.avgHolding, 1)}根</td></tr>`).join('')}</tbody></table></div>
      ${this.dim === 'tag' && !merged.some(t => t.hasNote)
        ? '<div style="font-size:12px;color:var(--accent-gold);margin-bottom:8px;">还没有任何标注 —— 上面这张表现在是空的。在下面的明细里给几笔打标签，才会出"哪类失误最亏钱"。</div>' : ''}`;
  }

  listHtml(merged) {
    if (!merged.length) {
      return '<div style="color:var(--text-muted);padding:14px;border:1px dashed var(--border-color);border-radius:6px;">还没有已平仓交易。先复盘几笔（或跑一次自动回测）。</div>';
    }
    // 两套引擎的字段名不一样：手动复盘记 direction，自动回测记 dir。
    // 只读一个的话，另一套的空单会被显示成多单 —— 数字对得上但方向是反的。
    const dirOf = (t) => (t.dir || t.direction);
    return `<div style="overflow:auto;max-height:340px;border:1px solid var(--border-color);border-radius:6px;">
      <table style="width:100%;border-collapse:collapse;font-size:12px;">
        <thead><tr style="background:var(--bg-tertiary);color:var(--text-muted);position:sticky;top:0;">
          <th style="text-align:left;padding:4px 7px;">品种</th><th>方向</th><th>区间</th><th>净盈亏</th><th>持仓</th><th>标注</th>
        </tr></thead><tbody>${merged.map((t, i) => {
      const open = String(this.openTradeId) === String(t.id);
      const chips = TAG_GROUPS.flatMap(g => (t.tags?.[g] || []).slice(0, 2).map(v =>
        `<span style="background:rgba(139,92,246,.18);color:#c4b5fd;border-radius:3px;padding:0 4px;font-size:11px;">${esc(v)}</span>`)).join(' ');
      const head = `<tr style="border-top:1px solid var(--border-color);cursor:pointer;" data-jn="expand" data-id="${esc(t.id)}">
        <td style="padding:4px 7px;text-align:left;">${esc(t.symbol || '—')}</td>
        <td>${dirOf(t) === 'short' ? '空' : '多'}</td>
        <td style="color:var(--text-muted);font-size:11px;">${esc(t.entryDate || t.entryTime || '')} → ${esc(t.exitDate || t.exitTime || '')}</td>
        <td style="color:${(t.netPnL || 0) >= 0 ? 'var(--up-color)' : 'var(--down-color)'};">${nf(t.netPnL)}</td>
        <td>${t.holdingBars ?? '—'}</td>
        <td style="text-align:left;">${t.hasNote ? '📝' : ''} ${chips}</td></tr>`;
      return open ? head + `<tr><td colspan="6" style="padding:8px;background:var(--bg-primary);text-align:left;">${this.formHtml(t, i)}</td></tr>` : head;
    }).join('')}</tbody></table></div>`;
  }

  formHtml(t, i) {
    const tags = t.tags || {};
    return `
      <div style="display:grid;gap:6px;">
        <textarea data-f="note" rows="3" placeholder="这一笔：为什么进、为什么出、哪里做错了" style="${INP}width:100%;font-family:inherit;">${esc(t.note || '')}</textarea>
        ${TAG_GROUPS.map(g => `<div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center;">
          <span style="font-size:11px;color:var(--text-muted);min-width:64px;">${esc(g)}</span>
          ${(DEFAULT_TAGS[g] || []).map(v => `<label style="font-size:11px;display:flex;align-items:center;gap:2px;">
            <input type="checkbox" data-tag="${esc(g)}" data-val="${esc(v)}" ${(tags[g] || []).includes(v) ? 'checked' : ''} style="width:auto;" />${esc(v)}</label>`).join('')}
        </div>`).join('')}
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
          <button class="btn btn-sm" data-jn="save" data-idx="${i}" style="${BTN}border-color:var(--accent-blue);color:#93c5fd;">💾 保存笔记</button>
          <button class="btn btn-sm" data-jn="snap" data-idx="${i}" style="${BTN}">📷 附上当前图面快照</button>
          ${t.journal ? `<button class="btn btn-sm" data-jn="del" data-entry-id="${esc(t.journal.id)}" style="${BTN}">🗑 删除笔记</button>` : ''}
          ${t.journal?.updatedAt ? `<span style="font-size:11px;color:var(--text-muted);">更新于 ${esc(t.journal.updatedAt.slice(0, 16).replace('T', ' '))}</span>` : ''}
        </div>
        ${t.journal?.screenshot ? `<img src="${t.journal.screenshot}" style="max-width:340px;border:1px solid var(--border-color);border-radius:4px;margin-top:6px;" alt="交易快照" />` : ''}
      </div>`;
  }

  /** 从展开的表单里收集并落库。 */
  async saveFromForm(i) {
    const t = this.merged[i];
    if (!t) return;
    const row = this.root;
    const note = row.querySelector('[data-f="note"]')?.value || '';
    const tags = {};
    row.querySelectorAll('[data-tag]:checked').forEach(el => {
      const g = el.dataset.tag;
      (tags[g] = tags[g] || []).push(el.dataset.val);
    });
    const prev = t.journal || {};
    const entry = makeEntry(t, { note, tags, screenshot: prev.screenshot || null });
    await saveEntry(entry);
    await this.reload();
    this.api.toast?.('笔记已保存');
  }

  /**
   * 图面快照：抓主 canvas 并降采样成 JPEG。
   * 不降采样的话一张 Retina 截图是 2~4MB 的 base64，IndexedDB 很快就写爆，
   * 而用户看到的只是"保存失败"这种看不懂的消息。
   */
  async snapshot(i) {
    const t = this.merged[i];
    if (!t) return;
    const src = this.api.snapshotCanvas?.();
    if (!src) { this.api.toast?.('拿不到图面 canvas'); return; }
    const w = 560, ratio = w / (src.width || w);
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = Math.max(1, Math.round((src.height || 300) * ratio));
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#12151c'; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.drawImage(src, 0, 0, cv.width, cv.height);
    const data = cv.toDataURL('image/jpeg', 0.6);
    const prev = t.journal || {};
    const entry = makeEntry(t, { note: prev.note || t.note || '', tags: prev.tags || t.tags || {}, screenshot: data });
    await saveEntry(entry);
    await this.reload();
    this.api.toast?.('已附上图面快照（降采样，避免缓存膨胀）');
  }

  checklistHtml() {
    const done = CHECKLIST.filter(c => this.checklist[c.id]).length;
    return `<div style="border:1px solid var(--border-color);border-radius:6px;padding:9px 11px;margin-bottom:10px;">
      <b style="font-size:12px;color:var(--text-white);">复盘检查清单</b>
      <span style="font-size:11px;color:var(--text-muted);margin-left:6px;">${done}/${CHECKLIST.length}</span>
      <div style="display:grid;gap:3px;margin-top:6px;">
        ${CHECKLIST.map(c => `<label style="font-size:12px;display:flex;gap:6px;align-items:center;cursor:pointer;">
          <input type="checkbox" data-jn="chk" data-item="${esc(c.id)}" data-on="${this.checklist[c.id] ? '0' : '1'}" ${this.checklist[c.id] ? 'checked' : ''} style="width:auto;" />
          <span style="${this.checklist[c.id] ? 'color:var(--text-muted);text-decoration:line-through;' : ''}">${esc(c.text)}</span></label>`).join('')}
      </div></div>`;
  }

  /** 导出一份能自己看的 markdown 复盘纪要（纯文本，不依赖任何库）。 */
  exportMd() {
    const merged = attachNotes(this.trades, this.entries);
    const rec = reconcile(merged);
    const lines = ['# 复盘纪要', '', `- 已平仓 ${merged.length} 笔，总盈亏 ${nf(rec.total)} 元`,
      `- 已标注 ${merged.filter(t => t.hasNote).length} 笔`, '', '## 分组统计', ''];
    for (const [dim, label] of DIMS) {
      const g = groupStats(merged, dim);
      if (!g.length) continue;
      lines.push(`### ${label}`, '', `| ${label} | 笔数 | 胜率 | 总盈亏 | 单笔均额 | 盈亏比 |`, '|---|---|---|---|---|---|');
      for (const x of g) lines.push(`| ${x.key} | ${x.n} | ${pc(x.winRate)} | ${nf(x.pnl)} | ${nf(x.avg)} | ${x.payoff === null ? '—' : nf(x.payoff, 2)} |`);
      lines.push('');
    }
    lines.push('## 逐笔', '');
    for (const t of merged) {
      const tg = TAG_GROUPS.flatMap(g => (t.tags?.[g] || []).map(v => `${g}:${v}`)).join(', ');
      lines.push(`- ${t.symbol || ''} ${t.dir === 'short' ? '空' : '多'} ${t.entryDate || ''}→${t.exitDate || ''} 净 ${nf(t.netPnL)}`
        + (tg ? ` [${tg}]` : '') + (t.note ? `\n  ${String(t.note).replace(/\r?\n/g, ' ')}` : ''));
    }
    lines.push('', '## 检查清单', '');
    for (const c of CHECKLIST) lines.push(`- [${this.checklist[c.id] ? 'x' : ' '}] ${c.text}`);
    lines.push('', `对账：${rec.ok ? '分组与明细一致' : '⚠ 分组与明细不一致，统计不可信'}`, '');
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `复盘纪要_${new Date().toISOString().slice(0, 10)}.md`;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
    this.api.toast?.('已导出复盘纪要');
  }
}
