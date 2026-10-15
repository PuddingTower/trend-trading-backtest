/**
 * 自选池面板（M3）。
 *
 * 这一块本来就该早做：IndexedDB v2 里 watchlist/symbols 两个 store 和读写方法
 * M1 就写完了，只是前端从没调用过，所以「自选池」在线上线下都不存在。
 *
 * 面板自己不做解析、不做撮合：
 *   代码解析 → markets/symbolMeta；入库 → watchlist/store；
 *   识图 → watchlist/imageImport（有本地后端用 rapidocr，没有就浏览器 tesseract）。
 *
 * 线上版与本地版在这里是同一套代码，唯一差别只有 OCR 走哪条通道。
 */

import { listGroups, getGroup, makeGroup, saveGroup, deleteGroup, addItem, removeItem, toItem, storageStatus } from '../watchlist/store.js';
import { runOcr, analyzeLine, analyzeLines, parseTsv, crossCheck, OCR_LANGS } from '../watchlist/imageImport.js';
import { resolveSymbol, fetchBars } from '../data/sources.js';
import { cacheBars, barKey } from '../data/barStore.js';

const esc = (s) => String(s === null || s === undefined ? '' : s)
  .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const inp = 'background:var(--bg-tertiary);color:#fff;border:1px solid var(--border-color);padding:5px 8px;border-radius:4px;font-size:13px;';
const btn = 'background:var(--bg-tertiary);color:var(--text-main);border:1px solid var(--border-color);padding:6px 12px;border-radius:4px;font-size:13px;cursor:pointer;min-height:34px;';
const btnHi = 'background:rgba(41,98,255,.18);color:#93c5fd;border:1px solid var(--accent-blue);padding:6px 12px;border-radius:4px;font-size:13px;cursor:pointer;min-height:34px;';
const MARKET_LABEL = { ashare: 'A股/ETF/指数', futures: '期货' };

export class WatchlistPanel {
  /**
   * @param {string} rootId 容器 id
   * @param {{openSymbol:(code:string)=>void, toast:(msg:string)=>void}} api
   */
  constructor(rootId, api) {
    this.root = document.getElementById(rootId);
    this.api = api || {};
    this.groups = [];
    this.groupId = null;
    this.rows = [];
    this.view = 'list';       // list | import
    this.engine = 'auto';
    this.lang = 'eng';
    this.busy = '';
    this.mode = 'image';      // image | text
    this.bind();
    this.reload();
  }

  get group() { return getGroup(this.groups, this.groupId); }

  async reload() {
    this.groups = await listGroups();
    if (!this.groups.some(g => g.groupId === this.groupId)) this.groupId = this.groups[0].groupId;
    this.render();
    this.warnStorage();
  }

  /**
   * 存储坏了要在进面板那一刻就说，而不是等用户刷新之后发现自选股没了。
   * 以前 IDB 打不开、或被别的标签页攥住时所有失败都被咽掉，成功提示照样弹。
   */
  warnStorage() {
    if (this._storageWarned) return;
    const st = storageStatus();
    if (st.idb === false || st.ls === false) {
      this._storageWarned = true;
      this.api.toast && this.api.toast(`⚠️ 本地存储受限：${st.note || 'IndexedDB 不可用'}。`
        + (st.ls === true ? '自选池改用 localStorage 保存，换浏览器需重新导入。'
                          : '本次改动不会保留 —— 请关掉旧版标签页或退出隐私模式后刷新。'));
    }
  }

  /** 保存并把结果讲清楚：真的写进去了吗、写到哪了。 */
  async save(group, okMsg) {
    const r = await saveGroup(group);
    if (this.api.toast) {
      this.api.toast(r && r.ok
        ? (r.where === 'indexeddb' ? okMsg : `${okMsg}（已降级存进 localStorage）`)
        : '⚠️ 没能保存：浏览器拒绝写入本地存储（隐私模式或配额已满），本次改动只在这一页有效');
    }
    return r;
  }

  bind() {
    // 事件全部委托：面板内容每次重绘都会重建 DOM
    this.root.addEventListener('click', (e) => {
      const el = e.target.closest('[data-wl]');
      if (!el) return;
      const act = el.dataset.wl;
      if (act === 'newGroup') this.onNewGroup();
      else if (act === 'renameGroup') this.onRenameGroup();
      else if (act === 'deleteGroup') this.onDeleteGroup();
      else if (act === 'addItem') this.onAddItem();
      else if (act === 'open') this.onOpen(el.dataset.code);
      else if (act === 'del') this.onDeleteItem(el.dataset.secid);
      else if (act === 'import') this.setView('import');
      else if (act === 'backList') this.setView('list');
      else if (act === 'modeImage') { this.mode = 'image'; this.render(); }
      else if (act === 'modeText') { this.mode = 'text'; this.render(); }
      else if (act === 'commit') this.onCommit();
      else if (act === 'chooseFile') this.fileInput && this.fileInput.click();
      else if (act === 'runOcr') this.onRunOcr();
      else if (act === 'parseText') this.onParseText();
      else if (act === 'clearRows') { this.rows = []; this.renderImport(); }
      else if (act === 'toggleRow') this.onToggleRow(el.dataset.idx);
      else if (act === 'pullGroup') this.onBatchPull();
    });
    this.root.addEventListener('change', (e) => {
      const el = e.target.closest('[data-wl]');
      if (!el) return;
      if (el.dataset.wl === 'switchGroup') { this.groupId = el.value; this.render(); }
      else if (el.dataset.wl === 'engine') { this.engine = el.value; }
      else if (el.dataset.wl === 'lang') { this.lang = el.value; }
      else if (el.dataset.wl === 'codeEdit') this.onEditCode(el.dataset.idx, el.value);
    });
    this.root.addEventListener('paste', (e) => {
      if (this.view !== 'import' || this.mode !== 'image') return;
      const item = Array.from((e.clipboardData || {}).items || []).find(i => i.type.startsWith('image/'));
      if (item) { e.preventDefault(); this.pendingFile = item.getAsFile(); this.renderImport(); this.onRunOcr(); }
    });
    this.root.addEventListener('dragover', (e) => { e.preventDefault(); });
    this.root.addEventListener('drop', (e) => {
      if (this.view !== 'import') return;
      e.preventDefault();
      const f = (e.dataTransfer || {}).files && e.dataTransfer.files[0];
      if (f) { this.pendingFile = f; this.onRunOcr(); }
    });
  }

  setView(v) { this.view = v; this.render(); }

  render() {
    if (!this.root) return;
    const head = `
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:2px 0 10px;">
        <select data-wl="switchGroup" style="${inp}min-width:130px;">
          ${this.groups.map(g => `<option value="${esc(g.groupId)}" ${g.groupId === this.groupId ? 'selected' : ''}>${esc(g.name)}（${g.items.length}）</option>`).join('')}
        </select>
        <button class="btn btn-sm" style="${btn}" data-wl="newGroup">＋ 新分组</button>
        <button class="btn btn-sm" style="${btn}" data-wl="renameGroup">✏️ 重命名</button>
        <button class="btn btn-sm" style="${btn}" data-wl="deleteGroup">🗑 删分组</button>
        <span style="flex:1"></span>
        ${this.view === 'list'
          ? `<button class="btn btn-sm" style="${btnHi}" data-wl="import">🖼 识图 / 文本导入</button>`
          : `<button class="btn btn-sm" style="${btn}" data-wl="backList">← 返回自选池</button>`}
      </div>`;
    this.root.innerHTML = head + (this.view === 'list' ? this.listHtml() : this.importHtml());
    if (this.view === 'import') this.afterImportRender();
  }

  /* ---------------- 列表视图 ---------------- */

  listHtml() {
    const g = this.group;
    const adder = `
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;">
        <input id="wlAddInput" placeholder="代码：600519 / sh000001 / rb2610 / 螺纹钢主连" style="${inp}flex:1;min-width:220px;" />
        <button class="btn btn-sm" style="${btnHi}" data-wl="addItem">＋ 加入自选</button>
        <button class="btn btn-sm" style="${btn}" data-wl="pullGroup">🔽 批量拉本组日线</button>
      </div>`;
    if (!g.items.length) {
      return adder + `<div style="color:var(--text-muted);padding:18px;text-align:center;border:1px dashed var(--border-color);border-radius:6px;">
        这个分组还没有品种。上面直接输代码，或点「🖼 识图 / 文本导入」从行情软件的截图/文本一次进一批。</div>`;
    }
    return adder + `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:8px;">
      ${g.items.map(it => this.cardHtml(it)).join('')}</div>`;
  }

  cardHtml(it) {
    const color = it.market === 'futures' ? 'var(--accent-gold)' : 'var(--accent-blue)';
    return `<div style="background:var(--bg-tertiary);border:1px solid var(--border-color);border-radius:6px;padding:9px 10px;">
      <div style="display:flex;align-items:baseline;gap:6px;">
        <b style="color:${color};font-size:14px;">${esc(it.openCode || it.symbol)}</b>
        <span style="font-size:11px;color:var(--text-muted);">${esc(MARKET_LABEL[it.market] || it.market)}</span>
      </div>
      <div style="font-size:12px;margin:3px 0 7px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
        ${esc(it.name || '—')}${it.ambiguous ? ' <span style="color:var(--accent-gold);">同码多义</span>' : ''}
      </div>
      <div style="display:flex;gap:6px;">
        <button class="btn btn-sm" style="${btnHi}flex:1;padding:4px;" data-wl="open" data-code="${esc(it.openCode || it.symbol)}">看盘</button>
        <button class="btn btn-sm" style="${btn}padding:4px 8px;" data-wl="del" data-secid="${esc(it.secid)}">移除</button>
      </div>
    </div>`;
  }

  async onNewGroup() {
    const name = window.prompt('新分组名称', '新分组');
    if (!name) return;
    const g = makeGroup(name);
    await this.save(g, `已新建分组「${g.name}」`);
    this.groupId = g.groupId;
    await this.reload();
  }

  async onRenameGroup() {
    const g = this.group;
    const name = window.prompt('分组名称', g.name);
    if (!name) return;
    g.name = String(name).slice(0, 24);
    await this.save(g, '分组名已更新');
    this.render();
  }

  async onDeleteGroup() {
    const g = this.group;
    if (g.groupId === 'default') { this.api.toast && this.api.toast('默认分组不可删除，可以清空它的品种'); return; }
    if (!window.confirm(`删除分组「${g.name}」？只删分组与它的自选列表，已缓存的K线不动。`)) return;
    await deleteGroup(g.groupId);
    await this.reload();
  }

  async onAddItem() {
    const el = this.root.querySelector('#wlAddInput');
    const raw = (el && el.value || '').trim();
    if (!raw) { this.api.toast && this.api.toast('请先输入代码，例如 600519 / sh000001 / rb2610'); return; }
    const r = addItem(this.group, raw, '');
    if (!r.ok) { this.api.toast && this.api.toast(`没能加入：${r.reason}`); return; }
    await this.save(this.group, `已加入 ${r.item.name || r.item.symbol}`);
    if (el) el.value = '';
    this.render();
    this.fillNames([r.item]);
  }

  /**
   * A股/ETF/指数 的名称不在规格表里（规格表只有期货乘数/tick），
   * 用代码表 JSONP 回填一次。失败就留着空 —— 卡片上名称是可选信息，代码才是主键。
   */
  async fillNames(items) {
    const need = (items || []).filter(i => !i.name);
    if (!need.length) return;
    let changed = false;
    for (const it of need) {
      const cands = await resolveSymbol(it.symbol).catch(() => []);
      const hit = cands.find(c => String(c.secid || c.QuoteID || '') === String(it.secid))
        || cands.find(c => String(c.code) === String(it.symbol));
      if (hit && hit.name) { it.name = hit.name; changed = true; }
    }
    if (changed) await saveGroup(this.group);
    this.render();
  }

  async onDeleteItem(secid) {
    if (removeItem(this.group, secid)) await saveGroup(this.group);
    this.render();
  }

  onOpen(code) {
    if (this.api.openSymbol) this.api.openSymbol(code);
  }

  /**
   * 批量拉本组日线：走的是取数层，落进 IndexedDB 缓存，
   * 不换图、不动当前复盘进度 —— 否则「批量」会把界面拖着一路闪。
   */
  async onBatchPull() {
    const items = this.group.items;
    if (!items.length) { this.api.toast && this.api.toast('本组没有品种'); return; }
    const periodEl = document.getElementById('periodSelect');
    const adjustEl = document.getElementById('adjustSelect');
    const period = periodEl ? periodEl.value : 'daily';
    this.busy = `拉取中 0/${items.length}`;
    this.render();
    let ok = 0, fail = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      this.busy = `拉取中 ${i + 1}/${items.length} · ${it.openCode || it.symbol}`;
      this.updateBusy();
      try {
        const out = await fetchBars({
          market: it.market, symbol: it.symbol, secid: it.secid, period,
          adjust: it.market === 'futures' ? 'none' : (adjustEl ? adjustEl.value : 'qfq')
        });
        if (out.ok && out.bars && out.bars.length) {
          await cacheBars(barKey(it.market, it.symbol, period, it.market === 'futures' ? 'none' : (adjustEl ? adjustEl.value : 'qfq')), out.bars, { name: out.name, source: out.source });
          ok++;
        } else fail.push(`${it.openCode || it.symbol}`);
      } catch (e) { fail.push(`${it.openCode || it.symbol}`); }
    }
    this.busy = '';
    this.api.toast && this.api.toast(`批量拉取完成：成功 ${ok}／${items.length}${fail.length ? `，失败 ${fail.join('、')}` : ''}`);
    this.render();
  }

  updateBusy() {
    const el = this.root.querySelector('[data-wl="busy"]');
    if (el) el.textContent = this.busy;
  }

  /* ---------------- 导入视图 ---------------- */

  importHtml() {
    const engineOpts = `
      <select data-wl="engine" style="${inp}">
        <option value="auto" ${this.engine === 'auto' ? 'selected' : ''}>通道：自动</option>
        <option value="server" ${this.engine === 'server' ? 'selected' : ''}>只用本地 rapidocr</option>
        <option value="browser" ${this.engine === 'browser' ? 'selected' : ''}>只用浏览器 tesseract</option>
      </select>
      <select data-wl="lang" style="${inp}">
        ${Object.entries(OCR_LANGS).map(([k, v]) => `<option value="${k}" ${this.lang === k ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}
      </select>`;
    const tabs = `
      <div style="display:flex;gap:6px;margin-bottom:8px;">
        <button class="btn btn-sm" style="${this.mode === 'image' ? btnHi : btn}" data-wl="modeImage">🖼 截图识别</button>
        <button class="btn btn-sm" style="${this.mode === 'text' ? btnHi : btn}" data-wl="modeText">📋 粘贴文本</button>
      </div>`;
    const stage = this.mode === 'image' ? `
      <div id="wlDrop" style="border:1px dashed var(--border-color);border-radius:6px;padding:16px;text-align:center;color:var(--text-muted);">
        拖入截图 / 点这里粘贴（Ctrl+V 或 ⌘V）／<button class="btn btn-sm" style="${btn}" data-wl="chooseFile">选文件</button>
        <div style="font-size:11px;margin-top:6px;">
          本地服务器在跑时优先用 rapidocr（中文最好，不下载模型）；纯静态托管会现取 tesseract 模型，
          英文约 10.9MB、中文约 20.2MB，只在此刻加载一次。图片不会上传到任何第三方。
        </div>
      </div>
      <input type="file" accept="image/*" id="wlFile" style="display:none;" />`
      : `<textarea id="wlText" rows="6" placeholder="从行情软件复制整列代码粘在这里，每行一条：&#10;600519 贵州茅台&#10;000001 平安银行&#10;rb2610 螺纹钢2610" style="${inp}width:100%;font-family:var(--font-mono);"></textarea>
        <button class="btn btn-sm" style="${btnHi}" data-wl="parseText">解析文本</button>`;

    return tabs + engineOpts + stage + this.previewHtml();
  }

  previewHtml() {
    if (!this.rows.length) return '';
    const nOk = this.rows.filter(r => r.ok && !r.needsReview && r.checked).length;
    const nRev = this.rows.filter(r => r.needsReview || !r.ok).length;
    return `
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:10px 0 6px;">
        <b style="color:var(--text-white);">预览确认</b>
        <span style="color:var(--text-muted);font-size:12px;">通道 ${esc(this.lastChannel || '—')} · 可入 ${nOk} 行 · 需人工确认 ${nRev} 行</span>
        ${this.busy ? `<span data-wl="busy" style="color:var(--accent-gold);font-size:12px;">${esc(this.busy)}</span>` : ''}
        <span style="flex:1"></span>
        <button class="btn btn-sm" style="${btn}" data-wl="clearRows">清空</button>
        <button class="btn btn-sm" style="${btnHi}" data-wl="commit">✔ 入池（勾上的）</button>
      </div>
      <div style="overflow:auto;max-height:300px;border:1px solid var(--border-color);border-radius:6px;">
      <table style="width:100%;border-collapse:collapse;font-size:12px;">
        <thead><tr style="background:var(--bg-tertiary);position:sticky;top:0;">
          <th style="padding:4px 6px;">选</th><th style="padding:4px 6px;text-align:left;">OCR 原文</th>
          <th style="padding:4px 6px;">代码</th><th style="padding:4px 6px;">名称</th>
          <th style="padding:4px 6px;">secid</th><th style="padding:4px 6px;">状态</th>
        </tr></thead>
        <tbody>${this.rows.map((r, i) => this.rowHtml(r, i)).join('')}</tbody>
      </table></div>
      <div style="color:var(--text-muted);font-size:11px;margin-top:6px;">
        「需确认」的行不会被静默入池：同码多义（如 000001 平安银行 / 上证指数）或未识别的，请改代码或取消勾选。
      </div>`;
  }

  rowHtml(r, i) {
    const st = !r.ok ? `<span style="color:var(--up-color);">未识别：${esc(r.reason || '')}</span>`
      : r.needsReview ? `<span style="color:var(--accent-gold);">需确认${esc(r.reason ? '：' + r.reason : '')}</span>`
        : `<span style="color:var(--down-color);">可入池</span>`;
    const checked = r.checked !== false && r.ok && !r.needsReview;
    return `<tr style="border-top:1px solid var(--border-color);${checked ? '' : 'opacity:.72;'}">
      <td style="text-align:center;"><input type="checkbox" data-wl="toggleRow" data-idx="${i}" ${checked ? 'checked' : ''} style="width:auto;" /></td>
      <td style="padding:4px 6px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(r.raw)}">${esc(r.raw)}</td>
      <td style="padding:4px 6px;"><input value="${esc(r.code || '')}" data-wl="codeEdit" data-idx="${i}" style="${inp}width:96px;font-family:var(--font-mono);" /></td>
      <td style="padding:4px 6px;">${esc(r.displayName || r.tableMatch?.name || '—')}${r.tableNames && r.needsReview ? `<div style="color:var(--text-muted);font-size:11px;">${esc(r.tableNames.join(' / '))}</div>` : ''}</td>
      <td style="padding:4px 6px;color:var(--text-muted);">${esc(r.secid || '—')}</td>
      <td style="padding:4px 6px;">${st}</td>
    </tr>`;
  }

  afterImportRender() {
    this.fileInput = this.root.querySelector('#wlFile');
    if (this.fileInput) {
      this.fileInput.onchange = () => {
        if (this.fileInput.files && this.fileInput.files[0]) { this.pendingFile = this.fileInput.files[0]; this.onRunOcr(); }
      };
    }
    const drop = this.root.querySelector('#wlDrop');
    if (drop) drop.addEventListener('click', (e) => { if (e.target.dataset.wl !== 'chooseFile') this.fileInput && this.fileInput.click(); });
  }

  onToggleRow(idx) {
    const r = this.rows[Number(idx)];
    if (!r) return;
    r.checked = !(r.checked !== false);
    this.renderImport();
  }

  async onEditCode(idx, value) {
    const r = await analyzeLine(String(value || '').trim(), { resolve: resolveSymbol });
    if (!r) return;
    this.rows[Number(idx)] = { ...r, checked: r.ok && !r.needsReview };
    this.renderImport();
  }

  renderImport() { this.render(); }

  async onParseText() {
    const el = this.root.querySelector('#wlText');
    const txt = (el && el.value || '').trim();
    if (!txt) { this.api.toast && this.api.toast('先粘贴文本，每行一条'); return; }
    this.lastChannel = 'text-paste';
    // parseTsv 是同步的纯解析；同码多义那些行（000001 平安银行 / 上证指数）再拿名称去代码表消歧一次，
    // 消得掉才自动勾上 —— 图片通道本来就走这一步，两条通道不能一个严一个松。
    const rows = parseTsv(txt);
    this.busy = '代码表交叉校验中…';
    this.render();
    const judged = [];
    for (const r of rows) {
      let row = r;
      if (r.ok && r.needsReview && r.nameHint) row = await crossCheck(r, resolveSymbol);
      judged.push({ ...row, checked: row.ok && !row.needsReview });
    }
    this.rows = judged;
    this.busy = '';
    this.render();
  }

  async onRunOcr() {
    const src = this.pendingFile;
    if (!src) { this.api.toast && this.api.toast('先选一张截图（或 Ctrl+V 粘贴）'); return; }
    this.busy = 'OCR 启动中…';
    this.render();
    try {
      const out = await runOcr(src, { engine: this.engine, lang: this.lang, onProgress: (p) => { this.busy = p; this.updateBusy(); } });
      if (!out.ok) { this.busy = ''; this.api.toast && this.api.toast(`识别失败：${out.error || '未知'}${out.install ? '（' + out.install + '）' : ''}`); this.render(); return; }
      this.lastChannel = out.channel + (out.lang ? `/${out.lang}` : '');
      const rowsSrc = out.rows && out.rows.length ? out.rows : [];
      this.busy = '代码表交叉校验中…';
      this.updateBusy();
      this.rows = await analyzeLines(rowsSrc, { resolve: resolveSymbol });
      this.busy = '';
      const note = out.note ? ` ${out.note}` : '';
      const okCount = this.rows.filter(j => j.ok).length;
      this.api.toast && this.api.toast(`识别完成：${this.rows.length} 行，其中 ${okCount} 行有可解析代码${note}`);
    } catch (e) {
      this.busy = '';
      this.api.toast && this.api.toast(`识别异常：${String(e && e.message || e)}`);
    }
    this.pendingFile = null;
    this.render();
  }

  /**
   * 入池：只写勾上的，且逐条再判一次。
   * 这里坚持「宁可漏进也不错进」—— 错代码入池后回测照样跑得出漂亮的曲线，
   * 但那是另一个品种的，而图上看不出来。
   */
  async onCommit() {
    const picked = this.rows.filter(r => r.checked !== false);
    if (!picked.length) { this.api.toast && this.api.toast('没有勾选任何行'); return; }
    const g = this.group;
    const done = [], skipped = [];
    for (const r of picked) {
      const res = addItem(g, r.code, r.displayName || r.nameHint || '');
      if (res.ok) done.push(res.item.symbol);
      else skipped.push(`${r.code}（${res.reason}）`);
    }
    let savedOk = true, savedWhere = 'indexeddb';
    if (done.length) { const sr = await saveGroup(g); savedOk = !!(sr && sr.ok); savedWhere = (sr && sr.where) || 'none'; }
    const tail = !done.length ? ''
      : savedOk ? (savedWhere === 'indexeddb' ? '' : '（已降级存进 localStorage）')
                : '；⚠️ 没存上：浏览器拒绝写入本地存储，刷新后会丢';
    this.api.toast && this.api.toast(`入池 ${done.length} 条${skipped.length ? `；跳过 ${skipped.length} 条：${skipped.slice(0, 3).join('、')}` : ''}${tail}`);
    this.rows = [];
    this.view = 'list';
    await this.reload();
  }
}
