const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const express = require('express');

const queryLog = [];
const attendanceWrites = [];
const sectionAssignments = [
  { id: 10, name: 'Grade 10A', grade: '10', section: 'A', academic_year: '2025-2026', attendance_teacher_id: 1 },
  { id: 11, name: 'Grade 10B', grade: '10', section: 'B', academic_year: '2025-2026', attendance_teacher_id: 1 },
  { id: 20, name: 'Grade 11A', grade: '11', section: 'A', academic_year: '2025-2026', attendance_teacher_id: 2 },
];
const adminAttendanceRecord = {
  id: 900,
  student_id: 301,
  class_id: 20,
  class_name: 'Grade 11A',
  status: 'present',
};

const db = {
  async execute(sql, params = []) {
    queryLog.push({ sql, params });

    if (sql.includes('SELECT id FROM teachers WHERE user_id = ?')) {
      const teacherId = Number(params[0]) === 303 ? 3 : Number(params[0]) === 202 ? 2 : 1;
      return [[{ id: teacherId }], []];
    }
    if (sql.includes('SELECT id FROM classes WHERE attendance_teacher_id = ?')) {
      return [sectionAssignments
        .filter((section) => section.attendance_teacher_id === Number(params[0]))
        .slice(0, 1)
        .map((section) => ({ id: section.id })), []];
    }
    if (sql.includes('SELECT c.id as class_id, c.name as class_name')) {
      const teacherId = Number(params[0]);
      return [sectionAssignments
        .filter((section) => section.attendance_teacher_id === teacherId)
        .map((section) => ({
          class_id: section.id,
          class_name: section.name,
          grade: section.grade,
          section: section.section,
          student_count: 2,
        })), []];
    }
    if (sql.includes('SELECT c.*, c.attendance_teacher_id = ? as can_take_attendance')) {
      const teacherId = Number(params[0]);
      return [[
        ...sectionAssignments
          .filter((section) => [10, 11].includes(section.id))
          .map((section) => ({
            ...section,
            can_take_attendance: section.attendance_teacher_id === teacherId ? 1 : 0,
            student_count: 2,
          })),
        {
          id: 30,
          name: 'Grade 10C',
          grade: '10',
          section: 'C',
          attendance_teacher_id: null,
          can_take_attendance: 0,
          student_count: 2,
        },
      ], []];
    }
    if (sql.includes('SELECT id, name, grade, section, academic_year')) {
      const section = sectionAssignments.find((row) =>
        row.id === Number(params[0]) && row.attendance_teacher_id === Number(params[1])
      );
      return [section ? [{
        id: section.id,
        name: section.name,
        grade: section.grade,
        section: section.section,
        academic_year: section.academic_year,
      }] : [], []];
    }
    if (sql.includes('SELECT s.id as student_pk')) {
      return [[
        { student_pk: 301, first_name: 'Ada', last_name: 'Student', student_id: 'STU-301', status: 'present', notes: '', approval_status: 'approved' },
        { student_pk: 302, first_name: 'Sam', last_name: 'Student', student_id: 'STU-302', status: null, notes: null, approval_status: null },
      ], []];
    }
    if (sql.includes('FROM students s') && sql.includes('s.id IN (')) {
      const ids = params.slice(1).map(Number);
      return [Number(params[0]) === 10 ? ids.filter((id) => [301, 302].includes(id)).map((id) => ({ id })) : [], []];
    }
    if (sql.includes('INSERT INTO attendance')) {
      attendanceWrites.push({ sql, params });
      return [{ affectedRows: 1 }, []];
    }
    if (sql.includes('UPDATE attendance SET status = ?')) return [{ affectedRows: 1 }, []];
    if (sql.includes('DELETE FROM attendance WHERE id = ?')) return [{ affectedRows: 1 }, []];
    if (sql.includes('FROM attendance a')) return [[adminAttendanceRecord], []];
    if (sql.includes('SELECT id, name FROM classes ORDER BY name ASC')) {
      return [sectionAssignments.map(({ id, name }) => ({ id, name })), []];
    }
    if (sql.includes('FROM teachers t') && sql.includes('JOIN users u')) {
      return [[{ id: 1, first_name: 'Assigned', last_name: 'Teacher' }], []];
    }
    return [[], []];
  },
};

const dbPath = require.resolve('../config/db');
const settingsPath = require.resolve('../config/systemSettings');
const settingsControlPath = require.resolve('../config/settingsControl');
const teacherRoutesPath = require.resolve('../routes/teacher');
const adminRoutesPath = require.resolve('../routes/admin');
const originalModules = new Map([
  [dbPath, require.cache[dbPath]],
  [settingsPath, require.cache[settingsPath]],
  [settingsControlPath, require.cache[settingsControlPath]],
  [teacherRoutesPath, require.cache[teacherRoutesPath]],
  [adminRoutesPath, require.cache[adminRoutesPath]],
]);

require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: { pool: db },
};
require.cache[settingsPath] = {
  id: settingsPath,
  filename: settingsPath,
  loaded: true,
  exports: {
    getSetting: async () => '',
    updateSetting: async () => {},
    getAcademicContext: async () => ({
      academicYear: '2025-2026',
      semesterLabel: 'Semester 1',
    }),
    getAcademicYearHistory: async () => [],
    setActiveAcademicYear: async () => {},
    getNextAcademicYear: async () => '2026-2027',
    getActiveAcademicYear: async () => '2025-2026',
    emitAcademicContextUpdate: async () => {},
    normalizeAcademicYear: (year) => year,
    DEFAULT_ACADEMIC_YEAR: '2025-2026',
    ATTENDANCE_COURSE_NAME_SQL: 'co.course_name',
  },
};
require.cache[settingsControlPath] = {
  id: settingsControlPath,
  filename: settingsControlPath,
  loaded: true,
  exports: { updateSettings: async () => {} },
};

const teacherRoutes = require('../routes/teacher');
const adminRoutes = require('../routes/admin');
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  req.session = {
    user: {
      id: Number(req.headers['x-test-user']) || 101,
      role: req.headers['x-test-role'] || 'teacher',
    },
  };
  res.render = (view, locals) => res.json({
    view,
    locals,
    canTakeAttendance: res.locals.canTakeAttendance,
  });
  next();
});
app.use('/teacher', teacherRoutes);
app.use('/admin', adminRoutes);

let server;
let baseUrl;
before(async () => {
  server = await new Promise((resolve) => {
    const listeningServer = app.listen(0, () => resolve(listeningServer));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  for (const [modulePath, priorModule] of originalModules) {
    if (priorModule) require.cache[modulePath] = priorModule;
    else delete require.cache[modulePath];
  }
});

async function request(url, { userId = 101, role = 'teacher', ...options } = {}) {
  return fetch(`${baseUrl}${url}`, {
    ...options,
    headers: {
      'x-test-user': String(userId),
      'x-test-role': role,
      ...(options.headers || {}),
    },
  });
}

test('administrator attendance page includes records across sections', async () => {
  const response = await request('/admin/attendance', { role: 'admin' });
  assert.equal(response.status, 200);
  const page = await response.json();
  assert.equal(page.view, 'admin/attendance');
  assert.ok(page.locals.attendance.some((record) => record.id === adminAttendanceRecord.id));
  assert.ok(page.locals.attendance.some((record) => record.class_id === 20));
});

test('assigned teacher sees only their assigned classes and class-wide records', async () => {
  const indexResponse = await request('/teacher/attendance');
  assert.equal(indexResponse.status, 200);
  const index = await indexResponse.json();
  assert.equal(index.canTakeAttendance, true);
  assert.deepEqual(
    [...new Set(index.locals.assignments.map((assignment) => assignment.class_id))].sort(),
    [10, 11]
  );

  const recordsResponse = await request('/teacher/attendance/10/2026-10-28');
  assert.equal(recordsResponse.status, 200);
  const recordsPage = await recordsResponse.json();
  assert.equal(recordsPage.view, 'teacher/attendance');
  assert.equal(recordsPage.locals.attendance.length, 2);
  assert.ok(recordsPage.locals.attendance.every((record) => record.approval_status !== 'course-specific'));

  const otherSectionResponse = await request('/teacher/attendance/20/2026-10-28');
  assert.equal(otherSectionResponse.status, 403);
});

test('teacher classes page offers attendance only for explicitly designated classes', async () => {
  const response = await request('/teacher/classes');
  assert.equal(response.status, 200);
  const page = await response.json();
  assert.equal(page.view, 'teacher/classes');
  const [designatedClass, , nonDesignatedClass] = page.locals.classes;
  assert.equal(designatedClass.can_take_attendance, 1);
  assert.equal(nonDesignatedClass.can_take_attendance, 0);
});

test('unassigned teacher cannot see or access attendance pages or APIs', async () => {
  const indexResponse = await request('/teacher/attendance', { userId: 303 });
  assert.equal(indexResponse.status, 403);
  assert.equal((await indexResponse.json()).canTakeAttendance, false);

  const pageResponse = await request('/teacher/attendance/10/2026-10-28', { userId: 303 });
  assert.equal(pageResponse.status, 403);

  const writesBefore = attendanceWrites.length;
  const saveResponse = await request('/teacher/attendance/save', {
    userId: 303,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      classId: 10,
      date: '2026-10-28',
      attendance: { 301: { status: 'present' } },
    }),
  });
  assert.equal(saveResponse.status, 403);
  assert.equal(attendanceWrites.length, writesBefore);
});

test('assigned teacher can save attendance only for active students in their section', async () => {
  const response = await request('/teacher/attendance/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      classId: 10,
      date: '2026-10-28',
      attendance: { 301: { status: 'present' } },
    }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(attendanceWrites.length, 1);
  assert.ok(attendanceWrites[0].params.includes(301));
  assert.equal(attendanceWrites[0].params[2], null);
  assert.match(attendanceWrites[0].sql, /ON DUPLICATE KEY UPDATE/);
  assert.match(attendanceWrites[0].sql, /course_id = NULL/);

  const updateResponse = await request('/teacher/attendance/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      classId: 10,
      date: '2026-10-28',
      attendance: { 301: { status: 'late' } },
    }),
  });
  assert.equal(updateResponse.status, 200);
  assert.equal(attendanceWrites.length, 2);

  const writesBefore = attendanceWrites.length;
  const crossSectionResponse = await request('/teacher/attendance/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      classId: 10,
      date: '2026-10-28',
      attendance: { 999: { status: 'present' } },
    }),
  });
  assert.equal(crossSectionResponse.status, 403);
  assert.equal(attendanceWrites.length, writesBefore);

  const otherSectionResponse = await request('/teacher/attendance/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      classId: 20,
      date: '2026-10-28',
      attendance: { 301: { status: 'present' } },
    }),
  });
  assert.equal(otherSectionResponse.status, 403);
  assert.equal(attendanceWrites.length, writesBefore);
});

test('administrator can update and delete attendance records', async () => {
  const updateResponse = await request('/admin/attendance/900/update', {
    role: 'admin',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'excused', notes: 'Approved correction' }),
  });
  assert.equal(updateResponse.status, 200);
  assert.ok(updateResponse.url.endsWith('/admin/attendance'));
  assert.ok(queryLog.some(({ sql, params }) =>
    sql.includes('UPDATE attendance SET status = ?') &&
    params[0] === 'excused' && params[2] === 900
  ));

  const deleteResponse = await request('/admin/attendance/900/delete', {
    role: 'admin',
    method: 'POST',
  });
  assert.equal(deleteResponse.status, 200);
  assert.ok(deleteResponse.url.endsWith('/admin/attendance'));
  assert.ok(queryLog.some(({ sql, params }) =>
    sql.includes('DELETE FROM attendance WHERE id = ?') && params[0] === 900
  ));
});
