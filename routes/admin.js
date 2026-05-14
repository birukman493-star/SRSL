const express = require('express');
const { pool } = require('../config/db');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { updateSettings } = require('../config/settingsControl');
const router = express.Router();

// --- Multer Configuration for Student Files ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    let dir = './public/uploads/students';
    if (file.fieldname === 'previousTranscript') {
      dir = './public/uploads/transcripts';
    } else if (file.fieldname === 'certificate' || file.fieldname === 'idCard') {
      dir = './public/uploads/teachers';
    }
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    let prefix = 'student-';
    if (file.fieldname === 'previousTranscript') prefix = 'transcript-';
    if (file.fieldname === 'certificate') prefix = 'cert-';
    if (file.fieldname === 'idCard') prefix = 'id-';
    cb(null, prefix + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    const filetypes = /jpeg|jpg|png|webp|pdf/;
    const mimetype = filetypes.test(file.mimetype);
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
    if (mimetype && extname) return cb(null, true);
    cb(new Error('Only images (jpeg, jpg, png, webp) and PDF files are allowed'));
  }
});

// Middleware to check if user is admin
function isAdmin(req, res, next) {
  if (req.session.user?.role !== 'admin') {
    return res.redirect('/auth/login');
  }
  next();
}

// Apply admin middleware to all routes
router.use(isAdmin);

// GET /admin/users - User management
router.get('/users', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = 10;
    const offset = (page - 1) * limit;
    const role = req.query.role || '';
    const status = req.query.status || '';
    const search = req.query.search || '';
    const grade = req.query.grade || '';

    let query = `
      SELECT u.id, u.username, u.email, u.first_name, u.last_name, u.role, u.is_active, u.phone, u.created_at,
             s.grade_level, t.department,
             tg.teacher_classes, tg.teacher_grade_list
      FROM users u
      LEFT JOIN students s ON u.id = s.user_id
      LEFT JOIN teachers t ON u.id = t.user_id
      LEFT JOIN (
        SELECT t2.user_id, 
               GROUP_CONCAT(DISTINCT CAST(c.grade AS CHAR)) as teacher_grade_list,
               GROUP_CONCAT(DISTINCT CONCAT(c.grade, '-', c.section) SEPARATOR ', ') as teacher_classes
        FROM classes c
        LEFT JOIN class_teachers ct ON c.id = ct.class_id
        JOIN teachers t2 ON (c.teacher_id = t2.id OR ct.teacher_id = t2.id)
        GROUP BY t2.user_id
      ) tg ON u.id = tg.user_id
      WHERE 1=1
    `;
    const params = [];

    if (role) {
      query += ' AND LOWER(u.role) = LOWER(?)';
      params.push(role);
    }
    if (status) {
      query += ' AND u.is_active = ?';
      params.push(status === 'active');
    }
    if (grade) {
      query += ` AND (
        (LOWER(u.role) = 'student' AND TRIM(CAST(s.grade_level AS CHAR)) = ?)
        OR
        (LOWER(u.role) = 'teacher' AND FIND_IN_SET(?, tg.teacher_grade_list))
      )`;
      params.push(grade, grade);
    }
    if (search) {
      query += ' AND (u.username LIKE ? OR u.first_name LIKE ? OR u.last_name LIKE ? OR u.email LIKE ?)';
      const searchPattern = `%${search}%`;
      params.push(searchPattern, searchPattern, searchPattern, searchPattern);
    }

    query += ' ORDER BY u.created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const [users] = await pool.query(query, params);

    // Get total count for pagination
    let countQuery = `
      SELECT COUNT(*) as total 
      FROM users u 
      LEFT JOIN students s ON u.id = s.user_id 
      LEFT JOIN teachers t ON u.id = t.user_id 
      WHERE 1=1
    `;
    const countParams = [];
    if (role) {
      countQuery += ' AND LOWER(u.role) = LOWER(?)';
      countParams.push(role);
    }
    if (status) {
      countQuery += ' AND u.is_active = ?';
      countParams.push(status === 'active');
    }
    if (grade) {
      countQuery += ` AND (
        (LOWER(u.role) = 'student' AND TRIM(CAST(s.grade_level AS CHAR)) = ?)
        OR
        (LOWER(u.role) = 'teacher' AND u.id IN (
          SELECT t2.user_id FROM teachers t2 
          LEFT JOIN class_teachers ct ON t2.id = ct.teacher_id 
          LEFT JOIN classes c ON (c.id = ct.class_id OR c.teacher_id = t2.id)
          WHERE CAST(c.grade AS CHAR) = ?
        ))
      )`;
      countParams.push(grade, grade);
    }
    if (search) {
      countQuery += ' AND (u.username LIKE ? OR u.first_name LIKE ? OR u.last_name LIKE ? OR u.email LIKE ?)';
      const searchPattern = `%${search}%`;
      countParams.push(searchPattern, searchPattern, searchPattern, searchPattern);
    }
    const [countResult] = await pool.query(countQuery, countParams);
    const totalUsers = countResult[0].total;
    const totalPages = Math.ceil(totalUsers / limit);

    // Fetch classes for the Assign Classes modal
    const [classes] = await pool.query('SELECT id, name, grade, section FROM classes ORDER BY grade, section');

    res.render('admin/users', {
      title: 'User Management',
      user: req.session.user || {},
      users: users || [],
      classes: classes || [],
      currentPage: page,
      totalPages: totalPages || 1,
      totalUsers: totalUsers,
      role,
      status,
      grade,
      search,
      error: req.session.flash ? req.session.flash.error : null,
      success: req.session.flash ? req.session.flash.success : null,
      filters: { role, status, search, grade }
    });
  } catch (error) {
    console.error('Users management error:', error);
    res.status(500).render('500-modern', { title: 'Server Error', message: error.message });
  }
});

// GET /admin/teachers/:id/classes - Fetch assigned classes for a teacher
router.get('/teachers/:id/classes', async (req, res) => {
  try {
    const userId = req.params.id;
    // Get teacher_id from user_id
    const [teacherResult] = await pool.execute('SELECT id FROM teachers WHERE user_id = ?', [userId]);
    if (teacherResult.length === 0) {
      return res.json({ success: false, message: 'Teacher not found' });
    }
    const teacherId = teacherResult[0].id;

    const [assignedClasses] = await pool.execute(
      'SELECT class_id FROM class_teachers WHERE teacher_id = ?',
      [teacherId]
    );
    res.json({ success: true, classIds: assignedClasses.map(c => c.class_id) });
  } catch (error) {
    console.error('Fetch teacher classes error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /admin/users/assign-classes/:id - Assign classes to a teacher
router.post('/users/assign-classes/:id', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const userId = req.params.id;
    const { class_id } = req.body; // Array of class IDs or single ID

    // Get teacher_id from user_id
    const [teacherResult] = await connection.execute('SELECT id FROM teachers WHERE user_id = ?', [userId]);
    if (teacherResult.length === 0) {
      throw new Error('Teacher profile not found for this user');
    }
    const teacherId = teacherResult[0].id;

    // Delete existing assignments
    await connection.execute('DELETE FROM class_teachers WHERE teacher_id = ?', [teacherId]);

    // Parse class_id input
    let classes = [];
    if (Array.isArray(class_id)) {
      classes = class_id.filter(id => id);
    } else if (class_id) {
      classes = [class_id];
    }

    // Insert new assignments
    for (const cid of classes) {
      await connection.execute(
        'INSERT INTO class_teachers (class_id, teacher_id, assigned_date) VALUES (?, ?, CURDATE())',
        [cid, teacherId]
      );
    }

    await connection.commit();
    req.session.flash = { success: 'Teacher classes updated successfully' };
    res.redirect('back');
  } catch (error) {
    await connection.rollback();
    console.error('Assign classes error:', error);
    req.session.flash = { error: 'Failed to assign classes: ' + error.message };
    res.redirect('back');
  } finally {
    connection.release();
  }
});

// GET /admin/profile - Admin profile
router.get('/profile', (req, res) => {
  res.render('admin/profile', {
    title: 'Administrator Profile',
    user: req.session.user
  });
});

// GET /admin/dashboard - Admin dashboard
router.get('/dashboard', async (req, res) => {
  try {
    // Fetch unique academic years for the selector
    const [yearsResult] = await pool.execute('SELECT DISTINCT academic_year FROM classes ORDER BY academic_year DESC');
    const availableYears = yearsResult.length > 0 ? yearsResult.map(y => y.academic_year) : ['2025/2026'];

    const selectedYear = req.query.year || availableYears[0];

    // Get comprehensive system statistics filtered by year where applicable
    const [statsResult] = await pool.execute(`
          SELECT 
            (SELECT COUNT(*) FROM students WHERE withdrawal_status != 'withdrawn') as students,
            (SELECT COUNT(*) FROM teachers WHERE is_active = TRUE) as teachers,
            (SELECT COUNT(*) FROM parents) as parents,
            (SELECT COUNT(*) FROM courses WHERE is_active = TRUE) as courses,
            (SELECT COUNT(*) FROM students WHERE gender = 'male' AND withdrawal_status != 'withdrawn') as male_count,
            (SELECT COUNT(*) FROM students WHERE gender = 'female' AND withdrawal_status != 'withdrawn') as female_count,
            (SELECT COUNT(*) FROM students WHERE withdrawal_status = 'withdrawn') as withdrawn_count,
            (SELECT COUNT(*) FROM academic_history WHERE academic_year = ? AND status IN ('promoted', 'graduated')) as pass_count,
            (SELECT COUNT(*) FROM academic_history WHERE academic_year = ? AND status = 'retained') as fail_count,
            (SELECT COUNT(*) FROM national_exams) as national_exam_count,
            (SELECT COUNT(*) FROM enrollments WHERE status = 'enrolled') as enrollments
        `, [selectedYear, selectedYear]);

    const stats = statsResult[0];

    // Get recent activities
    const [recentActivities] = await pool.execute(`
          SELECT CONCAT(first_name, ' ', last_name) as description, created_at as activity_date, role
          FROM users 
          ORDER BY created_at DESC 
          LIMIT 5
        `);

    res.render('admin/dashboard', {
      title: 'Admin Dashboard',
      user: req.session.user || {},
      stats: stats || { students: 0, teachers: 0, parents: 0, courses: 0 },
      availableYears,
      selectedYear,
      recentActivities: recentActivities || []
    });
  } catch (err) {
    console.error('Dashboard error:', err);
    res.render('admin/dashboard', {
      title: 'Admin Dashboard',
      user: req.session.user || {},
      stats: { students: 0, teachers: 0, parents: 0, courses: 0 },
      availableYears: ['2025/2026'],
      selectedYear: '2025/2026',
      recentActivities: []
    });
  }
});

// GET /admin/students - Manage students
router.get('/students', async (req, res) => {
  try {
    const grade = req.query.grade || '';
    const section = req.query.section || '';
    const search = req.query.search || '';

    let query = `
      SELECT u.id, u.username, u.email, u.first_name, u.last_name, u.phone, u.created_at, u.is_active, u.profile_picture,
             s.id as student_profile_id, s.student_id, s.grade_level, s.section, s.registration_status, s.address, s.previous_school,
             s.withdrawal_status, s.withdrawal_reason, s.withdrawal_date
      FROM users u
      LEFT JOIN students s ON u.id = s.user_id
      WHERE u.role = 'student'
    `;
    const params = [];

    if (grade) {
      query += ' AND s.grade_level = ?';
      params.push(grade);
    }
    if (section) {
      query += ' AND s.section = ?';
      params.push(section);
    }
    const status = req.query.status || '';
    if (status) {
      query += ' AND s.withdrawal_status = ?';
      params.push(status);
    }

    if (search) {
      query += ' AND (u.first_name LIKE ? OR u.last_name LIKE ? OR s.student_id LIKE ?)';
      const pattern = `%${search}%`;
      params.push(pattern, pattern, pattern);
    }

    query += ' ORDER BY u.created_at DESC';

    const [students] = await pool.execute(query, params);

    // Calculate pending registrations count for the top alert banner
    const [pendingResult] = await pool.execute('SELECT COUNT(*) as count FROM students WHERE registration_status = "pending"');
    const submittedStudents = pendingResult[0].count;

    res.render('admin/students', {
      title: 'Manage Students',
      user: req.session.user,
      students,
      submittedStudents,
      filters: { grade, section, search, status },
      error: req.session.flash ? req.session.flash.error : null,
      success: req.session.flash ? req.session.flash.success : null
    });
    if (req.session.flash) delete req.session.flash;
  } catch (error) {
    console.error('Students error:', error);
    res.status(500).render('500-modern', { title: 'Server Error' });
  }
});

// GET /admin/teachers - Manage teachers
router.get('/teachers', async (req, res) => {
  try {
    const grade = req.query.grade || '';
    const search = req.query.search || '';

    let query = `
      SELECT u.id, u.username, u.email, u.first_name, u.last_name, u.phone, u.created_at, u.is_active,
             t.id as teacher_db_id, t.employee_id, t.department, t.qualification, t.experience, t.certificate_url, t.id_card_url,
             tg.teacher_classes as assigned_classes, tg.teacher_grade_list
      FROM users u
      LEFT JOIN teachers t ON u.id = t.user_id
      LEFT JOIN (
        SELECT t2.user_id, 
               GROUP_CONCAT(DISTINCT CAST(c.grade AS CHAR)) as teacher_grade_list,
               GROUP_CONCAT(DISTINCT CONCAT(c.grade, '-', c.section) SEPARATOR ', ') as teacher_classes
        FROM classes c
        LEFT JOIN class_teachers ct ON c.id = ct.class_id
        JOIN teachers t2 ON (c.teacher_id = t2.id OR ct.teacher_id = t2.id)
        GROUP BY t2.user_id
      ) tg ON u.id = tg.user_id
      WHERE LOWER(u.role) = 'teacher'
    `;
    const params = [];

    if (grade) {
      query += ` AND FIND_IN_SET(?, tg.teacher_grade_list)`;
      params.push(grade);
    }
    if (search) {
      query += ' AND (u.first_name LIKE ? OR u.last_name LIKE ? OR t.employee_id LIKE ? OR t.department LIKE ?)';
      const searchPattern = `%${search}%`;
      params.push(searchPattern, searchPattern, searchPattern, searchPattern);
    }

    query += ' ORDER BY u.created_at DESC';

    const [teachers] = await pool.query(query, params);
    const [classes] = await pool.query('SELECT id, name, grade, section FROM classes ORDER BY grade, section');

    res.render('admin/teachers', {
      title: 'Manage Teachers',
      user: req.session.user,
      teachers,
      classes,
      filters: { grade, search },
      error: req.session.flash ? req.session.flash.error : null,
      success: req.session.flash ? req.session.flash.success : null
    });
    if (req.session.flash) delete req.session.flash;
  } catch (error) {
    console.error('Teachers error:', error);
    res.status(500).render('500-modern', { title: 'Server Error' });
  }
});

// GET /admin/parents - Manage parents
router.get('/parents', async (req, res) => {
  try {
    const [parents] = await pool.execute(`
      SELECT u.id, u.username, u.email, u.first_name, u.last_name, u.phone, u.created_at, u.is_active,
             p.relationship, p.occupation,
             GROUP_CONCAT(CONCAT(s.first_name, ' ', s.last_name) SEPARATOR ', ') as children
      FROM users u
      JOIN parents p ON u.id = p.user_id
      LEFT JOIN parent_student_relations psr ON p.id = psr.parent_id
      LEFT JOIN students s ON psr.student_id = s.id
      WHERE u.role = 'parent'
      GROUP BY u.id, u.username, u.email, u.first_name, u.last_name, u.phone, u.created_at, u.is_active, p.relationship, p.occupation
      ORDER BY u.created_at DESC
    `);

    res.render('admin/parents', {
      title: 'Manage Parents',
      user: req.session.user || {},
      parents,
      error: req.session.flash ? req.session.flash.error : null,
      success: req.session.flash ? req.session.flash.success : null
    });
    if (req.session.flash) delete req.session.flash;
  } catch (error) {
    console.error('Parents error:', error);
    res.status(500).render('500-modern', { title: 'Server Error' });
  }
});

// POST /admin/parents/add - Add new parent/guardian
router.post('/parents/add', async (req, res) => {
  const { firstName, lastName, relationship, email, phone, occupation, username, password } = req.body;

  try {
    // Basic validation
    if (!username || !password || !email || !firstName || !lastName || !relationship) {
      req.session.flash = { error: 'Please completely fill out all required core fields.' };
      return res.redirect('/admin/parents?form=open');
    }

    // Check if user already exists
    const [existing] = await pool.execute('SELECT id FROM users WHERE username = ? OR email = ?', [username, email]);
    if (existing.length > 0) {
      req.session.flash = { error: 'A user with this username or email already exists in the system.' };
      return res.redirect('/admin/parents?form=open');
    }

    // Hash the password securely
    const hashedPassword = await bcrypt.hash(password, 10);

    // Insert Base User Identity
    const [userResult] = await pool.execute(
      'INSERT INTO users (username, password, email, first_name, last_name, phone, role) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [username, hashedPassword, email, firstName, lastName, phone || null, 'parent']
    );

    const userId = userResult.insertId;

    // Attach Extended Parent Record
    await pool.execute(
      'INSERT INTO parents (user_id, relationship, occupation) VALUES (?, ?, ?)',
      [userId, relationship, occupation || null]
    );

    req.session.flash = { success: `Parent Account for ${firstName} ${lastName} created successfully.` };
    res.redirect('/admin/parents');

  } catch (error) {
    console.error('Add Parent Registration Error:', error);
    req.session.flash = { error: 'A critical server error occurred trying to save the parent details.' };
    res.redirect('/admin/parents?form=open');
  }
});

// GET /admin/students/new - Redirect to students with form open
router.get('/students/new', (req, res) => {
  res.redirect('/admin/students?form=open');
});

// GET /admin/teachers/new - Redirect to teachers with form open
router.get('/teachers/new', (req, res) => {
  res.redirect('/admin/teachers?form=open');
});

// GET /admin/announcements/new - Redirect to announcements with form open
router.get('/announcements/new', (req, res) => {
  res.redirect('/admin/announcements?form=open');
});

// GET /admin/attendance - Manage attendance across school
router.get('/attendance', async (req, res) => {
  try {
    const { date, class_id, grade, search } = req.query;
    let query = `
      SELECT a.*, u.first_name, u.last_name, c.name as class_name, s.student_id, s.grade_level
      FROM attendance a
      LEFT JOIN students s ON a.student_id = s.id
      LEFT JOIN users u ON s.user_id = u.id
      LEFT JOIN classes c ON a.class_id = c.id
      WHERE 1=1
    `;
    const params = [];

    if (date) {
      query += ` AND a.date = ?`;
      params.push(date);
    }
    if (class_id) {
      query += ` AND a.class_id = ?`;
      params.push(class_id);
    }
    if (grade) {
      query += ` AND s.grade_level = ?`;
      params.push(grade);
    }
    if (search) {
      query += ` AND (u.first_name LIKE ? OR u.last_name LIKE ? OR s.student_id LIKE ?)`;
      const pattern = `%${search}%`;
      params.push(pattern, pattern, pattern);
    }

    query += ` ORDER BY a.date DESC LIMIT 500`;

    const [attendance] = await pool.execute(query, params);

    // Fetch classes - filter by grade if a grade is selected for more organized navigation
    let classQuery = 'SELECT id, name FROM classes';
    const classParams = [];
    if (grade) {
      classQuery += ' WHERE grade = ?';
      classParams.push(grade);
    }
    classQuery += ' ORDER BY name ASC';
    const [classes] = await pool.execute(classQuery, classParams);

    // Compute aggregate stats
    const stats = {
      total: attendance.length,
      present: attendance.filter(r => r.status === 'present').length,
      absent: attendance.filter(r => r.status === 'absent').length,
      late: attendance.filter(r => r.status === 'late').length,
      excused: attendance.filter(r => r.status === 'excused').length
    };
    stats.rate = stats.total > 0 ? Math.round(((stats.present + stats.late + stats.excused) / stats.total) * 100) : 0;

    res.render('admin/attendance', {
      title: 'Attendance Management',
      user: req.session.user,
      attendance,
      classes,
      stats,
      filters: { date, class_id, grade, search }
    });
  } catch (error) {
    console.error('Admin attendance error:', error);
    res.status(500).render('500-modern', { title: 'Server Error', message: error.message });
  }
});


// GET /admin/messages - View contact messages
router.get('/messages', async (req, res) => {
  try {
    const [messages] = await pool.execute(`
      SELECT * FROM contact_messages 
      ORDER BY created_at DESC
    `);

    res.render('admin/messages', {
      title: 'Contact Messages',
      user: req.session.user,
      messages
    });
  } catch (error) {
    console.error('Messages error:', error);
    res.status(500).render('500-modern', { title: 'Server Error' });
  }
});

// POST /admin/messages/read/:id
router.post('/messages/read/:id', async (req, res) => {
  try {
    await pool.execute('UPDATE contact_messages SET is_read = TRUE WHERE id = ?', [req.params.id]);
    res.redirect('/admin/messages');
  } catch (error) {
    console.error('Read message error:', error);
    res.redirect('/admin/messages');
  }
});

// POST /admin/messages/delete/:id
router.post('/messages/delete/:id', async (req, res) => {
  try {
    await pool.execute('DELETE FROM contact_messages WHERE id = ?', [req.params.id]);
    res.redirect('/admin/messages');
  } catch (error) {
    console.error('Delete message error:', error);
    res.redirect('/admin/messages');
  }
});

// POST /admin/students/register - Register a new student
router.post('/students/register', upload.fields([
  { name: 'studentPhoto', maxCount: 1 },
  { name: 'previousTranscript', maxCount: 5 }
]), async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    let {
      username, email, password, firstName, lastName, phone,
      studentId, gradeLevel, section, dateOfBirth, gender, enrollmentDate,
      parentGuardianName, relationship, parentPhone, parentEmail,
      address, previousSchool,
      admission_type, transfer_date, transfer_reason
    } = req.body;

    // Automatically generate unique student ID: AES-{year}-{serial}
    const currentYear = new Date().getFullYear();
    const idPrefix = `AES-${currentYear}-`;

    // Find the latest serial for this year prefix to ensure sequential order across all grades
    const [lastStudent] = await connection.execute(
      'SELECT student_id FROM students WHERE student_id LIKE ? ORDER BY student_id DESC LIMIT 1',
      [idPrefix + '%']
    );

    let nextSerial = 1;
    if (lastStudent.length > 0) {
      const lastId = lastStudent[0].student_id;
      const parts = lastId.split('-');
      const lastSerial = parseInt(parts[parts.length - 1]);
      if (!isNaN(lastSerial)) {
        nextSerial = lastSerial + 1;
      }
    }

    // Final ID override: Generation is automatic and ignores manual input for consistency
    studentId = idPrefix + nextSerial.toString().padStart(4, '0');

    // Check if user already exists
    const [existing] = await connection.execute('SELECT id FROM users WHERE username = ? OR email = ?', [username, email]);
    if (existing.length > 0) {
      throw new Error('Username or Email already exists');
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 12);

    // Profile picture path if uploaded
    const profilePicture = req.files['studentPhoto'] ? '/uploads/students/' + req.files['studentPhoto'][0].filename : null;

    // 1. Create User
    const [userResult] = await connection.execute(`
      INSERT INTO users (username, email, password, first_name, last_name, role, phone, profile_picture)
      VALUES (?, ?, ?, ?, ?, 'student', ?, ?)
    `, [username, email, hashedPassword, firstName, lastName, phone, profilePicture]);

    const userId = userResult.insertId;

    // 2. Create Student Profile
    const [studentResult] = await connection.execute(`
      INSERT INTO students (
        user_id, student_id, first_name, last_name, email, phone, 
        grade_level, section, date_of_birth, gender, enrollment_date, parent_guardian_name,
        address, previous_school, admission_type, transfer_date, transfer_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      userId, studentId, firstName, lastName, email, phone,
      gradeLevel, section, dateOfBirth, gender, enrollmentDate || new Date(), parentGuardianName,
      address || null, previousSchool || null, admission_type || 'new', transfer_date || null, transfer_reason || null
    ]);
    const studentDbId = studentResult.insertId;

    // 2.5 Handle Multiple Transcripts
    if (req.files['previousTranscript']) {
      for (const file of req.files['previousTranscript']) {
        const transcriptUrl = '/uploads/transcripts/' + file.filename;
        await connection.execute(`
          INSERT INTO student_documents (student_id, document_type, file_url, file_name)
          VALUES (?, 'transcript', ?, ?)
        `, [studentDbId, transcriptUrl, file.originalname]);

        // Also update the main profile with the first one for backward compatibility
        if (file === req.files['previousTranscript'][0]) {
          await connection.execute('UPDATE students SET previous_transcript_url = ? WHERE id = ?', [transcriptUrl, studentDbId]);
        }
      }
    }

    // 3. Handle Parent Account Creation
    if (parentEmail && parentEmail.trim()) {
      const [existingParent] = await connection.execute('SELECT id FROM users WHERE email = ?', [parentEmail]);
      let parentUserId;

      if (existingParent.length > 0) {
        parentUserId = existingParent[0].id;
      } else {
        // Create New Parent User
        const parentUsername = parentEmail.split('@')[0] + Math.floor(Math.random() * 1000);
        const parentHashedPassword = await bcrypt.hash('Parent123!', 12);
        const [pUserResult] = await connection.execute(`
                INSERT INTO users (username, email, password, first_name, last_name, role, phone)
                VALUES (?, ?, ?, ?, ?, 'parent', ?)
            `, [parentUsername, parentEmail, parentHashedPassword, parentGuardianName.split(' ')[0], parentGuardianName.split(' ').slice(1).join(' ') || '', parentPhone]);
        parentUserId = pUserResult.insertId;

        // Create Parent Profile
        await connection.execute(`
                INSERT INTO parents (user_id, relationship) VALUES (?, ?)
            `, [parentUserId, relationship || 'parent']);
      }

      // Link Parent to Student
      const [parentData] = await connection.execute('SELECT id FROM parents WHERE user_id = ?', [parentUserId]);
      if (parentData.length > 0) {
        await connection.execute(`
                INSERT IGNORE INTO parent_student_relations (parent_id, student_id, relationship)
                VALUES (?, ?, ?)
            `, [parentData[0].id, studentDbId, relationship || 'parent']);
      }
    }

    await connection.commit();
    req.session.flash = { success: 'Student registered successfully. ID: ' + studentId };
    res.redirect('/admin/students');
  } catch (error) {
    await connection.rollback();
    console.error('Student registration error:', error);
    req.session.flash = { error: 'Failed to register student: ' + error.message };
    res.redirect('/admin/students?form=open');
  } finally {
    connection.release();
  }
});

// GET /admin/students/edit/:id - Fetch student for editing
router.get('/students/edit/:id', async (req, res) => {
  try {
    const [studentData] = await pool.execute(`
            SELECT u.*, s.*, s.id as student_profile_id
            FROM users u
            LEFT JOIN students s ON u.id = s.user_id
            WHERE u.id = ?
        `, [req.params.id]);

    if (studentData.length === 0) {
      return res.status(404).json({ success: false, message: 'Student not found' });
    }

    const student = studentData[0];

    // Fetch additional documents
    const [documents] = await pool.execute('SELECT * FROM student_documents WHERE student_id = ?', [student.student_profile_id]);
    student.documents = documents || [];

    res.json({ success: true, student });
  } catch (error) {
    console.error('Fetch student error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /admin/students/withdraw/:id - Mark student as withdrawn/transferred/dropped_out
router.post('/students/withdraw/:id', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const userId = req.params.id;
    const { status, reason, date } = req.body;

    if (!['withdrawn', 'transferred', 'dropped_out', 'active'].includes(status)) {
      throw new Error('Invalid withdrawal status');
    }

    // Update student profile
    await connection.execute(`
            UPDATE students SET 
                withdrawal_status = ?, 
                withdrawal_reason = ?, 
                withdrawal_date = ?
            WHERE user_id = ?
        `, [status, reason || null, date || new Date(), userId]);

    // If not active, deactivate the user account
    const isActive = status === 'active';
    await connection.execute('UPDATE users SET is_active = ? WHERE id = ?', [isActive, userId]);

    await connection.commit();
    req.session.flash = { success: `Student status updated to ${status.replace('_', ' ')}` };
    res.redirect('/admin/students');
  } catch (error) {
    await connection.rollback();
    console.error('Withdraw student error:', error);
    req.session.flash = { error: 'Failed to update status: ' + error.message };
    res.redirect('/admin/students');
  } finally {
    connection.release();
  }
});

// POST /admin/students/update/:id - Update student information
router.post('/students/update/:id', upload.fields([
  { name: 'studentPhoto', maxCount: 1 },
  { name: 'previousTranscript', maxCount: 5 }
]), async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const userId = req.params.id;
    const {
      firstName, lastName, email, phone,
      gradeLevel, section, dateOfBirth, gender,
      parentGuardianName, address, previousSchool, is_active,
      withdrawal_status, withdrawal_reason, withdrawal_date,
      admission_type, transfer_date, transfer_reason
    } = req.body;

    // Update User table
    let userUpdateQuery = 'UPDATE users SET first_name = ?, last_name = ?, email = ?, phone = ?, is_active = ?';
    const userParams = [firstName, lastName, email, phone, is_active === 'on' || is_active === '1' || is_active === true];

    if (req.files && req.files['studentPhoto']) {
      userUpdateQuery += ', profile_picture = ?';
      userParams.push('/uploads/students/' + req.files['studentPhoto'][0].filename);
    }

    userUpdateQuery += ' WHERE id = ?';
    userParams.push(userId);
    await connection.execute(userUpdateQuery, userParams);

    // Update Student table
    let studentUpdateQuery = `
            UPDATE students SET 
                first_name = ?, last_name = ?, email = ?, phone = ?,
                grade_level = ?, section = ?, date_of_birth = ?, gender = ?,
                parent_guardian_name = ?, address = ?, previous_school = ?,
                withdrawal_status = ?, withdrawal_reason = ?, withdrawal_date = ?,
                admission_type = ?, transfer_date = ?, transfer_reason = ?
    `;
    const studentParams = [
      firstName || null, lastName || null, email || null, phone || null,
      gradeLevel || null, section || null, dateOfBirth || null, gender || null,
      parentGuardianName || null, address || null, previousSchool || null,
      withdrawal_status || 'active', withdrawal_reason || null, withdrawal_date || null,
      admission_type || 'new', transfer_date || null, transfer_reason || null
    ];

    if (req.files && req.files['previousTranscript']) {
      // Get the student's primary ID from the students table
      const [sData] = await connection.execute('SELECT id FROM students WHERE user_id = ?', [userId]);
      if (sData.length > 0) {
        const studentDbId = sData[0].id;
        for (const file of req.files['previousTranscript']) {
          const transcriptUrl = '/uploads/transcripts/' + file.filename;
          await connection.execute(`
            INSERT INTO student_documents (student_id, document_type, file_url, file_name)
            VALUES (?, 'transcript', ?, ?)
          `, [studentDbId, transcriptUrl, file.originalname]);

          // Update primary if first one
          if (file === req.files['previousTranscript'][0]) {
            await connection.execute('UPDATE students SET previous_transcript_url = ? WHERE user_id = ?', [transcriptUrl, userId]);
          }
        }
      }
    }

    studentUpdateQuery += ' WHERE user_id = ?';
    studentParams.push(userId);
    await connection.execute(studentUpdateQuery, studentParams);

    await connection.commit();
    req.session.flash = { success: 'Student information updated successfully' };
    res.redirect('/admin/students');
  } catch (error) {
    await connection.rollback();
    console.error('Update student error:', error);
    req.session.flash = { error: 'Failed to update student: ' + error.message };
    res.redirect('/admin/students');
  } finally {
    connection.release();
  }
});

// POST /admin/promotion/process - Handle end-of-year promotions
router.post('/promotion/process', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { academicYear, passingGrade } = req.body;
    const threshold = parseFloat(passingGrade) || 50.0;

    // 1. Get all active students and their average grades for the SPECIFIC year being promoted
    const [students] = await connection.execute(`
            SELECT s.id as student_profile_id, s.user_id, s.grade_level, 
                   (SELECT AVG(score) FROM grades g 
                    JOIN classes c ON g.class_id = c.id 
                    WHERE g.student_id = s.id AND c.academic_year = ?) as avg_score
            FROM students s
            WHERE s.is_active = TRUE
        `, [academicYear]);

    for (const student of students) {
      const avg = student.avg_score || 0;
      const isPassing = avg >= threshold;
      const currentGrade = parseInt(student.grade_level);
      let nextGrade;
      let status;

      if (isPassing) {
        if (currentGrade < 8) {
          nextGrade = (currentGrade + 1).toString();
          status = 'promoted';
        } else {
          nextGrade = '8'; // Stay at 8 or could be marked 'graduated'
          status = 'graduated';
        }
      } else {
        nextGrade = currentGrade.toString();
        status = 'retained';
      }

      // 2. Save to academic history
      await connection.execute(`
                INSERT INTO academic_history (student_id, grade_level, academic_year, average_score, status, remarks)
                VALUES (?, ?, ?, ?, ?, ?)
            `, [student.student_profile_id, student.grade_level, academicYear, avg, status, isPassing ? 'Passed criteria' : 'Needs improvement']);

      // 3. Update student's grade level if promoted
      if (isPassing) {
        await connection.execute('UPDATE students SET grade_level = ? WHERE id = ?', [nextGrade, student.student_profile_id]);
      }
    }

    await connection.commit();
    req.session.flash = { success: `Promotion process completed for ${students.length} students.` };
    res.redirect('/admin/students');
  } catch (error) {
    await connection.rollback();
    console.error('Promotion error:', error);
    req.session.flash = { error: 'Promotion process failed: ' + error.message };
    res.redirect('/admin/students');
  } finally {
    connection.release();
  }
});

// POST /admin/teachers/add - Add a new teacher with auto-ID and file uploads
router.post('/teachers/add', upload.fields([
  { name: 'certificate', maxCount: 1 },
  { name: 'idCard', maxCount: 1 }
]), async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    let {
      username, email, password, firstName, lastName, phone,
      department, hireDate, qualification, experience, subjects
    } = req.body;

    // Automatically generate sequential Employee ID: AES-T-xxxx
    const [lastTeacher] = await connection.execute(
      "SELECT employee_id FROM teachers WHERE employee_id LIKE 'AES-T-%' ORDER BY employee_id DESC LIMIT 1"
    );

    let nextSerial = 1;
    if (lastTeacher.length > 0) {
      const lastId = lastTeacher[0].employee_id;
      const parts = lastId.split('-');
      const lastSerial = parseInt(parts[parts.length - 1]);
      if (!isNaN(lastSerial)) {
        nextSerial = lastSerial + 1;
      }
    }
    const employeeId = `AES-T-${nextSerial.toString().padStart(4, '0')}`;

    // Check if user already exists
    const [existing] = await connection.execute('SELECT id FROM users WHERE username = ? OR email = ?', [username, email]);
    if (existing.length > 0) {
      throw new Error('Username or Email already exists');
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 12);

    // 1. Create User
    const [userResult] = await connection.execute(`
      INSERT INTO users (username, email, password, first_name, last_name, role, phone)
      VALUES (?, ?, ?, ?, ?, 'teacher', ?)
    `, [username, email, hashedPassword, firstName, lastName, phone]);

    const userId = userResult.insertId;

    // File paths
    const certificateUrl = req.files['certificate'] ? '/uploads/teachers/' + req.files['certificate'][0].filename : null;
    const idCardUrl = req.files['idCard'] ? '/uploads/teachers/' + req.files['idCard'][0].filename : null;

    // 2. Create Teacher Profile
    await connection.execute(`
      INSERT INTO teachers (
        user_id, employee_id, first_name, last_name, email, phone, 
        department, hire_date, qualification, experience, certificate_url, id_card_url
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      userId, employeeId, firstName, lastName, email, phone,
      department, hireDate, qualification || null, experience || null,
      certificateUrl, idCardUrl
    ]);

    await connection.commit();
    req.session.flash = { success: 'Teacher added successfully. Employee ID: ' + employeeId };
    res.redirect('/admin/teachers');
  } catch (error) {
    await connection.rollback();
    console.error('Teacher add error:', error);
    req.session.flash = { error: 'Failed to add teacher: ' + error.message };
    res.redirect('/admin/teachers?form=open');
  } finally {
    connection.release();
  }
});

// GET /admin/classes - Manage classes
router.get('/classes', async (req, res) => {
  try {
    const grade = req.query.grade || '';
    const search = req.query.search || '';

    let query = `
      SELECT c.*, 
             GROUP_CONCAT(DISTINCT CONCAT(t.first_name, ' ', t.last_name) SEPARATOR ', ') as teacher_names,
             GROUP_CONCAT(DISTINCT t.id) as teacher_ids,
             (SELECT COUNT(*) FROM students WHERE grade_level = c.grade AND section = c.section AND withdrawal_status = 'active') as current_students
      FROM classes c
      LEFT JOIN class_teachers ct ON c.id = ct.class_id
      LEFT JOIN teachers t ON ct.teacher_id = t.id
      WHERE 1=1
    `;
    const params = [];

    if (grade) {
      query += ' AND c.grade = ?';
      params.push(grade);
    }

    if (search) {
      query += ' AND c.name LIKE ?';
      params.push(`%${search}%`);
    }

    query += ` GROUP BY c.id ORDER BY c.grade, c.section`;

    const [classes] = await pool.execute(query, params);
    const [teachers] = await pool.execute(`
      SELECT id, first_name, last_name, employee_id 
      FROM teachers 
      WHERE is_active = TRUE 
      ORDER BY first_name, last_name
    `);

    res.render('admin/classes', {
      title: 'Manage Classes',
      user: req.session.user,
      classes,
      teachers,
      filters: { grade, search },
      error: null,
      success: null
    });
  } catch (error) {
    console.error('Classes error:', error);
    res.status(500).render('500-modern', { title: 'Server Error' });
  }
});

// GET /admin/courses - Manage courses
router.get('/courses', async (req, res) => {
  try {
    // Robustly handle grade and search params (handle arrays and trim)
    const rawGrade = req.query.grade;
    const grade = Array.isArray(rawGrade) ? rawGrade[0] : (rawGrade || '').toString().trim();
    
    const rawSearch = req.query.search;
    const search = Array.isArray(rawSearch) ? rawSearch[0] : (rawSearch || '').toString().trim();
    let query = `
      SELECT c.*, t.first_name as teacher_first, t.last_name as teacher_last
      FROM courses c
      LEFT JOIN teachers t ON c.teacher_id = t.id
      WHERE 1=1
    `;
    const params = [];

    if (grade) {
      query += ' AND c.grade = ?';
      params.push(grade);
    }

    if (search) {
      query += ' AND (c.course_name LIKE ? OR c.course_code LIKE ?)';
      const pattern = `%${search}%`;
      params.push(pattern, pattern);
    }

    query += ' ORDER BY c.grade, c.course_name';
    
    const [courses] = await pool.execute(query, params);
    const [teachers] = await pool.execute(`
      SELECT id, first_name, last_name, employee_id 
      FROM teachers 
      WHERE is_active = TRUE 
      ORDER BY first_name, last_name
    `);

    res.render('admin/courses', {
      title: 'Manage Courses',
      user: req.session.user,
      courses,
      teachers,
      filters: { grade, search },
      error: req.session.flash ? req.session.flash.error : null,
      success: req.session.flash ? req.session.flash.success : null
    });
    if (req.session.flash) delete req.session.flash;
  } catch (error) {
    console.error('Courses error:', error);
    res.status(500).render('500-modern', { title: 'Server Error' });
  }
});

// POST /admin/classes/add
router.post('/classes/add', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { name, grade, section, teacher_id, academic_year, semester, course_limit } = req.body;
    const [result] = await connection.execute(
      'INSERT INTO classes (name, grade, section, academic_year, semester, course_limit) VALUES (?, ?, ?, ?, ?, ?)',
      [name, grade, section, academic_year || '2023-2024', semester || '1', course_limit || 10]
    );
    const classId = result.insertId;

    let teachers = [];
    if (Array.isArray(teacher_id)) {
      teachers = teacher_id.filter(id => id);
    } else if (teacher_id) {
      teachers = [teacher_id];
    }

    for (const tid of teachers) {
      await connection.execute(
        'INSERT INTO class_teachers (class_id, teacher_id, assigned_date) VALUES (?, ?, CURDATE())',
        [classId, tid]
      );
    }

    await connection.commit();
    req.session.flash = { success: 'Class created successfully' };
    res.redirect('/admin/classes');
  } catch (error) {
    await connection.rollback();
    console.error('Add class error:', error);
    res.redirect('back');
  } finally {
    connection.release();
  }
});

// POST /admin/classes/edit/:id
router.post('/classes/edit/:id', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const classId = req.params.id;
    const { name, grade, section, teacher_id, academic_year, semester, course_limit } = req.body;
    await connection.execute(
      'UPDATE classes SET name = ?, grade = ?, section = ?, academic_year = ?, semester = ?, course_limit = ? WHERE id = ?',
      [name, grade, section, academic_year || '2023-2024', semester || '1', course_limit || 10, classId]
    );

    await connection.execute('DELETE FROM class_teachers WHERE class_id = ?', [classId]);

    let teachers = [];
    if (Array.isArray(teacher_id)) {
      teachers = teacher_id.filter(id => id);
    } else if (teacher_id) {
      teachers = [teacher_id];
    }

    for (const tid of teachers) {
      await connection.execute(
        'INSERT INTO class_teachers (class_id, teacher_id, assigned_date) VALUES (?, ?, CURDATE())',
        [classId, tid]
      );
    }

    await connection.commit();
    req.session.flash = { success: 'Class updated successfully' };
    res.redirect('/admin/classes');
  } catch (error) {
    await connection.rollback();
    console.error('Edit class error:', error);
    res.redirect('back');
  } finally {
    connection.release();
  }
});

// POST /admin/classes/delete/:id
router.post('/classes/delete/:id', async (req, res) => {
  try {
    await pool.execute('DELETE FROM classes WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Class deleted successfully' });
  } catch (error) {
    console.error('Delete class error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /admin/courses/add
router.post('/courses/add', async (req, res) => {
  try {
    const { name, code, grade, credits, description, teacher_id } = req.body;
    await pool.execute(
      'INSERT INTO courses (course_name, course_code, grade, credits, description, teacher_id) VALUES (?, ?, ?, ?, ?, ?)',
      [name, code, grade || null, credits, description, teacher_id || null]
    );
    req.session.flash = { success: 'Course added successfully' };
    res.redirect('/admin/courses');
  } catch (error) {
    console.error('Add course error:', error);
    res.redirect('back');
  }
});

// POST /admin/courses/edit/:id
router.post('/courses/edit/:id', async (req, res) => {
  try {
    const { name, code, grade, credits, description, teacher_id } = req.body;
    await pool.execute(
      'UPDATE courses SET course_name = ?, course_code = ?, grade = ?, credits = ?, description = ?, teacher_id = ? WHERE id = ?',
      [name, code, grade || null, credits, description, teacher_id || null, req.params.id]
    );
    req.session.flash = { success: 'Course updated successfully' };
    res.redirect('/admin/courses');
  } catch (error) {
    console.error('Edit course error:', error);
    res.redirect('back');
  }
});

// POST /admin/courses/delete/:id
router.post('/courses/delete/:id', async (req, res) => {
  try {
    await pool.execute('DELETE FROM courses WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Course deleted successfully' });
  } catch (error) {
    console.error('Delete course error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /admin/registration/start - Open registration and notify students
router.post('/registration/start', async (req, res) => {
  try {
    const { academic_year, semester } = req.body;
    const adminId = req.session.user.id;

    // Reset all student registration statuses to 'pending' as they need to register now
    await pool.execute("UPDATE students SET registration_status = 'pending'");


    res.redirect('/admin/classes?success=Registration notifications sent to all students');
  } catch (error) {
    console.error('Start registration error:', error);
    res.status(500).send('Error starting registration');
  }
});

// POST /admin/students/confirm-registration/:id - Confirm a student's semester registration
router.post('/students/confirm-registration/:id', async (req, res) => {
  try {
    const studentId = req.params.id;
    await pool.execute("UPDATE students SET registration_status = 'registered' WHERE id = ?", [studentId]);
    res.json({ success: true, message: 'Student marked as registered for the semester' });
  } catch (error) {
    console.error('Confirm registration error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /admin/students/approve-all - Confirm all submitted registrations
router.post('/students/approve-all', async (req, res) => {
  try {
    await pool.execute("UPDATE students SET registration_status = 'registered' WHERE registration_status = 'submitted'");
    res.json({ success: true, message: 'All submitted registrations have been approved' });
  } catch (error) {
    console.error('Approve all error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /admin/enrollments/status/:id - Update enrollment status
router.post('/enrollments/status/:id', async (req, res) => {
  try {
    const { status } = req.body;
    await pool.execute('UPDATE enrollments SET status = ? WHERE id = ?', [status, req.params.id]);
    res.json({ success: true, message: `Status updated to ${status}` });
  } catch (error) {
    console.error('Update enrollment status error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Helper to get system setting
async function getSetting(key, defaultValue = '') {
  try {
    const [rows] = await pool.execute('SELECT setting_value FROM system_settings WHERE setting_key = ?', [key]);
    return rows.length > 0 ? rows[0].setting_value : defaultValue;
  } catch (error) {
    console.error(`Get setting error (${key}):`, error);
    return defaultValue;
  }
}

// Helper to update system setting
async function updateSetting(key, value, category = 'general') {
  try {
    const [existing] = await pool.execute('SELECT id FROM system_settings WHERE setting_key = ?', [key]);
    if (existing.length > 0) {
      await pool.execute('UPDATE system_settings SET setting_value = ?, category = ? WHERE setting_key = ?', [value, category, key]);
    } else {
      await pool.execute('INSERT INTO system_settings (setting_key, setting_value, category) VALUES (?, ?, ?)', [key, value, category]);
    }
  } catch (error) {
    console.error(`Update setting error (${key}):`, error);
  }
}

// GET /admin/announcements - Manage announcements
router.get('/announcements', async (req, res) => {
  try {
    const [announcements] = await pool.execute(`
      SELECT a.*, u.first_name, u.last_name 
      FROM announcements a
      LEFT JOIN users u ON a.created_by = u.id
      ORDER BY a.created_at DESC
    `);

    res.render('admin/announcements', {
      title: 'Manage Announcements',
      user: req.session.user,
      announcements,
      error: null,
      success: req.session.flash ? req.session.flash.success : null
    });
    delete req.session.flash;
  } catch (error) {
    console.error('Announcements error:', error);
    res.status(500).render('500-modern', { title: 'Server Error' });
  }
});

// GET /admin/reports - View reports
router.get('/reports', async (req, res) => {
  try {
    // Basic stats
    const [stats] = await pool.execute(`
      SELECT 
        (SELECT COUNT(*) FROM students WHERE is_active = TRUE) as studentCount,
        (SELECT COUNT(*) FROM teachers WHERE is_active = TRUE) as teacherCount,
        (SELECT COUNT(*) FROM classes WHERE is_active = TRUE) as classCount,
        (SELECT COUNT(*) FROM contact_messages WHERE is_read = FALSE) as unreadMessages
    `);

    // Additional reports data
    const [gradeDistribution] = await pool.execute(`
      SELECT grade_level, COUNT(*) as count 
      FROM students 
      WHERE is_active = TRUE 
      GROUP BY grade_level 
      ORDER BY grade_level
    `);

    const [recentRegistrations] = await pool.execute(`
      SELECT first_name, last_name, role, created_at 
      FROM users 
      ORDER BY created_at DESC 
      LIMIT 10
    `);

    res.render('admin/reports', {
      title: 'System Reports',
      user: req.session.user,
      stats: stats[0],
      gradeDistribution,
      recentRegistrations
    });
  } catch (error) {
    console.error('Reports error:', error);
    res.status(500).render('500-modern', { title: 'Server Error' });
  }
});

// GET /admin/rankings - Student Rankings and Performance
router.get('/rankings', async (req, res) => {
  try {
    const selectedYear = req.query.year || '';
    const selectedGrade = req.query.grade || '';
    const selectedClass = req.query.classId || '';

    // Fetch filter options
    const [years] = await pool.execute('SELECT DISTINCT academic_year FROM classes ORDER BY academic_year DESC');
    const [gradeRows] = await pool.execute('SELECT DISTINCT grade FROM classes ORDER BY CAST(grade AS UNSIGNED)');

    let classQuery = 'SELECT id, name, grade, section FROM classes WHERE 1=1';
    const classParams = [];
    if (selectedYear) {
      classQuery += ' AND academic_year = ?';
      classParams.push(selectedYear);
    }
    classQuery += ' ORDER BY CAST(grade AS UNSIGNED), section';
    const [classes] = await pool.execute(classQuery, classParams);

    // Build ranking query - include all grades (pending + approved) so data always shows
    let query = `
      SELECT 
        s.id AS student_pk,
        u.first_name,
        u.last_name,
        s.student_id,
        c.id AS class_id,
        c.name AS class_name,
        c.grade,
        c.section,
        c.academic_year,
        ROUND(AVG(g.score), 2) AS average_score,
        COUNT(g.id) AS assessments_count
      FROM students s
      JOIN users u ON s.user_id = u.id
      JOIN grades g ON s.id = g.student_id
      JOIN classes c ON g.class_id = c.id
      WHERE s.withdrawal_status = 'active'
    `;
    const params = [];

    if (selectedYear) {
      query += ' AND c.academic_year = ?';
      params.push(selectedYear);
    }
    if (selectedGrade) {
      query += ' AND c.grade = ?';
      params.push(selectedGrade);
    }
    if (selectedClass) {
      query += ' AND c.id = ?';
      params.push(selectedClass);
    }

    // GROUP BY all non-aggregated columns for MySQL strict mode compatibility
    query += `
      GROUP BY s.id, u.first_name, u.last_name, s.student_id,
               c.id, c.name, c.grade, c.section, c.academic_year
      ORDER BY average_score DESC
    `;

    const [rankedStudents] = await pool.execute(query, params);

    // Assign sequential ranks
    rankedStudents.forEach((student, index) => {
      student.rank = index + 1;
    });

    res.render('admin/rankings', {
      title: 'Student Rankings',
      user: req.session.user,
      rankedStudents,
      filters: {
        years: years.map(y => y.academic_year),
        grades: gradeRows.map(g => g.grade),
        classes,
        selectedYear,
        selectedGrade,
        selectedClass
      }
    });
  } catch (error) {
    console.error('Rankings error:', error);
    res.status(500).render('500-modern', { title: 'Server Error', message: error.message });
  }
});

// GET /admin/settings - System settings
router.get('/settings', async (req, res) => {
  try {
    const settings = {
      schoolName: await getSetting('schoolName', 'Abdigudina Elementary School'),
      academicYear: await getSetting('academicYear', '2023-2024'),
      contactEmail: await getSetting('contactEmail', 'admin@abdigudina.edu'),
      phonePrefix: await getSetting('phonePrefix', '+251'),
      semester: await getSetting('semester', '1'),
      attendanceThreshold: await getSetting('attendanceThreshold', '75'),
      passingGrade: await getSetting('passingGrade', '50'),
      regOpen: await getSetting('regOpen', 'on'),
      maintMode: await getSetting('maintMode', 'off')
    };

    res.render('admin/settings', {
      title: 'System Settings',
      user: req.session.user,
      settings,
      success: req.session.flash ? req.session.flash.success : null
    });
    delete req.session.flash;
  } catch (error) {
    console.error('Settings view error:', error);
    res.status(500).render('500-modern', { title: 'Server Error' });
  }
});

// POST /admin/announcements/add
router.post('/announcements/add', async (req, res) => {
  try {
    const { title, message, audience } = req.body;
    await pool.execute(
      'INSERT INTO announcements (title, message, audience, created_by) VALUES (?, ?, ?, ?)',
      [title, message, audience, req.session.user.id]
    );
    req.session.flash = { success: 'Announcement published successfully' };
    res.redirect('/admin/announcements');
  } catch (error) {
    console.error('Add announcement error:', error);
    res.redirect('back');
  }
});

// POST /admin/settings/quick-toggle
router.post('/settings/quick-toggle', async (req, res) => {
  try {
    const { key, value } = req.body;
    if (key === 'regOpen' || key === 'maintMode') {
      await updateSetting(key, value, 'system');

      // Sync regOpen to settings.json instantly
      if (key === 'regOpen') {
        const { updateSettings } = require('../config/settingsControl');
        updateSettings({ publicRegistrationEnabled: value === 'on' });
      }

      return res.json({ success: true, message: 'Setting updated instantly' });
    }
    res.status(400).json({ success: false, message: 'Invalid setting key' });
  } catch (error) {
    console.error('Quick toggle error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /admin/settings/update
router.post('/settings/update', async (req, res) => {
  try {
    const {
      schoolName, academicYear, contactEmail, phonePrefix,
      semester, attendanceThreshold, passingGrade
    } = req.body;

    // Checkboxes are only in body if checked
    const regOpen = req.body.regOpen || 'off';
    const maintMode = req.body.maintMode || 'off';

    await updateSetting('schoolName', schoolName, 'institution');
    await updateSetting('academicYear', academicYear, 'academic');
    await updateSetting('contactEmail', contactEmail, 'institution');
    await updateSetting('phonePrefix', phonePrefix, 'institution');
    await updateSetting('semester', semester, 'academic');
    await updateSetting('attendanceThreshold', attendanceThreshold, 'academic');
    await updateSetting('passingGrade', passingGrade, 'academic');
    await updateSetting('regOpen', regOpen, 'system');
    await updateSetting('maintMode', maintMode, 'system');

    // --- Sync to settings.json so auth.js enforces the registration gate ---
    updateSettings({ publicRegistrationEnabled: regOpen === 'on' });

    req.session.flash = { success: 'Settings updated successfully' };
    res.redirect('/admin/settings');
  } catch (error) {
    console.error('Update settings error:', error);
    res.redirect('back');
  }
});

// POST /admin/toggle-user - Activate/deactivate user
router.post('/toggle-user/:id', async (req, res) => {
  try {
    const userId = req.params.id;
    await pool.execute('UPDATE users SET is_active = NOT is_active WHERE id = ?', [userId]);
    req.session.flash = { success: 'User status updated successfully' };
    res.redirect('back');
  } catch (error) {
    console.error('Toggle user error:', error);
    req.session.flash = { error: 'Failed' };
    res.redirect('back');
  }
});

// POST /admin/delete-user - Delete user
router.post('/delete-user/:id', async (req, res) => {
  try {
    const userId = req.params.id;
    await pool.execute('DELETE FROM users WHERE id = ?', [userId]);
    req.session.flash = { success: 'User deleted successfully' };
    res.redirect('back');
  } catch (error) {
    console.error('Delete user error:', error);
    req.session.flash = { error: 'Failed to delete' };
    res.redirect('back');
  }
});

// 9. Academic Records and Grade Management
router.get('/grades', isAdmin, async (req, res) => {
  try {
    const grade = req.query.grade || '';
    const search = req.query.search || '';

    let query = `
      SELECT g.*, u.first_name, u.last_name, c.name as course_name,
             g.title as assignment_name, g.assessment_type as assignment_type,
             s.student_id as student_reg_id, s.grade_level
      FROM grades g
      JOIN students s ON g.student_id = s.id
      JOIN users u ON s.user_id = u.id
      JOIN classes c ON g.class_id = c.id
      WHERE 1=1
    `;
    const params = [];

    if (grade) {
      query += ' AND s.grade_level = ?';
      params.push(grade);
    }

    if (search) {
      query += ' AND (u.first_name LIKE ? OR u.last_name LIKE ? OR s.student_id LIKE ?)';
      const pattern = `%${search}%`;
      params.push(pattern, pattern, pattern);
    }

    query += " ORDER BY g.status = 'pending' DESC, g.created_at DESC";
    const [grades] = await pool.execute(query, params);

    res.render('admin/grades', {
      title: 'Academic Records',
      user: req.session.user,
      grades,
      filters: { grade, search }
    });
  } catch (error) {
    console.error('Grades error:', error);
    res.status(500).render('500-modern', { title: 'Server Error', message: error.message });
  }
});

// Approve a grade
router.post('/grades/approve/:id', isAdmin, async (req, res) => {
  try {
    await pool.execute('UPDATE grades SET status = "approved" WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Grade approved successfully' });
  } catch (error) {
    console.error('Approve grade error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Reject a grade
router.post('/grades/reject/:id', isAdmin, async (req, res) => {
  try {
    await pool.execute('UPDATE grades SET status = "rejected" WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Grade rejected successfully' });
  } catch (error) {
    console.error('Reject grade error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Delete a grade
router.post('/grades/delete/:id', isAdmin, async (req, res) => {
  try {
    await pool.execute('DELETE FROM grades WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Grade deleted successfully' });
  } catch (error) {
    console.error('Delete grade error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Add a new grade
router.post('/grades/add', isAdmin, async (req, res) => {
  try {
    const { student_id, class_id, title, assessment_type, score, max_score, weight } = req.body;
    await pool.execute(
      'INSERT INTO grades (student_id, class_id, title, assessment_type, score, max_score, weight, status) VALUES (?, ?, ?, ?, ?, ?, ?, "pending")',
      [student_id, class_id, title, assessment_type, score, max_score, weight]
    );
    res.json({ success: true, message: 'Grade added successfully' });
  } catch (error) {
    console.error('Add grade error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Edit an existing grade
router.post('/grades/edit/:id', isAdmin, async (req, res) => {
  try {
    const { student_id, class_id, title, assessment_type, score, max_score, weight } = req.body;
    await pool.execute(
      'UPDATE grades SET student_id = ?, class_id = ?, title = ?, assessment_type = ?, score = ?, max_score = ?, weight = ? WHERE id = ?',
      [student_id, class_id, title, assessment_type, score, max_score, weight, req.params.id]
    );
    res.json({ success: true, message: 'Grade updated successfully' });
  } catch (error) {
    console.error('Edit grade error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get grade details for editing
router.get('/grades/:id', isAdmin, async (req, res) => {
  try {
    const [grade] = await pool.execute('SELECT * FROM grades WHERE id = ?', [req.params.id]);
    if (grade.length > 0) {
      res.json({ success: true, grade: grade[0] });
    } else {
      res.status(404).json({ success: false, message: 'Grade not found' });
    }
  } catch (error) {
    console.error('Get grade details error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});
// GET /admin/enrollments - Manage all student enrollments
router.get('/enrollments', async (req, res) => {
  try {
    const [enrollments] = await pool.execute(`
      SELECT e.*, u.first_name, u.last_name, s.student_id as student_reg_id, c.course_name, c.course_code
      FROM enrollments e
      JOIN students s ON e.student_id = s.id
      JOIN users u ON s.user_id = u.id
      JOIN courses c ON e.course_id = c.id
      ORDER BY e.created_at DESC
    `);

    res.render('admin/enrollments', {
      title: 'Enrollment Management',
      user: req.session.user,
      enrollments,
      success: req.session.flash ? req.session.flash.success : null,
      error: req.session.flash ? req.session.flash.error : null
    });
    if (req.session.flash) delete req.session.flash;
  } catch (error) {
    console.error('Enrollments error:', error);
    res.status(500).render('500-modern', { title: 'Server Error' });
  }
});


// GET /admin/classes/schedule/:id - Manage class schedule
router.get('/classes/schedule/:id', async (req, res) => {
  try {
    const classId = req.params.id;
    const [classInfo] = await pool.execute('SELECT * FROM classes WHERE id = ?', [classId]);
    if (classInfo.length === 0) return res.status(404).render('500-modern', { title: '404', message: 'Class not found' });

    const [schedule] = await pool.execute(`
      SELECT cs.*, c.course_name, c.course_code, c.credits
      FROM class_schedule cs
      JOIN courses c ON cs.course_id = c.id
      WHERE cs.class_id = ?
      ORDER BY FIELD(day_of_week, 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'), start_time
    `, [classId]);

    const [courses] = await pool.execute('SELECT id, course_name, course_code FROM courses WHERE is_active = TRUE AND grade = ? ORDER BY course_name', [classInfo[0].grade]);

    res.render('admin/class-schedule', {
      title: `Schedule: ${classInfo[0].name}`,
      user: req.session.user,
      classInfo: classInfo[0],
      schedule,
      courses,
      success: req.session.flash ? req.session.flash.success : null
    });
    if (req.session.flash) delete req.session.flash;
  } catch (error) {
    console.error('Class schedule error:', error);
    res.status(500).render('500-modern', { title: 'Server Error' });
  }
});

// POST /admin/classes/schedule/add
router.post('/classes/schedule/add', async (req, res) => {
  try {
    const { class_id, course_id, day_of_week, start_time, end_time, room, period } = req.body;
    await pool.execute(
      'INSERT INTO class_schedule (class_id, course_id, day_of_week, start_time, end_time, room, period) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [class_id, course_id, day_of_week, start_time, end_time, room, period]
    );
    req.session.flash = { success: 'Period added successfully' };
    res.redirect(`/admin/classes/schedule/${class_id}`);
  } catch (error) {
    console.error('Add period error:', error);
    res.redirect('back');
  }
});

// POST /admin/classes/schedule/delete/:id
router.post('/classes/schedule/delete/:id', async (req, res) => {
  try {
    const [period] = await pool.execute('SELECT class_id FROM class_schedule WHERE id = ?', [req.params.id]);
    if (period.length > 0) {
      const classId = period[0].class_id;
      await pool.execute('DELETE FROM class_schedule WHERE id = ?', [req.params.id]);
      req.session.flash = { success: 'Period removed' };
      res.redirect(`/admin/classes/schedule/${classId}`);
    } else {
      res.redirect('back');
    }
  } catch (error) {
    console.error('Delete period error:', error);
    res.redirect('back');
  }
});

// GET /admin/profile - View admin profile
router.get('/profile', async (req, res) => {
  try {
    res.render('admin/profile', {
      title: 'Admin Profile',
      user: req.session.user
    });
  } catch (error) {
    console.error('Admin profile error:', error);
    res.status(500).render('500-modern', { title: 'Server Error' });
  }
});

// --- Transcript Generation System ---

// GET /admin/transcripts - Search and manage transcripts
router.get('/transcripts', async (req, res) => {
  try {
    const search = req.query.search || '';
    const grade = req.query.grade || '';

    let query = `
            SELECT u.first_name, u.last_name, s.id, s.student_id, s.grade_level, s.section
            FROM students s
            JOIN users u ON s.user_id = u.id
            WHERE 1=1
        `;
    const params = [];
    if (search) {
      query += ' AND (u.first_name LIKE ? OR u.last_name LIKE ? OR s.student_id LIKE ?)';
      const pattern = `%${search}%`;
      params.push(pattern, pattern, pattern);
    }
    if (grade) {
      query += ' AND s.grade_level = ?';
      params.push(grade);
    }
    query += ' ORDER BY s.grade_level ASC, s.section ASC LIMIT 50';
    const [students] = await pool.execute(query, params);

    res.render('admin/transcripts', {
      title: 'Transcript Management',
      user: req.session.user,
      students,
      search,
      grade,
      filters: { search, grade }
    });
  } catch (error) {
    console.error('Transcripts search error:', error);
    res.status(500).render('500-modern', { title: 'Server Error' });
  }
});

// GET /admin/transcripts/generate/:id - Generate full transcript
router.get('/transcripts/generate/:id', async (req, res) => {
  try {
    const studentId = req.params.id;

    // 1. Get student basic info (explicitly select to avoid collisions)
    const [studentData] = await pool.execute(`
            SELECT 
                u.first_name, u.last_name, 
                s.gender, s.id, s.student_id, s.grade_level, s.section, s.date_of_birth, s.enrollment_date
            FROM users u
            JOIN students s ON u.id = s.user_id
            WHERE s.id = ?
        `, [studentId]);

    if (studentData.length === 0) return res.status(404).send('Student not found');
    const student = studentData[0];

    // 2. Collect all academic history (Years/Semesters)
    const [history] = await pool.execute(`
            SELECT * FROM academic_history 
            WHERE student_id = ? 
            ORDER BY academic_year DESC
        `, [studentId]);

    // 3. Get all detailed grades joined with classes (for year/sem) and courses (for names)
    const [grades] = await pool.execute(`
            SELECT 
                g.*,
                COALESCE(c.course_name, cl.name) as class_name,
                cl.academic_year,
                cl.semester,
                cl.grade as grade_level
            FROM grades g
            JOIN classes cl ON g.class_id = cl.id
            LEFT JOIN courses c ON g.course_id = c.id
            WHERE g.student_id = ? AND g.status = 'approved'
            ORDER BY cl.academic_year ASC, cl.semester ASC
        `, [studentId]);

    // 4. Get national exam results
    const [nationalExams] = await pool.execute(`
            SELECT * FROM national_exams WHERE student_id = ?
        `, [studentId]);

    // 5. Generate transcript number
    let transcriptNum = `TS-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;
    const [existingTs] = await pool.execute('SELECT transcript_number FROM transcripts WHERE student_id = ?', [studentId]);
    if (existingTs.length > 0) transcriptNum = existingTs[0].transcript_number;

    // 6. Get School Name from settings
    const schoolName = await getSetting('schoolName', 'Abdigudina Elementary School');

    res.render('admin/transcript-generate', {
      title: 'Generate Transcript',
      user: req.session.user,
      student,
      history,
      grades,
      nationalExams,
      transcriptNum,
      schoolName,
      today: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
    });
  } catch (error) {
    console.error('CRITICAL Transcript generation error:', error);
    res.status(500).render('500-modern', {
      title: 'Server Error',
      error: process.env.NODE_ENV === 'development' ? error : {},
      message: 'An error occurred during transcript generation. Please check the server logs.'
    });
  }
});

// POST /admin/transcripts/national-exams - Save national exam results
router.post('/transcripts/national-exams', async (req, res) => {
  try {
    const { student_id, exam_type, academic_year, total_score, remarks } = req.body;
    await pool.execute(`
            INSERT INTO national_exams (student_id, exam_type, academic_year, total_score, remarks)
            VALUES (?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE 
                academic_year = VALUES(academic_year),
                total_score = VALUES(total_score),
                remarks = VALUES(remarks)
        `, [student_id, exam_type, academic_year, total_score, remarks || null]);

    res.json({ success: true, message: 'National exam result saved' });
  } catch (error) {
    console.error('Save national exam error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /admin/profile/update - Update admin profile
router.post('/profile/update', async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { first_name, last_name, email } = req.body;

    await pool.execute(
      'UPDATE users SET first_name = ?, last_name = ?, email = ? WHERE id = ?',
      [first_name, last_name, email, userId]
    );

    // Update session
    req.session.user.first_name = first_name;
    req.session.user.last_name = last_name;
    req.session.user.email = email;

    res.redirect('/admin/profile');
  } catch (error) {
    console.error('Admin profile update error:', error);
    res.redirect('back');
  }
});

// --- Data Backup & Restore ---
const backupUpload = multer({ dest: './backups/' });

// GET /admin/backup - Generate full JSON backup
router.get('/backup', async (req, res) => {
  try {
    const [tables] = await pool.execute('SHOW TABLES');
    const dbName = 'student_registration_system';
    const backupData = {};

    for (let tableObj of tables) {
      const tableName = tableObj[`Tables_in_${dbName}`];
      const [rows] = await pool.execute(`SELECT * FROM ${tableName}`);
      backupData[tableName] = rows;
    }

    const fileName = `Abdigudina_Backup_${new Date().toISOString().split('T')[0]}.json`;
    res.setHeader('Content-disposition', 'attachment; filename=' + fileName);
    res.setHeader('Content-type', 'application/json');
    res.write(JSON.stringify(backupData, null, 2));
    res.end();
  } catch (error) {
    console.error('Backup error:', error);
    res.status(500).send('Backup failed: ' + error.message);
  }
});

// POST /admin/restore - Restore from JSON backup
router.post('/restore', backupUpload.single('backupFile'), async (req, res) => {
  const connection = await pool.getConnection();
  try {
    if (!req.file) throw new Error('No backup file provided');

    const backupData = JSON.parse(fs.readFileSync(req.file.path, 'utf8'));
    await connection.beginTransaction();

    // 1. Disable foreign key checks for clean wipe
    await connection.execute('SET FOREIGN_KEY_CHECKS = 0');

    // 2. Clear and Restore tables in order (reversed for users last)
    const tables = Object.keys(backupData);
    for (let tableName of tables) {
      await connection.execute(`DELETE FROM ${tableName}`);
      if (backupData[tableName].length > 0) {
        const columns = Object.keys(backupData[tableName][0]);
        const valuesPlaceholder = columns.map(() => '?').join(', ');
        const insertQuery = `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${valuesPlaceholder})`;

        for (let row of backupData[tableName]) {
          const values = columns.map(col => row[col]);
          await connection.execute(insertQuery, values);
        }
      }
    }

    // 3. Re-enable foreign key checks
    await connection.execute('SET FOREIGN_KEY_CHECKS = 1');
    await connection.commit();

    fs.unlinkSync(req.file.path); // Cleanup
    req.session.flash = { success: 'System restored successfully from backup' };
    res.redirect('/admin/settings');
  } catch (error) {
    await connection.rollback();
    await connection.execute('SET FOREIGN_KEY_CHECKS = 1');
    console.error('Restore error:', error);
    res.status(500).send('Restore failed: ' + error.message);
  } finally {
    connection.release();
  }
});

// GET /admin/promotions - Preview student promotions
router.get('/promotions', async (req, res) => {
  try {
    // 1. Get passing grade from settings
    const [settings] = await pool.execute('SELECT setting_value FROM system_settings WHERE setting_key = "passingGrade"');
    const passingGrade = settings.length > 0 ? parseFloat(settings[0].setting_value) : 50.0;

    // 2. Fetch all active students with their average approved grades for the current cycle
    const [students] = await pool.execute(`
            SELECT 
                s.id, s.student_id, s.grade_level, s.withdrawal_status,
                u.first_name, u.last_name,
                (SELECT AVG(score) FROM grades WHERE student_id = s.id AND status = 'approved') as average_score
            FROM students s
            JOIN users u ON s.user_id = u.id
            WHERE u.is_active = TRUE
        `);

    // 3. Apply promotion rules
    const previewList = students.map(student => {
      let decision = 'Retained';
      if (student.withdrawal_status === 'withdrawn') {
        decision = 'Excluded';
      } else if (student.average_score >= passingGrade) {
        if (student.grade_level >= 8) {
          decision = 'Graduated';
        } else {
          decision = 'Promoted';
        }
      }
      return { ...student, decision };
    });

    res.render('admin/promotions', {
      title: 'Student Promotions',
      user: req.session.user,
      students: previewList,
      passingGrade
    });
  } catch (error) {
    console.error('Promotions preview error:', error);
    res.status(500).render('500-modern', { title: 'Server Error' });
  }
});

// POST /admin/promotions/process - Execute promotions
router.post('/promotions/process', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // 1. Get settings
    const [settings] = await connection.execute('SELECT setting_value FROM system_settings WHERE setting_key = "academicYear"');
    const currentYear = settings.length > 0 ? settings[0].setting_value : '2023-2024';

    const [passSettings] = await connection.execute('SELECT setting_value FROM system_settings WHERE setting_key = "passingGrade"');
    const passingGrade = passSettings.length > 0 ? parseFloat(passSettings[0].setting_value) : 50.0;

    // 2. Fetch students
    const [students] = await connection.execute(`
            SELECT s.id, s.grade_level, s.withdrawal_status,
            (SELECT AVG(score) FROM grades WHERE student_id = s.id AND status = 'approved') as average_score
            FROM students s
            JOIN users u ON s.user_id = u.id
            WHERE u.is_active = TRUE
        `);

    for (let student of students) {
      let status = 'retained';
      let nextGrade = student.grade_level;
      let isActive = true;

      if (student.withdrawal_status === 'withdrawn') {
        status = 'withdrawn';
        isActive = false;
      } else if (student.average_score >= passingGrade) {
        if (student.grade_level >= 8) {
          status = 'graduated';
          isActive = false;
        } else {
          status = 'promoted';
          nextGrade = student.grade_level + 1;
        }
      }

      // A. Store in academic history
      await connection.execute(`
                INSERT INTO academic_history (student_id, academic_year, grade_level, average_score, status)
                VALUES (?, ?, ?, ?, ?)
            `, [student.id, currentYear, student.grade_level, student.average_score || 0, status]);

      // B. Update Student record
      await connection.execute(`
                UPDATE students SET grade_level = ? WHERE id = ?
            `, [nextGrade, student.id]);

      // C. If graduated or withdrawn, deactivate user
      if (!isActive) {
        await connection.execute(`
                    UPDATE users SET is_active = FALSE WHERE id = (SELECT user_id FROM students WHERE id = ?)
                `, [student.id]);
      }
    }

    await connection.commit();
    req.session.flash = { success: 'End-of-year promotion process completed successfully' };
    res.redirect('/admin/promotions');
  } catch (error) {
    await connection.rollback();
    console.error('Promotion process error:', error);
    res.status(500).send('Promotion failed: ' + error.message);
  } finally {
    connection.release();
  }
});

module.exports = router;
