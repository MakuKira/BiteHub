(() => {
  let requested = false;

  function requestFonts() {
    if (requested) return;
    requested = true;
    const stylesheet = document.createElement('link');
    stylesheet.rel = 'stylesheet';
    stylesheet.href = 'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Manrope:wght@400;500;600;700;800&family=Nunito+Sans:wght@400;500;600;700;800;900&display=swap';
    document.head.append(stylesheet);
  }

  function scheduleFonts() {
    if ('requestIdleCallback' in window) {
      window.requestIdleCallback(requestFonts, { timeout: 1800 });
    } else {
      window.setTimeout(requestFonts, 700);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scheduleFonts, { once: true });
  } else {
    scheduleFonts();
  }
})();
