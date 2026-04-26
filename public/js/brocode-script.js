// BroCode Dark Theme - Modern Student Management System JavaScript

// ===== UTILITY FUNCTIONS =====
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => document.querySelectorAll(selector);

const debounce = (func, wait) => {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
};

// ===== INITIALIZATION =====
document.addEventListener('DOMContentLoaded', function() {
    initializeApp();
});

function initializeApp() {
    initNavigation();
    initScrollEffects();
    initAnimations();
    initFormValidation();
    initGallery();
    initTheme();
    initParticles();
    initTypingEffect();
    initCounters();
    initScrollReveal();
}

// ===== NAVIGATION =====
function initNavigation() {
    const navbar = $('.navbar');
    const navLinks = $$('.nav-link');
    
    // Navbar scroll effect
    window.addEventListener('scroll', debounce(() => {
        if (window.scrollY > 50) {
            navbar.style.background = 'rgba(15, 15, 35, 0.98)';
            navbar.style.boxShadow = '0 4px 20px rgba(0, 0, 0, 0.3)';
        } else {
            navbar.style.background = 'rgba(15, 15, 35, 0.95)';
            navbar.style.boxShadow = 'none';
        }
    }, 10));
    
    // Active link highlighting
    navLinks.forEach(link => {
        link.addEventListener('click', function(e) {
            navLinks.forEach(l => l.classList.remove('active'));
            this.classList.add('active');
            
            // Auto-close sidebar on mobile after clicking a link
            if (window.innerWidth <= 991) {
                const sidebar = $('#sidebar');
                if (sidebar) sidebar.classList.remove('active');
            }
        });
    });

    // Sidebar Toggle for Mobile
    const toggleBtn = $('.sidebar-toggle-btn');
    const sidebar = $('#sidebar');
    if (toggleBtn && sidebar) {
        toggleBtn.addEventListener('click', () => {
            sidebar.classList.toggle('active');
        });
        
        // Close sidebar when clicking outside
        document.addEventListener('click', (e) => {
            if (window.innerWidth <= 991 && 
                sidebar.classList.contains('active') && 
                !sidebar.contains(e.target) && 
                !toggleBtn.contains(e.target)) {
                sidebar.classList.remove('active');
            }
        });
    }
}

// ===== SCROLL EFFECTS =====
function initScrollEffects() {
    // Back to top button
    const backToTop = createBackToTopButton();
    document.body.appendChild(backToTop);
    
    window.addEventListener('scroll', debounce(() => {
        if (window.scrollY > 300) {
            backToTop.style.opacity = '1';
            backToTop.style.pointerEvents = 'auto';
        } else {
            backToTop.style.opacity = '0';
            backToTop.style.pointerEvents = 'none';
        }
    }, 10));
}

function createBackToTopButton() {
    const button = document.createElement('button');
    button.innerHTML = '<i class="fas fa-arrow-up"></i>';
    button.className = 'back-to-top-btn';
    button.style.cssText = `
        position: fixed;
        bottom: 30px;
        right: 30px;
        width: 50px;
        height: 50px;
        background: var(--gradient-1);
        border: none;
        border-radius: 50%;
        color: white;
        font-size: 1.2rem;
        cursor: pointer;
        opacity: 0;
        pointer-events: none;
        transition: all 0.3s ease;
        z-index: 1000;
        box-shadow: 0 4px 15px rgba(0, 200, 255, 0.4);
    `;
    
    button.addEventListener('click', () => {
        window.scrollTo({
            top: 0,
            behavior: 'smooth'
        });
    });
    
    button.addEventListener('mouseenter', () => {
        button.style.transform = 'translateY(-5px)';
        button.style.boxShadow = '0 8px 25px rgba(0, 200, 255, 0.6)';
    });
    
    button.addEventListener('mouseleave', () => {
        button.style.transform = 'translateY(0)';
        button.style.boxShadow = '0 4px 15px rgba(0, 200, 255, 0.4)';
    });
    
    return button;
}

// ===== ANIMATIONS =====
function initAnimations() {
    // Intersection Observer for scroll animations
    const observerOptions = {
        threshold: 0.1,
        rootMargin: '0px 0px -50px 0px'
    };
    
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.style.opacity = '1';
                entry.target.style.transform = 'translateY(0)';
                observer.unobserve(entry.target);
            }
        });
    }, observerOptions);
    
    // Observe elements with animation classes
    $$('.animate-on-scroll').forEach(el => {
        el.style.opacity = '0';
        el.style.transform = 'translateY(30px)';
        el.style.transition = 'all 0.6s ease-out';
        observer.observe(el);
    });
}

// ===== FORM VALIDATION =====
function initFormValidation() {
    const forms = $$('form');
    
    forms.forEach(form => {
        form.addEventListener('submit', handleFormSubmit);
        
        // Real-time validation
        const inputs = form.querySelectorAll('input, textarea, select');
        inputs.forEach(input => {
            input.addEventListener('blur', () => validateField(input));
            input.addEventListener('input', () => {
                if (input.classList.contains('error')) {
                    validateField(input);
                }
            });
        });
    });
    
    // Initialize role selection for registration form
    initRoleSelection();
}

// ===== ROLE SELECTION =====
function initRoleSelection() {
    const roleCards = $$('.role-card');
    const userTypeInput = $('#userType');
    const studentFields = $('#studentFields');
    const teacherFields = $('#teacherFields');
    const parentFields = $('#parentFields');
    
    if (!roleCards.length || !userTypeInput) return;
    
    roleCards.forEach(card => {
        card.addEventListener('click', function() {
            const role = this.getAttribute('data-role');
            
            // Remove active class from all cards
            roleCards.forEach(c => c.classList.remove('active'));
            
            // Add active class to selected card
            this.classList.add('active');
            
            // Set hidden input value
            userTypeInput.value = role;
            
            // Show/hide role-specific fields
            studentFields.style.display = role === 'student' ? 'block' : 'none';
            teacherFields.style.display = role === 'teacher' ? 'block' : 'none';
            parentFields.style.display = role === 'parent' ? 'block' : 'none';
            
            // Update progress bar
            updateProgressBar(1);
        });
    });
    
    // Password strength checker
    const passwordInput = $('#password');
    const passwordStrength = $('#passwordStrength');
    if (passwordInput && passwordStrength) {
        passwordInput.addEventListener('input', checkPasswordStrength);
    }
}

// ===== PASSWORD STRENGTH =====
function checkPasswordStrength() {
    const password = $('#password').value;
    const strengthDiv = $('#passwordStrength');
    
    let strength = 0;
    const requirements = {
        length: password.length >= 5,
        upper: /[A-Z]/.test(password),
        lower: /[a-z]/.test(password),
        number: /[0-9]/.test(password),
        special: /[^A-Za-z0-9]/.test(password)
    };
    
    // Update requirement indicators
    updateRequirement('lengthReq', requirements.length);
    updateRequirement('upperReq', requirements.upper);
    updateRequirement('lowerReq', requirements.lower);
    updateRequirement('numberReq', requirements.number);
    
    // Calculate strength
    Object.values(requirements).forEach(met => {
        if (met) strength++;
    });
    
    // Update strength display
    let strengthText = '';
    let strengthClass = '';
    
    if (strength <= 2) {
        strengthText = 'Weak';
        strengthClass = 'weak';
    } else if (strength <= 3) {
        strengthText = 'Medium';
        strengthClass = 'medium';
    } else if (strength <= 4) {
        strengthText = 'Strong';
        strengthClass = 'strong';
    } else {
        strengthText = 'Very Strong';
        strengthClass = 'very-strong';
    }
    
    strengthDiv.textContent = strengthText;
    strengthDiv.className = `password-strength ${strengthClass}`;
}

function updateRequirement(reqId, met) {
    const req = $(`#${reqId}`);
    if (req) {
        const icon = req.querySelector('i');
        if (met) {
            icon.className = 'fas fa-check-circle';
            req.style.color = '#00b894';
        } else {
            icon.className = 'fas fa-circle';
            req.style.color = '#6c757d';
        }
    }
}

// ===== PROGRESS BAR =====
function updateProgressBar(step) {
    const progressBar = $('#progressBar');
    const stepIndicators = $$('.step');
    
    if (progressBar && stepIndicators.length) {
        const percentage = (step / 3) * 100;
        progressBar.style.width = `${percentage}%`;
        
        stepIndicators.forEach((indicator, index) => {
            if (index < step) {
                indicator.classList.add('active');
            } else {
                indicator.classList.remove('active');
            }
        });
    }
}

function handleFormSubmit(e) {
    const form = e.target;
    
    // Check if this is the registration form - let it submit normally
    if (form.id === 'registerForm') {
        console.log('Registration form submitting to server...');
        // Don't prevent default, let the form submit normally
        return;
    }
    
    // For other forms, use the existing validation logic
    e.preventDefault();
    const formData = new FormData(form);
    
    // Validate all fields
    const inputs = form.querySelectorAll('input, textarea, select');
    let isValid = true;
    
    inputs.forEach(input => {
        if (!validateField(input)) {
            isValid = false;
        }
    });
    
    if (isValid) {
        // Show loading state
        const submitBtn = form.querySelector('button[type="submit"]');
        if (submitBtn) {
            submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin me-2"></i> Processing...';
            // We do not disable the button here because form.submit() might fail if button is disabled in some browsers,
            // but usually it's fine. We'll just let the browser immediately submit and refresh.
            submitBtn.style.pointerEvents = 'none';
        }
        
        // Actually submit the data to the backend!
        form.submit();
    }
}

function validateField(field) {
    const value = field.value.trim();
    const fieldName = field.name || field.id;
    let isValid = true;
    let errorMessage = '';
    
    // Remove previous error states
    field.classList.remove('error', 'success');
    const existingError = field.parentNode.querySelector('.error-message');
    if (existingError) existingError.remove();
    
    // Validation rules
    if (field.hasAttribute('required') && !value) {
        isValid = false;
        errorMessage = 'This field is required';
    } else if (field.type === 'email' && value && !isValidEmail(value)) {
        isValid = false;
        errorMessage = 'Please enter a valid email address';
    } else if (field.type === 'password' && value && value.length < 5) {
        isValid = false;
        errorMessage = 'Password must be at least 8 characters';
    } else if (field.name === 'confirmPassword' && value) {
        const password = document.querySelector('input[name="password"]').value;
        if (value !== password) {
            isValid = false;
            errorMessage = 'Passwords do not match';
        }
    }
    
    // Apply validation state
    if (!isValid) {
        field.classList.add('error');
        showError(field, errorMessage);
    } else if (value) {
        field.classList.add('success');
    }
    
    return isValid;
}

function isValidEmail(email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
}

function showError(field, message) {
    const errorDiv = document.createElement('div');
    errorDiv.className = 'error-message';
    errorDiv.textContent = message;
    errorDiv.style.cssText = `
        color: #d63031;
        font-size: 0.875rem;
        margin-top: 0.5rem;
        display: block;
    `;
    field.parentNode.appendChild(errorDiv);
}

// ===== GALLERY =====
function initGallery() {
    const galleryItems = $$('.gallery-item');
    const modal = createGalleryModal();
    document.body.appendChild(modal);
    
    galleryItems.forEach(item => {
        item.addEventListener('click', () => {
            const img = item.querySelector('img');
            const title = item.querySelector('.gallery-title').textContent;
            const description = item.querySelector('.gallery-description').textContent;
            openGalleryModal(img.src, title, description);
        });
    });
}

function createGalleryModal() {
    const modal = document.createElement('div');
    modal.className = 'gallery-modal';
    modal.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, 0.9);
        display: none;
        align-items: center;
        justify-content: center;
        z-index: 2000;
        opacity: 0;
        transition: opacity 0.3s ease;
    `;
    
    modal.innerHTML = `
        <div class="modal-content" style="
            max-width: 90%;
            max-height: 90%;
            background: #1a1a2e;
            border-radius: 20px;
            overflow: hidden;
            position: relative;
            transform: scale(0.8);
            transition: transform 0.3s ease;
        ">
            <button class="modal-close" style="
                position: absolute;
                top: 20px;
                right: 20px;
                background: none;
                border: none;
                color: white;
                font-size: 2rem;
                cursor: pointer;
                z-index: 1;
            ">×</button>
            <img class="modal-image" style="
                width: 100%;
                height: auto;
                max-height: 70vh;
                object-fit: contain;
            ">
            <div class="modal-info" style="
                padding: 2rem;
                color: white;
            ">
                <h3 class="modal-title"></h3>
                <p class="modal-description"></p>
            </div>
        </div>
    `;
    
    modal.addEventListener('click', (e) => {
        if (e.target === modal || e.target.classList.contains('modal-close')) {
            closeGalleryModal();
        }
    });
    
    return modal;
}

function openGalleryModal(src, title, description) {
    const modal = $('.gallery-modal');
    const modalImage = modal.querySelector('.modal-image');
    const modalTitle = modal.querySelector('.modal-title');
    const modalDescription = modal.querySelector('.modal-description');
    const modalContent = modal.querySelector('.modal-content');
    
    modalImage.src = src;
    modalTitle.textContent = title;
    modalDescription.textContent = description;
    
    modal.style.display = 'flex';
    setTimeout(() => {
        modal.style.opacity = '1';
        modalContent.style.transform = 'scale(1)';
    }, 10);
}

function closeGalleryModal() {
    const modal = $('.gallery-modal');
    const modalContent = modal.querySelector('.modal-content');
    
    modal.style.opacity = '0';
    modalContent.style.transform = 'scale(0.8)';
    setTimeout(() => {
        modal.style.display = 'none';
    }, 300);
}

// ===== THEME =====
function initTheme() {
    const themeToggle = createThemeToggle();
    $('.navbar').appendChild(themeToggle);
    
    // Load saved theme
    const savedTheme = localStorage.getItem('theme') || 'dark';
    applyTheme(savedTheme);
}

function createThemeToggle() {
    const toggle = document.createElement('button');
    toggle.innerHTML = '<i class="fas fa-moon"></i>';
    toggle.className = 'theme-toggle';
    toggle.style.cssText = `
        background: var(--gradient-1);
        border: none;
        border-radius: 50px;
        color: white;
        padding: 0.5rem 1rem;
        cursor: pointer;
        transition: all 0.3s ease;
        margin-left: auto;
    `;
    
    toggle.addEventListener('click', () => {
        const currentTheme = document.body.getAttribute('data-theme');
        const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
        applyTheme(newTheme);
        localStorage.setItem('theme', newTheme);
    });
    
    return toggle;
}

function applyTheme(theme) {
    document.body.setAttribute('data-theme', theme);
    const icon = document.querySelector('.theme-toggle i');
    icon.className = theme === 'dark' ? 'fas fa-moon' : 'fas fa-sun';
}

// ===== PARTICLES =====
function initParticles() {
    const canvas = document.createElement('canvas');
    canvas.id = 'particles-canvas';
    canvas.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
        z-index: -1;
    `;
    document.body.appendChild(canvas);
    
    const ctx = canvas.getContext('2d');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    
    const particles = [];
    const particleCount = 50;
    
    class Particle {
        constructor() {
            this.x = Math.random() * canvas.width;
            this.y = Math.random() * canvas.height;
            this.vx = (Math.random() - 0.5) * 0.5;
            this.vy = (Math.random() - 0.5) * 0.5;
            this.radius = Math.random() * 2 + 1;
            this.opacity = Math.random() * 0.5 + 0.2;
        }
        
        update() {
            this.x += this.vx;
            this.y += this.vy;
            
            if (this.x < 0 || this.x > canvas.width) this.vx = -this.vx;
            if (this.y < 0 || this.y > canvas.height) this.vy = -this.vy;
        }
        
        draw() {
            ctx.beginPath();
            ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(108, 92, 231, ${this.opacity})`;
            ctx.fill();
        }
    }
    
    // Create particles
    for (let i = 0; i < particleCount; i++) {
        particles.push(new Particle());
    }
    
    // Animation loop
    function animate() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        
        particles.forEach(particle => {
            particle.update();
            particle.draw();
        });
        
        // Draw connections
        particles.forEach((p1, i) => {
            particles.slice(i + 1).forEach(p2 => {
                const distance = Math.sqrt((p1.x - p2.x) ** 2 + (p1.y - p2.y) ** 2);
                if (distance < 100) {
                    ctx.beginPath();
                    ctx.moveTo(p1.x, p1.y);
                    ctx.lineTo(p2.x, p2.y);
                    ctx.strokeStyle = `rgba(108, 92, 231, ${0.2 * (1 - distance / 100)})`;
                    ctx.stroke();
                }
            });
        });
        
        requestAnimationFrame(animate);
    }
    
    animate();
    
    // Handle resize
    window.addEventListener('resize', () => {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
    });
}

// ===== TYPING EFFECT =====
function initTypingEffect() {
    const elements = $$('[data-typing]');
    
    elements.forEach(element => {
        const text = element.textContent;
        element.textContent = '';
        let index = 0;
        
        function type() {
            if (index < text.length) {
                element.textContent += text.charAt(index);
                index++;
                setTimeout(type, 50);
            }
        }
        
        // Start typing when element is in view
        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    type();
                    observer.unobserve(entry.target);
                }
            });
        });
        
        observer.observe(element);
    });
}

// ===== COUNTERS =====
function initCounters() {
    const counters = $$('[data-counter]');
    
    counters.forEach(counter => {
        const target = parseInt(counter.getAttribute('data-counter'));
        const duration = 2000;
        const increment = target / (duration / 16);
        let current = 0;
        
        const updateCounter = () => {
            current += increment;
            if (current < target) {
                counter.textContent = Math.floor(current);
                requestAnimationFrame(updateCounter);
            } else {
                counter.textContent = target;
            }
        };
        
        // Start counting when element is in view
        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    updateCounter();
                    observer.unobserve(entry.target);
                }
            });
        });
        
        observer.observe(counter);
    });
}

// ===== SCROLL REVEAL =====
function initScrollReveal() {
    const reveals = $$('[data-reveal]');
    
    reveals.forEach(element => {
        const direction = element.getAttribute('data-reveal') || 'bottom';
        const distance = element.getAttribute('data-distance') || '50px';
        
        element.style.opacity = '0';
        element.style.transition = 'all 0.8s ease-out';
        
        switch (direction) {
            case 'left':
                element.style.transform = `translateX(-${distance})`;
                break;
            case 'right':
                element.style.transform = `translateX(${distance})`;
                break;
            case 'top':
                element.style.transform = `translateY(-${distance})`;
                break;
            default:
                element.style.transform = `translateY(${distance})`;
        }
        
        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    element.style.opacity = '1';
                    element.style.transform = 'translate(0)';
                    observer.unobserve(entry.target);
                }
            });
        }, { threshold: 0.1 });
        
        observer.observe(element);
    });
}

// ===== NOTIFICATIONS =====
function showNotification(message, type = 'info') {
    const notification = document.createElement('div');
    notification.className = `notification notification-${type}`;
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: ${type === 'success' ? '#00b894' : type === 'error' ? '#d63031' : '#00d2d3'};
        color: white;
        padding: 1rem 1.5rem;
        border-radius: 10px;
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.2);
        z-index: 3000;
        opacity: 0;
        transform: translateX(100%);
        transition: all 0.3s ease;
        max-width: 300px;
    `;
    
    notification.textContent = message;
    document.body.appendChild(notification);
    
    // Animate in
    setTimeout(() => {
        notification.style.opacity = '1';
        notification.style.transform = 'translateX(0)';
    }, 10);
    
    // Remove after 3 seconds
    setTimeout(() => {
        notification.style.opacity = '0';
        notification.style.transform = 'translateX(100%)';
        setTimeout(() => {
            notification.remove();
        }, 300);
    }, 3000);
}

// ===== UTILITY FUNCTIONS =====
function smoothScroll(target) {
    document.querySelector(target).scrollIntoView({
        behavior: 'smooth'
    });
}

function formatDate(date) {
    const options = { year: 'numeric', month: 'long', day: 'numeric' };
    return new Date(date).toLocaleDateString(undefined, options);
}

function formatTime(date) {
    const options = { hour: '2-digit', minute: '2-digit' };
    return new Date(date).toLocaleTimeString(undefined, options);
}

// Export functions for global use
window.BroCodeApp = {
    showNotification,
    smoothScroll,
    formatDate,
    formatTime
};
