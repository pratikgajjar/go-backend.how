document.addEventListener("DOMContentLoaded", () => {
    const images = document.querySelectorAll('.lazyload-image');

    images.forEach(img => {
        const placeholder = img.previousElementSibling;

        const handleImageLoaded = () => {
            img.style.opacity = '1';
            if (placeholder) {
                Object.assign(placeholder.style, {
                    opacity: '0',
                    height: '0',
                    width: '0',
                    transform: 'scale(1.1)'
                });
            }
        };

        if (img.complete && img.naturalWidth !== 0) {
            handleImageLoaded();
        } else {
            img.addEventListener('load', handleImageLoaded, { once: true });
        }
    });
});

