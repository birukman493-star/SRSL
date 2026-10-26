// BroCode Dark Theme - Modern Student Management System JavaScript

// Immediate Theme Application (Prevent White Flash)
(function () {
    const savedTheme = localStorage.getItem('theme') || 'light';
    document.documentElement.setAttribute('data-theme', savedTheme);
    if (savedTheme === 'dark') {
        document.documentElement.classList.add('dark');
    }
})();

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
document.addEventListener('DOMContentLoaded', function () {
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
    initDashboardSidebar();
    
    // Initialize Socket.io client safely for real-time attendance updates
    if (typeof io !== 'undefined') {
        const socket = io({
            query: {
                userId: window.currentUser?.id,
                role: window.currentUser?.role
            }
        });

        // Debug check (MANDATORY) - Add temporary global event logger
        socket.onAny((event, data) => {
            console.log("SOCKET EVENT:", event, data);
        });

        // Initialize role-based Socket.io listeners for real-time attendance updates
        socket.on('attendanceHistoryUpdated', (data) => {
            console.log("RECEIVED HISTORY UPDATE:", data);
            if (typeof updateTeacherAttendance === 'function') {
                updateTeacherAttendance(data);
            }
            if (typeof updateAdminDashboard === 'function') {
                updateAdminDashboard(data);
            }
        });

        socket.on('academicContextUpdated', (data) => {
            if (!data) return;
            document.querySelectorAll('.academic-year-display').forEach((el) => {
                if (data.academicYear) el.textContent = data.academicYear;
            });
            document.querySelectorAll('.semester-display').forEach((el) => {
                if (data.semesterLabel) el.textContent = data.semesterLabel;
            });
            document.querySelectorAll('.academic-context-banner').forEach((banner) => {
                if (data.academicYear) banner.dataset.academicYear = data.academicYear;
                if (data.semester) banner.dataset.semester = data.semester;
                if (data.semesterLabel) banner.dataset.semesterLabel = data.semesterLabel;
            });
        });

        socket.on('semesterChanged', (data) => {
            console.log("SEMESTER CHANGED GLOBALLY:", data);
            window.location.reload();
        });

        socket.on('semesterUpdated', (data) => {
            if (data?.semesterLabel) {
                document.querySelectorAll('.semester-display').forEach((el) => {
                    el.textContent = data.semesterLabel;
                });
            }
        });

        socket.on('academicYearUpdated', (data) => {
            if (data?.academicYear) {
                document.querySelectorAll('.academic-year-display').forEach((el) => {
                    el.textContent = data.academicYear;
                });
            }
        });

        socket.on('gradeUpdated', () => {
            if (document.querySelector('[data-reload-on-grade-update]')) {
                window.location.reload();
            }
        });

        socket.on('studentAttendanceUpdated', (data) => {
            console.log("RECEIVED ATTENDANCE UPDATE:", data);
            
            // Search for premium card by primary key, registration ID, or studentUserId
            let card = document.querySelector(`.premium-card[data-student-id="${data.studentId}"]`) || 
                       document.querySelector(`.premium-card[data-student-id="${data.studentRegId}"]`);
            
            if (card) {
                updateAttendanceCard(card, data);
            } else {
                updateAttendanceCard(data);
            }
            
            // Admin dashboard: globally show a quick toast
            if (window.currentUser?.role === 'admin') {
                showAdminAttendanceToast(data);
            }
        });

        // Helper for Admin Dashboard Global Analytics Stream
        function showAdminAttendanceToast(data) {
            if (!document.querySelector('.dashboard-title')) return; // Ensure we are on a dashboard
            let toastContainer = document.getElementById('toast-container');
            if (!toastContainer) {
                toastContainer = document.createElement('div');
                toastContainer.id = 'toast-container';
                toastContainer.className = 'toast-container position-fixed bottom-0 end-0 p-3';
                toastContainer.style.zIndex = '9999';
                document.body.appendChild(toastContainer);
            }
            const toast = document.createElement('div');
            toast.className = 'toast show align-items-center text-white bg-dark border-0 mb-2 shadow-lg';
            toast.style.borderRadius = '12px';
            toast.innerHTML = `
                <div class="d-flex">
                    <div class="toast-body d-flex align-items-center gap-2">
                        <span class="badge ${data.status === 'present' ? 'bg-success' : (data.status === 'absent' ? 'bg-danger' : 'bg-warning')} shadow-xs">${data.status.toUpperCase()}</span>
                        <span><strong>Student ID ${data.studentRegId || data.studentId}</strong> recorded in ${data.subject}</span>
                    </div>
                    <button type="button" class="btn-close btn-close-white me-2 m-auto" onclick="this.parentElement.parentElement.remove()"></button>
                </div>
            `;
            toastContainer.appendChild(toast);
            setTimeout(() => toast.remove(), 5000);
        }
    }

    // Helper to update a student's attendance card dynamically using single socket payload
    function updateAttendanceCard(card, data) {
        // Support both (card, data) and (data) signatures
        if (!data && card) {
            data = card;
            card = null;
        }
        if (!data) return;

        const { studentId, studentRegId, totalPresent, totalAbsent, subject, status } = data;
        
        if (!card) {
            card = document.querySelector(`.premium-card[data-student-id="${studentId}"]`) ||
                   document.querySelector(`.premium-card[data-student-id="${studentRegId}"]`);
        }
        if (!card) return;
        
        let attendanceRate = '100';
        const total = totalPresent + totalAbsent;
        if (total > 0) {
            attendanceRate = ((totalPresent / total) * 100).toFixed(1);
        }

        // Find the percentage element and update it
        const rateEls = card.querySelectorAll('.text-primary, .global-attendance-rate');
        rateEls.forEach(el => {
            if (el.textContent.includes('%') || el.classList.contains('h3')) {
                if (el.textContent.trim().endsWith('%') || el.nextElementSibling?.textContent.includes('Attendance') || el.classList.contains('global-attendance-rate')) {
                    el.textContent = `${attendanceRate}%`;
                }
            }
        });

        // Add/update specific teacher attendance entry
        const container = card.querySelector('.teacher-attendance-container');
        if (container && subject) {
            let subjectRow = container.querySelector(`[data-subject="${subject}"]`);
            if (!subjectRow) {
                subjectRow = document.createElement('div');
                subjectRow.dataset.subject = subject;
                subjectRow.className = 'd-flex justify-content-between align-items-center bg-white p-2 rounded shadow-sm border border-opacity-10 transition hover-scale';
                container.appendChild(subjectRow);
            }
            
            let badgeClass = 'bg-secondary';
            if (status === 'present') badgeClass = 'bg-success bg-opacity-10 text-success border border-success border-opacity-25';
            else if (status === 'absent') badgeClass = 'bg-danger bg-opacity-10 text-danger border border-danger border-opacity-25';
            else if (status === 'late') badgeClass = 'bg-warning bg-opacity-10 text-warning border border-warning border-opacity-25';
            else if (status === 'excused') badgeClass = 'bg-info bg-opacity-10 text-info border border-info border-opacity-25';
            
            subjectRow.innerHTML = `
                <span class="small fw-800 text-dark"><i class="fas fa-book me-2 opacity-50"></i>${subject}</span>
                <span class="badge ${badgeClass} text-uppercase shadow-xs" style="font-size: 0.65rem; letter-spacing: 0.5px;">${status}</span>
            `;
        }
    }
    // initPageTransitions(); // Disabled for blazing fast native performance
}


// ===== NAVIGATION =====
function initNavigation() {
    const navbar = $('.navbar');
    const navLinks = $$('.navbar .navbar-nav .nav-link');
    const toggler = $('.navbar-toggler');
    const collapse = $('.navbar-collapse');

    const normalizePath = (path) => path.replace(/\/+$/, '') || '/';
    const currentPath = normalizePath(window.location.pathname);

    navLinks.forEach((link) => {
        link.classList.remove('active');
        link.removeAttribute('aria-current');

        const href = link.getAttribute('href');
        if (!href || href.startsWith('#')) return;

        const target = new URL(href, window.location.origin);
        if (target.origin === window.location.origin && normalizePath(target.pathname) === currentPath) {
            link.classList.add('active');
            link.setAttribute('aria-current', 'page');
        }
    });

    // Navbar scroll effect
    const handleScroll = () => {
        if (!navbar) return;
        if (window.scrollY > 50) {
            navbar.classList.add('scrolled');
        } else {
            navbar.classList.remove('scrolled');
        }
    };


    window.addEventListener('scroll', handleScroll);
    handleScroll(); // Initialize on load

    // Custom Toggler Logic — right-side slide panel
    if (toggler && collapse) {
        // Create overlay for when menu is open
        let navOverlay = document.getElementById('nav-overlay');
        if (!navOverlay) {
            navOverlay = document.createElement('div');
            navOverlay.id = 'nav-overlay';
            navOverlay.style.cssText = `
                display: none;
                position: fixed;
                inset: 0;
                background: rgba(0, 0, 0, 0.5);
                z-index: 1140;
                transition: opacity 0.3s ease;
                opacity: 0;
            `;
            document.body.appendChild(navOverlay);
        }

        function openNav() {
            toggler.classList.add('active');
            collapse.classList.add('show');
            document.body.style.overflow = 'hidden';
            navOverlay.style.display = 'block';
            requestAnimationFrame(() => navOverlay.style.opacity = '1');
        }

        function closeNav() {
            toggler.classList.remove('active');
            collapse.classList.remove('show');
            document.body.style.overflow = '';
            navOverlay.style.opacity = '0';
            setTimeout(() => navOverlay.style.display = 'none', 300);
        }

        toggler.addEventListener('click', () => {
            collapse.classList.contains('show') ? closeNav() : openNav();
        });

        navOverlay.addEventListener('click', closeNav);

        // Close menu on nav link click
        navLinks.forEach(link => {
            link.addEventListener('click', () => closeNav());
        });
    }
    // Language selector logic and Google Translate Integration
    const langDropdown = $('#languageDropdown');
    const langItems = $$('.glass-dropdown .dropdown-item');

    // Inject Google Translate script dynamically
    if (!document.getElementById('google-translate-script')) {
        const gtScript = document.createElement('script');
        gtScript.id = 'google-translate-script';
        gtScript.src = '//translate.google.com/translate_a/element.js?cb=googleTranslateElementInit';
        document.body.appendChild(gtScript);

        const gtWidget = document.createElement('div');
        gtWidget.id = 'google_translate_element';
        gtWidget.style.display = 'none'; // Hide the default widget
        document.body.appendChild(gtWidget);

        window.googleTranslateElementInit = function () {
            new google.translate.TranslateElement({
                pageLanguage: 'en',
                includedLanguages: 'en,am,om',
                autoDisplay: false
            }, 'google_translate_element');
        };
    }

    // Function to firmly set language via DOM trigger
    function triggerTranslation(langCode) {
        const gtSelect = document.querySelector('.goog-te-combo');
        if (gtSelect) {
            gtSelect.value = langCode;
            // Native dispatch is required for Google Translate to pick up the change
            gtSelect.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        }

        // Update Map Language if it exists
        const campusMap = document.getElementById('campusMap');
        if (campusMap) {
            const baseUrl = 'https://www.google.com/maps?q=Jimma+Institute+of+Technology&output=embed';
            campusMap.src = `${baseUrl}&hl=${langCode}`;
        }
    }

    if (langDropdown && langItems.length) {
        langItems.forEach(item => {
            item.addEventListener('click', (e) => {
                e.preventDefault();
                const langCode = item.getAttribute('href').split('=')[1].toLowerCase();
                const displayCode = langCode.toUpperCase();

                langDropdown.innerHTML = `<i class="fas fa-globe"></i> ${displayCode}`;
                localStorage.setItem('preferred_lang', langCode);

                // If it's English, clear cookies to revert to original
                if (langCode === 'en') {
                    document.cookie = 'googtrans=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;';
                    document.cookie = 'googtrans=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/; domain=' + window.location.hostname + ';';
                    window.location.reload();
                    return;
                }

                // Try to trigger immediately
                triggerTranslation(langCode);
            });
        });

        // Update the UI button based on the saved language
        const savedLang = localStorage.getItem('preferred_lang');
        if (savedLang) {
            langDropdown.innerHTML = `<i class="fas fa-globe"></i> ${savedLang.toUpperCase()}`;

            // If we have a saved lang that isn't English, we must trigger it when the script loads
            if (savedLang !== 'en') {
                // Poll until the combo box exists, then trigger
                const checkExist = setInterval(function () {
                    if (document.querySelector('.goog-te-combo')) {
                        triggerTranslation(savedLang);
                        clearInterval(checkExist);
                    }
                }, 100);

                // Update map immediately even if google translate isn't ready
                setTimeout(() => {
                    const campusMap = document.getElementById('campusMap');
                    if (campusMap) {
                        campusMap.src = `https://www.google.com/maps?q=Jimma+Institute+of+Technology&output=embed&hl=${savedLang}`;
                    }
                }, 500);
            }
        }
    }
}
    // ===== THEME MANAGEMENT =====
    function initTheme() {
        const html = document.documentElement;
        const body = document.body;
        const savedTheme = localStorage.getItem('theme') || 'light';

        // Apply theme immediately
        const applyTheme = (theme) => {
            html.setAttribute('data-theme', theme);
            if (theme === 'dark') {
                html.classList.add('dark');
                body.classList.add('dark');
            } else {
                html.classList.remove('dark');
                body.classList.remove('dark');
            }
            updateThemeIcon(theme);
        };

        applyTheme(savedTheme);

        document.addEventListener('click', (e) => {
            const toggle = e.target.closest('#themeToggle, .theme-toggle-btn');
            if (!toggle) return;

            e.preventDefault();
            const newTheme = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
            applyTheme(newTheme);
            localStorage.setItem('theme', newTheme);
            document.dispatchEvent(new CustomEvent('themeChanged', { detail: { theme: newTheme } }));
        });
    }

    function updateThemeIcon(theme) {
        const icons = $$('#themeToggle i, .theme-toggle-btn i');
        icons.forEach(icon => {
            if (theme === 'dark') {
                icon.className = 'fas fa-sun';
            } else {
                icon.className = 'fas fa-moon';
            }
        });
    }

    function createFloatingThemeToggle() {
        // Only create if not already present and not in a specialized view
        if ($('#themeToggle') || $('.theme-toggle-btn').length) return;

        const btn = document.createElement('button');
        btn.className = 'theme-toggle-btn shadow-lg';
        btn.id = 'themeToggle';
        btn.innerHTML = '<i class="fas fa-moon"></i>';
        btn.style.cssText = `
            position: fixed;
            bottom: 30px;
            right: 30px;
            width: 60px;
            height: 60px;
            border-radius: 50%;
            background: var(--gradient-1);
            color: white;
            border: none;
            cursor: pointer;
            z-index: 9999;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 1.5rem;
            box-shadow: 0 10px 25px rgba(37, 99, 235, 0.3);
            transition: all 0.3s ease;
        `;

        btn.onmouseover = () => btn.style.transform = 'scale(1.1) rotate(15deg)';
        btn.onmouseout = () => btn.style.transform = 'scale(1) rotate(0deg)';

        document.body.appendChild(btn);
    }

    // ===== SCROLL EFFECTS =====
    function initScrollEffects() {
        // Back to top button
        const backToTop = createBackToTopButton();
        document.body.appendChild(backToTop);

        let scrollUpdatePending = false;
        window.addEventListener('scroll', () => {
            if (scrollUpdatePending) return;
            scrollUpdatePending = true;
            requestAnimationFrame(() => {
                scrollUpdatePending = false;
                if (window.scrollY > 300) {
                    backToTop.style.opacity = '1';
                    backToTop.style.pointerEvents = 'auto';
                } else {
                    backToTop.style.opacity = '0';
                    backToTop.style.pointerEvents = 'none';
                }
            });
        }, { passive: true });
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
                behavior: 'auto'
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
            el.style.transition = 'opacity 0.35s ease-out, transform 0.35s ease-out';
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

        if (!roleCards.length || !userTypeInput || $('#registerForm')) return;

        roleCards.forEach(card => {
            card.addEventListener('click', function () {
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

        // Check if this is the registration or login form - let them submit natively and instantly
        if (form.id === 'registerForm' || form.id === 'loginForm') {
            // Don't prevent default, let the form submit natively for maximum speed
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
                <div class="mobile-nav-logo">
                        <i class="fas fa-graduation-cap"></i>
                        <span>Abdigudina ES</span>
                    </div>
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

        const observerOptions = {
            threshold: 0.15,
            rootMargin: '0px 0px -50px 0px'
        };

        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    entry.target.classList.add('revealed');
                    observer.unobserve(entry.target);
                }
            });
        }, observerOptions);

        reveals.forEach(element => {
            const direction = element.getAttribute('data-reveal') || 'bottom';
            const distance = element.getAttribute('data-distance') || '30px';
            const delay = element.getAttribute('data-delay') || '0s';

            element.style.opacity = '0';
            element.style.transition = `opacity 0.35s ease ${delay}, transform 0.35s ease ${delay}`;

            let transformValue = '';
            switch (direction) {
                case 'left': transformValue = `translateX(-${distance})`; break;
                case 'right': transformValue = `translateX(${distance})`; break;
                case 'top': transformValue = `translateY(-${distance})`; break;
                default: transformValue = `translateY(${distance})`;
            }

            element.style.transform = `${transformValue} scale(0.98)`;
            observer.observe(element);
        });

        // Add CSS for revealed state if not already in stylesheet
        if (!document.getElementById('reveal-styles')) {
            const style = document.createElement('style');
            style.id = 'reveal-styles';
            style.textContent = `
            [data-reveal].revealed {
                opacity: 1 !important;
                transform: translate(0) scale(1) !important;
            }
        `;
            document.head.appendChild(style);
        }
    }

    // ===== UTILITY FUNCTIONS =====
    // ===== PAGE TRANSITIONS (SPA SIMULATION) =====
    function initPageTransitions() {
        const wrapper = $('.page-transition-wrapper');
        if (!wrapper) return;

        // Handle back/forward buttons
        window.addEventListener('popstate', (e) => {
            loadPage(window.location.pathname, false);
        });

        // Intercept internal links
        document.addEventListener('click', (e) => {
            const link = e.target.closest('a');
            if (!link) return;

            const href = link.getAttribute('href');
            if (!href) return;

            // Only handle internal links that aren't anchors or external
            if (href.startsWith('/') && !href.startsWith('//') && !link.hasAttribute('data-no-transition')) {
                e.preventDefault();
                loadPage(href);
            }
        });
    }

    async function loadPage(url, push = true) {
        const wrapper = $('.page-transition-wrapper');
        if (!wrapper) return;

        // Start fade out
        wrapper.classList.add('fade-out');

        // Wait for animation
        await new Promise(resolve => setTimeout(resolve, 400));

        try {
            const response = await fetch(url);
            const html = await response.text();

            // Parse new HTML
            const parser = new DOMParser();
            const newDoc = parser.parseFromString(html, 'text/html');
            const newContent = newDoc.querySelector('.page-transition-wrapper');
            const newTitle = newDoc.title;

            if (newContent) {
                // Update content and title
                wrapper.innerHTML = newContent.innerHTML;
                document.title = newTitle;

                if (push) {
                    window.history.pushState({}, '', url);
                }

                // Scroll to top
                window.scrollTo(0, 0);

                // Re-initialize app logic for new content
                reInitializeContent();

                // Fade in
                wrapper.classList.remove('fade-out');
                wrapper.classList.add('fade-in');
                setTimeout(() => wrapper.classList.remove('fade-in'), 600);

                // Update active state in navbar
                updateActiveLink(url);
            } else {
                // Fallback for pages without wrapper
                window.location.href = url;
            }
        } catch (err) {
            console.error('Failed to load page:', err);
            window.location.href = url;
        }
    }

    function reInitializeContent() {
        // Re-run initializations that depend on DOM content
        initAnimations();
        initFormValidation();
        initGallery();
        initTypingEffect();
        initCounters();
        initScrollReveal();
        // Re-check scroll position for navbar
        if (window.scrollY > 50) {
            $('.navbar').classList.add('scrolled');
        } else {
            $('.navbar').classList.remove('scrolled');
        }
    }

    function updateActiveLink(url) {
        $$('.nav-link').forEach(link => {
            const href = link.getAttribute('href');
            if (href === url || (url === '/' && href === '/')) {
                link.classList.add('active');
            } else {
                link.classList.remove('active');
            }
        });
    }

// Keep in-page navigation immediate so anchor clicks respond without a long scroll animation.
document.addEventListener('click', (e) => {
    const anchor = e.target.closest('a');
    if (anchor && anchor.hash && anchor.origin === window.location.origin) {
        const target = document.querySelector(anchor.hash);
        if (target) {
            e.preventDefault();
            smoothScroll(anchor.hash);
        }
    }
});

function smoothScroll(target) {
    const element = typeof target === 'string' ? document.querySelector(target) : target;
    if (!element) return;

    window.scrollTo({
        top: element.getBoundingClientRect().top + window.scrollY - 80,
        behavior: 'auto'
    });
}

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

    setTimeout(() => {
        notification.style.opacity = '1';
        notification.style.transform = 'translateX(0)';
    }, 10);

    setTimeout(() => {
        notification.style.opacity = '0';
        notification.style.transform = 'translateX(100%)';
        setTimeout(() => notification.remove(), 300);
    }, 3000);
}

function formatDate(date) {
    const options = { year: 'numeric', month: 'long', day: 'numeric' };
    return new Date(date).toLocaleDateString(undefined, options);
}

function formatTime(date) {
    const options = { hour: '2-digit', minute: '2-digit' };
    return new Date(date).toLocaleTimeString(undefined, options);
}

// ===== OFFLINE TRANSLATION SYSTEM =====
const translations = {
    'en': {
        'dashboard': 'Dashboard',
        'attendance': 'Attendance',
        'grades': 'Academic Records',
        'rankings': 'Rankings',
        'students': 'Students',
        'teachers': 'Teachers',
        'parents': 'Parents',
        'users': 'User Management',
        'courses': 'Course Catalog',
        'settings': 'System Settings',
        'logout': 'Logout',
        'welcome': 'Welcome Back',
        'system_status': 'System Status',
        'online': 'Online',
        'offline': 'Offline (Local)',
        'search_placeholder': 'Search student name or ID...',
        'apply_filters': 'Apply Filters',
        'clear': 'Clear',
        'all_grades': 'All Elementary Grades',
        'export': 'Export Report',
        // Front Page Strings
        'home': 'Home',
        'about': 'About',
        'gallery': 'Gallery',
        'contact': 'Contact',
        'login': 'Login',
        'welcome_title': 'Welcome to Abdigudina Elementary School',
        'hero_subtitle': 'Empowering Education Through Modern Technology',
        'get_started': 'Get Started',
        'learn_more': 'Learn More',
        'powerful_features': 'Powerful Features',
        'features_subtitle': 'Everything you need for modern education management packed into one beautiful, intelligent interface.',
        'student_portal': 'Student Portal',
        'teacher_dashboard': 'Teacher Dashboard',
        'analytics_engine': 'Analytics Engine',
        'secure_platform': 'Secure Platform',
        'mobile_responsive': 'Mobile Responsive',
        'easy_config': 'Easy Configuration'
    },
    'am': {
        'dashboard': 'ዳሽቦርድ',
        'attendance': 'የተማሪዎች መገኘት',
        'grades': 'የትምህርት ውጤቶች',
        'rankings': 'ደረጃዎች',
        'students': 'ተማሪዎች',
        'teachers': 'መምህራን',
        'parents': 'ወላጆች',
        'users': 'የተጠቃሚዎች አስተዳደር',
        'courses': 'የትምህርት አይነቶች',
        'settings': 'ቅንብሮች',
        'logout': 'ውጣ',
        'welcome': 'እንኳን ደህና መጡ',
        'system_status': 'የስርዓት ሁኔታ',
        'online': 'ኦንላይን',
        'offline': 'ከመስመር ውጭ',
        'search_placeholder': 'ተማሪ በስም ወይም በመታወቂያ ይፈልጉ...',
        'apply_filters': 'አጣራ',
        'clear': 'አጽዳ',
        'all_grades': 'ሁሉም ክፍሎች',
        'export': 'መረጃ አውጣ',
        // Front Page Strings
        'home': 'መነሻ',
        'about': 'ስለ እኛ',
        'gallery': 'ጋለሪ',
        'contact': 'እውቂያ',
        'login': 'ግባ',
        'welcome_title': 'እንኳን ወደ አብዲጉዲና የመጀመሪያ ደረጃ ትምህርት ቤት በሰላም መጡ',
        'hero_subtitle': 'ዘመናዊ ቴክኖሎጂን በመጠቀም ትምህርትን ማሳደግ',
        'get_started': 'ይጀምሩ',
        'learn_more': 'ተጨማሪ መረጃ',
        'powerful_features': 'ታላላቅ አገልግሎቶች',
        'features_subtitle': 'ለዘመናዊ የትምህርት አስተዳደር የሚያስፈልጉዎትን ነገሮች ሁሉ በአንድ ቦታ ያገኛሉ።',
        'student_portal': 'የተማሪዎች ፖርታል',
        'teacher_dashboard': 'የመምህራን ዳሽቦርድ',
        'analytics_engine': 'የመረጃ ትንተና',
        'secure_platform': 'ደህንነቱ የተጠበቀ',
        'mobile_responsive': 'በሞባይል የሚሰራ',
        'easy_config': 'ቀላል አጠቃቀም'
    },
    'om': {
        'dashboard': 'Daashboordii',
        'attendance': 'Hirmaannaa',
        'grades': 'Galmeewwan Barnootaa',
        'rankings': 'Sadarkaa',
        'students': 'Barattoota',
        'teachers': 'Barsiisota',
        'parents': 'Maatii',
        'users': 'Bulchiinsa Fayyadamtootaa',
        'courses': 'Kataaloogii Koorsii',
        'settings': 'Settiingii',
        'logout': 'Ba\'uu',
        'welcome': 'Baga Nagaan Dhuftan',
        'system_status': 'Haala Sirnaa',
        'online': 'Onlaayin',
        'offline': 'Oflaayin',
        'search_placeholder': 'Maqaa ykn ID barataa barbaadi...',
        'apply_filters': 'Sifayi',
        'clear': 'Qulqulleessi',
        'all_grades': 'Kilaasota Hundumaa',
        'export': 'Gabaasa Baasi',
        // Front Page Strings
        'home': 'Fuula Duraa',
        'about': 'Waa\'ee Keenya',
        'gallery': 'Gaalarii',
        'contact': 'Quunnama',
        'login': 'Seeni',
        'welcome_title': 'Baga Gara Mana Barumsaa Sadarkaa Tokkoffaa Abdiigudiinaatti Nagaan Dhufte',
        'hero_subtitle': 'Teknooloojii Ammayyaatti Fayyadamuun Barnoota Humneessuu',
        'get_started': 'Eegali',
        'learn_more': 'Bal\'inaan Hubadhu',
        'powerful_features': 'Tajaajila Ciccimoo',
        'features_subtitle': 'Waan bulchiinsa barnootaa ammayyaaf isin barbaachisu hundumaa iddoo tokkotti argattu.',
        'student_portal': 'Poortaalii Barataa',
        'teacher_dashboard': 'Daashboordii Barsiisaa',
        'analytics_engine': 'Injiinii Xiinxalaa',
        'secure_platform': 'Sirna Amansiisaa',
        'mobile_responsive': 'Moobaayilaan Kan Hojjetu',
        'easy_config': 'Qindaa\'ina Salphaa'
    }
};

// Export functions for global use
window.BroCodeApp = {
    showNotification,
    smoothScroll,
    formatDate,
    formatTime
};

// ===== DASHBOARD MOBILE SIDEBAR =====
function initDashboardSidebar() {
    const sidebar = document.querySelector('.glass-sidebar');
    if (!sidebar) return; // Only runs on dashboard pages

    // Create dark overlay
    const overlay = document.createElement('div');
    overlay.id = 'sidebar-overlay';
    overlay.style.cssText = `
        display: none;
        position: fixed;
        inset: 0;
        background: rgba(0,0,0,0.55);
        z-index: 998;
        backdrop-filter: blur(2px);
        -webkit-backdrop-filter: blur(2px);
        transition: opacity 0.3s ease;
        opacity: 0;
    `;
    document.body.appendChild(overlay);

    // Create mobile navbar container (Logo + Toggler)
    const mobileNav = document.createElement('div');
    mobileNav.className = 'dashboard-mobile-nav d-lg-none notranslate';
    mobileNav.innerHTML = `
        <a href="/" class="navbar-brand" style="color: var(--primary-color) !important; font-weight: 700; font-size: 1.4rem; display: flex; align-items: center; gap: 10px; text-decoration: none;">
            <i class="fas fa-graduation-cap"></i>
            Abdigudina ES
        </a>
        <button id="sidebar-toggle" class="sidebar-toggle-btn" aria-label="Open Navigation">
            <span></span>
            <span></span>
            <span></span>
        </button>
    `;
    
    // Insert mobile nav at the top of the body
    document.body.insertBefore(mobileNav, document.body.firstChild);
    
    const toggleBtn = mobileNav.querySelector('#sidebar-toggle');

    function openSidebar() {
        sidebar.classList.add('active');
        overlay.style.display = 'block';
        requestAnimationFrame(() => overlay.style.opacity = '1');
        document.body.style.overflow = 'hidden';
        toggleBtn.setAttribute('aria-label', 'Close Navigation');
        toggleBtn.classList.add('open');
    }

    function closeSidebar() {
        sidebar.classList.remove('active');
        overlay.style.opacity = '0';
        setTimeout(() => { overlay.style.display = 'none'; }, 300);
        document.body.style.overflow = '';
        toggleBtn.setAttribute('aria-label', 'Open Navigation');
        toggleBtn.classList.remove('open');
    }

    toggleBtn.addEventListener('click', () => {
        sidebar.classList.contains('active') ? closeSidebar() : openSidebar();
    });

    overlay.addEventListener('click', closeSidebar);

    // In-sidebar close button (×)
    const closeBtn = sidebar.querySelector('#sidebar-close');
    if (closeBtn) closeBtn.addEventListener('click', closeSidebar);

    // Close on nav link click on mobile
    sidebar.querySelectorAll('.sidebar-nav-link').forEach(link => {
        link.addEventListener('click', () => {
            if (window.innerWidth <= 1024) closeSidebar();
        });
    });

    // Re-open properly on resize
    window.addEventListener('resize', () => {
        if (window.innerWidth > 1024) {
            closeSidebar();
            overlay.style.display = 'none';
            document.body.style.overflow = '';
        }
    });

    // Touch swipe left to close
    let touchStartX = 0;
    sidebar.addEventListener('touchstart', e => { touchStartX = e.touches[0].clientX; }, { passive: true });
    sidebar.addEventListener('touchend', e => {
        if (e.changedTouches[0].clientX - touchStartX < -60) closeSidebar();
    }, { passive: true });
}
