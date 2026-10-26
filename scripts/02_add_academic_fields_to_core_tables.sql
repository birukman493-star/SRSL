/* scripts/02_add_academic_fields_to_core_tables.sql */
-- Add academic_year_id and semester_id columns to tables that need year/semester tracking

ALTER TABLE materials
  ADD COLUMN academic_year_id INT NULL,
  ADD COLUMN semester_id INT NULL,
  ADD CONSTRAINT fk_material_year FOREIGN KEY (academic_year_id) REFERENCES academic_years(id),
  ADD CONSTRAINT fk_material_semester FOREIGN KEY (semester_id) REFERENCES semesters(id);

ALTER TABLE grade_submissions
  ADD COLUMN academic_year_id INT NULL,
  ADD COLUMN semester_id INT NULL,
  ADD CONSTRAINT fk_grade_sub_year FOREIGN KEY (academic_year_id) REFERENCES academic_years(id),
  ADD CONSTRAINT fk_grade_sub_semester FOREIGN KEY (semester_id) REFERENCES semesters(id);

ALTER TABLE student_results
  ADD COLUMN academic_year_id INT NULL,
  ADD COLUMN semester_id INT NULL,
  ADD CONSTRAINT fk_student_res_year FOREIGN KEY (academic_year_id) REFERENCES academic_years(id),
  ADD CONSTRAINT fk_student_res_semester FOREIGN KEY (semester_id) REFERENCES semesters(id);

ALTER TABLE attendance
  ADD COLUMN academic_year_id INT NULL,
  ADD COLUMN semester_id INT NULL,
  ADD CONSTRAINT fk_attendance_year FOREIGN KEY (academic_year_id) REFERENCES academic_years(id),
  ADD CONSTRAINT fk_attendance_semester FOREIGN KEY (semester_id) REFERENCES semesters(id);

ALTER TABLE assignments
  ADD COLUMN academic_year_id INT NULL,
  ADD COLUMN semester_id INT NULL,
  ADD CONSTRAINT fk_assignments_year FOREIGN KEY (academic_year_id) REFERENCES academic_years(id),
  ADD CONSTRAINT fk_assignments_semester FOREIGN KEY (semester_id) REFERENCES semesters(id);

ALTER TABLE approved_results
  ADD COLUMN academic_year_id INT NULL,
  ADD COLUMN semester_id INT NULL,
  ADD CONSTRAINT fk_approved_year FOREIGN KEY (academic_year_id) REFERENCES academic_years(id),
  ADD CONSTRAINT fk_approved_semester FOREIGN KEY (semester_id) REFERENCES semesters(id);

ALTER TABLE student_course_results
  ADD COLUMN academic_year_id INT NULL,
  ADD COLUMN semester_id INT NULL,
  ADD CONSTRAINT fk_course_res_year FOREIGN KEY (academic_year_id) REFERENCES academic_years(id),
  ADD CONSTRAINT fk_course_res_semester FOREIGN KEY (semester_id) REFERENCES semesters(id);

-- Populate new columns for existing rows using current system settings
-- This is a one‑time fill; assumes system_settings already points to correct year/semester
INSERT INTO @tmp (SELECT current_academic_year_id, current_semester_id FROM system_settings WHERE id = 1);
-- (Manual step: run an UPDATE for each table setting the new columns to the values from system_settings)
