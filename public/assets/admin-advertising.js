'use strict';

window.KinanAdvertising = (() => {
  const channels = {
    meta: ['Meta Ads', 'https://adsmanager.facebook.com/'],
    tiktok: ['TikTok Ads', 'https://ads.tiktok.com/'],
    google: ['Google Ads', 'https://ads.google.com/']
  };
  const labels = {
    configured: 'Configured', setup: 'Setup required', authorize: 'Authorization required',
    permission: 'Access denied', rate_limit: 'Rate limit reached', unavailable: 'Report unavailable'
  };
  const decimal = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
  const fmt = (value) => value == null ? '—' : decimal.format(value);
  const ratio = (a, b) => a == null || !b ? null : a / b;

  function dateBefore(days) {
    const date = new Date();
    date.setDate(date.getDate() - days);
    return new Intl.DateTimeFormat('sv-SE').format(date);
  }

  function summary(rows, currency, esc) {
    const sum = (key) => rows.length && rows.every((row) => row[key] != null)
      ? rows.reduce((total, row) => total + row[key], 0) : null;
    const spend = currency ? sum('spend') : null;
    const clicks = sum('clicks');
    const impressions = sum('impressions');
    const ctr = ratio(clicks, impressions);
    return [
      ['Spend', spend == null ? '—' : fmt(spend) + ' ' + currency],
      ['Impressions', fmt(impressions)], ['Clicks', fmt(clicks)],
      ['CTR', ctr == null ? '—' : fmt(100 * ctr) + '%'],
      ['Conversions', fmt(sum('conversions'))],
      ['Conversion value', currency && sum('value') != null ? fmt(sum('value')) + ' ' + currency : '—']
    ].map(([label, value]) => '<div class="card ads-kpi"><span class="muted">' + label + '</span><strong>'
      + esc(value) + '</strong></div>').join('');
  }

  async function render(view, api, esc) {
    const accounts = await api('/api/admin/advertising');
    const initial = Object.keys(channels).find((key) => accounts[key]?.status === 'configured') || 'meta';
    view.innerHTML = `
      <div class="ads-channels">${Object.entries(channels).map(([key, [name, url]]) => {
        const { status, account, missing } = accounts[key];
        return `<section class="card ads-channel">
          <div class="ads-channel-head"><h2>${name}</h2><span class="pill ${status === 'configured' ? 'ok' : 'warn'}">${labels[status]}</span></div>
          ${account ? `<p class="muted">Account ${esc(account)}</p>` : ''}
          ${missing.length ? `<p class="muted small">Render environment · ${missing.map(esc).join(', ')}</p>` : ''}
          ${status === 'authorize' ? '<p class="muted small">Authorize Google Ads under AI &amp; Product Research.</p>' : ''}
          <a href="${url}" target="_blank" rel="noopener">Open Ads Manager ↗</a>
        </section>`;
      }).join('')}</div>
      <form class="card ads-filter">
        <label>Platform<select name="platform">${Object.entries(channels).map(([key, [name]]) =>
          `<option value="${key}" ${key === initial ? 'selected' : ''}>${name}</option>`).join('')}</select></label>
        <label>From<input type="date" name="from" value="${dateBefore(29)}" required></label>
        <label>To<input type="date" name="to" value="${dateBefore(0)}" required></label>
        <button class="btn" type="submit">Load report</button>
      </form>
      <div class="ads-report" aria-busy="false"></div>`;

    const form = view.querySelector('form');
    const output = view.querySelector('.ads-report');
    let requestNumber = 0;

    async function load() {
      const sequence = ++requestNumber;
      const query = new URLSearchParams(new FormData(form));
      const platform = query.get('platform');
      output.setAttribute('aria-busy', 'true');
      output.innerHTML = '<p class="muted" role="status">Loading campaign performance…</p>';
      try {
        const report = await api('/api/admin/advertising?' + query);
        if (sequence !== requestNumber) return;
        if (report.status !== 'ready') {
          output.innerHTML = `<p class="card" role="status">${esc(labels[report.status] || 'Report unavailable')}. Review the platform connection above.</p>`;
          return;
        }
        const rows = report.rows.slice().sort((a, b) => (b.spend ?? -1) - (a.spend ?? -1));
        if (!rows.length) {
          output.innerHTML = '<p class="card" role="status">The platform returned no campaign rows for these dates.</p>';
          return;
        }
        const currencies = new Set(rows.map((row) => row.currency));
        const currency = currencies.size === 1 ? rows[0].currency : null;
        output.innerHTML = `
          ${report.partial ? '<p class="card">The report reached its page limit. Figures cover the campaigns shown. Shorten the date range to narrow the report.</p>' : ''}
          <div class="ads-kpis">${summary(rows, currency, esc)}</div>
          <section class="card">
            <div class="ads-channel-head"><h2>Campaign performance</h2><span class="muted small">Fetched ${esc(new Date(report.fetchedAt).toLocaleString())}</span></div>
            <p class="muted small">${platform === 'google' ? 'Conversions follow the goals configured in Google Ads.' : 'Conversions represent purchases reported by this platform.'}</p>
            <label class="ads-search">Filter campaigns<input type="search" placeholder="Campaign name or ID"></label>
            <div class="ads-table"><table>
              <thead><tr>${['Campaign', 'Objective', 'Spend', 'Impressions', 'Clicks', 'CTR', 'CPC', 'Reach', 'Conversions', 'Cost / conversion', 'Conversion value', 'ROAS'].map((name) => '<th scope="col">' + name + '</th>').join('')}</tr></thead>
              <tbody>${rows.map((row) => {
                const ctr = ratio(row.clicks, row.impressions);
                const money = (value) => value == null ? '—' : fmt(value) + (row.currency ? ' ' + row.currency : '');
                const name = row.name || row.id;
                const roas = row.roas ?? ratio(row.value, row.spend);
                return `<tr data-campaign><th scope="row"><strong>${esc(name)}</strong><small class="muted">${esc(row.id)}${row.status ? ' · ' + esc(row.status) : ''}</small></th>
                  <td>${esc(row.objective || '—')}</td><td>${esc(money(row.spend))}</td><td>${fmt(row.impressions)}</td><td>${fmt(row.clicks)}</td>
                  <td>${ctr == null ? '—' : fmt(100 * ctr) + '%'}</td><td>${esc(money(ratio(row.spend, row.clicks)))}</td>
                  <td>${fmt(row.reach)}</td><td>${fmt(row.conversions)}</td><td>${esc(money(ratio(row.spend, row.conversions)))}</td>
                  <td>${esc(money(row.value))}</td><td>${roas == null ? '—' : fmt(roas) + '×'}</td></tr>`;
              }).join('')}</tbody>
            </table></div>
            <p class="muted small" role="status" data-campaign-count>${rows.length} campaigns</p>
          </section>`;
        const search = output.querySelector('input[type="search"]');
        const campaignRows = [...output.querySelectorAll('[data-campaign]')];
        search.oninput = () => {
          const term = search.value.trim().toLowerCase();
          let count = 0;
          for (const row of campaignRows) {
            row.hidden = !row.firstElementChild.textContent.toLowerCase().includes(term);
            if (!row.hidden) count++;
          }
          output.querySelector('[data-campaign-count]').textContent = count + ' campaigns';
        };
      } catch (error) {
        if (sequence === requestNumber) output.innerHTML = `<p class="card err" role="alert">${esc(error.message)}</p>`;
      } finally {
        if (sequence === requestNumber) output.setAttribute('aria-busy', 'false');
      }
    }

    form.onsubmit = (event) => { event.preventDefault(); load(); };
    form.elements.platform.onchange = load;
    await load();
  }

  return { render };
})();
