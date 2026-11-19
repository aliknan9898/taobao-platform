// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
const { config } = require('../config');

async function send(summary, accepted, rejected, label, { points = true } = {}) {
  const lines = [
    `📦 Kinan × CJdropshipping — ${label}`,
    `تم النشر: ${accepted.filter((p) => p.status === 'active').length} · بانتظار النشر: ${accepted.filter((p) => p.status !== 'active').length} · مرفوض: ${rejected.length}`,
    ...(summary.checked != null ? [`مرشّحون للفحص: ${summary.checked} · إجمالي التجاوزات في الدفعة: ${summary.skipped || 0}`] : []),
    ...(summary.error ? [`⏸ ${summary.error}`] : []),
  ];
  const usage = points ? require('../cj/client').usage().points : null;
  if (usage) lines.push(`🔑 CJ points: ${usage.remaining}/${usage.total || '?'} (+${usage.refill_per_minute || '?'}/min)`);
  for (const [title, products] of [
    ['✅ المنتجات المنشورة', accepted.filter((p) => p.status === 'active')],
    ['⏳ منتجات أضيفت وتنتظر النشر', accepted.filter((p) => p.status !== 'active')],
    ['❌ المنتجات المرفوضة', rejected],
  ]) {
    lines.push('', `${title} (${products.length})`);
    for (const p of products) {
      lines.push(`• ${String(p.title || p.pid || 'CJ').slice(0, 160)}${p.pid ? ` [CJ: ${String(p.pid).slice(0, 60)}]` : ''}${p.reason ? ` — ${String(p.reason).slice(0, 200)}` : ''}`);
      if (p.id && p.status === 'active') lines.push(`${config.publicBaseUrl}/#/p/${encodeURIComponent(p.id)}`);
    }
  }
  const telegram = require('../push').telegram;
  const heading = lines[0];
  let message = '';
  for (const line of lines) {
    if (message && message.length + line.length + 1 > 3400) {
      if (!await telegram(message)) return false;
      message = `${heading} (متابعة)`;
    }
    message += (message ? '\n' : '') + line.slice(0, 800);
  }
  return telegram(message);
}

module.exports = { send };
