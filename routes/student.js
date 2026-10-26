const express = require('express');
const { pool } = require('../config/db');
const {
  getSetting,
  getAcademicContext,
  DEFAULT_ACADEMIC_YEAR,
  formatSemesterLabel,
  ATTENDANCE_COURSE_NAME_SQL,
} = require('../config/systemSettings');
const router = express.Router();

// Middleware to check if user is student
function isStudent(req, res, next) {
  if (!req.session.user || req.session.user.role !== 'student') {
    return res.redirect('/auth/login');
  }
  next();
}

// Apply student middleware to all routes
router.use(isStudent);

// GET /student/dashboard - Student dashboard
router.get('/dashboard', async (req, res) => {
  try {
    const studentId = req.session.user.id;

    // Get student information
    const [studentInfo] = await pool.execute(`
      SELECT s.*, u.username, u.email
      FROM students s
      JOIN users u ON s.user_id = u.id
      WHERE s.user_id = ?
    `, [studentId]);

    if (studentInfo.length === 0) {
      console.error('Student dashboard profile missing for user ID:', studentId);
      return res.status(403).render('500-modern', {
        title: 'Student Profile Not Found',
        message: 'Your student account is active, but its student profile has not been created. Please contact the administrator.'
      });
    }

    // Get ALL approved course results for table display
    const [approvedCourseResults] = await pool.execute(`
      SELECT scr.*, 
             COALESCE(co.course_name, (SELECT course_name FROM courses WHERE teacher_id = scr.teacher_id AND grade = cl.grade LIMIT 1)) as course_name, 
             COALESCE(co.course_code, (SELECT course_code FROM courses WHERE teacher_id = scr.teacher_id AND grade = cl.grade LIMIT 1)) as course_code, 
             cl.name as class_name,
             t.first_name as teacher_fname, t.last_name as teacher_lname
      FROM approved_results scr
      LEFT JOIN courses co ON (scr.course_id = co.id AND scr.course_id != 0)
      JOIN classes cl ON scr.class_id = cl.id
      LEFT JOIN teachers t ON scr.teacher_id = t.id
      WHERE scr.student_id = ?
      ORDER BY scr.academic_year DESC, scr.semester_id ASC, co.course_name ASC
    `, [studentInfo[0].id]);

    const dashboardCourseResults = approvedCourseResults.map(cr => ({
      course_name: cr.course_name || 'General Grade',
      course_code: cr.course_code || '',
      class_name: cr.class_name,
      semester: cr.semester_id,
      academic_year: cr.academic_year,
      teacher_name: (cr.teacher_fname && cr.teacher_lname) ? `${cr.teacher_fname} ${cr.teacher_lname}` : 'Assigned Teacher',
      categories: [],
      total_weighted: parseFloat(cr.total_score),
      structure_id: cr.assessment_structure_id
    }));

    const [dashboardDetails] = await pool.execute(`
      SELECT sr.score, ac.name as category_name, ac.weight_percentage, ac.max_mark, gs.id as structure_id
      FROM student_results sr
      JOIN assessment_categories ac ON sr.category_id = ac.id
      JOIN grading_structures gs ON ac.structure_id = gs.id
      WHERE sr.student_id = ? AND sr.status IN ('approved','saved')
      ORDER BY ac.order_index ASC
    `, [studentInfo[0].id]);

    dashboardDetails.forEach(d => {
      const ws = d.max_mark > 0 ? (parseFloat(d.score) / parseFloat(d.max_mark)) * parseFloat(d.weight_percentage) : 0;
      const targetCourse = dashboardCourseResults.find(c => c.structure_id === d.structure_id);
      if (targetCourse) {
        targetCourse.categories.push({
          category_name: d.category_name,
          score: d.score,
          max_mark: d.max_mark,
          weight_percentage: d.weight_percentage,
          weighted_score: ws
        });
      }
    });

    const courses = dashboardCourseResults;

    // Calculate Statistics using ONLY approved_results (Single Source of Truth)
    const [stats] = await pool.execute(`
      SELECT 
        AVG(scr.total_score) as average_score,
        COUNT(*) as approved_count
      FROM approved_results scr
      WHERE scr.student_id = ?
    `, [studentInfo[0].id]);

    const [semesterStats] = await pool.execute(`
      SELECT 
        scr.academic_year, 
        scr.semester_id as semester, 
        AVG(scr.total_score) as semester_avg
      FROM approved_results scr
      WHERE scr.student_id = ?
      GROUP BY scr.academic_year, scr.semester_id
      ORDER BY scr.academic_year DESC, scr.semester_id DESC
    `, [studentInfo[0].id]);

    const average_grade_num = stats[0].average_score ? parseFloat(stats[0].average_score) : 0;
    const average_grade = stats[0].average_score ? parseFloat(stats[0].average_score).toFixed(1) + '%' : 'N/A';
    const overall_progress = stats[0].average_score ? Math.round(parseFloat(stats[0].average_score)) : 0;
    const cgpa = (average_grade_num / 25).toFixed(2);
    const total_score = stats[0].total_score ? parseFloat(stats[0].total_score).toFixed(1) : '0.0';
    const total_max = (stats[0].approved_count || 0) * 100;

    // Calculate Class Rank using competition ranking per class_id + academic_year
    // Step 1: Resolve the student's class_id for ranking
    let rankClassId = studentInfo[0].class_id;
    if (!rankClassId && studentInfo[0].grade_level && studentInfo[0].section) {
      const [clsRes2] = await pool.execute(
        'SELECT id FROM classes WHERE CAST(grade AS CHAR) = CAST(? AS CHAR) AND section = ? LIMIT 1',
        [studentInfo[0].grade_level, studentInfo[0].section]
      );
      if (clsRes2.length > 0) rankClassId = clsRes2[0].id;
    }
    // Step 2: Get the active academic year from settings
    const activeYearForRank = (await getAcademicContext()).academicYear;
    // Step 3: Count students with a strictly higher average in the same class & year
    let rankDataResult = [{ student_rank: 'N/A' }];
    if (rankClassId) {
      const [rankRows] = await pool.execute(`
        SELECT COUNT(*) + 1 as student_rank
        FROM (
          SELECT scr2.student_id, AVG(scr2.total_score) as avg_score
          FROM approved_results scr2
          WHERE scr2.class_id = ?
            AND (? = '' OR scr2.academic_year = ?)
          GROUP BY scr2.student_id
        ) as class_ranks
        WHERE avg_score > ?
      `, [rankClassId, activeYearForRank, activeYearForRank, average_grade_num]);
      rankDataResult = rankRows;
    }
    const [rankData] = [rankDataResult];

    const [totalStudents] = await pool.execute(`
      SELECT COUNT(*) as total 
      FROM students 
      WHERE grade_level = ? AND section = ?
    `, [studentInfo[0].grade_level, studentInfo[0].section]);

    // Today's schedule
    const daysArr = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const todayName = daysArr[new Date().getDay()];
    let todaySchedule = [];

    // Resolve class_id for schedule
    let classIdForSchedule = studentInfo[0].class_id;
    if (!classIdForSchedule && studentInfo[0].grade_level && studentInfo[0].section) {
      const [clsRes] = await pool.execute(
        'SELECT id FROM classes WHERE CAST(grade AS CHAR) = CAST(? AS CHAR) AND section = ? LIMIT 1',
        [studentInfo[0].grade_level, studentInfo[0].section]
      );
      if (clsRes.length > 0) classIdForSchedule = clsRes[0].id;
    }

    if (classIdForSchedule) {
      const [todaySchedRes] = await pool.execute(`
            SELECT cs.*, c.course_name, c.course_code
            FROM class_schedule cs
            JOIN courses c ON cs.course_id = c.id
            WHERE cs.class_id = ? AND cs.day_of_week = ?
            ORDER BY cs.start_time
        `, [classIdForSchedule, todayName]);
      todaySchedule = todaySchedRes;
    }

    // Fetch recent attendance history for the student dashboard
    const [attendanceHistory] = await pool.execute(`
      SELECT a.*, c.name as class_name, ${ATTENDANCE_COURSE_NAME_SQL} as course_name
      FROM attendance a
      JOIN classes c ON a.class_id = c.id
      LEFT JOIN courses co ON a.course_id = co.id
      WHERE a.student_id = ? AND a.approval_status = 'approved'
      ORDER BY a.date DESC
      LIMIT 10
    `, [studentInfo[0].id]);

    // Moved attendanceData down

    // Check if Registration is Open via system settings
    let isRegistrationOpen = false;
    try {
      const [regSetting] = await pool.execute("SELECT setting_value FROM system_settings WHERE setting_key = 'regOpen'");
      isRegistrationOpen = (regSetting.length > 0 && regSetting[0].setting_value === 'on');
    } catch (e) { console.error("Reg setting fetch error:", e); }

    // Get Recent Assignments
    let dashboardAssignments = [];
    try {
      const [assignmentRes] = await pool.execute(`
            SELECT a.*, c.course_name, t.first_name as teacher_fname, t.last_name as teacher_lname
            FROM assignments a
            JOIN courses c ON a.class_id = c.id
            JOIN enrollments e ON c.id = e.course_id
            LEFT JOIN teachers t ON a.created_by = t.id
            WHERE e.student_id = ? AND e.status = 'enrolled'
            ORDER BY a.due_date ASC
            LIMIT 5
        `, [studentInfo[0].id]);
      dashboardAssignments = assignmentRes;
    } catch (e) { console.error("Dashboard assignments error:", e); }

    // Get Full Weekly Schedule
    let fullSchedule = [];
    if (classIdForSchedule) {
      try {
        const [schedRes] = await pool.execute(`
                SELECT cs.*, c.course_name, c.course_code
                FROM class_schedule cs
                JOIN courses c ON cs.course_id = c.id
                WHERE cs.class_id = ?
                ORDER BY FIELD(day_of_week, 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'), start_time
            `, [classIdForSchedule]);
        fullSchedule = schedRes;
      } catch (e) { console.error("Full schedule fetch error:", e); }
    }

    // Get Pending Tasks
    let pending_tasks = 0;
    try {
      const [assignments] = await pool.execute(`
         SELECT COUNT(*) as count FROM assignments a
         JOIN enrollments e ON a.class_id = e.course_id
         WHERE e.student_id = ? AND e.status = 'enrolled'
         AND (a.due_date >= CURDATE() OR a.due_date IS NULL)
      `, [studentInfo[0].id]);
      pending_tasks = (assignments[0] && assignments[0].count) || 0;
    } catch (e) { pending_tasks = 0; }

    const [attendance] = await pool.execute(`
          SELECT 
            SUM(CASE WHEN status = 'present' THEN 1 ELSE 0 END) as present_count,
            SUM(CASE WHEN status = 'late' THEN 1 ELSE 0 END) as late_count,
            SUM(CASE WHEN status = 'excused' THEN 1 ELSE 0 END) as excused_count,
            COUNT(*) as total_count
          FROM attendance
          WHERE student_id = ? AND approval_status = 'approved'
        `, [studentInfo[0].id]);
    // Compute stats
    const present = attendance[0].present_count || 0;
    const late = attendance[0].late_count || 0;
    const excused = attendance[0].excused_count || 0;
    const total = attendance[0].total_count || 0;
    const absent = total - (present + late + excused);
    const attendedCount = present + late + excused;
    const attendance_rate = total > 0 ? ((attendedCount / total) * 100).toFixed(1) : '100';
    const attendanceData = {
      percentage: attendance_rate,
      present,
      late,
      excused,
      absent,
      sessions: attendedCount
    };

    res.render('student/dashboard-new', {
      title: 'Student Dashboard',
      user: req.session.user,
      student: studentInfo[0],
      courses_count: courses.length,
      courses,
      assignments: dashboardAssignments,
      fullSchedule,
      attendance_rate: attendance_rate,
      attendance: attendanceData,
      attendanceHistory: attendanceHistory,
      cgpa: parseFloat(cgpa).toFixed(2),
      total_score: parseFloat(total_score).toFixed(1),
      total_max: total_max,
      average_grade: average_grade,
      overall_progress: overall_progress,
      overall_progress_text: `${overall_progress}% Academic Progress`,
      semester_stats: semesterStats,
      rank: (rankData[0] && rankData[0].student_rank) || 'N/A',
      total_in_class: totalStudents[0].total,
      pending_tasks: pending_tasks,
      isRegistrationOpen,
      todaySchedule,
      todayName
    });

  } catch (error) {
    console.error('Student dashboard error:', error);
    res.status(500).render('500-modern', { title: 'Server Error' });
  }
});

// GET /student/profile - Student profile
router.get('/profile', async (req, res) => {
  try {
    const studentId = req.session.user.id;

    const [studentInfo] = await pool.execute(`
      SELECT s.*, u.username, u.email, u.phone
      FROM students s
      JOIN users u ON s.user_id = u.id
      WHERE s.user_id = ?
    `, [studentId]);

    res.render('student/profile', {
      title: 'My Profile',
      user: req.session.user,
      student: studentInfo[0]
    });

  } catch (error) {
    console.error('Student profile error:', error);
    res.status(500).render('500-modern', { title: 'Server Error' });
  }
});

// POST /student/profile/update - Update student profile
router.post('/profile/update', async (req, res) => {
  try {
    const userId = req.session.user.id;
    const {
      first_name, last_name, email, phone, gender,
      date_of_birth, parent_guardian_name, address, previous_school
    } = req.body;

    // Update users table
    await pool.execute(
      'UPDATE users SET first_name = ?, last_name = ?, email = ?, phone = ? WHERE id = ?',
      [first_name, last_name, email, phone, userId]
    );

    // Update students table
    await pool.execute(
      'UPDATE students SET first_name = ?, last_name = ?, gender = ?, date_of_birth = ?, parent_guardian_name = ?, address = ?, previous_school = ? WHERE user_id = ?',
      [first_name, last_name, gender, date_of_birth, parent_guardian_name, address, previous_school, userId]
    );

    // Update session
    req.session.user.first_name = first_name;
    req.session.user.last_name = last_name;
    req.session.user.email = email;

    res.redirect('/student/profile');
  } catch (error) {
    console.error('Student profile update error:', error);
    res.redirect('back');
  }
});

// GET /student/courses - Student courses
router.get('/courses', async (req, res) => {
  try {
    const studentId = req.session.user.id;

    // Get student information
    const [studentInfo] = await pool.execute(`
      SELECT id FROM students WHERE user_id = ?
    `, [req.session.user.id]);

    // Get enrolled courses with grades
    const [courses] = await pool.execute(`
      SELECT c.*, e.enrollment_date, e.grade, e.status,
             t.first_name as teacher_fname, t.last_name as teacher_lname,
             (SELECT total_score 
              FROM student_course_results scr 
              WHERE scr.course_id = c.id AND scr.student_id = ? AND scr.status = 'approved' 
              ORDER BY scr.academic_year DESC, scr.semester_id DESC LIMIT 1) as average_grade
      FROM courses c
      JOIN enrollments e ON c.id = e.course_id
      LEFT JOIN teachers t ON c.teacher_id = t.id
      WHERE e.student_id = ?
      ORDER BY c.course_name
    `, [studentInfo[0].id, studentInfo[0].id]);

    res.render('student/courses', {
      title: 'My Courses',
      user: req.session.user,
      courses: courses
    });

  } catch (error) {
    console.error('Student courses error:', error);
    res.status(500).render('500-modern', { title: 'Server Error' });
  }
});

// GET /student/attendance - Student attendance
router.get('/attendance', async (req, res) => {
  try {
    const [studentInfo] = await pool.execute(`
      SELECT id FROM students WHERE user_id = ?
    `, [req.session.user.id]);

    const courseIdFilter = req.query.courseId;
    let query = `
      SELECT a.*, c.name as class_name, ${ATTENDANCE_COURSE_NAME_SQL} as course_name
      FROM attendance a
      JOIN classes c ON a.class_id = c.id
      LEFT JOIN courses co ON a.course_id = co.id
      WHERE a.student_id = ?
    `;
    const params = [studentInfo[0].id];

    if (courseIdFilter) {
      query += ` AND a.course_id = ?`;
      params.push(courseIdFilter);
    }
    query += ` ORDER BY a.date DESC`;

    const [attendance] = await pool.execute(query, params);

    // Fetch enrolled courses for the filter dropdown
    const [courses] = await pool.execute(`
      SELECT DISTINCT co.id, co.course_name 
      FROM enrollments e 
      JOIN courses co ON e.course_id = co.id 
      WHERE e.student_id = ? AND e.status = 'enrolled'
    `, [studentInfo[0].id]);

    // Calculate stats
    const stats = {
      present: attendance.filter(a => a.status === 'present').length,
      absent: attendance.filter(a => a.status === 'absent').length,
      late: attendance.filter(a => a.status === 'late').length,
      excused: attendance.filter(a => a.status === 'excused').length,
      total: attendance.length
    };
    const attended = stats.present + stats.late + stats.excused;
    stats.percentage = stats.total > 0 ? ((attended / stats.total) * 100).toFixed(1) : '100';
    // Alias for template compatibility
    stats.rate = stats.percentage;


    res.render('student/attendance', {
      title: 'My Attendance',
      user: req.session.user,
      attendance,
      stats,
      courses,
      selectedCourseId: courseIdFilter || ''
    });

  } catch (error) {
    console.error('Student attendance error:', error);
    res.status(500).render('500-modern', { title: 'Server Error' });
  }
});

// GET /student/assignments - Student assignments
router.get('/assignments', async (req, res) => {
  try {
    const [studentInfo] = await pool.execute(`
      SELECT id FROM students WHERE user_id = ?
    `, [req.session.user.id]);

    const [assignments] = await pool.execute(`
      SELECT a.*, c.name as class_name, t.first_name as teacher_fname, t.last_name as teacher_lname
      FROM assignments a
      JOIN classes c ON a.class_id = c.id
      JOIN class_students cs ON c.id = cs.class_id
      LEFT JOIN teachers t ON a.created_by = t.id
      WHERE cs.student_id = ?
      ORDER BY a.due_date ASC
    `, [studentInfo[0].id]);

    res.render('student/assignments', {
      title: 'My Assignments',
      user: req.session.user,
      assignments
    });

  } catch (error) {
    console.error('Student assignments error:', error);
    res.status(500).render('500-modern', { title: 'Server Error' });
  }
});

// GET /student/timetable - Student timetable
router.get('/timetable', async (req, res) => {
  try {
    const [students] = await pool.execute(
      'SELECT id, class_id, grade_level, section FROM students WHERE user_id = ?',
      [req.session.user.id]
    );

    if (students.length === 0) {
      return res.render('student/timetable', { title: 'My Timetable', user: req.session.user, schedule: [] });
    }

    let classId = students[0].class_id;

    // Fallback: If class_id is missing, look it up by grade and section
    if (!classId && students[0].grade_level && students[0].section) {
      // Use CAST to handle numeric/string grade mismatches
      const [classes] = await pool.execute(
        'SELECT id FROM classes WHERE CAST(grade AS CHAR) = CAST(? AS CHAR) AND section = ? LIMIT 1',
        [students[0].grade_level, students[0].section]
      );
      if (classes.length > 0) {
        classId = classes[0].id;
        // Auto-fix the student's class_id for future lookups
        await pool.execute('UPDATE students SET class_id = ? WHERE id = ?', [classId, students[0].id]);
      }
    }

    if (!classId) {
      return res.render('student/timetable', { title: 'My Timetable', user: req.session.user, schedule: [] });
    }

    const [schedule] = await pool.execute(`
      SELECT cs.*, c.course_name, c.course_code
      FROM class_schedule cs
      JOIN courses c ON cs.course_id = c.id
      WHERE cs.class_id = ?
      ORDER BY FIELD(day_of_week, 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'), start_time
    `, [classId]);

    res.render('student/timetable', {
      title: 'My Timetable',
      user: req.session.user,
      schedule
    });

  } catch (error) {
    console.error('Student timetable error:', error);
    res.status(500).render('500-modern', { title: 'Server Error' });
  }
});

// GET /student/announcements - Student announcements
router.get('/announcements', async (req, res) => {
  try {
    const [announcements] = await pool.execute(`
      SELECT a.*, u.first_name as creator_fname, u.last_name as creator_lname
      FROM announcements a
      LEFT JOIN users u ON a.created_by = u.id
      WHERE a.audience IN ('all', 'students')
      ORDER BY a.created_at DESC
    `);

    res.render('student/announcements', {
      title: 'Announcements',
      user: req.session.user,
      announcements
    });

  } catch (error) {
    console.error('Student announcements error:', error);
    res.status(500).render('500-modern', { title: 'Server Error' });
  }
});

// GET /student/api/grades - API returning JSON results matching exact required structure
router.get('/api/grades', async (req, res) => {
  try {
    const [studentInfo] = await pool.execute(
      'SELECT id, grade_level, section FROM students WHERE user_id = ?',
      [req.session.user.id]
    );
    if (!studentInfo[0]) return res.status(404).json({ error: 'Student not found' });
    const studentId = studentInfo[0].id;

    const { academicYear: activeYear, semesterLabel: activeSemSetting } = await getAcademicContext();

    const [courseResults] = await pool.execute(`
      SELECT scr.*, co.course_name, co.course_code, cl.name as class_name,
             t.first_name as teacher_fname, t.last_name as teacher_lname
      FROM approved_results scr
      LEFT JOIN courses co ON (scr.course_id = co.id AND scr.course_id != 0)
      JOIN classes cl ON scr.class_id = cl.id
      LEFT JOIN teachers t ON scr.teacher_id = t.id
      WHERE scr.student_id = ? AND scr.status IN ('approved','saved') AND scr.academic_year = ? AND scr.semester_id = ?
      ORDER BY co.course_name ASC
    `, [studentId, activeYear, activeSemSetting]);

    const coursesJson = [];

    for (const cr of courseResults) {
      const [categories] = await pool.execute(`
        SELECT ac.name, ac.max_mark, ac.weight_percentage,
               (SELECT sr.score FROM student_results sr WHERE sr.student_id = ? AND sr.category_id = ac.id AND sr.status IN ('approved','saved') LIMIT 1) as obtained_score
      FROM assessment_categories ac
      WHERE ac.structure_id = ?
    `, [studentId, cr.assessment_structure_id]);

      let max_mark = 0;
      let student_mark = 0;
      let weight = 0;

      categories.forEach(cat => {
        max_mark += parseFloat(cat.max_mark || 0);
        student_mark += parseFloat(cat.obtained_score || 0);
        weight += parseFloat(cat.weight_percentage || 0);
      });

      const final_score = parseFloat(cr.total_score);
      let grade = 'F';
      if (final_score >= 90) grade = 'A+';
      else if (final_score >= 85) grade = 'A';
      else if (final_score >= 80) grade = 'A-';
      else if (final_score >= 75) grade = 'B+';
      else if (final_score >= 70) grade = 'B';
      else if (final_score >= 65) grade = 'B-';
      else if (final_score >= 60) grade = 'C+';
      else if (final_score >= 55) grade = 'C';
      else if (final_score >= 50) grade = 'D';

      coursesJson.push({
        course_name: cr.course_name || 'General Grade',
        teacher_name: (cr.teacher_fname && cr.teacher_lname) ? `${cr.teacher_fname} ${cr.teacher_lname}` : 'Assigned Teacher',
        max_mark,
        student_mark,
        weight: weight / 100,
        final_score,
        grade
      });
    }

    res.json({
      student_id: studentId,
      semester: activeSemSetting,
      courses: coursesJson
    });

  } catch (error) {
    console.error('API grades error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// GET /student/grades - Student grades (Flexible Grading System)
router.get('/grades', async (req, res) => {
  try {
    const [studentInfo] = await pool.execute(
      'SELECT id, grade_level, section FROM students WHERE user_id = ?',
      [req.session.user.id]
    );
    if (!studentInfo[0]) return res.status(404).render('500-modern', { title: 'Not Found' });
    const studentId = studentInfo[0].id;

    const { academicYear: activeYear, semesterLabel: activeSemSetting } = await getAcademicContext();

    const [courseResults] = await pool.execute(`
    SELECT 
        academic_year,
        semester_id,
        total_score,
        assessment_structure_id,
        course_name,
        course_code,
        class_name,
        teacher_fname,
        teacher_lname
    FROM (
        SELECT 
            scr.academic_year,
            scr.semester_id,
            scr.total_score,
            scr.assessment_structure_id,
            COALESCE(co.course_name, (SELECT course_name FROM courses WHERE teacher_id = scr.teacher_id AND grade = cl.grade LIMIT 1)) AS course_name,
            COALESCE(co.course_code, (SELECT course_code FROM courses WHERE teacher_id = scr.teacher_id AND grade = cl.grade LIMIT 1)) AS course_code,
            cl.name AS class_name,
            t.first_name AS teacher_fname,
            t.last_name AS teacher_lname
        FROM approved_results scr
        LEFT JOIN courses co ON (scr.course_id = co.id AND scr.course_id != 0)
        JOIN classes cl ON scr.class_id = cl.id
        LEFT JOIN teachers t ON scr.teacher_id = t.id
        WHERE scr.student_id = ?
        UNION ALL
        SELECT 
            scr2.academic_year,
            scr2.semester_id,
            scr2.total_score,
            scr2.assessment_structure_id,
            COALESCE(co2.course_name, (SELECT course_name FROM courses WHERE teacher_id = scr2.teacher_id AND grade = cl2.grade LIMIT 1)) AS course_name,
            COALESCE(co2.course_code, (SELECT course_code FROM courses WHERE teacher_id = scr2.teacher_id AND grade = cl2.grade LIMIT 1)) AS course_code,
            cl2.name AS class_name,
            t2.first_name AS teacher_fname,
            t2.last_name AS teacher_lname
        FROM student_course_results scr2
        LEFT JOIN courses co2 ON (scr2.course_id = co2.id AND scr2.course_id != 0)
        JOIN classes cl2 ON scr2.class_id = cl2.id
        LEFT JOIN teachers t2 ON scr2.teacher_id = t2.id
        WHERE scr2.student_id = ? AND scr2.status = 'saved'
    ) AS combined
    ORDER BY academic_year DESC, semester_id ASC, course_name ASC
`, [studentId, studentId]);

    const courseList = courseResults.map(cr => ({
      course_name: cr.course_name || 'General Grade',
      course_code: cr.course_code || '',
      class_name: cr.class_name,
      semester: cr.semester_id,
      academic_year: cr.academic_year,
      class_id: cr.class_id,
      teacher_name: (cr.teacher_fname && cr.teacher_lname) ? `${cr.teacher_fname} ${cr.teacher_lname}` : 'Assigned Teacher',
      categories: [],
      total_weighted: parseFloat(cr.total_score),
      structure_id: cr.assessment_structure_id
    }));

    // Fetch individual category details
    const [details] = await pool.execute(`
      SELECT sr.score, ac.name as category_name, ac.weight_percentage, ac.max_mark, gs.id as structure_id
      FROM student_results sr
      JOIN assessment_categories ac ON sr.category_id = ac.id
      JOIN grading_structures gs ON ac.structure_id = gs.id
      WHERE sr.student_id = ? AND sr.status IN ('approved','saved')
      ORDER BY ac.order_index ASC
    `, [studentId]);

    details.forEach(d => {
      const ws = d.max_mark > 0 ? (parseFloat(d.score) / parseFloat(d.max_mark)) * parseFloat(d.weight_percentage) : 0;
      const targetCourse = courseList.find(c => c.structure_id === d.structure_id);
      if (targetCourse) {
        targetCourse.categories.push({
          category_name: d.category_name,
          score: d.score,
          max_mark: d.max_mark,
          weight_percentage: d.weight_percentage,
          weighted_score: ws
        });
      }
    });

    // Group into Current Semester vs Previous Semester
    const currentSemesterResults = [];
    const previousSemesterResults = [];

    courseList.forEach(c => {
      if (c.academic_year === activeYear && c.semester === activeSemSetting) {
        currentSemesterResults.push(c);
      } else {
        previousSemesterResults.push(c);
      }
    });

    let currentSum = 0;
    currentSemesterResults.forEach(c => { currentSum += c.total_weighted; });
    const currentAvg = currentSemesterResults.length > 0 ? (currentSum / currentSemesterResults.length) : 0;

    let previousSum = 0;
    previousSemesterResults.forEach(c => { previousSum += c.total_weighted; });
    const previousAvg = previousSemesterResults.length > 0 ? (previousSum / previousSemesterResults.length) : 0;

    let overallSum = 0;
    courseList.forEach(c => { overallSum += c.total_weighted; });
    const overallAvg = courseList.length > 0 ? (overallSum / courseList.length) : 0;

    // Resolve class_id for grades page rank
    let gradesClassId = studentInfo[0].class_id || null;
    if (!gradesClassId && studentInfo[0].grade_level && studentInfo[0].section) {
      const [clsForGrades] = await pool.execute(
        'SELECT id FROM classes WHERE CAST(grade AS CHAR) = CAST(? AS CHAR) AND section = ? LIMIT 1',
        [studentInfo[0].grade_level, studentInfo[0].section]
      );
      if (clsForGrades.length > 0) gradesClassId = clsForGrades[0].id;
    }
    const gradesActiveYear = await getSetting('academicYear', '');
    let gradesRankResult = [{ student_rank: 'N/A' }];
    if (gradesClassId) {
      const [gradesRankRows] = await pool.execute(`
        SELECT COUNT(*) + 1 as student_rank
        FROM (
          SELECT scr2.student_id, AVG(scr2.total_score) as avg_score
          FROM approved_results scr2
          WHERE scr2.class_id = ?
            AND (? = '' OR scr2.academic_year = ?)
          GROUP BY scr2.student_id
        ) as ranks
        WHERE avg_score > ?
      `, [gradesClassId, gradesActiveYear, gradesActiveYear, overallAvg]);
      gradesRankResult = gradesRankRows;
    }
    const [rankData] = [gradesRankResult];

    // Attendance rate
    const [attendance] = await pool.execute(`
       SELECT 
         SUM(CASE WHEN status IN ('present', 'late', 'excused') THEN 1 ELSE 0 END) as present_count,
         COUNT(*) as total_count
       FROM attendance
       WHERE student_id = ? AND approval_status = 'approved'
    `, [studentId]);

    let attendance_rate = '100';
    if (attendance[0].total_count > 0) {
      attendance_rate = ((attendance[0].present_count / attendance[0].total_count) * 100).toFixed(1);
    }

    res.render('student/grades', {
      title: 'My Academic Results',
      user: req.session.user,
      currentSemesterResults,
      previousSemesterResults,
      currentAvg: currentAvg.toFixed(1),
      currentSum: currentSum.toFixed(1),
      previousAvg: previousAvg.toFixed(1),
      previousSum: previousSum.toFixed(1),
      overallAvg: overallAvg.toFixed(1),
      overallSum: overallSum.toFixed(1),
      rank: (rankData[0] && rankData[0].student_rank) || 'N/A',
      courseResults: courseList,
      attendance_rate,
      hasResults: courseList.length > 0
    });

  } catch (error) {
    console.error('Student grades error:', error);
    res.status(500).render('500-modern', { title: 'Server Error' });
  }
});

// GET /student/materials - View course materials
router.get('/materials', async (req, res) => {
  try {
    const studentUserId = req.session.user.id;

    // Get student profile ID
    const [studentProfile] = await pool.execute(
      'SELECT id, grade_level, section FROM students WHERE user_id = ?',
      [studentUserId]
    );

    if (studentProfile.length === 0) {
      return res.status(404).render('500-modern', { title: '404', message: 'Student profile not found.' });
    }

    const studentId = studentProfile[0].id;

    // Fetch materials for all classes the student belongs to
    const [materials] = await pool.execute(`
        SELECT m.*, c.name as class_name, cr.course_name as course_name, t.first_name as teacher_fname, t.last_name as teacher_lname
        FROM materials m
        JOIN classes c ON m.class_id = c.id
        JOIN class_students cs ON c.id = cs.class_id
        LEFT JOIN teachers t ON m.teacher_id = t.id
        LEFT JOIN courses cr ON m.course_id = cr.id
        WHERE cs.student_id = ?
        ORDER BY m.created_at DESC
    `, [studentId]);

    res.render('student/materials', {
      title: 'Course Materials',
      user: req.session.user,
      materials
    });

  } catch (error) {
    console.error('Student materials error:', error);
    res.status(500).render('500-modern', { title: 'Server Error' });
  }
});

// GET /student/registration - View available courses for registration
router.get('/registration', async (req, res) => {
  try {
    const studentUserId = req.session.user.id;
    const [studentInfo] = await pool.execute('SELECT id, grade_level, registration_status FROM students WHERE user_id = ?', [studentUserId]);
    const studentId = studentInfo[0].id;
    const gradeLevel = studentInfo[0].grade_level;
    const registrationStatus = studentInfo[0].registration_status;

    // Get all active courses
    const [courses] = await pool.execute(`
      SELECT c.*, t.first_name as teacher_fname, t.last_name as teacher_lname,
             (SELECT COUNT(*) FROM enrollments WHERE course_id = c.id AND status = 'enrolled') as enrolled_count
      FROM courses c
      LEFT JOIN teachers t ON c.teacher_id = t.id
      WHERE c.is_active = TRUE
    `);

    // Get student's current enrollments
    const [currentEnrollments] = await pool.execute(
      'SELECT course_id, status FROM enrollments WHERE student_id = ?',
      [studentId]
    );

    // Get prerequisites
    const [allPrereqs] = await pool.execute(`
      SELECT cp.*, c.course_name as prereq_name
      FROM course_prerequisites cp
      JOIN courses c ON cp.prerequisite_id = c.id
    `);

    res.render('student/registration', {
      title: 'Course Registration',
      user: req.session.user,
      courses,
      currentEnrollments,
      allPrereqs,
      registrationStatus,
      success: req.session.flash ? req.session.flash.success : null,
      error: req.session.flash ? req.session.flash.error : null
    });
    if (req.session.flash) delete req.session.flash;
  } catch (error) {
    console.error('Registration view error:', error);
    res.status(500).render('500-modern', { title: 'Server Error' });
  }
});

// POST /student/courses/enroll - Enroll in a course
router.post('/courses/enroll', async (req, res) => {
  try {
    const { course_id } = req.body;
    const studentUserId = req.session.user.id;
    const [studentInfo] = await pool.execute('SELECT id FROM students WHERE user_id = ?', [studentUserId]);
    const studentId = studentInfo[0].id;

    // 1. Check Prerequisites
    const [prereqs] = await pool.execute(
      'SELECT prerequisite_id FROM course_prerequisites WHERE course_id = ?',
      [course_id]
    );

    for (const prereq of prereqs) {
      const [completed] = await pool.execute(
        "SELECT id FROM enrollments WHERE student_id = ? AND course_id = ? AND status = 'completed'",
        [studentId, prereq.prerequisite_id]
      );
      if (completed.length === 0) {
        req.session.flash = { error: 'Prerequisites not met for this course.' };
        return res.redirect('/student/registration');
      }
    }

    // 2. Check if already enrolled/pending
    const [existing] = await pool.execute(
      "SELECT id FROM enrollments WHERE student_id = ? AND course_id = ? AND status IN ('enrolled', 'pending', 'waitlisted')",
      [studentId, course_id]
    );
    if (existing.length > 0) {
      req.session.flash = { error: 'Already registered or pending for this course.' };
      return res.redirect('/student/registration');
    }

    // 3. Create Enrollment (default status: pending)
    await pool.execute(
      "INSERT INTO enrollments (student_id, course_id, status, enrollment_date) VALUES (?, ?, 'pending', CURDATE())",
      [studentId, course_id]
    );

    req.session.flash = { success: 'Registration request submitted. Pending admin approval.' };
    res.redirect('/student/registration');
  } catch (error) {
    console.error('Enrollment error:', error);
    req.session.flash = { error: 'Failed to enroll: ' + error.message };
    res.redirect('/student/registration');
  }
});

// POST /student/courses/drop/:id - Drop a course
router.post('/courses/drop/:id', async (req, res) => {
  try {
    const enrollmentId = req.params.id;
    // Simplified deadline check: can drop if it's still 'pending' or 'enrolled'
    // Optional: add date check here
    await pool.execute(
      "UPDATE enrollments SET status = 'dropped' WHERE id = ? AND student_id = (SELECT id FROM students WHERE user_id = ?)",
      [enrollmentId, req.session.user.id]
    );
    req.session.flash = { success: 'Course dropped successfully.' };
    res.redirect('/student/registration');
  } catch (error) {
    console.error('Drop error:', error);
    req.session.flash = { error: 'Failed to drop course.' };
    res.redirect('/student/registration');
  }
});

// POST /student/registration/assisted - Auto enroll in all active courses and submit
router.post('/registration/assisted', async (req, res) => {
  try {
    const studentUserId = req.session.user.id;
    const [studentInfo] = await pool.execute('SELECT id FROM students WHERE user_id = ?', [studentUserId]);
    const studentId = studentInfo[0].id;

    // Get all active courses
    const [activeCourses] = await pool.execute('SELECT id FROM courses WHERE is_active = TRUE');

    // Auto-enroll in all active courses
    if (activeCourses.length > 0) {
      for (const course of activeCourses) {
        // Check if already enrolled to avoid uniqueness constraint error without IGNORE if IGNORE isn't bulletproof
        const [existing] = await pool.execute(
          "SELECT id FROM enrollments WHERE student_id = ? AND course_id = ?",
          [studentId, course.id]
        );

        if (existing.length === 0) {
          await pool.execute(
            "INSERT INTO enrollments (student_id, course_id, status, enrollment_date) VALUES (?, ?, 'pending', CURDATE())",
            [studentId, course.id]
          );
        }
      }
    }

    
    req.session.flash = { success: 'Assisted auto-enrollment complete. Registration submitted for admin approval.' };
    res.redirect('/student/registration');
  } catch (error) {
    console.error('Assisted registration error:', error);
    req.session.flash = { error: 'Failed to complete assisted registration: ' + error.message };
    res.redirect('/student/registration');
  }
});

// POST /student/registration/submit - Submit all enrollments for admin approval
router.post('/registration/submit', async (req, res) => {
  try {
    const studentUserId = req.session.user.id;

    // Try to safely alter the ENUM to include 'submitted' if it doesn't already
    try {
      await pool.execute("ALTER TABLE students MODIFY COLUMN registration_status ENUM('not_started', 'pending', 'submitted', 'registered') DEFAULT 'not_started'");
    } catch (e) { }

    await pool.execute(
      "UPDATE students SET registration_status = 'submitted' WHERE user_id = ?",
      [studentUserId]
    );
    req.session.flash = { success: 'Semester registration submitted for admin approval.' };
    res.redirect('/student/registration');
  } catch (error) {
    console.error('Submit registration error:', error);
    req.session.flash = { error: 'Failed to submit registration.' };
    res.redirect('/student/registration');
  }
});




// GET /student/registration/simple - Simple registration page
router.get('/registration/simple', async (req, res) => {
  try {
    const studentUserId = req.session.user.id;
    const [studentInfo] = await pool.execute('SELECT registration_status FROM students WHERE user_id = ?', [studentUserId]);
    const registrationStatus = studentInfo[0].registration_status;
    res.render('student/simple_registration', {
      title: 'Semester Registration',
      user: req.session.user,
      registrationStatus,
      success: req.session.flash ? req.session.flash.success : null,
      error: req.session.flash ? req.session.flash.error : null
    });
    if (req.session.flash) delete req.session.flash;
  } catch (error) {
    console.error('Simple registration view error:', error);
    res.status(500).render('500-modern', { title: 'Server Error' });
  }
});

// POST /student/registration/simple - Process registration click
router.post('/registration/simple', async (req, res) => {
  try {
    const studentUserId = req.session.user.id;
    await pool.execute('UPDATE students SET registration_status = ?, registration_updated_at = CURRENT_TIMESTAMP WHERE user_id = ?', ['registered', studentUserId]);
    req.session.flash = { success: 'Semester registration successful.' };
    // Redirect to dashboard (will show toast via flash)
    res.redirect('/student/dashboard');
  } catch (error) {
    console.error('Simple registration submit error:', error);
    req.session.flash = { error: 'Failed to complete registration.' };
    res.redirect('/student/registration/simple');
  }
});


module.exports = router;
