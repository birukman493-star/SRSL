/* scripts/04_alter_academic_years.sql */
ALTER TABLE academic_years
  ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1 AFTER status,
  ADD COLUMN started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP AFTER is_active,
  ADD COLUMN ended_at DATETIME NULL AFTER started_at,
  ADD COLUMN changed_by INT NULL AFTER ended_at,
  ADD COLUMN notes TEXT NULL AFTER changed_by,
  ADD INDEX idx_academic_year_changed_by (changed_by),
  ADD CONSTRAINT fk_academic_year_changed_by FOREIGN KEY (changed_by) REFERENCES users(id) ON DELETE SET NULL;
