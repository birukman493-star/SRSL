const { pool } = require('./db');

const DEFAULT_ACADEMIC_YEAR = '2025-2026';
const DEFAULT_SEMESTER = '1';

/** Normalize academic year labels (2025/2026 → 2025-2026) */
function normalizeAcademicYear(year) {
  if (!year || typeof year !== 'string') return '';
  return year.trim().replace(/\//g, '-');
}

/** Semester setting "1"|"2" → "Semester 1"|"Semester 2" */
function formatSemesterLabel(semesterValue) {
  const raw = String(semesterValue || DEFAULT_SEMESTER).trim();
  if (raw.toLowerCase().startsWith('semester')) return raw;
  const num = raw.replace(/\D/g, '') || '1';
  return `Semester ${num}`;
}

/** Semester setting → numeric "1" or "2" */
function parseSemesterNumber(semesterValue) {
  const raw = String(semesterValue || DEFAULT_SEMESTER).trim();
  if (raw.toLowerCase().includes('2')) return '2';
  return '1';
}

async function getSetting(key, defaultValue = '') {
  try {
    const [rows] = await pool.execute(
      'SELECT setting_value FROM system_settings WHERE setting_key = ?',
      [key]
    );
    return rows.length > 0 ? rows[0].setting_value : defaultValue;
  } catch (error) {
    console.error(`Get setting error (${key}):`, error);
    return defaultValue;
  }
}

async function updateSetting(key, value, category = 'general') {
  const [existing] = await pool.execute(
    'SELECT id FROM system_settings WHERE setting_key = ?',
    [key]
  );
  if (existing.length > 0) {
    await pool.execute(
      'UPDATE system_settings SET setting_value = ?, category = ? WHERE setting_key = ?',
      [value, category, key]
    );
  } else {
    await pool.execute(
      'INSERT INTO system_settings (setting_key, setting_value, category) VALUES (?, ?, ?)',
      [key, value, category]
    );
  }
}

async function getActiveAcademicYear() {
  const stored = await getSetting('academicYear', DEFAULT_ACADEMIC_YEAR);
  return normalizeAcademicYear(stored) || DEFAULT_ACADEMIC_YEAR;
}

async function getAcademicContext() {
  const academicYear = await getActiveAcademicYear();
  const semesterRaw = await getSetting('semester', DEFAULT_SEMESTER);
  const semester = parseSemesterNumber(semesterRaw);
  const semesterLabel = formatSemesterLabel(semesterRaw);
  return { academicYear, semester, semesterLabel, semesterRaw };
}

async function getAcademicYearHistory(limit = 20) {
  try {
    const [rows] = await pool.query(
      `SELECT ay.*, u.first_name, u.last_name
       FROM academic_years ay
       LEFT JOIN users u ON ay.changed_by = u.id
       ORDER BY ay.started_at DESC
       LIMIT ?`,
      [limit]
    );
    return rows;
  } catch (error) {
    console.error('Academic year history error:', error);
    return [];
  }
}

/**
 * When admin sets a new active academic year: archive previous, never delete records.
 */
async function setActiveAcademicYear(newYear, changedByUserId = null) {
  const normalized = normalizeAcademicYear(newYear);
  if (!normalized) throw new Error('Invalid academic year');

  const previous = await getActiveAcademicYear();
  if (previous === normalized) {
    return { changed: false, previous, current: normalized };
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    await conn.execute(
      'UPDATE academic_years SET is_active = 0, ended_at = COALESCE(ended_at, CURRENT_TIMESTAMP) WHERE is_active = 1'
    );

    const [existing] = await conn.execute(
      'SELECT id FROM academic_years WHERE year_label = ?',
      [normalized]
    );
    if (existing.length > 0) {
      await conn.execute(
        'UPDATE academic_years SET is_active = 1, ended_at = NULL, changed_by = ? WHERE id = ?',
        [changedByUserId, existing[0].id]
      );
    } else {
      await conn.execute(
        `INSERT INTO academic_years (year_label, is_active, started_at, changed_by)
         VALUES (?, 1, CURRENT_TIMESTAMP, ?)`,
        [normalized, changedByUserId]
      );
    }

    await conn.execute(
      'UPDATE system_settings SET setting_value = ?, category = ? WHERE setting_key = ?',
      [normalized, 'academic', 'academicYear']
    );
    const [check] = await conn.execute(
      'SELECT id FROM system_settings WHERE setting_key = ?',
      ['academicYear']
    );
    if (check.length === 0) {
      await conn.execute(
        'INSERT INTO system_settings (setting_key, setting_value, category) VALUES (?, ?, ?)',
        ['academicYear', normalized, 'academic']
      );
    }

    await conn.commit();
    return { changed: true, previous, current: normalized };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/** Emit real-time academic context to all dashboards */
function emitAcademicContextUpdate(app, payload) {
  const io = app && app.get ? app.get('io') : null;
  if (!io) return;
  io.emit('academicContextUpdated', payload);
  if (payload.semester !== undefined) {
    io.emit('semesterUpdated', payload);
  }
  if (payload.academicYear !== undefined) {
    io.emit('academicYearUpdated', payload);
  }
}

/** SQL fragment: resolve attendance course display name */
const ATTENDANCE_COURSE_NAME_SQL = `COALESCE(co.course_name, CONCAT(c.name, ' — Homeroom'))`;

/** Helper to calculate next academic year from current (2025-2026 -> 2026-2027) */
function getNextAcademicYear(currentYear) {
  if (!currentYear || typeof currentYear !== 'string') return '';
  const normalized = normalizeAcademicYear(currentYear);
  const parts = normalized.split('-');
  if (parts.length === 2) {
    const year1 = parseInt(parts[0]);
    const year2 = parseInt(parts[1]);
    if (!isNaN(year1) && !isNaN(year2)) {
      return `${year1 + 1}-${year2 + 1}`;
    }
  }
  return '';
}

module.exports = {
  DEFAULT_ACADEMIC_YEAR,
  DEFAULT_SEMESTER,
  normalizeAcademicYear,
  formatSemesterLabel,
  parseSemesterNumber,
  getSetting,
  updateSetting,
  getActiveAcademicYear,
  getAcademicContext,
  getAcademicYearHistory,
  setActiveAcademicYear,
  emitAcademicContextUpdate,
  ATTENDANCE_COURSE_NAME_SQL,
  getNextAcademicYear
};
