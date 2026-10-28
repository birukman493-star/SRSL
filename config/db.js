const mysql = require('mysql2/promise');

// Create connection pool with database
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || 'ru0207/16',
  database: process.env.DB_NAME || 'student_registration_system',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});
// Removed circular import; will import inside initDatabase
// Database initialization function - creates database and tables dynamically
async function initDatabase() {
const { getActiveAcademicYear, getSetting, formatSemesterLabel, DEFAULT_SEMESTER } = require('./systemSettings');
  try {
    console.log('Initializing database...');

    // Create a temporary pool without database to create the database
    const tempPool = mysql.createPool({
      host: process.env.DB_HOST || 'localhost',
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || 'ru0207/16',
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0
    });

    const connection = await tempPool.getConnection();

    const dbName = process.env.DB_NAME || 'student_registration_system';

    // Create database if it doesn't exist
    await connection.execute(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    console.log(`Database '${dbName}' created or already exists`);

    // Release the connection and close temp pool
    connection.release();
    await tempPool.end();

    // Now use the main pool (which should have database specified)
    const dbConnection = await pool.getConnection();

    // Create users table
    await dbConnection.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        first_name VARCHAR(50) NOT NULL,
        last_name VARCHAR(50) NOT NULL,
        role ENUM('admin', 'teacher', 'student', 'parent') NOT NULL,
        is_active BOOLEAN DEFAULT TRUE,
        phone VARCHAR(20),
        reset_token VARCHAR(255),
        reset_token_expiry DATETIME,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_username (username),
        INDEX idx_email (email),
        INDEX idx_role (role)
      )
    `);

    // Add missing reset_token columns if they don't exist
    try {
      await dbConnection.execute('ALTER TABLE users ADD COLUMN reset_token VARCHAR(255)');
      console.log('Added reset_token to users table');
    } catch (e) {
      if (e.code !== 'ER_DUP_FIELDNAME') throw e;
    }

    try {
      await dbConnection.execute('ALTER TABLE users ADD COLUMN reset_token_expiry DATETIME');
      console.log('Added reset_token_expiry to users table');
    } catch (e) {
      if (e.code !== 'ER_DUP_FIELDNAME') throw e;
    }

    try {
      await dbConnection.execute('ALTER TABLE users ADD COLUMN profile_picture VARCHAR(255)');
      console.log('Added profile_picture to users table');
    } catch (e) {
      if (e.code !== 'ER_DUP_FIELDNAME') throw e;
    }

    // Create teachers table
    await dbConnection.execute(`
      CREATE TABLE IF NOT EXISTS teachers (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        employee_id VARCHAR(50) UNIQUE,
        first_name VARCHAR(50),
        last_name VARCHAR(50),
        email VARCHAR(100),
        phone VARCHAR(20),
        department VARCHAR(100),
        hire_date DATE,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        INDEX idx_employee_id (employee_id),
        INDEX idx_department (department)
      )
    `);

    // Add missing columns to teachers if they don't exist
    try {
      await dbConnection.execute('ALTER TABLE teachers ADD COLUMN qualification VARCHAR(255)');
      console.log('Added qualification to teachers table');
    } catch (e) {
      if (e.code !== 'ER_DUP_FIELDNAME') throw e;
    }

    try {
      await dbConnection.execute('ALTER TABLE teachers ADD COLUMN experience VARCHAR(255)');
      console.log('Added experience to teachers table');
    } catch (e) {
      if (e.code !== 'ER_DUP_FIELDNAME') throw e;
    }

    try {
      await dbConnection.execute('ALTER TABLE teachers ADD COLUMN certificate_url VARCHAR(255)');
      console.log('Added certificate_url to teachers table');
    } catch (e) {
      if (e.code !== 'ER_DUP_FIELDNAME') throw e;
    }

    try {
      await dbConnection.execute('ALTER TABLE teachers ADD COLUMN id_card_url VARCHAR(255)');
      console.log('Added id_card_url to teachers table');
    } catch (e) {
      if (e.code !== 'ER_DUP_FIELDNAME') throw e;
    }

    // Create classes table
    await dbConnection.execute(`
      CREATE TABLE IF NOT EXISTS classes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        grade VARCHAR(10) NOT NULL,
        section VARCHAR(10),
        teacher_id INT,
        attendance_teacher_id INT NULL,
        room VARCHAR(50),
        schedule TEXT,
        academic_year VARCHAR(20) DEFAULT '2025-2026',
        semester VARCHAR(50) DEFAULT '1',
        course_limit INT DEFAULT 10,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE,
        FOREIGN KEY (attendance_teacher_id) REFERENCES teachers(id) ON DELETE SET NULL,
        INDEX idx_grade (grade),
        INDEX idx_teacher_id (teacher_id)
      )
    `);

    // Add missing columns to classes if they don't exist
    try {
      await dbConnection.execute("ALTER TABLE classes ADD COLUMN academic_year VARCHAR(20) DEFAULT '2025-2026'");
      console.log('Added academic_year to classes table');
    } catch (e) {
      if (e.code !== 'ER_DUP_FIELDNAME') throw e;
    }

    try {
      await dbConnection.execute("ALTER TABLE classes ADD COLUMN semester VARCHAR(50) DEFAULT '1'");
      console.log('Added semester to classes table');
    } catch (e) {
      if (e.code !== 'ER_DUP_FIELDNAME') throw e;
    }

    try {
      await dbConnection.execute("ALTER TABLE classes ADD COLUMN course_limit INT DEFAULT 10");
      console.log('Added course_limit to classes table');
    } catch (e) {
      if (e.code !== 'ER_DUP_FIELDNAME') throw e;
    }

    // Create students table
    await dbConnection.execute(`
      CREATE TABLE IF NOT EXISTS students (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        student_id VARCHAR(20) UNIQUE NOT NULL,
        first_name VARCHAR(50),
        last_name VARCHAR(50),
        email VARCHAR(100),
        phone VARCHAR(20),
        grade_level VARCHAR(10),
        section VARCHAR(10),
        date_of_birth DATE,
        gender ENUM('male', 'female') NOT NULL,
        enrollment_date DATE,
        parent_guardian_name VARCHAR(100),
        address TEXT,
        previous_school VARCHAR(255),
        class_id INT,
        registration_status ENUM('pending', 'registered', 'not_started') DEFAULT 'not_started',
        withdrawal_status ENUM('active', 'withdrawn', 'transferred', 'dropped_out') DEFAULT 'active',
        withdrawal_reason TEXT,
        withdrawal_date DATE,
        admission_type ENUM('new', 'transfer') DEFAULT 'new',
        transfer_date DATE,
        transfer_reason TEXT,
        previous_transcript_url VARCHAR(255),
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE SET NULL,
        INDEX idx_student_id (student_id),
        INDEX idx_grade_level (grade_level),
        INDEX idx_parent_guardian (parent_guardian_name),
        INDEX idx_withdrawal_status (withdrawal_status)
      )
    `);

    // Add missing columns to students if they don't exist
    try {
      await dbConnection.execute('ALTER TABLE students ADD COLUMN address TEXT');
      console.log('Added address to students table');
    } catch (e) {
      if (e.code !== 'ER_DUP_FIELDNAME') throw e;
    }

    try {
      await dbConnection.execute('ALTER TABLE students ADD COLUMN previous_school VARCHAR(255)');
      console.log('Added previous_school to students table');
    } catch (e) {
      if (e.code !== 'ER_DUP_FIELDNAME') throw e;
    }

    try {
      await dbConnection.execute("ALTER TABLE students ADD COLUMN withdrawal_status ENUM('active', 'withdrawn', 'transferred', 'dropped_out') DEFAULT 'active'");
      console.log('Added withdrawal_status to students table');
    } catch (e) {
      if (e.code !== 'ER_DUP_FIELDNAME') throw e;
    }

    try {
      await dbConnection.execute('ALTER TABLE students ADD COLUMN withdrawal_reason TEXT');
      console.log('Added withdrawal_reason to students table');
    } catch (e) {
      if (e.code !== 'ER_DUP_FIELDNAME') throw e;
    }

    try {
      await dbConnection.execute('ALTER TABLE students ADD COLUMN withdrawal_date DATE');
      console.log('Added withdrawal_date to students table');
    } catch (e) {
      if (e.code !== 'ER_DUP_FIELDNAME') throw e;
    }

    try {
      await dbConnection.execute('ALTER TABLE students ADD COLUMN admission_type ENUM(\'new\', \'transfer\') DEFAULT \'new\'');
      console.log('Added admission_type to students table');
    } catch (e) {
      if (e.code !== 'ER_DUP_FIELDNAME') throw e;
    }

    try {
      await dbConnection.execute('ALTER TABLE students ADD COLUMN transfer_date DATE');
      console.log('Added transfer_date to students table');
    } catch (e) {
      if (e.code !== 'ER_DUP_FIELDNAME') throw e;
    }

    try {
      await dbConnection.execute('ALTER TABLE students ADD COLUMN transfer_reason TEXT');
      console.log('Added transfer_reason to students table');
    } catch (e) {
      if (e.code !== 'ER_DUP_FIELDNAME') throw e;
    }

    try {
      await dbConnection.execute('ALTER TABLE students ADD COLUMN previous_transcript_url VARCHAR(255)');
      console.log('Added previous_transcript_url to students table');
    } catch (e) {
      if (e.code !== 'ER_DUP_FIELDNAME') throw e;
    }

    // Create student_documents table for multiple uploads
    await dbConnection.execute(`
      CREATE TABLE IF NOT EXISTS student_documents (
        id INT AUTO_INCREMENT PRIMARY KEY,
        student_id INT NOT NULL,
        document_type ENUM('transcript', 'report_card', 'id_card', 'other') DEFAULT 'transcript',
        file_url VARCHAR(255) NOT NULL,
        file_name VARCHAR(255),
        uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
        INDEX idx_student_id (student_id)
      )
    `);
    console.log('Verified student_documents table');

    // Create parents table
    await dbConnection.execute(`
      CREATE TABLE IF NOT EXISTS parents (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        relationship VARCHAR(50),
        occupation VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        INDEX idx_relationship (relationship)
      )
    `);

    // Create courses table
    await dbConnection.execute(`
      CREATE TABLE IF NOT EXISTS courses (
        id INT AUTO_INCREMENT PRIMARY KEY,
        course_name VARCHAR(100) NOT NULL,
        course_code VARCHAR(20) UNIQUE NOT NULL,
        description TEXT,
        grade VARCHAR(10),
        credits INT DEFAULT 3,
        teacher_id INT,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE,
        INDEX idx_course_code (course_code),
        INDEX idx_teacher_id (teacher_id),
        INDEX idx_course_name (course_name)
      )
    `);

    // Add missing grade column to courses if it doesn't exist
    try {
      await dbConnection.execute("ALTER TABLE courses ADD COLUMN grade VARCHAR(10)");
      console.log('Added grade to courses table');
    } catch (e) {
      if (e.code !== 'ER_DUP_FIELDNAME') throw e;
    }

    // Create enrollments table (fixed typo)
    await dbConnection.execute(`
      CREATE TABLE IF NOT EXISTS enrollments (
        id INT AUTO_INCREMENT PRIMARY KEY,
        student_id INT NOT NULL,
        course_id INT NOT NULL,
        enrollment_date DATE,
        grade VARCHAR(5),
        status ENUM('enrolled', 'completed', 'dropped', 'pending', 'waitlisted') DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
        FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE,
        UNIQUE KEY unique_enrollment (student_id, course_id),
        INDEX idx_student_course (student_id, course_id),
        INDEX idx_status (status)
      )
    `);

    // Classes table was created earlier before students to satisfy foreign key dependencies.
    // Create class_teachers table for multiple teacher assignments
    await dbConnection.execute(`
      CREATE TABLE IF NOT EXISTS class_teachers (
        id INT AUTO_INCREMENT PRIMARY KEY,
        class_id INT NOT NULL,
        teacher_id INT NOT NULL,
        assigned_date DATE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE,
        FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE,
        UNIQUE KEY unique_class_teacher (class_id, teacher_id),
        INDEX idx_class_id (class_id),
        INDEX idx_teacher_id (teacher_id)
      )
    `);

    // Migrate existing teacher_id from classes to class_teachers if needed
    try {
      await dbConnection.execute(`
        INSERT IGNORE INTO class_teachers (class_id, teacher_id, assigned_date)
        SELECT id, teacher_id, CURDATE() FROM classes WHERE teacher_id IS NOT NULL
      `);
      console.log('Migrated existing class teachers to class_teachers table');
    } catch (e) {
      console.error('Migration error:', e);
    }


    // Create class_students table
    await dbConnection.execute(`
      CREATE TABLE IF NOT EXISTS class_students (
        id INT AUTO_INCREMENT PRIMARY KEY,
        class_id INT NOT NULL,
        student_id INT NOT NULL,
        enrollment_date DATE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE,
        FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
        UNIQUE KEY unique_class_student (class_id, student_id),
        INDEX idx_class_id (class_id),
        INDEX idx_student_id (student_id)
      )
    `);

    // Create attendance table
    await dbConnection.execute(`
      CREATE TABLE IF NOT EXISTS attendance (
        id INT AUTO_INCREMENT PRIMARY KEY,
        student_id INT NOT NULL,
        class_id INT NOT NULL,
        course_id INT,
        date DATE NOT NULL,
        status ENUM('present', 'absent', 'late', 'excused') DEFAULT 'present',
        approval_status ENUM('pending', 'approved', 'rejected') DEFAULT 'pending',
        attendance_type ENUM('daily', 'morning', 'afternoon') DEFAULT 'daily',
        notes TEXT,
        created_by INT,
        teacher_id INT,
        semester_id VARCHAR(50),
        academic_year VARCHAR(20),
        semester VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
        FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE,
        FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE SET NULL,
        FOREIGN KEY (created_by) REFERENCES teachers(id) ON DELETE SET NULL,
        FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE SET NULL,
        INDEX idx_student_date (student_id, date),
        INDEX idx_class_date (class_id, date),
        INDEX idx_status (status),
        UNIQUE KEY unique_class_attendance (student_id, class_id, date)
      )
    `);

    // Migration for attendance table
    try {
      await dbConnection.execute('ALTER TABLE attendance ADD COLUMN course_id INT AFTER class_id');
      console.log('Added course_id to attendance table');
    } catch (e) { }

    try {
      await dbConnection.execute('ALTER TABLE attendance ADD COLUMN approval_status ENUM(\'pending\', \'approved\', \'rejected\') DEFAULT \'pending\' AFTER status');
      console.log('Added approval_status to attendance table');
    } catch (e) { }

    try {
      await dbConnection.execute('ALTER TABLE attendance ADD CONSTRAINT fk_attendance_course FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE SET NULL');
    } catch (e) { }

    // Keep an audit copy of course-based rows and records removed while consolidating
    // legacy course attendance into a single class/day record.
    await dbConnection.execute('CREATE TABLE IF NOT EXISTS attendance_course_history LIKE attendance');
    for (const indexName of ['unique_attendance', 'unique_class_attendance']) {
      const [archiveIndexes] = await dbConnection.execute(
        `SELECT INDEX_NAME FROM information_schema.statistics
         WHERE table_schema = DATABASE() AND table_name = 'attendance_course_history'
           AND index_name = ? LIMIT 1`,
        [indexName]
      );
      if (archiveIndexes.length > 0) {
        await dbConnection.execute(`ALTER TABLE attendance_course_history DROP INDEX ${indexName}`);
      }
    }
    await dbConnection.execute(`
      INSERT IGNORE INTO attendance_course_history
      SELECT a.*
      FROM attendance a
      WHERE a.course_id IS NOT NULL
         OR EXISTS (
           SELECT 1
           FROM attendance newer
           WHERE newer.student_id = a.student_id
             AND newer.class_id = a.class_id
             AND newer.date = a.date
             AND (
               newer.updated_at > a.updated_at
               OR (newer.updated_at = a.updated_at AND newer.id > a.id)
             )
         )
    `);
    await dbConnection.execute(`
      DELETE older FROM attendance older
      JOIN attendance newer
        ON newer.student_id = older.student_id
       AND newer.class_id = older.class_id
       AND newer.date = older.date
       AND (
         newer.updated_at > older.updated_at
         OR (newer.updated_at = older.updated_at AND newer.id > older.id)
       )
    `);
    await dbConnection.execute('UPDATE attendance SET course_id = NULL WHERE course_id IS NOT NULL');

    const [attendanceIndexes] = await dbConnection.execute(
      `SELECT INDEX_NAME FROM information_schema.statistics
       WHERE table_schema = DATABASE() AND table_name = 'attendance'
         AND index_name = 'unique_attendance' LIMIT 1`
    );
    if (attendanceIndexes.length > 0) {
      await dbConnection.execute('ALTER TABLE attendance DROP INDEX unique_attendance');
    }
    const [classAttendanceIndexes] = await dbConnection.execute(
      `SELECT INDEX_NAME FROM information_schema.statistics
       WHERE table_schema = DATABASE() AND table_name = 'attendance'
         AND index_name = 'unique_class_attendance' LIMIT 1`
    );
    if (classAttendanceIndexes.length === 0) {
      await dbConnection.execute(
        'ALTER TABLE attendance ADD UNIQUE KEY unique_class_attendance (student_id, class_id, date)'
      );
    }
    console.log('Migrated attendance to one record per student, class, and date');

    try {
      await dbConnection.execute('ALTER TABLE attendance ADD COLUMN academic_year VARCHAR(20)');
      await dbConnection.execute('ALTER TABLE attendance ADD COLUMN semester VARCHAR(50)');
      console.log('Added academic fields to attendance');
    } catch (e) { }


    // Create assignments table
    await dbConnection.execute(`
      CREATE TABLE IF NOT EXISTS assignments (
        id INT AUTO_INCREMENT PRIMARY KEY,
        class_id INT NOT NULL,
        course_id INT,
        assignment_type ENUM('homework', 'project', 'lab', 'reading', 'worksheet') DEFAULT 'homework',
        title VARCHAR(200) NOT NULL,
        description TEXT,
        learning_objectives TEXT,
        additional_links TEXT,
        due_date DATE,
        max_points DECIMAL(5,2) DEFAULT 100.00,
        time_limit INT,
        attempts_allowed ENUM('1', '2', '3', 'unlimited') DEFAULT 'unlimited',
        visible_to_students BOOLEAN DEFAULT TRUE,
        created_by INT,
        teacher_id INT,
        academic_year VARCHAR(20),
        semester VARCHAR(50),
        semester_id VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE,
        FOREIGN KEY (created_by) REFERENCES teachers(id) ON DELETE SET NULL,
        FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE SET NULL,
        FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE SET NULL,
        INDEX idx_class_id (class_id),
        INDEX idx_due_date (due_date),
        INDEX idx_created_by (created_by)
      )
    `);

    try {
      await dbConnection.execute('ALTER TABLE assignments ADD COLUMN academic_year VARCHAR(20)');
      await dbConnection.execute('ALTER TABLE assignments ADD COLUMN semester VARCHAR(50)');
      console.log('Added academic fields to assignments');
    } catch (e) { }
    await dbConnection.execute(`
      CREATE TABLE IF NOT EXISTS course_prerequisites (
        id INT AUTO_INCREMENT PRIMARY KEY,
        course_id INT NOT NULL,
        prerequisite_id INT NOT NULL,
        FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE,
        FOREIGN KEY (prerequisite_id) REFERENCES courses(id) ON DELETE CASCADE,
        UNIQUE KEY unique_prerequisite (course_id, prerequisite_id),
        INDEX idx_course_id (course_id)
      )
    `);

    // Create class_schedule table
    await dbConnection.execute(`
      CREATE TABLE IF NOT EXISTS class_schedule (
        id INT AUTO_INCREMENT PRIMARY KEY,
        class_id INT NOT NULL,
        course_id INT NOT NULL,
        teacher_id INT,
        academic_year VARCHAR(20),
        semester VARCHAR(50) DEFAULT 'Semester 1',
        semester_id VARCHAR(50) DEFAULT 'Semester 1',
        day_of_week ENUM('Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday') NOT NULL,
        start_time TIME NOT NULL,
        end_time TIME NOT NULL,
        room VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE,
        FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE SET NULL,
        INDEX idx_class_day (class_id, day_of_week)
      )
    `);

    // Add period column to class_schedule if missing
    try {
      await dbConnection.execute('ALTER TABLE class_schedule ADD COLUMN period VARCHAR(50)');
      console.log('Added period to class_schedule table');
    } catch (e) {
      if (e.code !== 'ER_DUP_FIELDNAME') throw e;
    }

    // Create subjects table
    await dbConnection.execute(`
      CREATE TABLE IF NOT EXISTS subjects (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        code VARCHAR(20) UNIQUE NOT NULL,
        description TEXT,
        department VARCHAR(100),
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_code (code),
        INDEX idx_department (department)
      )
    `);

    // Create teacher_subjects table
    await dbConnection.execute(`
      CREATE TABLE IF NOT EXISTS teacher_subjects (
        id INT AUTO_INCREMENT PRIMARY KEY,
        teacher_id INT NOT NULL,
        subject_id INT NOT NULL,
        assigned_date DATE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE,
        FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE,
        UNIQUE KEY unique_teacher_subject (teacher_id, subject_id),
        INDEX idx_teacher_id (teacher_id),
        INDEX idx_subject_id (subject_id)
      )
    `);

    // Create messages table
    await dbConnection.execute(`
      CREATE TABLE IF NOT EXISTS messages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        sender_id INT NOT NULL,
        recipient_type ENUM('admin', 'student', 'parent', 'teacher', 'class') NOT NULL,
        recipient_id INT,
        subject VARCHAR(200) NOT NULL,
        content TEXT NOT NULL,
        is_read BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
        INDEX idx_sender_id (sender_id),
        INDEX idx_recipient (recipient_type, recipient_id),
        INDEX idx_created_at (created_at)
      )
    `);

    // Create parent_student_relations table
    await dbConnection.execute(`
      CREATE TABLE IF NOT EXISTS parent_student_relations (
        id INT AUTO_INCREMENT PRIMARY KEY,
        parent_id INT NOT NULL,
        student_id INT NOT NULL,
        relationship ENUM('father', 'mother', 'guardian', 'other') NOT NULL,
        is_primary BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (parent_id) REFERENCES parents(id) ON DELETE CASCADE,
        FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
        UNIQUE KEY unique_parent_student (parent_id, student_id),
        INDEX idx_parent_id (parent_id),
        INDEX idx_student_id (student_id)
      )
    `);

    // Create grades table
    await dbConnection.execute(`
      CREATE TABLE IF NOT EXISTS grades (
        id INT AUTO_INCREMENT PRIMARY KEY,
        student_id INT NOT NULL,
        class_id INT NOT NULL,
        course_id INT,
        teacher_id INT,
        academic_year VARCHAR(20),
        semester VARCHAR(50),
        semester_id VARCHAR(50),
        assessment_type ENUM('quiz', 'attendance', 'mid-exam', 'final-exam', 'homework', 'exam', 'project', 'participation') NOT NULL,
        title VARCHAR(100) NOT NULL,
        score DECIMAL(5,2) NOT NULL,
        mid_score DECIMAL(5,2) DEFAULT '0.00',
        test_score DECIMAL(5,2) DEFAULT '0.00',
        attendance_score DECIMAL(5,2) DEFAULT '0.00',
        final_score DECIMAL(5,2) DEFAULT '0.00',
        max_score DECIMAL(5,2) NOT NULL,
        weight DECIMAL(5,2) DEFAULT 1.0,
        grade_date DATE,
        notes TEXT,
        status ENUM('pending', 'approved', 'rejected') DEFAULT 'pending',
        created_by INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
        FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE,
        FOREIGN KEY (created_by) REFERENCES teachers(id) ON DELETE SET NULL,
        FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE SET NULL,
        INDEX idx_student_class_grade (student_id, class_id),
        INDEX idx_assessment_type (assessment_type),
        INDEX idx_grade_date (grade_date),
        INDEX idx_created_by (created_by)
      )
    `);

      // Create system_settings table before any settings-dependent initialization
      await dbConnection.execute(`
        CREATE TABLE IF NOT EXISTS system_settings (
          id INT AUTO_INCREMENT PRIMARY KEY,
          setting_key VARCHAR(100) UNIQUE NOT NULL,
          setting_value TEXT,
          category VARCHAR(50),
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_key (setting_key),
          INDEX idx_category (category)
        )
      `);

      // Create academic_sessions table – stores distinct year+semester sessions
      await dbConnection.execute(`
        CREATE TABLE IF NOT EXISTS academic_sessions (
          id INT AUTO_INCREMENT PRIMARY KEY,
          academic_year VARCHAR(20) NOT NULL,
          semester ENUM('Semester 1','Semester 2') NOT NULL,
          start_date DATE,
          end_date DATE,
          is_active BOOLEAN DEFAULT FALSE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY uq_year_semester (academic_year, semester)
        )
      `);
      // Ensure at least one active session based on current system settings
      const [existing] = await dbConnection.execute('SELECT id FROM academic_sessions WHERE is_active = 1');
      if (existing.length === 0) {
        const aYear = await getActiveAcademicYear();
        const semRaw = await getSetting('semester', DEFAULT_SEMESTER);
        const semester = formatSemesterLabel(semRaw);
        await dbConnection.execute(
          'INSERT INTO academic_sessions (academic_year, semester, is_active) VALUES (?, ?, TRUE)',
          [aYear, semester]
        );
      }

    // Create grading_structures table (Flexible Assessment Templates)
    await dbConnection.execute(`
      CREATE TABLE IF NOT EXISTS grading_structures (
        id INT AUTO_INCREMENT PRIMARY KEY,
        teacher_id INT NOT NULL,
        course_id INT NULL,
        class_id INT NOT NULL,
        semester VARCHAR(50) NOT NULL DEFAULT 'Semester 1',
        semester_id VARCHAR(50) NULL,
        academic_year VARCHAR(20) NULL,
        status ENUM('draft', 'pending', 'approved', 'rejected') DEFAULT 'draft',
        feedback TEXT,
        total_weight DECIMAL(5,2) DEFAULT '0.00',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE,
        FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE,
        FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE,
        UNIQUE KEY unique_structure (teacher_id, course_id, class_id, semester)
      )
    `);

    // Create assessment_categories table
    await dbConnection.execute(`
      CREATE TABLE IF NOT EXISTS assessment_categories (
        id INT AUTO_INCREMENT PRIMARY KEY,
        structure_id INT NOT NULL,
        name VARCHAR(100) NOT NULL,
        weight_percentage DECIMAL(5,2) NOT NULL,
        max_mark DECIMAL(5,2) NOT NULL,
        passing_mark DECIMAL(5,2),
        description TEXT,
        order_index INT DEFAULT 0,
        FOREIGN KEY (structure_id) REFERENCES grading_structures(id) ON DELETE CASCADE
      )
    `);

    // Create student_results table for dynamic grades
    await dbConnection.execute(`
      CREATE TABLE IF NOT EXISTS student_results (
        id INT AUTO_INCREMENT PRIMARY KEY,
        student_id INT NOT NULL,
        category_id INT NOT NULL,
        score DECIMAL(5,2) NOT NULL,
        graded_by INT,
        teacher_id INT,
        class_id INT,
        course_id INT,
        semester VARCHAR(50),
        semester_id VARCHAR(50),
        academic_year VARCHAR(20),
        grade_date DATE,
        status ENUM('pending', 'approved', 'rejected') DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
        FOREIGN KEY (category_id) REFERENCES assessment_categories(id) ON DELETE CASCADE,
        FOREIGN KEY (graded_by) REFERENCES teachers(id) ON DELETE SET NULL,
        FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE SET NULL,
        FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE SET NULL,
        FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE SET NULL,
        UNIQUE KEY unique_student_category (student_id, category_id),
        INDEX idx_student_results_owner_course (teacher_id, class_id, course_id, academic_year, semester)
      )
    `);

    for (const statement of [
      'ALTER TABLE student_results ADD COLUMN academic_year VARCHAR(20)',
      'ALTER TABLE student_results ADD COLUMN semester VARCHAR(50)',
    ]) {
      try {
        await dbConnection.execute(statement);
      } catch (e) {
        if (e.code !== 'ER_DUP_FIELDNAME') throw e;
      }
    }

    try {
      await dbConnection.execute(
        'ALTER TABLE student_results ADD INDEX idx_student_results_owner_course (teacher_id, class_id, course_id, academic_year, semester)'
      );
    } catch (e) {
      if (e.code !== 'ER_DUP_KEYNAME') throw e;
    }

    // Create materials table if missing
    await dbConnection.execute(`
      CREATE TABLE IF NOT EXISTS materials (
        id INT AUTO_INCREMENT PRIMARY KEY,
        class_id INT NOT NULL,
        course_id INT,
        teacher_id INT NOT NULL,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        file_url VARCHAR(512),
        material_type VARCHAR(50) DEFAULT 'reading',
        academic_year VARCHAR(20),
        semester VARCHAR(50),
        semester_id VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE,
        FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE,
        FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE SET NULL,
        INDEX idx_class (class_id),
        INDEX idx_teacher (teacher_id)
      )
    `);

    // Create teacher_activities table
    await dbConnection.execute(`
      CREATE TABLE IF NOT EXISTS teacher_activities (
        id INT AUTO_INCREMENT PRIMARY KEY,
        teacher_id INT NOT NULL,
        activity_type VARCHAR(100) NOT NULL,
        description TEXT,
        class_id INT,
        course_id INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE,
        INDEX idx_teacher (teacher_id),
        INDEX idx_created_at (created_at)
      )
    `);
    await dbConnection.execute(`
      CREATE TABLE IF NOT EXISTS contact_messages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(100) NOT NULL,
        subject VARCHAR(200) NOT NULL,
        message TEXT NOT NULL,
        is_read BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_email (email),
        INDEX idx_is_read (is_read)
      )
    `);
    await dbConnection.execute(`
      CREATE TABLE IF NOT EXISTS testimonials (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        role VARCHAR(100) NOT NULL,
        quote TEXT NOT NULL,
        rating TINYINT UNSIGNED NOT NULL DEFAULT 5,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        sort_order INT NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_testimonials_active_order (is_active, sort_order, id)
      )
    `);

    const [existingTestimonials] = await dbConnection.execute(
      'SELECT id FROM testimonials LIMIT 1'
    );
    if (existingTestimonials.length === 0) {
      await dbConnection.execute(
        `INSERT INTO testimonials (name, role, quote, rating, sort_order)
         VALUES
          (?, ?, ?, 5, 1),
          (?, ?, ?, 5, 2),
          (?, ?, ?, 5, 3)`,
        [
          'Sarah Jenkins',
          'Parent',
          "The parent portal has completely changed how I stay involved in my child's education. Real-time updates on grades and attendance are a game-changer!",
          'Marcus Rodriguez',
          'Teacher',
          'Managing my classes and grading assignments used to take hours. Now, everything is streamlined into one beautiful, easy-to-use interface.',
          'Elena Thompson',
          'School Administrator',
          'The administrative tools are incredibly robust. Setting up the academic year and managing user permissions is completely hassle-free.',
        ]
      );
    }

    // Create academic_history table
    await dbConnection.execute(`
      CREATE TABLE IF NOT EXISTS academic_history (
        id INT AUTO_INCREMENT PRIMARY KEY,
        student_id INT NOT NULL,
        grade_level VARCHAR(10) NOT NULL,
        academic_year VARCHAR(20) NOT NULL,
        average_score DECIMAL(5,2),
        status ENUM('promoted', 'retained', 'graduated') NOT NULL,
        remarks TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
        INDEX idx_student_year (student_id, academic_year)
      )
    `);

    // Create system_settings table
    await dbConnection.execute(`
      CREATE TABLE IF NOT EXISTS system_settings (
        id INT AUTO_INCREMENT PRIMARY KEY,
        setting_key VARCHAR(100) UNIQUE NOT NULL,
        setting_value TEXT,
        category VARCHAR(50),
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_key (setting_key),
        INDEX idx_category (category)
      )
    `);

    // Academic year history (active year in system_settings; past years preserved)
    await dbConnection.execute(`
      CREATE TABLE IF NOT EXISTS academic_years (
        id INT AUTO_INCREMENT PRIMARY KEY,
        year_label VARCHAR(20) NOT NULL,
        is_active BOOLEAN DEFAULT FALSE,
        started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        ended_at TIMESTAMP NULL,
        changed_by INT NULL,
        notes TEXT,
        UNIQUE KEY unique_year_label (year_label),
        INDEX idx_active (is_active),
        FOREIGN KEY (changed_by) REFERENCES users(id) ON DELETE SET NULL
      )
    `);

    // Create announcements table
    await dbConnection.execute(`
      CREATE TABLE IF NOT EXISTS announcements (
        id INT AUTO_INCREMENT PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        message TEXT NOT NULL,
        audience ENUM('all', 'students', 'teachers', 'parents') DEFAULT 'all',
        created_by INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
        INDEX idx_audience (audience),
        INDEX idx_created_at (created_at)
      )
    `);
    console.log('Verified announcements table');

    // Create national_exams table
    await dbConnection.execute(`
      CREATE TABLE IF NOT EXISTS national_exams (
        id INT AUTO_INCREMENT PRIMARY KEY,
        student_id INT NOT NULL,
        exam_type ENUM('Grade 6', 'Grade 8') NOT NULL,
        academic_year VARCHAR(20) NOT NULL,
        total_score DECIMAL(5,2),
        result_status ENUM('Pass', 'Fail') DEFAULT 'Pass',
        remarks TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
        UNIQUE KEY unique_exam (student_id, exam_type),
        INDEX idx_student_exam (student_id, exam_type)
      )
    `);

    // Create transcripts table
    await dbConnection.execute(`
      CREATE TABLE IF NOT EXISTS transcripts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        student_id INT NOT NULL,
        transcript_number VARCHAR(50) UNIQUE NOT NULL,
        issued_date DATE NOT NULL,
        academic_years_covered TEXT, -- JSON or comma separated years
        remarks TEXT,
        issued_by INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
        FOREIGN KEY (issued_by) REFERENCES users(id) ON DELETE SET NULL,
        INDEX idx_transcript_num (transcript_number),
        INDEX idx_student_transcript (student_id)
      )
    `);

    // Create teacher_course_assignments table
    await dbConnection.execute(`
      CREATE TABLE IF NOT EXISTS teacher_course_assignments (
        id INT AUTO_INCREMENT PRIMARY KEY,
        teacher_id INT NOT NULL,
        class_id INT NOT NULL,
        course_id INT NOT NULL,
        academic_year VARCHAR(20),
        status ENUM('active', 'inactive') DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE,
        FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE,
        FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE,
        UNIQUE KEY unique_assignment (teacher_id, class_id, course_id),
        INDEX idx_teacher_class (teacher_id, class_id)
      )
    `);
    console.log('Verified teacher_course_assignments table');

    // Create grade_submissions table (Submissions by teacher for approval)
    await dbConnection.execute(`
      CREATE TABLE IF NOT EXISTS grade_submissions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        teacher_id INT NOT NULL,
        course_id INT NOT NULL,
        class_id INT NOT NULL,
        semester_id VARCHAR(50) NOT NULL,
        academic_year VARCHAR(20) NOT NULL,
        status ENUM('pending', 'approved', 'rejected') DEFAULT 'pending',
        submitted_by INT,
        submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        approved_by INT NULL,
        approved_at TIMESTAMP NULL,
        rejected_by INT NULL,
        rejected_at TIMESTAMP NULL,
        comments TEXT NULL,
        FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE,
        FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE,
        FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE,
        FOREIGN KEY (submitted_by) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY (rejected_by) REFERENCES users(id) ON DELETE SET NULL,
        UNIQUE KEY unique_grade_submission (teacher_id, course_id, class_id, semester_id, academic_year),
        INDEX idx_submission_search (teacher_id, course_id, class_id)
      )
    `);
    console.log('Verified grade_submissions table');

    // Create student_rankings table for storing calculated ranks
    await dbConnection.execute(`
      CREATE TABLE IF NOT EXISTS student_rankings (
        id INT AUTO_INCREMENT PRIMARY KEY,
        student_id INT NOT NULL,
        class_id INT NOT NULL,
        section VARCHAR(10) NOT NULL,
        semester VARCHAR(50) NOT NULL,
        academic_year VARCHAR(20) NOT NULL,
        average_score DECIMAL(5,2) NOT NULL,
        gpa DECIMAL(5,2) NOT NULL,
        rank_position INT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
        FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE,
        INDEX idx_student_class_year_sem (student_id, class_id, academic_year, semester)
      )
    `);
    console.log('Verified student_rankings table');

    // Create student_course_results table (Final course marks)
    await dbConnection.execute(`
      CREATE TABLE IF NOT EXISTS student_course_results (
        id INT AUTO_INCREMENT PRIMARY KEY,
        submission_id INT NULL,
        student_id INT NOT NULL,
        teacher_id INT NOT NULL,
        course_id INT NOT NULL,
        class_id INT NOT NULL,
        semester_id VARCHAR(50) NOT NULL,
        academic_year VARCHAR(20) NOT NULL,
        assessment_structure_id INT NOT NULL,
        total_score DECIMAL(5,2) NOT NULL,
        status ENUM('pending', 'approved', 'rejected') DEFAULT 'pending',
        submitted_by INT,
        submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        approved_by INT NULL,
        approved_at TIMESTAMP NULL,
        rejected_by INT NULL,
        rejected_at TIMESTAMP NULL,
        comments TEXT NULL,
        FOREIGN KEY (submission_id) REFERENCES grade_submissions(id) ON DELETE CASCADE,
        FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
        FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE,
        FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE,
        FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE,
        FOREIGN KEY (assessment_structure_id) REFERENCES grading_structures(id) ON DELETE CASCADE,
        FOREIGN KEY (submitted_by) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY (rejected_by) REFERENCES users(id) ON DELETE SET NULL,
        UNIQUE KEY unique_student_course_result (student_id, course_id, semester_id, academic_year, assessment_structure_id),
        INDEX idx_course_result_search (student_id, course_id, semester_id)
      )
    `);
    console.log('Verified student_course_results table');

    // Create approvals_log table (Centralized audit log)
    await dbConnection.execute(`
      CREATE TABLE IF NOT EXISTS approvals_log (
        id INT AUTO_INCREMENT PRIMARY KEY,
        entity_type ENUM('grading_structure', 'student_course_result', 'grade_submission', 'attendance') NOT NULL,
        entity_id INT NOT NULL,
        action ENUM('approve', 'reject') NOT NULL,
        performed_by INT NOT NULL,
        comments TEXT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (performed_by) REFERENCES users(id) ON DELETE CASCADE,
        INDEX idx_approval_entity (entity_type, entity_id)
      )
    `);
    console.log('Verified approvals_log table');

    // Create grade_change_logs table (Auditable grade changes)
    await dbConnection.execute(`
      CREATE TABLE IF NOT EXISTS grade_change_logs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        student_id INT NOT NULL,
        category_id INT NOT NULL,
        old_value DECIMAL(5,2) NULL,
        new_value DECIMAL(5,2) NOT NULL,
        comment TEXT NULL,
        edited_by INT NOT NULL,
        change_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
        FOREIGN KEY (category_id) REFERENCES assessment_categories(id) ON DELETE CASCADE,
        FOREIGN KEY (edited_by) REFERENCES teachers(id) ON DELETE CASCADE
      )
    `);
    console.log('Verified grade_change_logs table');

    // Create pending_registrations table for student/parent staging queue
    await dbConnection.execute(`
      CREATE TABLE IF NOT EXISTS pending_registrations (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(50) NOT NULL,
        email VARCHAR(100) NOT NULL,
        password VARCHAR(255) NOT NULL,
        first_name VARCHAR(50) NOT NULL,
        last_name VARCHAR(50) NOT NULL,
        role ENUM('student', 'parent') NOT NULL,
        phone VARCHAR(20),
        
        -- Student specific fields
        grade_level VARCHAR(10),
        section VARCHAR(10),
        date_of_birth DATE,
        gender ENUM('male', 'female') DEFAULT 'male',
        parent_guardian_name VARCHAR(100),
        address TEXT,
        previous_school VARCHAR(255),
        admission_type ENUM('new', 'transfer') DEFAULT 'new',
        transfer_date DATE,
        transfer_reason TEXT,
        profile_picture VARCHAR(255),
        transcripts_json TEXT, -- Store list of transcripts as JSON string
        
        -- Parent specific fields
        occupation VARCHAR(100),
        relationship VARCHAR(50),
        
        status ENUM('pending', 'approved', 'rejected') DEFAULT 'pending',
        admin_feedback TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_pending_email (email),
        INDEX idx_pending_username (username),
        INDEX idx_pending_status (status)
      )
    `);
    console.log('Verified pending_registrations table');

    // Create approved_results view (Strict final transcript data source)
    await dbConnection.execute(`
      CREATE OR REPLACE VIEW approved_results AS
        SELECT * FROM student_course_results WHERE status IN ('approved','saved')
    `);
    console.log('Verified approved_results view');

    // === SAFE MIGRATIONS ===
    // Fix: course_id FK in grade_submissions and student_course_results prevents homeroom
    // grades (course_id = 0). Drop FKs and make column nullable.
    const migrations = [
      // grade_submissions: drop FK, make nullable
      `ALTER TABLE grade_submissions DROP FOREIGN KEY grade_submissions_ibfk_2`,
      `ALTER TABLE grade_submissions MODIFY COLUMN course_id INT NULL`,
      // student_course_results: drop FK, make nullable
      `ALTER TABLE student_course_results DROP FOREIGN KEY student_course_results_ibfk_4`,
      `ALTER TABLE student_course_results MODIFY COLUMN course_id INT NULL`,
      // Fix UNIQUE KEY to allow one row per student+structure (not one row per student+course+semester)
      `ALTER TABLE student_course_results DROP INDEX unique_student_course_result`,
      `ALTER TABLE student_course_results ADD UNIQUE KEY unique_student_course_result (student_id, course_id, semester_id, academic_year, assessment_structure_id)`,
      `ALTER TABLE grade_change_logs ADD COLUMN comment TEXT NULL`,
      // Enforce Designated Attendance Teacher per class
      `ALTER TABLE classes ADD COLUMN attendance_teacher_id INT NULL`,
      `ALTER TABLE classes ADD CONSTRAINT fk_classes_attendance_teacher FOREIGN KEY (attendance_teacher_id) REFERENCES teachers(id) ON DELETE SET NULL`,
      // Expand grade status ENUM values
      `ALTER TABLE grade_submissions MODIFY COLUMN status ENUM('draft', 'saved', 'submitted', 'pending', 'approved', 'rejected') DEFAULT 'draft'`,
      `ALTER TABLE student_course_results MODIFY COLUMN status ENUM('draft', 'saved', 'submitted', 'pending', 'approved', 'rejected') DEFAULT 'draft'`,
      `ALTER TABLE student_results MODIFY COLUMN status ENUM('draft', 'saved', 'submitted', 'pending', 'approved', 'rejected') DEFAULT 'draft'`,
    ];
    for (const sql of migrations) {
      try { await dbConnection.execute(sql); } catch (e) { /* Already applied or constraint name differs — safe to ignore */ }
    }
    console.log('Schema migrations applied');

    console.log('Database and tables created successfully');

    // === SEED DEFAULT ADMIN ===
    const bcrypt = require('bcryptjs');
    const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
    const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@abdigudina.edu';
    const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
    const ADMIN_SECRET = process.env.ADMIN_SECRET || 'ABDIGUDINA-ADMIN-2024';

    const [existingAdmin] = await dbConnection.execute(
      'SELECT id FROM users WHERE username = ? OR email = ?',
      [ADMIN_USERNAME, ADMIN_EMAIL]
    );

    if (existingAdmin.length === 0) {
      const hashedPw = await bcrypt.hash(ADMIN_PASSWORD, 12);
      await dbConnection.execute(
        `INSERT INTO users (username, email, password, first_name, last_name, role, is_active, created_at)
         VALUES (?, ?, ?, 'System', 'Administrator', 'admin', 1, NOW())`,
        [ADMIN_USERNAME, ADMIN_EMAIL, hashedPw]
      );
      console.log(`>>> DEFAULT ADMIN CREATED: username="${ADMIN_USERNAME}"  secret="${ADMIN_SECRET}"`);
    }
    // ===========================

    // Seed active academic year (2025-2026) and preserve history
    const DEFAULT_YEAR = '2025-2026';
    const [yearRows] = await dbConnection.execute(
      'SELECT COUNT(*) as cnt FROM academic_years'
    );
    if (yearRows[0].cnt === 0) {
      await dbConnection.execute(
        `INSERT INTO academic_years (year_label, is_active, notes) VALUES (?, 1, 'Initial active year')`,
        [DEFAULT_YEAR]
      );
    }
    const [aySetting] = await dbConnection.execute(
      'SELECT setting_value FROM system_settings WHERE setting_key = ?',
      ['academicYear']
    );
    const currentAy =
      aySetting.length > 0 ? aySetting[0].setting_value : null;
    if (
      !currentAy ||
      currentAy === '2023-2024' ||
      currentAy === '2023/2024'
    ) {
      const [exists] = await dbConnection.execute(
        'SELECT id FROM system_settings WHERE setting_key = ?',
        ['academicYear']
      );
      if (exists.length > 0) {
        await dbConnection.execute(
          'UPDATE system_settings SET setting_value = ?, category = ? WHERE setting_key = ?',
          [DEFAULT_YEAR, 'academic', 'academicYear']
        );
      } else {
        await dbConnection.execute(
          'INSERT INTO system_settings (setting_key, setting_value, category) VALUES (?, ?, ?)',
          ['academicYear', DEFAULT_YEAR, 'academic']
        );
      }
    }

    dbConnection.release();
  } catch (error) {
    console.error('Database initialization error:', error);
    throw error;
  }
}

// Function to check if database exists
async function checkDatabaseExists() {
  try {
    const connection = await pool.getConnection();
    const [rows] = await connection.execute(`SHOW DATABASES LIKE '${process.env.DB_NAME || 'student_registration_system'}'`);
    connection.release();
    return rows.length > 0;
  } catch (error) {
    console.error('Database check error:', error);
    return false;
  }
}

// Function to get table structure
async function getTableStructure(tableName) {
  try {
    const connection = await pool.getConnection();
    const [rows] = await connection.execute(`DESCRIBE ${tableName}`);
    connection.release();
    return rows;
  } catch (error) {
    console.error(`Table structure error for ${tableName}:`, error);
    return [];
  }
}

// Function to check if table exists
async function checkTableExists(tableName) {
  try {
    const connection = await pool.getConnection();
    const [rows] = await connection.execute(`SHOW TABLES LIKE '${tableName}'`);
    connection.release();
    return rows.length > 0;
  } catch (error) {
    console.error(`Table check error for ${tableName}:`, error);
    return false;
  }
}

// Function to get database statistics
async function getDatabaseStats() {
  try {
    const connection = await pool.getConnection();
    const stats = {};

    // Get user counts by role
    const [userStats] = await connection.execute(`
      SELECT role, COUNT(*) as count 
      FROM users 
      WHERE is_active = TRUE 
      GROUP BY role
    `);
    stats.users = userStats;

    // Get course count
    const [courseStats] = await connection.execute(`
      SELECT COUNT(*) as count FROM courses WHERE is_active = TRUE
    `);
    stats.courses = courseStats[0].count;

    // Get enrollment count
    const [enrollmentStats] = await connection.execute(`
      SELECT COUNT(*) as count FROM enrollments WHERE status = 'enrolled'
    `);
    stats.enrollments = enrollmentStats[0].count;

    // Get grade count
    const [gradeStats] = await connection.execute(`
      SELECT COUNT(*) as count FROM grades
    `);
    stats.grades = gradeStats[0].count;

    connection.release();
    return stats;
  } catch (error) {
    console.error('Database stats error:', error);
    return {};
  }
}

// Function to backup database structure (returns SQL for tables)
async function getDatabaseSchema() {
  try {
    const connection = await pool.getConnection();
    const [tables] = await connection.execute(`SHOW TABLES`);
    const schema = [];

    for (const table of tables) {
      const tableName = Object.values(table)[0];
      const [createTable] = await connection.execute(`SHOW CREATE TABLE ${tableName}`);
      schema.push({
        table: tableName,
        sql: createTable[0]['Create Table']
      });
    }

    connection.release();
    return schema;
  } catch (error) {
    console.error('Database schema error:', error);
    return [];
  }
}

// Function to validate database integrity
async function validateDatabase() {
  try {
    const connection = await pool.getConnection();
    const issues = [];

    // Check for orphaned records
    const [orphanedTeachers] = await connection.execute(`
      SELECT t.id FROM teachers t 
      LEFT JOIN users u ON t.user_id = u.id 
      WHERE u.id IS NULL
    `);
    if (orphanedTeachers.length > 0) {
      issues.push(`Found ${orphanedTeachers.length} orphaned teacher records`);
    }

    const [orphanedStudents] = await connection.execute(`
      SELECT s.id FROM students s 
      LEFT JOIN users u ON s.user_id = u.id 
      WHERE u.id IS NULL
    `);
    if (orphanedStudents.length > 0) {
      issues.push(`Found ${orphanedStudents.length} orphaned student records`);
    }

    const [orphanedParents] = await connection.execute(`
      SELECT p.id FROM parents p 
      LEFT JOIN users u ON p.user_id = u.id 
      WHERE u.id IS NULL
    `);
    if (orphanedParents.length > 0) {
      issues.push(`Found ${orphanedParents.length} orphaned parent records`);
    }

    connection.release();
    return issues;
  } catch (error) {
    console.error('Database validation error:', error);
    return ['Database validation failed'];
  }
}

// Export all functions and the pool
module.exports = {
  pool,
  initDatabase,
  checkDatabaseExists,
  getTableStructure,
  checkTableExists,
  getDatabaseStats,
  getDatabaseSchema,
  validateDatabase
};
