const express = require('express');
const { pool } = require('../config/db');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const { pool: dbPool } = require('../config/db'); // Use alias if needed or just use pool

// Helper to log teacher activity
async function logActivity(teacherId, type, desc, classId = null, courseId = null) {
  try {
    await pool.execute(
      'INSERT INTO teacher_activities (teacher_id, activity_type, description, class_id, course_id) VALUES (?, ?, ?, ?, ?)',
      [teacherId, type, desc, classId, courseId]
    );
  } catch (e) {
    console.error('Logging error:', e);
  }
}


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

    // Get teacher's assigned classes and courses
    const [assignedCourses] = await pool.execute(`
      SELECT tca.*, c.name as class_name, c.grade, c.section, co.course_name, co.course_code
      FROM teacher_course_assignments tca
      JOIN classes c ON tca.class_id = c.id
      JOIN courses co ON tca.course_id = co.id
      WHERE tca.teacher_id = ? AND tca.status = 'active'
    `, [teacherId]);

    // Get total students count across all assigned classes
    const [studentCount] = await pool.execute(`
      SELECT COUNT(DISTINCT s.id) as total_students
      FROM students s
      JOIN classes c ON s.grade_level = c.grade AND s.section = c.section
      WHERE c.id IN (
        SELECT class_id FROM teacher_course_assignments WHERE teacher_id = ? AND status = 'active'
        UNION
        SELECT class_id FROM class_teachers WHERE teacher_id = ?
      ) 
    `, [teacherId, teacherId]);

    // Get assigned classes count
    const [classesCount] = await pool.execute(`
      SELECT COUNT(DISTINCT class_id) as count FROM (
        SELECT class_id FROM teacher_course_assignments WHERE teacher_id = ? AND status = 'active'
        UNION
        SELECT class_id FROM class_teachers WHERE teacher_id = ?
      ) as combined_classes
    `, [teacherId, teacherId]);

    // Get assigned classes details - Updated to UNION both assignment types
    const [classes] = await pool.execute(`
      SELECT DISTINCT c.*, co.course_name, co.course_code,
             (SELECT COUNT(*) FROM students WHERE grade_level = c.grade AND section = c.section AND withdrawal_status = 'active') as student_count,
             'course' as assignment_type
      FROM classes c
      JOIN teacher_course_assignments tca ON c.id = tca.class_id
      JOIN courses co ON tca.course_id = co.id
      WHERE tca.teacher_id = ? AND tca.status = 'active'
      
      UNION
      
      SELECT DISTINCT c.*, 'Daily Attendance' as course_name, 'DAILY' as course_code,
             (SELECT COUNT(*) FROM students WHERE grade_level = c.grade AND section = c.section AND withdrawal_status = 'active') as student_count,
             'homeroom' as assignment_type
      FROM classes c
      JOIN class_teachers ct ON c.id = ct.class_id
      WHERE ct.teacher_id = ?
      
      ORDER BY grade, section
    `, [teacherId, teacherId]);

    // Get pending assignments count for the teacher
    const [assignmentsCount] = await pool.execute(`
      SELECT COUNT(*) as count 
      FROM teacher_course_assignments 
      WHERE teacher_id = ? AND status = 'active'
    `, [teacherId]);

    // Get recent activities (mock or from a table if exists)
    const activities = []; 
    const [attendanceRate] = await pool.execute(`
      SELECT AVG(CASE WHEN a.status IN ('present','late','excused') THEN 1 ELSE 0 END) * 100 as rate
      FROM attendance a
      WHERE a.created_by = ? AND a.date = CURDATE()
    `, [teacherId]);

    // Get today's schedule for specifically assigned courses
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const today = days[new Date().getDay()];

    const [todaySchedule] = await pool.execute(`
      SELECT cs.*, c.course_name, c.course_code, cl.name as class_name
      FROM class_schedule cs
      JOIN courses c ON cs.course_id = c.id
      JOIN classes cl ON cs.class_id = cl.id
      JOIN teacher_course_assignments tca ON (cs.class_id = tca.class_id AND cs.course_id = tca.course_id)
      WHERE tca.teacher_id = ? AND cs.day_of_week = ? AND tca.status = 'active'
      ORDER BY cs.start_time
    `, [teacherId, today]);


    res.render('teacher/dashboard', {
      title: 'Teacher Dashboard',
      user: req.session.user,
      stats: {
        classes: classesCount[0].count,
        students: (studentCount[0] && studentCount[0].total_students) || 0,
        pendingGrades: 0, // Placeholder or actual pending grades count
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
      SELECT c.*, 
             (SELECT COUNT(*) FROM students s WHERE s.grade_level = c.grade AND s.section = c.section AND s.withdrawal_status = 'active') as student_count
      FROM classes c
      WHERE c.id IN (
        SELECT class_id FROM class_teachers WHERE teacher_id = ?
        UNION
        SELECT class_id FROM teacher_course_assignments WHERE teacher_id = ? AND status = 'active'
      )
    `;
    let params = [teacherId, teacherId];

    if (grade) {
      query += ` AND c.grade = ?`;
      params.push(grade);
    }

    query += ` ORDER BY c.grade, c.section`;

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
    const [classCheck] = await pool.execute(`
      SELECT id FROM classes WHERE id = ? AND id IN (
        SELECT class_id FROM class_teachers WHERE teacher_id = ?
        UNION
        SELECT class_id FROM teacher_course_assignments WHERE teacher_id = ? AND status = 'active'
      )
    `, [classId, teacherId, teacherId]);

    if (classCheck.length === 0) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const [students] = await pool.execute(`
      SELECT u.id as user_id, s.id as student_pk, u.first_name, u.last_name, u.email, s.student_id,
             (SELECT AVG(g.score) FROM grades g WHERE g.student_id = s.id AND g.teacher_id = ?) as average_grade,
             (SELECT COUNT(a.id) FROM attendance a WHERE a.student_id = s.id AND a.status = 'present' AND a.teacher_id = ?) / 
             NULLIF((SELECT COUNT(*) FROM attendance a WHERE a.student_id = s.id AND a.teacher_id = ?), 0) * 100 as attendance_rate
      FROM users u
      JOIN students s ON u.id = s.user_id
      JOIN classes c ON s.grade_level = c.grade AND s.section = c.section
      WHERE c.id = ? AND u.role = 'student' AND s.withdrawal_status = 'active'
      ORDER BY u.last_name, u.first_name
    `, [teacherId, teacherId, teacherId, classId]);

    res.json(students);

  } catch (error) {
    console.error('Students error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /teacher/attendance - Show attendance dashboard
router.get('/attendance', async (req, res) => {
  try {
    const teacherId = req.teacherId;
    // Get assigned class-course pairs
    const [assignments] = await pool.execute(`
      SELECT tca.class_id, tca.course_id, c.name as class_name, c.grade, c.section, co.course_name
      FROM teacher_course_assignments tca
      JOIN classes c ON tca.class_id = c.id
      JOIN courses co ON tca.course_id = co.id
      WHERE tca.teacher_id = ? AND tca.status = 'active'
      
      UNION
      
      SELECT ct.class_id, 0 as course_id, c.name as class_name, c.grade, c.section, 'Daily Attendance' as course_name
      FROM class_teachers ct
      JOIN classes c ON ct.class_id = c.id
      WHERE ct.teacher_id = ?
    `, [teacherId, teacherId]);

    res.render('teacher/attendance-index', {
      title: 'Attendance Management',
      user: req.session.user,
      assignments
    });
  } catch (error) {
    res.status(500).render('500-modern', { title: 'Server Error', message: error.message });
  }
});

// Get attendance data for a class/course
router.get('/attendance/:classId/:courseId/:date', async (req, res) => {
  try {
    const teacherId = req.teacherId;
    const { classId, courseId, date } = req.params;

    // Verify teacher is assigned to this class and course
    const [assignmentCheck] = await pool.execute(`
      SELECT id FROM teacher_course_assignments WHERE teacher_id = ? AND class_id = ? AND course_id = ? AND status = 'active'
      UNION
      SELECT id FROM class_teachers WHERE teacher_id = ? AND class_id = ? AND ? = 0
    `, [teacherId, classId, courseId, teacherId, classId, courseId]);

    if (assignmentCheck.length === 0) {
      return res.status(403).render('500-modern', { title: 'Access Denied', message: 'You are not assigned to this course/class.' });
    }

    const [attendance] = await pool.execute(`
      SELECT s.id as student_pk, u.first_name, u.last_name, s.student_id, a.status, a.notes, a.approval_status
      FROM users u
      JOIN students s ON u.id = s.user_id
      JOIN classes c ON s.grade_level = c.grade AND s.section = c.section
      LEFT JOIN attendance a ON s.id = a.student_id AND a.date = ? AND a.class_id = ? AND a.course_id = ? AND a.teacher_id = ?
      WHERE c.id = ? AND u.role = 'student' AND s.withdrawal_status = 'active'
      ORDER BY u.last_name, u.first_name
    `, [date, classId, courseId, teacherId, classId]);

    let courseName = 'Daily Attendance';
    if (courseId != 0) {
      const [courseInfo] = await pool.execute('SELECT course_name FROM courses WHERE id = ?', [courseId]);
      if (courseInfo.length > 0) courseName = courseInfo[0].course_name;
    }

    res.render('teacher/attendance', {
      title: 'Class Attendance',
      user: req.session.user,
      classId,
      courseId,
      courseName,
      date,
      attendance
    });

  } catch (error) {
    console.error('Get attendance error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Record student attendance
router.post('/attendance/save', async (req, res) => {
  try {
    const { classId, courseId, date, attendanceType, attendance } = req.body;
    const teacherId = req.teacherId;

    // Verify assignment
    const [assignmentCheck] = await pool.execute(`
      SELECT id FROM teacher_course_assignments WHERE teacher_id = ? AND class_id = ? AND course_id = ? AND status = 'active'
      UNION
      SELECT id FROM class_teachers WHERE teacher_id = ? AND class_id = ? AND ? = 0
    `, [teacherId, classId, courseId, teacherId, classId, courseId]);

    if (assignmentCheck.length === 0) {
      return res.status(403).json({ message: 'Access denied' });
    }

    // Get academic year, semester, class name, and subject name
    const [classDetails] = await pool.execute('SELECT academic_year, name FROM classes WHERE id = ?', [classId]);
    const academicYear = classDetails[0] ? classDetails[0].academic_year : '';
    const className = classDetails[0] ? classDetails[0].name : '';
    
    let subjectName = 'Daily Attendance';
    if (courseId && courseId != 0) {
      const [courseDetails] = await pool.execute('SELECT course_name FROM courses WHERE id = ?', [courseId]);
      if (courseDetails.length > 0) subjectName = courseDetails[0].course_name;
    }

    const [struct] = await pool.execute(
      'SELECT semester FROM grading_structures WHERE (course_id = ? OR (course_id IS NULL AND ? = 0)) AND class_id = ? AND teacher_id = ? LIMIT 1',
      [courseId, courseId, classId, teacherId]
    );
    const semester = struct[0] ? struct[0].semester : 'Semester 1';

    const studentIds = Object.keys(attendance);
    const dbCourseId = (courseId == 0 || !courseId) ? null : courseId;

    if (studentIds.length > 0) {
      // 1. Batch Insert Attendance
      let insertQuery = `INSERT INTO attendance (student_id, class_id, course_id, date, academic_year, semester, status, notes, attendance_type, created_by, approval_status, teacher_id, semester_id) VALUES `;
      let insertValues = [];
      let insertPlaceholders = [];
      for (const studentId of studentIds) {
        const data = attendance[studentId];
        insertPlaceholders.push(`(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`);
        insertValues.push(
          studentId, classId, dbCourseId, date, academicYear, semester, data.status, data.notes || '', attendanceType || 'daily', teacherId, teacherId, semester
        );
      }
      insertQuery += insertPlaceholders.join(', ');
      insertQuery += ` ON DUPLICATE KEY UPDATE status = VALUES(status), notes = VALUES(notes), attendance_type = VALUES(attendance_type), approval_status = 'pending', academic_year = VALUES(academic_year), semester = VALUES(semester), teacher_id = VALUES(teacher_id), semester_id = VALUES(semester_id)`;
      
      await pool.execute(insertQuery, insertValues);

      // Emit real-time updates to role-based rooms using single standardized payload
      const io = req.app.get('io');
      if (io) {
        const placeholders = studentIds.map(() => '?').join(',');
        
        // 2. Batch fetch parent mappings with User IDs
        const [parentRelations] = await pool.execute(`
          SELECT psr.student_id, p.id as parent_id, p.user_id as parent_user_id 
          FROM parent_student_relations psr
          JOIN parents p ON psr.parent_id = p.id
          WHERE psr.student_id IN (${placeholders})
        `, studentIds);
        
        const parentUserMap = {};
        const parentProfileMap = {};
        parentRelations.forEach(r => {
          if (!parentUserMap[r.student_id]) parentUserMap[r.student_id] = [];
          parentUserMap[r.student_id].push(r.parent_user_id);
          
          if (!parentProfileMap[r.student_id]) parentProfileMap[r.student_id] = [];
          parentProfileMap[r.student_id].push(r.parent_id);
        });

        // Batch fetch student user IDs and registration IDs
        const [studentDetails] = await pool.execute(`
          SELECT id as student_pk, user_id as student_user_id, student_id
          FROM students
          WHERE id IN (${placeholders})
        `, studentIds);
        
        const studentUserMap = {};
        const studentRegMap = {};
        studentDetails.forEach(s => {
          studentUserMap[s.student_pk] = s.student_user_id;
          studentRegMap[s.student_pk] = s.student_id;
        });

        // 3. Batch fetch attendance statistics for these students
        const [stats] = await pool.execute(`
          SELECT student_id,
                 SUM(CASE WHEN status IN ('present', 'late', 'excused') THEN 1 ELSE 0 END) as present_count,
                 SUM(CASE WHEN status = 'absent' THEN 1 ELSE 0 END) as absent_count
          FROM attendance
          WHERE student_id IN (${placeholders}) AND approval_status = 'approved'
          GROUP BY student_id
        `, studentIds);
        
        const statsMap = {};
        stats.forEach(s => {
          statsMap[s.student_id] = { present: parseInt(s.present_count || 0), absent: parseInt(s.absent_count || 0) };
        });

        // Shared payload builder function
        const buildAttendancePayload = (sid, status, studentStats, pid, pUserId) => ({
          studentId: parseInt(sid),
          studentRegId: studentRegMap[sid] || '',
          studentUserId: studentUserMap[sid] || null,
          parentId: pid ? parseInt(pid) : null,
          parentUserId: pUserId ? parseInt(pUserId) : null,
          teacherId: parseInt(teacherId),
          teacherUserId: req.session.user.id,
          classId: parseInt(classId),
          className: className,
          courseId: dbCourseId,
          courseName: subjectName,
          subject: subjectName,
          status: status,
          date: date,
          totalPresent: studentStats ? studentStats.present : 0,
          totalAbsent: studentStats ? studentStats.absent : 0
        });

        // Loop over students to emit role-based updates
        studentIds.forEach(sidStr => {
          const sid = parseInt(sidStr);
          const data = attendance[sidStr];
          const studentStats = statsMap[sid];
          const studentUserId = studentUserMap[sid];

          // Emit to Parent(s) (using parent user ID for the room name parent_${parentUserId})
          const parentUserIds = parentUserMap[sid] || [];
          const parentProfileIds = parentProfileMap[sid] || [];
          parentUserIds.forEach((pUserId, index) => {
            const pid = parentProfileIds[index];
            const payload = buildAttendancePayload(sid, data.status, studentStats, pid, pUserId);
            
            // Emit using user_id based room
            io.to(`parent_${pUserId}`).emit('studentAttendanceUpdated', payload);
            
            // Fallback: Also emit to profile_id based room
            io.to(`parent_${pid}`).emit('studentAttendanceUpdated', payload);
          });

          // Emit to Student (using student user ID for the room name student_${studentUserId})
          const studentPayload = buildAttendancePayload(sid, data.status, studentStats, null, null);
          if (studentUserId) {
            io.to(`student_${studentUserId}`).emit('studentAttendanceUpdated', studentPayload);
          }
          // Fallback: Also emit to profile_id based room
          io.to(`student_${sid}`).emit('studentAttendanceUpdated', studentPayload);
          
          // Emit to Admin
          io.to('admin_dashboard').emit('studentAttendanceUpdated', studentPayload);

          // Emit globally for student/parent real-time dashboard listeners
          const dayName = new Date(date).toLocaleDateString('en-US', { weekday: 'long' });
          const attendanceData = {
            studentId: sid,
            studentUserId: studentUserId || null,
            day: dayName,
            date: date,
            status: data.status,
            courseId: dbCourseId,
            courseName: subjectName,
            subject: subjectName,
            className: className,
            notes: data.notes || '',
            remarks: data.notes || '',
            parentUserIds: parentUserIds
          };
          io.emit('attendanceUpdated', attendanceData);
        });

        // Emit to Teacher Dashboard
        const teacherUserId = req.session.user.id;
        const summaryPayload = {
          classId: parseInt(classId),
          className: className,
          date: date,
          studentIds: studentIds.map(id => parseInt(id))
        };
        io.to(`teacher_${teacherUserId}`).emit('attendanceHistoryUpdated', summaryPayload);
        io.to(`teacher_${teacherId}`).emit('attendanceHistoryUpdated', summaryPayload);
        
        // Emit to Admin
        io.to('admin_dashboard').emit('attendanceHistoryUpdated', summaryPayload);
      }
    }

    // Log activity
    await logActivity(teacherId, 'Attendance Submitted', `Recorded ${attendanceType || 'daily'} attendance for ${date}`, classId, courseId);

    res.json({ message: 'Attendance submitted for approval' });
  } catch (error) {
    console.error('Save attendance error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});


// 3. Enter and update student grades dynamically
router.post('/grades/save', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const { classId, courseId, structureId, gradeDate, studentResults } = req.body;
    const teacherId = req.teacherId;

    // Verify assignment
    const [assignmentCheck] = await conn.execute(`
      SELECT id FROM teacher_course_assignments WHERE teacher_id = ? AND class_id = ? AND course_id = ? AND status = 'active'
      UNION
      SELECT id FROM class_teachers WHERE teacher_id = ? AND class_id = ? AND ? = 0
    `, [teacherId, classId, courseId, teacherId, classId, courseId]);

    if (assignmentCheck.length === 0) {
      await conn.rollback();
      return res.status(403).json({ message: 'Access denied' });
    }

    // Get academic year
    const [classDetails] = await conn.execute('SELECT academic_year FROM classes WHERE id = ?', [classId]);
    const academicYear = classDetails[0] ? classDetails[0].academic_year : '';

    // Get semester
    const [structureDetails] = await conn.execute('SELECT semester FROM grading_structures WHERE id = ? AND teacher_id = ?', [structureId, teacherId]);
    const semester = structureDetails[0] ? structureDetails[0].semester : 'Semester 1';

    const dbCourseId = (courseId == 0 || !courseId) ? null : courseId;

    // Save dynamic grades for each student and category
    for (const [studentId, categories] of Object.entries(studentResults)) {
      for (const [categoryId, score] of Object.entries(categories)) {
        await conn.execute(`
          INSERT INTO student_results (student_id, category_id, score, graded_by, grade_date, status, teacher_id, class_id, course_id, semester, semester_id, academic_year)
          VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE 
            score = ?, graded_by = ?, grade_date = ?, status = 'pending', teacher_id = ?, class_id = ?, course_id = ?, semester = ?, semester_id = ?, academic_year = ?
        `, [
          studentId, categoryId, score, teacherId, gradeDate, teacherId, classId, dbCourseId, semester, semester, academicYear,
          score, teacherId, gradeDate, teacherId, classId, dbCourseId, semester, semester, academicYear
        ]);
      }
    }

    // Now, create or update a grade_submissions record for this class/course/semester batch
    // Using 0 as course_id for general homeroom grades to support database constraints
    const targetCourseId = dbCourseId || 0;
    await conn.execute(`
      INSERT INTO grade_submissions (teacher_id, course_id, class_id, semester_id, academic_year, status, submitted_by, submitted_at, comments)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, CURRENT_TIMESTAMP, NULL)
      ON DUPLICATE KEY UPDATE
        status = 'pending',
        submitted_by = ?,
        submitted_at = CURRENT_TIMESTAMP,
        approved_by = NULL,
        approved_at = NULL,
        rejected_by = NULL,
        rejected_at = NULL,
        comments = NULL
    `, [teacherId, targetCourseId, classId, semester, academicYear, req.session.user.id, req.session.user.id]);

    const [existingSub] = await conn.execute(`
      SELECT id FROM grade_submissions 
      WHERE teacher_id = ? AND course_id = ? AND class_id = ? AND semester_id = ? AND academic_year = ?
    `, [teacherId, targetCourseId, classId, semester, academicYear]);
    const submissionId = existingSub[0].id;

    // Calculate cumulative course scores for each student and save to student_course_results
    for (const studentId of Object.keys(studentResults)) {
      const [categoryScores] = await conn.execute(`
        SELECT 
          SUM((sr.score / ac.max_mark) * ac.weight_percentage) as calculated_score
        FROM student_results sr
        JOIN assessment_categories ac ON sr.category_id = ac.id
        WHERE sr.student_id = ? AND ac.structure_id = ?
      `, [studentId, structureId]);

      const totalScore = categoryScores[0] && categoryScores[0].calculated_score !== null 
        ? parseFloat(categoryScores[0].calculated_score) 
        : 0.00;

      await conn.execute(`
        INSERT INTO student_course_results (
          submission_id, student_id, teacher_id, course_id, class_id, semester_id, academic_year, assessment_structure_id, total_score, status, submitted_by, submitted_at, approved_by, approved_at, rejected_by, rejected_at, comments
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, CURRENT_TIMESTAMP, NULL, NULL, NULL, NULL, NULL)
        ON DUPLICATE KEY UPDATE
          submission_id = ?,
          teacher_id = ?,
          class_id = ?,
          assessment_structure_id = ?,
          total_score = ?,
          status = 'pending',
          submitted_by = ?,
          submitted_at = CURRENT_TIMESTAMP,
          approved_by = NULL,
          approved_at = NULL,
          rejected_by = NULL,
          rejected_at = NULL,
          comments = NULL
      `, [
        submissionId, studentId, teacherId, targetCourseId, classId, semester, academicYear, structureId, totalScore, req.session.user.id,
        submissionId, teacherId, classId, structureId, totalScore, req.session.user.id
      ]);
    }

    // Log activity
    await logActivity(teacherId, 'Grades Submitted', `Recorded student scores for ${gradeDate}`, classId, courseId);

    await conn.commit();
    res.json({ message: 'Grades submitted for approval' });
  } catch (error) {
    await conn.rollback();
    console.error('Save grades error:', error);
    res.status(500).json({ message: 'Server error' });
  } finally {
    conn.release();
  }
});

// POST /teacher/grades/edit - Edit grades after submission with auditable logging and instant sync
router.post('/grades/edit', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const { classId, courseId, structureId, studentResults } = req.body;
    const teacherId = req.teacherId;

    // Verify assignment
    const [assignmentCheck] = await conn.execute(`
      SELECT id FROM teacher_course_assignments WHERE teacher_id = ? AND class_id = ? AND course_id = ? AND status = 'active'
      UNION
      SELECT id FROM class_teachers WHERE teacher_id = ? AND class_id = ? AND ? = 0
    `, [teacherId, classId, courseId, teacherId, classId, courseId]);

    if (assignmentCheck.length === 0) {
      await conn.rollback();
      return res.status(403).json({ message: 'Access denied: You are not assigned to this class/course.' });
    }

    // Get academic year
    const [classDetails] = await conn.execute('SELECT academic_year FROM classes WHERE id = ?', [classId]);
    const academicYear = classDetails[0] ? classDetails[0].academic_year : '';

    // Get semester
    const [structureDetails] = await conn.execute('SELECT semester FROM grading_structures WHERE id = ? AND teacher_id = ?', [structureId, teacherId]);
    const semester = structureDetails[0] ? structureDetails[0].semester : 'Semester 1';

    const dbCourseId = (courseId == 0 || !courseId) ? null : courseId;
    const targetCourseId = dbCourseId || 0;

    // Record dynamic grades and audit logs for each student
    for (const [studentId, categories] of Object.entries(studentResults)) {
      for (const [categoryId, score] of Object.entries(categories)) {
        // Query the old value
        const [oldScoreRecord] = await conn.execute(`
          SELECT score FROM student_results
          WHERE student_id = ? AND category_id = ?
        `, [studentId, categoryId]);

        const old_value = oldScoreRecord[0] ? parseFloat(oldScoreRecord[0].score) : null;
        
        let new_value;
        let comment = null;
        if (score && typeof score === 'object') {
          new_value = parseFloat(score.score);
          comment = score.comment || null;
        } else {
          new_value = parseFloat(score);
        }

        // Only log and update if value has changed
        if (old_value !== new_value) {
          // Update student_results score (preserving or forcing status to match grade submissions status)
          // Since it might already be approved or pending, we set the status to 'approved' if already approved, or 'pending'.
          // Wait, let's look at the current status in student_course_results or student_results for that student.
          const [existingResult] = await conn.execute(`
            SELECT status FROM student_results 
            WHERE student_id = ? AND category_id = ?
          `, [studentId, categoryId]);
          
          const currentStatus = existingResult[0] ? existingResult[0].status : 'pending';

          await conn.execute(`
            INSERT INTO student_results (student_id, category_id, score, graded_by, grade_date, status, teacher_id, class_id, course_id, semester, semester_id, academic_year)
            VALUES (?, ?, ?, ?, CURDATE(), ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE 
              score = ?, graded_by = ?, grade_date = CURDATE(), status = ?, teacher_id = ?, class_id = ?, course_id = ?, semester = ?, semester_id = ?, academic_year = ?
          `, [
            studentId, categoryId, new_value, teacherId, currentStatus, teacherId, classId, dbCourseId, semester, semester, academicYear,
            new_value, teacherId, currentStatus, teacherId, classId, dbCourseId, semester, semester, academicYear
          ]);

          // Insert into grade_change_logs
          await conn.execute(`
            INSERT INTO grade_change_logs (student_id, category_id, old_value, new_value, comment, edited_by, change_time)
            VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          `, [studentId, categoryId, old_value, new_value, comment, teacherId]);
        }
      }
    }

    // Determine target grade submission status
    const [existingSub] = await conn.execute(`
      SELECT id, status FROM grade_submissions 
      WHERE teacher_id = ? AND course_id = ? AND class_id = ? AND semester_id = ? AND academic_year = ?
    `, [teacherId, targetCourseId, classId, semester, academicYear]);

    let submissionId = null;
    let status = 'approved'; // Default to approved if nothing exists, but normally it should exist
    if (existingSub.length > 0) {
      submissionId = existingSub[0].id;
      status = existingSub[0].status;
    } else {
      const [insertSub] = await conn.execute(`
        INSERT INTO grade_submissions (teacher_id, course_id, class_id, semester_id, academic_year, status, submitted_by, submitted_at)
        VALUES (?, ?, ?, ?, ?, 'approved', ?, CURRENT_TIMESTAMP)
      `, [teacherId, targetCourseId, classId, semester, academicYear, req.session.user.id]);
      submissionId = insertSub.insertId;
    }

    // Recalculate total weighted score for each student
    for (const studentId of Object.keys(studentResults)) {
      const [categoryScores] = await conn.execute(`
        SELECT 
          SUM((sr.score / ac.max_mark) * ac.weight_percentage) as calculated_score
        FROM student_results sr
        JOIN assessment_categories ac ON sr.category_id = ac.id
        WHERE sr.student_id = ? AND ac.structure_id = ?
      `, [studentId, structureId]);

      const totalScore = categoryScores[0] && categoryScores[0].calculated_score !== null 
        ? parseFloat(categoryScores[0].calculated_score) 
        : 0.00;

      await conn.execute(`
        INSERT INTO student_course_results (
          submission_id, student_id, teacher_id, course_id, class_id, semester_id, academic_year, assessment_structure_id, total_score, status, submitted_by, submitted_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON DUPLICATE KEY UPDATE
          submission_id = ?,
          teacher_id = ?,
          class_id = ?,
          assessment_structure_id = ?,
          total_score = ?,
          status = ?
      `, [
        submissionId, studentId, teacherId, targetCourseId, classId, semester, academicYear, structureId, totalScore, status, req.session.user.id,
        submissionId, teacherId, classId, structureId, totalScore, status
      ]);

      // Synchronize academic_history/transcript
      await conn.execute(`
        UPDATE academic_history ah
        JOIN (
          SELECT student_id, academic_year, AVG(total_score) as new_avg
          FROM approved_results
          GROUP BY student_id, academic_year
        ) as stats ON ah.student_id = stats.student_id AND ah.academic_year = stats.academic_year
        SET ah.average_score = stats.new_avg
        WHERE ah.student_id = ?
      `, [studentId]);
    }

    // Log teacher activity
    await logActivity(teacherId, 'Grades Edited', `Edited and synced scores for class ${classId}`, classId, courseId);

    await conn.commit();
    // Emit real-time update to connected clients
    const io = req.app.get('io');
    if (io) {
      io.emit('gradeUpdated', { classId, courseId, teacherId });
    }
    res.json({ message: 'Grades successfully updated and synced' });
  } catch (error) {
    await conn.rollback();
    console.error('Edit grades error:', error);
    res.status(500).json({ message: 'Server error: ' + error.message });
  } finally {
    conn.release();
  }
});

// GET /teacher/grades/history/:classId/:courseId - Fetch change history logs for a course
router.get('/grades/history/:classId/:courseId', async (req, res) => {
  try {
    const teacherId = req.teacherId;
    const { classId, courseId } = req.params;

    // Verify assignment
    const [assignmentCheck] = await pool.execute(`
      SELECT id FROM teacher_course_assignments WHERE teacher_id = ? AND class_id = ? AND course_id = ? AND status = 'active'
      UNION
      SELECT id FROM class_teachers WHERE teacher_id = ? AND class_id = ? AND ? = 0
    `, [teacherId, classId, courseId, teacherId, classId, courseId]);

    if (assignmentCheck.length === 0) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const [logs] = await pool.execute(`
      SELECT gcl.*, 
             CONCAT(su.first_name, ' ', su.last_name) as student_name,
             s.student_id as reference_id,
             ac.name as category_name,
             CONCAT(tu.first_name, ' ', tu.last_name) as teacher_name
      FROM grade_change_logs gcl
      JOIN students s ON gcl.student_id = s.id
      JOIN users su ON s.user_id = su.id
      JOIN assessment_categories ac ON gcl.category_id = ac.id
      JOIN teachers t ON gcl.edited_by = t.id
      JOIN users tu ON t.user_id = tu.id
      WHERE ac.structure_id = (
        SELECT id FROM grading_structures 
        WHERE (course_id = ? OR (course_id IS NULL AND ? = 0)) AND class_id = ? AND semester = 'Semester 1' LIMIT 1
      )
      ORDER BY gcl.change_time DESC
    `, [courseId, courseId, classId]);

    res.json(logs);
  } catch (error) {
    console.error('Get grade logs error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /teacher/grades - Show grades dashboard
router.get('/grades', async (req, res) => {
  try {
    const teacherId = req.teacherId;
    const [assignments] = await pool.execute(`
      SELECT tca.class_id, tca.course_id, c.name as class_name, c.grade, c.section, co.course_name,
             gs.status as structure_status, gs.id as structure_id, gs.semester as structure_semester,
             COALESCE(
               (SELECT status FROM grade_submissions WHERE class_id = tca.class_id AND course_id = tca.course_id AND teacher_id = tca.teacher_id AND semester_id = gs.semester LIMIT 1),
               (SELECT sr.status FROM student_results sr JOIN assessment_categories ac ON sr.category_id = ac.id WHERE ac.structure_id = gs.id LIMIT 1)
             ) as grades_status
      FROM teacher_course_assignments tca
      JOIN classes c ON tca.class_id = c.id
      JOIN courses co ON tca.course_id = co.id
      LEFT JOIN grading_structures gs ON (tca.course_id = gs.course_id AND tca.class_id = gs.class_id AND gs.teacher_id = tca.teacher_id)
      WHERE tca.teacher_id = ? AND tca.status = 'active'
      
      UNION
      
      SELECT ct.class_id, 0 as course_id, c.name as class_name, c.grade, c.section, 'General Grade' as course_name,
             gs.status as structure_status, gs.id as structure_id, gs.semester as structure_semester,
             COALESCE(
               (SELECT status FROM grade_submissions WHERE class_id = ct.class_id AND course_id = 0 AND teacher_id = ct.teacher_id AND semester_id = gs.semester LIMIT 1),
               (SELECT sr.status FROM student_results sr JOIN assessment_categories ac ON sr.category_id = ac.id WHERE ac.structure_id = gs.id LIMIT 1)
             ) as grades_status
      FROM class_teachers ct
      JOIN classes c ON ct.class_id = c.id
      LEFT JOIN grading_structures gs ON (gs.course_id IS NULL AND ct.class_id = gs.class_id AND gs.teacher_id = ct.teacher_id)
      WHERE ct.teacher_id = ?
    `, [teacherId, teacherId]);

    res.render('teacher/grades-index', {
      title: 'Grade Management',
      user: req.session.user,
      assignments
    });
  } catch (error) {
    res.status(500).render('500-modern', { title: 'Server Error', message: error.message });
  }
});

// Get grades data for a class/course
router.get('/grades/:classId/:courseId', async (req, res) => {
  try {
    const teacherId = req.teacherId;
    const { classId, courseId } = req.params;

    // Verify assignment
    const [assignmentCheck] = await pool.execute(`
      SELECT id FROM teacher_course_assignments WHERE teacher_id = ? AND class_id = ? AND course_id = ? AND status = 'active'
      UNION
      SELECT id FROM class_teachers WHERE teacher_id = ? AND class_id = ? AND ? = 0
    `, [teacherId, classId, courseId, teacherId, classId, courseId]);

    if (assignmentCheck.length === 0) {
      return res.status(403).render('500-modern', { title: 'Access Denied', message: 'You are not assigned to this course/class.' });
    }

    // Fetch grading structure
    const [structures] = await pool.execute(
      'SELECT id, status FROM grading_structures WHERE (course_id = ? OR (course_id IS NULL AND ? = 0)) AND class_id = ? AND teacher_id = ? AND semester = "Semester 1"',
      [courseId, courseId, classId, teacherId]
    );

    let structure = structures.length > 0 ? structures[0] : null;
    let categories = [];
    let students = [];
    let studentResults = {};
    let gradesStatus = null;

    if (structure && structure.status === 'approved') {
      // Get categories
      const [cats] = await pool.execute('SELECT * FROM assessment_categories WHERE structure_id = ? ORDER BY order_index ASC', [structure.id]);
      categories = cats;

      // Get students
      const [stus] = await pool.execute(`
        SELECT s.id as student_id, u.first_name, u.last_name, s.student_id as reference_id
        FROM users u
        JOIN students s ON u.id = s.user_id
        JOIN classes c ON s.grade_level = c.grade AND s.section = c.section
        WHERE c.id = ? AND u.role = 'student' AND s.withdrawal_status = 'active'
        ORDER BY u.first_name, u.last_name
      `, [classId]);
      students = stus;

      // Get existing results
      const [results] = await pool.execute(`
        SELECT sr.student_id, sr.category_id, sr.score, sr.status 
        FROM student_results sr
        JOIN assessment_categories ac ON sr.category_id = ac.id
        WHERE ac.structure_id = ? AND sr.teacher_id = ?
      `, [structure.id, teacherId]);

      // Calculate overall grades status
      const targetCourseId = courseId == 0 ? 0 : courseId;
      const [subs] = await pool.execute(`
        SELECT status FROM grade_submissions 
        WHERE class_id = ? AND course_id = ? AND teacher_id = ? AND semester_id = ?
      `, [classId, targetCourseId, teacherId, structure.semester || 'Semester 1']);
      
      if (subs.length > 0) {
        gradesStatus = subs[0].status;
      } else if (results.length > 0) {
        if (results.some(r => r.status === 'pending')) {
          gradesStatus = 'pending';
        } else if (results.some(r => r.status === 'rejected')) {
          gradesStatus = 'rejected';
        } else if (results.some(r => r.status === 'approved')) {
          gradesStatus = 'approved';
        }
      }

      // Organize results by student_id and category_id
      results.forEach(r => {
        if (!studentResults[r.student_id]) studentResults[r.student_id] = {};
        studentResults[r.student_id][r.category_id] = r;
      });
    }

    let courseName = 'General Grade';
    if (courseId != 0) {
      const [courseInfo] = await pool.execute('SELECT course_name FROM courses WHERE id = ?', [courseId]);
      if (courseInfo.length > 0) courseName = courseInfo[0].course_name;
    }

    const [classInfo] = await pool.execute('SELECT grade, section FROM classes WHERE id = ?', [classId]);
    const classGrade = classInfo[0] ? classInfo[0].grade : '';
    const classSection = classInfo[0] ? classInfo[0].section : '';

    res.render('teacher/grades', {
      title: 'Class Grades',
      user: req.session.user,
      classId,
      courseId,
      courseName,
      classGrade,
      classSection,
      structure,
      categories,
      students,
      studentResults,
      gradesStatus
    });

  } catch (error) {
    console.error('Get grades error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ==========================================
// FLEXIBLE GRADING STRUCTURE ENDPOINTS
// ==========================================

// GET /teacher/grading-structures/:classId/:courseId - Show structure builder
router.get('/grading-structures/:classId/:courseId', async (req, res) => {
  try {
    const teacherId = req.teacherId;
    const { classId, courseId } = req.params;

    // Verify assignment
    const [assignmentCheck] = await pool.execute(`
      SELECT id FROM teacher_course_assignments WHERE teacher_id = ? AND class_id = ? AND course_id = ? AND status = 'active'
      UNION
      SELECT id FROM class_teachers WHERE teacher_id = ? AND class_id = ? AND ? = 0
    `, [teacherId, classId, courseId, teacherId, classId, courseId]);

    if (assignmentCheck.length === 0) {
      return res.status(403).render('500-modern', { title: 'Access Denied', message: 'You are not assigned to this class/course.' });
    }

    let courseName = 'General Grade';
    if (courseId != 0) {
      const [courseInfo] = await pool.execute('SELECT course_name FROM courses WHERE id = ?', [courseId]);
      if (courseInfo.length > 0) courseName = courseInfo[0].course_name;
    }
    
    // Get existing structure
    const [structures] = await pool.execute(
      'SELECT * FROM grading_structures WHERE teacher_id = ? AND course_id = ? AND class_id = ?',
      [teacherId, courseId, classId]
    );

    let structure = structures.length > 0 ? structures[0] : null;
    let categories = [];

    if (structure) {
      const [cats] = await pool.execute(
        'SELECT * FROM assessment_categories WHERE structure_id = ? ORDER BY order_index ASC',
        [structure.id]
      );
      categories = cats;
    }

    const [classInfo] = await pool.execute('SELECT grade, section FROM classes WHERE id = ?', [classId]);
    const classGrade = classInfo[0] ? classInfo[0].grade : '';
    const classSection = classInfo[0] ? classInfo[0].section : '';

    res.render('teacher/grading-structure', {
      title: 'Grading Structure',
      user: req.session.user,
      classId,
      courseId,
      courseName,
      classGrade,
      classSection,
      semester: req.query.semester || 'Semester 1',
      semesterOptions: ['Semester 1', 'Semester 2'],
      structure,
      categories
    });
  } catch (error) {
    console.error('Get grading structure error:', error);
    res.status(500).render('500-modern', { title: 'Server Error', message: error.message });
  }
});

// POST /teacher/grading-structures/:classId/:courseId - Save structure
router.post('/grading-structures/:classId/:courseId', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const teacherId = req.teacherId;
    const { classId, courseId } = req.params;
    const { semester, categories, status: reqStatus } = req.body;
    const saveStatus = reqStatus === 'pending' ? 'pending' : 'draft';

    // Verify assignment
    const [assignmentCheck] = await conn.execute(`
      SELECT id FROM teacher_course_assignments WHERE teacher_id = ? AND class_id = ? AND course_id = ? AND status = 'active'
      UNION
      SELECT id FROM class_teachers WHERE teacher_id = ? AND class_id = ? AND ? = 0
    `, [teacherId, classId, courseId, teacherId, classId, courseId]);

    if (assignmentCheck.length === 0) {
      await conn.rollback();
      return res.status(403).json({ message: 'Access denied' });
    }

    // Validate categories sum to 100
    let parsedCategories = typeof categories === 'string' ? JSON.parse(categories) : categories;
    let totalWeight = 0;
    parsedCategories.forEach(cat => totalWeight += parseFloat(cat.weight_percentage));
    
    if (Math.abs(totalWeight - 100) > 0.01) {
      await conn.rollback();
      return res.status(400).json({ message: 'Total weight must equal exactly 100%' });
    }

    // Check if structure exists and is editable
    const [existing] = await conn.execute(
      'SELECT id, status FROM grading_structures WHERE (course_id = ? OR (course_id IS NULL AND ? = 0)) AND class_id = ? AND teacher_id = ? AND semester = ?',
      [courseId, courseId, classId, teacherId, semester || 'Semester 1']
    );

    let structureId;
    if (existing.length > 0) {
      const currentStatus = existing[0].status;
      if (currentStatus === 'approved' || currentStatus === 'pending') {
        await conn.rollback();
        return res.status(403).json({ message: 'Approved or Pending structures cannot be modified.' });
      }

      structureId = existing[0].id;
      // Update existing structure
      await conn.execute(
        'UPDATE grading_structures SET teacher_id = ?, total_weight = ?, status = ? WHERE id = ?',
        [teacherId, totalWeight, saveStatus, structureId]
      );
      // Remove old categories
      await conn.execute('DELETE FROM assessment_categories WHERE structure_id = ?', [structureId]);
    } else {
      // Create new structure
      const dbCourseId = courseId == 0 ? null : courseId;
      const [result] = await conn.execute(
        'INSERT INTO grading_structures (teacher_id, course_id, class_id, semester, status, total_weight) VALUES (?, ?, ?, ?, ?, ?)',
        [teacherId, dbCourseId, classId, semester || 'Semester 1', saveStatus, totalWeight]
      );
      structureId = result.insertId;
    }

    // Insert new categories
    for (let i = 0; i < parsedCategories.length; i++) {
      const cat = parsedCategories[i];
      await conn.execute(
        'INSERT INTO assessment_categories (structure_id, name, weight_percentage, max_mark, passing_mark, description, order_index) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [structureId, cat.name || 'Category', parseFloat(cat.weight_percentage) || 0, parseFloat(cat.max_mark) || 100, cat.passing_mark ? parseFloat(cat.passing_mark) : null, cat.description || '', i]
      );
    }
    
    // Log activity
    const activityDesc = saveStatus === 'pending' ? 'Submitted grading structure for approval' : 'Saved grading structure draft';
    await logActivity(teacherId, 'Grading Structure', activityDesc, classId, courseId);

    await conn.commit();
    res.json({ message: 'Grading structure saved and submitted for admin approval.' });
  } catch (error) {
    await conn.rollback();
    console.error('Save grading structure error:', error);
    res.status(500).json({ message: 'Server error' });
  } finally {
    conn.release();
  }
});

// 4. Upload assignments or materials
router.post('/assignments/create', async (req, res) => {
  try {
    const {
      classId, courseId, assignmentType, title, dueDate, maxPoints, timeLimit,
      attemptsAllowed, description, learningObjectives, additionalLinks, visibleToStudents
    } = req.body;
    const teacherId = req.teacherId;

    // Verify teacher has access to this class
    const [classCheck] = await pool.execute(`
      SELECT id FROM classes WHERE id = ? AND id IN (
        SELECT class_id FROM class_teachers WHERE teacher_id = ?
        UNION
        SELECT class_id FROM teacher_course_assignments WHERE teacher_id = ? AND status = 'active'
      )
    `, [classId, teacherId, teacherId]);

    if (classCheck.length === 0) {
      return res.status(403).json({ message: 'Access denied' });
    }

    // Get academic year
    const [classDetails] = await pool.execute('SELECT academic_year FROM classes WHERE id = ?', [classId]);
    const academicYear = classDetails[0] ? classDetails[0].academic_year : '';

    // Get semester
    const [structureDetails] = await pool.execute(
      'SELECT semester FROM grading_structures WHERE class_id = ? AND teacher_id = ? LIMIT 1',
      [classId, teacherId]
    );
    const semester = structureDetails[0] ? structureDetails[0].semester : 'Semester 1';

    // Create assignment
    await pool.execute(`
      INSERT INTO assignments (
        class_id, course_id, assignment_type, title, description, learning_objectives, additional_links, due_date, max_points, time_limit, 
        attempts_allowed, visible_to_students, created_by, teacher_id, academic_year, semester, semester_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      classId, courseId || null, assignmentType, title, description, learningObjectives, additionalLinks, dueDate || null, maxPoints || 100.00, timeLimit || null,
      attemptsAllowed || 'unlimited', visibleToStudents === 'on' ? 1 : 0, teacherId, teacherId, academicYear, semester, semester
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
      WHERE a.teacher_id = ?
      ORDER BY a.created_at DESC
    `, [teacherId]);

    const [classes] = await pool.execute(`
      SELECT id, name, grade, section FROM classes 
      WHERE id IN (
        SELECT class_id FROM class_teachers WHERE teacher_id = ?
        UNION
        SELECT class_id FROM teacher_course_assignments WHERE teacher_id = ? AND status = 'active'
      )
    `, [teacherId, teacherId]);

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
      SELECT id, name, grade, section FROM classes 
      WHERE id IN (
        SELECT class_id FROM class_teachers WHERE teacher_id = ?
        UNION
        SELECT class_id FROM teacher_course_assignments WHERE teacher_id = ? AND status = 'active'
      )
    `, [teacherId, teacherId]);

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
    const { classId, courseId, title, description, fileUrl, materialType } = req.body;
    const teacherId = req.teacherId;

    // Verify class belongs to teacher
    const [classCheck] = await pool.execute(`
      SELECT id FROM classes WHERE id = ? AND id IN (
        SELECT class_id FROM class_teachers WHERE teacher_id = ?
        UNION
        SELECT class_id FROM teacher_course_assignments WHERE teacher_id = ? AND status = 'active'
      )
    `, [classId, teacherId, teacherId]);

    if (classCheck.length === 0) {
      return res.status(403).json({ message: 'Access denied' });
    }

    // Get academic year and semester for materials
    const [classDetails] = await pool.execute('SELECT academic_year FROM classes WHERE id = ?', [classId]);
    const academicYear = classDetails[0] ? classDetails[0].academic_year : '';

    // Get semester
    const [structureDetails] = await pool.execute(
      'SELECT semester FROM grading_structures WHERE class_id = ? AND teacher_id = ? LIMIT 1',
      [classId, teacherId]
    );
    const semester = structureDetails[0] ? structureDetails[0].semester : 'Semester 1';

    await pool.execute(`
      INSERT INTO materials (class_id, teacher_id, course_id, title, description, file_url, material_type, academic_year, semester, semester_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [classId, teacherId, courseId || null, title, description, fileUrl, materialType || 'reading', academicYear, semester, semester]);

    // Log activity
    await logActivity(teacherId, 'Material Uploaded', `Uploaded ${materialType || 'resource'}: ${title}`, classId, courseId || null);

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
      WHERE id IN (
        SELECT class_id FROM class_teachers WHERE teacher_id = ?
        UNION
        SELECT class_id FROM teacher_course_assignments WHERE teacher_id = ? AND status = 'active'
      )
      ORDER BY grade, section
    `, [teacherId, teacherId]);

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
    const [classInfo] = await pool.execute(`
      SELECT * FROM classes WHERE id = ? AND id IN (
        SELECT class_id FROM class_teachers WHERE teacher_id = ?
        UNION
        SELECT class_id FROM teacher_course_assignments WHERE teacher_id = ? AND status = 'active'
      )
    `, [classId, teacherId, teacherId]);

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
      SELECT DISTINCT cs.*, c.course_name, c.course_code, cl.name as class_name
      FROM class_schedule cs
      JOIN courses c ON cs.course_id = c.id
      JOIN classes cl ON cs.class_id = cl.id
      LEFT JOIN teacher_course_assignments tca ON (cs.class_id = tca.class_id AND cs.course_id = tca.course_id)
      LEFT JOIN class_teachers ct ON cs.class_id = ct.class_id
      WHERE (tca.teacher_id = ? AND tca.status = 'active')
         OR (ct.teacher_id = ?)
      ORDER BY FIELD(cs.day_of_week, 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'), cs.start_time
    `, [teacherId, teacherId]);

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
      WHERE c.id IN (
        SELECT class_id FROM class_teachers WHERE teacher_id = ?
        UNION
        SELECT class_id FROM teacher_course_assignments WHERE teacher_id = ? AND status = 'active'
      )
      AND s.withdrawal_status = 'active'
      ORDER BY u.last_name, u.first_name
    `, [teacherId, teacherId]);

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