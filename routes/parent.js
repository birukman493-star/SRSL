const express = require('express');
const { pool } = require('../config/db');
const {
  getSetting,
  getAcademicContext,
  DEFAULT_ACADEMIC_YEAR,
  ATTENDANCE_COURSE_NAME_SQL,
} = require('../config/systemSettings');
const router = express.Router();

// Middleware to check if user is parent
function isParent(req, res, next) {
  if (!req.session.user || req.session.user.role !== 'parent') {
    return res.redirect('/auth/login');
  }
  next();
}

// Apply parent middleware to all routes
router.use(isParent);

// GET /parent/dashboard - Parent dashboard
router.get('/dashboard', async (req, res) => {
  try {
    const userId = req.session.user.id;
    
    // Get parent information
    const [parentData] = await pool.execute(`
      SELECT p.id, p.*, u.username, u.email, u.first_name, u.last_name
      FROM parents p
      JOIN users u ON p.user_id = u.id
      WHERE p.user_id = ?
    `, [userId]);

    if (parentData.length === 0) {
      return res.redirect('/auth/logout');
    }
    const parent = parentData[0];
    
    // Get children via relations table
    const [children] = await pool.execute(`
      SELECT s.*, u.email as student_email
      FROM students s
      JOIN users u ON s.user_id = u.id
      JOIN parent_student_relations psr ON s.id = psr.student_id
      WHERE psr.parent_id = ?
      ORDER BY s.last_name, s.first_name
    `, [parent.id]);
    
    // Get child-specific stats using ONLY approved_results view (Single Source of Truth)
    let totalAttended = 0;
    let totalAttendanceRecords = 0;
    
    for (let child of children) {
      const [childStats] = await pool.execute(`
        SELECT 
          AVG(scr.total_score) as average_score,
          SUM(scr.total_score) as total_score
        FROM approved_results scr
        WHERE scr.student_id = ?
      `, [child.id]);
      
      // Fetch semester stats for this child
      const [childSemesterStats] = await pool.execute(`
        SELECT 
          scr.academic_year, 
          scr.semester_id as semester, 
          AVG(scr.total_score) as semester_avg
        FROM approved_results scr
        WHERE scr.student_id = ?
        GROUP BY scr.academic_year, scr.semester_id
        ORDER BY scr.academic_year DESC, scr.semester_id DESC
      `, [child.id]);
      
      // Calculate Class Rank per class_id + academic_year (competition ranking)
      // Resolve class_id for this child
      let childClassId = child.class_id || null;
      if (!childClassId && child.grade_level && child.section) {
        const [childCls] = await pool.execute(
          'SELECT id FROM classes WHERE CAST(grade AS CHAR) = CAST(? AS CHAR) AND section = ? LIMIT 1',
          [child.grade_level, child.section]
        );
        if (childCls.length > 0) childClassId = childCls[0].id;
      }
      const activeYearForChild = (await getAcademicContext()).academicYear;
      const activeSemForChild = (await getAcademicContext()).semester;
      let childRankData = [{ child_rank: 'N/A' }];
      if (childClassId) {
        const childAvg = childStats[0].average_score ? parseFloat(childStats[0].average_score) : 0;
        const [childRankRows] = await pool.execute(`
        SELECT COUNT(*) + 1 as child_rank
        FROM (
          SELECT scr2.student_id, AVG(scr2.total_score) as avg_score
          FROM approved_results scr2
          WHERE scr2.class_id = ?
            AND (? = '' OR scr2.academic_year = ?)
            AND (? = '' OR scr2.semester_id = ?)
          GROUP BY scr2.student_id
        ) as class_ranks
        WHERE avg_score > ?
      `, [childClassId, activeYearForChild, activeYearForChild, activeSemForChild, activeSemForChild, childAvg]);
        childRankData = childRankRows;
      }

      const [totalInClass] = await pool.execute(`
        SELECT COUNT(*) as total 
        FROM students 
        WHERE grade_level = ? AND section = ?
      `, [child.grade_level, child.section]);

      // Compute attendance rate for the parent dashboard child card
      const [childAttendance] = await pool.execute(`
        SELECT 
          SUM(CASE WHEN status IN ('present', 'late', 'excused') THEN 1 ELSE 0 END) as attended,
          COUNT(*) as total
        FROM attendance
        WHERE student_id = ? AND approval_status = 'approved'
      `, [child.id]);
      const attTotal = childAttendance[0].total || 0;
      const attAttended = childAttendance[0].attended || 0;
      totalAttended += attAttended;
      totalAttendanceRecords += attTotal;
      child.attendance_rate = attTotal > 0 ? ((attAttended / attTotal) * 100).toFixed(1) : '100.0';
      
      child.gpa = childStats[0].average_score ? (parseFloat(childStats[0].average_score) / 25).toFixed(2) : '0.00'; 
      child.average_score = childStats[0].average_score ? parseFloat(childStats[0].average_score).toFixed(1) : '0.0';
      child.total_score = childStats[0].total_score || 0;
      child.semester_stats = childSemesterStats;
      child.rank = (childRankData[0] && childRankData[0].child_rank) || 'N/A';
      child.total_in_class = totalInClass[0].total;
    }

    const [statsData] = await pool.execute(`
      SELECT 
        AVG(scr.total_score) as avg_grade,
        SUM(scr.total_score) as total_score,
        COUNT(*) as approved_count
      FROM approved_results scr
      JOIN parent_student_relations psr ON scr.student_id = psr.student_id
      WHERE psr.parent_id = ?
    `, [parent.id]);

    const [achievementsData] = await pool.execute(`
      SELECT COUNT(*) as count
      FROM approved_results scr
      JOIN parent_student_relations psr ON scr.student_id = psr.student_id
      WHERE psr.parent_id = ? AND scr.total_score >= 90
    `, [parent.id]);

    const [successData] = await pool.execute(`
      SELECT 
        COUNT(*) as total_courses,
        SUM(CASE WHEN scr.total_score >= 50 THEN 1 ELSE 0 END) as passed_courses
      FROM approved_results scr
      JOIN parent_student_relations psr ON scr.student_id = psr.student_id
      WHERE psr.parent_id = ?
    `, [parent.id]);

    const totalCourses = successData[0].total_courses || 0;
    const passedCourses = successData[0].passed_courses || 0;
    const overallSuccessRate = totalCourses > 0
      ? Math.round((passedCourses / totalCourses) * 100) + '%'
      : '100%';

    const overallAttendanceRate = totalAttendanceRecords > 0 
      ? ((totalAttended / totalAttendanceRecords) * 100).toFixed(1) + '%'
      : '100.0%';

    const stats = {
      averageGrade: statsData[0].avg_grade ? Math.round(parseFloat(statsData[0].avg_grade)) + '%' : 'N/A',
      cgpa: statsData[0].avg_grade ? (parseFloat(statsData[0].avg_grade) / 25).toFixed(2) : '0.00',
      totalScore: statsData[0].total_score || 0,
      maxTotal: (statsData[0].approved_count || 0) * 100,
      achievements: achievementsData[0].count || 0,
      overallSuccessRate,
      overallAttendanceRate
    };
    
    // Get recent activities
    const [announcements] = await pool.execute(`
      SELECT 'announcement' as type, title, 
             DATE_FORMAT(created_at, '%Y-%m-%d') as date
      FROM announcements
      WHERE audience IN ('all', 'students')
      UNION ALL
      SELECT 'grade' as type, CONCAT(s.first_name, ' ', s.last_name, ' - New grade: ', ac.name) as title,
             DATE_FORMAT(sr.grade_date, '%Y-%m-%d') as date
      FROM student_results sr
      JOIN assessment_categories ac ON sr.category_id = ac.id
      JOIN students s ON sr.student_id = s.id
      JOIN parent_student_relations psr ON s.id = psr.student_id
      WHERE psr.parent_id = ? AND sr.status = 'approved'
      ORDER BY date DESC
      LIMIT 5
    `, [parent.id]);
    
    res.render('parent/dashboard-new', {
      title: 'Parent Dashboard',
      user: req.session.user,
      parent: parent,
      children: children,
      stats: stats,
      announcements: announcements
    });
    
  } catch (error) {
    console.error('Parent dashboard error:', error);
    res.status(500).render('500-modern', { title: 'Server Error' });
  }
});

// GET /parent/children - View children's information
router.get('/children', async (req, res) => {
  try {
    const userId = req.session.user.id;
    
    const [parentData] = await pool.execute('SELECT id FROM parents WHERE user_id = ?', [userId]);
    if (parentData.length === 0) return res.redirect('/parent/dashboard');

    const [children] = await pool.execute(`
      SELECT s.*, u.email as student_email,
             (SELECT COUNT(*) FROM student_course_results WHERE student_id = s.id AND status = 'approved') as grade_count,
             (SELECT ROUND(AVG(scr.total_score), 1) 
              FROM student_course_results scr 
              WHERE scr.student_id = s.id AND scr.status = 'approved') as average_grade
      FROM students s
      JOIN users u ON s.user_id = u.id
      JOIN parent_student_relations psr ON s.id = psr.student_id
      WHERE psr.parent_id = ?
      ORDER BY s.last_name, s.first_name
    `, [parentData[0].id]);
    
    for (let child of children) {
      const [attendance] = await pool.execute(`
        SELECT \
               COUNT(DISTINCT CASE WHEN status = 'present' THEN date END) as present,
               COUNT(DISTINCT CASE WHEN status = 'absent' THEN date END) as absent,
               COUNT(DISTINCT CASE WHEN status = 'late' THEN date END) as late,
               COUNT(DISTINCT CASE WHEN status IN ('present', 'absent', 'late') THEN date END) as total
        FROM attendance 
        WHERE student_id = ? AND (course_id IS NULL OR course_id = 0)
      `, [child.id]);
      
      const present = parseInt(attendance[0].present || 0, 10);
      const absent = parseInt(attendance[0].absent || 0, 10);
      const late = parseInt(attendance[0].late || 0, 10);
      const total = present + absent + late;
      child.present = present;
      child.absent = absent;
      child.late = late;
      child.total_attendance = total;
      child.attendance_rate = total > 0 ? (((present + late) / total) * 100).toFixed(1) : '100.0';

      // Calculate class rank for this child (competition ranking)
      const [childAvgRows] = await pool.execute(`
        SELECT ROUND(AVG(total_score), 2) as avg_score
        FROM approved_results
        WHERE student_id = ?
      `, [child.id]);
      const childAvgScore = (childAvgRows[0] && childAvgRows[0].avg_score) ? parseFloat(childAvgRows[0].avg_score) : 0;

      let childClassId = child.class_id || null;
      if (!childClassId && child.grade_level && child.section) {
        const [clsRows] = await pool.execute(
          'SELECT id FROM classes WHERE CAST(grade AS CHAR) = CAST(? AS CHAR) AND section = ? LIMIT 1',
          [child.grade_level, child.section]
        );
        if (clsRows.length > 0) childClassId = clsRows[0].id;
      }

      const { academicYear: activeYearForChild } = await getAcademicContext();

      if (childClassId) {
        const [childRankRows] = await pool.execute(`
          SELECT COUNT(*) + 1 as child_rank
          FROM (
            SELECT scr2.student_id, AVG(scr2.total_score) as avg_score
            FROM approved_results scr2
            WHERE scr2.class_id = ?
              AND (? = '' OR scr2.academic_year = ?)
            GROUP BY scr2.student_id
          ) as class_ranks
          WHERE avg_score > ?
        `, [childClassId, activeYearForChild, activeYearForChild, childAvgScore]);
        child.rank = (childRankRows[0] && childRankRows[0].child_rank) || 'N/A';
      } else {
        child.rank = 'N/A';
      }

      const [totalInClass] = await pool.execute(`
        SELECT COUNT(*) as total
        FROM students
        WHERE grade_level = ? AND section = ?
      `, [child.grade_level, child.section]);
      child.total_in_class = (totalInClass[0] && totalInClass[0].total) || 0;
      child.rank_display = (child.rank !== 'N/A' && child.total_in_class > 0)
        ? `${child.rank} out of ${child.total_in_class} students`
        : 'N/A';
    }

    res.render('parent/children', {
      title: 'My Children',
      user: req.session.user,
      children: children
    });
    
  } catch (error) {
    console.error('Parent children error:', error);
    res.status(500).render('500-modern', { title: 'Server Error' });
  }
});

// Fallback routes for direct sidebar access
router.get('/grades', (req, res) => res.redirect('/parent/children'));
router.get('/attendance', (req, res) => res.redirect('/parent/children'));

// GET /parent/grades/:studentId - View specific child's grades
router.get('/grades/:studentId', async (req, res) => {
  try {
    const userId = req.session.user.id;
    const studentId = req.params.studentId;
    
    const [parentData] = await pool.execute('SELECT id FROM parents WHERE user_id = ?', [userId]);
    if (parentData.length === 0) return res.redirect('/parent/dashboard');

    // Verify relation
    const [relation] = await pool.execute(`
      SELECT s.* 
      FROM students s
      JOIN parent_student_relations psr ON s.id = psr.student_id
      WHERE psr.parent_id = ? AND s.id = ?
    `, [parentData[0].id, studentId]);
    
    if (relation.length === 0) {
      return res.status(403).render('404-modern', { title: 'Access Denied' });
    }
    
    // Fetch approved courses from approved_results (course_rank removed — rank is now per final average)
    const [courseResults] = await pool.execute(`
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
    `, [studentId]);

    const { academicYear: activeYear, semesterLabel: activeSemSetting } = await getAcademicContext();

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

    res.render('parent/student-grades', {
      title: relation[0].first_name + ' ' + relation[0].last_name + "'s Grades",
      user: req.session.user,
      student: relation[0],
      currentSemesterResults,
      previousSemesterResults,
      currentAvg: currentAvg.toFixed(1),
      currentSum: currentSum.toFixed(1),
      previousAvg: previousAvg.toFixed(1),
      previousSum: previousSum.toFixed(1),
      overallAvg: overallAvg.toFixed(1),
      overallSum: overallSum.toFixed(1),
      attendance_rate,
      courseResults: courseList,
      hasResults: courseList.length > 0
    });
    
  } catch (error) {
    console.error('Parent grades error:', error);
    res.status(500).render('500-modern', { title: 'Server Error' });
  }
});

// GET /parent/attendance/:studentId - View child's attendance
router.get('/attendance/:studentId', async (req, res) => {
  try {
    const userId = req.session.user.id;
    const studentId = req.params.studentId;
    
    const [parentData] = await pool.execute('SELECT id FROM parents WHERE user_id = ?', [userId]);
    if (parentData.length === 0) return res.redirect('/parent/dashboard');

    const [relation] = await pool.execute(`
      SELECT s.*, s.student_id as student_code, u.first_name, u.last_name,
             c.id as class_id, c.name as class_name, c.grade as class_grade, c.section as class_section,
             assigned_user.first_name as attendance_teacher_first_name,
             assigned_user.last_name as attendance_teacher_last_name
      FROM students s
      JOIN users u ON s.user_id = u.id
      JOIN parent_student_relations psr ON s.id = psr.student_id
      LEFT JOIN classes c ON (s.class_id = c.id OR (s.grade_level = c.grade AND s.section = c.section))
      LEFT JOIN teachers assigned_teacher ON c.attendance_teacher_id = assigned_teacher.id
      LEFT JOIN users assigned_user ON assigned_teacher.user_id = assigned_user.id
      WHERE psr.parent_id = ? AND s.id = ?
      LIMIT 1
    `, [parentData[0].id, studentId]);
    
    if (relation.length === 0) {
      return res.status(403).render('404-modern', { title: 'Access Denied' });
    }
    const student = relation[0];
    
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
    const params = [studentId];
    
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
      rate: rate
    };

    const studentRow = {
      ...student,
      student_id: student.student_code || student.student_id || student.id,
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

    res.render('parent/student-attendance', {
      title: `${student.first_name}'s Attendance`,
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
    console.error('Parent attendance error:', error);
    res.status(500).render('500-modern', { title: 'Server Error', message: error.message });
  }
});


// GET /parent/announcements - View school announcements
router.get('/announcements', async (req, res) => {
  try {
    const [announcements] = await pool.execute(`
      SELECT a.*, u.username as author_name
      FROM announcements a
      LEFT JOIN users u ON a.created_by = u.id
      WHERE a.audience IN ('all', 'students')
      ORDER BY a.created_at DESC
    `);
    
    res.render('parent/announcements', {
      title: 'School Announcements',
      user: req.session.user,
      announcements: announcements
    });
  } catch (error) {
    console.error('Parent announcements error:', error);
    res.status(500).render('500-modern', { title: 'Server Error' });
  }
});

// GET /parent/profile - View/Edit parent profile
router.get('/profile', async (req, res) => {
  try {
    const userId = req.session.user.id;
    const [parentData] = await pool.execute(`
      SELECT p.*, u.username, u.email, u.first_name, u.last_name, u.phone
      FROM parents p
      JOIN users u ON p.user_id = u.id
      WHERE p.user_id = ?
    `, [userId]);

    if (parentData.length === 0) return res.redirect('/parent/dashboard');

    res.render('parent/profile', {
      title: 'My Profile',
      user: req.session.user,
      parent: parentData[0],
      error: req.session.flash ? req.session.flash.error : null,
      success: req.session.flash ? req.session.flash.success : null
    });
    if (req.session.flash) delete req.session.flash;
  } catch (error) {
    console.error('Parent profile error:', error);
    res.status(500).render('500-modern', { title: 'Server Error' });
  }
});

// POST /parent/profile/update - Update parent profile
router.post('/profile/update', async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { first_name, last_name, phone, occupation, relationship, address } = req.body;

    // Update users table
    await pool.execute(
      'UPDATE users SET first_name = ?, last_name = ?, phone = ? WHERE id = ?',
      [first_name, last_name, phone, userId]
    );

    // Update parents table
    await pool.execute(
      'UPDATE parents SET occupation = ?, relationship = ?, address = ? WHERE user_id = ?',
      [occupation, relationship, address, userId]
    );

    req.session.flash = { success: 'Profile updated successfully!' };
    res.redirect('/parent/profile');
  } catch (error) {
    console.error('Parent profile update error:', error);
    req.session.flash = { error: 'Failed to update profile.' };
    res.redirect('/parent/profile');
  }
});

module.exports = router;
