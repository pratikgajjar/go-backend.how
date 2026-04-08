// ============================================================
// backend.how — main.js
// ============================================================

// === Lazy Load Images ===
function initLazyLoadImages() {
  const images = document.querySelectorAll('.lazyload-image');
  images.forEach(img => {
    const placeholder = img.previousElementSibling;
    const handleLoaded = () => {
      img.style.opacity = '1';
      if (placeholder) placeholder.style.opacity = '0';
    };
    if (img.complete && img.naturalWidth !== 0) {
      handleLoaded();
    } else {
      img.addEventListener('load', handleLoaded, { once: true });
    }
  });
}

// === Copy Buttons for Code Blocks ===
function initCopyButtons() {
  document.querySelectorAll('.highlight').forEach(block => {
    // Wrap in a relative-positioned container
    const wrapper = document.createElement('div');
    wrapper.className = 'highlight-wrapper';
    block.parentNode.insertBefore(wrapper, block);
    wrapper.appendChild(block);

    const btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.textContent = 'copy';
    btn.setAttribute('aria-label', 'Copy code to clipboard');
    wrapper.appendChild(btn);

    btn.addEventListener('click', () => {
      const code = block.querySelector('code') || block.querySelector('pre');
      const text = code ? code.innerText : '';
      navigator.clipboard.writeText(text).then(() => {
        btn.textContent = 'copied!';
        setTimeout(() => { btn.textContent = 'copy'; }, 2000);
      }).catch(() => {
        // Fallback for older browsers
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        btn.textContent = 'copied!';
        setTimeout(() => { btn.textContent = 'copy'; }, 2000);
      });
    });
  });
}

// === Code Language Labels ===
function initCodeLabels() {
  document.querySelectorAll('.highlight pre code').forEach(code => {
    const langClass = Array.from(code.classList).find(c => c.startsWith('language-'));
    if (!langClass) return;
    const lang = langClass.replace('language-', '');
    if (!lang || lang === 'plaintext' || lang === 'text' || lang === 'txt' || lang === 'fallback') return;

    const block = code.closest('.highlight');
    if (!block) return;
    block.style.position = 'relative';

    const label = document.createElement('span');
    label.className = 'code-lang-label';
    label.textContent = lang;
    block.appendChild(label);
  });
}

// === Reading Progress Bar ===
function initProgressBar() {
  if (!document.querySelector('.article-content')) return;

  const bar = document.createElement('div');
  bar.id = 'reading-progress';
  document.body.prepend(bar);

  const update = () => {
    const doc = document.documentElement;
    const scrollTop = window.scrollY || doc.scrollTop;
    const scrollHeight = doc.scrollHeight - doc.clientHeight;
    bar.style.width = (scrollHeight > 0 ? (scrollTop / scrollHeight) * 100 : 0) + '%';
  };

  window.addEventListener('scroll', update, { passive: true });
  update();
}

// === Back to Top Button ===
function initBackToTop() {
  const btn = document.createElement('button');
  btn.id = 'back-to-top';
  btn.innerHTML = '↑';
  btn.setAttribute('aria-label', 'Back to top');
  document.body.appendChild(btn);

  window.addEventListener('scroll', () => {
    btn.classList.toggle('visible', window.scrollY > 400);
  }, { passive: true });

  btn.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
}

// === Active TOC Highlighting ===
function initTOCHighlight() {
  const toc = document.querySelector('.table-of-content');
  if (!toc) return;

  // Support h1/h2/h3 since content uses h1 for sections
  const headings = document.querySelectorAll(
    '.article-content h1[id], .article-content h2[id], .article-content h3[id]'
  );
  const tocLinks = toc.querySelectorAll('a[href^="#"]');
  if (!headings.length || !tocLinks.length) return;

  const linkMap = {};
  tocLinks.forEach(link => {
    const id = link.getAttribute('href').slice(1);
    linkMap[id] = link;
  });

  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        tocLinks.forEach(l => l.classList.remove('toc-active'));
        const link = linkMap[entry.target.id];
        if (link) link.classList.add('toc-active');
      }
    });
  }, { rootMargin: '-8% 0px -80% 0px', threshold: 0 });

  headings.forEach(h => observer.observe(h));
}

// === Dark Mode Toggle ===
function initDarkModeToggle() {
  const btn = document.getElementById('theme-toggle');
  if (!btn) return;

  const html = document.documentElement;
  const origTheme = document.body.dataset.theme;

  // If page has no theme, toggle is useless — hide it
  if (!origTheme) {
    btn.style.display = 'none';
    return;
  }

  const isDark = () => html.hasAttribute('data-force-dark');
  btn.textContent = isDark() ? '●' : '◑';
  btn.title = isDark() ? 'Switch to themed mode' : 'Switch to dark mode';

  btn.addEventListener('click', () => {
    if (isDark()) {
      html.removeAttribute('data-force-dark');
      localStorage.removeItem('backend-theme');
      btn.textContent = '◑';
      btn.title = 'Switch to dark mode';
    } else {
      html.setAttribute('data-force-dark', '');
      localStorage.setItem('backend-theme', 'dark');
      btn.textContent = '●';
      btn.title = 'Switch to themed mode';
    }
  });
}

// === Keyboard Navigation Between Posts ===
function initKeyboardNav() {
  const prev = document.querySelector('.prev-post');
  const next = document.querySelector('.next-post');
  if (!prev && !next) return;

  // Show hint for desktop users
  const navEl = document.querySelector('.post-navigation');
  if (navEl) {
    const hint = document.createElement('div');
    hint.className = 'keyboard-hint';
    hint.textContent = '← → arrow keys to navigate';
    navEl.appendChild(hint);
  }

  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.target.isContentEditable) return;
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    if (e.key === 'ArrowLeft' && prev) prev.click();
    if (e.key === 'ArrowRight' && next) next.click();
  });
}

// === Share: Copy Link Button ===
function initShareButtons() {
  document.querySelectorAll('.share-copy-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(window.location.href).then(() => {
        const orig = btn.textContent;
        btn.textContent = 'copied!';
        setTimeout(() => { btn.textContent = orig; }, 2000);
      });
    });
  });
}

// === Init All ===
function initAll() {
  initLazyLoadImages();
  initCopyButtons();
  initCodeLabels();
  initProgressBar();
  initBackToTop();
  initTOCHighlight();
  initDarkModeToggle();
  initKeyboardNav();
  initShareButtons();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initAll);
} else {
  if ('requestIdleCallback' in window) {
    requestIdleCallback(initAll);
  } else {
    setTimeout(initAll, 1);
  }
}
