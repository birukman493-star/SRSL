const express = require('express');
const { pool } = require('../config/db');
const bcrypt = require('bcryptjs');
const { updateSettings } = require('../config/settingsControl');
const router = express.Router();

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

    let query = `
      SELECT u.id, u.username, u.email, u.first_name, u.last_name, u.role, u.is_active, u.phone, u.created_at,
             s.grade_level, t.department
      FROM users u
      LEFT JOIN students s ON u.id = s.user_id
      LEFT JOIN teachers t ON u.id = t.user_id
      WHERE 1=1
    `;
    const params = [];

    if (role) {
      query += ' AND u.role = ?';
      params.push(role);
    }
    if (status) {
      query += ' AND u.is_active = ?';
      params.push(status === 'active');
    }
    if (search) {
      query += ' AND (u.username LIKE ? OR u.first_name LIKE ? OR u.last_name LIKE ? OR u.email LIKE ?)';
      const searchPattern = `%${search}%`;
      params.push(searchPattern, searchPattern, searchPattern, searchPattern);
    }

    query += ' ORDER BY u.created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const [users] = await pool.execute(query, params);
    
    // Get total count for pagination
    let countQuery = 'SELECT COUNT(*) as total FROM users u WHERE 1=1';
    const countParams = [];
    if (role) {
      countQuery += ' AND u.role = ?';
      countParams.push(role);
    }
    if (status) {
      countQuery += ' AND u.is_active = ?';
      countParams.push(status === 'active');
    }
    if (search) {
      countQuery += ' AND (u.username LIKE ? OR u.first_name LIKE ? OR u.last_name LIKE ? OR u.email LIKE ?)';
      countParams.push(searchPattern, searchPattern, searchPattern, searchPattern);
    }
    const [countResult] = await pool.execute(countQuery, countParams);
    const totalUsers = countResult[0].total;
    const totalPages = Math.ceil(totalUsers / limit);

    res.render('admin/users', {
      title: 'User Management',
      user: req.session.user || {},
      users,
      currentPage: page,
      totalPages: totalPages || 1,
      filters: { role, status, search }
    });
  } catch (error) {
    console.error('Users management error:', error);
    res.status(500).render('500-modern', { title: 'Server Error', message: error.message });
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
  console.log('>>> ADMIN DASHBOARD: Route Hit');
  try {
        // Get system statistics
        const [stats] = await pool.execute(`
          SELECT 
            (SELECT COUNT(*) FROM students WHERE is_active = TRUE) as students,
            (SELECT COUNT(*) FROM teachers WHERE is_active = TRUE) as teachers,
            (SELECT COUNT(*) FROM parents) as parents,
            (SELECT COUNT(*) FROM courses WHERE is_active = TRUE) as courses,
            (SELECT COUNT(*) FROM enrollments WHERE status = 'enrolled') as enrollments
        `);

        // Get recent activities (recent user registrations)
        const [recentActivities] = await pool.execute(`
          SELECT username as description, created_at as activity_date
          FROM users 
          ORDER BY created_at DESC 
          LIMIT 5
        `);
        
        res.render('admin/dashboard', {
            title: 'Admin Dashboard',
            user: req.session.user || {},
            stats: (stats && stats[0]) ? stats[0] : { students: 0, teachers: 0, parents: 0, courses: 0, enrollments: 0 },
            recentActivities: recentActivities || []
        });
    } catch (err) {
        console.error('Dashboard error:', err);
        res.render('admin/dashboard', {
            title: 'Admin Dashboard',
            user: req.session.user || {},
            stats: { students: 0, teachers: 0, parents: 0, courses: 0, enrollments: 0 },
            recentActivities: []
        });
    }
});

// GET /admin/students - Manage students
router.get('/students', async (req, res) => {
  try {
    const [students] = await pool.execute(`
      SELECT u.id, u.username, u.email, u.first_name, u.last_name, u.phone, u.created_at, u.is_active,
             s.id as student_profile_id, s.student_id, s.grade_level, s.section, s.registration_status
      FROM users u
      LEFT JOIN students s ON u.id = s.user_id
      WHERE u.role = 'student'
      ORDER BY u.created_at DESC
    `);
    
    res.render('admin/students', {
      title: 'Manage Students',
      user: req.session.user,
      students,
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
    const [teachers] = await pool.execute(`
      SELECT u.id, u.username, u.email, u.first_name, u.last_name, u.phone, u.created_at, u.is_active,
             t.employee_id, t.department
      FROM users u
      LEFT JOIN teachers t ON u.id = t.user_id
      WHERE u.role = 'teacher'
      ORDER BY u.created_at DESC
    `);
    
    res.render('admin/teachers', {
      title: 'Manage Teachers',
      user: req.session.user,
      teachers,
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
    const [attendance] = await pool.execute(`
      SELECT a.*, u.first_name, u.last_name, c.name as class_name
      FROM attendance a
      JOIN students s ON a.student_id = s.id
      JOIN users u ON s.user_id = u.id
      JOIN classes c ON a.class_id = c.id
      ORDER BY a.date DESC
      LIMIT 200
    `);
    
    // Compute aggregate stats (present, late, and excused all count as attended)
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
      stats
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
router.post('/students/register', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    
    const { 
      username, email, password, firstName, lastName, phone,
      studentId, gradeLevel, section, dateOfBirth, gender, enrollmentDate,
      parentGuardianName, relationship, parentPhone, parentEmail
    } = req.body;

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
      VALUES (?, ?, ?, ?, ?, 'student', ?)
    `, [username, email, hashedPassword, firstName, lastName, phone]);
    
    const userId = userResult.insertId;

    // 2. Create Student Profile
    const [studentResult] = await connection.execute(`
      INSERT INTO students (
        user_id, student_id, first_name, last_name, email, phone, 
        grade_level, section, date_of_birth, gender, enrollment_date, parent_guardian_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      userId, studentId, firstName, lastName, email, phone,
      gradeLevel, section, dateOfBirth, gender, enrollmentDate, parentGuardianName
    ]);
    const studentDbId = studentResult.insertId;

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
            const [pProfileResult] = await connection.execute(`
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
    req.session.flash = { success: 'Student registered successfully' };
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

// POST /admin/teachers/add - Add a new teacher
router.post('/teachers/add', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const {
      username, email, password, firstName, lastName, phone,
      employeeId, department, hireDate, qualification, subjects
    } = req.body;

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

    // 2. Create Teacher Profile
    await connection.execute(`
      INSERT INTO teachers (
        user_id, employee_id, first_name, last_name, email, phone, 
        department, hire_date
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      userId, employeeId, firstName, lastName, email, phone,
      department, hireDate
    ]);

    await connection.commit();
    req.session.flash = { success: 'Teacher added successfully' };
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
    const [classes] = await pool.execute(`
      SELECT c.*, t.first_name as teacher_first, t.last_name as teacher_last,
             (SELECT COUNT(*) FROM students WHERE grade_level = c.grade AND section = c.section) as current_students
      FROM classes c
      LEFT JOIN teachers t ON c.teacher_id = t.id
      ORDER BY c.grade, c.section
    `);
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
    const [courses] = await pool.execute(`
      SELECT c.*, t.first_name as teacher_first, t.last_name as teacher_last
      FROM courses c
      LEFT JOIN teachers t ON c.teacher_id = t.id
      ORDER BY c.course_name
    `);
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
  try {
    const { name, grade, section, teacher_id, academic_year, semester } = req.body;
    await pool.execute(
      'INSERT INTO classes (name, grade, section, teacher_id, academic_year, semester) VALUES (?, ?, ?, ?, ?, ?)',
      [name, grade, section, teacher_id || null, academic_year || '2023-2024', semester || '1']
    );
    req.session.flash = { success: 'Class created successfully' };
    res.redirect('/admin/classes');
  } catch (error) {
    console.error('Add class error:', error);
    res.redirect('back');
  }
});

// POST /admin/classes/edit/:id
router.post('/classes/edit/:id', async (req, res) => {
  try {
    const { name, grade, section, teacher_id, academic_year, semester } = req.body;
    await pool.execute(
      'UPDATE classes SET name = ?, grade = ?, section = ?, teacher_id = ?, academic_year = ?, semester = ? WHERE id = ?',
      [name, grade, section, teacher_id || null, academic_year || '2023-2024', semester || '1', req.params.id]
    );
    req.session.flash = { success: 'Class updated successfully' };
    res.redirect('/admin/classes');
  } catch (error) {
    console.error('Edit class error:', error);
    res.redirect('back');
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
    const { name, code, credits, description, teacher_id } = req.body;
    await pool.execute(
      'INSERT INTO courses (course_name, course_code, credits, description, teacher_id) VALUES (?, ?, ?, ?, ?)',
      [name, code, credits, description, teacher_id || null]
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
    const { name, code, credits, description, teacher_id } = req.body;
    await pool.execute(
      'UPDATE courses SET course_name = ?, course_code = ?, credits = ?, description = ?, teacher_id = ? WHERE id = ?',
      [name, code, credits, description, teacher_id || null, req.params.id]
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

// GET /admin/courses/prerequisites/:id - Get prerequisites for a course
router.get('/courses/prerequisites/:id', async (req, res) => {
  try {
    const [prereqs] = await pool.execute(`
      SELECT cp.*, c.course_name, c.course_code
      FROM course_prerequisites cp
      JOIN courses c ON cp.prerequisite_id = c.id
      WHERE cp.course_id = ?
    `, [req.params.id]);
    res.json({ success: true, prerequisites: prereqs });
  } catch (error) {
    console.error('Get prerequisites error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /admin/courses/prerequisites/add
router.post('/courses/prerequisites/add', async (req, res) => {
  try {
    const { course_id, prerequisite_id } = req.body;
    if (course_id === prerequisite_id) {
       return res.status(400).json({ success: false, message: 'A course cannot be its own prerequisite' });
    }
    await pool.execute(
      'INSERT INTO course_prerequisites (course_id, prerequisite_id) VALUES (?, ?)',
      [course_id, prerequisite_id]
    );
    res.json({ success: true, message: 'Prerequisite added successfully' });
  } catch (error) {
    console.error('Add prerequisite error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /admin/courses/prerequisites/delete/:id
router.post('/courses/prerequisites/delete/:id', async (req, res) => {
  try {
    await pool.execute('DELETE FROM course_prerequisites WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Prerequisite removed' });
  } catch (error) {
    console.error('Delete prerequisite error:', error);
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

    // Create a special registration announcement
    await pool.execute(`
      INSERT INTO announcements (title, message, audience, created_by)
      VALUES (?, ?, ?, ?)
    `, [
      `Registration Open: ${academic_year} Semester ${semester}`,
      "registration", // Special keyword for student UI detection
      'all',
      adminId
    ]);

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

// GET /admin/settings - System settings
router.get('/settings', async (req, res) => {
  try {
    const settings = {
        schoolName: await getSetting('schoolName', 'SRSL International School'),
        academicYear: await getSetting('academicYear', '2023-2024'),
        contactEmail: await getSetting('contactEmail', 'admin@srsl-school.com'),
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
    const [grades] = await pool.execute(`
      SELECT g.*, u.first_name, u.last_name, c.name as course_name,
             g.title as assignment_name, g.assessment_type as assignment_type,
             s.student_id as student_reg_id
      FROM grades g
      JOIN students s ON g.student_id = s.id
      JOIN users u ON s.user_id = u.id
      JOIN classes c ON g.class_id = c.id
      ORDER BY g.status = 'pending' DESC, g.created_at DESC
    `);

    res.render('admin/grades', {
      title: 'Academic Records',
      user: req.session.user,
      grades
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
      SELECT cs.*, c.course_name, c.course_code
      FROM class_schedule cs
      JOIN courses c ON cs.course_id = c.id
      WHERE cs.class_id = ?
      ORDER BY FIELD(day_of_week, 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'), start_time
    `, [classId]);

    const [courses] = await pool.execute('SELECT id, course_name, course_code FROM courses WHERE is_active = TRUE');

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

module.exports = router;
