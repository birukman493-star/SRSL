const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const express = require('express');

const queryLog = [];

const mockAttendanceRows = [
  // Student 101 in Class 10: 2 present, 1 absent, 1 late across 4 distinct dates
  {
    id: 1,
    student_id: 101,
    student_code: 'STU-101',
    first_name: 'Biruk',
    last_name: 'Simon',
    class_id: 10,
    class_name: 'Grade 10A',
    class_grade: '10',
    section: 'A',
    date: '2026-10-01',
    status: 'present',
    course_id: null,
    notes: 'Good attendance',
  },
  {
    id: 2,
    student_id: 101,
    student_code: 'STU-101',
    first_name: 'Biruk',
    last_name: 'Simon',
    class_id: 10,
    class_name: 'Grade 10A',
    class_grade: '10',
    section: 'A',
    date: '2026-10-02',
    status: 'present',
    course_id: null,
    notes: '',
  },
  {
    id: 3,
    student_id: 101,
    student_code: 'STU-101',
    first_name: 'Biruk',
    last_name: 'Simon',
    class_id: 10,
    class_name: 'Grade 10A',
    class_grade: '10',
    section: 'A',
    date: '2026-10-03',
    status: 'absent',
    course_id: null,
    notes: 'Sick',
  },
  {
    id: 4,
    student_id: 101,
    student_code: 'STU-101',
    first_name: 'Biruk',
    last_name: 'Simon',
    class_id: 10,
    class_name: 'Grade 10A',
    class_grade: '10',
    section: 'A',
    date: '2026-10-04',
    status: 'late',
    course_id: null,
    notes: 'Traffic',
  },
  // Duplicate record for Student 101 on 2026-10-04 (must NOT be counted twice)
  {
    id: 5,
    student_id: 101,
    student_code: 'STU-101',
    first_name: 'Biruk',
    last_name: 'Simon',
    class_id: 10,
    class_name: 'Grade 10A',
    class_grade: '10',
    section: 'A',
    date: '2026-10-04',
    status: 'late',
    course_id: null,
    notes: 'Duplicate entry',
  },
  // Legacy course-based record for Student 101 (must NOT be counted in class attendance)
  {
    id: 6,
    student_id: 101,
    student_code: 'STU-101',
    first_name: 'Biruk',
    last_name: 'Simon',
    class_id: 10,
    class_name: 'Grade 10A',
    class_grade: '10',
    section: 'A',
    date: '2026-10-05',
    status: 'present',
    course_id: 99, // Course-specific record
    notes: 'Math course attendance',
  },

  // Student 102 in Class 10: 1 present, 2 absent
  {
    id: 7,
    student_id: 102,
    student_code: 'STU-102',
    first_name: 'Sara',
    last_name: 'Kebede',
    class_id: 10,
    class_name: 'Grade 10A',
    class_grade: '10',
    section: 'A',
    date: '2026-10-01',
    status: 'present',
    course_id: null,
    notes: '',
  },
  {
    id: 8,
    student_id: 102,
    student_code: 'STU-102',
    first_name: 'Sara',
    last_name: 'Kebede',
    class_id: 10,
    class_name: 'Grade 10A',
    class_grade: '10',
    section: 'A',
    date: '2026-10-02',
    status: 'absent',
    course_id: null,
    notes: '',
  },
  {
    id: 9,
    student_id: 102,
    student_code: 'STU-102',
    first_name: 'Sara',
    last_name: 'Kebede',
    class_id: 10,
    class_name: 'Grade 10A',
    class_grade: '10',
    section: 'A',
    date: '2026-10-03',
    status: 'absent',
    course_id: null,
    notes: '',
  },
];

const db = {
  async execute(sql, params = []) {
    queryLog.push({ sql, params });

    if (sql.includes('FROM attendance a')) {
      // Simulate filtering on date range if params provided
      let results = [...mockAttendanceRows];
      if (sql.includes('a.date >= ? AND a.date <= ?')) {
        const [startDate, endDate] = params;
        results = results.filter((r) => r.date >= startDate && r.date <= endDate);
      } else if (sql.includes('a.date = ?')) {
        const [dateParam] = params;
        results = results.filter((r) => r.date === dateParam);
      }
      return [results, []];
    }

    if (sql.includes('SELECT id, name FROM classes ORDER BY name ASC')) {
      return [[{ id: 10, name: 'Grade 10A' }, { id: 20, name: 'Grade 11A' }], []];
    }

    if (sql.includes('FROM teachers t') && sql.includes('JOIN users u')) {
      return [[{ id: 1, first_name: 'Assigned', last_name: 'Teacher' }], []];
    }

    if (sql.includes('FROM students s') && sql.includes('WHERE c.id = ?')) {
      return [[
        {
          student_pk: 101,
          student_code: 'STU-101',
          first_name: 'Biruk',
          last_name: 'Simon',
          class_id: 10,
          class_name: 'Grade 10A',
          class_grade: '10',
          class_section: 'A',
          attendance_teacher_first_name: 'Assigned',
          attendance_teacher_last_name: 'Teacher',
        },
        {
          student_pk: 102,
          student_code: 'STU-102',
          first_name: 'Sara',
          last_name: 'Kebede',
          class_id: 10,
          class_name: 'Grade 10A',
          class_grade: '10',
          class_section: 'A',
          attendance_teacher_first_name: 'Assigned',
          attendance_teacher_last_name: 'Teacher',
        },
      ], []];
    }

    return [[], []];
  },
};

const dbPath = require.resolve('../config/db');
const settingsPath = require.resolve('../config/systemSettings');
const settingsControlPath = require.resolve('../config/settingsControl');
const adminRoutesPath = require.resolve('../routes/admin');

const originalModules = new Map([
  [dbPath, require.cache[dbPath]],
  [settingsPath, require.cache[settingsPath]],
  [settingsControlPath, require.cache[settingsControlPath]],
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
  },
};
require.cache[settingsControlPath] = {
  id: settingsControlPath,
  filename: settingsControlPath,
  loaded: true,
  exports: { updateSettings: async () => {} },
};

const adminRoutes = require('../routes/admin');
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  req.session = {
    user: {
      id: 1,
      role: 'admin',
    },
  };
  res.render = (view, locals) => res.json({ view, locals });
  next();
});
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

async function request(url) {
  return fetch(`${baseUrl}${url}`);
}

test('per-student attendance counts: displays each student in one row with present, absent, late counts', async () => {
  const response = await request('/admin/attendance');
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.view, 'admin/attendance');

  const { attendance } = data.locals;
  assert.ok(Array.isArray(attendance));

  // Verify each student appears only once per class
  assert.equal(attendance.length, 2);

  // Student 101: 2 present, 1 absent, 1 late (duplicate on 2026-10-04 and course_id 99 are excluded)
  const student101 = attendance.find((s) => s.student_pk === 101 || s.student_id === 101 || s.student_code === 'STU-101');
  assert.ok(student101, 'Student 101 should be present in results');
  assert.equal(student101.present_count, 2, 'Present count should be 2');
  assert.equal(student101.absent_count, 1, 'Absent count should be 1');
  assert.equal(student101.late_count, 1, 'Late count should be 1');
  // Present + Absent + Late totals equal valid records for those 3 statuses: 2 + 1 + 1 = 4
  assert.equal(student101.total_count, 4, 'Total count should equal present + absent + late');

  // Student 102: 1 present, 2 absent, 0 late
  const student102 = attendance.find((s) => s.student_pk === 102 || s.student_id === 102 || s.student_code === 'STU-102');
  assert.ok(student102, 'Student 102 should be present in results');
  assert.equal(student102.present_count, 1, 'Present count should be 1');
  assert.equal(student102.absent_count, 2, 'Absent count should be 2');
  assert.equal(student102.late_count, 0, 'Late count should be 0');
  assert.equal(student102.total_count, 3, 'Total count should equal present + absent + late');
});

test('date range filtering updates counts for the selected period', async () => {
  // Query only for dates 2026-10-01 to 2026-10-02
  const response = await request('/admin/attendance?start_date=2026-10-01&end_date=2026-10-02');
  assert.equal(response.status, 200);
  const data = await response.json();
  const { attendance, filters } = data.locals;

  assert.equal(filters.start_date, '2026-10-01');
  assert.equal(filters.end_date, '2026-10-02');

  const student101 = attendance.find((s) => s.student_pk === 101 || s.student_code === 'STU-101');
  assert.ok(student101);
  // In range 2026-10-01 to 2026-10-02: 2 present, 0 absent, 0 late
  assert.equal(student101.present_count, 2);
  assert.equal(student101.absent_count, 0);
  assert.equal(student101.late_count, 0);
  assert.equal(student101.total_count, 2);

  const student102 = attendance.find((s) => s.student_pk === 102 || s.student_code === 'STU-102');
  assert.ok(student102);
  // In range 2026-10-01 to 2026-10-02: 1 present, 1 absent
  assert.equal(student102.present_count, 1);
  assert.equal(student102.absent_count, 1);
  assert.equal(student102.late_count, 0);
  assert.equal(student102.total_count, 2);
});

test('class-based filtering accurately isolates records for selected class', async () => {
  const response = await request('/admin/attendance?class_id=10');
  assert.equal(response.status, 200);
  const data = await response.json();
  const { attendance, filters } = data.locals;

  assert.equal(filters.class_id, '10');
  assert.ok(attendance.every((s) => s.class_id === 10));
});
