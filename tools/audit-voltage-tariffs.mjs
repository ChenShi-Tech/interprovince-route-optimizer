#!/usr/bin/env node
// Audit voltage-level provincial T&D tariffs (受端分电压输配电价 / 送端电站专属送出价) against
// 发改价格〔2026〕1077号 附件1 PDF, re-read with pdftotext, and against existing repo data.
//
// Usage: node tools/audit-voltage-tariffs.mjs <repoRoot> [voltage-tariffs.json]
//   <repoRoot>            repository root (contains data/ and docs/原始文件/)
//   [json] defaults to <repoRoot>/data/fixed-prices.json（含 受端分电压输配电价 / 送端电站专属送出价）
// Env: PDFTOTEXT=/path/to/pdftotext (optional)
// Prints a JSON summary to stdout; exit code 1 on any mismatch.
//
// Checks
//  (0) coverage: every 省级参数 code present; every PDF table title maps to exactly one entity (page + name);
//      默认主体 valid; tier shape (两部制 / 需量 / 容量 null together).
//  (a) every non-null number appears on its page text (tariff cells in the table region as printed:
//      电量 4 decimals 元/千瓦时, 需量/容量 1 decimal; line-loss as「线损率为 X%」; 送出价 as a note number);
//      原文摘录 pieces occur verbatim (whitespace-insensitive).
//  (a2) row/column alignment: re-parses the 单一制 and 两部制 value lines, maps each two-part number to a
//      tier by nearest column of the single-part row, and compares full ordered sequences incl. 需量/容量.
//  (b) default entity 220千伏及以上 两部制 == 省级参数.受端省网输配电价
//  (c) default entity 省内上网环节线损率 == 省级参数.省内上网环节线损率
//  (d) 需量/容量 == 两部制容量需量电价 (CAP) for the same 档别 (CAP.NM applies to both 蒙东/蒙西)
//  (e) 110kV-ish tier 两部制 (plus 220kV 单一制/两部制) == docs/原始文件/省级电网输配电价_第四监管周期.json
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';

const root = path.resolve(process.argv[2] ?? '.');
const vtPath = process.argv[3] ? path.resolve(process.argv[3]) : path.join(root, 'data/fixed-prices.json');   // 数据已并入 fixed-prices.json（价格唯一来源）
const PDF_REL = 'docs/原始文件/S11-附件1-省级电网输配电价表.pdf';
const pdfPath = path.join(root, PDF_REL);
const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const vt = readJson(vtPath);
const fixed = readJson(path.join(root, 'data/fixed-prices.json'));
const archived = readJson(path.join(root, 'docs/原始文件/省级电网输配电价_第四监管周期.json'));

function pdftotext(args) {
  const candidates = [process.env.PDFTOTEXT, 'pdftotext', '/opt/homebrew/bin/pdftotext', '/usr/local/bin/pdftotext', '/usr/bin/pdftotext'].filter(Boolean);
  for (const bin of candidates) {
    try { return execFileSync(bin, args, {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024}); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  throw new Error('pdftotext not found (set PDFTOTEXT)');
}
const pages = pdftotext(['-layout', pdfPath, '-']).split('\f');
if (pages.at(-1).trim() === '') pages.pop();
const P = n => pages[n - 1] ?? '';
const strip = s => String(s).replace(/\s+/g, '');
const tableRegion = n => { const t = P(n); const i = t.indexOf('注：'); return i < 0 ? t : t.slice(0, i); };
const notesRegion = n => { const t = P(n); const i = t.indexOf('注：'); return i < 0 ? '' : t.slice(i); };
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasToken = (text, tok) => new RegExp(`(?<![\\d.])${esc(tok)}(?![\\d])`).test(text);
const kwh = v => (Math.round(v * 10) / 10000).toFixed(4); // 元/MWh -> printed 元/千瓦时
const eq = (a, b) => a != null && b != null && Math.abs(a - b) < 1e-9;
const isNum = v => typeof v === 'number' && Number.isFinite(v);

const failures = []; // {check, entity, field, expected, actual, detail}
const fail = (check, entity, field, expected, actual, detail) => failures.push({check, entity, field, expected, actual, ...(detail ? {detail} : {})});
const counters = {a: 0, a2: 0, b: 0, c: 0, d: 0, e: 0, excerpts: 0};
const info = [];

const R = vt.受端分电压输配电价 ?? {};
const S = vt.送端电站专属送出价 ?? {};
const params = fixed.省级参数;
const CAP = fixed.两部制容量需量电价;
const entities = [];
for (const [code, node] of Object.entries(R)) {
  if (code.startsWith('_')) continue;
  for (const e of node.主体 ?? []) entities.push({code, e, isDefault: node.默认主体 === e.id});
}

// ---------- (0) coverage & shape ----------
for (const code of Object.keys(params)) if (!R[code]) fail('0', code, '受端分电压输配电价', 'present', 'missing');
for (const [code, node] of Object.entries(R)) {
  if (code.startsWith('_')) continue;
  if (!params[code]) fail('0', code, 'code', 'in 省级参数', 'unknown code');
  const ids = (node.主体 ?? []).map(e => e.id);
  if (ids.length && !ids.includes(node.默认主体)) fail('0', code, '默认主体', ids, node.默认主体);
  if (!ids.length && node.默认主体 != null) fail('0', code, '默认主体', null, node.默认主体);
}
const idSeen = new Set();
for (const {e} of entities) { if (idSeen.has(e.id)) fail('0', e.id, 'id', 'unique', 'duplicate'); idSeen.add(e.id); }
const titles = [];
pages.forEach((t, i) => {
  const line = t.split('\n').find(l => l.includes('输配电价表'));
  if (line) titles.push({page: i + 1, title: strip(line)});
});
const skippedTables = [];
for (const {page, title} of titles) {
  const hits = entities.filter(({e}) => e.页码 === page);
  if (!hits.length) { skippedTables.push({page, title}); continue; }
  if (hits.length > 1) fail('0', hits.map(h => h.e.id).join(','), '页码', 'one entity per page', hits.length);
  for (const {e} of hits) if (strip(e.名称) + '输配电价表' !== title) fail('0', e.id, '名称', title, e.名称);
}
for (const {e} of entities) if (!titles.some(t => t.page === e.页码)) fail('0', e.id, '页码', 'page with a tariff table', e.页码);
for (const {e} of entities) {
  if (!Array.isArray(e.档位)) { fail('0', e.id, '档位', 'array', typeof e.档位); continue; }
  if (e.结构特殊 !== true && !e.档位.length) fail('0', e.id, '档位', 'non-empty for regular table', 0);
  for (const t of e.档位) {
    for (const f of ['单一制', '两部制', '需量电价', '容量电价']) if (!(t[f] === null || isNum(t[f]))) fail('0', e.id, `${t.档别}.${f}`, 'number|null', t[f]);
    if ((t.两部制 == null) !== (t.需量电价 == null) || (t.需量电价 == null) !== (t.容量电价 == null)) fail('0', e.id, t.档别, '两部制/需量/容量 null together', [t.两部制, t.需量电价, t.容量电价]);
  }
}

// ---------- (a) presence of every number + excerpts ----------
const nonNull = {电量电价: 0, 需量电价: 0, 容量电价: 0, 线损率: 0, 深圳分类电价: 0, 送出价: 0, 送端线损率: 0};
for (const {e} of entities) {
  const tab = tableRegion(e.页码), notes = strip(notesRegion(e.页码));
  for (const t of e.档位 ?? []) {
    for (const f of ['单一制', '两部制']) if (isNum(t[f])) {
      nonNull.电量电价++; counters.a++;
      if (!Number.isInteger(Math.round(t[f] * 10 * 1e6) / 1e6)) fail('a', e.id, `${t.档别}.${f}`, '≤4 decimals in 元/千瓦时', t[f]);
      if (!hasToken(tab, kwh(t[f]))) fail('a', e.id, `${t.档别}.${f}`, `token ${kwh(t[f])} on p${e.页码}`, 'not found');
    }
    for (const f of ['需量电价', '容量电价']) if (isNum(t[f])) {
      nonNull[f]++; counters.a++;
      if (!hasToken(tab, t[f].toFixed(1))) fail('a', e.id, `${t.档别}.${f}`, `token ${t[f].toFixed(1)} on p${e.页码}`, 'not found');
    }
  }
  if (e.省内上网环节线损率 != null) {
    nonNull.线损率++; counters.a++;
    if (!new RegExp(`线损率为${esc(e.省内上网环节线损率.toFixed(2))}%`).test(notes)) fail('a', e.id, '省内上网环节线损率', `线损率为${e.省内上网环节线损率.toFixed(2)}% on p${e.页码}`, 'not found');
  } else {
    fail('a', e.id, '省内上网环节线损率', 'number (every table has a line-loss note)', null);
  }
  const lossText = /省内上网环节线损率/.test(notes) ? '省内上网环节线损率' : '上网环节线损率';
  if (lossText !== '省内上网环节线损率') info.push({entity: e.id, note: `线损率注释原文为「${lossText}」（无「省内」）`});
  const includesLoss = /表中各电价含[^。]*上网环节线损费用/.test(notes);
  if (includesLoss !== (e.电价含线损 === true)) fail('a', e.id, '电价含线损', includesLoss, e.电价含线损);
  for (const rows of [e.深圳分类电价 ?? []]) for (const r of rows) {
    for (const [col, v] of Object.entries(r.电量电价 ?? {})) if (isNum(v)) {
      nonNull.深圳分类电价++; counters.a++;
      if (!hasToken(tab, kwh(v))) fail('a', e.id, `${r.用电分类}/${r.子类}/${col}`, `token ${kwh(v)}`, 'not found');
    }
    for (const f of ['需量电价', '容量电价']) if (isNum(r[f])) {
      nonNull.深圳分类电价++; counters.a++;
      if (!hasToken(tab, r[f].toFixed(1))) fail('a', e.id, `${r.用电分类}/${r.子类}/${f}`, `token ${r[f].toFixed(1)}`, 'not found');
    }
  }
  const page = strip(P(e.页码));
  for (const x of String(e.原文摘录 ?? '').split(' | ').filter(Boolean)) {
    counters.excerpts++;
    if (!page.includes(strip(x))) fail('a', e.id, '原文摘录', x, 'not verbatim on page');
  }
}
for (const [code, list] of Object.entries(S)) {
  if (code.startsWith('_')) continue;
  if (!R[code]) fail('0', code, '送端电站专属送出价', 'known province code', 'unknown');
  for (const x of list) {
    const notes = strip(notesRegion(x.页码));
    const ex = strip(x.原文摘录 ?? '');
    counters.excerpts++;
    if (!ex || !notes.includes(ex)) { fail('a', `${code}:${x.范围}`, '原文摘录', 'verbatim in notes', 'not found'); continue; }
    if (isNum(x.送出价)) {
      nonNull.送出价++; counters.a++;
      const toM = n => Math.round(Number(n) * 1e7) / 1e4;
      const cond = strip(x.适用条件 ?? '');
      if (ex.includes('分别为')) {
        // 「A、B、C年度 a亿、b亿、c亿千瓦时以内…分别为每千瓦时 p元、q元、r元」: check positional correspondence
        const names = ex.slice(0, ex.search(/年度/)).split('、');
        const quotas = [...ex.slice(ex.search(/年度/), ex.indexOf('千瓦时以内')).matchAll(/(\d+)亿/g)].map(m => m[1]);
        const prices = [...ex.slice(ex.indexOf('分别为')).matchAll(/(\d+\.\d+)元/g)].map(m => m[1]);
        const idx = names.indexOf(strip(x.范围));
        if (idx < 0 || names.length !== prices.length || names.length !== quotas.length) fail('a', `${code}:${x.范围}`, '分别为 list', {names, quotas, prices}, 'cannot align');
        else {
          if (!eq(toM(prices[idx]), x.送出价)) fail('a', `${code}:${x.范围}`, '送出价', toM(prices[idx]), x.送出价);
          if (!cond.includes(`${quotas[idx]}亿`)) fail('a', `${code}:${x.范围}`, '适用条件', `${quotas[idx]}亿`, x.适用条件);
        }
      } else {
        const m = ex.match(/每千瓦时(\d+\.\d+)元/);
        if (!m || !eq(toM(m[1]), x.送出价)) fail('a', `${code}:${x.范围}`, '送出价', m ? toM(m[1]) : 'price in excerpt', x.送出价);
        const q = ex.match(/(\d+)亿千瓦时以内/);
        if (q && !cond.includes(`${q[1]}亿`)) fail('a', `${code}:${x.范围}`, '适用条件', `${q[1]}亿`, x.适用条件);
      }
    }
    if (isNum(x.线损率)) {
      nonNull.送端线损率++; counters.a++;
      if (x.线损率 === 0 ? !ex.includes('不计线损') : !ex.includes(`线损率为${x.线损率.toFixed(2)}%`)) fail('a', `${code}:${x.范围}`, '线损率', x.线损率 === 0 ? '「不计线损」' : `线损率为${x.线损率.toFixed(2)}%`, 'not in excerpt');
    }
    if (!ex.includes(strip(x.范围).replace(/水电站$/, ''))) {
      // 范围 may be one item of a「分别为」list; require each 、-separated name to occur
      for (const name of strip(x.范围).split(/[、和]/)) if (!ex.includes(name)) fail('a', `${code}:${x.范围}`, '范围', 'names in excerpt', name);
    }
  }
}

// ---------- (a2) row / column alignment ----------
const numsWithPos = (line, re) => [...line.matchAll(re)].map(m => ({s: m[0], v: Number(m[0]), c: m.index + m[0].length / 2}));
const TOKEN_RE = /（\d+）|(?<!\d)\d+~\d+(?!\d)|及以下/g; // wording that distinguishes tier labels
const labelTokens = s => new Set((strip(s).match(TOKEN_RE) ?? []));
for (const {e} of entities) {
  const tab = tableRegion(e.页码);
  if (e.结构特殊) {
    const four = (tab.match(/\d\.\d{4}/g) ?? []).map(Number);
    const exp = (e.深圳分类电价 ?? []).flatMap(r => Object.values(r.电量电价).map(v => Number(kwh(v))));
    counters.a2++;
    if (JSON.stringify(four) !== JSON.stringify(exp)) fail('a2', e.id, '深圳分类电价.电量电价 sequence', four, exp);
    const one = (tab.replace(/\d\.\d{4}/g, '').match(/(?<![\d.])\d{2}\.\d(?![\d])/g) ?? []).map(Number);
    const seen = new Set(); const expC = [];
    for (const r of e.深圳分类电价 ?? []) if (isNum(r.需量电价) && !seen.has(r.用电分类)) { seen.add(r.用电分类); expC.push(r.需量电价, r.容量电价); }
    counters.a2++;
    if (JSON.stringify(one) !== JSON.stringify(expC)) fail('a2', e.id, '深圳分类电价.需量/容量 sequence', one, expC);
    continue;
  }
  const lines = tab.split('\n').filter(l => /\d\.\d{4}/.test(l));
  if (lines.length !== 2) { fail('a2', e.id, 'value lines', 2, lines.length); continue; }
  const single = numsWithPos(lines[0], /\d\.\d{4}/g);
  const two = numsWithPos(lines[1], /\d\.\d{4}/g);
  const capNums = numsWithPos(lines[1].replace(/\d\.\d{4}/g, m => ' '.repeat(m.length)), /(?<![\d.])\d+\.\d(?![\d])/g);
  const tiers = e.档位;
  counters.a2++;
  if (single.length !== tiers.length) { fail('a2', e.id, '单一制 count', single.length, tiers.length); continue; }
  single.forEach((n, i) => { counters.a2++; if (!eq(Number(kwh(tiers[i].单一制 ?? NaN)), n.v)) fail('a2', e.id, `${tiers[i].档别}.单一制`, n.s, tiers[i].单一制); });
  const assigned = new Map();
  for (const n of two) {
    const d = single.map(s => Math.abs(s.c - n.c));
    const best = d.indexOf(Math.min(...d));
    const second = Math.min(...d.filter((_, i) => i !== best));
    if (!(d[best] + 2 < second)) fail('a2', e.id, `两部制 ${n.s}`, 'unambiguous column', {distances: d});
    if (assigned.has(best)) fail('a2', e.id, `两部制 ${n.s}`, 'one value per column', tiers[best].档别);
    assigned.set(best, n);
  }
  tiers.forEach((t, i) => {
    counters.a2++;
    const n = assigned.get(i);
    if (n ? !eq(Number(kwh(t.两部制 ?? NaN)), n.v) : t.两部制 !== null) fail('a2', e.id, `${t.档别}.两部制`, n ? n.s : null, t.两部制);
  });
  const demTiers = []; const seenD = new Set();
  for (const t of tiers) if (isNum(t.需量电价)) { const k = t.容需量档别 ?? t.档别; if (!seenD.has(k)) { seenD.add(k); demTiers.push(t); } }
  const expCap = [...demTiers.map(t => t.需量电价), ...demTiers.map(t => t.容量电价)];
  counters.a2++;
  if (JSON.stringify(capNums.map(n => n.v)) !== JSON.stringify(expCap)) fail('a2', e.id, '需量/容量 sequence', capNums.map(n => n.s), expCap);
  // header wording consistency: parenthetical tokens, merged ranges and 及以下 must match the 档别 labels
  const headerRaw = tab.split('\n').filter(l => !/\d\.\d{4}/.test(l)).join('\n');
  const header = strip(headerRaw);
  const headerTokens = new Set(headerRaw.match(TOKEN_RE) ?? []);
  const labelSet = new Set(tiers.flatMap(t => [...labelTokens(t.档别), ...(t.容需量档别 ? labelTokens(t.容需量档别) : [])]));
  counters.a2++;
  if ([...headerTokens].sort().join() !== [...labelSet].sort().join()) fail('a2', e.id, '档别 wording tokens', [...headerTokens], [...labelSet]);
  for (const t of tiers) {
    counters.a2++;
    for (const k of (strip(t.档别).match(/\d+/g) ?? [])) if (!new RegExp(`(?<!\\d)${k}(?!\\d)`).test(headerRaw)) fail('a2', e.id, `${t.档别}`, `number ${k} in header`, 'missing');
  }
}

// ---------- (b) (c) defaults vs 省级参数 ----------
const is220 = s => strip(s).startsWith('220千伏');
for (const [code, p] of Object.entries(params)) {
  const node = R[code];
  const def = node?.主体?.find(x => x.id === node.默认主体);
  if (!def) { info.push({entity: code, note: '无默认主体（附件1无表），跳过 b/c', 省级参数受端省网输配电价: p.受端省网输配电价}); continue; }
  const t220 = def.档位.filter(t => is220(t.档别));
  counters.b++;
  if (t220.length !== 1) fail('b', def.id, '220千伏及以上 tier', 1, t220.length);
  else if (!eq(t220[0].两部制, p.受端省网输配电价)) fail('b', def.id, '220千伏及以上.两部制', p.受端省网输配电价, t220[0].两部制);
  counters.c++;
  if (!eq(def.省内上网环节线损率, p.省内上网环节线损率)) fail('c', def.id, '省内上网环节线损率', p.省内上网环节线损率, def.省内上网环节线损率);
}

// ---------- (d) CAP ----------
const noCapRef = [];
for (const {code, e, isDefault} of entities) {
  const cap = CAP[code];
  const applies = cap && !e.结构特殊 && (isDefault || code === 'NM');
  if (!applies) { if (e.档位?.some(t => isNum(t.需量电价)) || e.结构特殊) noCapRef.push(e.id); continue; }
  // CAP rows were transcribed from CAP.页码; for another table (蒙西 vs 蒙东) allow wording-only label differences
  // such as 「110千伏」 vs 「110（66）千伏」 and report them as info.
  const samePage = cap.页码 === e.页码;
  const norm = s => samePage ? strip(s) : strip(s).replace(/（66）/g, '');
  const labelsDiffer = new Set();
  for (const f of ['需量电价', '容量电价']) {
    const capRows = cap[f] ?? [];
    for (const row of capRows) {
      counters.d++;
      const hits = e.档位.filter(t => norm(t.容需量档别 ?? t.档别) === norm(row.档别));
      for (const h of hits) if (strip(h.容需量档别 ?? h.档别) !== strip(row.档别)) labelsDiffer.add(`${h.容需量档别 ?? h.档别} ≈ CAP「${row.档别}」`);
      if (!hits.length) fail('d', e.id, `${row.档别}.${f}`, row.价, 'tier not found');
      for (const h of hits) if (!eq(h[f], row.价)) fail('d', e.id, `${h.档别}.${f}`, row.价, h[f]);
    }
    for (const t of e.档位) if (isNum(t[f]) && !capRows.some(r => norm(r.档别) === norm(t.容需量档别 ?? t.档别))) {
      counters.d++; fail('d', e.id, `${t.档别}.${f}`, 'CAP row', 'missing in CAP');
    }
  }
  if (labelsDiffer.size) info.push({entity: e.id, note: `CAP.${code} 档别取自第${cap.页码}页，与本表(第${e.页码}页)措辞不同但数值已比对：${[...labelsDiffer].join('；')}`});
}

// ---------- (e) archived 第四监管周期 json ----------
const usedArchived = new Set();
for (const {e} of entities) {
  const rec = archived.find(r => r.province === e.名称) ?? archived.find(r => r.province.startsWith(`${e.名称}（`));
  if (!rec) { fail('e', e.id, 'archived record', e.名称, 'not found'); continue; }
  usedArchived.add(rec.province);
  const toM = k => (k == null ? null : Math.round(k * 1e7) / 1e4);
  if (e.结构特殊) {
    const v110 = (e.深圳分类电价 ?? []).map(r => r.电量电价?.['110千伏']);
    counters.e++;
    const ok = rec.voltage_110kv_twopart_kwh == null || v110.some(v => eq(v, toM(rec.voltage_110kv_twopart_kwh)));
    info.push({entity: e.id, note: `结构特殊，跳过档位比对；归档 110kV 值 ${rec.voltage_110kv_twopart_kwh} ${ok ? '见于' : '不见于'} 深圳分类电价.110千伏`});
    if (!ok) fail('e', e.id, '110千伏 (深圳分类电价)', toM(rec.voltage_110kv_twopart_kwh), v110);
    continue;
  }
  const t110 = e.档位.filter(t => /110/.test(t.档别));
  counters.e++;
  if (t110.length !== 1) fail('e', e.id, '110kV-ish tier', 1, t110.map(t => t.档别));
  else if (!eq(t110[0].两部制, toM(rec.voltage_110kv_twopart_kwh))) fail('e', e.id, `${t110[0].档别}.两部制`, toM(rec.voltage_110kv_twopart_kwh), t110[0].两部制);
  const t220 = e.档位.find(t => is220(t.档别));
  counters.e += 2;
  if (!eq(t220?.两部制, toM(rec.voltage_220kv_above?.twopart_kwh))) fail('e', e.id, '220千伏及以上.两部制', toM(rec.voltage_220kv_above?.twopart_kwh), t220?.两部制);
  if (!eq(t220?.单一制, toM(rec.voltage_220kv_above?.single_kwh))) fail('e', e.id, '220千伏及以上.单一制', toM(rec.voltage_220kv_above?.single_kwh), t220?.单一制);
}
const archivedUnused = archived.map(r => r.province).filter(p => !usedArchived.has(p));

// ---------- summary ----------
const tiers = entities.reduce((s, {e}) => s + (e.档位?.length ?? 0), 0);
const byCheck = Object.fromEntries(['0', 'a', 'a2', 'b', 'c', 'd', 'e'].map(k => [k, failures.filter(f => f.check === k).length]));
const summary = {
  ok: failures.length === 0,
  source: PDF_REL,
  sha256: crypto.createHash('sha256').update(fs.readFileSync(pdfPath)).digest('hex'),
  audited: path.relative(root, vtPath).startsWith('..') ? path.basename(vtPath) : path.relative(root, vtPath),
  counts: {
    pdfPages: pages.length, pdfTables: titles.length, tablesMapped: titles.length - skippedTables.length,
    skippedTables, provinces: Object.keys(R).filter(k => !k.startsWith('_')).length,
    provincesWithoutTable: Object.entries(R).filter(([k, v]) => !k.startsWith('_') && !(v.主体 ?? []).length).map(([k]) => k),
    entities: entities.length, specialStructureEntities: entities.filter(({e}) => e.结构特殊).map(({e}) => e.id),
    tiers, nonNullValues: {...nonNull, total: Object.values(nonNull).reduce((a, b) => a + b, 0)},
    sendSideEntries: Object.entries(S).filter(([k]) => !k.startsWith('_')).reduce((s, [, v]) => s + v.length, 0),
  },
  checks: {
    '0_coverage_shape': {failures: byCheck['0']},
    a_presence: {checked: counters.a, excerpts: counters.excerpts, failures: byCheck.a},
    a2_row_alignment: {checked: counters.a2, failures: byCheck.a2},
    b_default_220kV_twopart_vs_省级参数: {checked: counters.b, failures: byCheck.b},
    c_default_lineloss_vs_省级参数: {checked: counters.c, failures: byCheck.c},
    d_demand_capacity_vs_CAP: {checked: counters.d, failures: byCheck.d, noCapReference: noCapRef},
    e_vs_archived_第四监管周期json: {checked: counters.e, failures: byCheck.e, archivedRecordsNotAudited: archivedUnused},
  },
  info,
  failures,
};
console.log(JSON.stringify(summary, null, 2));
if (failures.length) process.exitCode = 1;
