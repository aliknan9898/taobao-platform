// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
'use strict';

const db = require('../db');
const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Malta', dateStyle: 'short' });
const prefix = 'import_digest:';
let sending = false;

function record(source, run, accepted, rejected = [], time = Date.now()) {
  const id = prefix + day.format(time);
  const existing = db.settings.get(id);
  const sources = existing?.sources || {};
  const summary = sources[source] || { runs: 0, checked: 0, skipped: 0, published: 0, pending: 0, rejected: 0, reasons: {} };
  summary.runs++;
  summary.checked += Number(run.checked) || 0;
  summary.skipped += Number(run.skipped) || 0;
  summary.published += accepted.filter((item) => item.status === 'active').length;
  summary.pending += accepted.filter((item) => item.status !== 'active').length;
  summary.rejected += rejected.length;
  if (run.error) summary.error = String(run.error).slice(0, 180);
  const reasons = new Map(Object.entries(run.reasons || {}));
  const explicit = new Map();
  for (const item of rejected) {
    const reason = String(item.reason || 'Unknown').slice(0, 120);
    explicit.set(reason, (explicit.get(reason) || 0) + 1);
  }
  for (const [reason, count] of explicit) {
    reasons.set(reason, Math.max(reasons.get(reason) || 0, count));
  }
  const totals = new Map(Object.entries(summary.reasons));
  for (const [reason, count] of reasons) totals.set(reason, (totals.get(reason) || 0) + Number(count));
  summary.reasons = Object.fromEntries([...totals].sort((a, b) => b[1] - a[1]).slice(0, 25));
  sources[source] = summary;
  if (existing) db.settings.update(id, { sources });
  else db.settings.insert({ id, sources });
}

async function tick(time = Date.now()) {
  if (sending) return false;
  const today = day.format(time);
  const report = db.settings.all((row) => row.id.startsWith(prefix) && row.id.slice(prefix.length) < today && !row.sent_at)
    .sort((a, b) => a.id.localeCompare(b.id))[0];
  const deliveryId = 'import_digest_delivery';
  if (!report || db.settings.get(deliveryId)?.day === today) return false;
  sending = true;
  try {
    const lines = [`📦 تقرير استيراد KINAN · ${report.id.slice(prefix.length)} (مالطا)`];
    for (const [source, stats] of Object.entries(report.sources)) {
      lines.push('', source, `الدفعات: ${stats.runs} · فُحص: ${stats.checked} · تجاوز: ${stats.skipped}`,
        `نُشر: ${stats.published} · بانتظار النشر: ${stats.pending} · رُفض: ${stats.rejected}`);
      for (const [reason, count] of Object.entries(stats.reasons).sort((a, b) => b[1] - a[1]).slice(0, 3)) {
        lines.push(`• ${reason.slice(0, 90)}: ${count}`);
      }
      if (stats.error) lines.push(`آخر خطأ: ${stats.error}`);
    }
    if (!await require('../push').telegram(lines.join('\n').slice(0, 3500))) return false;
    db.settings.update(report.id, { sent_at: time });
    if (db.settings.get(deliveryId)) db.settings.update(deliveryId, { day: today });
    else db.settings.insert({ id: deliveryId, day: today });
    await db.flush();
    return true;
  } finally {
    sending = false;
  }
}

module.exports = { record, tick };
