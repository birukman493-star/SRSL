const express = require('express');
const { pool } = require('../config/db');
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

    // Get enrolled courses with teacher details
    const [courses] = await pool.execute(`
      SELECT c.*, e.enrollment_date, e.grade, e.status, t.first_name as teacher_fname, t.last_name as teacher_lname
      FROM courses c
      JOIN enrollments e ON c.id = e.course_id
      LEFT JOIN teachers t ON c.teacher_id = t.id
      WHERE e.student_id = ? AND e.status = 'enrolled'
      ORDER BY c.course_name
    `, [studentInfo[0].id]);

    // Calculate Average Grade from all approved grades
    const [allGrades] = await pool.execute(`
      SELECT score, max_score FROM grades WHERE student_id = ? AND status = 'approved'
    `, [studentInfo[0].id]);

    let average_grade = 'N/A';
    let overall_progress = 0;

    if (allGrades.length > 0) {
      let totalScore = 0;
      let totalMax = 0;
      allGrades.forEach(g => {
        totalScore += parseFloat(g.score);
        totalMax += parseFloat(g.max_score);
      });
      if (totalMax > 0) {
        const avg = (totalScore / totalMax) * 100;
        average_grade = avg.toFixed(1) + '%';
        overall_progress = avg.toFixed(1);
      }
    }

    let overall_progress_text = overall_progress ? `${overall_progress}% Complete` : 'No grades yet';

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

    // Attendance rate
    const [attendance] = await pool.execute(`
       SELECT 
         SUM(CASE WHEN status IN ('present', 'late', 'excused') THEN 1 ELSE 0 END) as present_count,
         COUNT(*) as total_count
       FROM attendance
       WHERE student_id = ?
    `, [studentInfo[0].id]);

    let attendance_rate = '100';
    if (attendance[0].total_count > 0) {
      attendance_rate = ((attendance[0].present_count / attendance[0].total_count) * 100).toFixed(1);
    }

    // Pre-render courses HTML
    let courses_html = '';
    if (courses.length > 0) {
      courses.slice(0, 5).forEach(course => {
        const teacherName = (course.teacher_fname && course.teacher_lname) ? `${course.teacher_fname} ${course.teacher_lname}` : 'Assigned Teacher';
        courses_html += `
            <li class="course-item">
                <div class="course-icon">
                    <i class="fas fa-book"></i>
                </div>
                <div class="course-info">
                    <div class="course-name">${course.course_name}</div>
                    <div class="course-details">
                        ${teacherName} • ${course.credits || '3'} credits
                    </div>
                </div>
            </li>`;
      });
    } else {
      courses_html = `
            <li class="course-item">
                <div class="course-info" style="text-align: center; color: #6c757d; width: 100%;">
                    No courses enrolled yet
                </div>
            </li>`;
    }

    // Calculate Statistics
    const [stats] = await pool.execute(`
      SELECT 
        SUM(score) as total_score,
        SUM(max_score) as total_max,
        AVG(score/max_score * 100) as avg_perc,
        AVG(score/max_score * 4.0) as cgpa
      FROM grades
      WHERE student_id = ? AND status = 'approved'
    `, [studentInfo[0].id]);

    const [semesterStats] = await pool.execute(`
      SELECT 
        c.academic_year, 
        c.semester, 
        AVG(g.score/g.max_score * 4.0) as semester_gpa
      FROM grades g
      JOIN classes c ON g.class_id = c.id
      WHERE g.student_id = ? AND g.status = 'approved'
      GROUP BY c.academic_year, c.semester
      ORDER BY c.academic_year DESC, c.semester DESC
    `, [studentInfo[0].id]);

    const cgpa = stats[0].cgpa || 0;
    const total_score = stats[0].total_score || 0;
    const total_max = stats[0].total_max || 1; // avoid divide by zero
    const avg_perc = stats[0].avg_perc || 0;

    // Calculate Class Rank
    const [rankData] = await pool.execute(`
      SELECT COUNT(*) + 1 as rank
      FROM (
        SELECT s.id, AVG(g.score/g.max_score) as avg_score
        FROM students s
        JOIN grades g ON s.id = g.student_id
        WHERE s.grade_level = ? AND s.section = ? AND g.status = 'approved'
        GROUP BY s.id
      ) as class_ranks
      WHERE avg_score > ?
    `, [studentInfo[0].grade_level, studentInfo[0].section, avg_perc / 100]);

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

    const attendanceData = {
      percentage: attendance_rate,
      sessions: (attendance[0] && attendance[0].present_count) || 0
    };

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
      cgpa: parseFloat(cgpa).toFixed(2),
      total_score: parseFloat(total_score).toFixed(1),
      total_max: total_max,
      average_grade: Math.round(avg_perc) + '%',
      overall_progress: Math.round(avg_perc),
      overall_progress_text: `${Math.round(avg_perc)}% Academic Progress`,
      semester_stats: semesterStats,
      rank: rankData[0].rank,
      total_in_class: totalStudents[0].total,
      pending_tasks: pending_tasks,
      isRegistrationOpen,
      courses_html,
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
             (SELECT AVG(g.score/g.max_score * 100) 
              FROM grades g 
              WHERE g.course_id = c.id AND g.student_id = ? AND g.status = 'approved') as average_grade
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

    const [attendance] = await pool.execute(`
      SELECT a.*, c.name as class_name
      FROM attendance a
      JOIN classes c ON a.class_id = c.id
      WHERE a.student_id = ?
      ORDER BY a.date DESC
    `, [studentInfo[0].id]);

    // Calculate stats
    const stats = {
      present: attendance.filter(a => a.status === 'present').length,
      absent: attendance.filter(a => a.status === 'absent').length,
      late: attendance.filter(a => a.status === 'late').length,
      excused: attendance.filter(a => a.status === 'excused').length,
      total: attendance.length
    };

    // Consistent rate calculation: present, late, and excused count as attended
    const attendedCount = stats.present + stats.late + stats.excused;
    stats.percentage = stats.total > 0 ? ((attendedCount / stats.total) * 100).toFixed(1) : '100';

    res.render('student/attendance', {
      title: 'My Attendance',
      user: req.session.user,
      attendance,
      stats
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

// GET /student/grades - Student grades
router.get('/grades', async (req, res) => {
  try {
    const [studentInfo] = await pool.execute(`
      SELECT id FROM students WHERE user_id = ?
    `, [req.session.user.id]);

    // Get grades grouped by class
    const [grades] = await pool.execute(`
      SELECT g.*, c.name as class_name
      FROM grades g
      JOIN classes c ON g.class_id = c.id
      WHERE g.student_id = ? AND g.status = 'approved'
      ORDER BY c.name, g.grade_date DESC
    `, [studentInfo[0].id]);

    // Group grades by class name
    const groupedGrades = {};
    grades.forEach(g => {
      if (!groupedGrades[g.class_name]) {
        groupedGrades[g.class_name] = {
          items: []
        };
      }
      groupedGrades[g.class_name].items.push(g);
    });

    let grades_html = '';
    if (grades.length > 0) {
      grades_html += `
        <div class="premium-panel">
            <div class="d-flex justify-content-between align-items-center mb-4">
                <h4 class="fw-bold text-dark m-0"><i class="fas fa-file-invoice me-2 text-primary"></i>Complete Academic Transcript</h4>
                <span class="badge bg-primary bg-opacity-10 text-primary px-3 py-2 rounded-pill fw-bold" style="font-size: 0.7rem;">TOTAL RECORDS: ${grades.length}</span>
            </div>
            <div class="table-responsive">
                <table class="table table-hover align-middle mb-0">
                    <thead style="background: #f8fafc">
                        <tr class="text-secondary small fw-bold" style="text-transform: uppercase; letter-spacing: 1px;">
                            <th class="border-0 py-3">Course / Subject</th>
                            <th class="border-0 py-3">Assessment Title</th>
                            <th class="border-0 text-center py-3">Mid (30)</th>
                            <th class="border-0 text-center py-3">Test (10)</th>
                            <th class="border-0 text-center py-3">Att (10)</th>
                            <th class="border-0 text-center py-3">Final (50)</th>
                            <th class="border-0 text-center py-3">Total (100)</th>
                            <th class="border-0 text-end py-3">Date</th>
                        </tr>
                    </thead>
                    <tbody>`;

      grades.forEach(item => {
        const totalScore = parseFloat(item.score).toFixed(1);
        const perc = (item.score / item.max_score) * 100;
        let colorClass = 'text-danger';
        if (perc >= 80) colorClass = 'text-success';
        else if (perc >= 60) colorClass = 'text-warning';

        grades_html += `
                <tr>
                    <td class="border-0 py-3">
                        <div class="fw-bold text-dark">${item.class_name}</div>
                    </td>
                    <td class="border-0 py-3">
                        <div class="fw-medium text-dark">${item.title}</div>
                        <small class="text-secondary" style="font-size: 0.7rem; font-weight: 600;">${item.assessment_type.toUpperCase()}</small>
                    </td>
                    <td class="border-0 text-center text-dark fw-bold">${item.mid_score || 0}</td>
                    <td class="border-0 text-center text-dark fw-bold">${item.test_score || 0}</td>
                    <td class="border-0 text-center text-dark fw-bold">${item.attendance_score || 0}</td>
                    <td class="border-0 text-center text-dark fw-bold">${item.final_score || 0}</td>
                    <td class="border-0 text-center">
                        <span class="${colorClass} fw-bold h6 m-0">${totalScore}</span>
                    </td>
                    <td class="border-0 text-end text-secondary small fw-bold">
                        ${new Date(item.grade_date).toLocaleDateString()}
                    </td>
                </tr>`;
      });

      grades_html += `
                    </tbody>
                </table>
            </div>
        </div>`;
    } else {
      grades_html = '<div class="premium-panel text-center py-5"><div class="text-secondary opacity-30 mb-3"><i class="fas fa-file-invoice fa-4x"></i></div><h4 class="text-dark fw-bold">No grades found</h4><p class="text-secondary fw-medium">You haven\'t received any academic results yet.</p></div>';
    }

    res.render('student/grades', {
      title: 'My Grades',
      user: req.session.user,
      grades_html: grades_html
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
      SELECT m.*, c.name as class_name, t.first_name as teacher_fname, t.last_name as teacher_lname
      FROM materials m
      JOIN classes c ON m.class_id = c.id
      JOIN class_students cs ON c.id = cs.class_id
      LEFT JOIN teachers t ON m.teacher_id = t.id
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

    // Try to safely alter the ENUM to include 'submitted' if it doesn't already
    try {
      await pool.execute("ALTER TABLE students MODIFY COLUMN registration_status ENUM('not_started', 'pending', 'submitted', 'registered') DEFAULT 'not_started'");
    } catch (e) {
      console.log("Could not alter students table enum silently, moving on.");
    }

    await pool.execute(
      "UPDATE students SET registration_status = 'submitted' WHERE user_id = ?",
      [studentUserId]
    );

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

module.exports = router;
