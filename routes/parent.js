const express = require('express');
const { pool } = require('../config/db');
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
    
    // Get child-specific stats
    for (let child of children) {
      const [childStats] = await pool.execute(`
        SELECT 
          AVG(score/max_score * 4.0) as gpa,
          SUM(score) as total_score,
          SUM(max_score) as total_max
        FROM grades
        WHERE student_id = ? AND status = 'approved'
      `, [child.id]);
      
      // Fetch semester stats for this child
      const [childSemesterStats] = await pool.execute(`
        SELECT 
          c.academic_year, 
          c.semester, 
          AVG(g.score/g.max_score * 4.0) as semester_gpa
        FROM grades g
        JOIN classes c ON g.class_id = c.id
        WHERE g.student_id = ? AND g.status = 'approved'
        GROUP BY c.academic_year, c.semester
        ORDER BY c.academic_year DESC, c.semester DESC
      `, [child.id]);
      
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
        WHERE avg_score > (
          SELECT AVG(score/max_score)
          FROM grades
          WHERE student_id = ? AND status = 'approved'
        )
      `, [child.grade_level, child.section, child.id]);

      const [totalInClass] = await pool.execute(`
        SELECT COUNT(*) as total 
        FROM students 
        WHERE grade_level = ? AND section = ?
      `, [child.grade_level, child.section]);
      
      child.gpa = childStats[0].gpa ? parseFloat(childStats[0].gpa).toFixed(2) : '0.00';
      child.total_score = childStats[0].total_score || 0;
      child.total_max = childStats[0].total_max || 0;
      child.semester_stats = childSemesterStats;
      child.rank = rankData[0].rank;
      child.total_in_class = totalInClass[0].total;
    }
    const [statsData] = await pool.execute(`
      SELECT 
        AVG(score/max_score * 100) as avg_grade,
        AVG(score/max_score * 4.0) as cgpa,
        SUM(score) as total_score,
        SUM(max_score) as max_total,
        COUNT(DISTINCT CASE WHEN g.score/g.max_score >= 0.9 THEN g.id END) as achievements
      FROM grades g
      JOIN parent_student_relations psr ON g.student_id = psr.student_id
      WHERE psr.parent_id = ? AND g.status = 'approved'
    `, [parent.id]);

    const stats = {
      averageGrade: statsData[0].avg_grade ? Math.round(statsData[0].avg_grade) + '%' : 'N/A',
      cgpa: statsData[0].cgpa ? parseFloat(statsData[0].cgpa).toFixed(2) : '0.00',
      totalScore: statsData[0].total_score || 0,
      maxTotal: statsData[0].max_total || 0,
      achievements: statsData[0].achievements || 0
    };
    
    // Get recent activities
    const [announcements] = await pool.execute(`
      SELECT 'announcement' as type, title, 
             DATE_FORMAT(created_at, '%Y-%m-%d') as date
      FROM announcements
      WHERE audience IN ('all', 'students')
      UNION ALL
      SELECT 'grade' as type, CONCAT(s.first_name, ' ', s.last_name, ' - New grade: ', g.title) as title,
             DATE_FORMAT(g.grade_date, '%Y-%m-%d') as date
      FROM grades g
      JOIN students s ON g.student_id = s.id
      JOIN parent_student_relations psr ON s.id = psr.student_id
      WHERE psr.parent_id = ? AND g.status = 'approved'
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
             (SELECT COUNT(*) FROM grades WHERE student_id = s.id AND status = 'approved') as grade_count,
             (SELECT AVG(g.score/g.max_score * 100) 
              FROM grades g 
              WHERE g.student_id = s.id AND g.status = 'approved') as average_grade
      FROM students s
      JOIN users u ON s.user_id = u.id
      JOIN parent_student_relations psr ON s.id = psr.student_id
      WHERE psr.parent_id = ?
      ORDER BY s.last_name, s.first_name
    `, [parentData[0].id]);
    
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
    
    // Get student's grades
    const [grades] = await pool.execute(`
      SELECT g.*, g.title as assignment_name, c.name as class_name, c.grade, c.section
      FROM grades g
      JOIN classes c ON g.class_id = c.id
      WHERE g.student_id = ? AND g.status = 'approved'
      ORDER BY g.grade_date DESC, c.name
    `, [studentId]);
    
    // Calculate GPA
    const [gpaData] = await pool.execute(`
      SELECT AVG(g.score/g.max_score * 4.0) as gpa
      FROM grades g
      WHERE g.student_id = ? AND g.status = 'approved'
    `, [studentId]);
    
    res.render('parent/student-grades', {
      title: `${relation[0].first_name} ${relation[0].last_name}'s Grades`,
      user: req.session.user,
      student: relation[0],
      grades: grades,
      gpa: parseFloat(gpaData[0].gpa || 0)
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
      SELECT s.*, u.first_name, u.last_name
      FROM students s
      JOIN users u ON s.user_id = u.id
      JOIN parent_student_relations psr ON s.id = psr.student_id
      WHERE psr.parent_id = ? AND s.id = ?
    `, [parentData[0].id, studentId]);
    
    if (relation.length === 0) {
      return res.status(403).render('404-modern', { title: 'Access Denied' });
    }
    
    // Get attendance records with class name
    const [attendance] = await pool.execute(`
      SELECT a.*, c.name as class_name
      FROM attendance a
      JOIN classes c ON a.class_id = c.id
      WHERE a.student_id = ?
      ORDER BY a.date DESC
      LIMIT 50
    `, [studentId]);
    
    // Compute attendance stats (present, late, and excused all count as attended)
    const stats = {
      total: attendance.length,
      present: attendance.filter(a => a.status === 'present').length,
      absent: attendance.filter(a => a.status === 'absent').length,
      late: attendance.filter(a => a.status === 'late').length,
      excused: attendance.filter(a => a.status === 'excused').length
    };
    const attended = stats.present + stats.late + stats.excused;
    stats.rate = stats.total > 0 ? Math.round((attended / stats.total) * 100) : 100;
    
    res.render('parent/student-attendance', {
      title: `${relation[0].first_name}'s Attendance`,
      user: req.session.user,
      student: relation[0],
      attendance: attendance,
      stats
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
