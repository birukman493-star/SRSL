const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const express = require('express');

const assignmentWrites = [];
let connectionRequests = 0;
const fakePool = {
  async execute() {
    return [[], []];
  },
  async getConnection() {
    connectionRequests += 1;
    return {
      async beginTransaction() {},
      async commit() {},
      async rollback() {},
      release() {},
      async execute(sql, params = []) {
        if (sql.includes('FROM teachers WHERE id = ?')) return [[{ id: 4 }], []];
        if (sql.includes('FROM classes WHERE id = ?')) return [[{ id: 12 }], []];
        if (sql.includes('FROM courses WHERE id = ?')) return [[{ id: 7 }], []];
        if (sql.includes('SELECT id, status FROM teacher_course_assignments')) return [[], []];
        if (sql.includes('SELECT COUNT(*) AS count FROM teacher_course_assignments')) {
          return [[{ count: 1 }], []];
        }
        if (sql.includes('SELECT id FROM teacher_course_assignments')) return [[], []];
        if (sql.includes('INSERT INTO teacher_course_assignments')) {
          assignmentWrites.push({ sql, params });
          return [{ insertId: 99 }, []];
        }
        throw new Error(`Unexpected SQL in assignment test: ${sql}`);
      },
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
    DEFAULT_ACADEMIC_YEAR: '2026-2027',
  },
};

const adminRoutes = require('../routes/admin');
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use((req, res, next) => {
  req.session = {
    user: {
      id: 1,
      role: req.headers['x-test-role'] || 'admin',
    },
  };
  res.redirect = (url) => res.status(302).json({ redirect: url, flash: req.session.flash });
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

test('admin course assignment persists the selected teacher, class, course, and year', async () => {
  assignmentWrites.length = 0;
  const response = await fetch(`${baseUrl}/admin/assignments/add`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      teacher_id: '4',
      class_id: '12',
      course_id: '7',
      academic_year: '2026-2027',
    }),
  });

  assert.equal(response.status, 302);
  const result = await response.json();
  assert.equal(result.flash.success, 'Teacher assignment created successfully.');
  assert.equal(assignmentWrites.length, 1);
  assert.deepEqual(assignmentWrites[0].params, [4, 12, 7, '2026-2027']);
  assert.match(assignmentWrites[0].sql, /VALUES \(\?, \?, \?, \?, 'active'\)/);
});

test('course assignments reject invalid IDs and non-admin users', async () => {
  const connectionsBeforeInvalid = connectionRequests;
  const invalidResponse = await fetch(`${baseUrl}/admin/assignments/add`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      teacher_id: 'not-an-id',
      class_id: '12',
      course_id: '7',
    }),
  });
  assert.equal(invalidResponse.status, 302);
  assert.equal(connectionRequests, connectionsBeforeInvalid);

  const forbiddenResponse = await fetch(`${baseUrl}/admin/assignments/add`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-test-role': 'teacher',
    },
    body: new URLSearchParams({
      teacher_id: '4',
      class_id: '12',
      course_id: '7',
    }),
  });
  assert.equal(forbiddenResponse.status, 302);
  assert.equal(connectionRequests, connectionsBeforeInvalid);
});
