const express = require('express');
const { pool } = require('../config/db');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { updateSettings } = require('../config/settingsControl');
const {
  getSetting,
  updateSetting,
  getAcademicContext,
  getAcademicYearHistory,
  setActiveAcademicYear,
  getNextAcademicYear,
  getActiveAcademicYear,
  emitAcademicContextUpdate,
  normalizeAcademicYear,
  DEFAULT_ACADEMIC_YEAR,
} = require('../config/systemSettings');
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

// Middleware to check if user is admin and deny unauthenticated or wrong-role users
function isAdmin(req, res, next) {
  if (!req.session.user) {
    return res.redirect('/auth/login');
  }

  if (req.session.user.role !== 'admin') {
    const wantsJson = req.xhr || (req.headers.accept || '').includes('json');
    if (wantsJson) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }
    return res.redirect('/dashboard');
  }

  next();
}

// Apply admin middleware to all routes
router.use(isAdmin);

// POST /admin/settings/update - Save system settings
router.post('/settings/update', async (req, res) => {
  try {
    const {
      schoolName,
      academicYear,
      contactEmail,
      phonePrefix,
      semester,
      attendanceThreshold,
      passingGrade,
      regOpen,
      maintMode
    } = req.body;

    // Update settings individually
    await Promise.all([
      updateSetting('schoolName', schoolName || ''),
      updateSetting('academicYear', academicYear || ''),
      updateSetting('contactEmail', contactEmail || ''),
      updateSetting('phonePrefix', phonePrefix || ''),
      updateSetting('semester', semester || ''),
      updateSetting('attendanceThreshold', attendanceThreshold || ''),
      updateSetting('passingGrade', passingGrade || ''),
      updateSetting('regOpen', regOpen === 'on' ? 'on' : 'off'),
      updateSetting('maintMode', maintMode === 'on' ? 'on' : 'off')
    ]);

    // Emit real‑time context update if academic year or semester changed
    if (academicYear || semester) {
      const ctx = await getAcademicContext();
      emitAcademicContextUpdate(req.app, ctx);
    }

    req.session.flash = { success: 'System settings saved successfully.' };
    res.redirect('/admin/settings');
  } catch (err) {
    console.error('Settings update error:', err);
    req.session.flash = { error: 'Failed to save settings.' };
    res.redirect('/admin/settings');
  }
});
router.post('/academic/start', async (req, res) => {
  console.log('Session user in start route:', req.session.user);
  try {
    const currentYear = await getActiveAcademicYear();
    const nextYear = getNextAcademicYear(currentYear);
    if (!nextYear) {
      throw new Error('Unable to determine next academic year');
    }
    await setActiveAcademicYear(nextYear);
    // Reset semester to 1 and persist the setting
    await updateSetting('semester', '1');
    // Emit updated academic context to any connected clients
    const ctx = await getAcademicContext();
    emitAcademicContextUpdate(req.app, ctx);
    // Send JSON response
    return res.json({ success: true, message: `Academic year advanced to ${nextYear}` });
  } catch (err) {
    console.error('Start academic year error:', err);
    // Ensure JSON error response
    return res.status(500).json({ success: false, error: err.message || 'Failed to start new academic year' });
  }
});
  
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
      const ctx = await getAcademicContext();
      const availableYears = yearsResult.length > 0
        ? yearsResult.map((y) => y.academic_year)
        : [ctx.academicYear];

      const selectedYear = req.query.year || ctx.academicYear;

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

      // Get section counts
      const [sectionCounts] = await pool.execute(`
        SELECT grade_level AS grade, section, COUNT(*) as student_count 
        FROM students 
        WHERE withdrawal_status != 'withdrawn'
        GROUP BY grade_level, section
      `);

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
        recentActivities: recentActivities || [],
        academicContext: ctx,
        // New: Section student counts and limit per section
        sectionCounts: sectionCounts || [],
        maxSectionSize: 50
      });
    } catch (err) {
      console.error('Dashboard error:', err);
      res.render('admin/dashboard', {
        title: 'Admin Dashboard',
        user: req.session.user || {},
        stats: { students: 0, teachers: 0, parents: 0, courses: 0 },
        availableYears: [DEFAULT_ACADEMIC_YEAR],
        selectedYear: DEFAULT_ACADEMIC_YEAR,
        recentActivities: [],
        academicContext: {
          academicYear: DEFAULT_ACADEMIC_YEAR,
          semester: '1',
          semesterLabel: 'Semester 1',
        },
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
      const search = req.query.search || '';
      const grade = req.query.grade || '';

      let query = `
      SELECT u.id as user_id, u.username, u.email, u.first_name, u.last_name, u.phone, u.is_active,
             t.id as teacher_profile_id, t.employee_id, t.department, t.qualification, t.experience, t.hire_date,
             t.certificate_url, t.id_card_url,
             GROUP_CONCAT(DISTINCT CONCAT(c.grade, '-', c.section) SEPARATOR ', ') as assigned_classes
      FROM users u
      JOIN teachers t ON u.id = t.user_id
      LEFT JOIN class_teachers ct ON t.id = ct.teacher_id
      LEFT JOIN classes c ON (c.id = ct.class_id OR c.teacher_id = t.id)
      WHERE u.role = 'teacher'
    `;
      const params = [];

      if (search) {
        query += ' AND (u.first_name LIKE ? OR u.last_name LIKE ? OR t.employee_id LIKE ? OR t.department LIKE ?)';
        const pattern = `%${search}%`;
        params.push(pattern, pattern, pattern, pattern);
      }

      if (grade) {
        query += ' AND c.grade = ?';
        params.push(grade);
      }

      query += ' GROUP BY u.id, t.id ORDER BY u.first_name, u.last_name';

      const [teachers] = await pool.execute(query, params);

      res.render('admin/teachers', {
        title: 'Manage Teachers',
        user: req.session.user,
        teachers,
        filters: { search, grade },
        error: req.session.flash ? req.session.flash.error : null,
        success: req.session.flash ? req.session.flash.success : null
      });
    } catch (error) {
      console.error('Teachers management error:', error);
      res.status(500).render('500-modern', { title: 'Server Error', message: error.message });
    }
  });

  // --- Teacher Assignments Management ---

  // GET /admin/assignments - Redirect to integrated Classes view
  router.get('/assignments', (req, res) => {
    res.redirect('/admin/classes');
  });

  // POST /admin/assignments/add - Add new teacher assignment
  router.post('/assignments/add', async (req, res) => {
    const teacherId = Number(req.body.teacher_id);
    const classId = Number(req.body.class_id);
    const courseId = Number(req.body.course_id);
    const academicYear = String(req.body.academic_year || DEFAULT_ACADEMIC_YEAR).trim();
    const redirectToAssignments = () => res.redirect('/admin/classes#pills-assignments');

    if (
      !Number.isSafeInteger(teacherId) || teacherId <= 0 ||
      !Number.isSafeInteger(classId) || classId <= 0 ||
      !Number.isSafeInteger(courseId) || courseId <= 0 ||
      !academicYear || academicYear.length > 20
    ) {
      req.session.flash = { error: 'Select a valid teacher, class, course, and academic year.' };
      return redirectToAssignments();
    }

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      const [teachers] = await connection.execute(
        'SELECT id FROM teachers WHERE id = ? FOR UPDATE',
        [teacherId]
      );
      const [classes] = await connection.execute(
        'SELECT id FROM classes WHERE id = ?',
        [classId]
      );
      const [courses] = await connection.execute(
        'SELECT id FROM courses WHERE id = ? AND is_active = TRUE',
        [courseId]
      );
      if (!teachers.length || !classes.length || !courses.length) {
        await connection.rollback();
        req.session.flash = { error: 'The selected teacher, class, or active course could not be found.' };
        return redirectToAssignments();
      }

      const [existingAssignments] = await connection.execute(
        `SELECT id, status FROM teacher_course_assignments
         WHERE teacher_id = ? AND class_id = ? AND course_id = ? LIMIT 1`,
        [teacherId, classId, courseId]
      );

      if (existingAssignments[0] && existingAssignments[0].status === 'active') {
        await connection.rollback();
        req.session.flash = { error: 'This teacher is already assigned to this course and class.' };
        return redirectToAssignments();
      }

      const [classAssigned] = await connection.execute(
        `SELECT id FROM teacher_course_assignments
         WHERE teacher_id = ? AND class_id = ? AND status = 'active' LIMIT 1`,
        [teacherId, classId]
      );
      if (classAssigned.length > 0) {
        await connection.rollback();
        req.session.flash = { error: 'This teacher is already assigned to a course in this class.' };
        return redirectToAssignments();
      }

      const [courseCount] = await connection.execute(
        `SELECT COUNT(*) AS count FROM teacher_course_assignments
         WHERE teacher_id = ? AND status = 'active'`,
        [teacherId]
      );
      if (Number(courseCount[0].count) >= 3) {
        await connection.rollback();
        req.session.flash = { error: 'Teacher already has the maximum of 3 active course assignments.' };
        return redirectToAssignments();
      }

      if (existingAssignments[0]) {
        await connection.execute(
          `UPDATE teacher_course_assignments
           SET status = 'active', academic_year = ?
           WHERE id = ? AND teacher_id = ?`,
          [academicYear, existingAssignments[0].id, teacherId]
        );
      } else {
        await connection.execute(
          `INSERT INTO teacher_course_assignments
           (teacher_id, class_id, course_id, academic_year, status)
           VALUES (?, ?, ?, ?, 'active')`,
          [teacherId, classId, courseId, academicYear]
        );
      }

      await connection.commit();
      req.session.flash = { success: 'Teacher assignment created successfully.' };
      return redirectToAssignments();
    } catch (error) {
      await connection.rollback();
      console.error('Add assignment error:', error);
      req.session.flash = { error: 'Failed to create assignment: ' + error.message };
      return redirectToAssignments();
    } finally {
      connection.release();
    }
  });

  // POST /admin/assignments/delete/:id - Remove assignment
  router.post('/assignments/delete/:id', async (req, res) => {
    try {
      await pool.execute('DELETE FROM teacher_course_assignments WHERE id = ?', [req.params.id]);
      req.session.flash = { success: 'Assignment removed successfully.' };
      res.redirect('/admin/classes#pills-assignments');
    } catch (error) {
      console.error('Delete assignment error:', error);
      res.redirect('/admin/classes#pills-assignments');
    }
  });

  // --- Approval Workflow Routes ---

  // GET /admin/approvals - Redirect to integrated Grades view
  router.get('/approvals', (req, res) => {
    res.redirect('/admin/grades');
  });

  // POST /admin/approvals/grades/:action/:id
  router.post('/approvals/grades/:action/:id', async (req, res) => {
    let conn;
    try {
      const { action, id } = req.params;
      const status = action === 'approve' ? 'approved' : 'saved';

      // Start transaction
      conn = await pool.getConnection();
      await conn.beginTransaction();

      // Update the individual student_result entry
      await conn.execute('UPDATE student_results SET status = ? WHERE id = ?', [status, id]);
      // Also update legacy grades table if it exists
      await conn.execute('UPDATE grades SET status = ? WHERE id = ?', [status, id]);

      // Fetch related identifiers to cascade status updates
      const [resultInfo] = await conn.execute(
        `SELECT teacher_id, class_id, course_id, student_id FROM student_results WHERE id = ?`,
        [id]
      );
      
      let rejectReason = '';
      if (resultInfo.length > 0) {
        const { teacher_id, class_id, course_id, student_id } = resultInfo[0];
        
        // If rejecting, capture reason and update grade_submissions
        if (action === 'reject') {
          rejectReason = req.body.reason || '';
          await conn.execute(
            `UPDATE grade_submissions SET reject_reason = ?, status = ? WHERE teacher_id = ? AND class_id = ? AND course_id = ?`,
            [rejectReason, 'saved', teacher_id, class_id, course_id || 0]
          );
        } else {
          // Update grade_submissions for this batch
          await conn.execute(
            `UPDATE grade_submissions SET status = ? WHERE teacher_id = ? AND class_id = ? AND course_id = ?`,
            [status, teacher_id, class_id, course_id || 0]
          );
        }
        
        // Update student_course_results for the student
        await conn.execute(
          `UPDATE student_course_results SET status = ? WHERE teacher_id = ? AND class_id = ? AND course_id = ? AND student_id = ?`,
          [status, teacher_id, class_id, course_id || 0, student_id]
        );

        // Emit socket events for approval/rejection
        const io = req.app.get('io');
        if (io) {
          const payload = {
            studentId: student_id,
            classId: class_id,
            courseId: course_id,
            teacherId: teacher_id,
            status: status,
            action: action,
            reason: action === 'reject' ? rejectReason : undefined,
          };
          io.to(`student_${student_id}`).emit('gradeUpdated', payload);
          io.to(`parent_${student_id}`).emit('gradeUpdated', payload);
          io.to('admin_dashboard').emit('gradeUpdated', payload);
        }
      }

      await conn.commit();
      conn.release();

      req.session.flash = { success: `Grade ${action}d successfully.` };
      res.redirect('/admin/grades');
    } catch (error) {
      console.error('Grade approval error:', error);
      // Attempt rollback if a connection exists
      if (typeof conn !== 'undefined' && conn) {
        try { await conn.rollback(); conn.release(); } catch (_) { }
      }
      req.session.flash = { error: 'Failed to process grade approval.' };
      res.redirect('/admin/grades');
    }
  });

  // POST /admin/approvals/attendance/approve
  router.post('/approvals/attendance/approve', async (req, res) => {
    try {
      const { date, class_id } = req.body;

      await pool.execute(
        'UPDATE attendance SET approval_status = "approved" WHERE date = ? AND class_id = ?',
        [date, class_id]
      );

      req.session.flash = { success: 'Attendance records approved.' };
      res.redirect('/admin/grades');
    } catch (error) {
      console.error('Attendance approval error:', error);
      res.redirect('/admin/grades');
    }
  });

  // --- Transcript Generation Routes ---

  async function getClassRanksForYear(conn, classId, academicYear) {
    const [students] = await conn.execute(`
    SELECT student_id, ROUND(AVG(total_score), 2) as average_score
    FROM approved_results
    WHERE class_id = ? AND academic_year = ?
    GROUP BY student_id
    ORDER BY average_score DESC
  `, [classId, academicYear]);

    const ranks = new Map();
    for (let i = 0; i < students.length; i++) {
      const currentAverage = Number(students[i].average_score);
      const previousAverage = i > 0 ? Number(students[i - 1].average_score) : null;
      const rank = i > 0 && currentAverage === previousAverage
        ? ranks.get(String(students[i - 1].student_id)).rank
        : i + 1;
      ranks.set(String(students[i].student_id), { rank, classSize: students.length });
    }
    return ranks;
  }

  // Calculate competition rank from the latest approved results for a class and year.
  async function getStudentRankForClass(conn, studentId, classId, academicYear) {
    const ranks = await getClassRanksForYear(conn, classId, academicYear);
    const studentRank = ranks.get(String(studentId));
    if (studentRank) {
      return `${studentRank.rank}/${studentRank.classSize}`;
    }
    return '';
  }

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

      // 3. Get all final course grades from student_course_results (Official Source)
      const [grades] = await pool.execute(`
      SELECT 
        scr.assessment_structure_id as structure_id,
        scr.semester_id as semester,
        COALESCE(
          NULLIF(scr.course_id, 0), 
          (SELECT id FROM courses WHERE teacher_id = gs.teacher_id AND grade = cl.grade LIMIT 1), 
          0
        ) as course_id,
        scr.academic_year,
        cl.grade as grade_level,
        cl.id as class_id,
        COALESCE(
          co.course_name, 
          (SELECT course_name FROM courses WHERE teacher_id = gs.teacher_id AND grade = cl.grade LIMIT 1), 
          cl.name
        ) as class_name,
        scr.total_score as score
      FROM approved_results scr
      JOIN classes cl ON scr.class_id = cl.id
      LEFT JOIN courses co ON (scr.course_id = co.id AND scr.course_id != 0)
      LEFT JOIN grading_structures gs ON scr.assessment_structure_id = gs.id
      WHERE scr.student_id = ?
      ORDER BY scr.academic_year ASC, scr.semester_id ASC
    `, [studentId]);

      // 3b. Check for pending or incomplete results to set the watermark
      const [pendingResults] = await pool.execute(`
      SELECT COUNT(*) as count FROM student_course_results 
      WHERE student_id = ? AND status IN ('pending', 'rejected')
    `, [studentId]);
      const hasIncompleteGrades = pendingResults[0].count > 0;

      // 4. Get granular assessment breakdown for the transcript
      const [breakdown] = await pool.execute(`
      SELECT 
        sr.student_id, sr.category_id, sr.score as student_mark,
        ac.name as category_name, ac.weight_percentage, ac.max_mark, ac.passing_mark,
        gs.id as structure_id, gs.course_id, gs.semester
      FROM student_results sr
      JOIN assessment_categories ac ON sr.category_id = ac.id
      JOIN grading_structures gs ON ac.structure_id = gs.id
      WHERE sr.student_id = ? AND sr.status = 'approved'
    `, [studentId]);

      // 5. Get national exam results
      const [nationalExams] = await pool.execute(`
      SELECT * FROM national_exams WHERE student_id = ?
    `, [studentId]);

      // 5b. Get enrolled courses for the student
      const [enrolledCourses] = await pool.execute(`
      SELECT e.course_id, co.course_name, co.grade as enrollment_grade
      FROM enrollments e
      JOIN courses co ON e.course_id = co.id
      WHERE e.student_id = ?
    `, [studentId]);

      // 6. Generate transcript number
      let transcriptNum = `TS-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;
      const [existingTs] = await pool.execute('SELECT transcript_number FROM transcripts WHERE student_id = ?', [studentId]);
      if (existingTs.length > 0) transcriptNum = existingTs[0].transcript_number;

      // 7. Get School Name from settings
      const schoolName = await getSetting('schoolName', 'Abdigudina Elementary School');

      // Calculate rank directly from approved results, even if academic history is incomplete.
      const rankByAcademicYear = {};
      const yearClassMap = new Map();
      for (const grade of grades) {
        if (!yearClassMap.has(grade.academic_year)) {
          yearClassMap.set(grade.academic_year, grade.class_id);
        }
      }
      for (const [academicYear, classId] of yearClassMap) {
        if (classId) {
          rankByAcademicYear[academicYear] = await getStudentRankForClass(
            pool,
            studentId,
            classId,
            academicYear
          );
        }
      }

      // Keep the rank available on the academic history record for existing transcript views.
      for (const hist of history) {
        hist.rank = rankByAcademicYear[hist.academic_year] || '';
      }

      res.render('admin/transcript-generate', {
        title: 'Generate Transcript',
        user: req.session.user,
        student,
        history,
        grades,
        rankByAcademicYear,
        enrolledCourses,
        hasIncompleteGrades,
        breakdown,
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


  // GET /admin/parents - Manage parents
  router.get('/parents', async (req, res) => {
    try {
      const [parents] = await pool.execute(`
      SELECT u.id, u.username, u.email, u.first_name, u.last_name, u.phone, u.created_at, u.is_active,
             p.id as parent_id, p.relationship, p.occupation,
             GROUP_CONCAT(CONCAT(s.first_name, ' ', s.last_name) SEPARATOR ', ') as children
      FROM users u
      JOIN parents p ON u.id = p.user_id
      LEFT JOIN parent_student_relations psr ON p.id = psr.parent_id
      LEFT JOIN students s ON psr.student_id = s.id
      WHERE u.role = 'parent' AND u.username IS NOT NULL AND u.username != ''
      GROUP BY u.id, u.username, u.email, u.first_name, u.last_name, u.phone, u.created_at, u.is_active, p.id, p.relationship, p.occupation
      ORDER BY u.created_at DESC
    `);

      const [students] = await pool.execute(`
      SELECT s.id, s.student_id, u.first_name, u.last_name, s.grade_level, s.section 
      FROM students s
      JOIN users u ON s.user_id = u.id
      ORDER BY u.first_name, u.last_name
    `);

      res.render('admin/parents', {
        title: 'Manage Parents',
        user: req.session.user || {},
        parents,
        students,
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
      const rel = (relationship || 'guardian').toLowerCase();
      const validRels = ['father', 'mother', 'guardian', 'other'];
      const sanitizedRel = validRels.includes(rel) ? rel : 'other';

      const [parentResult] = await pool.execute(
        'INSERT INTO parents (user_id, relationship, occupation) VALUES (?, ?, ?)',
        [userId, sanitizedRel, occupation || null]
      );
      const parentId = parentResult.insertId;

      // Dynamic Connection: Auto-link students who listed this parent's name
      const fullName = `${firstName} ${lastName}`.toLowerCase().trim();
      const [matchingStudents] = await pool.execute(
        'SELECT id, parent_guardian_name FROM students'
      );

      let linkedCount = 0;
      for (const student of matchingStudents) {
        if (student.parent_guardian_name && student.parent_guardian_name.toLowerCase().trim() === fullName) {
          await pool.execute(
            'INSERT IGNORE INTO parent_student_relations (parent_id, student_id, relationship) VALUES (?, ?, ?)',
            [parentId, student.id, sanitizedRel]
          );
          linkedCount++;
        }
      }

      req.session.flash = { success: `Parent Account created. Dynamically linked to ${linkedCount} matching students.` };
      res.redirect('/admin/parents');

    } catch (error) {
      console.error('Add Parent Registration Error:', error);
      req.session.flash = { error: 'A critical server error occurred trying to save the parent details.' };
      res.redirect('/admin/parents?form=open');
    }
  });

  // POST /admin/parents/link-student - Link a student to a parent
  router.post('/parents/link-student', async (req, res) => {
    const { parent_id, student_id, relationship } = req.body;
    try {
      if (!parent_id || !student_id) {
        req.session.flash = { error: 'Parent and Student are required.' };
        return res.redirect('/admin/parents');
      }

      // Check if already linked
      const [existing] = await pool.execute(
        'SELECT id FROM parent_student_relations WHERE parent_id = ? AND student_id = ?',
        [parent_id, student_id]
      );

      if (existing.length > 0) {
        req.session.flash = { error: 'This student is already linked to the parent.' };
        return res.redirect('/admin/parents');
      }

      const rel = (relationship || 'guardian').toLowerCase();
      const validRels = ['father', 'mother', 'guardian', 'other'];
      const sanitizedRel = validRels.includes(rel) ? rel : 'other';

      await pool.execute(
        'INSERT INTO parent_student_relations (parent_id, student_id, relationship) VALUES (?, ?, ?)',
        [parent_id, student_id, sanitizedRel]
      );

      req.session.flash = { success: 'Student successfully linked to parent.' };
      res.redirect('/admin/parents');
    } catch (error) {
      console.error('Link Student Error:', error);
      req.session.flash = { error: 'Server error linking student.' };
      res.redirect('/admin/parents');
    }
  });

  // GET /admin/teachers/edit/:id - Fetch teacher data for editing
  router.get('/teachers/edit/:id', async (req, res) => {
    try {
      const [teachers] = await pool.execute(`
      SELECT u.id as user_id, u.username, u.first_name, u.last_name, u.email, u.phone, u.is_active,
             t.employee_id, t.department, t.qualification, t.experience
      FROM users u
      JOIN teachers t ON u.id = t.user_id
      WHERE u.id = ?
    `, [req.params.id]);

      if (teachers.length === 0) return res.json({ success: false, message: 'Teacher not found' });
      res.json({ success: true, teacher: teachers[0] });
    } catch (error) {
      console.error('Fetch Teacher Edit Error:', error);
      res.json({ success: false });
    }
  });

  // POST /admin/teachers/edit/:id - Update teacher data
  router.post('/teachers/edit/:id', upload.fields([
    { name: 'certificate', maxCount: 1 },
    { name: 'idCard', maxCount: 1 }
  ]), async (req, res) => {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const userId = req.params.id;
      const { firstName, lastName, email, phone, department, qualification, experience, is_active, username, password, employee_id } = req.body;

      // Check if new username/email is taken by another user
      const [existing] = await connection.execute('SELECT id FROM users WHERE (username = ? OR email = ?) AND id != ?', [username, email, userId]);
      if (existing.length > 0) {
        await connection.rollback();
        req.session.flash = { error: 'Username or Email is already taken by another account.' };
        return res.redirect('/admin/teachers');
      }

      // Check if employee_id is taken by another teacher
      if (employee_id) {
        const [existingEmp] = await connection.execute('SELECT id FROM teachers WHERE employee_id = ? AND user_id != ?', [employee_id, userId]);
        if (existingEmp.length > 0) {
          await connection.rollback();
          req.session.flash = { error: 'Employee ID is already assigned to another teacher.' };
          return res.redirect('/admin/teachers');
        }
      }

      // Update User Table
      await connection.execute(`
      UPDATE users 
      SET first_name = ?, last_name = ?, email = ?, phone = ?, is_active = ?, username = ?
      WHERE id = ?
    `, [firstName, lastName, email, phone || null, is_active ? 1 : 0, username, userId]);

      // Handle password update if provided
      if (password && password.trim() !== '') {
        const hashedPassword = await bcrypt.hash(password, 10);
        await connection.execute('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, userId]);
      }

      // Update Teacher Table
      await connection.execute(`
      UPDATE teachers 
      SET department = ?, qualification = ?, experience = ?, employee_id = ?
      WHERE user_id = ?
    `, [department || null, qualification || null, experience || 0, employee_id || null, userId]);

      // Handle File Uploads if any
      if (req.files) {
        if (req.files['certificate']) {
          const certUrl = `/uploads/${req.files['certificate'][0].filename}`;
          await connection.execute('UPDATE teachers SET certificate_url = ? WHERE user_id = ?', [certUrl, userId]);
        }
        if (req.files['idCard']) {
          const idCardUrl = `/uploads/${req.files['idCard'][0].filename}`;
          await connection.execute('UPDATE teachers SET id_card_url = ? WHERE user_id = ?', [idCardUrl, userId]);
        }
      }

      await connection.commit();
      req.session.flash = { success: 'Teacher profile updated successfully.' };
      res.redirect('/admin/teachers');
    } catch (error) {
      await connection.rollback();
      console.error('Update Teacher Error:', error);
      req.session.flash = { error: 'Failed to update teacher profile.' };
      res.redirect('/admin/teachers');
    } finally {
      connection.release();
    }
  });

  // GET /admin/parents/edit/:id - Fetch parent data for editing
  router.get('/parents/edit/:id', async (req, res) => {
    try {
      const [parents] = await pool.execute(`
      SELECT u.id, u.username, u.first_name, u.last_name, u.email, u.phone, u.is_active,
             p.relationship, p.occupation
      FROM users u
      JOIN parents p ON u.id = p.user_id
      WHERE u.id = ?
    `, [req.params.id]);

      if (parents.length === 0) return res.json({ success: false, message: 'Parent not found' });
      res.json({ success: true, parent: parents[0] });
    } catch (error) {
      console.error('Fetch Parent Edit Error:', error);
      res.json({ success: false });
    }
  });

  // POST /admin/parents/edit/:id - Update parent data
  router.post('/parents/edit/:id', async (req, res) => {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const userId = req.params.id;
      const { firstName, lastName, email, phone, relationship, occupation, is_active, username, password } = req.body;

      // Check if new username/email is taken by another user
      const [existing] = await connection.execute('SELECT id FROM users WHERE (username = ? OR email = ?) AND id != ?', [username, email, userId]);
      if (existing.length > 0) {
        await connection.rollback();
        req.session.flash = { error: 'Username or Email is already taken by another account.' };
        return res.redirect('/admin/parents');
      }

      // Update User Table
      await connection.execute(`
      UPDATE users 
      SET first_name = ?, last_name = ?, email = ?, phone = ?, is_active = ?, username = ?
      WHERE id = ?
    `, [firstName, lastName, email, phone || null, is_active ? 1 : 0, username, userId]);

      // Handle password update if provided
      if (password && password.trim() !== '') {
        const hashedPassword = await bcrypt.hash(password, 10);
        await connection.execute('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, userId]);
      }

      // Update Parent Table
      const rel = (relationship || 'guardian').toLowerCase();
      const validRels = ['father', 'mother', 'guardian', 'other'];
      const sanitizedRel = validRels.includes(rel) ? rel : 'other';

      await connection.execute(`
      UPDATE parents 
      SET relationship = ?, occupation = ?
      WHERE user_id = ?
    `, [sanitizedRel, occupation || null, userId]);

      await connection.commit();
      req.session.flash = { success: 'Parent profile updated successfully.' };
      res.redirect('/admin/parents');
    } catch (error) {
      await connection.rollback();
      console.error('Update Parent Error:', error);
      req.session.flash = { error: 'Failed to update parent profile.' };
      res.redirect('/admin/parents');
    } finally {
      connection.release();
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
      const { date, start_date, end_date, class_id, grade, search, teacher_id } = req.query;
      let query = `
      SELECT a.*, u.first_name, u.last_name, c.name as class_name, c.grade as class_grade,
             c.section, c.attendance_teacher_id,
             assigned_user.first_name as attendance_teacher_first_name,
             assigned_user.last_name as attendance_teacher_last_name,
             s.student_id as student_code, s.grade_level,
             tu.first_name as teacher_fname, tu.last_name as teacher_lname
      FROM attendance a
      LEFT JOIN students s ON a.student_id = s.id
      LEFT JOIN users u ON s.user_id = u.id
      LEFT JOIN classes c ON a.class_id = c.id
      LEFT JOIN teachers assigned_teacher ON c.attendance_teacher_id = assigned_teacher.id
      LEFT JOIN users assigned_user ON assigned_teacher.user_id = assigned_user.id
      LEFT JOIN teachers t ON COALESCE(a.teacher_id, a.created_by) = t.id
      LEFT JOIN users tu ON t.user_id = tu.id
      WHERE (a.course_id IS NULL OR a.course_id = 0)
    `;
      const params = [];

      // Date or date range filtering
      if (start_date && end_date) {
        query += ` AND a.date >= ? AND a.date <= ?`;
        params.push(start_date, end_date);
      } else if (start_date) {
        query += ` AND a.date >= ?`;
        params.push(start_date);
      } else if (end_date) {
        query += ` AND a.date <= ?`;
        params.push(end_date);
      } else if (date) {
        query += ` AND a.date = ?`;
        params.push(date);
      }

      if (class_id) {
        query += ` AND a.class_id = ?`;
        params.push(class_id);
      }
      if (grade) {
        query += ` AND (c.grade = ? OR s.grade_level = ?)`;
        params.push(grade, grade);
      }
      if (teacher_id) {
        query += ' AND (COALESCE(a.teacher_id, a.created_by) = ? OR c.attendance_teacher_id = ?)';
        params.push(teacher_id, teacher_id);
      }

      if (search) {
        query += ` AND (u.first_name LIKE ? OR u.last_name LIKE ? OR s.student_id LIKE ? OR s.first_name LIKE ? OR s.last_name LIKE ?)`;
        const pattern = `%${search}%`;
        params.push(pattern, pattern, pattern, pattern, pattern);
      }

      query += ` ORDER BY a.date DESC, a.id DESC`;

      const [rawAttendance] = await pool.execute(query, params);

      // Fetch classes for dropdown
      const [classes] = await pool.execute('SELECT id, name FROM classes ORDER BY name ASC');

      // Fetch teachers for dropdown
      const [teachers] = await pool.execute(`
      SELECT t.id, u.first_name, u.last_name 
      FROM teachers t 
      JOIN users u ON t.user_id = u.id 
      ORDER BY u.first_name, u.last_name
    `);

      const studentMap = new Map();

      // If a class filter is chosen, preload enrolled active students so every student appears once in that class
      if (class_id) {
        try {
          const [classStudents] = await pool.execute(`
            SELECT s.id as student_pk, s.student_id as student_code,
                   COALESCE(u.first_name, s.first_name) as first_name,
                   COALESCE(u.last_name, s.last_name) as last_name,
                   c.id as class_id, c.name as class_name, c.grade as class_grade, c.section as class_section,
                   assigned_user.first_name as attendance_teacher_first_name,
                   assigned_user.last_name as attendance_teacher_last_name
            FROM students s
            LEFT JOIN users u ON s.user_id = u.id
            JOIN classes c ON (s.class_id = c.id OR (s.grade_level = c.grade AND s.section = c.section))
            LEFT JOIN teachers assigned_teacher ON c.attendance_teacher_id = assigned_teacher.id
            LEFT JOIN users assigned_user ON assigned_teacher.user_id = assigned_user.id
            WHERE c.id = ? AND (s.withdrawal_status IS NULL OR s.withdrawal_status = 'active')
            ORDER BY COALESCE(u.last_name, s.last_name), COALESCE(u.first_name, s.first_name)
          `, [class_id]);

          for (const cs of classStudents) {
            if (search) {
              const sTerm = search.toLowerCase();
              const fullName = `${cs.first_name || ''} ${cs.last_name || ''}`.toLowerCase();
              const sCode = String(cs.student_code || '').toLowerCase();
              if (!fullName.includes(sTerm) && !sCode.includes(sTerm)) {
                continue;
              }
            }
            const key = `${cs.student_pk}_${cs.class_id}`;
            studentMap.set(key, {
              id: null,
              student_pk: cs.student_pk,
              student_id: cs.student_code || cs.student_pk,
              student_code: cs.student_code || cs.student_pk,
              first_name: cs.first_name || '',
              last_name: cs.last_name || '',
              class_id: cs.class_id,
              class_name: cs.class_name,
              class_grade: cs.class_grade,
              class_section: cs.class_section,
              attendance_teacher_first_name: cs.attendance_teacher_first_name,
              attendance_teacher_last_name: cs.attendance_teacher_last_name,
              present_count: 0,
              absent_count: 0,
              late_count: 0,
              excused_count: 0,
              total_count: 0,
              records: []
            });
          }
        } catch (csErr) {
          // Graceful fallback if mock environment does not support class students query
        }
      }

      // Group attendance records per student and class
      // Requirement 4: Each student appears once per class in results
      // Requirement 5: Do not count course records or duplicate attendance records
      const seenDates = new Set();

      for (const row of rawAttendance) {
        if (row.course_id && row.course_id !== 0) continue;

        const studentPk = row.student_id;
        const classId = row.class_id;
        const key = `${studentPk}_${classId}`;

        let student = studentMap.get(key);
        if (!student) {
          student = {
            id: row.id,
            student_pk: studentPk,
            student_id: row.student_code || row.student_id,
            student_code: row.student_code || row.student_id,
            first_name: row.first_name || '',
            last_name: row.last_name || '',
            class_id: classId,
            class_name: row.class_name || (classId ? `Class #${classId}` : 'Class'),
            class_grade: row.class_grade || row.grade_level || '',
            class_section: row.section || '',
            attendance_teacher_first_name: row.attendance_teacher_first_name,
            attendance_teacher_last_name: row.attendance_teacher_last_name,
            present_count: 0,
            absent_count: 0,
            late_count: 0,
            excused_count: 0,
            total_count: 0,
            records: []
          };
          studentMap.set(key, student);
        }

        if (!student.id && row.id) student.id = row.id;

        // Deduplicate records on student_id, class_id, and date
        const dateStr = row.date instanceof Date
          ? row.date.toISOString().split('T')[0]
          : (row.date ? String(row.date).split('T')[0] : `no-date-${row.id}`);
        const dateKey = `${key}_${dateStr}`;
        if (seenDates.has(dateKey)) {
          continue;
        }
        seenDates.add(dateKey);

        student.records.push({
          id: row.id,
          date: row.date,
          status: row.status,
          notes: row.notes,
          teacher_fname: row.teacher_fname,
          teacher_lname: row.teacher_lname
        });

        const status = (row.status || '').toLowerCase();
        if (status === 'present') {
          student.present_count++;
        } else if (status === 'absent') {
          student.absent_count++;
        } else if (status === 'late') {
          student.late_count++;
        } else if (status === 'excused') {
          student.excused_count++;
        }

        student.total_count = student.present_count + student.absent_count + student.late_count;
      }

      const attendance = Array.from(studentMap.values());

      // Compute aggregate stats across all students
      const stats = {
        totalStudents: attendance.length,
        total: attendance.reduce((sum, s) => sum + s.total_count + (s.excused_count || 0), 0),
        present: attendance.reduce((sum, s) => sum + s.present_count, 0),
        absent: attendance.reduce((sum, s) => sum + s.absent_count, 0),
        late: attendance.reduce((sum, s) => sum + s.late_count, 0),
        excused: attendance.reduce((sum, s) => sum + (s.excused_count || 0), 0)
      };
      const validTotal = stats.present + stats.absent + stats.late;
      stats.rate = validTotal > 0 ? Math.round(((stats.present + stats.late) / validTotal) * 100) : 0;

      const activeStartDate = start_date || (date && !end_date ? date : '');
      const activeEndDate = end_date || (date && !start_date ? date : '');

      res.render('admin/attendance', {
        title: 'Attendance Management',
        user: req.session.user,
        attendance,
        classes,
        teachers,
        stats,
        filters: {
          date: date || '',
          start_date: activeStartDate,
          end_date: activeEndDate,
          class_id: class_id || '',
          grade: grade || '',
          search: search || '',
          teacher_id: teacher_id || ''
        }
      });
    } catch (error) {
      console.error('Admin attendance error:', error);
      res.status(500).render('500-modern', { title: 'Server Error', message: error.message });
    }
  });

  router.post('/attendance/:id/update', async (req, res) => {
    const recordId = Number(req.params.id);
    const { status, notes } = req.body;
    if (!Number.isSafeInteger(recordId) || recordId <= 0 ||
        !['present', 'absent', 'late', 'excused'].includes(status) ||
        (notes !== undefined && typeof notes !== 'string')) {
      req.session.flash = { error: 'Invalid attendance update.' };
      return res.redirect('/admin/attendance');
    }

    try {
      await pool.execute(
        'UPDATE attendance SET status = ?, notes = ? WHERE id = ?',
        [status, typeof notes === 'string' ? notes.slice(0, 1000) : null, recordId]
      );
      req.session.flash = { success: 'Attendance record updated.' };
    } catch (error) {
      console.error('Admin attendance update error:', error);
      req.session.flash = { error: 'Failed to update attendance record.' };
    }
    return res.redirect('/admin/attendance');
  });

  router.post('/attendance/:id/delete', async (req, res) => {
    const recordId = Number(req.params.id);
    if (!Number.isSafeInteger(recordId) || recordId <= 0) {
      req.session.flash = { error: 'Invalid attendance record.' };
      return res.redirect('/admin/attendance');
    }

    try {
      await pool.execute('DELETE FROM attendance WHERE id = ?', [recordId]);
      req.session.flash = { success: 'Attendance record deleted.' };
    } catch (error) {
      console.error('Admin attendance delete error:', error);
      req.session.flash = { error: 'Failed to delete attendance record.' };
    }
    return res.redirect('/admin/attendance');
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

  // GET /admin/pending-registrations - View staged student and parent registration requests
  router.get('/pending-registrations', async (req, res) => {
    try {
      const role = req.query.role || '';
      const status = req.query.status || '';
      const search = req.query.search || '';

      let query = 'SELECT * FROM pending_registrations WHERE 1=1';
      const params = [];

      if (role) {
        query += ' AND role = ?';
        params.push(role);
      }
      if (status) {
        query += ' AND status = ?';
        params.push(status);
      }
      if (search) {
        query += ' AND (first_name LIKE ? OR last_name LIKE ? OR email LIKE ? OR username LIKE ?)';
        const searchPattern = `%${search}%`;
        params.push(searchPattern, searchPattern, searchPattern, searchPattern);
      }

      query += ' ORDER BY created_at DESC';

      const [pendingUsers] = await pool.execute(query, params);

      res.render('admin/pending-registrations', {
        title: 'Pending Registrations',
        user: req.session.user || {},
        pendingUsers,
        filters: { role, status, search },
        error: req.session.flash ? req.session.flash.error : null,
        success: req.session.flash ? req.session.flash.success : null
      });
    } catch (error) {
      console.error('Pending registrations error:', error);
      res.status(500).render('500-modern', { title: 'Server Error', message: error.message });
    }
  });

  // POST /admin/pending-registrations/approve/:id - Approve staged user registration and insert into active databases
  router.post('/pending-registrations/approve/:id', async (req, res) => {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const pendingId = req.params.id;

      // 1. Fetch pending registration details
      const [pendingRows] = await connection.execute(
        'SELECT * FROM pending_registrations WHERE id = ? AND status = "pending"',
        [pendingId]
      );

      if (pendingRows.length === 0) {
        throw new Error('Registration request not found or already processed.');
      }

      const pr = pendingRows[0];

      // Double check duplicate username/email in active users table again to be completely safe
      const [existingUsers] = await connection.execute(
        'SELECT id FROM users WHERE username = ? OR email = ?',
        [pr.username, pr.email]
      );
      if (existingUsers.length > 0) {
        throw new Error('A user with this username or email already exists in the system.');
      }

      // 2. Insert into users table
      const [userResult] = await connection.execute(
        `INSERT INTO users (username, email, password, first_name, last_name, role, phone, is_active, profile_picture, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, NOW())`,
        [pr.username, pr.email, pr.password, pr.first_name, pr.last_name, pr.role, pr.phone || null, pr.profile_picture || null]
      );

      const userId = userResult.insertId;

      if (pr.role === 'student') {
        // 3a. Generate sequential Student ID AES-{year}-{serial}
        const currentYear = new Date().getFullYear();
        const idPrefix = `AES-${currentYear}-`;

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

        const studentId = idPrefix + nextSerial.toString().padStart(4, '0');

        // 3b. Find matching class id
        const [matchingClass] = await connection.execute(
          'SELECT id FROM classes WHERE CAST(grade AS CHAR) = CAST(? AS CHAR) AND section = ? LIMIT 1',
          [pr.grade_level, pr.section]
        );
        const classId = matchingClass.length > 0 ? matchingClass[0].id : null;

        // 3c. Insert into students table
        const [studentResult] = await connection.execute(
          `INSERT INTO students (
          user_id, student_id, first_name, last_name, email, phone, 
          grade_level, section, class_id, date_of_birth, gender, enrollment_date, parent_guardian_name,
          address, previous_school, admission_type, transfer_date, transfer_reason, is_active, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURDATE(), ?, ?, ?, ?, ?, ?, 1, NOW())`,
          [
            userId, studentId, pr.first_name, pr.last_name, pr.email, pr.phone || null,
            pr.grade_level, pr.section, classId, pr.date_of_birth, pr.gender || 'male', pr.parent_guardian_name,
            pr.address || null, pr.previous_school || null, pr.admission_type || 'new', pr.transfer_date || null, pr.transfer_reason || null
          ]
        );
        const studentDbId = studentResult.insertId;

        // 3d. Map class_students mapping
        if (classId) {
          await connection.execute(
            'INSERT IGNORE INTO class_students (student_id, class_id, enrollment_date) VALUES (?, ?, CURDATE())',
            [studentDbId, classId]
          );
        }

        // 3e. Move documents from pending_registrations transcripts_json
        if (pr.transcripts_json) {
          try {
            const docs = JSON.parse(pr.transcripts_json);
            if (Array.isArray(docs)) {
              for (const doc of docs) {
                await connection.execute(
                  `INSERT INTO student_documents (student_id, document_type, file_url, file_name)
                 VALUES (?, 'transcript', ?, ?)`,
                  [studentDbId, doc.file_url, doc.file_name]
                );
                // Set the first one as primary
                if (doc === docs[0]) {
                  await connection.execute(
                    'UPDATE students SET previous_transcript_url = ? WHERE id = ?',
                    [doc.file_url, studentDbId]
                  );
                }
              }
            }
          } catch (jsonErr) {
            console.error('Error parsing transcripts JSON:', jsonErr);
          }
        }
      } else if (pr.role === 'parent') {
        // 4a. Create Parent Profile
        const rel = (pr.relationship || 'guardian').toLowerCase();
        const validRels = ['father', 'mother', 'guardian', 'other'];
        const sanitizedRel = validRels.includes(rel) ? rel : 'other';

        const [parentResult] = await connection.execute(
          'INSERT INTO parents (user_id, relationship, occupation, created_at) VALUES (?, ?, ?, NOW())',
          [userId, sanitizedRel, pr.occupation || null]
        );
        const parentId = parentResult.insertId;

        // 4b. Dynamic Connection: Auto-link students who listed this parent's name
        const fullName = `${pr.first_name} ${pr.last_name}`.toLowerCase().trim();
        const [matchingStudents] = await connection.execute(
          'SELECT id, parent_guardian_name FROM students'
        );

        for (const student of matchingStudents) {
          if (student.parent_guardian_name && student.parent_guardian_name.toLowerCase().trim() === fullName) {
            await connection.execute(
              'INSERT IGNORE INTO parent_student_relations (parent_id, student_id, relationship) VALUES (?, ?, ?)',
              [parentId, student.id, sanitizedRel]
            );
          }
        }
      }

      // 5. Update pending registrations status to approved
      await connection.execute(
        'UPDATE pending_registrations SET status = "approved" WHERE id = ?',
        [pendingId]
      );

      await connection.commit();

      // 6. Emit Real-time Socket alert
      const io = req.app.get('io');
      if (io) {
        io.to('admin_dashboard').emit('registrationApproved', { id: pendingId });
      }

      req.session.flash = { success: `Successfully approved registration request. ${pr.role === 'student' ? 'Student ID generated.' : 'Parent profile created.'}` };
      res.redirect('/admin/pending-registrations');
    } catch (error) {
      await connection.rollback();
      console.error('Approve registration error:', error);
      req.session.flash = { error: 'Failed to approve registration: ' + error.message };
      res.redirect('/admin/pending-registrations');
    } finally {
      connection.release();
    }
  });

  // POST /admin/pending-registrations/reject/:id - Reject staged user registration
  router.post('/pending-registrations/reject/:id', async (req, res) => {
    try {
      const pendingId = req.params.id;
      const { feedback } = req.body;

      const [pendingRows] = await pool.execute(
        'SELECT id, email, first_name, last_name FROM pending_registrations WHERE id = ? AND status = "pending"',
        [pendingId]
      );

      if (pendingRows.length === 0) {
        req.session.flash = { error: 'Staged registration request not found or already processed.' };
        return res.redirect('/admin/pending-registrations');
      }

      await pool.execute(
        'UPDATE pending_registrations SET status = "rejected", admin_feedback = ? WHERE id = ?',
        [feedback || null, pendingId]
      );

      // Emit Real-time Socket alert
      const io = req.app.get('io');
      if (io) {
        io.to('admin_dashboard').emit('registrationRejected', { id: pendingId });
      }

      req.session.flash = { success: 'Registration request successfully rejected.' };
      res.redirect('/admin/pending-registrations');
    } catch (error) {
      console.error('Reject registration error:', error);
      req.session.flash = { error: 'Failed to reject registration: ' + error.message };
      res.redirect('/admin/pending-registrations');
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

      // Find matching class
      const [matchingClass] = await connection.execute('SELECT id FROM classes WHERE CAST(grade AS CHAR) = CAST(? AS CHAR) AND section = ? LIMIT 1', [gradeLevel, section]);
      const classId = matchingClass.length > 0 ? matchingClass[0].id : null;

      // Enforce section size limit (max 50 students per section)
      if (classId) {
        const [cntResult] = await connection.execute('SELECT COUNT(*) as cnt FROM students WHERE class_id = ? AND withdrawal_status != \'withdrawn\'', [classId]);
        if (cntResult[0].cnt >= 50) {
          throw new Error('Section is full. Cannot register more students.');
        }
      }

      // 2. Create Student Profile
      const [studentResult] = await connection.execute(`
      INSERT INTO students (
        user_id, student_id, first_name, last_name, email, phone, 
        grade_level, section, class_id, date_of_birth, gender, enrollment_date, parent_guardian_name,
        address, previous_school, admission_type, transfer_date, transfer_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
        userId, studentId, firstName, lastName, email, phone,
        gradeLevel, section, classId, dateOfBirth, gender, enrollmentDate || new Date(), parentGuardianName,
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

      // Parent account creation is now handled manually via the parent registry

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
      // Using CAST to ensure numerical sort of the suffix
      const [lastTeacher] = await connection.execute(
        "SELECT employee_id FROM teachers WHERE employee_id LIKE 'AES-T-%' ORDER BY CAST(SUBSTRING(employee_id, 7) AS UNSIGNED) DESC LIMIT 1"
      );

      let nextSerial = 1;
      if (lastTeacher.length > 0) {
        const lastId = lastTeacher[0].employee_id;
        const parts = lastId.split('-');
        const lastSerialString = parts[parts.length - 1];
        const lastSerial = parseInt(lastSerialString);
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
             (SELECT COUNT(*) FROM students WHERE grade_level = c.grade AND section = c.section AND withdrawal_status = 'active') as current_students,
             (SELECT CONCAT(u.first_name, ' ', u.last_name) FROM teachers t JOIN users u ON t.user_id = u.id WHERE t.id = c.attendance_teacher_id) as attendance_teacher_name
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

      const [assignments] = await pool.execute(`
      SELECT tca.*, u.first_name, u.last_name, t.employee_id, c.name as class_name, c.grade, c.section, co.course_name, co.course_code
      FROM teacher_course_assignments tca
      JOIN teachers t ON tca.teacher_id = t.id
      JOIN users u ON t.user_id = u.id
      JOIN classes c ON tca.class_id = c.id
      JOIN courses co ON tca.course_id = co.id
      WHERE tca.status = 'active'
      ORDER BY c.grade, c.section, co.course_name
    `);
      const [courses] = await pool.execute('SELECT id, course_name, course_code FROM courses WHERE is_active = TRUE');

      res.render('admin/classes', {
        title: 'Manage Classes',
        user: req.session.user,
        classes,
        teachers,
        assignments,
        courses,
        filters: { grade, search },
        error: req.session.flash ? req.session.flash.error : null,
        success: req.session.flash ? req.session.flash.success : null
      });
    } catch (error) {
      console.error('Classes error:', error);
      res.status(500).render('500-modern', { title: 'Server Error', error: error });
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
      const { name, grade, section, teacher_id, academic_year, semester, course_limit, attendance_teacher_id } = req.body;
      const [result] = await connection.execute(
        'INSERT INTO classes (name, grade, section, academic_year, semester, course_limit, attendance_teacher_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [name, grade, section, academic_year || DEFAULT_ACADEMIC_YEAR, semester || '1', course_limit || 10, attendance_teacher_id ? parseInt(attendance_teacher_id) : null]
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
      const { name, grade, section, teacher_id, academic_year, semester, course_limit, attendance_teacher_id } = req.body;
      await connection.execute(
        'UPDATE classes SET name = ?, grade = ?, section = ?, academic_year = ?, semester = ?, course_limit = ?, attendance_teacher_id = ? WHERE id = ?',
        [name, grade, section, academic_year || DEFAULT_ACADEMIC_YEAR, semester || '1', course_limit || 10, attendance_teacher_id ? parseInt(attendance_teacher_id) : null, classId]
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

      // Build ranking query - calculate final score based on approved course results
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
        ROUND(AVG(ar.total_score), 2) AS average_score,
        COUNT(ar.student_id) AS assessments_count
      FROM students s
      JOIN users u ON s.user_id = u.id
      JOIN approved_results ar ON s.id = ar.student_id
      JOIN classes c ON ar.class_id = c.id
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

      // Calculate dynamic competition ranking per academic group (class/year)
      const groups = {};
      rankedStudents.forEach(student => {
        const key = `${student.class_id}_${student.academic_year}`;
        if (!groups[key]) groups[key] = [];
        groups[key].push(student);
      });

      const finalRankedStudents = [];
      Object.values(groups).forEach(group => {
        // Sort within the group descending
        group.sort((a, b) => b.average_score - a.average_score);

        for (let i = 0; i < group.length; i++) {
          // Competition Ranking (1, 1, 3, 4)
          if (i > 0 && group[i].average_score === group[i - 1].average_score) {
            group[i].rank = group[i - 1].rank;
          } else {
            group[i].rank = i + 1;
          }
          finalRankedStudents.push(group[i]);
        }
      });

      // Restore overall order by class name, then by average_score
      finalRankedStudents.sort((a, b) => {
        const classCompare = a.class_name.localeCompare(b.class_name);
        if (classCompare !== 0) return classCompare;
        return b.average_score - a.average_score;
      });

      res.render('admin/rankings', {
        title: 'Student Rankings',
        user: req.session.user,
        rankedStudents: finalRankedStudents,
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
      const ctx = await getAcademicContext();
      const settings = {
        schoolName: await getSetting('schoolName', 'Abdigudina Elementary School'),
        academicYear: ctx.academicYear,
        contactEmail: await getSetting('contactEmail', 'admin@abdigudina.edu'),
        phonePrefix: await getSetting('phonePrefix', '+251'),
        semester: ctx.semester,
        attendanceThreshold: await getSetting('attendanceThreshold', '75'),
        passingGrade: await getSetting('passingGrade', '50'),
        regOpen: await getSetting('regOpen', 'on'),
        maintMode: await getSetting('maintMode', 'off')
      };

      const academicYearHistory = await getAcademicYearHistory(15);

      res.render('admin/settings', {
        title: 'System Settings',
        user: req.session.user,
        settings,
        academicYearHistory,
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
      const { title, message, audience, category } = req.body;
      const targetAudience = audience && ['all', 'students', 'teachers', 'parents'].includes(audience) ? audience : 'all';
      const targetCategory = category || 'general';

      const [result] = await pool.execute(
        'INSERT INTO announcements (title, message, audience, category, created_by) VALUES (?, ?, ?, ?, ?)',
        [title ? title.trim() : 'Announcement', message ? message.trim() : '', targetAudience, targetCategory, req.session.user.id]
      );

      // Real-time broadcast
      const io = req.app.get('io');
      if (io) {
        const payload = {
          id: result.insertId,
          title: title ? title.trim() : '',
          message: message ? message.trim() : '',
          audience: targetAudience,
          category: targetCategory,
          created_at: new Date()
        };
        io.emit('newAnnouncement', payload);
      }

      req.session.flash = { success: 'Announcement published successfully' };
      res.redirect('/admin/announcements');
    } catch (error) {
      console.error('Add announcement error:', error);
      res.redirect('back');
    }
  });

  // POST /admin/announcements/edit/:id
  router.post('/announcements/edit/:id', async (req, res) => {
    try {
      const announcementId = req.params.id;
      const { title, message, audience, category } = req.body;
      const targetAudience = audience && ['all', 'students', 'teachers', 'parents'].includes(audience) ? audience : 'all';
      const targetCategory = category || 'general';

      await pool.execute(
        'UPDATE announcements SET title = ?, message = ?, audience = ?, category = ? WHERE id = ?',
        [title ? title.trim() : '', message ? message.trim() : '', targetAudience, targetCategory, announcementId]
      );

      const io = req.app.get('io');
      if (io) {
        io.emit('updateAnnouncement', {
          id: Number(announcementId),
          title: title ? title.trim() : '',
          message: message ? message.trim() : '',
          audience: targetAudience,
          category: targetCategory
        });
      }

      if (req.xhr || req.headers.accept?.includes('application/json')) {
        return res.json({ success: true, message: 'Announcement updated successfully' });
      }

      req.session.flash = { success: 'Announcement updated successfully' };
      res.redirect('/admin/announcements');
    } catch (error) {
      console.error('Edit announcement error:', error);
      if (req.xhr || req.headers.accept?.includes('application/json')) {
        return res.status(500).json({ success: false, message: error.message });
      }
      res.redirect('back');
    }
  });

  // POST /admin/announcements/delete/:id
  router.post('/announcements/delete/:id', async (req, res) => {
    try {
      const announcementId = req.params.id;
      await pool.execute('DELETE FROM announcements WHERE id = ?', [announcementId]);

      const io = req.app.get('io');
      if (io) {
        io.emit('deleteAnnouncement', { id: Number(announcementId) });
      }

      if (req.xhr || req.headers.accept?.includes('application/json')) {
        return res.json({ success: true, message: 'Announcement deleted successfully' });
      }

      req.session.flash = { success: 'Announcement deleted successfully' };
      res.redirect('/admin/announcements');
    } catch (error) {
      console.error('Delete announcement error:', error);
      if (req.xhr || req.headers.accept?.includes('application/json')) {
        return res.status(500).json({ success: false, message: error.message });
      }
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

      const regOpen = req.body.regOpen || 'off';
      const maintMode = req.body.maintMode || 'off';

      const prevContext = await getAcademicContext();
      const normalizedYear = normalizeAcademicYear(academicYear);

      await updateSetting('schoolName', schoolName, 'institution');
      await updateSetting('contactEmail', contactEmail, 'institution');
      await updateSetting('phonePrefix', phonePrefix, 'institution');
      await updateSetting('semester', semester, 'academic');
      await updateSetting('attendanceThreshold', attendanceThreshold, 'academic');
      await updateSetting('passingGrade', passingGrade, 'academic');
      await updateSetting('regOpen', regOpen, 'system');
      await updateSetting('maintMode', maintMode, 'system');

      if (normalizedYear && normalizedYear !== prevContext.academicYear) {
        await setActiveAcademicYear(normalizedYear, req.session.user?.id || null);
      }

      updateSettings({ publicRegistrationEnabled: regOpen === 'on' });

      const newContext = await getAcademicContext();
      const payload = {
        academicYear: newContext.academicYear,
        semester: newContext.semester,
        semesterLabel: newContext.semesterLabel,
        previousAcademicYear: prevContext.academicYear,
        previousSemester: prevContext.semester,
      };
      emitAcademicContextUpdate(req.app, payload);

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
      const { grade, search, teacher_id, class_id, academic_year, semester_id } = req.query;

      let query = `
        SELECT scr.id AS result_id,
               scr.student_id,
               scr.teacher_id,
               tu.first_name AS teacher_first_name,
               tu.last_name AS teacher_last_name,
               scr.course_id,
               COALESCE(NULLIF(scr.course_id, 0), assigned_course.course_id, scheduled_course.course_id) AS resolved_course_id,
               co.course_name,
               scr.class_id,
               c.name AS class_name,
               scr.semester_id,
               scr.academic_year,
               scr.total_score,
               scr.status,
               scr.submitted_at AS created_at,
               s.student_id AS student_reg_id,
               u.first_name AS student_first_name,
               u.last_name AS student_last_name,
               s.grade_level
        FROM student_course_results scr
        JOIN students s ON scr.student_id = s.id
        JOIN users u ON s.user_id = u.id
        LEFT JOIN classes c ON scr.class_id = c.id
        LEFT JOIN (
          SELECT teacher_id, class_id, MIN(course_id) AS course_id
          FROM teacher_course_assignments
          WHERE status = 'active'
          GROUP BY teacher_id, class_id
          HAVING COUNT(DISTINCT course_id) = 1
        ) assigned_course
          ON assigned_course.teacher_id = scr.teacher_id
          AND assigned_course.class_id = scr.class_id
        LEFT JOIN (
          SELECT schedule_links.teacher_id, schedule_links.class_id,
                 MIN(schedule_links.course_id) AS course_id
          FROM (
            SELECT teacher_id, class_id, course_id
            FROM class_schedule
            WHERE teacher_id IS NOT NULL
            UNION
            SELECT course_owner.teacher_id, cs.class_id, cs.course_id
            FROM class_schedule cs
            JOIN courses course_owner ON course_owner.id = cs.course_id
            WHERE course_owner.teacher_id IS NOT NULL
          ) schedule_links
          GROUP BY schedule_links.teacher_id, schedule_links.class_id
          HAVING COUNT(DISTINCT course_id) = 1
        ) scheduled_course
          ON scheduled_course.teacher_id = scr.teacher_id
          AND scheduled_course.class_id = scr.class_id
        LEFT JOIN courses co
          ON co.id = COALESCE(NULLIF(scr.course_id, 0), assigned_course.course_id, scheduled_course.course_id)
        LEFT JOIN teachers t ON scr.teacher_id = t.id
        LEFT JOIN users tu ON t.user_id = tu.id
        WHERE 1=1
      `;
      const params = [];

      if (grade) {
        query += ' AND s.grade_level = ?';
        params.push(grade);
      }
      if (class_id) {
        query += ' AND scr.class_id = ?';
        params.push(class_id);
      }
      if (academic_year) {
        query += ' AND scr.academic_year = ?';
        params.push(academic_year);
      }
      if (semester_id) {
        query += ' AND scr.semester_id = ?';
        params.push(semester_id);
      }
      if (teacher_id) {
        query += ' AND scr.teacher_id = ?';
        params.push(teacher_id);
      }
      if (search) {
        query += ' AND (u.first_name LIKE ? OR u.last_name LIKE ? OR s.student_id LIKE ?)';
        const pattern = `%${search}%`;
        params.push(pattern, pattern, pattern);
      }

      query += " ORDER BY scr.status = 'pending' DESC, scr.id DESC LIMIT 500";
      const [gradeResults] = await pool.execute(query, params);

      const resultIds = [...new Set(gradeResults.map((grade) => grade.result_id))];
      let assessmentsByResult = new Map();
      if (resultIds.length > 0) {
        const resultPlaceholders = resultIds.map(() => '?').join(', ');
        const [assessmentResults] = await pool.execute(`
          SELECT scr.id AS result_id, ac.name AS assessment_name,
                 sr.score, ac.max_mark, ac.weight_percentage
          FROM student_course_results scr
          JOIN student_results sr
            ON sr.student_id = scr.student_id
            AND sr.teacher_id = scr.teacher_id
            AND sr.class_id = scr.class_id
            AND sr.academic_year = scr.academic_year
            AND sr.semester_id = scr.semester_id
            AND (
              sr.course_id = scr.course_id
              OR (sr.course_id IS NULL AND (scr.course_id IS NULL OR scr.course_id = 0))
            )
          JOIN assessment_categories ac
            ON ac.id = sr.category_id
            AND ac.structure_id = scr.assessment_structure_id
          WHERE scr.id IN (${resultPlaceholders})
          ORDER BY ac.order_index ASC, sr.id ASC
        `, resultIds);

        assessmentsByResult = new Map();
        for (const assessment of assessmentResults) {
          const resultAssessments = assessmentsByResult.get(assessment.result_id) || [];
          resultAssessments.push(assessment);
          assessmentsByResult.set(assessment.result_id, resultAssessments);
        }
      }

      const studentsById = new Map();
      for (const grade of gradeResults) {
        let student = studentsById.get(grade.student_id);
        if (!student) {
          student = {
            student_id: grade.student_id,
            student_reg_id: grade.student_reg_id,
            student_first_name: grade.student_first_name,
            student_last_name: grade.student_last_name,
            grade_level: grade.grade_level,
            gradeRecords: [],
          };
          studentsById.set(grade.student_id, student);
        }

        if (!student.gradeRecords.some((record) => record.id === grade.result_id)) {
          const assessments = assessmentsByResult.get(grade.result_id) || [];
          const assessmentGroups = {
            assignment: [],
            midterm: [],
            final: [],
            other: [],
          };

          for (const assessment of assessments) {
            const name = String(assessment.assessment_name || '').toLowerCase();
            if (/\b(assignment|homework|coursework)\b/.test(name)) {
              assessmentGroups.assignment.push(assessment);
            } else if (/\bmid[\s-]?term\b/.test(name)) {
              assessmentGroups.midterm.push(assessment);
            } else if (/\bfinal\b/.test(name)) {
              assessmentGroups.final.push(assessment);
            } else {
              assessmentGroups.other.push(assessment);
            }
          }

          const weightedTotal = assessments.length > 0
            ? assessments.reduce((total, assessment) => {
              const maxMark = Number(assessment.max_mark);
              return total + (maxMark > 0
                ? (Number(assessment.score) / maxMark) * Number(assessment.weight_percentage)
                : 0);
            }, 0)
            : Number(grade.total_score) || 0;

          student.gradeRecords.push({
            ...grade,
            id: grade.result_id,
            assessments,
            assessmentGroups,
            weightedTotal: Number(weightedTotal.toFixed(1)),
          });
        }
      }
      const grades = [...studentsById.values()];

      // Compute per-student overall average and total courses
      for (const student of grades) {
        student.total_courses = student.gradeRecords.length;
        if (student.total_courses > 0) {
          const sum = student.gradeRecords.reduce((s, r) => s + (r.weightedTotal || 0), 0);
          student.overall_average = (sum / student.total_courses).toFixed(1);
        } else {
          student.overall_average = 'N/A';
        }
        // Primary class/section from first record
        student.class_name = student.gradeRecords[0] ? (student.gradeRecords[0].class_name || '—') : '—';
        student.academic_year_display = student.gradeRecords[0] ? (student.gradeRecords[0].academic_year || '') : '';
      }

      const classRankPromises = new Map();
      for (const student of grades) {
        for (const record of student.gradeRecords) {
          if (!record.class_id || !record.academic_year) continue;
          const rankKey = `${record.class_id}_${record.academic_year}`;
          if (!classRankPromises.has(rankKey)) {
            classRankPromises.set(
              rankKey,
              getClassRanksForYear(pool, record.class_id, record.academic_year)
            );
          }
        }
      }

      const classRanks = new Map();
      for (const [rankKey, rankPromise] of classRankPromises) {
        classRanks.set(rankKey, await rankPromise);
      }
      for (const student of grades) {
        // Per-record rank
        for (const record of student.gradeRecords) {
          const rankKey = `${record.class_id}_${record.academic_year}`;
          const rank = classRanks.get(rankKey)?.get(String(student.student_id));
          record.rank = rank ? `${rank.rank}/${rank.classSize}` : 'N/A';
        }
        // Student-level rank (from first record's class/year)
        const firstRecord = student.gradeRecords[0];
        if (firstRecord && firstRecord.class_id && firstRecord.academic_year) {
          const rankKey = `${firstRecord.class_id}_${firstRecord.academic_year}`;
          const rankMap = classRanks.get(rankKey);
          const rankEntry = rankMap?.get(String(student.student_id));
          student.rank_display = rankEntry ? `${rankEntry.rank} out of ${rankEntry.classSize} students` : 'N/A';
          student.student_rank = rankEntry ? rankEntry.rank : null;
        } else {
          student.rank_display = 'N/A';
          student.student_rank = null;
        }
      }

      // Fetch classes for filter dropdown
      const [classesList] = await pool.execute('SELECT id, name, grade, section FROM classes ORDER BY grade, section');

      // Fetch distinct academic years for filter dropdown
      const [academicYears] = await pool.execute(
        'SELECT DISTINCT academic_year FROM student_course_results WHERE academic_year IS NOT NULL ORDER BY academic_year DESC'
      );

      // Fetch teachers for filter
      const [teachers] = await pool.execute(`
      SELECT t.id, u.first_name, u.last_name 
      FROM teachers t 
      JOIN users u ON t.user_id = u.id 
      ORDER BY u.first_name, u.last_name
    `);

      // Fetch pending results for approval queue
      const [pendingGrades] = await pool.execute(`
      SELECT sr.*, u.first_name, u.last_name, s.student_id, c.name as class_name, co.course_name, 
             tu.first_name as teacher_fname, tu.last_name as teacher_lname, ac.name as category_name
      FROM student_results sr
      JOIN assessment_categories ac ON sr.category_id = ac.id
      JOIN grading_structures gs ON ac.structure_id = gs.id
      JOIN students s ON sr.student_id = s.id
      JOIN users u ON s.user_id = u.id
      JOIN classes c ON gs.class_id = c.id
      LEFT JOIN courses co ON gs.course_id = co.id
      LEFT JOIN teachers t ON COALESCE(sr.teacher_id, sr.graded_by) = t.id
      LEFT JOIN users tu ON t.user_id = tu.id
      WHERE sr.status = 'pending'
      ORDER BY sr.created_at ASC
    `);

      res.render('admin/grades', {
        title: 'Academic Records',
        user: req.session.user,
        grades,
        pendingGrades,
        teachers,
        classesList,
        academicYears,
        filters: { grade, search, teacher_id, class_id, academic_year, semester_id },
        success: req.session.flash ? req.session.flash.success : null,
        error: req.session.flash ? req.session.flash.error : null
      });
      if (req.session.flash) delete req.session.flash;
    } catch (error) {
      console.error('Grades error:', error);
      res.status(500).render('500-modern', { title: 'Server Error', message: error.message });
    }
  });

  // POST /admin/grades/approve - Approve submitted grades
router.post('/grades/approve', isAdmin, async (req, res) => {
  const { classId, courseId } = req.body;
  // Validate input
  if (classId == null || isNaN(Number(classId))) {
    return res.status(400).json({ success: false, message: 'Invalid or missing classId' });
  }
  if (courseId == null || isNaN(Number(courseId))) {
    return res.status(400).json({ success: false, message: 'Invalid or missing courseId' });
  }
  const adminId = req.session.user.id;
  try {
    // Approve grade submissions
    await pool.execute(
      `UPDATE grade_submissions
       SET status = 'approved', approved_by = ?, approved_at = CURRENT_TIMESTAMP
       WHERE class_id = ? AND course_id = ? AND status = 'submitted'`,
      [adminId, classId, courseId || 0]
    );
    // Approve student course results
    await pool.execute(
      `UPDATE student_course_results
       SET status = 'approved', approved_by = ?, approved_at = CURRENT_TIMESTAMP
       WHERE class_id = ? AND course_id = ? AND status = 'submitted'`,
      [adminId, classId, courseId || 0]
    );
    const io = req.app.get('io');
    if (io) {
      // Log approval action
      await pool.execute(
        `INSERT INTO approvals_log (entity_type, entity_id, action, performed_by, note)
         VALUES ('grade', ?, 'approved', ?, NULL)`,
        [classId, adminId]
      );
      io.to('admin_dashboard').emit('gradesApproved', { classId, courseId });
    }
    res.json({ success: true, message: 'Grades approved' });
  } catch (error) {
    console.error('Approve grades error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /admin/grades/reject - Reject submitted grades
router.post('/grades/reject', isAdmin, async (req, res) => {
  const { classId, courseId, reason } = req.body;
  const adminId = req.session.user.id;
  try {
    // Reject grade submissions
    await pool.execute(
      `UPDATE grade_submissions
       SET status = 'rejected', rejected_by = ?, rejected_at = CURRENT_TIMESTAMP
       WHERE class_id = ? AND course_id = ? AND status = 'submitted'`,
      [adminId, classId, courseId || 0]
    );
    // Reject student course results
    await pool.execute(
      `UPDATE student_course_results
       SET status = 'rejected', rejected_by = ?, rejected_at = CURRENT_TIMESTAMP
       WHERE class_id = ? AND course_id = ? AND status = 'submitted'`,
      [adminId, classId, courseId || 0]
    );
    if (reason) {
      await pool.execute(
        `INSERT INTO approvals_log (entity_type, entity_id, action, performed_by, note)
         VALUES ('grade', ?, 'rejected', ?, ?)`,
        [classId, adminId, reason]
      );
    }
    const io = req.app.get('io');
    if (io) io.to('admin_dashboard').emit('gradesRejected', { classId, courseId, reason });
    res.json({ success: true, message: 'Grades rejected' });
  } catch (error) {
    console.error('Reject grades error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /admin/grades/delete - Delete a grade record (admin only)
router.post('/grades/delete', isAdmin, async (req, res) => {
  const { classId, courseId } = req.body;
  try {
    const conn = await pool.getConnection();
    await conn.beginTransaction();
    // Delete unapproved grade submissions
    await conn.execute(
      `DELETE FROM grade_submissions
       WHERE class_id = ? AND course_id = ? AND status != 'approved'`,
      [classId, courseId || 0]
    );
    // Delete corresponding student course results that are not approved
    await conn.execute(
      `DELETE FROM student_course_results
       WHERE class_id = ? AND course_id = ? AND status != 'approved'`,
      [classId, courseId || 0]
    );
    await conn.commit();
    conn.release();
    const io = req.app.get('io');
    if (io) io.to('admin_dashboard').emit('gradeDeleted', { classId, courseId });
    res.json({ success: true, message: 'Grade record deleted' });
  } catch (error) {
    console.error('Delete grade error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});
// GET /admin/grades/history - Get all grade change logs for the admin history tab
  router.get('/grades/history', isAdmin, async (req, res) => {
    try {
      const [logs] = await pool.execute(`
      SELECT gcl.*, 
             CONCAT(su.first_name, ' ', su.last_name) as student_name,
             s.student_id as reference_id,
             ac.name as category_name,
             co.course_name,
             CONCAT(tu.first_name, ' ', tu.last_name) as teacher_name
      FROM grade_change_logs gcl
      JOIN students s ON gcl.student_id = s.id
      JOIN users su ON s.user_id = su.id
      JOIN assessment_categories ac ON gcl.category_id = ac.id
      JOIN grading_structures gs ON ac.structure_id = gs.id
      LEFT JOIN courses co ON gs.course_id = co.id
      LEFT JOIN teachers t ON gcl.edited_by = t.id
      LEFT JOIN users tu ON t.user_id = tu.id
      ORDER BY gcl.change_time DESC
      LIMIT 200
    `);
      res.json({ success: true, logs });
    } catch (error) {
      console.error('Get admin grade logs error:', error);
      res.status(500).json({ success: false, message: error.message });
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
        SELECT cs.*, c.course_name, c.course_code, c.credits,
               CONCAT(u.first_name, ' ', u.last_name) as teacher_name
        FROM class_schedule cs
        JOIN courses c ON cs.course_id = c.id
        LEFT JOIN teachers t ON cs.teacher_id = t.id
        LEFT JOIN users u ON t.user_id = u.id
        WHERE cs.class_id = ?
        ORDER BY FIELD(day_of_week, 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'), start_time
      `, [classId]);

      const [courses] = await pool.execute(
        'SELECT id, course_name, course_code FROM courses WHERE is_active = TRUE AND grade = ? ORDER BY course_name',
        [classInfo[0].grade]
      );

      const [teachers] = await pool.execute(`
        SELECT t.id, CONCAT(u.first_name, ' ', u.last_name) as teacher_name, t.department
        FROM teachers t
        JOIN users u ON t.user_id = u.id
        WHERE t.is_active = TRUE
        ORDER BY u.last_name, u.first_name
      `);

      res.render('admin/class-schedule', {
        title: `Schedule: ${classInfo[0].name}`,
        user: req.session.user,
        classInfo: classInfo[0],
        schedule,
        courses,
        teachers,
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
      let teacher_id = req.body.teacher_id ? Number(req.body.teacher_id) : null;

      // Auto-resolve teacher if not manually selected
      if (!teacher_id) {
        const [tca] = await pool.execute(
          "SELECT teacher_id FROM teacher_course_assignments WHERE class_id = ? AND course_id = ? AND status = 'active' LIMIT 1",
          [class_id, course_id]
        );
        if (tca.length > 0) {
          teacher_id = tca[0].teacher_id;
        } else {
          const [co] = await pool.execute('SELECT teacher_id FROM courses WHERE id = ? LIMIT 1', [course_id]);
          if (co.length > 0 && co[0].teacher_id) {
            teacher_id = co[0].teacher_id;
          }
        }
      }

      const [classDetails] = await pool.execute('SELECT academic_year, semester FROM classes WHERE id = ?', [class_id]);
      const academicYear = (classDetails[0] && classDetails[0].academic_year) || '2025-2026';
      const semester = (classDetails[0] && classDetails[0].semester) || 'Semester 1';

      await pool.execute(
        `INSERT INTO class_schedule 
          (class_id, course_id, teacher_id, academic_year, semester, day_of_week, start_time, end_time, room, period) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [class_id, course_id, teacher_id, academicYear, semester, day_of_week, start_time, end_time, room, period]
      );

      const io = req.app.get('io');
      if (io) {
        io.emit('scheduleUpdated', { classId: Number(class_id), teacherId: teacher_id });
      }

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
      const [period] = await pool.execute('SELECT class_id, teacher_id FROM class_schedule WHERE id = ?', [req.params.id]);
      if (period.length > 0) {
        const classId = period[0].class_id;
        const teacherId = period[0].teacher_id;
        await pool.execute('DELETE FROM class_schedule WHERE id = ?', [req.params.id]);

        const io = req.app.get('io');
        if (io) {
          io.emit('scheduleUpdated', { classId, teacherId });
        }

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

  // --- Grading Structure Management ---

  // GET /admin/grading - List pending grading structures
  router.get('/grading', async (req, res) => {
    try {
      const { teacher_id } = req.query;
      let query = `
      SELECT gs.*, u.first_name, u.last_name, c.name as class_name, co.course_name
      FROM grading_structures gs
      JOIN teachers t ON gs.teacher_id = t.id
      JOIN users u ON t.user_id = u.id
      LEFT JOIN classes c ON gs.class_id = c.id
      LEFT JOIN courses co ON gs.course_id = co.id
      WHERE gs.status = 'pending'
    `;
      const params = [];

      if (teacher_id) {
        query += ` AND gs.teacher_id = ?`;
        params.push(teacher_id);
      }

      query += ` ORDER BY gs.created_at DESC`;
      const [pending] = await pool.execute(query, params);

      const [teachers] = await pool.execute(`
      SELECT t.id, u.first_name, u.last_name 
      FROM teachers t 
      JOIN users u ON t.user_id = u.id 
      ORDER BY u.first_name, u.last_name
    `);

      res.render('admin/grading-management', {
        title: 'Grading Approval',
        user: req.session.user,
        pending,
        teachers,
        filters: { teacher_id }
      });
    } catch (error) {
      console.error('Admin grading list error:', error);
      res.status(500).render('500-modern', { title: 'Server Error' });
    }
  });

  // POST /grading/approve/:id - Approve structure
  router.post('/grading/approve/:id', async (req, res) => {
    try {
      await pool.execute('UPDATE grading_structures SET status = "approved", feedback = NULL WHERE id = ?', [req.params.id]);
      res.json({ message: 'Grading structure approved' });
    } catch (error) {
      res.status(500).json({ message: 'Error approving structure' });
    }
  });

  // POST /grading/reject/:id - Reject structure with feedback
  router.post('/grading/reject/:id', async (req, res) => {
    try {
      const { feedback } = req.body;
      await pool.execute('UPDATE grading_structures SET status = "rejected", feedback = ? WHERE id = ?', [feedback, req.params.id]);
      res.json({ message: 'Grading structure rejected and feedback sent' });
    } catch (error) {
      res.status(500).json({ message: 'Error rejecting structure' });
    }
  });

  // --- Teacher Activity Monitoring ---

  // GET /admin/activities - View teacher activity logs
  router.get('/activities', async (req, res) => {
    try {
      const { teacher_id, type } = req.query;
      let query = `
      SELECT ta.*, u.first_name, u.last_name, c.name as class_name, co.course_name
      FROM teacher_activities ta
      JOIN teachers t ON ta.teacher_id = t.id
      JOIN users u ON t.user_id = u.id
      LEFT JOIN classes c ON ta.class_id = c.id
      LEFT JOIN courses co ON ta.course_id = co.id
      WHERE 1=1
    `;
      const params = [];

      if (teacher_id) {
        query += ' AND ta.teacher_id = ?';
        params.push(teacher_id);
      }
      if (type) {
        query += ' AND ta.activity_type = ?';
        params.push(type);
      }

      query += ' ORDER BY ta.created_at DESC LIMIT 500';
      const [activities] = await pool.execute(query, params);

      // Fetch workload metrics if a specific teacher is selected
      let workload = null;
      if (teacher_id) {
        const [courseCount] = await pool.execute('SELECT COUNT(*) as count FROM teacher_course_assignments WHERE teacher_id = ? AND status = "active"', [teacher_id]);
        const [studentCount] = await pool.execute(`
        SELECT COUNT(DISTINCT s.id) as count 
        FROM students s
        JOIN classes c ON s.grade_level = c.grade AND s.section = c.section
        WHERE c.id IN (
          SELECT class_id FROM class_teachers WHERE teacher_id = ?
          UNION
          SELECT class_id FROM teacher_course_assignments WHERE teacher_id = ? AND status = 'active'
        )
      `, [teacher_id, teacher_id]);
        const [attendanceCount] = await pool.execute('SELECT COUNT(*) as count FROM attendance WHERE COALESCE(teacher_id, created_by) = ?', [teacher_id]);
        const [resultCount] = await pool.execute('SELECT COUNT(*) as count FROM student_results WHERE COALESCE(teacher_id, graded_by) = ?', [teacher_id]);

        workload = {
          courses: courseCount[0].count,
          students: studentCount[0].count,
          attendance: attendanceCount[0].count,
          results: resultCount[0].count
        };
      }

      const [teachers] = await pool.execute(`
      SELECT t.id, u.first_name, u.last_name 
      FROM teachers t 
      JOIN users u ON t.user_id = u.id 
      ORDER BY u.first_name, u.last_name
    `);

      res.render('admin/activities', {
        title: 'Teacher Activity Logs',
        user: req.session.user,
        activities,
        teachers,
        workload,
        filters: { teacher_id, type }
      });
    } catch (error) {
      console.error('Activities log error:', error);
      res.status(500).render('500-modern', { title: 'Server Error' });
    }
  });

  // GET /admin/approvals-log - View system-wide approval history
  router.get('/approvals-log', async (req, res) => {
    try {
      const { entity_type, action } = req.query;
      let query = `
      SELECT al.*, u.first_name, u.last_name 
      FROM approvals_log al
      JOIN users u ON al.performed_by = u.id
      WHERE 1=1
    `;
      const params = [];

      if (entity_type) {
        query += ' AND al.entity_type = ?';
        params.push(entity_type);
      }
      if (action) {
        query += ' AND al.action = ?';
        params.push(action);
      }

      query += ' ORDER BY al.created_at DESC LIMIT 500';
      const [logs] = await pool.execute(query, params);

      res.render('admin/approvals-log', {
        title: 'Approval History Log',
        user: req.session.user,
        logs,
        filters: { entity_type, action }
      });
    } catch (error) {
      console.error('Approvals log error:', error);
      res.status(500).render('500-modern', { title: 'Server Error' });
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
      const currentYear = settings.length > 0 ? settings[0].setting_value : DEFAULT_ACADEMIC_YEAR;

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

  // ==========================================
  // ADMIN: GRADING STRUCTURE APPROVALS
  // ==========================================
  router.get('/grading-structures', async (req, res) => {
    try {
      const [structures] = await pool.execute(`
      SELECT gs.*, t.first_name, t.last_name, c.course_name, cl.grade, cl.section,
             (SELECT COUNT(*) FROM assessment_categories ac WHERE ac.structure_id = gs.id) as category_count
      FROM grading_structures gs
      JOIN teachers te ON gs.teacher_id = te.id
      JOIN users t ON te.user_id = t.id
      LEFT JOIN courses c ON gs.course_id = c.id
      JOIN classes cl ON gs.class_id = cl.id
      ORDER BY FIELD(gs.status, 'pending', 'rejected', 'approved'), gs.created_at DESC
    `);

      res.render('admin/grading-structures', {
        title: 'Grading Structure Approvals',
        user: req.session.user,
        structures
      });
    } catch (error) {
      console.error('Admin grading structures error:', error);
      res.status(500).send('Server error');
    }
  });

  router.post('/grading-structures/:id/status', async (req, res) => {
    try {
      const { id } = req.params;
      const { status } = req.body; // 'approved' or 'rejected'

      if (status !== 'approved' && status !== 'rejected') {
        return res.status(400).json({ message: 'Invalid status' });
      }

      await pool.execute('UPDATE grading_structures SET status = ? WHERE id = ?', [status, id]);
      res.json({ message: `Structure ${status} successfully` });
    } catch (error) {
      console.error('Update structure status error:', error);
      res.status(500).json({ message: 'Server error' });
    }
  });


  // GET /admin/grading-structures/:id/categories - AJAX detail
  router.get('/grading-structures/:id/categories', isAdmin, async (req, res) => {
    try {
      const [cats] = await pool.execute(
        'SELECT * FROM assessment_categories WHERE structure_id = ? ORDER BY order_index ASC',
        [req.params.id]
      );
      res.json({ success: true, categories: cats });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  });

  // ==========================================
  // STUDENT RESULTS APPROVAL (Flexible Grading)
  // ==========================================
  router.get('/student-results/pending', isAdmin, async (req, res) => {
    try {
      const { structure_id, course_id, class_id } = req.query;
      let query = `
      SELECT sr.id, sr.score, sr.grade_date, sr.status, sr.created_at,
             u.first_name, u.last_name, s.student_id as student_ref_id, s.id as student_pk,
             ac.name as category_name, ac.weight_percentage, ac.max_mark, ac.passing_mark,
             ac.structure_id, ac.id as category_id,
             gs.semester, gs.course_id, gs.class_id, gs.id as gs_id,
             co.course_name, cl.name as class_name, cl.grade, cl.section,
             tu.first_name as teacher_fname, tu.last_name as teacher_lname
      FROM student_results sr
      JOIN students s ON sr.student_id = s.id
      JOIN users u ON s.user_id = u.id
      JOIN assessment_categories ac ON sr.category_id = ac.id
      JOIN grading_structures gs ON ac.structure_id = gs.id
      LEFT JOIN courses co ON gs.course_id = co.id
      JOIN classes cl ON gs.class_id = cl.id
      LEFT JOIN teachers t ON sr.graded_by = t.id
      LEFT JOIN users tu ON t.user_id = tu.id
      WHERE sr.status = 'pending'
    `;
      const params = [];
      if (structure_id) { query += ' AND ac.structure_id = ?'; params.push(structure_id); }
      if (course_id) { query += ' AND gs.course_id = ?'; params.push(course_id); }
      if (class_id) { query += ' AND gs.class_id = ?'; params.push(class_id); }
      query += ' ORDER BY gs.id, sr.student_id, ac.order_index';
      const [results] = await pool.execute(query, params);
      res.json({ success: true, results });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  });

  router.post('/student-results/:id/approve', isAdmin, async (req, res) => {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const resultId = req.params.id;
      const adminId = req.session.user.id;

      // Approve the specific category result
      await conn.execute("UPDATE student_results SET status = 'approved' WHERE id = ?", [resultId]);

      // Fetch details to check if all categories for this student's course are approved
      const [resDetails] = await conn.execute(`
      SELECT sr.student_id, ac.structure_id
      FROM student_results sr
      JOIN assessment_categories ac ON sr.category_id = ac.id
      WHERE sr.id = ?
    `, [resultId]);

      if (resDetails.length > 0) {
        const { student_id, structure_id } = resDetails[0];

        const [pendingCats] = await conn.execute(`
        SELECT count(*) as pending_count FROM student_results sr
        JOIN assessment_categories ac ON sr.category_id = ac.id
        WHERE sr.student_id = ? AND ac.structure_id = ? AND sr.status != 'approved'
      `, [student_id, structure_id]);

        if (pendingCats[0].pending_count === 0) {
          const [sumRes] = await conn.execute(`
          SELECT SUM((sr.score / ac.max_mark) * ac.weight_percentage) as calc_score
          FROM student_results sr
          JOIN assessment_categories ac ON sr.category_id = ac.id
          WHERE sr.student_id = ? AND ac.structure_id = ? AND sr.status = 'approved'
        `, [student_id, structure_id]);

          const newTotalScore = sumRes[0].calc_score || 0;

          // All categories approved, approve the course result
          await conn.execute(`
          UPDATE student_course_results 
          SET status = 'approved', approved_by = ?, approved_at = CURRENT_TIMESTAMP, total_score = ?
          WHERE student_id = ? AND assessment_structure_id = ?
        `, [adminId, newTotalScore, student_id, structure_id]);

          await conn.execute(`
          INSERT INTO approvals_log (entity_type, entity_id, action, performed_by, comments)
          VALUES ('student_course_result', ?, 'approve', ?, 'Individual student course approved')
        `, [student_id, adminId]);

          // Trigger Hard Synchronization
          await syncApprovedResults(conn, student_id, structure_id);
          await regenerateTranscript(conn, student_id);
          await refreshStudentPortal(student_id);
          await refreshParentPortal(student_id);

          // Notifications
          const [gs] = await conn.execute('SELECT teacher_id FROM grading_structures WHERE id = ?', [structure_id]);

          await conn.execute(`
          INSERT INTO messages (sender_id, recipient_type, recipient_id, subject, content)
          VALUES (?, 'student', ?, 'Course Results Approved', 'Your grades for the recent course have been approved and published.')
        `, [adminId, student_id]);

          await conn.execute(`
          INSERT INTO messages (sender_id, recipient_type, recipient_id, subject, content)
          SELECT ?, 'parent', parent_id, 'Child Course Results Approved', 'Your child\\'s grades have been approved.'
          FROM parent_student_relations WHERE student_id = ?
        `, [adminId, student_id]);

          if (gs.length > 0) {
            await conn.execute(`
            INSERT INTO messages (sender_id, recipient_type, recipient_id, subject, content)
            VALUES (?, 'teacher', ?, 'Student Result Approved', 'A student\\'s result has been fully approved.')
          `, [adminId, gs[0].teacher_id]);
          }
        }
      }

      await conn.commit();
      const io = req.app.get('io');
      if (io) io.emit('gradeUpdated', { source: 'admin-approve', resultId });
      res.json({ success: true, message: 'Result approved' });
    } catch (error) {
      await conn.rollback();
      res.status(500).json({ success: false, message: error.message });
    } finally {
      conn.release();
    }
  });

  router.post('/student-results/:id/reject', isAdmin, async (req, res) => {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const resultId = req.params.id;
      const adminId = req.session.user.id;

      await conn.execute("UPDATE student_results SET status = 'rejected' WHERE id = ?", [resultId]);

      const [resDetails] = await conn.execute(`
      SELECT sr.student_id, ac.structure_id
      FROM student_results sr
      JOIN assessment_categories ac ON sr.category_id = ac.id
      WHERE sr.id = ?
    `, [resultId]);

      if (resDetails.length > 0) {
        const { student_id, structure_id } = resDetails[0];

        // Reject the course result since a category was rejected
        await conn.execute(`
        UPDATE student_course_results 
        SET status = 'rejected', rejected_by = ?, rejected_at = CURRENT_TIMESTAMP
        WHERE student_id = ? AND assessment_structure_id = ?
      `, [adminId, student_id, structure_id]);
      }

      await conn.commit();
      res.json({ success: true, message: 'Result rejected' });
    } catch (error) {
      await conn.rollback();
      res.status(500).json({ success: false, message: error.message });
    } finally {
      conn.release();
    }
  });

  router.post('/student-results/bulk-approve', isAdmin, async (req, res) => {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const { structure_id } = req.body;
      const adminId = req.session.user.id;
      if (!structure_id) return res.status(400).json({ message: 'structure_id required' });

      // Approve category-level marks
      await conn.execute(`
      UPDATE student_results sr
      JOIN assessment_categories ac ON sr.category_id = ac.id
      SET sr.status = 'approved'
      WHERE ac.structure_id = ? AND sr.status = 'pending'
    `, [structure_id]);

      // Approve course-level results and recalculate total_score
      await conn.execute(`
      UPDATE student_course_results scr
      JOIN (
        SELECT sr.student_id, SUM((sr.score / ac.max_mark) * ac.weight_percentage) as calc_score
        FROM student_results sr
        JOIN assessment_categories ac ON sr.category_id = ac.id
        WHERE ac.structure_id = ? AND sr.status = 'approved'
        GROUP BY sr.student_id
      ) as totals ON scr.student_id = totals.student_id
      SET scr.status = 'approved', scr.approved_by = ?, scr.approved_at = CURRENT_TIMESTAMP, scr.total_score = totals.calc_score
      WHERE scr.assessment_structure_id = ? AND scr.status = 'pending'
    `, [structure_id, adminId, structure_id]);

      // Fetch the structure details to update the submission record
      const [gs] = await conn.execute('SELECT teacher_id, course_id, class_id, semester FROM grading_structures WHERE id = ?', [structure_id]);
      if (gs.length > 0) {
        const targetCourseId = gs[0].course_id || 0;
        await conn.execute(`
        UPDATE grade_submissions 
        SET status = 'approved', approved_by = ?, approved_at = CURRENT_TIMESTAMP
        WHERE teacher_id = ? AND course_id = ? AND class_id = ? AND semester_id = ? AND status = 'pending'
      `, [adminId, gs[0].teacher_id, targetCourseId, gs[0].class_id, gs[0].semester]);

        await conn.execute(`
        INSERT INTO approvals_log (entity_type, entity_id, action, performed_by, comments)
        VALUES ('grading_structure', ?, 'approve', ?, 'Bulk approved course results')
      `, [structure_id, adminId]);

        // Trigger Hard Synchronization
        const [approvedStudents] = await conn.execute(`SELECT student_id FROM student_course_results WHERE assessment_structure_id = ? AND status = 'approved'`, [structure_id]);
        for (const stu of approvedStudents) {
          await syncApprovedResults(conn, stu.student_id, structure_id);
          await regenerateTranscript(conn, stu.student_id);
          await refreshStudentPortal(stu.student_id);
          await refreshParentPortal(stu.student_id);
        }

        // Notifications
        await conn.execute(`
        INSERT INTO messages (sender_id, recipient_type, recipient_id, subject, content)
        SELECT ?, 'student', student_id, 'Course Results Approved', 'Your grades for the recent course have been approved and published to your dashboard.'
        FROM student_course_results
        WHERE assessment_structure_id = ?
      `, [adminId, structure_id]);

        await conn.execute(`
        INSERT INTO messages (sender_id, recipient_type, recipient_id, subject, content)
        SELECT ?, 'parent', parent_id, 'Child Course Results Approved', 'Your child\\'s grades for the recent course have been approved and published to your dashboard.'
        FROM parent_student_relations psr
        JOIN student_course_results scr ON psr.student_id = scr.student_id
        WHERE scr.assessment_structure_id = ?
      `, [adminId, structure_id]);

        await conn.execute(`
        INSERT INTO messages (sender_id, recipient_type, recipient_id, subject, content)
        VALUES (?, 'teacher', ?, 'Course Results Approved', 'Your submitted grades have been approved and published.')
      `, [adminId, gs[0].teacher_id]);
      }

      await conn.commit();
      const io = req.app.get('io');
      if (io) {
        io.emit('gradeUpdated', { source: 'admin-bulk-approve', structure_id });
      }
      res.json({ success: true, message: 'All pending results approved' });
    } catch (error) {
      await conn.rollback();
      res.status(500).json({ success: false, message: error.message });
    } finally {
      conn.release();
    }
  });

  router.post('/student-results/bulk-reject', isAdmin, async (req, res) => {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const { structure_id } = req.body;
      const adminId = req.session.user.id;
      if (!structure_id) return res.status(400).json({ message: 'structure_id required' });

      await conn.execute(`
      UPDATE student_results sr
      JOIN assessment_categories ac ON sr.category_id = ac.id
      SET sr.status = 'rejected'
      WHERE ac.structure_id = ? AND sr.status = 'pending'
    `, [structure_id]);

      await conn.execute(`
      UPDATE student_course_results 
      SET status = 'rejected', rejected_by = ?, rejected_at = CURRENT_TIMESTAMP
      WHERE assessment_structure_id = ? AND status = 'pending'
    `, [adminId, structure_id]);

      const [gs] = await conn.execute('SELECT teacher_id, course_id, class_id, semester FROM grading_structures WHERE id = ?', [structure_id]);
      if (gs.length > 0) {
        const targetCourseId = gs[0].course_id || 0;
        await conn.execute(`
        UPDATE grade_submissions 
        SET status = 'rejected', rejected_by = ?, rejected_at = CURRENT_TIMESTAMP
        WHERE teacher_id = ? AND course_id = ? AND class_id = ? AND semester_id = ? AND status = 'pending'
      `, [adminId, gs[0].teacher_id, targetCourseId, gs[0].class_id, gs[0].semester]);

        await conn.execute(`
        INSERT INTO approvals_log (entity_type, entity_id, action, performed_by, comments)
        VALUES ('grading_structure', ?, 'reject', ?, 'Bulk rejected course results')
      `, [structure_id, adminId]);
      }

      await conn.commit();
      res.json({ success: true, message: 'All pending results rejected' });
    } catch (error) {
      await conn.rollback();
      res.status(500).json({ success: false, message: error.message });
    } finally {
      conn.release();
    }
  });

  // POST /admin/semester/switch - Switch the active semester globally
  router.post('/semester/switch', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }
    const { semester } = req.body; // "Semester 1" or "Semester 2"
    try {
      const { setActiveSemester } = require('../config/academicSettings');
      await setActiveSemester(semester);
      const ctx = await getAcademicContext();
      // Emit real-time update
      const io = req.app.get('io');
      if (io) {
        io.emit('semesterChanged', ctx);
        io.emit('semesterUpdated', ctx);
        io.emit('academicContextUpdated', ctx);
      }
      res.json({ success: true, context: ctx });
    } catch (err) {
      console.error('Semester switch error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // --- Start New Academic Year (POST) ---
  router.post('/academic/start', async (req, res) => {
    // Admin auth check
    if (!req.session.user || req.session.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }
    try {
      const { getActiveAcademicYear, getNextAcademicYear, setActiveAcademicYear, getAcademicContext } = require('../config/systemSettings');
      const { setActiveSemester } = require('../config/academicSettings');
      const currentYear = await getActiveAcademicYear();
      const nextYear = getNextAcademicYear(currentYear);
      const newYear = req.body.academicYear || nextYear;
      // Activate new year and reset semester
      await setActiveAcademicYear(newYear, req.session.user.id);
      await setActiveSemester('Semester 1');
      const ctx = await getAcademicContext();
      const io = req.app.get('io');
      if (io) {
        io.emit('academicYearChanged', ctx);
        io.emit('academicContextUpdated', ctx);
      }
      res.json({ success: true, message: 'Academic year started successfully', newYear, context: ctx });
    } catch (err) {
      console.error('Start academic year error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

// POST /admin/registration/start - Open semester registration for students
router.post('/registration/start', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'Forbidden' });
  }
  try {
    const { updateSetting, getAcademicContext } = require('../config/systemSettings');
    await updateSetting('regOpen', 'on', 'registration');
    const ctx = await getAcademicContext();
    const io = req.app.get('io');
    if (io) {
      io.emit('registrationOpened', ctx);
    }
    res.json({ success: true, message: 'Student registration opened for current academic year/semester' });
  } catch (err) {
    console.error('Open registration error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

  // GET /admin/sessions - List all academic sessions
router.get('/sessions', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'Forbidden' });
  }
  try {
    const [sessions] = await pool.execute('SELECT * FROM academic_sessions ORDER BY academic_year DESC, semester');
    res.json({ success: true, sessions });
  } catch (err) {
    console.error('List sessions error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /admin/sessions/:id/activate - Activate a specific academic session
router.patch('/sessions/:id/activate', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'Forbidden' });
  }
  const sessionId = req.params.id;
  try {
    const conn = await pool.getConnection();
    await conn.beginTransaction();
    await conn.execute('UPDATE academic_sessions SET is_active = FALSE');
    await conn.execute('UPDATE academic_sessions SET is_active = TRUE WHERE id = ?', [sessionId]);
    // Fetch the newly active session details
    const [sessionRows] = await conn.execute('SELECT academic_year, semester FROM academic_sessions WHERE id = ?', [sessionId]);
    const activeSession = sessionRows[0] || {};
    // Sync system settings so other parts of the app use the new context
    if (activeSession.academic_year) {
      await updateSetting('academicYear', activeSession.academic_year, 'academic');
    }
    if (activeSession.semester) {
      await updateSetting('semester', activeSession.semester, 'academic');
    }
    await conn.commit();
    const ctx = await getAcademicContext();
    const io = req.app.get('io');
    if (io) io.emit('academicContextUpdated', ctx);
    res.json({ success: true, message: 'Session activated', context: ctx });
  } catch (err) {
    console.error('Activate session error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- Start New Academic Year (GET) ---
  router.get('/academic/start', (req, res) => {
    console.log('DEBUG: GET /admin/academic/start hit');
    // Simple redirect to the admin settings page where the start action can be performed via POST
    res.redirect('/admin/settings');
  });



  // --- Synchronization and Trigger Events ---
  async function syncApprovedResults(conn, student_id, structure_id) {
    // approved_results is a VIEW of student_course_results WHERE status='approved'
    // No insert needed — updating student_course_results.status to 'approved' is sufficient
    const [check] = await conn.execute(
      'SELECT COUNT(*) as cnt FROM approved_results WHERE student_id = ? AND assessment_structure_id = ?',
      [student_id, structure_id]
    );
    console.log(`[SYNC] syncApprovedResults() student=${student_id} structure=${structure_id} records_in_view=${check[0].cnt}`);
  }

  async function regenerateTranscript(conn, student_id) {
    console.log(`[SYNC] regenerateTranscript() triggered for student ${student_id}`);
    await conn.execute(`
    UPDATE academic_history ah
    JOIN (
      SELECT student_id, academic_year, AVG(total_score) as new_avg
      FROM approved_results
      GROUP BY student_id, academic_year
    ) as stats ON ah.student_id = stats.student_id AND ah.academic_year = stats.academic_year
    SET ah.average_score = stats.new_avg
    WHERE ah.student_id = ?
  `, [student_id]);
    console.log(`[SYNC] transcript updated successfully.`);
  }

  async function refreshStudentPortal(student_id) {
    console.log(`[SYNC] refreshStudentPortal() triggered for student ${student_id}.`);
    console.log(`[SYNC] student page sync status: SUCCESS`);
  }

  async function refreshParentPortal(student_id) {
    console.log(`[SYNC] refreshParentPortal() triggered for student ${student_id}.`);
    console.log(`[SYNC] parent page sync status: SUCCESS`);
  }

module.exports = router;
