const express = require('express');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { pool } = require('../config/db');
const { getSettings } = require('../config/settingsControl');
const router = express.Router();

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

const crypto = require('crypto');

// GET /auth/forgot-password - Show forgot password form
router.get('/forgot-password', (req, res) => {
  res.render('auth/forgot-password', {
    title: 'Forgot Password - Abdigudina',
    error: req.query.error || null,
    success: req.query.success || null,
    token: req.query.token || null
  });
});

// POST /auth/forgot-password - Handle forgot password request
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.redirect('/auth/forgot-password?error=Email is required');
    }

    // Check if user exists
    const [users] = await pool.execute('SELECT id, username FROM users WHERE email = ?', [email]);
    if (users.length === 0) {
      // For security, don't reveal if user exists, but here we can be helpful or silent
      return res.redirect('/auth/forgot-password?success=If an account exists with that email, a reset link has been sent.');
    }

    const user = users[0];
    const token = crypto.randomBytes(32).toString('hex');
    const expiry = new Date(Date.now() + 3600000); // 1 hour from now

    await pool.execute(
      'UPDATE users SET reset_token = ?, reset_token_expiry = ? WHERE id = ?',
      [token, expiry, user.id]
    );

    // SIMULATION: Log the reset link
    console.log(`>>> PASSWORD RESET REQUEST for ${user.username} (${email})`);
    console.log(`>>> RESET LINK: http://localhost:${process.env.PORT || 3001}/auth/reset-password/${token}`);

    res.redirect(`/auth/forgot-password?success=Password reset link has been generated!&token=${token}`);
  } catch (error) {
    console.error('Forgot password error:', error);
    res.redirect('/auth/forgot-password?error=An error occurred. Please try again.');
  }
});

// GET /auth/reset-password/:token - Show reset password form
router.get('/reset-password/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const [users] = await pool.execute(
      'SELECT id FROM users WHERE reset_token = ? AND reset_token_expiry > ?',
      [token, new Date()]
    );

    if (users.length === 0) {
      return res.redirect('/auth/forgot-password?error=Invalid or expired reset token');
    }

    res.render('auth/reset-password', {
      title: 'Reset Password - Abdigudina',
      token: token,
      error: null,
      success: null
    });
  } catch (error) {
    console.error('Reset password view error:', error);
    res.redirect('/auth/forgot-password?error=Server error');
  }
});

// POST /auth/reset-password/:token - Handle password reset
router.post('/reset-password/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const { password, confirmPassword } = req.body;

    if (password !== confirmPassword) {
      return res.render('auth/reset-password', {
        title: 'Reset Password - Abdigudina',
        token: token,
        error: 'Passwords do not match',
        success: null
      });
    }

    const [users] = await pool.execute(
      'SELECT id, username, email, first_name, last_name, role FROM users WHERE reset_token = ? AND reset_token_expiry > ?',
      [token, new Date()]
    );

    if (users.length === 0) {
      return res.redirect('/auth/forgot-password?error=Invalid or expired reset token');
    }

    const user = users[0];
    const hashedPassword = await bcrypt.hash(password, 12);

    await pool.execute(
      'UPDATE users SET password = ?, reset_token = NULL, reset_token_expiry = NULL WHERE id = ?',
      [hashedPassword, user.id]
    );

    // AUTO-LOGIN after successful reset
    req.session.user = {
      id: user.id,
      username: user.username,
      email: user.email,
      first_name: user.first_name,
      last_name: user.last_name,
      role: user.role
    };

    console.log(`>>> PASSWORD RESET SUCCESS: ${user.username} (Logged in)`);

    res.render('auth/reset-password', {
      title: 'Reset Password - Abdigudina',
      token: null,
      error: null,
      success: 'Password reset successful! You have been automatically logged in.',
      role: user.role // to help the template decide where to redirect
    });
  } catch (error) {
    console.error('Reset password error:', error);
    res.redirect('/auth/forgot-password?error=An error occurred');
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
