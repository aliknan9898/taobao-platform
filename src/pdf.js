// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * A small PDF writer (no dependencies) for invoices.
 * - Embeds DejaVu Sans (regular + bold, subset in assets/fonts) as Unicode fonts, so Latin, €, £ and Arabic all print.
 * - Arabic is shaped (letters joined) and laid out right-to-left; Latin words and numbers inside it stay left-to-right.
 * - Drawing: text, filled / stroked rectangles (optionally rounded), lines and SVG-like paths (M L H V Z).
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------------- TrueType font: cmap + widths ----------------
function loadFont(file) {
  const buf = fs.readFileSync(file);
  const tables = {};
  const n = buf.readUInt16BE(4);
  for (let i = 0; i < n; i++) { const o = 12 + i * 16; tables[buf.toString('ascii', o, o + 4)] = { off: buf.readUInt32BE(o + 8), len: buf.readUInt32BE(o + 12) }; }
  const head = tables.head.off; const upm = buf.readUInt16BE(head + 18);
  const hhea = tables.hhea.off; const ascent = buf.readInt16BE(hhea + 4); const descent = buf.readInt16BE(hhea + 6); const nHM = buf.readUInt16BE(hhea + 34);
  const numGlyphs = buf.readUInt16BE(tables.maxp.off + 4);
  const widths = new Array(numGlyphs);
  for (let g = 0; g < numGlyphs; g++) widths[g] = buf.readUInt16BE(tables.hmtx.off + 4 * Math.min(g, nHM - 1));
  // cmap: pick the Windows Unicode BMP table (format 4)
  const cm = tables.cmap.off; const nt = buf.readUInt16BE(cm + 2); const map = new Map();
  for (let i = 0; i < nt; i++) {
    const pid = buf.readUInt16BE(cm + 4 + i * 8); const eid = buf.readUInt16BE(cm + 6 + i * 8); const so = cm + buf.readUInt32BE(cm + 8 + i * 8);
    if (buf.readUInt16BE(so) !== 4 || !((pid === 3 && eid === 1) || pid === 0)) continue;
    const segX2 = buf.readUInt16BE(so + 6); const ends = so + 14; const starts = ends + segX2 + 2; const deltas = starts + segX2; const ranges = deltas + segX2;
    for (let s = 0; s < segX2 / 2; s++) {
      const end = buf.readUInt16BE(ends + s * 2); const start = buf.readUInt16BE(starts + s * 2); const delta = buf.readInt16BE(deltas + s * 2); const ro = buf.readUInt16BE(ranges + s * 2);
      for (let c = start; c <= end && c !== 0xffff; c++) {
        let g;
        if (!ro) g = (c + delta) & 0xffff;
        else { const gi = ranges + s * 2 + ro + (c - start) * 2; g = buf.readUInt16BE(gi); if (g) g = (g + delta) & 0xffff; }
        if (g) map.set(c, g);
      }
    }
    break;
  }
  return { buf, upm, ascent, descent, widths, map, used: new Map() };
}

const FONT_DIR = path.join(__dirname, '..', 'assets', 'fonts');
let FONTS = null;
const fonts = () => FONTS || (FONTS = { regular: loadFont(path.join(FONT_DIR, 'DejaVuSans.ttf')), bold: loadFont(path.join(FONT_DIR, 'DejaVuSans-Bold.ttf')) });

// ---------------- Arabic shaping + right-to-left order ----------------
// [isolated, final, initial, medial]; two forms = joins only to the letter before it
const FORMS = {
  0x621: [0xFE80], 0x622: [0xFE81, 0xFE82], 0x623: [0xFE83, 0xFE84], 0x624: [0xFE85, 0xFE86], 0x625: [0xFE87, 0xFE88], 0x626: [0xFE89, 0xFE8A, 0xFE8B, 0xFE8C],
  0x627: [0xFE8D, 0xFE8E], 0x628: [0xFE8F, 0xFE90, 0xFE91, 0xFE92], 0x629: [0xFE93, 0xFE94], 0x62A: [0xFE95, 0xFE96, 0xFE97, 0xFE98], 0x62B: [0xFE99, 0xFE9A, 0xFE9B, 0xFE9C],
  0x62C: [0xFE9D, 0xFE9E, 0xFE9F, 0xFEA0], 0x62D: [0xFEA1, 0xFEA2, 0xFEA3, 0xFEA4], 0x62E: [0xFEA5, 0xFEA6, 0xFEA7, 0xFEA8], 0x62F: [0xFEA9, 0xFEAA], 0x630: [0xFEAB, 0xFEAC],
  0x631: [0xFEAD, 0xFEAE], 0x632: [0xFEAF, 0xFEB0], 0x633: [0xFEB1, 0xFEB2, 0xFEB3, 0xFEB4], 0x634: [0xFEB5, 0xFEB6, 0xFEB7, 0xFEB8], 0x635: [0xFEB9, 0xFEBA, 0xFEBB, 0xFEBC],
  0x636: [0xFEBD, 0xFEBE, 0xFEBF, 0xFEC0], 0x637: [0xFEC1, 0xFEC2, 0xFEC3, 0xFEC4], 0x638: [0xFEC5, 0xFEC6, 0xFEC7, 0xFEC8], 0x639: [0xFEC9, 0xFECA, 0xFECB, 0xFECC],
  0x63A: [0xFECD, 0xFECE, 0xFECF, 0xFED0], 0x640: [0x640, 0x640, 0x640, 0x640], 0x641: [0xFED1, 0xFED2, 0xFED3, 0xFED4], 0x642: [0xFED5, 0xFED6, 0xFED7, 0xFED8],
  0x643: [0xFED9, 0xFEDA, 0xFEDB, 0xFEDC], 0x644: [0xFEDD, 0xFEDE, 0xFEDF, 0xFEE0], 0x645: [0xFEE1, 0xFEE2, 0xFEE3, 0xFEE4], 0x646: [0xFEE5, 0xFEE6, 0xFEE7, 0xFEE8],
  0x647: [0xFEE9, 0xFEEA, 0xFEEB, 0xFEEC], 0x648: [0xFEED, 0xFEEE], 0x649: [0xFEEF, 0xFEF0], 0x64A: [0xFEF1, 0xFEF2, 0xFEF3, 0xFEF4],
  0x67E: [0xFB56, 0xFB57, 0xFB58, 0xFB59], 0x686: [0xFB7A, 0xFB7B, 0xFB7C, 0xFB7D], 0x698: [0xFB8A, 0xFB8B], 0x6A9: [0xFB8E, 0xFB8F, 0xFB90, 0xFB91],
  0x6AF: [0xFB92, 0xFB93, 0xFB94, 0xFB95], 0x6CC: [0xFBFC, 0xFBFD, 0xFBFE, 0xFBFF]
};
const LAM_ALEF = { 0x622: [0xFEF5, 0xFEF6], 0x623: [0xFEF7, 0xFEF8], 0x625: [0xFEF9, 0xFEFA], 0x627: [0xFEFB, 0xFEFC] };
const isMark = (c) => (c >= 0x64B && c <= 0x65F) || c === 0x670;
const dual = (c) => FORMS[c] && FORMS[c].length === 4;
const joins = (c) => Boolean(FORMS[c]) && c !== 0x621;
const isRTL = (c) => (c >= 0x590 && c <= 0x8FF) || (c >= 0xFB1D && c <= 0xFDFF) || (c >= 0xFE70 && c <= 0xFEFF);

function shape(cps) {
  const s = cps.filter((c) => !isMark(c));
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (!FORMS[c]) { out.push(c); continue; }
    const prev = s[i - 1]; const joinPrev = prev !== undefined && dual(prev) && joins(c);
    if (c === 0x644 && LAM_ALEF[s[i + 1]]) { out.push(LAM_ALEF[s[i + 1]][joinPrev ? 1 : 0]); i++; continue; }
    const next = s[i + 1]; const joinNext = next !== undefined && dual(c) && joins(next);
    const f = FORMS[c];
    out.push(joinPrev && joinNext ? f[3] : joinPrev ? f[1] : joinNext ? f[2] : f[0]);
  }
  return out;
}

const MIRROR = { 0x28: 0x29, 0x29: 0x28, 0x5B: 0x5D, 0x5D: 0x5B, 0x7B: 0x7D, 0x7D: 0x7B, 0x3C: 0x3E, 0x3E: 0x3C, 0xAB: 0xBB, 0xBB: 0xAB };
/** Code points in the order they are drawn left to right. */
function visual(str) {
  const cps = [...String(str)].map((ch) => ch.codePointAt(0));
  if (!cps.some(isRTL)) return cps;
  // A paragraph with Arabic reads right to left; Latin words and numbers keep their own order
  // Simplified Unicode bidi: R (Arabic), L (Latin), E (digits: Latin after Latin, otherwise a run of their own), N (spaces, punctuation)
  const type = (c) => { const ch = String.fromCodePoint(c); return isRTL(c) && !/\p{Nd}/u.test(ch) ? 'R' : /\p{N}/u.test(ch) ? 'E' : /\p{L}/u.test(ch) ? 'L' : 'N'; };
  const t = cps.map(type);
  let strong = 'R';
  // Numbers stay whole: "12.50", "1,200", "€12", "15%"
  for (let i = 1; i < t.length - 1; i++) if (t[i] === 'N' && t[i - 1] === 'E' && t[i + 1] === 'E' && /[.,:/]/.test(String.fromCodePoint(cps[i]))) t[i] = 'E';
  for (let i = 0; i < t.length; i++) if (t[i] === 'N' && /[\p{Sc}%+\-−]/u.test(String.fromCodePoint(cps[i])) && (t[i - 1] === 'E' || t[i + 1] === 'E')) t[i] = 'E';
  for (let i = 0; i < t.length; i++) { if (t[i] === 'R' || t[i] === 'L') strong = t[i]; else if (t[i] === 'E' && strong === 'L') t[i] = 'L'; }
  for (let i = 0; i < t.length; i++) {
    if (t[i] !== 'N') continue;
    let j = i; while (j < t.length && t[j] === 'N') j++;
    const before = t[i - 1]; const after = t[j];
    const fill = before === 'L' && after === 'L' ? 'L' : 'R';
    for (let k = i; k < j; k++) t[k] = fill;
    i = j - 1;
  }
  const runs = [];
  for (let i = 0; i < cps.length; i++) { const last = runs[runs.length - 1]; if (last && last.t === t[i]) last.c.push(cps[i]); else runs.push({ t: t[i], c: [cps[i]] }); }
  return runs.reverse().flatMap((r) => (r.t === 'R' ? shape(r.c).reverse().map((c) => MIRROR[c] || c) : r.c));
}

// ---------------- Document ----------------
const hexColor = (h) => { const m = String(h).replace('#', ''); return [0, 2, 4].map((i) => (parseInt(m.slice(i, i + 2), 16) / 255).toFixed(3)).join(' '); };
const num = (n) => (Math.round(n * 100) / 100).toString();

class PDF {
  constructor({ width = 595.28, height = 841.89, title = 'Document', author = '' } = {}) {
    this.w = width; this.h = height; this.title = title; this.author = author;
    this.pages = []; this.f = fonts(); this.f.regular.used = new Map(); this.f.bold.used = new Map();
    this.addPage();
  }
  addPage() { this.ops = []; this.pages.push(this.ops); return this; }
  /** Width of a string in points. */
  width(text, size = 10, bold = false) {
    const f = bold ? this.f.bold : this.f.regular;
    return visual(text).reduce((a, c) => a + (f.widths[f.map.get(c) || 0] || 0), 0) * size / f.upm;
  }
  /** Draw text; x,y = baseline from the TOP-left corner. align: left | right | center (x is that edge). */
  text(str, x, y, { size = 10, bold = false, color = '#141b3a', align = 'left' } = {}) {
    if (str === undefined || str === null || str === '') return this;
    const f = bold ? this.f.bold : this.f.regular;
    const gids = visual(str).map((c) => { const g = f.map.get(c) || f.map.get(0x3F) || 0; f.used.set(g, c); return g; });
    const w = gids.reduce((a, g) => a + (f.widths[g] || 0), 0) * size / f.upm;
    const left = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
    const hex = gids.map((g) => g.toString(16).padStart(4, '0')).join('');
    this.ops.push(`BT /${bold ? 'F2' : 'F1'} ${num(size)} Tf ${hexColor(color)} rg ${num(left)} ${num(this.h - y)} Td <${hex}> Tj ET`);
    return this;
  }
  /** Split text into lines no wider than maxWidth. */
  wrap(str, maxWidth, size = 10, bold = false) {
    const words = String(str || '').split(/\s+/).filter(Boolean); const lines = []; let cur = '';
    for (const wd of words) {
      const t = cur ? `${cur} ${wd}` : wd;
      if (this.width(t, size, bold) <= maxWidth || !cur) cur = t; else { lines.push(cur); cur = wd; }
      while (this.width(cur, size, bold) > maxWidth && cur.length > 1) { // one very long word
        let k = cur.length; while (k > 1 && this.width(cur.slice(0, k), size, bold) > maxWidth) k--;
        lines.push(cur.slice(0, k)); cur = cur.slice(k);
      }
    }
    if (cur) lines.push(cur);
    return lines;
  }
  rect(x, y, w, h, { fill = null, stroke = null, lineWidth = 1, radius = 0 } = {}) {
    const Y = this.h - y - h; const r = Math.min(radius, w / 2, h / 2); const k = 0.5523 * r;
    let p;
    if (!r) p = `${num(x)} ${num(Y)} ${num(w)} ${num(h)} re`;
    else {
      const x2 = x + w; const y2 = Y + h;
      p = [`${num(x + r)} ${num(Y)} m`, `${num(x2 - r)} ${num(Y)} l`, `${num(x2 - r + k)} ${num(Y)} ${num(x2)} ${num(Y + r - k)} ${num(x2)} ${num(Y + r)} c`, `${num(x2)} ${num(y2 - r)} l`,
        `${num(x2)} ${num(y2 - r + k)} ${num(x2 - r + k)} ${num(y2)} ${num(x2 - r)} ${num(y2)} c`, `${num(x + r)} ${num(y2)} l`, `${num(x + r - k)} ${num(y2)} ${num(x)} ${num(y2 - r + k)} ${num(x)} ${num(y2 - r)} c`,
        `${num(x)} ${num(Y + r)} l`, `${num(x)} ${num(Y + r - k)} ${num(x + r - k)} ${num(Y)} ${num(x + r)} ${num(Y)} c`, 'h'].join(' ');
    }
    this.ops.push(`${fill ? `${hexColor(fill)} rg ` : ''}${stroke ? `${hexColor(stroke)} RG ${num(lineWidth)} w ` : ''}${p} ${fill && stroke ? 'B' : fill ? 'f' : 'S'}`);
    return this;
  }
  line(x1, y1, x2, y2, { color = '#e1e5ee', width = 1 } = {}) { this.ops.push(`${hexColor(color)} RG ${num(width)} w ${num(x1)} ${num(this.h - y1)} m ${num(x2)} ${num(this.h - y2)} l S`); return this; }
  circle(cx, cy, r, { fill = '#000' } = {}) { return this.rect(cx - r, cy - r, 2 * r, 2 * r, { fill, radius: r }); }
  /** Fill an SVG path made of M/L/H/V/Z commands (absolute or relative), drawn in a box scaled from viewBox units. */
  path(d, x, y, scale, { fill = '#000' } = {}) {
    const tok = String(d).match(/[MLHVZmlhvz]|-?\d*\.?\d+/g) || []; const out = []; let cx = 0; let cy = 0; let sx = 0; let sy = 0; let cmd = 'M'; let i = 0;
    const P = (px, py) => `${num(x + px * scale)} ${num(this.h - (y + py * scale))}`;
    while (i < tok.length) {
      if (/[A-Za-z]/.test(tok[i])) cmd = tok[i++];
      const rel = cmd === cmd.toLowerCase(); const C = cmd.toUpperCase();
      if (C === 'Z') { out.push('h'); cx = sx; cy = sy; continue; }
      if (C === 'H') { const v = +tok[i++]; cx = rel ? cx + v : v; out.push(`${P(cx, cy)} l`); continue; }
      if (C === 'V') { const v = +tok[i++]; cy = rel ? cy + v : v; out.push(`${P(cx, cy)} l`); continue; }
      const a = +tok[i++]; const b = +tok[i++]; cx = rel ? cx + a : a; cy = rel ? cy + b : b;
      if (C === 'M') { sx = cx; sy = cy; out.push(`${P(cx, cy)} m`); cmd = rel ? 'l' : 'L'; } else out.push(`${P(cx, cy)} l`);
    }
    this.ops.push(`${hexColor(fill)} rg ${out.join(' ')} f`);
    return this;
  }

  /** The finished PDF file. */
  toBuffer() {
    const objs = []; const add = (body) => { objs.push(body); return objs.length; };
    const stream = (dict, data, compress = true) => { const d = compress ? zlib.deflateSync(data) : data; return Buffer.concat([Buffer.from(`<< ${dict}${compress ? ' /Filter /FlateDecode' : ''} /Length ${d.length} >>\nstream\n`), d, Buffer.from('\nendstream')]); };
    const fontObj = (f, name) => {
      const file = add(stream(`/Length1 ${f.buf.length}`, f.buf));
      const sc = 1000 / f.upm;
      const desc = add(`<< /Type /FontDescriptor /FontName /${name} /Flags 32 /FontBBox [-1021 -463 1793 1232] /ItalicAngle 0 /Ascent ${Math.round(f.ascent * sc)} /Descent ${Math.round(f.descent * sc)} /CapHeight 729 /StemV 80 /FontFile2 ${file} 0 R >>`);
      const used = [...f.used.keys()].sort((a, b) => a - b);
      const W = used.map((g) => `${g} [${Math.round((f.widths[g] || 0) * sc)}]`).join(' ');
      const cid = add(`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${name} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${desc} 0 R /DW 600 /W [${W}] /CIDToGIDMap /Identity >>`);
      const bf = used.map((g) => { const u = f.used.get(g); const hex = u > 0xffff ? Buffer.from(String.fromCodePoint(u), 'utf16le').swap16().toString('hex') : u.toString(16).padStart(4, '0'); return `<${g.toString(16).padStart(4, '0')}> <${hex}>`; });
      const cmap = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /Adobe-Identity-UCS def /CMapType 2 def 1 begincodespacerange <0000> <FFFF> endcodespacerange\n${bf.length ? `${bf.length} beginbfchar\n${bf.join('\n')}\nendbfchar\n` : ''}endcmap CMapName currentdict /CMap defineresource pop end end`;
      const tu = add(stream('', Buffer.from(cmap)));
      return add(`<< /Type /Font /Subtype /Type0 /BaseFont /${name} /Encoding /Identity-H /DescendantFonts [${cid} 0 R] /ToUnicode ${tu} 0 R >>`);
    };
    const f1 = fontObj(this.f.regular, 'AAAAAA+DejaVuSans'); const f2 = fontObj(this.f.bold, 'AAAAAB+DejaVuSans-Bold');
    const pagesId = objs.length + 1 + this.pages.length * 2; // reserved below
    const pageIds = [];
    for (const ops of this.pages) {
      const c = add(stream('', Buffer.from(ops.join('\n'))));
      pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${num(this.w)} ${num(this.h)}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${c} 0 R >>`));
    }
    const pages = add(`<< /Type /Pages /Kids [${pageIds.map((p) => `${p} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);
    if (pages !== pagesId) throw new Error('pdf: object numbering');
    const str = (s) => `(${String(s).replace(/[\\()]/g, '\\$&').replace(/[^\x20-\x7e]/g, '')})`;
    const info = add(`<< /Title ${str(this.title)} /Author ${str(this.author)} /Producer (Kinan) /CreationDate (D:${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z) >>`);
    const catalog = add(`<< /Type /Catalog /Pages ${pages} 0 R >>`);
    const parts = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')]; const offsets = []; let len = parts[0].length;
    objs.forEach((o, i) => { const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), Buffer.isBuffer(o) ? o : Buffer.from(o), Buffer.from('\nendobj\n')]); offsets.push(len); parts.push(b); len += b.length; });
    const xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${len}\n%%EOF\n`;
    parts.push(Buffer.from(xref));
    return Buffer.concat(parts);
  }
}

module.exports = { PDF, visual, shape };
