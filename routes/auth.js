const express = require('express');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { pool } = require('../config/db');
const { getSettings } = require('../config/settingsControl');
const router = express.Router();



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
    try { fs.appendFileSync(logFile, `[${timestamp}] ${msg}\n`); } catch (e) { }
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


    // Create session
    req.session.user = {
      id: user.id,
      username: user.username,
      email: user.email,
      first_name: user.first_name,
      last_name: user.last_name,
      role: user.role,
      profile_picture: user.profile_picture
    };

    log('Session created for ' + user.username + '. Redirecting based on role: ' + user.role);

    // Redirect based on role
    switch (user.role) {
      case 'admin':
        res.redirect('/admin/dashboard');
        break;
      case 'student':
        res.redirect('/student/dashboard');
        break;
      case 'teacher':
        log('Redirecting to /teacher/dashboard');
        res.redirect('/teacher/dashboard');
        break;
      case 'parent':
        res.redirect('/parent/dashboard');
        break;
      default:
        res.redirect('/dashboard');
    }

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

// POST /auth/register - Handle registration
router.post('/register', async (req, res) => {
  const settings = getSettings();
  if (!settings.publicRegistrationEnabled) {
    return res.status(403).send('Public registration is currently closed.');
  }

  try {
    console.log('=== REGISTRATION START ===');
    console.log('Request body:', req.body);

    const {
      userType, firstName, lastName, email, phone, username,
      studentId, employeeId, grade, department, occupation, relationship,
      password, confirmPassword, terms
    } = req.body;

    console.log('Extracted data:', {
      userType,
      firstName,
      lastName,
      email,
      username,
      hasPassword: !!password,
      termsAccepted: !!terms
    });

    // Validate required fields
    if (!userType || !firstName || !lastName || !email || !username || !password || !confirmPassword) {
      console.log('❌ Missing required fields');
      return res.render('register-modern', {
        title: 'Register - Student Registration System',
        error: 'All required fields must be filled'
      });
    }

    // Validate terms acceptance
    if (!terms) {
      console.log('❌ Terms not accepted');
      return res.render('register-modern', {
        title: 'Register - Student Registration System',
        error: 'You must accept terms and conditions'
      });
    }

    // Validate password match
    if (password !== confirmPassword) {
      console.log('❌ Passwords do not match');
      return res.render('register-modern', {
        title: 'Register - Student Registration System',
        error: 'Passwords do not match'
      });
    }

    // Validate password strength
    if (password.length < 8) {
      console.log('❌ Password too short');
      return res.render('register-modern', {
        title: 'Register - Student Registration System',
        error: 'Password must be at least 8 characters long'
      });
    }

    // Validate grade level for students
    if (userType === 'student') {
      const gradeLevel = parseInt(grade);
      if (!gradeLevel || gradeLevel < 1 || gradeLevel > 8) {
        console.log('❌ Invalid grade level:', grade);
        return res.render('register-modern', {
          title: 'Register - Student Registration System',
          error: 'Student grade level must be between 1 and 8'
        });
      }
    }

    console.log('✅ Basic validation passed');

    // Test database connection
    try {
      const [testResult] = await pool.execute('SELECT 1 as test');
      console.log('✅ Database connection OK:', testResult);
    } catch (dbError) {
      console.error('❌ Database connection failed:', dbError);
      return res.render('register-modern', {
        title: 'Register - Student Registration System',
        error: 'Database connection failed: ' + dbError.message
      });
    }

    // Check if username or email already exists
    console.log('🔍 Checking for existing users...');
    const [existingUsers] = await pool.execute(
      'SELECT id FROM users WHERE username = ? OR email = ?',
      [username, email]
    );

    if (existingUsers.length > 0) {
      console.log('❌ User already exists');
      let errorMessage = 'Username or email already exists';
      if (existingUsers[0].username === username) {
        errorMessage = `Username '${username}' is already taken. Please choose a different username.`;
      } else if (existingUsers[0].email === email) {
        errorMessage = `Email '${email}' is already registered. Please use a different email.`;
      }
      return res.render('register-modern', {
        title: 'Register - Student Registration System',
        error: errorMessage
      });
    }

    console.log('✅ No existing users found');

    // Hash password
    console.log('🔐 Hashing password...');
    const hashedPassword = await bcrypt.hash(password, 12);
    console.log('✅ Password hashed');

    // Insert user without transaction first (simpler)
    console.log('💾 Inserting user into database...');
    try {
      const [userResult] = await pool.execute(
        `INSERT INTO users (username, email, password, first_name, last_name, role, phone, is_active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, NOW())`,
        [username, email, hashedPassword, firstName, lastName, userType, phone || null]
      );

      console.log('✅ User inserted successfully:', userResult);
      const userId = userResult.insertId;

      // Insert role-specific data (without transaction for now)
      console.log(`💾 Inserting ${userType} specific data...`);

      switch (userType) {
        case 'student':
          try {
            await pool.execute(
              `INSERT INTO students (user_id, student_id, first_name, last_name, email, phone, grade_level, gender, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, 'male', NOW())`,
              [userId, studentId || `STU${Date.now()}`, firstName, lastName, email, phone || null, grade || null]
            );
            console.log('✅ Student data inserted');
          } catch (studentError) {
            console.warn('⚠️ Student table might not exist:', studentError.message);
          }
          break;

        case 'teacher':
          try {
            await pool.execute(
              `INSERT INTO teachers (user_id, employee_id, first_name, last_name, email, phone, department, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
              [userId, employeeId || `TCH${Date.now()}`, firstName, lastName, email, phone || null, department || null]
            );
            console.log('✅ Teacher data inserted');
          } catch (teacherError) {
            console.warn('⚠️ Teacher table might not exist:', teacherError.message);
          }
          break;

        case 'parent':
          try {
            await pool.execute(
              `INSERT INTO parents (user_id, relationship, occupation, created_at)
               VALUES (?, ?, ?, NOW())`,
              [userId, relationship || 'Parent', occupation || null]
            );
            console.log('✅ Parent data inserted');
          } catch (parentError) {
            console.warn('⚠️ Parent table might not exist:', parentError.message);
          }
          break;

        case 'admin':
          console.log('✅ Admin user created - no additional data needed');
          break;
      }

      // Auto-login after registration
      console.log('🔓 Auto-login user...');
      req.session.user = {
        id: userId,
        username: username,
        email: email,
        first_name: firstName,
        last_name: lastName,
        role: userType
      };

      console.log('✅ Session created');

      // Redirect based on role
      console.log(`🔄 Redirecting to ${userType} dashboard...`);
      switch (userType) {
        case 'admin':
          res.redirect('/admin/dashboard');
          break;
        case 'student':
          res.redirect('/student/dashboard');
          break;
        case 'teacher':
          res.redirect('/teacher/dashboard');
          break;
        case 'parent':
          res.redirect('/parent/dashboard');
          break;
        default:
          res.redirect('/dashboard');
      }

      console.log('=== REGISTRATION SUCCESS ===');

    } catch (insertError) {
      console.error('❌ Database insertion failed:', insertError);
      return res.render('register-modern', {
        title: 'Register - Student Registration System',
        error: 'Failed to save user data: ' + insertError.message
      });
    }

  } catch (error) {
    console.error('❌ Registration error:', error);
    res.render('register-modern', {
      title: 'Register - Student Registration System',
      error: 'Registration failed: ' + error.message
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
