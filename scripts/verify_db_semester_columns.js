const { pool } = require('../config/db');

(async () => {
  try {
    const tables = [
      'classes', 'enrollments', 'attendance', 'assignments', 'materials',
      'student_results', 'student_course_results', 'grade_change_logs', 'grade_submissions'
    ];

    console.log('Verifying columns for time-sensitive tables:');
    for (const table of tables) {
      try {
        const [columns] = await pool.execute(`
          SELECT COLUMN_NAME, DATA_TYPE 
          FROM INFORMATION_SCHEMA.COLUMNS 
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
        `, [table]);

        const colNames = columns.map(c => c.COLUMN_NAME);
        console.log(`Table: ${table}`);
        console.log(` - Has academic_year: ${colNames.includes('academic_year')}`);
        console.log(` - Has semester: ${colNames.includes('semester')}`);
        console.log(` - Has semester_id: ${colNames.includes('semester_id')}`);
        console.log(` - All Columns: ${colNames.join(', ')}`);
      } catch (err) {
        console.log(`Error checking table ${table}:`, err.message);
      }
    }
    process.exit(0);
  } catch (err) {
    console.error('Critical verification error:', err);
    process.exit(1);
  }
})();
