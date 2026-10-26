const { pool } = require('../config/db');

async function addCourseIdColumn() {
  try {
    // Add course_id column if it doesn't exist
    try {
      await pool.execute("ALTER TABLE materials ADD COLUMN course_id INT");
      console.log('Added column course_id');
    } catch (e) {
      if (e.code === 'ER_DUP_FIELDNAME' || e.errno === 1050) {
        console.log('Column course_id already exists, skipping');
      } else {
        throw e;
      }
    }

    // Add foreign key constraint if it doesn't exist
    try {
      // Drop existing foreign key if it exists to avoid duplicate errors
      const [fkRows] = await pool.query("SELECT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'materials' AND CONSTRAINT_NAME = 'fk_materials_course'");
      if (fkRows.length > 0) {
        await pool.execute('ALTER TABLE materials DROP FOREIGN KEY fk_materials_course');
        console.log('Dropped existing foreign key fk_materials_course');
      }
      await pool.execute(
        "ALTER TABLE materials ADD CONSTRAINT fk_materials_course FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE SET NULL"
      );
      console.log('Added foreign key fk_materials_course');
    } catch (e) {
      console.error('Error adding foreign key:', e);
    }

    console.log('Course ID column and constraint ensured.');
    process.exit(0);
  } catch (e) {
    console.error('Error fixing materials course_id column:', e);
    process.exit(1);
  }
}

addCourseIdColumn();
