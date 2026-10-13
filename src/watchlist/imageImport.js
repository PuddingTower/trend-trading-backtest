/**
 * 识图导入管线（M3）。
 *
 * 设计原则和演进计划里写的一致：**不赌 OCR 的裸准确率，靠规则解析兜底**。
 * OCR 错了要变成「未识别 → 人工修正那一行」，绝不能让一个错代码静默入池，
 * 因为回测跑在错品种上得到的所有结论都是废的，而看起来和真结果一模一样。
 *
 * 分成两半是有意的：
 *   - 本文件的解析部分（rows / extractCandidates / judge）是纯函数，喂文本块就能跑，
 *     不需要浏览器、不需要 OCR，所以能离线单测；
 *   - OCR 通道（runOcr）才碰浏览器与网络。
 *
 * OCR 双通道：
 *   1. 有本地后端 → POST /api/ocr（rapidocr_onnxruntime，中文最好，且不下载模型）
 *   2. 没有后端（GitHub Pages 之类静态托管）→ 浏览器端 tesseract.js，模型从 CDN 现取现用
 *      默认 eng（≈10.9MB）：我们要的是代码本身（6 位数字 / 字母+月份），中文品种名列
 *      识别不出来就落进「未识别」由人工补；要读文华那种「螺纹钢2610」可以选 chi_sim（≈20.2MB）。
 */

import { parseSymbol } from '../markets/symbolMeta.js';

/** 明显不是代码的噪声：日期、时间、百分比、带小数的价格、纯千分位数字。 */
const NOISE = /^\d{4}[-/]\d{1,2}[-/]\d{1,2}$|^\d{1,2}:\d{2}(:\d{2})?$|^-?\d+(\.\d+)?%$|^-?\d+\.\d+$/;

/** OCR 文本块 [{text,bbox:[x1,y1,x2,y2]}] → 按 y 聚成行（同一行的列会被切成散块，必须合回来）。 */
export function rowsFromBlocks(blocks, { rowToleranceRatio = 0.8 } = {}) {
  const items = (blocks || []).filter(b => b && String(b.text || '').trim() && Array.isArray(b.bbox));
  if (!items.length) return [];
  const heights = items.map(b => Math.max(1, b.bbox[3] - b.bbox[1]));
  const tol = (heights.reduce((s, h) => s + h, 0) / heights.length) * rowToleranceRatio;

  const rows = [];
  for (const it of items.slice().sort((a, b) => (a.bbox[1] - b.bbox[1]) || (a.bbox[0] - b.bbox[0]))) {
    const y = (it.bbox[1] + it.bbox[3]) / 2;
    const hit = rows.find(r => Math.abs(r.y - y) <= tol);
    if (hit) {
      hit.cells.push(it);
      hit.y = (hit.y + y) / 2;
    } else {
      rows.push({ y, cells: [it] });
    }
  }
  return rows
    .sort((a, b) => a.y - b.y)
    .map(r => ({
      text: r.cells.slice().sort((a, b) => a.bbox[0] - b.bbox[0]).map(c => String(c.text).trim()).join(' '),
      score: r.cells.reduce((m, c) => Math.max(m, Number(c.score) || 0), 0)
    }));
}

/** tesseract 这类只给整段文本的通道：按行切即可。 */
export function rowsFromText(text) {
  return String(text || '').split(/\r?\n/).map(t => ({ text: t.trim(), score: 0 }))
    .filter(r => r.text);
}

/**
 * 从一行文本里抠出候选代码。
 * 顺序有讲究：先中文品种名（带月份）→ 字母+月份 → 6 位数字，避免「螺纹钢2610」
 * 被后面的纯数字规则截走变成无意义的 2610。
 */
export function extractCandidates(line) {
  const text = String(line || '').trim();
  if (!text || NOISE.test(text)) return [];
  const found = [];
  const push = (code, nameHint) => {
    const codeTrim = String(code).trim();
    if (!codeTrim) return;
    if (found.some(f => f.code.toUpperCase() === codeTrim.toUpperCase())) return;
    found.push({ code: codeTrim, nameHint: nameHint || '' });
  };

  // 中文品种名 + 可选月份/主连：文华、博易写法（螺纹钢2610、原油主连、豆粕连续）
  const cn = text.match(/[一-龥]{2,6}(?:\d{3,4}|主连|连续)?/g);
  if (cn) for (const m of cn) {
    const withMonth = /^([一-龥]{2,6})(\d{3,4})$/.exec(m);
    if (withMonth) push(withMonth[1] + withMonth[2], m);
    else if (/(?:主连|连续)$/.test(m)) push(m, m);
  }

  // 字母+数字：期货合约（rb2610 / SR609 / M2601）与主力写法（RB0 / rbm / eg2612）
  const letters = text.match(/\b([A-Za-z]{1,2})(\d{1,4}|[A-Za-z])\b/g);
  if (letters) for (const m of letters) push(m, '');

  // 6 位数字：A股 / ETF / 指数 / 北交所。7 位以上的量额不会命中（\b 卡在数字中间不成立）
  const six = text.match(/\b\d{6}\b/g);
  if (six) for (const m of six) push(m, '');

  return found;
}

/**
 * 判一个候选到底是不是能用的代码。解析权在 symbolMeta，这里只记录结论与原因。
 * 同码多义（000001 = 平安银行 / 上证指数）标 ambiguous，交给上层用名称消歧，
 * 不自己猜一个 —— 猜错就是把 A股 回测跑在指数上。
 */
export function judge(candidate) {
  const parsed = parseSymbol(candidate.code, candidate.nameHint || '');
  if (!parsed.ok) {
    return { ...candidate, ok: false, reason: parsed.reason || '无法解析', needsReview: true };
  }
  return {
    ...candidate,
    ok: true,
    secid: parsed.secid,
    market: parsed.market,
    displayName: parsed.name || '',
    kind: parsed.kind || (parsed.market === 'futures' ? 'futures' : undefined),
    board: parsed.board,
    exchange: parsed.exchange,
    ambiguous: !!parsed.ambiguous,
    reason: parsed.ambiguous ? '同码多义，需按名称确认' : '',
    needsReview: !!parsed.ambiguous
  };
}

/**
 * 名称交叉校验：OCR 认出的中文名列能对上代码表给出的名字才敢直接勾上。
 * resolve 由调用方注入（浏览器里传 sources.js 的 resolveSymbol），
 * 这样本函数在 node 单测里可以塞一个假检索函数。
 */
export async function crossCheck(row, resolve) {
  if (typeof resolve !== 'function') return row;
  const cands = await resolve(row.code).catch(() => []);
  if (!cands || !cands.length) return { ...row, resolvedCount: 0 };
  const named = String(row.nameHint || '').trim();
  const match = named
    ? cands.find(c => String(c.name || '').includes(named) || named.includes(String(c.name || '')))
    : null;
  // 代码表唯一命中时直接采用它的名称 —— A股/ETF 的名称不在本地规格表里（规格表只有期货），
  // 不回填的话预览表「名称」列全是空的，用户没法靠名称确认这到底是哪个品种。
  const sole = !match && cands.length === 1 && String(cands[0].code) === String(row.code) ? cands[0] : null;
  const displayName = (match && match.name) || (sole && sole.name) || row.displayName || '';
  return {
    ...row,
    displayName,
    resolvedCount: cands.length,
    tableNames: cands.slice(0, 4).map(c => `${c.name}(${c.code})`),
    tableMatch: match ? { code: match.code, name: match.name, secid: match.QuoteID || match.secid } : (sole ? { code: sole.code, name: sole.name, secid: sole.QuoteID || sole.secid } : null),
    needsReview: row.ok ? (row.ambiguous && !match) : true
  };
}

/** 一行 OCR 文本 → 预览行数组（每行取第一个能解析成功的候选为主选，其余留作备选）。 */
export async function analyzeLine(line, { resolve = null } = {}) {
  const raw = String(line || '').trim();
  if (!raw) return null;
  const cands = extractCandidates(raw);
  if (!cands.length) return { raw, ok: false, reason: '本行未识别到代码', needsReview: true, options: [] };

  const judged = cands.map(judge);
  const first = judged.find(c => c.ok) || judged[0];
  const row = { raw, ...first, options: judged };
  return resolve ? await crossCheck(row, resolve) : row;
}

/**
 * 多行 → 预览行，**一行里的多个代码全部展开成各自的行**。
 *
 * 这里原本每行只取第一个能解析的候选：实测一张 6 码两行的合成截图，OCR 文本
 * 是完好的（600519 510300 rb2610 / 159915 688981 000700），extractCandidates 也
 * 全都抠出来了，但入池预览只剩 2 条 —— 剩下 4 个是被我们自己吞掉的，不是识别错。
 * 通达信/同花顺的板块宫格视图就是一行塞好几个代码，吞码比误码更难被发现。
 *
 * 名称归属只在「一行一码一名称」时才敢认定；一行多码时名称留给代码表回填。
 */
export async function analyzeLines(lines, { resolve = null } = {}) {
  const out = [];
  const seen = new Set();
  for (const rawLine of (lines || [])) {
    const raw = String(rawLine && rawLine.text !== undefined ? rawLine.text : rawLine || '').trim();
    if (!raw) continue;
    const cands = extractCandidates(raw);
    if (!cands.length) {
      out.push({ raw, ok: false, reason: '本行未识别到代码', needsReview: true, options: [], checked: false });
      continue;
    }
    const cnNames = raw.match(/[一-龥]{2,8}/g) || [];
    const soleName = cands.length === 1 && cnNames.length === 1 ? cnNames[0] : '';
    for (const cand of cands) {
      const dedup = cand.code.toUpperCase();
      if (seen.has(dedup)) continue;
      seen.add(dedup);
      let row = judge({ code: cand.code, nameHint: soleName || cand.nameHint });
      row.raw = raw;
      if (resolve) row = await crossCheck(row, resolve);
      out.push({ ...row, checked: row.ok && !row.needsReview });
    }
  }
  return out;
}

/**
 * 兜底通道 1：从行情软件复制的表格文本（TSV / 空格分隔 / 每行一个代码）。
 * 永远可用 —— 不依赖 OCR、不依赖后端、不依赖模型下载。
 */
export function parseTsv(text) {
  return String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean).map((line) => {
    const cells = line.split(/[\t,、]+|\s+/).map(c => c.trim()).filter(Boolean);
    const codeCell = cells.find(c => /^(?:[A-Za-z]{1,2}\.?)?\d{6}$|^[A-Za-z]{1,2}\d{1,4}$|^[A-Za-z]{1,2}(?:主连|连续)$/.test(c))
      || cells[0] || '';
    const nameCell = cells.find(c => c && c !== codeCell) || '';
    return { raw: line, code: codeCell, nameHint: nameCell };
  }).map(r => ({ ...r, ...judge({ code: r.code, nameHint: r.nameHint }) }));
}

/* ==================== 下面是浏览器侧：OCR 通道 ==================== */

const TESS_CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
export const OCR_LANGS = {
  eng: { label: '英文+数字（默认，约 10.9MB）', sizeMb: 10.9 },
  chi_sim: { label: '简体中文（约 20.2MB，文华那种「螺纹钢2610」要用它）', sizeMb: 20.2 }
};

let _tesseractLoading = null;
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (_tesseractLoading) return _tesseractLoading;
  _tesseractLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = TESS_CDN;
    s.onload = () => window.Tesseract ? resolve(window.Tesseract) : reject(new Error('tesseract.js 加载异常'));
    s.onerror = () => reject(new Error('tesseract.js 加载失败（CDN 不可达或被拦截）'));
    document.head.appendChild(s);
  });
  return _tesseractLoading;
}

/** 深色主题的行情软件截图在 OCR 前该反色：白底黑字对 tesseract 更友好。 */
function toLightCanvas(img, { invert = true, scale = 2 } = {}) {
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.round(img.width * scale));
  cv.height = Math.max(1, Math.round(img.height * scale));
  const c = cv.getContext('2d');
  c.fillStyle = '#fff';
  c.fillRect(0, 0, cv.width, cv.height);
  c.drawImage(img, 0, 0, cv.width, cv.height);
  if (!invert) return cv;
  const d = c.getImageData(0, 0, cv.width, cv.height);
  for (let i = 0; i < d.data.length; i += 4) {
    // 按亮度反色而不是无条件取反：彩色K线取反后会造出满屏假字符
    const y = 0.299 * d.data[i] + 0.587 * d.data[i + 1] + 0.114 * d.data[i + 2];
    if (y > 128) { d.data[i] = d.data[i + 1] = d.data[i + 2] = 0; }
    else { d.data[i] = d.data[i + 1] = d.data[i + 2] = 255; }
  }
  c.putImageData(d, 0, 0);
  return cv;
}

function loadImage(source) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片解码失败'));
    img.src = typeof source === 'string' ? source : URL.createObjectURL(source);
  });
}

/** 有本地后端吗 —— 只在同源的 localhost/局域网主机上问一次。 */
let _backendChecked = null;
async function backendHasOcr() {
  if (_backendChecked !== null) return _backendChecked;
  _backendChecked = await (async () => {
    try {
      const res = await fetch('/api/health');
      if (!res.ok) return false;
      const j = await res.json();
      return !!(j && j.ok && j.ocrReady);
    } catch (e) { return false; }
  })();
  return _backendChecked;
}

/**
 * 跑一次 OCR。返回 { channel, rows|text, lang, note }。
 * @param {File|Blob|string} source
 * @param {'auto'|'server'|'browser'} engine
 */
export async function runOcr(source, { engine = 'auto', lang = 'eng', onProgress = null } = {}) {
  const wantServer = engine === 'server' || (engine === 'auto' && await backendHasOcr());
  if (wantServer) {
    const blob = typeof source === 'string' ? await (await fetch(source)).blob() : source;
    const buf = new Uint8Array(await blob.arrayBuffer());
    const res = await fetch('/api/ocr', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: buf });
    const json = await res.json().catch(() => ({ ok: false }));
    if (res.status === 501 || !json.ok) {
      if (engine === 'server') return { ok: false, error: json.error || 'OCR 引擎不可用', install: json.install };
      // 服务器说它没有引擎，继续往下走浏览器通道
    } else {
      return { ok: true, channel: 'server', blocks: json.blocks || [], rows: rowsFromBlocks(json.blocks) };
    }
  }
  if (engine === 'server') return { ok: false, error: '本地 OCR 服务不可用' };

  const T = await loadTesseract();
  const img = await loadImage(source);
  const cv = toLightCanvas(img);
  if (onProgress) onProgress('loading model');
  const { data } = await T.recognize(cv, lang, { logger: (m) => { if (onProgress && m.status) onProgress(`${m.status} ${Math.round((m.progress || 0) * 100)}%`); } });
  return {
    ok: true,
    channel: 'browser-tesseract',
    lang,
    text: data.text || '',
    rows: rowsFromText(data.text),
    note: lang === 'eng' ? '英文模型只认得代码本身；中文名列会被忽略，未识别的行请手工补' : ''
  };
}
