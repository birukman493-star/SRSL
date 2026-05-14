const express = require('express');
const { pool } = require('../config/db');
const fs = require('fs');
const path = require('path');
const router = express.Router();

// Middleware to check if user is teacher and resolve their profile ID
async function isTeacher(req, res, next) {
  const logFile = path.join(__dirname, '../tmp/teacher_access.log');
  const log = (msg) => {
    const timestamp = new Date().toISOString();
    try {
      const logDir = path.dirname(logFile);
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }
      fs.appendFileSync(logFile, `[${timestamp}] ${msg}\n`);
    } catch (err) {
      console.error('Logging error:', err);
    }
    console.log(msg);
  };

  if (!req.session.user) {
    log('Teacher Access Denied: No session user. Redirecting to login.');
    return res.redirect('/auth/login');
  }

  if (req.session.user.role !== 'teacher') {
    log(`Teacher Access Denied: User role is ${req.session.user.role}. Redirecting to their dashboard.`);
    return res.redirect('/dashboard');
  }

  try {
    const [teacherProfiles] = await pool.execute(
      'SELECT id FROM teachers WHERE user_id = ?',
      [req.session.user.id]
    );

    if (teacherProfiles.length === 0) {
      log(`Teacher Profile Missing for user ID ${req.session.user.id}`);
      return res.status(403).render('500-modern', {
        title: 'Access Denied',
        message: 'Teacher profile not found for this user.'
      });
    }

    req.teacherId = teacherProfiles[0].id;
    next();
  } catch (error) {
    log(`Teacher middleware error: ${error.message}`);
    res.status(500).render('500-modern', { title: 'Server Error', message: error.message });
  }
}

// Apply teacher middleware to all routes
router.use(isTeacher);

// GET /teacher/dashboard - Teacher dashboard
router.get('/dashboard', async (req, res) => {
  try {
    const teacherId = req.teacherId;

    // Get teacher's assigned classes
    const [classes] = await pool.execute(`
      SELECT c.*, COUNT(s.id) as student_count
      FROM classes c
      LEFT JOIN students s ON c.grade = s.grade_level AND c.section = s.section AND s.withdrawal_status = 'active'
      WHERE c.id IN (SELECT class_id FROM class_teachers WHERE teacher_id = ?)
      GROUP BY c.id
    `, [teacherId]);

    // Get total students count
    const [studentCount] = await pool.execute(`
      SELECT COUNT(DISTINCT s.id) as total_students
      FROM students s
      JOIN classes c ON s.grade_level = c.grade AND s.section = c.section
      WHERE c.id IN (SELECT class_id FROM class_teachers WHERE teacher_id = ?) AND s.withdrawal_status = 'active'
    `, [teacherId]);

    // Get assignments count
    const [assignmentsCount] = await pool.execute(`
      SELECT COUNT(*) as count
      FROM assignments a
      JOIN classes c ON a.class_id = c.id
      WHERE c.id IN (SELECT class_id FROM class_teachers WHERE teacher_id = ?)
    `, [teacherId]);

    // Get today's attendance rate
    const [attendanceRate] = await pool.execute(`
      SELECT AVG(CASE WHEN a.status = 'present' THEN 1 ELSE 0 END) * 100 as rate
      FROM attendance a
      JOIN students s ON a.student_id = s.id
      JOIN classes c ON s.grade_level = c.grade AND s.section = c.section
      WHERE c.id IN (SELECT class_id FROM class_teachers WHERE teacher_id = ?) AND a.date = CURDATE() AND s.withdrawal_status = 'active'
    `, [teacherId]);

    // Get recent activities
    const [activities] = await pool.execute(`
      SELECT 
        'attendance' as type,
        CONCAT('Attendance recorded for ', c.name) as description,
        a.created_at
      FROM attendance a
      JOIN students s ON a.student_id = s.id
      JOIN classes c ON s.grade_level = c.grade AND s.section = c.section
      WHERE c.id IN (SELECT class_id FROM class_teachers WHERE teacher_id = ?) AND a.date = CURDATE()
      
      UNION ALL
      
      SELECT 
        'grade' as type,
        CONCAT('Grades updated for ', c.name) as description,
        g.created_at
      FROM grades g
      JOIN classes c ON g.class_id = c.id
      WHERE c.id IN (SELECT class_id FROM class_teachers WHERE teacher_id = ?) AND g.created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
      
      UNION ALL
      
      SELECT 
        'assignment' as type,
        CONCAT('Assignment uploaded for ', c.name) as description,
        a.created_at
      FROM assignments a
      JOIN classes c ON a.class_id = c.id
      WHERE c.id IN (SELECT class_id FROM class_teachers WHERE teacher_id = ?) AND a.created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
      
      ORDER BY created_at DESC
      LIMIT 5
    `, [teacherId, teacherId, teacherId]);

    // Get today's schedule
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const today = days[new Date().getDay()];

    const [todaySchedule] = await pool.execute(`
      SELECT cs.*, c.course_name, c.course_code, cl.name as class_name
      FROM class_schedule cs
      JOIN courses c ON cs.course_id = c.id
      JOIN classes cl ON cs.class_id = cl.id
      WHERE cl.id IN (SELECT class_id FROM class_teachers WHERE teacher_id = ?) AND cs.day_of_week = ?
      ORDER BY cs.start_time
    `, [teacherId, today]);

    res.render('teacher/dashboard', {
      title: 'Teacher Dashboard',
      user: req.session.user,
      stats: {
        classes: classes.length,
        students: (studentCount[0] && studentCount[0].total_students) || 0,
        pendingGrades: (assignmentsCount[0] && assignmentsCount[0].count) || 0,
        attendanceRate: Math.round((attendanceRate[0] && attendanceRate[0].rate) || 0)
      },
      classes,
      activities,
      todaySchedule
    });

  } catch (error) {
    console.error('Teacher dashboard error:', error);
    res.status(500).render('500-modern', { title: 'Server Error', message: error.message });
  }
});

// 1. View assigned classes and students
router.get('/classes', async (req, res) => {
  try {
    const teacherId = req.teacherId;
    const { grade } = req.query;

    let query = `
      SELECT c.*, COUNT(s.id) as student_count
      FROM classes c
      LEFT JOIN students s ON c.grade = s.grade_level AND c.section = s.section AND s.withdrawal_status = 'active'
      WHERE c.id IN (SELECT class_id FROM class_teachers WHERE teacher_id = ?)
    `;
    let params = [teacherId];

    if (grade) {
      query += ` AND c.grade = ?`;
      params.push(grade);
    }

    query += ` GROUP BY c.id ORDER BY c.grade, c.section`;

    const [classes] = await pool.execute(query, params);

    res.render('teacher/classes', {
      title: 'My Classes',
      user: req.session.user,
      classes
    });

  } catch (error) {
    console.error('Classes error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get students for a specific class
router.get('/classes/:id/students', async (req, res) => {
  try {
    const teacherId = req.teacherId;
    const classId = req.params.id;

    // Verify teacher has access to this class
    const [classCheck] = await pool.execute(
      'SELECT id FROM classes WHERE id = ? AND id IN (SELECT class_id FROM class_teachers WHERE teacher_id = ?)',
      [classId, teacherId]
    );

    if (classCheck.length === 0) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const [students] = await pool.execute(`
      SELECT u.id as user_id, s.id as student_pk, u.first_name, u.last_name, u.email, s.student_id,
             (SELECT AVG(g.score) FROM grades g WHERE g.student_id = s.id) as average_grade,
             (SELECT COUNT(a.id) FROM attendance a WHERE a.student_id = s.id AND a.status = 'present') / 
             NULLIF((SELECT COUNT(*) FROM attendance a WHERE a.student_id = s.id), 0) * 100 as attendance_rate
      FROM users u
      JOIN students s ON u.id = s.user_id
      JOIN classes c ON s.grade_level = c.grade AND s.section = c.section
      WHERE c.id = ? AND u.role = 'student' AND s.withdrawal_status = 'active'
      ORDER BY u.last_name, u.first_name
    `, [classId]);

    res.json(students);

  } catch (error) {
    console.error('Students error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// 2. Record student attendance
router.post('/attendance/save', async (req, res) => {
  try {
    const { classId, date, attendanceType, attendance } = req.body;
    const teacherId = req.teacherId;

    // Verify teacher has access to this class
    const [classCheck] = await pool.execute(
      'SELECT id FROM classes WHERE id = ? AND id IN (SELECT class_id FROM class_teachers WHERE teacher_id = ?)',
      [classId, teacherId]
    );

    if (classCheck.length === 0) {
      return res.status(403).json({ message: 'Access denied' });
    }

    // Save attendance for each student
    const studentIds = Object.keys(attendance);
    for (const studentId of studentIds) {
      const data = attendance[studentId];
      await pool.execute(`
        INSERT INTO attendance (student_id, class_id, date, status, notes, attendance_type, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE status = ?, notes = ?, attendance_type = ?
      `, [
        studentId, classId, date, data.status, data.notes || '', attendanceType || 'daily', teacherId,
        data.status, data.notes || '', attendanceType || 'daily'
      ]);
    }

    res.json({ message: 'Attendance saved successfully' });

  } catch (error) {
    console.error('Save attendance error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /teacher/attendance - Show attendance dashboard
router.get('/attendance', async (req, res) => {
  try {
    const teacherId = req.teacherId;
    const [classes] = await pool.execute('SELECT id, name, grade, section FROM classes WHERE id IN (SELECT class_id FROM class_teachers WHERE teacher_id = ?)', [teacherId]);
    res.render('teacher/attendance-index', {
      title: 'Attendance Management',
      user: req.session.user,
      classes
    });
  } catch (error) {
    res.status(500).render('500-modern', { title: 'Server Error', message: error.message });
  }
});

// Get attendance data for a class
router.get('/attendance/:classId/:date', async (req, res) => {
  try {
    const teacherId = req.teacherId;
    const { classId, date } = req.params;

    // Verify teacher has access to this class
    const [classCheck] = await pool.execute(
      'SELECT id FROM classes WHERE id = ? AND id IN (SELECT class_id FROM class_teachers WHERE teacher_id = ?)',
      [classId, teacherId]
    );

    if (classCheck.length === 0) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const [attendance] = await pool.execute(`
      SELECT s.id as student_pk, u.first_name, u.last_name, s.student_id, a.status, a.notes
      FROM users u
      JOIN students s ON u.id = s.user_id
      JOIN classes c ON s.grade_level = c.grade AND s.section = c.section
      LEFT JOIN attendance a ON s.id = a.student_id AND a.date = ? AND a.class_id = ?
      WHERE c.id = ? AND u.role = 'student' AND s.withdrawal_status = 'active'
      ORDER BY u.last_name, u.first_name
    `, [date, classId, classId]);

    res.render('teacher/attendance', {
      title: 'Class Attendance',
      user: req.session.user,
      classId,
      date,
      attendance
    });

  } catch (error) {
    console.error('Get attendance error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// 3. Enter and update student grades
router.post('/grades/save', async (req, res) => {
  try {
    const { classId, assessmentType, title, maxPoints, gradeWeight, gradeDate, grades: studentGrades } = req.body;
    const teacherId = req.teacherId;

    // Verify teacher has access to this class
    const [classCheck] = await pool.execute(
      'SELECT id FROM classes WHERE id = ? AND id IN (SELECT class_id FROM class_teachers WHERE teacher_id = ?)',
      [classId, teacherId]
    );

    if (classCheck.length === 0) {
      return res.status(403).json({ message: 'Access denied' });
    }

    // Save grades for each student
    for (const [studentId, gradeData] of Object.entries(studentGrades)) {
      await pool.execute(`
        INSERT INTO grades (
            student_id, class_id, assessment_type, title, score, mid_score, test_score, 
            attendance_score, final_score, max_score, weight, grade_date, notes, 
            created_by, status, academic_rank, academic_status
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
        ON DUPLICATE KEY UPDATE 
            score = ?, mid_score = ?, test_score = ?, attendance_score = ?, 
            final_score = ?, max_score = ?, weight = ?, grade_date = ?, notes = ?, 
            status = 'pending', academic_rank = ?, academic_status = ?
      `, [
        studentId, classId, assessmentType, title, gradeData.score || 0, gradeData.mid_score || 0, gradeData.test_score || 0,
        gradeData.attendance_score || 0, gradeData.final_score || 0, maxPoints, gradeWeight, gradeDate, gradeData.notes || '',
        teacherId, gradeData.academic_rank || null, gradeData.academic_status || null,

        gradeData.score || 0, gradeData.mid_score || 0, gradeData.test_score || 0, gradeData.attendance_score || 0,
        gradeData.final_score || 0, maxPoints, gradeWeight, gradeDate, gradeData.notes || '',
        gradeData.academic_rank || null, gradeData.academic_status || null
      ]);
    }

    res.json({ message: 'Grades saved successfully' });

  } catch (error) {
    console.error('Save grades error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /teacher/grades - Show grades dashboard
router.get('/grades', async (req, res) => {
  try {
    const teacherId = req.teacherId;
    const [classes] = await pool.execute('SELECT id, name, grade, section FROM classes WHERE id IN (SELECT class_id FROM class_teachers WHERE teacher_id = ?)', [teacherId]);
    res.render('teacher/grades-index', {
      title: 'Grade Management',
      user: req.session.user,
      classes
    });
  } catch (error) {
    res.status(500).render('500-modern', { title: 'Server Error', message: error.message });
  }
});

// Get grades data for a class
router.get('/grades/:classId', async (req, res) => {
  try {
    const teacherId = req.teacherId;
    const { classId } = req.params;

    // Verify teacher has access to this class
    const [classCheck] = await pool.execute(
      'SELECT id FROM classes WHERE id = ? AND id IN (SELECT class_id FROM class_teachers WHERE teacher_id = ?)',
      [classId, teacherId]
    );

    if (classCheck.length === 0) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const [grades] = await pool.execute(`
      SELECT s.id as student_pk, u.first_name, u.last_name, s.student_id,
             g.assessment_type, g.title, g.score, g.mid_score, g.test_score, g.attendance_score, g.final_score, 
             g.max_score, g.weight, g.grade_date, g.notes, g.created_at, g.status,
             g.academic_rank, g.academic_status
      FROM users u
      JOIN students s ON u.id = s.user_id
      JOIN classes c ON s.grade_level = c.grade AND s.section = c.section
      LEFT JOIN grades g ON s.id = g.student_id AND g.class_id = ?
      WHERE c.id = ? AND u.role = 'student' AND s.withdrawal_status = 'active'
      ORDER BY u.last_name, u.first_name, g.created_at DESC
    `, [classId, classId]);

    res.render('teacher/grades', {
      title: 'Class Grades',
      user: req.session.user,
      classId,
      grades
    });

  } catch (error) {
    console.error('Get grades error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// 4. Upload assignments or materials
router.post('/assignments/create', async (req, res) => {
  try {
    const {
      classId, assignmentType, title, dueDate, maxPoints, timeLimit,
      attemptsAllowed, description, learningObjectives, additionalLinks, visibleToStudents
    } = req.body;
    const teacherId = req.teacherId;

    // Verify teacher has access to this class
    const [classCheck] = await pool.execute(
      'SELECT id FROM classes WHERE id = ? AND id IN (SELECT class_id FROM class_teachers WHERE teacher_id = ?)',
      [classId, teacherId]
    );

    if (classCheck.length === 0) {
      return res.status(403).json({ message: 'Access denied' });
    }

    // Create assignment
    await pool.execute(`
      INSERT INTO assignments (
        class_id, assignment_type, title, due_date, max_points, time_limit, 
        attempts_allowed, description, learning_objectives, additional_links, 
        visible_to_students, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      classId, assignmentType, title, dueDate, maxPoints, timeLimit,
      attemptsAllowed, description, learningObjectives, additionalLinks,
      visibleToStudents === 'on' ? 1 : 0, teacherId
    ]);

    res.json({ message: 'Assignment created successfully' });

  } catch (error) {
    console.error('Create assignment error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get assignments for a teacher
router.get('/assignments', async (req, res) => {
  try {
    const teacherId = req.teacherId;

    const [assignments] = await pool.execute(`
      SELECT a.*, c.name as class_name, c.grade, c.section
      FROM assignments a
      JOIN classes c ON a.class_id = c.id
      WHERE c.id IN (SELECT class_id FROM class_teachers WHERE teacher_id = ?)
      ORDER BY a.created_at DESC
    `, [teacherId]);

    const [classes] = await pool.execute(`
      SELECT id, name, grade, section FROM classes WHERE id IN (SELECT class_id FROM class_teachers WHERE teacher_id = ?)
    `, [teacherId]);

    res.render('teacher/assignments', {
      title: 'My Assignments',
      user: req.session.user,
      assignments,
      classes
    });

  } catch (error) {
    console.error('Get assignments error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// --- COURSE MATERIALS ROUTES ---

// GET /teacher/materials - View and manage course materials
router.get('/materials', async (req, res) => {
  try {
    const teacherId = req.teacherId;

    const [materials] = await pool.execute(`
      SELECT m.*, c.name as class_name, c.grade, c.section
      FROM materials m
      JOIN classes c ON m.class_id = c.id
      WHERE m.teacher_id = ?
      ORDER BY m.created_at DESC
    `, [teacherId]);

    const [classes] = await pool.execute(`
      SELECT id, name, grade, section FROM classes WHERE id IN (SELECT class_id FROM class_teachers WHERE teacher_id = ?)
    `, [teacherId]);

    res.render('teacher/materials', {
      title: 'Course Materials',
      user: req.session.user,
      materials,
      classes
    });
  } catch (error) {
    console.error('Get materials error:', error);
    res.status(500).render('500-modern', { title: 'Server Error', message: error.message });
  }
});

// POST /teacher/materials/create - Create new material
router.post('/materials/create', async (req, res) => {
  try {
    const { classId, title, description, fileUrl, materialType } = req.body;
    const teacherId = req.teacherId;

    // Verify class belongs to teacher
    const [classCheck] = await pool.execute(
      'SELECT id FROM classes WHERE id = ? AND id IN (SELECT class_id FROM class_teachers WHERE teacher_id = ?)',
      [classId, teacherId]
    );

    if (classCheck.length === 0) {
      return res.status(403).json({ message: 'Access denied' });
    }

    await pool.execute(`
      INSERT INTO materials (class_id, teacher_id, title, description, file_url, material_type)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [classId, teacherId, title, description, fileUrl, materialType || 'reading']);

    res.json({ message: 'Material added successfully' });
  } catch (error) {
    console.error('Create material error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /teacher/materials/delete/:id - Delete material
router.post('/materials/delete/:id', async (req, res) => {
  try {
    const materialId = req.params.id;
    const teacherId = req.teacherId;

    // Verify material belongs to teacher
    const [materialCheck] = await pool.execute(
      'SELECT id FROM materials WHERE id = ? AND teacher_id = ?',
      [materialId, teacherId]
    );

    if (materialCheck.length === 0) {
      return res.status(403).json({ message: 'Access denied' });
    }

    await pool.execute('DELETE FROM materials WHERE id = ?', [materialId]);

    res.json({ message: 'Material deleted successfully' });
  } catch (error) {
    console.error('Delete material error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get classes for dropdowns
router.get('/classes-list', async (req, res) => {
  try {
    const teacherId = req.teacherId;

    const [classes] = await pool.execute(`
      SELECT id, CONCAT(name, ' - ', grade, section) as display_name
      FROM classes
      WHERE id IN (SELECT class_id FROM class_teachers WHERE teacher_id = ?)
      ORDER BY grade, section
    `, [teacherId]);

    res.json(classes);

  } catch (error) {
    console.error('Get classes list error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /teacher/messages - Teacher messages
router.get('/messages', async (req, res) => {
  try {
    const teacherId = req.teacherId;

    // Fetch received messages
    const [receivedMessages] = await pool.execute(`
      SELECT m.*, u.first_name, u.last_name, u.role as sender_role
      FROM messages m
      JOIN users u ON m.sender_id = u.id
      WHERE m.recipient_type = 'teacher' AND m.recipient_id = ?
      ORDER BY m.created_at DESC
    `, [teacherId]);

    res.render('teacher/messages', {
      title: 'Messages',
      user: req.session.user,
      messages: receivedMessages
    });
  } catch (error) {
    console.error('Messages error:', error);
    res.status(500).render('500-modern', { title: 'Server Error', message: error.message });
  }
});

// GET /teacher/classes/schedule/:id - View class schedule (READ-ONLY, admin manages scheduling)
router.get('/classes/schedule/:id', async (req, res) => {
  try {
    const classId = req.params.id;
    const teacherId = req.teacherId;

    // Verify the teacher is assigned to this class
    const [classInfo] = await pool.execute(
      'SELECT * FROM classes WHERE id = ? AND id IN (SELECT class_id FROM class_teachers WHERE teacher_id = ?)',
      [classId, teacherId]
    );

    if (classInfo.length === 0) {
      return res.status(403).render('500-modern', { title: 'Access Denied', message: 'You do not have access to this class.' });
    }

    const [schedule] = await pool.execute(`
      SELECT cs.*, c.course_name, c.course_code
      FROM class_schedule cs
      JOIN courses c ON cs.course_id = c.id
      WHERE cs.class_id = ?
      ORDER BY FIELD(cs.day_of_week, 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'), cs.start_time
    `, [classId]);

    res.render('teacher/class-schedule', {
      title: 'Class Timetable',
      user: req.session.user,
      classInfo: classInfo[0],
      schedule
    });
  } catch (error) {
    console.error('Teacher view schedule error:', error);
    res.status(500).render('500-modern', { title: 'Server Error' });
  }
});

// GET /teacher/schedule - Teacher's personal weekly schedule
router.get('/schedule', async (req, res) => {
  try {
    const teacherId = req.teacherId;

    const [schedule] = await pool.execute(`
      SELECT cs.*, c.course_name, c.course_code, cl.name as class_name
      FROM class_schedule cs
      JOIN courses c ON cs.course_id = c.id
      JOIN classes cl ON cs.class_id = cl.id
      WHERE cl.id IN (SELECT class_id FROM class_teachers WHERE teacher_id = ?)
      ORDER BY FIELD(cs.day_of_week, 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'), cs.start_time
    `, [teacherId]);

    res.render('teacher/schedule', {
      title: 'My Schedule',
      user: req.session.user,
      schedule
    });
  } catch (error) {
    console.error('Teacher schedule error:', error);
    res.status(500).render('500-modern', { title: 'Server Error', message: error.message });
  }
});

// POST /teacher/classes/schedule/add - BLOCKED: Only admin can schedule classes
router.post('/classes/schedule/add', (req, res) => {
  res.status(403).render('500-modern', {
    title: 'Access Denied',
    message: 'Schedule management is handled by the administrator. Teachers cannot add or modify class schedules.'
  });
});

// POST /teacher/classes/schedule/delete/:id - BLOCKED: Only admin can modify schedules
router.post('/classes/schedule/delete/:id', (req, res) => {
  res.status(403).render('500-modern', {
    title: 'Access Denied',
    message: 'Schedule management is handled by the administrator. Teachers cannot delete class schedule entries.'
  });
});

// GET /teacher/schedule - Teacher personal schedule view
router.get('/schedule', async (req, res) => {
  try {
    const teacherId = req.teacherId;

    // Get all scheduled periods for courses taught by this teacher
    const [schedule] = await pool.execute(`
      SELECT cs.*, c.course_name, c.course_code, cl.name as class_name
      FROM class_schedule cs
      JOIN courses c ON cs.course_id = c.id
      JOIN classes cl ON cs.class_id = cl.id
      WHERE c.id IN (SELECT class_id FROM class_teachers WHERE teacher_id = ?)
      ORDER BY FIELD(cs.day_of_week, 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'), cs.start_time
    `, [teacherId]);

    res.render('teacher/schedule', {
      title: 'My Schedule',
      user: req.session.user,
      schedule
    });
  } catch (error) {
    console.error('Schedule error:', error);
    res.status(500).render('500-modern', { title: 'Server Error', message: error.message });
  }
});

// GET /teacher/profile - View teacher profile
router.get('/profile', async (req, res) => {
  try {
    const userId = req.session.user.id;
    const [teacherData] = await pool.execute(`
      SELECT t.*, u.username, u.email, u.first_name, u.last_name, u.phone, u.created_at
      FROM teachers t
      JOIN users u ON t.user_id = u.id
      WHERE t.user_id = ?
    `, [userId]);

    if (teacherData.length === 0) return res.redirect('/teacher/dashboard');

    const [subjects] = await pool.execute(`
      SELECT s.* 
      FROM subjects s
      JOIN teacher_subjects ts ON s.id = ts.subject_id
      WHERE ts.teacher_id = ?
    `, [teacherData[0].id]);

    res.render('teacher/profile', {
      title: 'Teacher Profile',
      user: req.session.user,
      teacher: teacherData[0],
      subjects
    });
  } catch (error) {
    console.error('Teacher profile error:', error);
    res.status(500).render('500-modern', { title: 'Server Error' });
  }
});

// POST /teacher/profile/update - Update teacher profile
router.post('/profile/update', async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { first_name, last_name, email, phone, department } = req.body;

    // Update users table
    await pool.execute(
      'UPDATE users SET first_name = ?, last_name = ?, email = ?, phone = ? WHERE id = ?',
      [first_name, last_name, email, phone, userId]
    );

    // Update teachers table
    await pool.execute(
      'UPDATE teachers SET first_name = ?, last_name = ?, email = ?, phone = ?, department = ? WHERE user_id = ?',
      [first_name, last_name, email, phone, department, userId]
    );

    // Update session
    req.session.user.first_name = first_name;
    req.session.user.last_name = last_name;
    req.session.user.email = email;

    res.redirect('/teacher/profile');
  } catch (error) {
    console.error('Teacher profile update error:', error);
    res.redirect('back');
  }
});

// GET /teacher/announcements - View school announcements
router.get('/announcements', async (req, res) => {
  try {
    const [announcements] = await pool.execute(`
      SELECT a.*, u.first_name, u.last_name
      FROM announcements a
      LEFT JOIN users u ON a.created_by = u.id
      WHERE a.audience IN ('all', 'teachers')
      ORDER BY a.created_at DESC
    `);

    res.render('teacher/announcements', {
      title: 'Announcements',
      user: req.session.user,
      announcements
    });
  } catch (error) {
    console.error('Teacher announcements error:', error);
    res.status(500).render('500-modern', { title: 'Server Error', message: error.message });
  }
});

// GET /teacher/students - View all students in teacher's classes
router.get('/students', async (req, res) => {
  try {
    const teacherId = req.teacherId;

    const [students] = await pool.execute(`
      SELECT DISTINCT s.*, u.first_name, u.last_name, u.email, u.phone, 
             c.name as class_name, c.grade, c.section
      FROM students s
      JOIN users u ON s.user_id = u.id
      JOIN classes c ON s.grade_level = c.grade AND s.section = c.section
      WHERE c.id IN (SELECT class_id FROM class_teachers WHERE teacher_id = ?)
      ORDER BY u.last_name, u.first_name
    `, [teacherId]);

    res.render('teacher/students', {
      title: 'My Students',
      user: req.session.user,
      students
    });
  } catch (error) {
    console.error('Teacher students error:', error);
    res.status(500).render('500-modern', { title: 'Server Error', message: error.message });
  }
});

module.exports = router;