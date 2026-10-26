const { pool } = require('../config/db');

/**
 * Middleware to verify that the logged-in teacher is assigned to the specified class and course.
 * Expects classId and courseId (optional) in req.body or req.query.
 * If verification fails, responds with 403.
 */
async function verifyTeacherAssignment(req, res, next) {
  const teacherId = req.teacherId;
  const classId = req.body.classId || req.query.classId;
  const courseId = req.body.courseId !== undefined ? req.body.courseId : req.query.courseId;

  if (!classId) {
    return res.status(400).json({ message: 'classId is required' });
  }

  try {
    // Check assignment via teacher_course_assignments or class_teachers (homeroom)
    const [rows] = await pool.execute(
      `SELECT id FROM teacher_course_assignments 
       WHERE teacher_id = ? AND class_id = ? AND (course_id = ? OR ? = 0) AND status = 'active'
       UNION 
       SELECT id FROM class_teachers 
       WHERE teacher_id = ? AND class_id = ? AND ? = 0`,
      [teacherId, classId, courseId, courseId, teacherId, classId, courseId]
    );

    if (rows.length === 0) {
      return res.status(403).json({ message: 'Access denied: teacher not assigned to this class/course' });
    }
    next();
  } catch (err) {
    console.error('verifyTeacherAssignment error:', err);
    res.status(500).json({ message: 'Server error' });
  }
}

module.exports = verifyTeacherAssignment;
