// migration_exec.js
// Executes SQL statements from migration.sql using the existing DB pool
const fs = require('fs');
const path = require('path');
const { pool } = require('./config/db');

(async () => {
  try {
    const sql = fs.readFileSync(path.join(__dirname, 'migration.sql'), 'utf8');
    // Split statements by semicolon that are not within quotes (simple split)
    const statements = sql.split(/;\s*\n/).filter(s => s.trim().length > 0);
    for (const stmt of statements) {
      await pool.execute(stmt);
    }
    console.log('Migration applied successfully');
    process.exit(0);
  } catch (err) {
    console.error('Migration error:', err);
    process.exit(1);
  }
})();
