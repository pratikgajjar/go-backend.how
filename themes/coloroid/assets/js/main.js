document.addEventListener("DOMContentLoaded", function() {
    const images = document.querySelectorAll('.lazyload-image');

    images.forEach(function(img) {
        img.addEventListener('load', function() {
            img.style.opacity = '1';
            const placeholder = img.previousElementSibling;
            if (placeholder) {
                placeholder.style.opacity = '0';
                placeholder.style.transform = 'scale(1.1)';
            }
        });
    });
});

