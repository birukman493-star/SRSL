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

async function getVisibleCourseResults(studentId, academicYear, semester) {
  let academicFilter = '';
  const params = [studentId];

  if (academicYear !== undefined) {
    academicFilter += ' AND scr.academic_year = ?';
    params.push(academicYear);
  }
  if (semester !== undefined) {
    academicFilter += ' AND scr.semester_id = ?';
    params.push(semester);
  }

  const [results] = await pool.execute(`
    SELECT scr.id AS result_id, scr.student_id, scr.teacher_id, scr.course_id,
           COALESCE(NULLIF(scr.course_id, 0), assigned_course.course_id, scheduled_course.course_id) AS resolved_course_id,
           scr.class_id, scr.semester_id, scr.academic_year, scr.assessment_structure_id,
           scr.total_score, co.course_name, co.course_code, cl.name AS class_name,
           t.first_name AS teacher_fname, t.last_name AS teacher_lname
    FROM student_course_results scr
    JOIN students s ON s.id = scr.student_id
    JOIN classes cl ON cl.id = scr.class_id
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
    JOIN grading_structures gs
      ON gs.id = scr.assessment_structure_id
      AND gs.teacher_id = scr.teacher_id
      AND gs.class_id = scr.class_id
      AND (
        ((scr.course_id IS NULL OR scr.course_id = 0) AND gs.course_id IS NULL)
        OR gs.course_id = scr.course_id
      )
    LEFT JOIN teachers t ON t.id = scr.teacher_id
    WHERE scr.student_id = ?
      AND scr.status IN ('approved', 'saved')
      AND (
        s.class_id = scr.class_id
        OR (
          s.class_id IS NULL
          AND CAST(s.grade_level AS CHAR) = CAST(cl.grade AS CHAR)
          AND s.section = cl.section
        )
      )
      AND (
        scr.course_id IS NULL
        OR scr.course_id = 0
        OR EXISTS (
          SELECT 1 FROM enrollments e
          WHERE e.student_id = scr.student_id
            AND e.course_id = scr.course_id
            AND e.status IN ('enrolled', 'completed')
        )
      )
      ${academicFilter}
    ORDER BY scr.academic_year DESC, scr.semester_id ASC, co.course_name ASC
  `, params);

  if (results.length === 0) return [];

  const resultIds = results.map((result) => result.result_id);
  const placeholders = resultIds.map(() => '?').join(', ');
  const [assessments] = await pool.execute(`
    SELECT scr.id AS result_id, ac.name AS assessment_name,
           sr.score, ac.max_mark, ac.weight_percentage
    FROM student_course_results scr
    JOIN students s ON s.id = scr.student_id
    JOIN classes cl ON cl.id = scr.class_id
    JOIN grading_structures gs
      ON gs.id = scr.assessment_structure_id
      AND gs.teacher_id = scr.teacher_id
      AND gs.class_id = scr.class_id
      AND (
        ((scr.course_id IS NULL OR scr.course_id = 0) AND gs.course_id IS NULL)
        OR gs.course_id = scr.course_id
      )
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
      AND sr.status IN ('approved', 'saved')
    JOIN assessment_categories ac
      ON ac.id = sr.category_id
      AND ac.structure_id = scr.assessment_structure_id
    WHERE scr.student_id = ?
      AND scr.id IN (${placeholders})
      AND scr.status IN ('approved', 'saved')
      AND (
        s.class_id = scr.class_id
        OR (
          s.class_id IS NULL
          AND CAST(s.grade_level AS CHAR) = CAST(cl.grade AS CHAR)
          AND s.section = cl.section
        )
      )
    ORDER BY ac.order_index ASC
  `, [studentId, ...resultIds]);

  const assessmentsByResult = new Map();
  for (const assessment of assessments) {
    const courseAssessments = assessmentsByResult.get(assessment.result_id) || [];
    courseAssessments.push({
      assessment_name: assessment.assessment_name,
      score: Number(assessment.score),
      max_mark: Number(assessment.max_mark),
      weight_percentage: Number(assessment.weight_percentage),
    });
    assessmentsByResult.set(assessment.result_id, courseAssessments);
  }

  return results.map((result) => ({
    ...result,
    course_code: result.course_code || '',
    teacher_name: result.teacher_fname && result.teacher_lname
      ? `${result.teacher_fname} ${result.teacher_lname}`
      : 'Assigned Teacher',
    total_score: Number(result.total_score),
    assessments: assessmentsByResult.get(result.result_id) || [],
  })).filter((result) => result.course_name && result.assessments.length > 0);
}

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

    const visibleResults = await getVisibleCourseResults(studentInfo[0].id);
    const dashboardCourseResults = visibleResults.map((cr) => ({
      course_name: cr.course_name,
      course_code: cr.course_code || '',
      class_name: cr.class_name,
      semester: cr.semester_id,
      academic_year: cr.academic_year,
      teacher_name: cr.teacher_name,
      categories: cr.assessments.map((assessment) => ({
        category_name: assessment.assessment_name,
        score: assessment.score,
      })),
      total_weighted: cr.total_score,
    }));

    const courses = dashboardCourseResults;

    const resultTotal = visibleResults.reduce((total, result) => total + result.total_score, 0);
    const resultAverage = visibleResults.length > 0 ? resultTotal / visibleResults.length : 0;
    const stats = [{
      average_score: visibleResults.length > 0 ? resultAverage : null,
      approved_count: visibleResults.length,
      total_score: resultTotal,
    }];

    const semesterStats = Array.from(
      visibleResults.reduce((groups, result) => {
        const key = `${result.academic_year}:${result.semester_id}`;
        const group = groups.get(key) || {
          academic_year: result.academic_year,
          semester: result.semester_id,
          total: 0,
          count: 0,
        };
        group.total += result.total_score;
        group.count += 1;
        groups.set(key, group);
        return groups;
      }, new Map()).values()
    ).map((group) => ({
      academic_year: group.academic_year,
      semester: group.semester,
      semester_avg: group.total / group.count,
    }));

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

    const [enrolledCourses] = await pool.execute(`
      SELECT DISTINCT c.id AS course_id, c.course_name, c.course_code,
             CONCAT(u.first_name, ' ', u.last_name) AS teacher_name
      FROM enrollments e
      JOIN courses c ON c.id = e.course_id
      LEFT JOIN teacher_course_assignments tca
        ON tca.course_id = c.id AND tca.class_id = ? AND tca.status = 'active'
      LEFT JOIN class_schedule cs
        ON cs.course_id = c.id AND cs.class_id = ?
      LEFT JOIN teachers t ON t.id = COALESCE(tca.teacher_id, cs.teacher_id, c.teacher_id)
      LEFT JOIN users u ON u.id = t.user_id
      WHERE e.student_id = ? AND e.status IN ('enrolled', 'completed')
      ORDER BY c.course_name
    `, [classIdForSchedule || null, classIdForSchedule || null, studentInfo[0].id]);
    const dashboardCourseMap = new Map(
      enrolledCourses.map((course) => [course.course_id, { ...course, is_enrolled: true }])
    );
    for (const result of visibleResults) {
      if (result.resolved_course_id && result.course_name && !dashboardCourseMap.has(result.resolved_course_id)) {
        dashboardCourseMap.set(result.resolved_course_id, {
          course_id: result.resolved_course_id,
          course_name: result.course_name,
          course_code: result.course_code,
          teacher_name: result.teacher_name,
          is_enrolled: false,
        });
      }
    }
    const dashboardCourses = Array.from(dashboardCourseMap.values())
      .sort((left, right) => left.course_name.localeCompare(right.course_name));

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
      courses_count: dashboardCourses.length,
      courses,
      dashboardCourses,
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
      SELECT id, class_id, grade_level, section FROM students WHERE user_id = ?
    `, [req.session.user.id]);
    if (!studentInfo[0]) {
      return res.status(404).render('500-modern', { title: 'Student Not Found' });
    }
    let courseClassId = studentInfo[0].class_id;
    if (!courseClassId && studentInfo[0].grade_level && studentInfo[0].section) {
      const [classes] = await pool.execute(
        'SELECT id FROM classes WHERE CAST(grade AS CHAR) = CAST(? AS CHAR) AND section = ? LIMIT 1',
        [studentInfo[0].grade_level, studentInfo[0].section]
      );
      if (classes.length > 0) courseClassId = classes[0].id;
    }

    // Show active/completed enrollments and only this student's saved course results.
    const [courses] = await pool.execute(`
      SELECT c.*, e.enrollment_date, e.grade, e.status,
             t.first_name as teacher_fname, t.last_name as teacher_lname,
             (SELECT scr.total_score
              FROM student_course_results scr
              JOIN grading_structures gs
                ON gs.id = scr.assessment_structure_id
                AND gs.teacher_id = scr.teacher_id
                AND gs.class_id = scr.class_id
                AND gs.course_id = scr.course_id
              WHERE scr.course_id = c.id AND scr.student_id = ?
                AND scr.status IN ('approved', 'saved')
                AND scr.class_id = ?
              ORDER BY scr.academic_year DESC, scr.semester_id DESC LIMIT 1) as average_grade
      FROM courses c
      JOIN enrollments e ON c.id = e.course_id
      JOIN students s ON s.id = e.student_id
      LEFT JOIN teacher_course_assignments tca
        ON tca.course_id = c.id AND tca.class_id = ? AND tca.status = 'active'
      LEFT JOIN teachers t ON t.id = COALESCE(tca.teacher_id, c.teacher_id)
      WHERE e.student_id = ? AND e.status IN ('enrolled', 'completed')
      ORDER BY c.course_name
    `, [studentInfo[0].id, courseClassId, courseClassId, studentInfo[0].id]);

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
      SELECT s.id, s.student_id as student_code, s.grade_level, s.section,
             u.first_name, u.last_name,
             c.id as class_id, c.name as class_name, c.grade as class_grade, c.section as class_section,
             assigned_user.first_name as attendance_teacher_first_name,
             assigned_user.last_name as attendance_teacher_last_name
      FROM students s
      JOIN users u ON s.user_id = u.id
      LEFT JOIN classes c ON (s.class_id = c.id OR (s.grade_level = c.grade AND s.section = c.section))
      LEFT JOIN teachers assigned_teacher ON c.attendance_teacher_id = assigned_teacher.id
      LEFT JOIN users assigned_user ON assigned_teacher.user_id = assigned_user.id
      WHERE s.user_id = ?
      LIMIT 1
    `, [req.session.user.id]);

    if (!studentInfo || studentInfo.length === 0) {
      return res.status(404).render('404-modern', { title: 'Student Profile Not Found' });
    }
    const student = studentInfo[0];

    const { date, start_date, end_date } = req.query;
    let query = `
      SELECT a.*, c.name as class_name, c.grade as class_grade, c.section as class_section,
             tu.first_name as teacher_fname, tu.last_name as teacher_lname
      FROM attendance a
      JOIN classes c ON a.class_id = c.id
      LEFT JOIN teachers t ON COALESCE(a.teacher_id, a.created_by) = t.id
      LEFT JOIN users tu ON t.user_id = tu.id
      WHERE a.student_id = ?
        AND (a.course_id IS NULL OR a.course_id = 0)
    `;
    const params = [student.id];

    // Date range filtering
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
    query += ` ORDER BY a.date DESC, a.id DESC`;

    const [rawAttendance] = await pool.execute(query, params);

    // Deduplicate same-day records and calculate counts
    const seenDates = new Set();
    const validRecords = [];
    let presentCount = 0;
    let absentCount = 0;
    let lateCount = 0;
    let excusedCount = 0;

    for (const row of rawAttendance) {
      if (row.course_id && row.course_id !== 0) continue;

      const dateStr = row.date instanceof Date
        ? row.date.toISOString().split('T')[0]
        : (row.date ? String(row.date).split('T')[0] : `no-date-${row.id}`);

      if (seenDates.has(dateStr)) continue;
      seenDates.add(dateStr);

      validRecords.push(row);

      const st = (row.status || '').toLowerCase();
      if (st === 'present') presentCount++;
      else if (st === 'absent') absentCount++;
      else if (st === 'late') lateCount++;
      else if (st === 'excused') excusedCount++;
    }

    // Present + Absent + Late equals total valid records for the 3 statuses
    const validTotal = presentCount + absentCount + lateCount;
    const rate = validTotal > 0 ? Math.round(((presentCount + lateCount) / validTotal) * 100) : 100;

    const stats = {
      present: presentCount,
      absent: absentCount,
      late: lateCount,
      excused: excusedCount,
      total: validTotal,
      percentage: String(rate),
      rate: String(rate)
    };

    const studentRow = {
      student_id: student.student_code || student.id,
      student_name: `${student.first_name || ''} ${student.last_name || ''}`.trim() || 'Student',
      class_name: student.class_name || (student.class_id ? `Class #${student.class_id}` : `Grade ${student.grade_level || ''} Sec ${student.section || ''}`),
      class_grade: student.class_grade || student.grade_level,
      class_section: student.class_section || student.section,
      attendance_teacher_name: (student.attendance_teacher_first_name && student.attendance_teacher_last_name)
        ? `${student.attendance_teacher_first_name} ${student.attendance_teacher_last_name}`
        : 'Assigned Teacher',
      present_count: presentCount,
      absent_count: absentCount,
      late_count: lateCount,
      total_count: validTotal,
      rate: rate
    };

    const activeStartDate = start_date || (date && !end_date ? date : '');
    const activeEndDate = end_date || (date && !start_date ? date : '');

    res.render('student/attendance', {
      title: 'My Attendance',
      user: req.session.user,
      student: studentRow,
      attendance: validRecords,
      stats,
      filters: {
        date: date || '',
        start_date: activeStartDate,
        end_date: activeEndDate
      }
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
      'SELECT id FROM students WHERE user_id = ?',
      [req.session.user.id]
    );
    if (!studentInfo[0]) return res.status(404).json({ error: 'Student not found' });
    const studentId = studentInfo[0].id;

    const { academicYear: activeYear, semesterLabel: activeSemSetting } = await getAcademicContext();
    const courseResults = await getVisibleCourseResults(studentId, activeYear, activeSemSetting);

    const coursesJson = courseResults.map((result) => {
      const final_score = result.total_score;
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

      return {
        course_name: result.course_name,
        teacher_name: result.teacher_name,
        assessments: result.assessments,
        student_mark: result.assessments.reduce((total, assessment) => total + assessment.score, 0),
        final_score,
        grade
      };
    });

    res.json({
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
      'SELECT id, class_id, grade_level, section FROM students WHERE user_id = ?',
      [req.session.user.id]
    );
    if (!studentInfo[0]) return res.status(404).render('500-modern', { title: 'Not Found' });
    const studentId = studentInfo[0].id;

    const { academicYear: activeYear, semesterLabel: activeSemSetting } = await getAcademicContext();

    const visibleResults = await getVisibleCourseResults(studentId);
    const courseList = visibleResults.map((result) => ({
      course_name: result.course_name,
      course_code: result.course_code,
      class_name: result.class_name,
      semester: result.semester_id,
      academic_year: result.academic_year,
      teacher_name: result.teacher_name,
      assessments: result.assessments,
      total_weighted: result.total_score,
    }));

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
