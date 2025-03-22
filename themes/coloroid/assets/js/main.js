function initLazyLoadImages() {
  const images = document.querySelectorAll('.lazyload-image');

  images.forEach(img => {
    const placeholder = img.previousElementSibling; // blurred image
    const handleImageLoaded = () => {
      img.style.opacity = '1';  // fade in high-res image
      if (placeholder) {
        placeholder.style.opacity = '0';  // fade out placeholder
      }
    };

    if (img.complete && img.naturalWidth !== 0) {
      // Image already loaded
      handleImageLoaded();
    } else {
      img.addEventListener('load', handleImageLoaded, { once: true });
    }
  });
}

if ('requestIdleCallback' in window) {
  requestIdleCallback(initLazyLoadImages);
} else {
  setTimeout(initLazyLoadImages, 1);
}

