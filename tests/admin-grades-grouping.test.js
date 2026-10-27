const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { after, before, test } = require('node:test');
const express = require('express');

const queries = [];
const gradeResults = [
  {
    result_id: 101,
    student_id: 51,
    student_reg_id: 'ST-051',
    student_first_name: 'Amina',
    student_last_name: 'Ali',
    grade_level: '10',
    class_id: 15,
    course_name: 'Mathematics',
    class_name: 'Grade 10A',
    academic_year: '2025-2026',
    semester_id: 'Semester 1',
    total_score: 82,
    status: 'approved',
    created_at: '2026-01-10T00:00:00.000Z',
  },
  {
    result_id: 102,
    student_id: 51,
    student_reg_id: 'ST-051',
    student_first_name: 'Amina',
    student_last_name: 'Ali',
    grade_level: '10',
    class_id: 15,
    course_name: 'English',
    class_name: 'Grade 10A',
    academic_year: '2025-2026',
    semester_id: 'Semester 1',
    total_score: 90,
    status: 'pending',
    created_at: '2026-01-11T00:00:00.000Z',
  },
  {
    result_id: 103,
    student_id: 52,
    student_reg_id: 'ST-052',
    student_first_name: 'Bekele',
    student_last_name: 'Kebede',
    grade_level: '10',
    class_id: 15,
    course_name: 'Mathematics',
    class_name: 'Grade 10A',
    academic_year: '2025-2026',
    semester_id: 'Semester 1',
    total_score: 76,
    status: 'approved',
    created_at: '2026-01-12T00:00:00.000Z',
  },
];

const db = {
  async execute(sql, params = []) {
    queries.push({ sql, params });
    if (sql.includes('SELECT scr.id AS result_id, ac.name AS assessment_name')) {
      return [[
        { result_id: 101, assessment_name: 'Assignment 1', score: 18, max_mark: 20, weight_percentage: 20 },
        { result_id: 101, assessment_name: 'Midterm Exam', score: 25, max_mark: 30, weight_percentage: 30 },
        { result_id: 101, assessment_name: 'Final Exam', score: 40, max_mark: 50, weight_percentage: 50 },
        { result_id: 102, assessment_name: 'Assignment', score: 45, max_mark: 50, weight_percentage: 100 },
        { result_id: 103, assessment_name: 'Quiz', score: 15, max_mark: 20, weight_percentage: 100 },
      ], []];
    }
    if (sql.includes('SELECT student_id, ROUND(AVG(total_score), 2) as average_score')) {
      return [[
        { student_id: 51, average_score: '85.00' },
        { student_id: 52, average_score: '76.00' },
      ], []];
    }
    if (sql.includes('SELECT scr.id AS result_id')) return [gradeResults, []];
    if (sql.includes('FROM teachers t') && sql.includes('ORDER BY u.first_name')) return [[], []];
    if (sql.includes('FROM student_results sr')) return [[], []];
    throw new Error(`Unexpected admin grades query: ${sql}`);
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
  exports: {},
};

const adminRoutes = require('../routes/admin');
const app = express();
app.use((req, res, next) => {
  req.session = { user: { id: 1, role: 'admin' } };
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
  if (priorDbModule) require.cache[dbPath] = priorDbModule;
  else delete require.cache[dbPath];
  if (priorSettingsModule) require.cache[settingsPath] = priorSettingsModule;
  else delete require.cache[settingsPath];
});

test('admin grades page groups course and assessment results into one row per student', async () => {
  queries.length = 0;
  const response = await fetch(`${baseUrl}/admin/grades`);
  assert.equal(response.status, 200);
  const page = await response.json();

  assert.equal(page.view, 'admin/grades');
  assert.equal(page.locals.grades.length, 2);
  assert.deepEqual(page.locals.grades.map((student) => student.student_id), [51, 52]);

  const amina = page.locals.grades[0];
  assert.equal(amina.gradeRecords.length, 2);
  assert.equal(amina.gradeRecords[0].assessmentGroups.assignment[0].score, 18);
  assert.equal(amina.gradeRecords[0].assessmentGroups.midterm[0].score, 25);
  assert.equal(amina.gradeRecords[0].assessmentGroups.final[0].score, 40);
  assert.equal(amina.gradeRecords[0].weightedTotal, 83);
  assert.equal(amina.gradeRecords[0].rank, '1/2');
  assert.equal(amina.gradeRecords[1].course_name, 'English');
  assert.equal(amina.gradeRecords[1].weightedTotal, 90);

  const gradeQuery = queries.find(({ sql }) => sql.includes('SELECT scr.id AS result_id'));
  assert.ok(gradeQuery.sql.includes('scr.submitted_at AS created_at'));
  assert.ok(!gradeQuery.sql.includes('scr.created_at'));
  assert.ok(gradeQuery.sql.includes('COALESCE(NULLIF(scr.course_id, 0), assigned_course.course_id, scheduled_course.course_id)'));
  assert.ok(gradeQuery.sql.includes('WHERE course_owner.teacher_id IS NOT NULL'));
  assert.ok(queries.some(({ sql }) => sql.includes('scr.id IN (?, ?, ?)')));
  const template = fs.readFileSync(
    path.join(__dirname, '..', 'views', 'admin', 'grades.html'),
    'utf8'
  );
  assert.match(template, /for \(let student of grades\)/);
  assert.match(template, /student\.gradeRecords\.forEach/);
  assert.match(template, /record\.assessments\.forEach/);
  assert.match(template, /Student ID/);
  assert.match(template, /Student Name/);
  assert.match(template, />Course</);
  assert.match(template, />Assignment</);
  assert.match(template, />Midterm</);
  assert.match(template, />Final</);
  assert.match(template, />Total</);
  assert.match(template, />View</);
  assert.match(template, />Rank</);
  assert.match(template, /record\.weightedTotal\.toFixed\(1\) %>%/);
  const transcriptTemplate = fs.readFileSync(
    path.join(__dirname, '..', 'views', 'admin', 'transcript-generate.html'),
    'utf8'
  );
  assert.match(transcriptTemplate, /rankByAcademicYear\[yearObj\.year\]/);
});
