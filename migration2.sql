ALTER TABLE materials ADD COLUMN course_id INT;
ALTER TABLE materials ADD CONSTRAINT fk_materials_course FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE SET NULL;
