(() => {
  const current = new URL(window.location.href);
  // URL fragments never reach the server. Keep older shop bookmarks working.
  if (current.pathname === '/' && current.hash.startsWith('#/')) {
    current.pathname = '/shop';
    window.location.replace(current.href);
    return;
  }

  const locale = navigator.language || navigator.languages?.[0] || '';
  const language = /^ar(?:-|_|$)/i.test(locale) ? 'ar' : 'en';
  if (language === document.documentElement.lang) return;

  const alternate = document.querySelector(`link[rel="alternate"][hreflang="${language}"]`);
  if (!alternate) return;

  current.pathname = new URL(alternate.href).pathname;
  window.location.replace(current.href);
})();
