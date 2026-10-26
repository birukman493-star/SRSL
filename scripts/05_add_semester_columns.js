const { pool } = require('../config/db');

(async () => {
  try {
    console.log('Running migration: adding semester & academic year columns safely...');

    // Define table column definitions to ensure consistency
    const tableAlterations = {
      enrollments: [
        "ALTER TABLE enrollments ADD COLUMN academic_year VARCHAR(20) NOT NULL DEFAULT '2025-2026'",
        "ALTER TABLE enrollments ADD COLUMN semester VARCHAR(50) NOT NULL DEFAULT 'Semester 1'",
        "ALTER TABLE enrollments ADD COLUMN semester_id VARCHAR(50) NOT NULL DEFAULT 'Semester 1'"
      ],
      grade_change_logs: [
        "ALTER TABLE grade_change_logs ADD COLUMN academic_year VARCHAR(20) NOT NULL DEFAULT '2025-2026'",
        "ALTER TABLE grade_change_logs ADD COLUMN semester VARCHAR(50) NOT NULL DEFAULT 'Semester 1'",
        "ALTER TABLE grade_change_logs ADD COLUMN semester_id VARCHAR(50) NOT NULL DEFAULT 'Semester 1'"
      ],
      student_course_results: [
        "ALTER TABLE student_course_results ADD COLUMN semester VARCHAR(50) NOT NULL DEFAULT 'Semester 1'"
      ],
      grade_submissions: [
        "ALTER TABLE grade_submissions ADD COLUMN semester VARCHAR(50) NOT NULL DEFAULT 'Semester 1'"
      ],
      classes: [
        "ALTER TABLE classes ADD COLUMN semester_id VARCHAR(50) NOT NULL DEFAULT 'Semester 1'"
      ]
    };

    const connection = await pool.getConnection();

    for (const [table, queries] of Object.entries(tableAlterations)) {
      console.log(`Checking table: ${table}`);
      // Get existing columns
      const [columns] = await connection.execute(`
        SELECT COLUMN_NAME 
        FROM INFORMATION_SCHEMA.COLUMNS 
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
      `, [table]);
      const existingCols = columns.map(c => c.COLUMN_NAME.toLowerCase());

      for (const query of queries) {
        // Extract column name from the query
        const colMatch = query.match(/ADD\s+COLUMN\s+(\w+)/i);
        if (colMatch) {
          const colName = colMatch[1].toLowerCase();
          if (existingCols.includes(colName)) {
            console.log(` - Column ${colName} already exists in ${table}. Skipping.`);
          } else {
            console.log(` - Executing: ${query}`);
            await connection.execute(query);
          }
        }
      }
    }

    // Add indexes for academic_year and semester to all relevant tables for optimized filtering
    const tablesToIndex = [
      'classes', 'enrollments', 'attendance', 'assignments', 'materials',
      'student_results', 'student_course_results', 'grade_change_logs', 'grade_submissions'
    ];

    console.log('Verifying/Adding indexes on (academic_year, semester) for performance...');
    for (const table of tablesToIndex) {
      try {
        const [indexCheck] = await connection.execute(`
          SHOW INDEX FROM \`${table}\` WHERE KEY_NAME = ?
        `, [`idx_${table}_ay_sem`]);

        if (indexCheck.length === 0) {
          const query = `CREATE INDEX \`idx_${table}_ay_sem\` ON \`${table}\` (academic_year, semester)`;
          console.log(` - Creating index on ${table}: ${query}`);
          await connection.execute(query);
        } else {
          console.log(` - Index already exists on ${table}. Skipping.`);
        }
      } catch (err) {
        console.warn(` - Warning for index on table ${table}: ${err.message}`);
      }
    }

    connection.release();
    console.log('Migration completed successfully.');
    process.exit(0);
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  }
})();
