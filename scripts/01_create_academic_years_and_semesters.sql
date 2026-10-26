/* scripts/01_create_academic_years_and_semesters.sql */
CREATE TABLE IF NOT EXISTS academic_years (
  id INT AUTO_INCREMENT PRIMARY KEY,
  year_label VARCHAR(9) NOT NULL UNIQUE,
  status ENUM('active','archived') NOT NULL DEFAULT 'active'
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS semesters (
  id INT AUTO_INCREMENT PRIMARY KEY,
  academic_year_id INT NOT NULL,
  label ENUM('Semester 1','Semester 2') NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status ENUM('active','closed') NOT NULL DEFAULT 'active',
  CONSTRAINT fk_sem_year FOREIGN KEY (academic_year_id) REFERENCES academic_years(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Insert initial academic year 2025-2026 with two semesters (example dates)
INSERT INTO academic_years (year_label, status) VALUES ('2025-2026', 'active');
SET @yearId = LAST_INSERT_ID();
INSERT INTO semesters (academic_year_id, label, start_date, end_date, status) VALUES
  (@yearId, 'Semester 1', '2025-09-01', '2026-01-31', 'active'),
  (@yearId, 'Semester 2', '2026-02-01', '2026-06-30', 'closed');

-- System settings table to point to current active year/semester
CREATE TABLE IF NOT EXISTS system_settings (
  id INT PRIMARY KEY DEFAULT 1,
  current_academic_year_id INT NOT NULL,
  current_semester_id INT NOT NULL,
  semester_start DATE NOT NULL,
  semester_end DATE NOT NULL,
  year_status ENUM('ongoing','archived') NOT NULL DEFAULT 'ongoing',
  CONSTRAINT fk_setting_year FOREIGN KEY (current_academic_year_id) REFERENCES academic_years(id),
  CONSTRAINT fk_setting_semester FOREIGN KEY (current_semester_id) REFERENCES semesters(id)
) ENGINE=InnoDB;

INSERT INTO system_settings (id, current_academic_year_id, current_semester_id, semester_start, semester_end, year_status)
SELECT 1, ay.id, s.id, s.start_date, s.end_date, 'ongoing'
FROM academic_years ay JOIN semesters s ON ay.id = s.academic_year_id AND s.label = 'Semester 1'
WHERE ay.year_label = '2025-2026';
