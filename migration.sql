CREATE TABLE IF NOT EXISTS class_students (
  id INT AUTO_INCREMENT PRIMARY KEY,
  student_id INT NOT NULL,
  class_id INT NOT NULL,
  enrollment_date DATE DEFAULT CURRENT_DATE,
  UNIQUE KEY uq_student_class (student_id, class_id),
  FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
  FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE
);
