// check_teacher_overwrites.js
// This script verifies that grade entries in student_results are isolated per teacher (owner).
// It fetches teacher IDs for the given first names and reports the number of grade rows
// associated with each teacher.

const mysql = require('mysql2/promise');
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || 'ru0207/16',
  database: process.env.DB_NAME || 'student_registration_system',
  waitForConnections: true,
  connectionLimit: 5,
  queueLimit: 0
});

async function main() {
  const teacherNames = ['t1', 't2', 't3', 'yonase', 'abebe'];
  try {
    const conn = await pool.getConnection();
    // Get teacher IDs matching the first names
    const placeholders = teacherNames.map(() => '?').join(',');
    const [teachers] = await conn.execute(
      `SELECT id, first_name, last_name FROM teachers WHERE first_name IN (${placeholders})`,
      teacherNames
    );
    if (teachers.length === 0) {
      console.log('No teachers found for the given names.');
      return;
    }
    console.log('Found teachers:', teachers);
    // For each teacher, count rows in student_results where teacher_id matches (owner)
    for (const t of teachers) {
      const [rows] = await conn.execute(
        `SELECT COUNT(*) as cnt FROM student_results WHERE teacher_id = ?`,
        [t.id]
      );
      console.log(`Teacher ${t.first_name} (id=${t.id}) has ${rows[0].cnt} grade rows in student_results.`);
    }
    conn.release();
  } catch (err) {
    console.error('Error during check:', err);
  } finally {
    await pool.end();
  }
}

main();
