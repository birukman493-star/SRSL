const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { pool } = require('../config/db');
const { getSettings } = require('../config/settingsControl');
const rateLimit = require('express-rate-limit');
const router = express.Router();

// ── Email transporter (Nodemailer) ──────────────────────────────────────────
let nodemailer;
try { nodemailer = require('nodemailer'); } catch (e) { nodemailer = null; }

function createTransport() {
  if (!nodemailer) return null;
  const host = process.env.EMAIL_HOST;
  const user = process.env.EMAIL_USER;
  const pass = process.env.EMAIL_PASS;
  // Bail out if any credential is still a placeholder
  if (!host || !user || !pass ||
      user === 'your-email@gmail.com' ||
      pass === 'your-app-password') {
    return null;
  }
  return nodemailer.createTransport({
    host,
    port: parseInt(process.env.EMAIL_PORT || '587', 10),
    secure: process.env.EMAIL_PORT === '465',
    auth: { user, pass },
    tls: { rejectUnauthorized: false }
  });
}

// ── Rate limiter: max 5 requests in prod, 100 in dev per 15 min per IP ─────
const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'production' ? 5 : 100,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    return res.redirect('/auth/forgot-password?error=Too many requests. Please wait 15 minutes before trying again.');
  }
});

// ── Helper: hash a raw token for DB storage ─────────────────────────────────
function hashToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

// --- Dedicated Multer Configuration for Self-Registered Student Documents ---
const studentStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    let dir = './public/uploads/students';
    if (file.fieldname === 'previousTranscript') {
      dir = './public/uploads/transcripts';
    }
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    let prefix = 'student-';
    if (file.fieldname === 'previousTranscript') prefix = 'transcript-';
    cb(null, prefix + uniqueSuffix + path.extname(file.originalname));
  }
});

const uploadStudent = multer({
  storage: studentStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    const filetypes = /jpeg|jpg|png|webp|pdf/;
    const mimetype = filetypes.test(file.mimetype);
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
    if (mimetype && extname) return cb(null, true);
    cb(new Error('Only images (jpeg, jpg, png, webp) and PDF files are allowed'));
  }
});



// GET /auth/login - Show login form
router.get('/login', (req, res) => {
  res.render('login-modern', {
    title: 'Login - Student Registration System',
    error: null
  });
});

// POST /auth/login - Handle login
router.post('/login', async (req, res) => {
  const logFile = path.join(__dirname, '../tmp/auth_access.log');
  const log = (msg) => {
    const timestamp = new Date().toISOString();
    try {
      const logDir = path.dirname(logFile);
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }
      fs.appendFileSync(logFile, `[${timestamp}] ${msg}\n`);
    } catch (e) { }
    console.log(msg);
  };

  try {
    log('Login attempt: ' + JSON.stringify({ username: req.body.username, role: req.body.role }));

    const { username, password } = req.body;

    // Validate input
    if (!username || !password) {
      log('Missing fields: ' + JSON.stringify({ username: !!username, password: !!password }));
      return res.render('login-modern', {
        title: 'Login - Student Registration System',
        error: 'Username and password are required'
      });
    }

    // Find user by username or email
    const [users] = await pool.execute(
      'SELECT * FROM users WHERE username = ? OR email = ?',
      [username, username]
    );

    if (users.length === 0) {
      log('No user found for ' + username);
      return res.render('login-modern', {
        title: 'Login - Student Registration System',
        error: 'Invalid username or password'
      });
    }

    const user = users[0];
    log('User found: ' + JSON.stringify({ id: user.id, username: user.username, role: user.role }));

    // Check if user is active
    if (!user.is_active) {
      log('User is inactive: ' + username);
      return res.render('login-modern', {
        title: 'Login - Student Registration System',
        error: 'Your account has been deactivated. Please contact administrator.'
      });
    }

    // Verify password
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      log('Invalid password for ' + username);
      return res.render('login-modern', {
        title: 'Login - Student Registration System',
        error: 'Invalid username or password'
      });
    }


    const role = String(user.role || '').trim().toLowerCase();
    const dashboardByRole = {
      admin: '/admin/dashboard',
      student: '/student/dashboard',
      teacher: '/teacher/dashboard',
      parent: '/parent/dashboard'
    };
    const dashboardPath = dashboardByRole[role];
    if (!dashboardPath) {
      log('Unsupported account role for ' + user.username + ': ' + role);
      return res.status(403).render('login-modern', {
        title: 'Login - Student Registration System',
        error: 'This account role is not configured. Please contact the administrator.'
      });
    }

    await new Promise((resolve, reject) => {
      req.session.regenerate((error) => error ? reject(error) : resolve());
    });

    req.session.user = {
      id: user.id,
      username: user.username,
      email: user.email,
      first_name: user.first_name,
      last_name: user.last_name,
      role,
      profile_picture: user.profile_picture
    };

    await new Promise((resolve, reject) => {
      req.session.save((error) => error ? reject(error) : resolve());
    });

    log('Session saved for ' + user.username + '. Redirecting to ' + dashboardPath);
    return res.redirect(dashboardPath);

  } catch (error) {
    log('Login error: ' + error.message);
    res.render('login-modern', {
      title: 'Login - Student Registration System',
      error: 'An error occurred during login. Please try again.'
    });
  }
});

// GET /auth/register - Show registration form
router.get('/register', (req, res) => {
  const settings = getSettings();
  if (!settings.publicRegistrationEnabled) {
    return res.render('login-modern', {
      title: 'Login - Student Registration System',
      error: 'Public registration is currently closed. Please contact the administrator.'
    });
  }

  res.render('register-modern', {
    title: 'Register - Student Registration System',
    error: null
  });
});

// POST /auth/register - Handle registration staging (Admin Approval Workflow)
router.post('/register', uploadStudent.fields([
  { name: 'studentPhoto', maxCount: 1 },
  { name: 'previousTranscript', maxCount: 5 }
]), async (req, res) => {
  const settings = getSettings();
  if (!settings.publicRegistrationEnabled) {
    return res.status(403).send('Public registration is currently closed.');
  }

  try {
    console.log('=== STAGED REGISTRATION START ===');
    const {
      userType, firstName, lastName, email, phone, username,
      studentId, grade, section, parentGuardianName, dateOfBirth, gender,
      address, previousSchool, admission_type, transfer_date, transfer_reason,
      occupation, relationship,
      password, confirmPassword, terms
    } = req.body;
    console.log('Registration request received for role:', userType);

    // 1. Role Control & Validation
    if (userType !== 'student' && userType !== 'parent') {
      console.log('❌ Invalid registration role attempted:', userType);
      return res.render('register-modern', {
        title: 'Register - Student Registration System',
        error: 'Registration is only open to Students and Parents. Teachers and Administrators must be created by the system.',
        success: null
      });
    }

    // Validate required fields
    if (!userType || !firstName || !lastName || !email || !username || !password || !confirmPassword) {
      console.log('❌ Missing required fields');
      return res.render('register-modern', {
        title: 'Register - Student Registration System',
        error: 'All required core fields must be filled',
        success: null
      });
    }

    // Validate terms acceptance
    if (!terms) {
      console.log('❌ Terms not accepted');
      return res.render('register-modern', {
        title: 'Register - Student Registration System',
        error: 'You must accept the terms and conditions',
        success: null
      });
    }

    // Validate password match
    if (password !== confirmPassword) {
      console.log('❌ Passwords do not match');
      return res.render('register-modern', {
        title: 'Register - Student Registration System',
        error: 'Passwords do not match',
        success: null
      });
    }

    // Validate password strength
    if (password.length < 8) {
      console.log('❌ Password too short');
      return res.render('register-modern', {
        title: 'Register - Student Registration System',
        error: 'Password must be at least 8 characters long',
        success: null
      });
    }

    // Validate role-specific fields
    if (userType === 'student') {
      const gradeLevel = parseInt(grade);
      if (!gradeLevel || gradeLevel < 1 || gradeLevel > 8) {
        console.log('❌ Invalid grade level:', grade);
        return res.render('register-modern', {
          title: 'Register - Student Registration System',
          error: 'Student grade level must be between 1 and 8',
          success: null
        });
      }
      if (!section) {
        return res.render('register-modern', {
          title: 'Register - Student Registration System',
          error: 'Please select a Class Section',
          success: null
        });
      }
      if (!dateOfBirth) {
        return res.render('register-modern', {
          title: 'Register - Student Registration System',
          error: 'Date of Birth is required for students',
          success: null
        });
      }
      if (!parentGuardianName) {
        return res.render('register-modern', {
          title: 'Register - Student Registration System',
          error: 'Parent / Guardian Name is required for students',
          success: null
        });
      }
      if (admission_type === 'transfer' && !previousSchool) {
        return res.render('register-modern', {
          title: 'Register - Student Registration System',
          error: 'Previous School is required for transfer students',
          success: null
        });
      }
    } else if (userType === 'parent') {
      if (!relationship) {
        return res.render('register-modern', {
          title: 'Register - Student Registration System',
          error: 'Relationship field is required for parents',
          success: null
        });
      }
    }

    console.log('✅ Fields validation passed');

    // 2. Duplicate Check against both users and active pending queue
    const [existingUsers] = await pool.execute(
      'SELECT id, username, email FROM users WHERE username = ? OR email = ?',
      [username, email]
    );

    if (existingUsers.length > 0) {
      console.log('❌ User already exists in active database');
      let errorMessage = 'Username or email already exists';
      if (existingUsers[0].username === username) {
        errorMessage = `Username '${username}' is already taken. Please choose a different username.`;
      } else if (existingUsers[0].email === email) {
        errorMessage = `Email '${email}' is already registered. Please use a different email.`;
      }
      return res.render('register-modern', {
        title: 'Register - Student Registration System',
        error: errorMessage,
        success: null
      });
    }

    const [existingPending] = await pool.execute(
      "SELECT id, username, email FROM pending_registrations WHERE (username = ? OR email = ?) AND status = 'pending'",
      [username, email]
    );

    if (existingPending.length > 0) {
      console.log('❌ User already exists in pending registrations queue');
      let errorMessage = 'Username or email already has a pending registration';
      if (existingPending[0].username === username) {
        errorMessage = `Username '${username}' has a pending registration request waiting for admin approval.`;
      } else if (existingPending[0].email === email) {
        errorMessage = `Email '${email}' has a pending registration request waiting for admin approval.`;
      }
      return res.render('register-modern', {
        title: 'Register - Student Registration System',
        error: errorMessage,
        success: null
      });
    }

    // 3. Securely Hash Password
    console.log('🔐 Hashing password...');
    const hashedPassword = await bcrypt.hash(password, 12);
    console.log('✅ Password hashed');

    // 4. File uploads processing
    const profilePicture = req.files && req.files['studentPhoto']
      ? '/uploads/students/' + req.files['studentPhoto'][0].filename
      : null;

    let transcriptsJson = null;
    if (req.files && req.files['previousTranscript']) {
      const docs = req.files['previousTranscript'].map(file => ({
        file_url: '/uploads/transcripts/' + file.filename,
        file_name: file.originalname
      }));
      transcriptsJson = JSON.stringify(docs);
    }

    // 5. Save to Pending Staging Table
    console.log('💾 Staging registration request into database...');
    const [insertResult] = await pool.execute(
      `INSERT INTO pending_registrations (
        username, email, password, first_name, last_name, role, phone,
        grade_level, section, date_of_birth, gender, parent_guardian_name,
        address, previous_school, admission_type, transfer_date, transfer_reason,
        profile_picture, transcripts_json, occupation, relationship, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [
        username, email, hashedPassword, firstName, lastName, userType, phone || null,
        userType === 'student' ? grade : null,
        userType === 'student' ? section : null,
        userType === 'student' ? (dateOfBirth || null) : null,
        userType === 'student' ? (gender || 'male') : null,
        userType === 'student' ? (parentGuardianName || null) : null,
        userType === 'student' ? (address || null) : null,
        userType === 'student' ? (previousSchool || null) : null,
        userType === 'student' ? (admission_type || 'new') : null,
        userType === 'student' ? (transfer_date || null) : null,
        userType === 'student' ? (transfer_reason || null) : null,
        userType === 'student' ? profilePicture : null,
        userType === 'student' ? transcriptsJson : null,
        userType === 'parent' ? (occupation || null) : null,
        userType === 'parent' ? (relationship || 'guardian') : null
      ]
    );

    const pendingId = insertResult.insertId;
    console.log('✅ Registration request successfully staged. ID:', pendingId);

    // 6. Socket.IO Real-time notification to active admin dashboards
    const io = req.app.get('io');
    if (io) {
      console.log('🔌 Emitting real-time newPendingRegistration socket event to admin_dashboard');
      io.to('admin_dashboard').emit('newPendingRegistration', {
        id: pendingId,
        firstName,
        lastName,
        email,
        role: userType,
        created_at: new Date()
      });
    }

    console.log('=== STAGED REGISTRATION SUCCESS ===');
    return res.render('register-modern', {
      title: 'Register - Student Registration System',
      success: 'Your registration request has been submitted successfully! Waiting for admin approval. You will receive system access once an administrator approves your request.',
      error: null
    });

  } catch (error) {
    console.error('❌ Registration error:', error);
    res.render('register-modern', {
      title: 'Register - Student Registration System',
      error: 'Registration failed: ' + error.message,
      success: null
    });
  }
});

// GET /auth/admin - Show admin secret-code login
router.get('/admin', (req, res) => {
  if (req.session.user && req.session.user.role === 'admin') {
    return res.redirect('/admin/dashboard');
  }
  res.render('admin-login', { title: 'Admin Access', error: null });
});

// POST /auth/admin - Handle admin secret-code login
router.post('/admin', async (req, res) => {
  try {
    const { secretCode } = req.body;
    const ADMIN_SECRET = process.env.ADMIN_SECRET || 'ABDIGUDINA-ADMIN-2024';
    const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';

    if (!secretCode || secretCode.trim() !== ADMIN_SECRET) {
      return res.render('admin-login', { title: 'Admin Access', error: 'Invalid secret code. Access denied.' });
    }

    // Fetch the admin user
    const [admins] = await pool.execute(
      'SELECT * FROM users WHERE username = ? AND role = ?',
      [ADMIN_USERNAME, 'admin']
    );

    if (admins.length === 0) {
      return res.render('admin-login', { title: 'Admin Access', error: 'Admin account not found. Contact support.' });
    }

    const admin = admins[0];
    req.session.user = {
      id: admin.id,
      username: admin.username,
      email: admin.email,
      first_name: admin.first_name,
      last_name: admin.last_name,
      role: 'admin'
    };

    console.log(`Admin login via secret code: ${admin.username}`);
    res.redirect('/admin/dashboard');

  } catch (error) {
    console.error('Admin login error:', error);
    res.render('admin-login', { title: 'Admin Access', error: 'Server error. Please try again.' });
  }
});

// GET /auth/logout - Handle logout
router.get('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('Logout error:', err);
      return res.redirect('/dashboard');
    }
    res.clearCookie('connect.sid');
    res.redirect('/');
  });
});

// GET /auth/forgot-password - Show forgot password form
router.get('/forgot-password', (req, res) => {
  res.render('auth/forgot-password', {
    title: 'Forgot Password - Abdigudina',
    error: req.query.error || null,
    success: req.query.success || null,
    resetUrl: req.query.token ? `/auth/reset-password/${req.query.token}` : null,
    emailSent: req.query.emailSent === 'true'
  });
});

// POST /auth/forgot-password - Handle forgot password request (rate-limited)
router.post('/forgot-password', forgotPasswordLimiter, async (req, res) => {
  const isDev = process.env.NODE_ENV !== 'production';

  try {
    const rawInput = (req.body.email || req.body.identifier || '').trim();
    if (!rawInput) {
      return res.render('auth/forgot-password', {
        title: 'Forgot Password - Abdigudina',
        error: 'Please enter your email address or username.',
        success: null,
        resetUrl: null,
        emailSent: false
      });
    }

    const normalizedInput = rawInput.toLowerCase();

    // Look up user by email OR username
    const [users] = await pool.execute(
      'SELECT id, username, email, first_name, role FROM users WHERE (LOWER(email) = ? OR LOWER(username) = ?) AND is_active = 1',
      [normalizedInput, normalizedInput]
    );

    if (users.length === 0) {
      // In development, give immediate feedback if the user doesn't exist
      if (isDev) {
        return res.render('auth/forgot-password', {
          title: 'Forgot Password - Abdigudina',
          error: `No active account found for "${rawInput}". Please check the spelling or create an account.`,
          success: null,
          resetUrl: null,
          emailSent: false
        });
      }
      // Production: generic message to prevent user enumeration
      return res.render('auth/forgot-password', {
        title: 'Forgot Password - Abdigudina',
        error: null,
        success: 'If an account with that information exists, a password reset link has been processed.',
        resetUrl: null,
        emailSent: false
      });
    }

    const user = users[0];
    const targetEmail = user.email || (rawInput.includes('@') ? rawInput : null);

    // Generate cryptographically secure token
    const rawToken = crypto.randomBytes(48).toString('hex');
    const tokenHash = hashToken(rawToken);
    const expiry = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes

    // Store only the HASH in the database
    await pool.execute(
      'UPDATE users SET reset_token = ?, reset_token_expiry = ? WHERE id = ?',
      [tokenHash, expiry, user.id]
    );

    // Dynamically resolve base URL using the current request host and protocol
    const host = req.get('host') || `localhost:${process.env.PORT || 3001}`;
    const protocol = req.protocol || 'http';
    const appBase = (process.env.APP_URL && !process.env.APP_URL.includes('localhost'))
      ? process.env.APP_URL.replace(/\/$/, '')
      : `${protocol}://${host}`;

    const resetUrl = `${appBase}/auth/reset-password/${rawToken}`;

    // Attempt to send email via nodemailer if configured
    let emailSent = false;
    let emailErrMessage = null;
    const transporter = createTransport();

    if (transporter && targetEmail) {
      try {
        await transporter.sendMail({
          from: `"Abdigudina School" <${process.env.EMAIL_USER}>`,
          to: targetEmail,
          subject: 'Password Reset Request – Abdigudina EMS',
          text: [
            `Hello ${user.first_name || user.username},`,
            '',
            'We received a request to reset the password for your Abdigudina EMS account.',
            '',
            'Click the link below to reset your password (expires in 30 minutes):',
            resetUrl,
            '',
            'If you did not request a password reset, you can safely ignore this email.',
            'Your password will remain unchanged.',
            '',
            '— Abdigudina School System'
          ].join('\n'),
          html: `
            <div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;background:#0f172a;color:#e2e8f0;padding:32px;border-radius:16px;">
              <div style="text-align:center;margin-bottom:28px;">
                <span style="font-size:48px;">🔑</span>
                <h1 style="color:#38bdf8;font-size:24px;margin:12px 0 4px;">Password Reset</h1>
                <p style="color:#94a3b8;font-size:14px;margin:0;">Abdigudina Educational Management System</p>
              </div>
              <p style="font-size:15px;">Hello <strong>${user.first_name || user.username}</strong>,</p>
              <p style="font-size:14px;color:#94a3b8;">We received a request to reset the password for your account. Click the button below to proceed. This link expires in <strong style="color:#f59e0b;">30 minutes</strong>.</p>
              <div style="text-align:center;margin:28px 0;">
                <a href="${resetUrl}" style="display:inline-block;padding:14px 32px;background:linear-gradient(135deg,#0ea5e9,#6366f1);color:#fff;text-decoration:none;border-radius:10px;font-weight:700;font-size:15px;">Reset My Password</a>
              </div>
              <p style="font-size:13px;color:#64748b;">Or copy this link into your browser:</p>
              <p style="word-break:break-all;font-size:12px;color:#38bdf8;">${resetUrl}</p>
              <hr style="border:none;border-top:1px solid rgba(255,255,255,0.08);margin:24px 0;">
              <p style="font-size:12px;color:#64748b;">If you did not request this, please ignore this email. Your password will not change.</p>
            </div>`
        });
        emailSent = true;
        console.log(`[Auth] ✅ Password reset email sent to ${targetEmail} for user: ${user.username}`);
      } catch (emailErr) {
        emailErrMessage = emailErr.message;
        console.error('[Auth] ❌ Failed to send reset email:', emailErr.message);
      }
    } else {
      console.warn('\n[Auth] ⚠️ EMAIL NOT CONFIGURED / DEV MODE — Generated reset URL:');
      console.warn(`[Auth] User: ${user.username} (${targetEmail || 'No email'})`);
      console.warn(`[Auth] 🔗 Reset URL: ${resetUrl}\n`);
    }

    // Prepare success message
    let successMessage;
    if (emailSent) {
      successMessage = `A password reset link has been sent to ${targetEmail}. Please check your inbox.`;
    } else if (isDev) {
      successMessage = `Password reset link created for ${user.username}. You can reset your password directly below.`;
    } else {
      successMessage = 'If an account with that email exists, a password reset link has been sent. Check your inbox (and spam folder).';
    }

    // In dev mode or if email wasn't dispatched, present the reset link in the UI
    const exposedResetUrl = (isDev || !emailSent) ? resetUrl : null;

    return res.render('auth/forgot-password', {
      title: 'Forgot Password - Abdigudina',
      error: null,
      success: successMessage,
      resetUrl: exposedResetUrl,
      emailSent: emailSent
    });

  } catch (error) {
    console.error('[Auth] Forgot password error:', error.message);
    return res.render('auth/forgot-password', {
      title: 'Forgot Password - Abdigudina',
      error: 'An error occurred while processing your request. Please try again.',
      success: null,
      resetUrl: null,
      emailSent: false
    });
  }
});

// GET /auth/reset-password/:token - Show reset password form
router.get('/reset-password/:token', async (req, res) => {
  try {
    const rawToken = req.params.token;
    if (!rawToken || rawToken.length < 32) {
      return res.redirect('/auth/forgot-password?error=Invalid reset link.');
    }

    const tokenHash = hashToken(rawToken);
    const [users] = await pool.execute(
      'SELECT id, username FROM users WHERE reset_token = ? AND reset_token_expiry > NOW()',
      [tokenHash]
    );

    if (users.length === 0) {
      return res.redirect('/auth/forgot-password?error=This reset link is invalid or has expired. Please request a new one.');
    }

    res.render('auth/reset-password', {
      title: 'Reset Password - Abdigudina',
      token: rawToken,
      username: users[0].username,
      error: null,
      success: null
    });
  } catch (error) {
    console.error('[Auth] Reset password view error:', error.message);
    res.redirect('/auth/forgot-password?error=Server error. Please try again.');
  }
});

// POST /auth/reset-password/:token - Handle password reset
router.post('/reset-password/:token', async (req, res) => {
  const rawToken = req.params.token;

  const renderForm = (error) => res.render('auth/reset-password', {
    title: 'Reset Password - Abdigudina',
    token: rawToken,
    error,
    success: null
  });

  try {
    const { password, confirmPassword } = req.body;

    // Backend validation
    if (!password || !confirmPassword) {
      return renderForm('All fields are required.');
    }
    if (password.length < 8) {
      return renderForm('Password must be at least 8 characters long.');
    }
    if (password !== confirmPassword) {
      return renderForm('Passwords do not match.');
    }

    if (!rawToken || rawToken.length < 32) {
      return res.redirect('/auth/forgot-password?error=Invalid reset link.');
    }

    const tokenHash = hashToken(rawToken);

    const [users] = await pool.execute(
      'SELECT id, username, email, first_name, last_name, role FROM users WHERE reset_token = ? AND reset_token_expiry > NOW()',
      [tokenHash]
    );

    if (users.length === 0) {
      return res.redirect('/auth/forgot-password?error=This reset link is invalid or has already been used. Please request a new one.');
    }

    const user = users[0];
    const hashedPassword = await bcrypt.hash(password, 12);

    // Update password and IMMEDIATELY invalidate the token (single-use)
    await pool.execute(
      'UPDATE users SET password = ?, reset_token = NULL, reset_token_expiry = NULL WHERE id = ?',
      [hashedPassword, user.id]
    );

    // Regenerate session to prevent session fixation and log in user
    await new Promise((resolve, reject) => {
      if (req.session && typeof req.session.regenerate === 'function') {
        req.session.regenerate((err) => (err ? reject(err) : resolve()));
      } else {
        resolve();
      }
    });

    req.session.user = {
      id: user.id,
      username: user.username,
      email: user.email,
      first_name: user.first_name,
      last_name: user.last_name,
      role: user.role
    };

    await new Promise((resolve, reject) => {
      if (req.session && typeof req.session.save === 'function') {
        req.session.save((err) => (err ? reject(err) : resolve()));
      } else {
        resolve();
      }
    });

    console.log(`[Auth] Password reset successful for user: ${user.username}`);

    const targetDashboard = user.role ? `/${user.role}/dashboard` : '/dashboard';

    res.render('auth/reset-password', {
      title: 'Reset Password - Abdigudina',
      token: null,
      error: null,
      success: 'Your password has been reset successfully! You are now logged in.',
      role: user.role || '',
      dashboardUrl: targetDashboard
    });
  } catch (error) {
    console.error('[Auth] Reset password error:', error.message);
    return renderForm('An error occurred. Please try again.');
  }
});

// --- Profile Picture Upload Configuration ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = './public/uploads/profile-pics';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, 'profile-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB limit
  fileFilter: (req, file, cb) => {
    const filetypes = /jpeg|jpg|png|webp/;
    const mimetype = filetypes.test(file.mimetype);
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
    if (mimetype && extname) return cb(null, true);
    cb(new Error('Only images are allowed (jpeg, jpg, png, webp)'));
  }
});

// POST /auth/profile/upload-picture
router.post('/profile/upload-picture', upload.single('profile_picture'), async (req, res) => {
  if (!req.session.user) return res.redirect('/auth/login');

  try {
    if (!req.file) {
      return res.redirect('back');
    }

    const userId = req.session.user.id;
    const filePath = '/uploads/profile-pics/' + req.file.filename;

    await pool.execute('UPDATE users SET profile_picture = ? WHERE id = ?', [filePath, userId]);

    // Update session user object
    req.session.user.profile_picture = filePath;

    res.redirect('back');
  } catch (error) {
    console.error('Profile picture upload error:', error);
    res.redirect('back');
  }
});

module.exports = router;
