(() => {
  const locale = navigator.language || navigator.languages?.[0] || '';
  const language = /^ar(?:-|_|$)/i.test(locale) ? 'ar' : 'en';
  if (language === document.documentElement.lang) return;

  const alternate = document.querySelector(`link[rel="alternate"][hreflang="${language}"]`);
  if (!alternate) return;

  const current = new URL(window.location.href);
  current.pathname = new URL(alternate.href).pathname;
  window.location.replace(current.href);
})();
