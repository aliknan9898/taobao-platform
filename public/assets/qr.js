// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
/* Small QR Code encoder (byte mode, ISO/IEC 18004) for printed links such as the catalogue.
   KinanQR.matrix(text, ecl) → boolean rows; KinanQR.svg(text, opts) → an SVG string. */
'use strict';
(function (root) {
  var ECC = {
    L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    Q: [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    H: [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30]
  };
  var BLOCKS = {
    L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    Q: [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    H: [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81]
  };
  var FMT = { L: 1, M: 0, Q: 3, H: 2 };

  function rawModules(v) { var r = (16 * v + 128) * v + 64; if (v >= 2) { var n = Math.floor(v / 7) + 2; r -= (25 * n - 10) * n - 55; if (v >= 7) r -= 36; } return r; }
  function dataCodewords(v, e) { return Math.floor(rawModules(v) / 8) - ECC[e][v] * BLOCKS[e][v]; }
  function mul(x, y) { var z = 0; for (var i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11D); z ^= ((y >>> i) & 1) * x; } return z & 0xFF; }
  function divisor(d) { var r = []; for (var i = 0; i < d - 1; i++) r.push(0); r.push(1); var root = 1; for (var k = 0; k < d; k++) { for (var j = 0; j < d; j++) { r[j] = mul(r[j], root); if (j + 1 < d) r[j] ^= r[j + 1]; } root = mul(root, 2); } return r; }
  function remainder(data, div) { var r = div.map(function () { return 0; }); data.forEach(function (b) { var f = b ^ r.shift(); r.push(0); div.forEach(function (c, i) { r[i] ^= mul(c, f); }); }); return r; }
  function utf8(s) { return Array.from(unescape(encodeURIComponent(s))).map(function (c) { return c.charCodeAt(0); }); }

  function matrix(text, ecl, minVersion) {
    ecl = ecl || 'M';
    var data = utf8(String(text)); var ver; var cap; var cc;
    for (ver = minVersion || 1; ver <= 40; ver++) { cap = dataCodewords(ver, ecl) * 8; cc = ver <= 9 ? 8 : 16; if (4 + cc + data.length * 8 <= cap) break; }
    if (ver > 40) throw new Error('Text too long for a QR code');
    var bits = []; var app = function (val, n) { for (var i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    app(4, 4); app(data.length, cc); data.forEach(function (b) { app(b, 8); });
    app(0, Math.min(4, cap - bits.length)); app(0, (8 - bits.length % 8) % 8);
    for (var pad = 0xEC; bits.length < cap; pad ^= 0xEC ^ 0x11) app(pad, 8);
    var cw = []; for (var i = 0; i < bits.length; i += 8) { var b = 0; for (var j = 0; j < 8; j++) b = (b << 1) | bits[i + j]; cw.push(b); }

    var n = ver * 4 + 17; var mod = []; var fn = [];
    for (var y = 0; y < n; y++) { mod.push(new Array(n).fill(false)); fn.push(new Array(n).fill(false)); }
    var set = function (x, y, d) { mod[y][x] = d; fn[y][x] = true; };
    for (i = 0; i < n; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    var finder = function (cx, cy) { for (var dy = -4; dy <= 4; dy++) for (var dx = -4; dx <= 4; dx++) { var xx = cx + dx; var yy = cy + dy; if (xx >= 0 && xx < n && yy >= 0 && yy < n) { var d = Math.max(Math.abs(dx), Math.abs(dy)); set(xx, yy, d !== 2 && d !== 4); } } };
    finder(3, 3); finder(n - 4, 3); finder(3, n - 4);
    if (ver > 1) {
      var na = Math.floor(ver / 7) + 2; var step = ver === 32 ? 26 : Math.floor((ver * 4 + na * 2 + 1) / (na * 2 - 2)) * 2;
      var pos = [6]; for (i = n - 7; pos.length < na; i -= step) pos.splice(1, 0, i);
      for (i = 0; i < na; i++) for (j = 0; j < na; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === na - 1) || (i === na - 1 && j === 0)) continue;
        for (var ay = -2; ay <= 2; ay++) for (var ax = -2; ax <= 2; ax++) set(pos[i] + ax, pos[j] + ay, Math.max(Math.abs(ax), Math.abs(ay)) !== 1);
      }
    }
    var format = function (m) {
      var d = FMT[ecl] << 3 | m; var r = d; for (var k = 0; k < 10; k++) r = (r << 1) ^ ((r >>> 9) * 0x537);
      var fb = (d << 10 | r) ^ 0x5412; var g = function (k) { return ((fb >>> k) & 1) !== 0; };
      for (var q = 0; q <= 5; q++) set(8, q, g(q));
      set(8, 7, g(6)); set(8, 8, g(7)); set(7, 8, g(8));
      for (q = 9; q < 15; q++) set(14 - q, 8, g(q));
      for (q = 0; q < 8; q++) set(n - 1 - q, 8, g(q));
      for (q = 8; q < 15; q++) set(8, n - 15 + q, g(q));
      set(8, n - 8, true);
    };
    format(0);
    if (ver >= 7) {
      var r = ver; for (i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1F25);
      var vb = ver << 12 | r; for (i = 0; i < 18; i++) { var bit = ((vb >>> i) & 1) !== 0; var a = n - 11 + i % 3; var c = Math.floor(i / 3); set(a, c, bit); set(c, a, bit); }
    }
    // error correction and interleaving
    var nb = BLOCKS[ecl][ver]; var el = ECC[ecl][ver]; var raw = Math.floor(rawModules(ver) / 8);
    var nshort = nb - raw % nb; var slen = Math.floor(raw / nb); var div = divisor(el); var blocks = []; var k = 0;
    for (i = 0; i < nb; i++) { var dat = cw.slice(k, k + slen - el + (i < nshort ? 0 : 1)); k += dat.length; var ecc = remainder(dat, div); if (i < nshort) dat.push(0); blocks.push(dat.concat(ecc)); }
    var all = []; for (i = 0; i < blocks[0].length; i++) for (j = 0; j < blocks.length; j++) if (i !== slen - el || j >= nshort) all.push(blocks[j][i]);
    // place codewords
    var bi = 0;
    for (var right = n - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < n; vert++) for (j = 0; j < 2; j++) {
        var x = right - j; var up = ((right + 1) & 2) === 0; var yy2 = up ? n - 1 - vert : vert;
        if (!fn[yy2][x] && bi < all.length * 8) { mod[yy2][x] = ((all[bi >>> 3] >>> (7 - (bi & 7))) & 1) !== 0; bi++; }
      }
    }
    var masks = [function (x, y) { return (x + y) % 2 === 0; }, function (x, y) { return y % 2 === 0; }, function (x) { return x % 3 === 0; }, function (x, y) { return (x + y) % 3 === 0; },
      function (x, y) { return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; }, function (x, y) { return x * y % 2 + x * y % 3 === 0; },
      function (x, y) { return (x * y % 2 + x * y % 3) % 2 === 0; }, function (x, y) { return ((x + y) % 2 + x * y % 3) % 2 === 0; }];
    var applyMask = function (m) { for (var yy = 0; yy < n; yy++) for (var xx = 0; xx < n; xx++) if (!fn[yy][xx] && masks[m](xx, yy)) mod[yy][xx] = !mod[yy][xx]; };
    var penalty = function () {
      var res = 0; var lines = [];
      for (var yy = 0; yy < n; yy++) { lines.push(mod[yy]); var col = []; for (var xx = 0; xx < n; xx++) col.push(mod[xx][yy]); lines.push(col); }
      lines.forEach(function (row) {
        var run = 1; for (var q = 1; q < n; q++) { if (row[q] === row[q - 1]) { run++; if (run === 5) res += 3; else if (run > 5) res++; } else run = 1; }
        var s = row.map(function (v) { return v ? '1' : '0'; }).join('');
        ['10111010000', '00001011101'].forEach(function (p) { var at = s.indexOf(p); while (at >= 0) { res += 40; at = s.indexOf(p, at + 1); } });
      });
      for (yy = 0; yy < n - 1; yy++) for (var x2 = 0; x2 < n - 1; x2++) { var cc2 = mod[yy][x2]; if (cc2 === mod[yy][x2 + 1] && cc2 === mod[yy + 1][x2] && cc2 === mod[yy + 1][x2 + 1]) res += 3; }
      var dark = 0; mod.forEach(function (row) { row.forEach(function (v) { if (v) dark++; }); });
      res += (Math.ceil(Math.abs(dark * 20 - n * n * 10) / (n * n)) - 1) * 10;
      return res;
    };
    var best = 0; var bestP = Infinity;
    for (var m = 0; m < 8; m++) { applyMask(m); format(m); var p = penalty(); if (p < bestP) { bestP = p; best = m; } applyMask(m); }
    applyMask(best); format(best);
    return mod;
  }

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  /** opts: color, logo (image URL drawn in the middle; use ecl 'H'), ecl, label (accessible name). */
  function svg(text, opts) {
    opts = opts || {};
    var m = matrix(text, opts.logo ? 'H' : (opts.ecl || 'M'), opts.minVersion); var n = m.length; var q = 4; var N = n + 2 * q; var col = opts.color || '#172923';
    var c0 = (n - 1) / 2; var L = opts.logo ? n * 0.22 : 0; var lo = c0 - L / 2 - 0.5; var hi = c0 + L / 2 + 0.5;
    var finderArea = function (x, y) { return (x < 7 && y < 7) || (x >= n - 7 && y < 7) || (x < 7 && y >= n - 7); };
    var d = '';
    for (var y = 0; y < n; y++) for (var x = 0; x < n; x++) {
      if (!m[y][x] || finderArea(x, y) || (L && x >= lo && x <= hi && y >= lo && y <= hi)) continue;
      d += 'M' + (x + q) + ' ' + (y + q) + 'h1v1h-1z';
    }
    var eyes = [[0, 0], [n - 7, 0], [0, n - 7]].map(function (e) {
      var X = e[0] + q; var Y = e[1] + q;
      return '<rect x="' + (X + 0.5) + '" y="' + (Y + 0.5) + '" width="6" height="6" rx="1.5" fill="none" stroke="' + col + '"/><rect x="' + (X + 2) + '" y="' + (Y + 2) + '" width="3" height="3" rx=".7" fill="' + col + '"/>';
    }).join('');
    var logo = '';
    if (L) { var s = L + 0.2; var p0 = c0 + q - s / 2 + 0.5; logo = '<rect x="' + (p0 - 0.6) + '" y="' + (p0 - 0.6) + '" width="' + (s + 1.2) + '" height="' + (s + 1.2) + '" rx="1.3" fill="#fff"/><image href="' + esc(opts.logo) + '" x="' + p0 + '" y="' + p0 + '" width="' + s + '" height="' + s + '"/>'; }
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + N + ' ' + N + '" role="img" aria-label="' + esc(opts.label || text) + '" shape-rendering="crispEdges"><rect width="' + N + '" height="' + N + '" fill="#fff"/><path fill="' + col + '" d="' + d + '"/>' + eyes + logo + '</svg>';
  }

  root.KinanQR = { matrix: matrix, svg: svg };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.KinanQR;
})(typeof window !== 'undefined' ? window : globalThis);
