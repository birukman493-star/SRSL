const { pool } = require('../config/db');

async function fix() {
  try {
    // Add academic_year column if it doesn't exist
    try {
      await pool.execute("ALTER TABLE materials ADD COLUMN academic_year VARCHAR(20)");
      console.log('Added column academic_year');
    } catch (e) {
      if (e.code === 'ER_DUP_FIELDNAME' || e.errno === 1050) {
        console.log('Column academic_year already exists, skipping');
      } else {
        throw e;
      }
    }
    // Add semester column if it doesn't exist
    try {
      await pool.execute("ALTER TABLE materials ADD COLUMN semester VARCHAR(50)");
      console.log('Added column semester');
    } catch (e) {
      if (e.code === 'ER_DUP_FIELDNAME' || e.errno === 1050) {
        console.log('Column semester already exists, skipping');
      } else {
        throw e;
      }
    }
    console.log('Materials table columns ensured.');
    process.exit(0);
  } catch (e) {
    console.error('Error fixing materials columns:', e);
    process.exit(1);
  }
}

fix();
