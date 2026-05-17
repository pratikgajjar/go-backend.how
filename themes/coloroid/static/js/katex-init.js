// Apply the deferred KaTeX stylesheet now that we're about to render math.
// (See baseof.html — the link is loaded with media="print" so it doesn't
// block FCP; flipping media to "all" applies the rules.)
function applyKatexCss() {
  document.querySelectorAll("link[data-katex-css]").forEach(function (l) {
    l.media = "all";
  });
}

// Wait for auto-render to load, then render math
document.addEventListener("DOMContentLoaded", function () {
  applyKatexCss();
  if (typeof renderMathInElement === "undefined") {
    // auto-render not loaded yet (deferred), retry on load
    window.addEventListener("load", initKatex);
  } else {
    initKatex();
  }
});

function initKatex() {
  if (typeof renderMathInElement === "function") {
    renderMathInElement(document.body, {
      delimiters: [
        { left: "$$", right: "$$", display: true },
        { left: "\\[", right: "\\]", display: true },
        { left: "\\(", right: "\\)", display: false },
      ],
      throwOnError: false,
    });
  }
}
