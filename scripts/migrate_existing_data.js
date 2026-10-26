const { pool } = require('../config/db');
const { getAcademicContext } = require('../config/systemSettings');

(async () => {
  try {
    console.log('Starting data migration: back-filling academic context fields...');
    const ctx = await getAcademicContext();
    console.log(`Active Academic Context: ${ctx.academicYear} - ${ctx.semesterLabel} (Raw: ${ctx.semester})`);

    const tablesToBackfill = [
      {
        name: 'classes',
        updates: [
          `UPDATE classes SET academic_year = ? WHERE academic_year IS NULL OR academic_year = ''`,
          `UPDATE classes SET semester = ? WHERE semester IS NULL OR semester = ''`,
          `UPDATE classes SET semester_id = ? WHERE semester_id IS NULL OR semester_id = ''`
        ]
      },
      {
        name: 'enrollments',
        updates: [
          `UPDATE enrollments SET academic_year = ? WHERE academic_year IS NULL OR academic_year = ''`,
          `UPDATE enrollments SET semester = ? WHERE semester IS NULL OR semester = ''`,
          `UPDATE enrollments SET semester_id = ? WHERE semester_id IS NULL OR semester_id = ''`
        ]
      },
      {
        name: 'attendance',
        updates: [
          `UPDATE attendance SET academic_year = ? WHERE academic_year IS NULL OR academic_year = ''`,
          `UPDATE attendance SET semester = ? WHERE semester IS NULL OR semester = ''`,
          `UPDATE attendance SET semester_id = ? WHERE semester_id IS NULL OR semester_id = ''`
        ]
      },
      {
        name: 'assignments',
        updates: [
          `UPDATE assignments SET academic_year = ? WHERE academic_year IS NULL OR academic_year = ''`,
          `UPDATE assignments SET semester = ? WHERE semester IS NULL OR semester = ''`,
          `UPDATE assignments SET semester_id = ? WHERE semester_id IS NULL OR semester_id = ''`
        ]
      },
      {
        name: 'materials',
        updates: [
          `UPDATE materials SET academic_year = ? WHERE academic_year IS NULL OR academic_year = ''`,
          `UPDATE materials SET semester = ? WHERE semester IS NULL OR semester = ''`,
          `UPDATE materials SET semester_id = ? WHERE semester_id IS NULL OR semester_id = ''`
        ]
      },
      {
        name: 'student_results',
        updates: [
          `UPDATE student_results SET academic_year = ? WHERE academic_year IS NULL OR academic_year = ''`,
          `UPDATE student_results SET semester = ? WHERE semester IS NULL OR semester = ''`,
          `UPDATE student_results SET semester_id = ? WHERE semester_id IS NULL OR semester_id = ''`
        ]
      },
      {
        name: 'student_course_results',
        updates: [
          `UPDATE student_course_results SET academic_year = ? WHERE academic_year IS NULL OR academic_year = ''`,
          `UPDATE student_course_results SET semester = ? WHERE semester IS NULL OR semester = ''`,
          `UPDATE student_course_results SET semester_id = ? WHERE semester_id IS NULL OR semester_id = ''`
        ]
      },
      {
        name: 'grade_change_logs',
        updates: [
          `UPDATE grade_change_logs SET academic_year = ? WHERE academic_year IS NULL OR academic_year = ''`,
          `UPDATE grade_change_logs SET semester = ? WHERE semester IS NULL OR semester = ''`,
          `UPDATE grade_change_logs SET semester_id = ? WHERE semester_id IS NULL OR semester_id = ''`
        ]
      },
      {
        name: 'grade_submissions',
        updates: [
          `UPDATE grade_submissions SET academic_year = ? WHERE academic_year IS NULL OR academic_year = ''`,
          `UPDATE grade_submissions SET semester = ? WHERE semester IS NULL OR semester = ''`,
          `UPDATE grade_submissions SET semester_id = ? WHERE semester_id IS NULL OR semester_id = ''`
        ]
      }
    ];

    const connection = await pool.getConnection();

    for (const table of tablesToBackfill) {
      console.log(`Backfilling table: ${table.name}`);
      for (const query of table.updates) {
        // We substitute either academicYear or semesterLabel depending on query pattern
        const param = query.includes('academic_year') ? ctx.academicYear : ctx.semesterLabel;
        const [result] = await connection.execute(query, [param]);
        console.log(` - Executed: ${query.substring(0, 50)}... affectedRows: ${result.affectedRows}`);
      }
    }

    connection.release();
    console.log('Backfill data migration completed successfully.');
    process.exit(0);
  } catch (err) {
    console.error('Data migration failed:', err);
    process.exit(1);
  }
})();
