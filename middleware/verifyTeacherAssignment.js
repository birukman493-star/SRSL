const { pool } = require('../config/db');

function parseId(value, allowZero = false) {
  if (
    typeof value !== 'number' &&
    (typeof value !== 'string' || !/^\d+$/.test(value))
  ) {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < (allowZero ? 0 : 1)) {
    return null;
  }
  return parsed;
}

async function isTeacherAssigned(executor, teacherId, classId, courseId) {
  const parsedClassId = parseId(classId);
  const parsedCourseId = parseId(courseId, true);
  if (parsedClassId === null || parsedCourseId === null) {
    return false;
  }

  const [rows] = parsedCourseId === 0
    ? await executor.execute(
      'SELECT id FROM class_teachers WHERE teacher_id = ? AND class_id = ?',
      [teacherId, parsedClassId]
    )
    : await executor.execute(
      `SELECT id FROM teacher_course_assignments
       WHERE teacher_id = ? AND class_id = ? AND course_id = ? AND status = 'active'`,
      [teacherId, parsedClassId, parsedCourseId]
    );

  if (rows.length > 0 || parsedCourseId === 0) {
    return rows.length > 0;
  }

  const [scheduledAssignments] = await executor.execute(
    `SELECT id FROM class_schedule
     WHERE teacher_id = ? AND class_id = ? AND course_id = ?
     LIMIT 1`,
    [teacherId, parsedClassId, parsedCourseId]
  );
  if (scheduledAssignments.length > 0) return true;

  const [courseOwnerSchedules] = await executor.execute(
    `SELECT cs.id
     FROM class_schedule cs
     JOIN courses c ON c.id = cs.course_id
     WHERE c.teacher_id = ? AND cs.class_id = ? AND cs.course_id = ?
     LIMIT 1`,
    [teacherId, parsedClassId, parsedCourseId]
  );
  return courseOwnerSchedules.length > 0;
}

async function verifyTeacherAssignment(req, res, next) {
  const teacherId = req.teacherId;
  const body = req.body || {};
  const query = req.query || {};
  const classId = body.classId !== undefined ? body.classId : query.classId;
  const courseId = body.courseId !== undefined
    ? body.courseId
    : query.courseId !== undefined
      ? query.courseId
      : 0;

  if (classId === undefined || classId === null || classId === '') {
    return res.status(400).json({ message: 'classId is required' });
  }

  const parsedClassId = parseId(classId);
  const parsedCourseId = parseId(courseId, true);
  if (parsedClassId === null || parsedCourseId === null) {
    return res.status(400).json({ message: 'classId and courseId must be valid IDs' });
  }

  try {
    if (!await isTeacherAssigned(pool, teacherId, parsedClassId, parsedCourseId)) {
      return res.status(403).json({ message: 'Access denied: teacher is not assigned to this class/course' });
    }

    req.classId = parsedClassId;
    req.courseId = parsedCourseId;
    next();
  } catch (err) {
    console.error('verifyTeacherAssignment error:', err);
    res.status(500).json({ message: 'Server error' });
  }
}

module.exports = { verifyTeacherAssignment, isTeacherAssigned };
