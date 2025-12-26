// Load products from JSON file
function loadProducts() {
    fetch('products.json')
        .then(response => response.json())
        .then(data => {
            // Load product cards on About page
            const productsGrid = document.getElementById('products-grid');
            if (productsGrid) {
                productsGrid.innerHTML = data.products.map(product => `
                    <div class="product-card">
                        <div class="product-icon">${product.icon}</div>
                        <h3>${product.name}</h3>
                    </div>
                `).join('');
            }

            // Load product list text on Privacy Policy page
            const privacyList = document.getElementById('product-list-privacy');
            if (privacyList) {
                const names = data.products.map(p => p.name);
                privacyList.textContent = names.join(', ') + ', and all Kreative Koala LLC products';
            }

            // Load product list text on Terms page
            const termsList = document.getElementById('product-list-terms');
            if (termsList) {
                const names = data.products.map(p => p.name);
                termsList.textContent = names.join(', ');
            }
        })
        .catch(error => {
            console.error('Error loading products:', error);
        });
}

// Mobile Menu Toggle
document.addEventListener('DOMContentLoaded', function() {
    // Load products
    loadProducts();
    const mobileMenuBtn = document.querySelector('.mobile-menu-btn');
    const navLinks = document.querySelector('.nav-links');

    if (mobileMenuBtn && navLinks) {
        mobileMenuBtn.addEventListener('click', function() {
            mobileMenuBtn.classList.toggle('active');
            navLinks.classList.toggle('active');
        });

        // Close menu when clicking on a link
        navLinks.querySelectorAll('a').forEach(link => {
            link.addEventListener('click', function() {
                mobileMenuBtn.classList.remove('active');
                navLinks.classList.remove('active');
            });
        });

        // Close menu when clicking outside
        document.addEventListener('click', function(e) {
            if (!mobileMenuBtn.contains(e.target) && !navLinks.contains(e.target)) {
                mobileMenuBtn.classList.remove('active');
                navLinks.classList.remove('active');
            }
        });
    }

    // Smooth scroll for anchor links
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function(e) {
            e.preventDefault();
            const target = document.querySelector(this.getAttribute('href'));
            if (target) {
                target.scrollIntoView({
                    behavior: 'smooth',
                    block: 'start'
                });
            }
        });
    });

    // Add scroll effect to navbar
    const navbar = document.querySelector('.navbar');
    if (navbar) {
        window.addEventListener('scroll', function() {
            if (window.scrollY > 50) {
                navbar.style.boxShadow = '0 4px 6px -1px rgb(0 0 0 / 0.1)';
            } else {
                navbar.style.boxShadow = 'none';
            }
        });
    }
});
