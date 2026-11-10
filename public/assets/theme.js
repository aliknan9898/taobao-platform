// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
/* Light/dark switch shared by every Kinan app. Light is the default; the choice is remembered
   on this device and applies to the shop, Seller Center, admin and warehouse alike.
   Loaded in <head> so the saved theme is applied before the page paints. */
'use strict';
(function () {
  var KEY = 'kinan_theme';
  var root = document.documentElement;
  var MOON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>';
  var SUN = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/></svg>';

  function saved() { try { return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light'; } catch (e) { return 'light'; } }
  function isDark() { return root.getAttribute('data-theme') === 'dark'; }

  function paint() {
    var dark = isDark();
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#0f1428' : '#ffffff');
    var btns = document.querySelectorAll('[data-theme-toggle]');
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      if (b.getAttribute('data-state') === (dark ? 'dark' : 'light')) continue; // already drawn (also stops observer loops)
      b.setAttribute('data-state', dark ? 'dark' : 'light');
      b.innerHTML = (dark ? SUN : MOON) + (b.hasAttribute('data-label') ? '<span>' + (dark ? 'Light mode' : 'Dark mode') + '</span>' : '');
      b.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
      b.setAttribute('title', dark ? 'Light mode' : 'Dark mode');
      b.setAttribute('aria-pressed', dark ? 'true' : 'false');
    }
  }

  function set(theme) {
    if (theme === 'dark') root.setAttribute('data-theme', 'dark'); else root.removeAttribute('data-theme');
    try { localStorage.setItem(KEY, theme); } catch (e) { /* private mode: still switches for this visit */ }
    paint();
  }

  if (saved() === 'dark') root.setAttribute('data-theme', 'dark');

  // Any element with data-theme-toggle switches the theme (works for buttons rendered later too).
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-theme-toggle]');
    if (!b) return;
    e.preventDefault();
    set(isDark() ? 'light' : 'dark');
  });
  // Repaint icons whenever an app re-renders its header.
  new MutationObserver(function () { paint(); }).observe(root, { childList: true, subtree: true });
  document.addEventListener('DOMContentLoaded', paint);

  window.KinanTheme = {
    isDark: isDark, set: set,
    /** Icon button. withLabel adds "Dark mode"/"Light mode" text next to the icon. */
    button: function (cls, withLabel) { return '<button type="button" class="' + (cls || '') + '" data-theme-toggle' + (withLabel ? ' data-label' : '') + '></button>'; }
  };
})();
