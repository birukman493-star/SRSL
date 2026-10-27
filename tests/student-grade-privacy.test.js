const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { after, before, test } = require('node:test');
const express = require('express');

const queries = [];
const coursePageQueries = [];
const result = {
  result_id: 501,
  student_id: 51,
  teacher_id: 8,
  course_id: 7,
  resolved_course_id: 7,
  class_id: 15,
  semester_id: 'Semester 1',
  academic_year: '2025-2026',
  assessment_structure_id: 90,
  total_score: 82,
  course_name: 'Mathematics',
  course_code: 'MATH-10',
  class_name: 'Grade 10A',
  teacher_fname: 'Teacher',
  teacher_lname: 'One',
};
const secondCourseResult = {
  ...result,
  result_id: 502,
  course_id: 8,
  total_score: 91,
  course_name: 'English',
  course_code: 'ENG-10',
};
const db = {
  async execute(sql, params = []) {
    queries.push({ sql, params });
    if (sql.includes('FROM courses c') && sql.includes('JOIN enrollments e')) {
      coursePageQueries.push({ sql, params });
      return [[{
        id: 7,
        course_name: 'Mathematics',
        course_code: 'MATH-10',
        status: 'enrolled',
        average_grade: 82,
      }], []];
    }
    if (sql.includes('SELECT id, class_id FROM students WHERE user_id = ?')) {
      return [[{ id: 51, class_id: 15 }], []];
    }
    if (sql.includes('FROM students WHERE user_id = ?')) {
      return [[{
        id: Number(params[0]) === 1001 ? 51 : 52,
        class_id: 15,
        grade_level: '10',
        section: 'A',
      }], []];
    }
    if (sql.includes('FROM student_course_results scr') && sql.includes('JOIN student_results sr')) {
      return Number(params[0]) === 51
        ? [[
          {
            result_id: 501,
            assessment_name: 'Quiz',
            score: 18,
            max_mark: 20,
            weight_percentage: 20,
          },
          {
            result_id: 502,
            assessment_name: 'Essay',
            score: 45,
            max_mark: 50,
            weight_percentage: 30,
          },
        ], []]
        : [[], []];
    }
    if (sql.includes('FROM student_course_results scr')) {
      return Number(params[0]) === 51 ? [[result, secondCourseResult], []] : [[], []];
    }
    if (sql.includes('SELECT id FROM classes')) return [[{ id: 15 }], []];
    if (sql.includes('SELECT COUNT(*) + 1 as student_rank')) return [[{ student_rank: 2 }], []];
    if (sql.includes('FROM attendance')) return [[{ present_count: 0, total_count: 0 }], []];
    return [[], []];
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
  exports: { pool: db },
};
require.cache[settingsPath] = {
  id: settingsPath,
  filename: settingsPath,
  loaded: true,
  exports: {
    getSetting: async () => '',
    getAcademicContext: async () => ({
      academicYear: '2025-2026',
      semesterLabel: 'Semester 1',
    }),
    DEFAULT_ACADEMIC_YEAR: '2025-2026',
    formatSemesterLabel: (semester) => semester,
    ATTENDANCE_COURSE_NAME_SQL: 'co.course_name',
  },
};

const studentRoutes = require('../routes/student');
const app = express();
app.use((req, res, next) => {
  req.session = {
    user: {
      id: Number(req.headers['x-test-user']),
      role: 'student',
    },
  };
  res.render = (view, locals) => res.json({ view, locals });
  next();
});
app.use('/student', studentRoutes);

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

async function request(url, userId) {
  return fetch(`${baseUrl}${url}`, {
    headers: { 'x-test-user': String(userId) },
  });
}

test('student grade API returns only the logged-in student’s saved assessment results', async () => {
  queries.length = 0;
  const response = await request('/student/api/grades', 1001);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.courses.length, 2);
  assert.equal(body.courses[0].course_name, 'Mathematics');
  assert.deepEqual(body.courses[0].assessments, [{
    assessment_name: 'Quiz',
    score: 18,
    max_mark: 20,
    weight_percentage: 20,
  }]);
  assert.equal(body.courses[1].course_name, 'English');
  assert.deepEqual(body.courses[1].assessments, [{
    assessment_name: 'Essay',
    score: 45,
    max_mark: 50,
    weight_percentage: 30,
  }]);
  assert.equal('structure_id' in body.courses[0], false);

  const resultQuery = queries.find(({ sql }) => sql.includes('FROM student_course_results scr'));
  assert.ok(resultQuery.sql.includes("scr.status IN ('approved', 'saved')"));
  assert.ok(resultQuery.sql.includes('co.course_name'));
  assert.ok(resultQuery.sql.includes('scheduled_course.course_id'));
  assert.ok(resultQuery.sql.includes('scheduled_course.teacher_id = scr.teacher_id'));
  assert.ok(resultQuery.sql.includes('HAVING COUNT(DISTINCT course_id) = 1'));
  assert.ok(resultQuery.sql.includes("e.status IN ('enrolled', 'completed')"));
  assert.ok(resultQuery.sql.includes('gs.teacher_id = scr.teacher_id'));
  assert.deepEqual(resultQuery.params, [51, '2025-2026', 'Semester 1']);
  const assessmentQuery = queries.find(({ sql }) =>
    sql.includes('FROM student_course_results scr') && sql.includes('JOIN student_results sr')
  );
  assert.ok(assessmentQuery.sql.includes('sr.score, ac.max_mark, ac.weight_percentage'));

  const otherStudentResponse = await request('/student/api/grades', 1002);
  assert.equal(otherStudentResponse.status, 200);
  assert.deepEqual((await otherStudentResponse.json()).courses, []);
});

test('student grades page receives assessment scores without grading configuration', async () => {
  queries.length = 0;
  const response = await request('/student/grades', 1001);
  assert.equal(response.status, 200);
  const page = await response.json();
  assert.equal(page.view, 'student/grades');
  assert.equal(page.locals.courseResults[1].course_name, 'English');
  assert.deepEqual(page.locals.courseResults[0].assessments, [
    {
      assessment_name: 'Quiz',
      score: 18,
      max_mark: 20,
      weight_percentage: 20,
    },
  ]);
  assert.equal('structure_id' in page.locals.courseResults[0], false);
  assert.equal(page.locals.courseResults[0].assessments[0].max_mark, 20);
  assert.equal(page.locals.courseResults[0].assessments[0].weight_percentage, 20);
  assert.equal(page.locals.overallSum, '173.0');
  assert.equal(page.locals.overallAvg, '86.5');
  assert.equal(page.locals.rank, 2);
  assert.ok(queries.some(({ sql }) => sql.includes('SELECT id, class_id, grade_level, section FROM students')));
  assert.ok(queries.some(({ sql }) => sql.includes('SELECT COUNT(*) + 1 as student_rank')));

  const template = fs.readFileSync(
    path.join(__dirname, '..', 'views', 'student', 'grades.html'),
    'utf8'
  );
  assert.match(template, /assessment\.assessment_name/);
  assert.match(template, /<h4 class="h6 fw-bold text-dark mb-1"><%= course\.course_name %><\/h4>/);
  assert.match(template, /assessment\.score %> \/ <%= assessment\.max_mark/);
  assert.match(template, /assessment\.weight_percentage/);
  assert.match(template, /<th class="border-0 text-start">Assessment<\/th>/);
  assert.match(template, /<th class="border-0 text-center">Marks<\/th>/);
  assert.match(template, /<th class="border-0 text-center">Weight<\/th>/);
  assert.match(template, /<th class="border-0">Performance<\/th>/);
  assert.match(template, /class="assessment-row"/);
  assert.match(template, /Total Score/);
  assert.match(template, /Overall Average/);
  assert.match(template, /Class Rank/);
  assert.doesNotMatch(template, /grading-structures|Edit Structure/i);
});

test('student courses page lists enrolled courses and only their own saved grade', async () => {
  coursePageQueries.length = 0;
  const response = await request('/student/courses', 1001);
  assert.equal(response.status, 200);
  const page = await response.json();
  assert.equal(page.view, 'student/courses');
  assert.equal(page.locals.courses.length, 1);
  assert.equal(page.locals.courses[0].course_name, 'Mathematics');
  assert.equal(page.locals.courses[0].average_grade, 82);

  const courseQuery = coursePageQueries[0];
  assert.ok(courseQuery.sql.includes("e.status IN ('enrolled', 'completed')"));
  assert.ok(courseQuery.sql.includes("scr.status IN ('approved', 'saved')"));
  assert.ok(courseQuery.sql.includes('scr.student_id = ?'));
  assert.deepEqual(courseQuery.params, [51, 15, 15, 51]);
});
