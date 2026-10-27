const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const express = require('express');

const writes = [];
const gradeReads = [];
const courseReads = [];
let directCourseAssignment = true;
const fakePool = {
  async execute(sql, params = []) {
    if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) writes.push({ sql, params });
    if (/FROM student_results/i.test(sql)) gradeReads.push({ sql, params });
    if (sql === 'SELECT course_name FROM courses WHERE id = ?') courseReads.push({ sql, params });

    if (sql.includes('SELECT id FROM teachers WHERE user_id = ?')) {
      return [[{ id: Number(params[0]) === 101 ? 1 : 2 }], []];
    }
    if (sql.includes('SELECT COALESCE(') && sql.includes('FROM classes c')) {
      return [[{ course_name: 'Mathematics' }], []];
    }
    if (sql.includes('FROM teacher_course_assignments')) {
      return directCourseAssignment ? [[{ id: 1 }], []] : [[], []];
    }
    if (sql.includes('FROM class_schedule')) return [[{ id: 2 }], []];
    if (sql.startsWith('SELECT id FROM class_teachers WHERE teacher_id = ? AND class_id = ?')) {
      return [[{ id: 1 }], []];
    }
    if (sql.includes('FROM class_teachers')) {
      return [[], []];
    }
    if (sql.includes('FROM grading_structures')) {
      const teacherId = Number(params[0]);
      const ownedStructureId = teacherId === 1 ? 200 : 201;
      const requestedStructureId = sql.includes(' AND id = ?') ? Number(params[4]) : ownedStructureId;
      if (requestedStructureId !== ownedStructureId) return [[], []];

      return [[{
        id: ownedStructureId,
        teacher_id: teacherId,
        class_id: 10,
        course_id: 7,
        semester: 'Semester 1',
        status: 'approved',
      }], []];
    }
    if (sql.includes('SELECT * FROM assessment_categories')) {
      const structureId = Number(params[0]);
      return [[{
        id: structureId === 200 ? 300 : 301,
        name: 'Quiz',
        max_mark: 100,
        weight_percentage: 100,
        order_index: 0,
      }], []];
    }
    if (sql.includes('FROM students s') && sql.includes('ORDER BY u.first_name')) {
      return [[{ student_id: 55, first_name: 'Student', last_name: 'One', reference_id: 'S-55' }], []];
    }
    if (sql.includes('WHERE ac.structure_id = ? AND sr.teacher_id = ?')) {
      const teacherId = Number(params[1]);
      return [[{
        id: teacherId === 1 ? 909 : 910,
        student_id: 55,
        category_id: teacherId === 1 ? 300 : 301,
        score: teacherId === 1 ? 88 : 74,
        status: 'saved',
      }], []];
    }
    if (sql.includes('SELECT status FROM grade_submissions')) {
      return [[{ status: 'saved' }], []];
    }
    if (sql.includes('SELECT course_name FROM courses')) {
      return [[{ course_name: 'Mathematics' }], []];
    }
    if (sql.includes('SELECT grade, section FROM classes')) {
      return [[{ grade: '10', section: 'A' }], []];
    }
    if (sql.includes('WHERE sr.id = ? AND sr.teacher_id = ? AND gs.teacher_id = ?')) {
      return [[], []];
    }
    return [[], []];
  },
  async getConnection() {
    return {
      execute: (...args) => fakePool.execute(...args),
      beginTransaction: async () => {},
      commit: async () => {},
      rollback: async () => {},
      release: () => {},
    };
  },
};

const dbPath = require.resolve('../config/db');
const settingsPath = require.resolve('../config/systemSettings');
const priorDbModule = require.cache[dbPath];
const priorSettingsModule = require.cache[settingsPath];
require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: { pool: fakePool },
};
require.cache[settingsPath] = {
  id: settingsPath,
  filename: settingsPath,
  loaded: true,
  exports: {
    getAcademicContext: async () => ({
      academicYear: '2025-2026',
      semester: '1',
      semesterLabel: 'Semester 1',
    }),
    formatSemesterLabel: (semester) => semester,
    ATTENDANCE_COURSE_NAME_SQL: 'course_name',
    DEFAULT_ACADEMIC_YEAR: '2025-2026',
  },
};

const teacherRoutes = require('../routes/teacher');
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  req.session = {
    user: {
      id: Number(req.headers['x-test-user']),
      role: 'teacher',
    },
  };
  res.render = (view, locals) => res.json({ view, locals });
  next();
});
app.use('/teacher', teacherRoutes);

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
  if (priorDbModule) require.cache[dbPath] = priorDbModule;
  else delete require.cache[dbPath];
  if (priorSettingsModule) require.cache[settingsPath] = priorSettingsModule;
  else delete require.cache[settingsPath];
});

async function request(path, userId, method = 'GET', body) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'x-test-user': String(userId),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

test('each teacher can view their own grades without seeing the other teacher grades', async () => {
  const ownResponse = await request('/teacher/grades/10/7', 101);
  assert.equal(ownResponse.status, 200);
  const ownPage = await ownResponse.json();
  assert.equal(ownPage.locals.courseName, 'Mathematics');
  assert.equal(ownPage.locals.studentResults['55']['300'].id, 909);
  assert.ok(courseReads.some(({ sql, params }) =>
    sql === 'SELECT course_name FROM courses WHERE id = ?' && Number(params[0]) === 7
  ));

  gradeReads.length = 0;
  const secondTeacherResponse = await request('/teacher/grades/10/7', 102);
  assert.equal(secondTeacherResponse.status, 200);
  const secondTeacherPage = await secondTeacherResponse.json();
  assert.equal(secondTeacherPage.locals.studentResults['55']['301'].id, 910);
  assert.equal(secondTeacherPage.locals.studentResults['55']['300'], undefined);
  assert.equal(gradeReads.length, 1);
});

test('teacher general-grade routes display their assigned course name', async () => {
  const response = await request('/teacher/grades/10/0', 101);
  assert.equal(response.status, 200);
  const page = await response.json();
  assert.equal(page.locals.courseName, 'Mathematics', JSON.stringify(page));
  assert.notEqual(page.locals.courseName, 'General Grade');
});

test('scheduled course assignment is accepted for only the scheduled teacher/course', async () => {
  directCourseAssignment = false;
  try {
    const response = await request('/teacher/grades/10/7', 101);
    assert.equal(response.status, 200);
    const page = await response.json();
    assert.equal(page.locals.courseName, 'Mathematics');
  } finally {
    directCourseAssignment = true;
  }
});

test("manually supplying another teacher's structure ID cannot save or edit either teacher's grades", async () => {
  writes.length = 0;
  for (const attempt of [
    { userId: 102, structureId: 200, categoryId: 300 },
    { userId: 101, structureId: 201, categoryId: 301 },
  ]) {
    const payload = {
      classId: 10,
      courseId: 7,
      structureId: attempt.structureId,
      studentResults: { 55: { [attempt.categoryId]: 90 } },
    };

    const saveResponse = await request('/teacher/grades/save', attempt.userId, 'POST', payload);
    assert.equal(saveResponse.status, 403);
    const editResponse = await request('/teacher/grades/edit', attempt.userId, 'POST', payload);
    assert.equal(editResponse.status, 403);
  }
  assert.equal(writes.length, 0);
});

test("manually supplying another teacher's grade ID cannot delete either teacher's grade", async () => {
  writes.length = 0;
  for (const attempt of [
    { userId: 102, gradeId: 909 },
    { userId: 101, gradeId: 910 },
  ]) {
    const response = await request(`/teacher/grades/${attempt.gradeId}`, attempt.userId, 'DELETE');
    assert.equal(response.status, 404);
  }
  assert.equal(writes.some(({ sql }) => /^\s*DELETE/i.test(sql)), false);
});
