// Wait for auto-render to load, then render math
document.addEventListener("DOMContentLoaded", function () {
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
    });
  }
}
