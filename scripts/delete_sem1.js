const mysql = require('mysql2/promise');
(async () => {
  try {
    const pool = await mysql.createPool({
      host: process.env.DB_HOST || 'localhost',
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || 'ru0207/16',
      database: process.env.DB_NAME || 'student_registration_system',
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0
    });
    const [gradeResult] = await pool.execute("DELETE FROM grades WHERE semester = 'Semester 1'");
    const [attendanceResult] = await pool.execute("DELETE FROM attendance WHERE semester = 'Semester 1'");
    console.log('Deleted semester 1 grades and attendance');
    console.log('Grades rows affected:', gradeResult.affectedRows);
    console.log('Attendance rows affected:', attendanceResult.affectedRows);
    await pool.end();
  } catch (err) {
    console.error('Error during deletion:', err);
    process.exit(1);
  }
})();
