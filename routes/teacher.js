const express = require('express');
const { pool } = require('../config/db');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const {
  verifyTeacherAssignment,
  isTeacherAssigned,
} = require('../middleware/verifyTeacherAssignment');
const upload = require('../middleware/upload');
const {
  getAcademicContext,
  formatSemesterLabel,
  DEFAULT_ACADEMIC_YEAR,
} = require('../config/systemSettings');

function getCourseId(courseId) {
  if (
    typeof courseId !== 'number' &&
    (typeof courseId !== 'string' || !/^\d+$/.test(courseId))
  ) {
    return null;
  }

  const parsed = Number(courseId);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function isValidAttendanceDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return false;
  }
  const parsedDate = new Date(`${date}T00:00:00.000Z`);
  return !Number.isNaN(parsedDate.getTime()) && parsedDate.toISOString().slice(0, 10) === date;
}

async function getAuthorizedAttendanceClass(executor, teacherId, classId) {
  const [classes] = await executor.execute(
    `SELECT id, name, grade, section, academic_year
     FROM classes
     WHERE id = ? AND attendance_teacher_id = ?
     LIMIT 1`,
    [classId, teacherId]
  );
  return classes[0] || null;
}

async function getOwnedGradingStructure(executor, teacherId, classId, courseId, structureId, semester) {
  const params = [teacherId, classId, courseId, courseId];
  let structureFilter = '';

  if (structureId !== undefined) {
    structureFilter = ' AND id = ?';
    params.push(structureId);
  }
  if (semester !== undefined) {
    structureFilter += ' AND semester = ?';
    params.push(semester);
  }

  const [structures] = await executor.execute(
    `SELECT id, teacher_id, course_id, class_id, semester, status
     FROM grading_structures
     WHERE teacher_id = ? AND class_id = ?
       AND ((? = 0 AND course_id IS NULL) OR course_id = ?)
       ${structureFilter}
     LIMIT 1`,
    params
  );
  return structures[0] || null;
}

async function validateGradeEntries(executor, structureId, classId, studentResults) {
  if (!studentResults || typeof studentResults !== 'object' || Array.isArray(studentResults)) {
    return { error: 'Student grades must be provided as an object.' };
  }

  const rawEntries = Object.entries(studentResults);
  if (rawEntries.length === 0) {
    return { error: 'At least one student grade is required.' };
  }

  const entries = [];
  const studentIds = new Set();
  const categoryIds = new Set();
  for (const [rawStudentId, categories] of rawEntries) {
    const studentId = Number(rawStudentId);
    if (
      !Number.isSafeInteger(studentId) ||
      studentId <= 0 ||
      !categories ||
      typeof categories !== 'object' ||
      Array.isArray(categories)
    ) {
      return { error: 'Invalid student or category data.' };
    }

    studentIds.add(studentId);
    for (const [rawCategoryId, value] of Object.entries(categories)) {
      const categoryId = Number(rawCategoryId);
      if (!Number.isSafeInteger(categoryId) || categoryId <= 0) {
        return { error: 'Invalid assessment category.' };
      }

      const rawScore = value && typeof value === 'object' ? value.score : value;
      const score = Number(rawScore);
      if (rawScore === '' || rawScore === null || !Number.isFinite(score) || score < 0) {
        return { error: 'Grades must be valid non-negative numbers.' };
      }

      entries.push({
        studentId,
        categoryId,
        score,
        comment: value && typeof value === 'object' && typeof value.comment === 'string'
          ? value.comment.slice(0, 200)
          : null,
      });
      categoryIds.add(categoryId);
    }
  }

  if (entries.length === 0) {
    return { error: 'At least one student grade is required.' };
  }

  const categoryPlaceholders = Array.from(categoryIds, () => '?').join(', ');
  const [categories] = await executor.execute(
    `SELECT id, max_mark FROM assessment_categories
     WHERE structure_id = ? AND id IN (${categoryPlaceholders})`,
    [structureId, ...categoryIds]
  );
  if (categories.length !== categoryIds.size) {
    return { error: 'One or more assessment categories do not belong to this grading structure.' };
  }

  const categoryMaxMarks = new Map(categories.map((category) => [Number(category.id), Number(category.max_mark)]));
  if (entries.some((entry) => entry.score > categoryMaxMarks.get(entry.categoryId))) {
    return { error: 'A grade cannot exceed the assessment maximum mark.' };
  }

  const studentPlaceholders = Array.from(studentIds, () => '?').join(', ');
  const [students] = await executor.execute(
    `SELECT s.id
     FROM students s
     JOIN classes c ON s.grade_level = c.grade AND s.section = c.section
     WHERE c.id = ? AND s.withdrawal_status = 'active' AND s.id IN (${studentPlaceholders})`,
    [classId, ...studentIds]
  );
  if (students.length !== studentIds.size) {
    return { error: 'One or more students are not active members of this class.' };
  }

  return { entries };
}

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
    const [attendanceAssignments] = await pool.execute(
      'SELECT id FROM classes WHERE attendance_teacher_id = ? LIMIT 1',
      [req.teacherId]
    );
    res.locals.canTakeAttendance = attendanceAssignments.length > 0;
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
      SELECT assigned.class_id, assigned.course_id, c.name as class_name,
             c.grade, c.section, co.course_name, co.course_code
      FROM (
        SELECT class_id, course_id
        FROM teacher_course_assignments
        WHERE teacher_id = ? AND status = 'active'
        UNION
        SELECT class_id, course_id
        FROM class_schedule
        WHERE teacher_id = ?
        UNION
        SELECT cs.class_id, cs.course_id
        FROM class_schedule cs
        JOIN courses course_owner ON course_owner.id = cs.course_id
        WHERE course_owner.teacher_id = ?
      ) assigned
      JOIN classes c ON assigned.class_id = c.id
      JOIN courses co ON assigned.course_id = co.id
      ORDER BY co.course_name, c.grade, c.section
    `, [teacherId, teacherId, teacherId]);

    // Get total students count across all assigned classes
    const [studentCount] = await pool.execute(`
      SELECT COUNT(DISTINCT s.id) as total_students
      FROM students s
      JOIN classes c ON s.grade_level = c.grade AND s.section = c.section
      WHERE c.id IN (
        SELECT class_id FROM teacher_course_assignments WHERE teacher_id = ? AND status = 'active'
        UNION
        SELECT class_id FROM class_schedule WHERE teacher_id = ?
        UNION
        SELECT cs.class_id FROM class_schedule cs
        JOIN courses course_owner ON course_owner.id = cs.course_id
        WHERE course_owner.teacher_id = ?
        UNION
        SELECT class_id FROM class_teachers WHERE teacher_id = ?
      )
    `, [teacherId, teacherId, teacherId, teacherId]);

    // Get assigned classes count
    const [classesCount] = await pool.execute(`
      SELECT COUNT(DISTINCT class_id) as count FROM (
        SELECT class_id FROM teacher_course_assignments WHERE teacher_id = ? AND status = 'active'
        UNION
        SELECT class_id FROM class_schedule WHERE teacher_id = ?
        UNION
        SELECT cs.class_id FROM class_schedule cs
        JOIN courses course_owner ON course_owner.id = cs.course_id
        WHERE course_owner.teacher_id = ?
        UNION
        SELECT class_id FROM class_teachers WHERE teacher_id = ?
      ) as combined_classes
    `, [teacherId, teacherId, teacherId, teacherId]);

    // Get assigned classes details - Updated to UNION both assignment types
    const [classes] = await pool.execute(`
      SELECT DISTINCT c.*, assigned.course_id as assigned_course_id,
             co.course_name, co.course_code,
             (SELECT COUNT(*) FROM students WHERE grade_level = c.grade AND section = c.section AND withdrawal_status = 'active') as student_count,
             'course' as assignment_type
      FROM classes c
      JOIN (
        SELECT class_id, course_id
        FROM teacher_course_assignments
        WHERE teacher_id = ? AND status = 'active'
        UNION
        SELECT class_id, course_id
        FROM class_schedule
        WHERE teacher_id = ?
        UNION
        SELECT cs.class_id, cs.course_id
        FROM class_schedule cs
        JOIN courses course_owner ON course_owner.id = cs.course_id
        WHERE course_owner.teacher_id = ?
      ) assigned ON c.id = assigned.class_id
      JOIN courses co ON assigned.course_id = co.id
      
      UNION
      
      SELECT DISTINCT c.*, 0 as assigned_course_id,
             CONCAT(c.name, ' — Homeroom') as course_name, 'HOMEROOM' as course_code,
             (SELECT COUNT(*) FROM students WHERE grade_level = c.grade AND section = c.section AND withdrawal_status = 'active') as student_count,
             'homeroom' as assignment_type
      FROM classes c
      JOIN class_teachers ct ON c.id = ct.class_id
      WHERE ct.teacher_id = ?
      
      ORDER BY grade, section
    `, [teacherId, teacherId, teacherId, teacherId]);

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


    // Performance Pulse: Academic Progress = % of teacher's course structures that have at least one student result saved/submitted
    const [coverageData] = await pool.execute(`
      SELECT
        COUNT(DISTINCT gs.id) as total_structures,
        COUNT(DISTINCT CASE WHEN sr.id IS NOT NULL THEN gs.id END) as covered_structures
      FROM grading_structures gs
      LEFT JOIN student_results sr ON sr.teacher_id = gs.teacher_id
        AND sr.class_id = gs.class_id
        AND (sr.course_id = gs.course_id OR (sr.course_id IS NULL AND gs.course_id IS NULL))
      WHERE gs.teacher_id = ?
    `, [teacherId]);

    const totalStructures = coverageData[0].total_structures || 0;
    const coveredStructures = coverageData[0].covered_structures || 0;
    const academicProgress = totalStructures > 0
      ? Math.round((coveredStructures / totalStructures) * 100) + '%'
      : 'N/A';

    // Performance Pulse: Passing Grade Avg = % of approved student course results ≥ 50 for this teacher
    const [passData] = await pool.execute(`
      SELECT
        COUNT(*) as total_results,
        SUM(CASE WHEN scr.total_score >= 50 THEN 1 ELSE 0 END) as passed_results
      FROM student_course_results scr
      WHERE scr.teacher_id = ? AND scr.status = 'approved'
    `, [teacherId]);

    const totalResults = passData[0].total_results || 0;
    const passedResults = passData[0].passed_results || 0;
    const passingGradeAvg = totalResults > 0
      ? Math.round((passedResults / totalResults) * 100) + '%'
      : 'N/A';

    const academicContext = await getAcademicContext();

    res.render('teacher/dashboard', {
      title: 'Teacher Dashboard',
      user: req.session.user,
      stats: {
        classes: classesCount[0].count,
        students: (studentCount[0] && studentCount[0].total_students) || 0,
        pendingGrades: 0, // Placeholder or actual pending grades count
        attendanceRate: Math.round((attendanceRate[0] && attendanceRate[0].rate) || 0),
        academicProgress,
        passingGradeAvg
      },
      classes,
      assignedCourses,
      activities,
      todaySchedule,
      academicContext,
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
      SELECT c.*, c.attendance_teacher_id = ? as can_take_attendance,
             (SELECT COUNT(*) FROM students s WHERE s.grade_level = c.grade AND s.section = c.section AND s.withdrawal_status = 'active') as student_count
      FROM classes c
      WHERE c.id IN (
        SELECT class_id FROM class_teachers WHERE teacher_id = ?
        UNION
        SELECT class_id FROM teacher_course_assignments WHERE teacher_id = ? AND status = 'active'
      )
    `;
    let params = [teacherId, teacherId, teacherId];

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
             (SELECT COUNT(a.id) FROM attendance a WHERE a.student_id = s.id AND a.status IN ('present', 'late', 'excused') AND a.approval_status = 'approved') / 
             NULLIF((SELECT COUNT(*) FROM attendance a WHERE a.student_id = s.id AND a.approval_status = 'approved'), 0) * 100 as attendance_rate
      FROM users u
      JOIN students s ON u.id = s.user_id
      JOIN classes c ON s.grade_level = c.grade AND s.section = c.section
      WHERE c.id = ? AND u.role = 'student' AND s.withdrawal_status = 'active'
      ORDER BY u.last_name, u.first_name
    `, [teacherId, classId]);

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
    const [assignments] = await pool.execute(`
      SELECT c.id as class_id, c.name as class_name, c.grade, c.section,
             (SELECT COUNT(*) FROM students s
              WHERE s.grade_level = c.grade AND s.section = c.section
                AND s.withdrawal_status = 'active') as student_count
      FROM classes c
      WHERE c.attendance_teacher_id = ?
      ORDER BY c.grade, c.section
    `, [teacherId]);

    const academicContext = await getAcademicContext();
    if (assignments.length === 0) {
      return res.status(403).render('500-modern', {
        title: 'Access Denied',
        message: 'An administrator must assign you to a section before you can take attendance.'
      });
    }

    res.render('teacher/attendance-index', {
      title: 'Attendance Management',
      user: req.session.user,
      assignments,
      academicContext,
    });
  } catch (error) {
    res.status(500).render('500-modern', { title: 'Server Error', message: error.message });
  }
});

// Get class-wide attendance data
router.get('/attendance/:classId/:date', async (req, res) => {
  try {
    const teacherId = req.teacherId;
    const { classId, date } = req.params;
    const parsedClassId = getCourseId(classId);
    if (parsedClassId === null || parsedClassId === 0 || !isValidAttendanceDate(date)) {
      return res.status(400).render('500-modern', {
        title: 'Invalid Attendance Request',
        message: 'A valid section and attendance date are required.'
      });
    }

    const classInfo = await getAuthorizedAttendanceClass(
      pool,
      teacherId,
      parsedClassId
    );
    if (!classInfo) {
      const message = 'Access denied: you are not assigned to take attendance for this section.';
      if (req.xhr || (req.headers.accept || '').includes('application/json')) {
        return res.status(403).json({ message });
      }
      return res.status(403).render('500-modern', {
        title: 'Access Denied',
        message
      });
    }

    const [attendance] = await pool.execute(`
      SELECT s.id as student_pk, u.first_name, u.last_name, s.student_id, a.status, a.notes, a.approval_status
      FROM users u
      JOIN students s ON u.id = s.user_id
      JOIN classes c ON s.grade_level = c.grade AND s.section = c.section
      LEFT JOIN attendance a ON s.id = a.student_id AND a.date = ? AND a.class_id = ?
      WHERE c.id = ? AND u.role = 'student' AND s.withdrawal_status = 'active'
      ORDER BY u.last_name, u.first_name
    `, [date, parsedClassId, parsedClassId]);

    res.render('teacher/attendance', {
      title: 'Class Attendance',
      user: req.session.user,
      classId: parsedClassId,
      className: classInfo.name,
      grade: classInfo.grade,
      section: classInfo.section,
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
    const { classId, date, attendance } = req.body || {};
    const teacherId = req.teacherId;
    const parsedClassId = getCourseId(classId);
    if (parsedClassId === null || parsedClassId === 0 || !isValidAttendanceDate(date)) {
      return res.status(400).json({ message: 'A valid section and attendance date are required.' });
    }

    const classDetails = await getAuthorizedAttendanceClass(
      pool,
      teacherId,
      parsedClassId
    );
    if (!classDetails) {
      return res.status(403).json({
        message: 'Access denied: you are not assigned to take attendance for this section.'
      });
    }

    if (!attendance || typeof attendance !== 'object' || Array.isArray(attendance)) {
      return res.status(400).json({ message: 'Attendance entries must be provided as an object.' });
    }
    const attendanceEntries = Object.entries(attendance);
    if (attendanceEntries.length === 0 || attendanceEntries.length > 500) {
      return res.status(400).json({ message: 'Select attendance for at least one student.' });
    }

    const allowedStatuses = new Set(['present', 'absent', 'late', 'excused']);
    const studentIds = [];
    for (const [rawStudentId, data] of attendanceEntries) {
      const studentId = getCourseId(rawStudentId);
      if (
        studentId === null ||
        studentId === 0 ||
        String(studentId) !== rawStudentId ||
        !data ||
        typeof data !== 'object' ||
        Array.isArray(data) ||
        !allowedStatuses.has(data.status) ||
        (data.notes !== undefined && typeof data.notes !== 'string')
      ) {
        return res.status(400).json({ message: 'One or more attendance entries are invalid.' });
      }
      studentIds.push(studentId);
    }
    const studentPlaceholders = studentIds.map(() => '?').join(',');
    const [enrolledStudents] = await pool.execute(
      `SELECT s.id
       FROM students s
       JOIN classes c ON s.grade_level = c.grade AND s.section = c.section
       WHERE c.id = ? AND s.withdrawal_status = 'active'
         AND s.id IN (${studentPlaceholders})`,
      [parsedClassId, ...studentIds]
    );
    if (enrolledStudents.length !== studentIds.length) {
      return res.status(403).json({ message: 'Attendance can only be recorded for active students in this section.' });
    }

    const academicYear = classDetails.academic_year || '';
    const className = classDetails.name || '';
    const ctx = await getAcademicContext();
    const semester = ctx.semesterLabel;

    if (studentIds.length > 0) {
      // One class-wide attendance record per student and date.
      let insertQuery = `INSERT INTO attendance (student_id, class_id, course_id, date, academic_year, semester, status, notes, attendance_type, created_by, approval_status, teacher_id, semester_id) VALUES `;
      let insertValues = [];
      let insertPlaceholders = [];
      for (const studentId of studentIds) {
        const data = attendance[studentId];
        insertPlaceholders.push(`(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`);
        insertValues.push(
          studentId, parsedClassId, null, date, academicYear, semester, data.status, data.notes || '', 'daily', teacherId, teacherId, semester
        );
      }
      insertQuery += insertPlaceholders.join(', ');
      insertQuery += ` ON DUPLICATE KEY UPDATE course_id = NULL, status = VALUES(status), notes = VALUES(notes), attendance_type = VALUES(attendance_type), approval_status = 'pending', academic_year = VALUES(academic_year), semester = VALUES(semester), teacher_id = VALUES(teacher_id), semester_id = VALUES(semester_id)`;

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
          classId: parsedClassId,
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
    await logActivity(teacherId, 'Attendance Submitted', `Recorded class attendance for ${date}`, parsedClassId);

    res.json({ message: 'Class attendance saved.' });
  } catch (error) {
    console.error('Save attendance error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});


// 3. Enter and update student grades dynamically
router.post('/grades/save', verifyTeacherAssignment, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const classId = req.classId;
    const courseId = req.courseId;
    const structureId = Number(req.body.structureId);
    const { gradeDate, studentResults } = req.body;
    const teacherId = req.teacherId;

    if (!Number.isSafeInteger(structureId) || structureId <= 0) {
      await conn.rollback();
      return res.status(400).json({ message: 'A valid grading structure is required.' });
    }

    const structure = await getOwnedGradingStructure(
      conn,
      teacherId,
      classId,
      courseId,
      structureId
    );
    if (!structure || structure.status !== 'approved') {
      await conn.rollback();
      return res.status(403).json({ message: 'You cannot manage grades for this grading structure.' });
    }

    const validation = await validateGradeEntries(conn, structureId, classId, studentResults);
    if (validation.error) {
      await conn.rollback();
      return res.status(400).json({ message: validation.error });
    }

    const [classDetails] = await conn.execute(
      'SELECT academic_year FROM classes WHERE id = ?',
      [classId]
    );
    if (classDetails.length === 0) {
      await conn.rollback();
      return res.status(404).json({ message: 'Class not found.' });
    }

    const academicYear = classDetails[0].academic_year;
    const semester = structure.semester;
    const dbCourseId = courseId === 0 ? null : courseId;
    const targetCourseId = courseId;
    const studentIds = Array.from(new Set(validation.entries.map((entry) => entry.studentId)));
    const studentPlaceholders = studentIds.map(() => '?').join(', ');

    const [existingFinalResults] = await conn.execute(
      `SELECT status FROM student_course_results
       WHERE teacher_id = ? AND class_id = ?
         AND ((course_id = ?) OR (course_id IS NULL AND ? = 0))
         AND semester_id = ? AND academic_year = ? AND assessment_structure_id = ?
         AND student_id IN (${studentPlaceholders})
       FOR UPDATE`,
      [teacherId, classId, targetCourseId, targetCourseId, semester, academicYear, structureId, ...studentIds]
    );
    if (existingFinalResults.some((result) => ['pending', 'submitted', 'approved'].includes(result.status))) {
      await conn.rollback();
      return res.status(403).json({ message: 'Cannot edit grades that are submitted or finalized.' });
    }

    for (const entry of validation.entries) {
      const [existing] = await conn.execute(
        `SELECT sr.teacher_id, sr.class_id, sr.course_id, sr.status
         FROM student_results sr
         WHERE sr.student_id = ? AND sr.category_id = ?
         FOR UPDATE`,
        [entry.studentId, entry.categoryId]
      );
      if (existing.length > 0) {
        const row = existing[0];
        const existingCourseId = row.course_id === null ? 0 : Number(row.course_id);
        if (
          (row.teacher_id !== null && Number(row.teacher_id) !== teacherId) ||
          Number(row.class_id) !== classId ||
          existingCourseId !== courseId ||
          ['pending', 'submitted', 'approved'].includes(row.status)
        ) {
          await conn.rollback();
          return res.status(403).json({ message: 'This grade is owned by another teacher or is finalized.' });
        }
      }
    }

    const studentResultValues = [];
    const studentResultPlaceholders = [];
    for (const entry of validation.entries) {
      studentResultValues.push(
        entry.studentId,
        entry.categoryId,
        entry.score,
        teacherId,
        gradeDate || null,
        'saved',
        teacherId,
        classId,
        dbCourseId,
        semester,
        semester,
        academicYear
      );
      studentResultPlaceholders.push('( ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? )');
    }

    if (studentResultValues.length > 0) {
      const batchQuery = `INSERT INTO student_results (student_id, category_id, score, graded_by, grade_date, status, teacher_id, class_id, course_id, semester, semester_id, academic_year) VALUES ${studentResultPlaceholders.join(', ')} ON DUPLICATE KEY UPDATE score = VALUES(score), graded_by = VALUES(graded_by), grade_date = VALUES(grade_date), status = IF(VALUES(status) = 'approved', 'approved', 'saved'), teacher_id = VALUES(teacher_id), class_id = VALUES(class_id), course_id = VALUES(course_id), semester = VALUES(semester), semester_id = VALUES(semester_id), academic_year = VALUES(academic_year)`;
      await conn.execute(batchQuery, studentResultValues);
    }

    // Create or update only this teacher's submission.
    await conn.execute(`
      INSERT INTO grade_submissions (teacher_id, course_id, class_id, semester_id, academic_year, status, submitted_by, submitted_at, comments)
      VALUES (?, ?, ?, ?, ?, 'saved', ?, CURRENT_TIMESTAMP, NULL)
      ON DUPLICATE KEY UPDATE
        status = 'saved',
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

    for (const studentId of studentIds) {
      const [categoryScores] = await conn.execute(`
        SELECT 
          SUM((sr.score / ac.max_mark) * ac.weight_percentage) as calculated_score
        FROM student_results sr
        JOIN assessment_categories ac ON sr.category_id = ac.id
        WHERE sr.student_id = ? AND sr.teacher_id = ? AND sr.class_id = ?
          AND ((sr.course_id = ?) OR (sr.course_id IS NULL AND ? = 0))
          AND ac.structure_id = ?
      `, [studentId, teacherId, classId, courseId, courseId, structureId]);

      const totalScore = categoryScores[0] && categoryScores[0].calculated_score !== null
        ? parseFloat(categoryScores[0].calculated_score)
        : 0.00;

      await conn.execute(`
        INSERT INTO student_course_results (
          submission_id, student_id, teacher_id, course_id, class_id, semester_id, academic_year, assessment_structure_id, total_score, status, submitted_by, submitted_at, approved_by, approved_at, rejected_by, rejected_at, comments
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'saved', ?, CURRENT_TIMESTAMP, NULL, NULL, NULL, NULL, NULL)
        ON DUPLICATE KEY UPDATE
          submission_id = ?,
          teacher_id = ?,
          class_id = ?,
          assessment_structure_id = ?,
          total_score = ?,
          status = 'saved',
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
    // Emit real-time update for saved grades
    const io = req.app.get('io');
    if (io) {
      const studentIds = Array.from(new Set(validation.entries.map((entry) => entry.studentId)));
      studentIds.forEach(sid => {
        const payload = {
          studentId: sid,
          classId,
          courseId: dbCourseId,
          teacherId: teacherId,
          status: 'saved'
        };
        // Emit to student room
        io.to(`student_${sid}`).emit('gradeUpdated', payload);
        // Emit to parent room (assuming parent user IDs are linked via socket rooms elsewhere)
        io.to(`parent_${sid}`).emit('gradeUpdated', payload);
        // Also broadcast to admin dashboard
        io.to('admin_dashboard').emit('gradeUpdated', payload);
      });
    }
    res.json({ message: 'Grades saved' });
  } catch (error) {
    await conn.rollback();
    console.error('Save grades error:', error);
    res.status(500).json({ message: 'Server error' });
  } finally {
    conn.release();
  }
});

// POST /teacher/grades/submit - Final submission for approval
router.post('/grades/submit', verifyTeacherAssignment, async (req, res) => {
  const classId = req.classId;
  const courseId = req.courseId;
  const teacherId = req.teacherId;
  try {
    const gradeCtx = await getAcademicContext();
    const structure = await getOwnedGradingStructure(
      pool,
      teacherId,
      classId,
      courseId,
      undefined,
      gradeCtx.semesterLabel
    );
    if (!structure) {
      return res.status(403).json({ message: 'No grading structure is assigned to this teacher for the requested course.' });
    }

    const [classDetails] = await pool.execute(
      'SELECT academic_year FROM classes WHERE id = ?',
      [classId]
    );
    if (classDetails.length === 0) {
      return res.status(404).json({ message: 'Class not found.' });
    }

    const targetCourseId = courseId;
    const academicYear = classDetails[0].academic_year;

    await pool.execute(`
      UPDATE grade_submissions 
      SET status = 'submitted' 
      WHERE teacher_id = ? AND class_id = ?
        AND ((course_id = ?) OR (course_id IS NULL AND ? = 0))
        AND semester_id = ? AND academic_year = ?
    `, [teacherId, classId, targetCourseId, targetCourseId, structure.semester, academicYear]);

    await pool.execute(`
      UPDATE student_course_results 
      SET status = 'submitted' 
      WHERE teacher_id = ? AND class_id = ?
        AND ((course_id = ?) OR (course_id IS NULL AND ? = 0))
        AND semester_id = ? AND academic_year = ?
    `, [teacherId, classId, targetCourseId, targetCourseId, structure.semester, academicYear]);

    res.json({ message: 'Grades submitted for approval' });
  } catch (error) {
    console.error('Submit grades error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /teacher/grades/edit - Edit grades before submission with auditable logging and instant sync
router.post('/grades/edit', verifyTeacherAssignment, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const classId = req.classId;
    const courseId = req.courseId;
    const structureId = Number(req.body.structureId);
    const { studentResults } = req.body;
    const teacherId = req.teacherId;

    if (!Number.isSafeInteger(structureId) || structureId <= 0) {
      await conn.rollback();
      return res.status(400).json({ message: 'A valid grading structure is required.' });
    }

    const structure = await getOwnedGradingStructure(
      conn,
      teacherId,
      classId,
      courseId,
      structureId
    );
    if (!structure || structure.status !== 'approved') {
      await conn.rollback();
      return res.status(403).json({ message: 'You cannot manage grades for this grading structure.' });
    }

    const validation = await validateGradeEntries(conn, structureId, classId, studentResults);
    if (validation.error) {
      await conn.rollback();
      return res.status(400).json({ message: validation.error });
    }

    const [classDetails] = await conn.execute(
      'SELECT academic_year FROM classes WHERE id = ?',
      [classId]
    );
    if (classDetails.length === 0) {
      await conn.rollback();
      return res.status(404).json({ message: 'Class not found.' });
    }

    const academicYear = classDetails[0].academic_year;
    const semester = structure.semester;
    const dbCourseId = courseId === 0 ? null : courseId;
    const targetCourseId = courseId;

    const [submissionStatus] = await conn.execute(
      `SELECT status FROM grade_submissions
       WHERE teacher_id = ? AND class_id = ?
         AND ((course_id = ?) OR (course_id IS NULL AND ? = 0))
         AND semester_id = ? AND academic_year = ? AND status != 'saved'`,
      [teacherId, classId, targetCourseId, targetCourseId, semester, academicYear]
    );
    if (submissionStatus.length > 0) {
      await conn.rollback();
      return res.status(403).json({ message: 'Cannot edit: Grades have been submitted for approval.' });
    }

    const studentIds = Array.from(new Set(validation.entries.map((entry) => entry.studentId)));
    const studentPlaceholders = studentIds.map(() => '?').join(', ');
    const [existingFinalResults] = await conn.execute(
      `SELECT status FROM student_course_results
       WHERE teacher_id = ? AND class_id = ?
         AND ((course_id = ?) OR (course_id IS NULL AND ? = 0))
         AND semester_id = ? AND academic_year = ? AND assessment_structure_id = ?
         AND student_id IN (${studentPlaceholders})
       FOR UPDATE`,
      [teacherId, classId, targetCourseId, targetCourseId, semester, academicYear, structureId, ...studentIds]
    );
    if (existingFinalResults.some((result) => ['pending', 'submitted', 'approved'].includes(result.status))) {
      await conn.rollback();
      return res.status(403).json({ message: 'Cannot edit grades that are submitted or finalized.' });
    }

    for (const entry of validation.entries) {
        const [oldScoreRecord] = await conn.execute(
          `SELECT score, teacher_id, class_id, course_id, status
           FROM student_results
           WHERE student_id = ? AND category_id = ?
           FOR UPDATE`,
          [entry.studentId, entry.categoryId]
        );

        if (oldScoreRecord.length > 0) {
          const row = oldScoreRecord[0];
          const existingCourseId = row.course_id === null ? 0 : Number(row.course_id);
          if (
            (row.teacher_id !== null && Number(row.teacher_id) !== teacherId) ||
            Number(row.class_id) !== classId ||
            existingCourseId !== courseId ||
            ['pending', 'submitted', 'approved'].includes(row.status)
          ) {
            await conn.rollback();
            return res.status(403).json({ message: 'This grade is owned by another teacher or is finalized.' });
          }
        }

        const old_value = oldScoreRecord[0] ? Number(oldScoreRecord[0].score) : null;
        const new_value = entry.score;

        // Only log and update if value has changed
        if (old_value !== new_value) {
          const status = 'saved';

          await conn.execute(`
            INSERT INTO student_results (student_id, category_id, score, graded_by, grade_date, status, teacher_id, class_id, course_id, semester, semester_id, academic_year)
            VALUES (?, ?, ?, ?, CURDATE(), ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE 
              score = ?, graded_by = ?, grade_date = CURDATE(), status = ?, teacher_id = ?, class_id = ?, course_id = ?, semester = ?, semester_id = ?, academic_year = ?
          `, [
            entry.studentId, entry.categoryId, new_value, teacherId, status, teacherId, classId, dbCourseId, semester, semester, academicYear,
            new_value, teacherId, status, teacherId, classId, dbCourseId, semester, semester, academicYear
          ]);

          // Insert into grade_change_logs
          await conn.execute(`
            INSERT INTO grade_change_logs (student_id, category_id, old_value, new_value, comment, edited_by, change_time)
            VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          `, [entry.studentId, entry.categoryId, old_value, new_value, entry.comment, teacherId]);
        }
    }

    // Keep the submission and final result scoped to this teacher and structure.
    const [existingSub] = await conn.execute(`
      SELECT id, status FROM grade_submissions 
      WHERE teacher_id = ? AND class_id = ?
        AND ((course_id = ?) OR (course_id IS NULL AND ? = 0))
        AND semester_id = ? AND academic_year = ?
    `, [teacherId, classId, targetCourseId, targetCourseId, semester, academicYear]);

    let submissionId = null;
    if (existingSub.length > 0) {
      submissionId = existingSub[0].id;
      await conn.execute(`
        UPDATE grade_submissions
        SET status = 'saved',
            submitted_by = ?, submitted_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [req.session.user.id, submissionId]);
    } else {
      const [insertSub] = await conn.execute(`
        INSERT INTO grade_submissions (teacher_id, course_id, class_id, semester_id, academic_year, status, submitted_by, submitted_at)
        VALUES (?, ?, ?, ?, ?, 'saved', ?, CURRENT_TIMESTAMP)
      `, [teacherId, targetCourseId, classId, semester, academicYear, req.session.user.id]);
      submissionId = insertSub.insertId;
    }

    // Recalculate total weighted score for each student
    for (const studentId of studentIds) {
      const [categoryScores] = await conn.execute(`
        SELECT 
          SUM((sr.score / ac.max_mark) * ac.weight_percentage) as calculated_score
        FROM student_results sr
        JOIN assessment_categories ac ON sr.category_id = ac.id
        WHERE sr.student_id = ? AND sr.teacher_id = ? AND sr.class_id = ?
          AND ((sr.course_id = ?) OR (sr.course_id IS NULL AND ? = 0))
          AND ac.structure_id = ?
      `, [studentId, teacherId, classId, courseId, courseId, structureId]);

      const totalScore = categoryScores[0] && categoryScores[0].calculated_score !== null
        ? parseFloat(categoryScores[0].calculated_score)
        : 0.00;

      await conn.execute(`
        INSERT INTO student_course_results (
          submission_id, student_id, teacher_id, course_id, class_id, semester_id, academic_year, assessment_structure_id, total_score, status, submitted_by, submitted_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'saved', ?, CURRENT_TIMESTAMP)
        ON DUPLICATE KEY UPDATE
          submission_id = ?,
          teacher_id = ?,
          class_id = ?,
          assessment_structure_id = ?,
          total_score = ?,
          status = 'saved'
      `, [
        submissionId, studentId, teacherId, targetCourseId, classId, semester, academicYear, structureId, totalScore, req.session.user.id,
        submissionId, teacherId, classId, structureId, totalScore
      ]);
    }

    // Log teacher activity
    await logActivity(teacherId, 'Grades Edited', `Edited and synced scores for class ${classId}`, classId, courseId);

    await conn.commit();
    // Emit real-time update to connected clients
    const io = req.app.get('io');
    if (io) {
      const studentIds = Array.from(new Set(validation.entries.map((entry) => entry.studentId)));
      const payload = { classId, courseId: dbCourseId, teacherId };
      studentIds.forEach((studentId) => {
        io.to(`student_${studentId}`).emit('gradeUpdated', payload);
        io.to(`parent_${studentId}`).emit('gradeUpdated', payload);
      });
      io.to('admin_dashboard').emit('gradeUpdated', payload);
    }
    res.json({ message: 'Grades updated', status: 'saved' });
  } catch (error) {
    await conn.rollback();
    console.error('Edit grades error:', error);
    res.status(500).json({ message: 'Server error: ' + error.message });
  } finally {
    conn.release();
  }
});

// DELETE /teacher/grades/:gradeId - Remove one grade owned by the current teacher.
router.delete('/grades/:gradeId', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const gradeId = Number(req.params.gradeId);
    if (!Number.isSafeInteger(gradeId) || gradeId <= 0) {
      return res.status(400).json({ message: 'A valid grade ID is required.' });
    }

    await conn.beginTransaction();
    const teacherId = req.teacherId;
    const [rows] = await conn.execute(
      `SELECT sr.id, sr.student_id, sr.teacher_id, sr.class_id, sr.course_id,
              sr.status, gs.course_id AS structure_course_id, gs.class_id AS structure_class_id,
              gs.semester, ac.structure_id
       FROM student_results sr
       JOIN assessment_categories ac ON ac.id = sr.category_id
       JOIN grading_structures gs ON gs.id = ac.structure_id
       WHERE sr.id = ? AND sr.teacher_id = ? AND gs.teacher_id = ?
       FOR UPDATE`,
      [gradeId, teacherId, teacherId]
    );
    if (rows.length === 0) {
      await conn.rollback();
      return res.status(404).json({ message: 'Grade not found or access denied.' });
    }

    const grade = rows[0];
    const classId = Number(grade.structure_class_id);
    const courseId = grade.structure_course_id === null ? 0 : Number(grade.structure_course_id);
    const gradeCourseId = grade.course_id === null ? 0 : Number(grade.course_id);
    if (
      Number(grade.class_id) !== classId ||
      gradeCourseId !== courseId ||
      !await isTeacherAssigned(conn, teacherId, classId, courseId)
    ) {
      await conn.rollback();
      return res.status(403).json({ message: 'You are not authorized to remove this grade.' });
    }

    if (['pending', 'submitted', 'approved'].includes(grade.status)) {
      await conn.rollback();
      return res.status(403).json({ message: 'Grades submitted for approval or finalized cannot be deleted.' });
    }

    const [classDetails] = await conn.execute(
      'SELECT academic_year FROM classes WHERE id = ?',
      [classId]
    );
    if (classDetails.length === 0) {
      await conn.rollback();
      return res.status(404).json({ message: 'Class not found.' });
    }

    const academicYear = classDetails[0].academic_year;
    const [submissionRows] = await conn.execute(
      `SELECT id, status FROM grade_submissions
       WHERE teacher_id = ? AND class_id = ?
         AND ((course_id = ?) OR (course_id IS NULL AND ? = 0))
         AND semester_id = ? AND academic_year = ?
       FOR UPDATE`,
      [teacherId, classId, courseId, courseId, grade.semester, academicYear]
    );
    if (submissionRows.some((submission) => ['pending', 'submitted', 'approved'].includes(submission.status))) {
      await conn.rollback();
      return res.status(403).json({ message: 'Grades submitted for approval or finalized cannot be deleted.' });
    }

    const [finalResults] = await conn.execute(
      `SELECT id, status FROM student_course_results
       WHERE student_id = ? AND teacher_id = ? AND class_id = ?
         AND ((course_id = ?) OR (course_id IS NULL AND ? = 0))
         AND semester_id = ? AND academic_year = ? AND assessment_structure_id = ?
       FOR UPDATE`,
      [grade.student_id, teacherId, classId, courseId, courseId, grade.semester, academicYear, grade.structure_id]
    );
    if (finalResults.some((result) => ['pending', 'submitted', 'approved'].includes(result.status))) {
      await conn.rollback();
      return res.status(403).json({ message: 'Grades submitted for approval or finalized cannot be deleted.' });
    }

    await conn.execute(
      'DELETE FROM student_results WHERE id = ? AND teacher_id = ? AND class_id = ?',
      [gradeId, teacherId, classId]
    );

    const [remainingScores] = await conn.execute(
      `SELECT COUNT(*) AS score_count,
              SUM((sr.score / ac.max_mark) * ac.weight_percentage) AS total_score
       FROM student_results sr
       JOIN assessment_categories ac ON ac.id = sr.category_id
       WHERE sr.student_id = ? AND sr.teacher_id = ? AND sr.class_id = ?
         AND ((sr.course_id = ?) OR (sr.course_id IS NULL AND ? = 0))
         AND ac.structure_id = ?`,
      [grade.student_id, teacherId, classId, courseId, courseId, grade.structure_id]
    );

    if (Number(remainingScores[0].score_count) === 0) {
      await conn.execute(
        `DELETE FROM student_course_results
         WHERE student_id = ? AND teacher_id = ? AND class_id = ?
           AND ((course_id = ?) OR (course_id IS NULL AND ? = 0))
           AND semester_id = ? AND academic_year = ? AND assessment_structure_id = ?`,
        [grade.student_id, teacherId, classId, courseId, courseId, grade.semester, academicYear, grade.structure_id]
      );
    } else {
      await conn.execute(
        `UPDATE student_course_results
         SET total_score = ?, status = 'saved'
         WHERE student_id = ? AND teacher_id = ? AND class_id = ?
           AND ((course_id = ?) OR (course_id IS NULL AND ? = 0))
           AND semester_id = ? AND academic_year = ? AND assessment_structure_id = ?`,
        [
          Number(remainingScores[0].total_score),
          grade.student_id,
          teacherId,
          classId,
          courseId,
          courseId,
          grade.semester,
          academicYear,
          grade.structure_id,
        ]
      );
    }

    for (const submission of submissionRows) {
      await conn.execute(
        `UPDATE grade_submissions
         SET status = 'saved', submitted_by = ?, submitted_at = CURRENT_TIMESTAMP
         WHERE id = ? AND teacher_id = ?`,
        [req.session.user.id, submission.id, teacherId]
      );
    }

    await conn.commit();
    await logActivity(teacherId, 'Grade Deleted', `Removed a grade for student ${grade.student_id}`, classId, courseId);
    return res.json({ message: 'Grade deleted.' });
  } catch (error) {
    await conn.rollback();
    console.error('Delete grade error:', error);
    return res.status(500).json({ message: 'Server error' });
  } finally {
    conn.release();
  }
});

// GET /teacher/grades/history/:classId/:courseId - Fetch change history logs for a course
router.get('/grades/history/:classId/:courseId', async (req, res) => {
  try {
    const teacherId = req.teacherId;
    const classId = Number(req.params.classId);
    const courseId = getCourseId(req.params.courseId);
    if (courseId === null || !await isTeacherAssigned(pool, teacherId, classId, courseId)) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const gradeCtx = await getAcademicContext();
    const structure = await getOwnedGradingStructure(
      pool,
      teacherId,
      classId,
      courseId,
      undefined,
      gradeCtx.semesterLabel
    );
    if (!structure) {
      return res.json([]);
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
      JOIN grading_structures gs ON gs.id = ac.structure_id
      JOIN teachers t ON gcl.edited_by = t.id
      JOIN users tu ON t.user_id = tu.id
      WHERE gs.id = ? AND gs.teacher_id = ? AND gcl.edited_by = ?
      ORDER BY gcl.change_time DESC
    `, [structure.id, teacherId, teacherId]);

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
               (SELECT sr.status FROM student_results sr JOIN assessment_categories ac ON sr.category_id = ac.id
                WHERE ac.structure_id = gs.id AND sr.teacher_id = tca.teacher_id AND sr.class_id = tca.class_id LIMIT 1)
             ) as grades_status
      FROM (
        SELECT teacher_id, class_id, course_id, status
        FROM teacher_course_assignments
        WHERE status = 'active'
        UNION
        SELECT teacher_id, class_id, course_id, 'active' AS status
        FROM class_schedule
        WHERE teacher_id IS NOT NULL
        UNION
        SELECT course_owner.teacher_id, cs.class_id, cs.course_id, 'active' AS status
        FROM class_schedule cs
        JOIN courses course_owner ON course_owner.id = cs.course_id
        WHERE course_owner.teacher_id IS NOT NULL
      ) tca
      JOIN classes c ON tca.class_id = c.id
      JOIN courses co ON tca.course_id = co.id
      LEFT JOIN grading_structures gs ON (tca.course_id = gs.course_id AND tca.class_id = gs.class_id AND gs.teacher_id = tca.teacher_id)
      WHERE tca.teacher_id = ?
      
      UNION
      
      SELECT ct.class_id, 0 as course_id, c.name as class_name, c.grade, c.section,
             COALESCE(gco.course_name, scheduled_course.course_name) as course_name,
             gs.status as structure_status, gs.id as structure_id, gs.semester as structure_semester,
             COALESCE(
               (SELECT status FROM grade_submissions WHERE class_id = ct.class_id AND course_id = 0 AND teacher_id = ct.teacher_id AND semester_id = gs.semester LIMIT 1),
               (SELECT sr.status FROM student_results sr JOIN assessment_categories ac ON sr.category_id = ac.id
                WHERE ac.structure_id = gs.id AND sr.teacher_id = ct.teacher_id AND sr.class_id = ct.class_id LIMIT 1)
             ) as grades_status
      FROM class_teachers ct
      JOIN classes c ON ct.class_id = c.id
      LEFT JOIN teacher_course_assignments gca
        ON gca.teacher_id = ct.teacher_id
        AND gca.class_id = ct.class_id
        AND gca.status = 'active'
      LEFT JOIN courses gco ON gco.id = gca.course_id
      LEFT JOIN (
        SELECT cs.teacher_id, cs.class_id, MIN(co.course_name) AS course_name
        FROM class_schedule cs
        JOIN courses co ON co.id = cs.course_id
        GROUP BY cs.teacher_id, cs.class_id
        HAVING COUNT(DISTINCT cs.course_id) = 1
      ) scheduled_course
        ON scheduled_course.teacher_id = ct.teacher_id
        AND scheduled_course.class_id = ct.class_id
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
    const classId = Number(req.params.classId);
    const courseId = getCourseId(req.params.courseId);
    if (courseId === null || !await isTeacherAssigned(pool, teacherId, classId, courseId)) {
      return res.status(403).render('500-modern', { title: 'Access Denied', message: 'You are not assigned to this course/class.' });
    }

    const gradeCtx = await getAcademicContext();
    const structure = await getOwnedGradingStructure(
      pool,
      teacherId,
      classId,
      courseId,
      undefined,
      gradeCtx.semesterLabel
    );

    let teacherName = '';
    if (structure && structure.teacher_id) {
      const [owner] = await pool.execute(
        `SELECT u.first_name, u.last_name FROM teachers t JOIN users u ON t.user_id = u.id WHERE t.id = ?`,
        [structure.teacher_id]
      );
      if (owner.length > 0) {
        teacherName = `${owner[0].first_name || ''} ${owner[0].last_name || ''}`.trim();
      }
    }
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
        SELECT sr.id, sr.student_id, sr.category_id, sr.score, sr.status
        FROM student_results sr
        JOIN assessment_categories ac ON sr.category_id = ac.id
        WHERE ac.structure_id = ? AND sr.teacher_id = ?
          AND sr.class_id = ?
          AND ((sr.course_id = ?) OR (sr.course_id IS NULL AND ? = 0))
      `, [structure.id, teacherId, classId, courseId, courseId]);

      // Calculate overall grades status
      const [subs] = await pool.execute(`
        SELECT status FROM grade_submissions 
        WHERE class_id = ? AND course_id = ? AND teacher_id = ? AND semester_id = ?
      `, [classId, courseId, teacherId, structure.semester || 'Semester 1']);

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

    let courseName = '';
    if (courseId != 0) {
      const [courseInfo] = await pool.execute('SELECT course_name FROM courses WHERE id = ?', [courseId]);
      if (courseInfo.length === 0) {
        return res.status(404).render('500-modern', {
          title: 'Course Not Found',
          message: 'The selected course could not be found.',
        });
      }
      courseName = courseInfo[0].course_name;
    } else {
      const [courseInfo] = await pool.execute(`
        SELECT COALESCE(
          (
            SELECT co.course_name
            FROM teacher_course_assignments tca
            JOIN courses co ON co.id = tca.course_id
            WHERE tca.teacher_id = ? AND tca.class_id = ? AND tca.status = 'active'
            LIMIT 1
          ),
          (
            SELECT MIN(co.course_name)
            FROM class_schedule cs
            JOIN courses co ON co.id = cs.course_id
            WHERE (cs.teacher_id = ? OR co.teacher_id = ?)
              AND cs.class_id = ?
            HAVING COUNT(DISTINCT cs.course_id) = 1
            LIMIT 1
          )
        ) AS course_name
        FROM classes c
        WHERE c.id = ?
      `, [teacherId, classId, teacherId, teacherId, classId, classId]);
      if (courseInfo.length > 0) courseName = courseInfo[0].course_name;
    }

    const [classInfo] = await pool.execute('SELECT grade, section FROM classes WHERE id = ?', [classId]);
    const classGrade = classInfo[0] ? classInfo[0].grade : '';
    const classSection = classInfo[0] ? classInfo[0].section : '';

    res.render('teacher/grades', {
      title: 'Class Grades',
      user: req.session.user,
      teacherName,
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
    const classId = Number(req.params.classId);
    const courseId = getCourseId(req.params.courseId);
    if (courseId === null || !await isTeacherAssigned(pool, teacherId, classId, courseId)) {
      return res.status(403).render('500-modern', { title: 'Access Denied', message: 'You are not assigned to this class/course.' });
    }

    let courseName = '';
    if (courseId !== 0) {
      const [courseInfo] = await pool.execute('SELECT course_name FROM courses WHERE id = ?', [courseId]);
      if (courseInfo.length === 0) {
        return res.status(404).render('500-modern', {
          title: 'Course Not Found',
          message: 'The selected course could not be found.',
        });
      }
      courseName = courseInfo[0].course_name;
    } else {
      const [courseInfo] = await pool.execute(`
        SELECT COALESCE(
          (
            SELECT co.course_name
            FROM teacher_course_assignments tca
            JOIN courses co ON co.id = tca.course_id
            WHERE tca.teacher_id = ? AND tca.class_id = ? AND tca.status = 'active'
            LIMIT 1
          ),
          (
            SELECT MIN(co.course_name)
            FROM class_schedule cs
            JOIN courses co ON co.id = cs.course_id
            WHERE (cs.teacher_id = ? OR co.teacher_id = ?)
              AND cs.class_id = ?
            HAVING COUNT(DISTINCT cs.course_id) = 1
            LIMIT 1
          )
        ) AS course_name
        FROM classes c
        WHERE c.id = ?
      `, [teacherId, classId, teacherId, teacherId, classId, classId]);
      if (courseInfo.length > 0) courseName = courseInfo[0].course_name;
    }

    const semester = req.query.semester || 'Semester 1';
    const structure = await getOwnedGradingStructure(
      pool,
      teacherId,
      classId,
      courseId,
      undefined,
      semester
    );
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
      semester,
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
    const classId = Number(req.params.classId);
    const courseId = getCourseId(req.params.courseId);
    const { semester, categories, status: reqStatus } = req.body;
    const saveStatus = reqStatus === 'pending' ? 'pending' : 'draft';

    if (courseId === null || !await isTeacherAssigned(conn, teacherId, classId, courseId)) {
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
      const dbCourseId = courseId === 0 ? null : courseId;
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
      classId,
      courseId,
      assignmentType,
      title,
      dueDate,
      maxPoints,
      timeLimit,
      attemptsAllowed,
      description,
      learningObjectives,
      additionalLinks,
      visibleToStudents
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

    // Insert assignment and capture insertId
    const [result] = await pool.execute(`
      INSERT INTO assignments (
        class_id, course_id, assignment_type, title, description, learning_objectives, additional_links, due_date, max_points, time_limit, 
        attempts_allowed, visible_to_students, created_by, teacher_id, academic_year, semester, semester_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      classId, courseId || null, assignmentType, title, description, learningObjectives, additionalLinks, dueDate || null, maxPoints || 100.00, timeLimit || null,
      attemptsAllowed || 'unlimited', visibleToStudents === 'on' ? 1 : 0, teacherId, teacherId, academicYear, semester, semester
    ]);

    // Emit real-time update to students of the class via Socket.IO
    const io = req.app.get('io');
    if (io) {
      // Fetch all student user IDs for the class
      const [students] = await pool.execute(`
        SELECT s.id as student_id, u.id as user_id
        FROM students s
        JOIN users u ON s.user_id = u.id
        WHERE s.class_id = ?
      `, [classId]);

      // Fetch class name and course name for payload
      const [classInfo] = await pool.execute(`SELECT name FROM classes WHERE id = ?`, [classId]);
      const className = classInfo.length ? classInfo[0].name : '';
      let courseName = '';
      if (courseId) {
        const [courseInfo] = await pool.execute(`SELECT name FROM courses WHERE id = ?`, [courseId]);
        courseName = courseInfo.length ? courseInfo[0].name : '';
      }

      const payload = {
        assignmentId: result.insertId,
        title,
        classId,
        className,
        courseId: courseId || null,
        courseName,
        assignmentType,
        dueDate,
        maxPoints,
        description,
        teacherId,
        teacherName: `${req.session.user.first_name || ''} ${req.session.user.last_name || ''}`
      };
      // Emit to each student in the class
      students.forEach(st => {
        io.to(`student_${st.user_id}`).emit('newAssignment', payload);
      });
      // Also emit to the class room
      io.to(`class_${classId}`).emit('newAssignment', payload);
    }

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
      SELECT a.*, c.name as class_name, c.grade, c.section, co.course_name as course_name
      FROM assignments a
      JOIN classes c ON a.class_id = c.id
      LEFT JOIN courses co ON a.course_id = co.id
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
        SELECT m.*, c.name as class_name, cr.course_name as course_name, t.first_name as teacher_fname, t.last_name as teacher_lname
        FROM materials m
        JOIN classes c ON m.class_id = c.id
        LEFT JOIN teachers t ON m.teacher_id = t.id
        LEFT JOIN courses cr ON m.course_id = cr.id
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
router.post('/materials/create', upload.single('file'), async (req, res) => {
  console.log('Create material request body:', req.body);
  console.log('Uploaded file info:', req.file);
  try {
    const { classId, courseId, title, description, materialType } = req.body;
    const fileUrl = req.file ? `/uploads/${req.file.filename}` : null;
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

    const [result] = await pool.execute(`
      INSERT INTO materials (class_id, teacher_id, course_id, title, description, file_url, material_type, academic_year, semester)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [classId, teacherId, courseId || null, title || '', description || '', fileUrl, materialType || 'reading', academicYear || '', semester || 'Semester 1']);

    // Emit real-time update to students of the class via Socket.IO
    const io = req.app.get('io');
    if (io) {
      const [students] = await pool.execute(`
        SELECT s.id as student_id, u.id as user_id
        FROM students s
        JOIN users u ON s.user_id = u.id
        WHERE s.class_id = ?
      `, [classId]);

      const payload = {
        materialId: result.insertId,
        title,
        classId,
        courseId: courseId || null,
        materialType: materialType || 'reading',
        description,
        fileUrl,
        teacherId,
        teacherName: `${req.session.user.first_name || ''} ${req.session.user.last_name || ''}`
      };
      students.forEach(st => {
        io.to(`student_${st.user_id}`).emit('newMaterial', payload);
        io.to(`class_${classId}`).emit('newMaterial', payload);
      });
    }
    // Log activity
    await logActivity(teacherId, 'Material Uploaded', `Uploaded ${materialType || 'resource'}: ${title}`, classId, courseId || null);

    console.log('Material insert result:', result);
    res.json({ message: 'Material added successfully' });
  } catch (error) {
    console.error('Create material error:', error);
    console.error('Create material error details:', error);
    res.status(500).json({ message: error.message || 'Server error' });
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
// Teacher self-registration routes have been removed for security.
// Previously existed GET /teacher/register and POST /teacher/register now disabled.
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