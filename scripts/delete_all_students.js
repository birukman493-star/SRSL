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
    const [result] = await pool.execute('DELETE FROM students');
    console.log('Deleted all students. Rows affected:', result.affectedRows);
    await pool.end();
  } catch (err) {
    console.error('Error deleting students:', err);
    process.exit(1);
  }
})();
