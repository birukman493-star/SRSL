// add_academic_year_columns.js
// Migration script that adds required columns to `academic_years` only if they do not already exist.
// This avoids duplicate column/constraint errors.

const { pool } = require('./config/db');

(async () => {
  try {
    // Helper to check column existence
    const columnExists = async (col) => {
      const [rows] = await pool.execute(
        `SELECT COUNT(*) as cnt FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'academic_years' AND COLUMN_NAME = ?`,
        [col]
      );
      return rows[0].cnt > 0;
    };

    // Helper to check constraint existence
    const constraintExists = async (name) => {
      const [rows] = await pool.execute(
        `SELECT COUNT(*) as cnt FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'academic_years' AND CONSTRAINT_NAME = ?`,
        [name]
      );
      return rows[0].cnt > 0;
    };

    // 1. changed_by column
    if (!(await columnExists('changed_by'))) {
      await pool.execute(`ALTER TABLE academic_years ADD COLUMN changed_by INT NULL`);
      console.log('Added column changed_by');
    } else {
      console.log('Column changed_by already exists');
    }

    // 2. foreign key constraint for changed_by
    const fkName = 'fk_ay_changed_by';
    if (!(await constraintExists(fkName))) {
      await pool.execute(`ALTER TABLE academic_years ADD CONSTRAINT ${fkName} FOREIGN KEY (changed_by) REFERENCES users(id) ON DELETE SET NULL`);
      console.log('Added foreign key constraint', fkName);
    } else {
      console.log('Constraint', fkName, 'already exists');
    }

    // 3. started_at column
    if (!(await columnExists('started_at'))) {
      await pool.execute(`ALTER TABLE academic_years ADD COLUMN started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`);
      console.log('Added column started_at');
    } else {
      console.log('Column started_at already exists');
    }

    // 4. ended_at column
    if (!(await columnExists('ended_at'))) {
      await pool.execute(`ALTER TABLE academic_years ADD COLUMN ended_at TIMESTAMP NULL`);
      console.log('Added column ended_at');
    } else {
      console.log('Column ended_at already exists');
    }

    // 5. is_active column
    if (!(await columnExists('is_active'))) {
      await pool.execute(`ALTER TABLE academic_years ADD COLUMN is_active BOOLEAN DEFAULT FALSE`);
      console.log('Added column is_active');
    } else {
      console.log('Column is_active already exists');
    }

    console.log('Academic year migration completed successfully');
    process.exit(0);
  } catch (err) {
    console.error('Migration error:', err);
    process.exit(1);
  }
})();
