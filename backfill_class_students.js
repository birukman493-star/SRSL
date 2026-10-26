// backfill_class_students.js
// Populate class_students based on existing student grade_level and section mapping to classes
const { pool } = require('./config/db');

(async () => {
  try {
    const [students] = await pool.execute('SELECT id, grade_level, section FROM students');
    for (const s of students) {
      const [classes] = await pool.execute(
        'SELECT id FROM classes WHERE grade = ? AND section = ?',
        [s.grade_level, s.section]
      );
      for (const c of classes) {
        await pool.execute(
          'INSERT IGNORE INTO class_students (student_id, class_id) VALUES (?, ?)',
          [s.id, c.id]
        );
      }
    }
    console.log('Backfill completed');
    process.exit(0);
  } catch (err) {
    console.error('Backfill error:', err);
    process.exit(1);
  }
})();
