-- scripts/03_create_system_settings.sql
-- Creates a centralized settings table linking to the current academic year and semester
CREATE TABLE IF NOT EXISTS system_settings (
  id INT PRIMARY KEY AUTO_INCREMENT,
  current_academic_year_id INT NOT NULL,
  current_semester_id INT NOT NULL,
  semester_start DATE NOT NULL,
  semester_end DATE NOT NULL,
  year_status ENUM('ongoing','archived') NOT NULL DEFAULT 'ongoing',
  CONSTRAINT fk_current_year FOREIGN KEY (current_academic_year_id) REFERENCES academic_years(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT fk_current_semester FOREIGN KEY (current_semester_id) REFERENCES semesters(id) ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Seed with the initial year (2025-2026) and its Semester 1 as active
INSERT INTO system_settings (current_academic_year_id, current_semester_id, semester_start, semester_end, year_status)
SELECT ay.id, s.id, s.start_date, s.end_date, 'ongoing'
FROM academic_years ay
JOIN semesters s ON s.academic_year_id = ay.id AND s.label = 'Semester 1'
WHERE ay.year_label = '2025-2026'
LIMIT 1;
