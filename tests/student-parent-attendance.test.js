const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const express = require('express');

const mockAttendance = [
  // Student 201: 2 present, 1 absent, 1 late (plus 1 duplicate on 2026-10-04, plus 1 course-based record)
  {
    id: 1,
    student_id: 201,
    class_id: 10,
    class_name: 'Grade 10A',
    class_grade: '10',
    section: 'A',
    date: '2026-10-01',
    status: 'present',
    course_id: null,
    notes: 'On time',
  },
  {
    id: 2,
    student_id: 201,
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
    student_id: 201,
    class_id: 10,
    class_name: 'Grade 10A',
    class_grade: '10',
    section: 'A',
    date: '2026-10-03',
    status: 'absent',
    course_id: null,
    notes: 'Excused illness',
  },
  {
    id: 4,
    student_id: 201,
    class_id: 10,
    class_name: 'Grade 10A',
    class_grade: '10',
    section: 'A',
    date: '2026-10-04',
    status: 'late',
    course_id: null,
    notes: 'Late bus',
  },
  // Duplicate on 2026-10-04:
  {
    id: 5,
    student_id: 201,
    class_id: 10,
    class_name: 'Grade 10A',
    class_grade: '10',
    section: 'A',
    date: '2026-10-04',
    status: 'late',
    course_id: null,
    notes: 'Duplicate',
  },
  // Course-specific record (should be ignored):
  {
    id: 6,
    student_id: 201,
    class_id: 10,
    class_name: 'Grade 10A',
    class_grade: '10',
    section: 'A',
    date: '2026-10-05',
    status: 'present',
    course_id: 88,
    notes: 'Course lecture only',
  },
];

const db = {
  async execute(sql, params = []) {
    // Student profile lookup
    if (sql.includes('FROM students s') && sql.includes('WHERE s.user_id = ?')) {
      return [[
        {
          id: 201,
          student_code: 'STU-201',
          grade_level: '10',
          section: 'A',
          first_name: 'Student',
          last_name: 'One',
          class_id: 10,
          class_name: 'Grade 10A',
          class_grade: '10',
          class_section: 'A',
          attendance_teacher_first_name: 'John',
          attendance_teacher_last_name: 'Teacher',
        },
      ], []];
    }

    // Parent profile lookup
    if (sql.includes('SELECT id FROM parents WHERE user_id = ?')) {
      return [[{ id: 501 }], []];
    }

    // Children list for parent
    if (sql.includes('SELECT s.*, u.email as student_email')) {
      return [[
        {
          id: 201,
          first_name: 'Student',
          last_name: 'One',
          grade_level: '10',
          section: 'A',
        },
      ], []];
    }

    // Parent-student relation check
    if (sql.includes('FROM students s') && sql.includes('parent_student_relations psr')) {
      const studentId = Number(params[1]);
      if (studentId === 201) {
        return [[
          {
            id: 201,
            student_code: 'STU-201',
            student_id: 'STU-201',
            grade_level: '10',
            section: 'A',
            first_name: 'Student',
            last_name: 'One',
            class_id: 10,
            class_name: 'Grade 10A',
            class_grade: '10',
            class_section: 'A',
            attendance_teacher_first_name: 'John',
            attendance_teacher_last_name: 'Teacher',
          },
        ], []];
      }
      // Access denied for other students
      return [[], []];
    }

    // Count query for /parent/children
    if (sql.includes('COUNT(DISTINCT CASE WHEN status')) {
      return [[{ present: 2, absent: 1, late: 1, total: 4 }], []];
    }

    if (sql.includes('FROM attendance a')) {
      let records = [...mockAttendance];
      if (sql.includes('a.date >= ? AND a.date <= ?')) {
        const [startDate, endDate] = params.slice(1);
        records = records.filter((r) => r.date >= startDate && r.date <= endDate);
      } else if (sql.includes('a.date = ?')) {
        const [dateParam] = params.slice(1);
        records = records.filter((r) => r.date === dateParam);
      }
      return [records, []];
    }

    return [[], []];
  },
};

const dbPath = require.resolve('../config/db');
const settingsPath = require.resolve('../config/systemSettings');
const settingsControlPath = require.resolve('../config/settingsControl');
const studentRoutesPath = require.resolve('../routes/student');
const parentRoutesPath = require.resolve('../routes/parent');

const originalModules = new Map([
  [dbPath, require.cache[dbPath]],
  [settingsPath, require.cache[settingsPath]],
  [settingsControlPath, require.cache[settingsControlPath]],
  [studentRoutesPath, require.cache[studentRoutesPath]],
  [parentRoutesPath, require.cache[parentRoutesPath]],
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

const studentRoutes = require('../routes/student');
const parentRoutes = require('../routes/parent');

const app = express();
app.use(express.json());

let currentTestUser = { id: 1001, role: 'student' };

app.use((req, res, next) => {
  req.session = { user: currentTestUser };
  res.render = (view, locals) => res.json({ view, locals });
  next();
});

app.use('/student', studentRoutes);
app.use('/parent', parentRoutes);

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

test('student attendance: provides per-student counts with present, absent, late, and rate', async () => {
  currentTestUser = { id: 1001, role: 'student' };
  const response = await fetch(`${baseUrl}/student/attendance`);
  assert.equal(response.status, 200);
  const data = await response.json();

  assert.equal(data.view, 'student/attendance');
  const { student, stats, attendance } = data.locals;

  // Student summary row
  assert.equal(student.student_id, 'STU-201');
  assert.equal(student.present_count, 2);
  assert.equal(student.absent_count, 1);
  assert.equal(student.late_count, 1);
  // Total equals present + absent + late (4 valid session days)
  assert.equal(student.total_count, 4);

  // Rate: (2 present + 1 late) / 4 = 75%
  assert.equal(student.rate, 75);
  assert.equal(stats.rate, '75');

  // Valid session logs deduplicated (4 records)
  assert.equal(attendance.length, 4);
});

test('student attendance: filters counts by date range', async () => {
  currentTestUser = { id: 1001, role: 'student' };
  const response = await fetch(`${baseUrl}/student/attendance?start_date=2026-10-01&end_date=2026-10-02`);
  assert.equal(response.status, 200);
  const data = await response.json();

  const { student, filters } = data.locals;
  assert.equal(filters.start_date, '2026-10-01');
  assert.equal(filters.end_date, '2026-10-02');

  // Only 2 dates in range: 2 present, 0 absent, 0 late
  assert.equal(student.present_count, 2);
  assert.equal(student.absent_count, 0);
  assert.equal(student.late_count, 0);
  assert.equal(student.total_count, 2);
});

test('parent attendance: provides per-student counts for linked child and enforces access control', async () => {
  currentTestUser = { id: 2001, role: 'parent' };

  // Accessible child
  const response = await fetch(`${baseUrl}/parent/attendance/201`);
  assert.equal(response.status, 200);
  const data = await response.json();

  assert.equal(data.view, 'parent/student-attendance');
  const { student, stats } = data.locals;
  assert.equal(student.student_id, 'STU-201');
  assert.equal(student.present_count, 2);
  assert.equal(student.absent_count, 1);
  assert.equal(student.late_count, 1);
  assert.equal(student.total_count, 4);
  assert.equal(stats.rate, 75);

  // Unlinked child: returns 403 Access Denied
  const forbiddenRes = await fetch(`${baseUrl}/parent/attendance/999`);
  assert.equal(forbiddenRes.status, 403);
});

test('parent children overview: displays class-based attendance counts', async () => {
  currentTestUser = { id: 2001, role: 'parent' };
  const response = await fetch(`${baseUrl}/parent/children`);
  assert.equal(response.status, 200);
  const data = await response.json();

  assert.equal(data.view, 'parent/children');
  const child = data.locals.children[0];
  assert.equal(child.present, 2);
  assert.equal(child.absent, 1);
  assert.equal(child.late, 1);
  assert.equal(child.total_attendance, 4);
});
