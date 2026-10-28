const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const express = require('express');

// Mock data tables
let announcementsTable = [];
let classScheduleTable = [];
let nextAnnId = 1;
let nextSchedId = 1;

const db = {
  async execute(sql, params = []) {
    // Announcements INSERT
    if (sql.includes('INSERT INTO announcements')) {
      const id = nextAnnId++;
      const [title, message, audience, category, created_by] = params;
      const record = {
        id,
        title,
        message,
        audience,
        category: category || 'general',
        created_by,
        created_at: new Date(),
        updated_at: new Date()
      };
      announcementsTable.push(record);
      return [{ insertId: id }];
    }

    // Announcements UPDATE
    if (sql.includes('UPDATE announcements SET title = ?')) {
      const [title, message, audience, category, id] = params;
      const ann = announcementsTable.find(a => a.id === Number(id));
      if (ann) {
        ann.title = title;
        ann.message = message;
        ann.audience = audience;
        ann.category = category;
      }
      return [{ affectedRows: ann ? 1 : 0 }];
    }

    // Announcements DELETE
    if (sql.includes('DELETE FROM announcements WHERE id = ?')) {
      const id = Number(params[0]);
      announcementsTable = announcementsTable.filter(a => a.id !== id);
      return [{ affectedRows: 1 }];
    }

    // Announcements for admin
    if (sql.includes('FROM announcements a') && sql.includes('LEFT JOIN users u ON a.created_by = u.id') && !sql.includes('WHERE')) {
      return [announcementsTable.map(a => ({ ...a, first_name: 'Admin', last_name: 'User' }))];
    }

    // Announcements for students
    if (sql.includes('FROM announcements a') && sql.includes("WHERE a.audience IN ('all', 'students')")) {
      const rows = announcementsTable
        .filter(a => a.audience === 'all' || a.audience === 'students')
        .map(a => ({ ...a, content: a.message, creator_fname: 'Admin', creator_lname: 'User' }));
      return [rows];
    }

    // Announcements for teachers
    if (sql.includes('FROM announcements a') && sql.includes("WHERE a.audience IN ('all', 'teachers')")) {
      const rows = announcementsTable
        .filter(a => a.audience === 'all' || a.audience === 'teachers')
        .map(a => ({ ...a, content: a.message, first_name: 'Admin', last_name: 'User' }));
      return [rows];
    }

    // Announcements for parents (both queries)
    if (sql.includes('FROM announcements a') && sql.includes("WHERE a.audience IN ('all', 'parents')")) {
      const rows = announcementsTable
        .filter(a => a.audience === 'all' || a.audience === 'parents')
        .map(a => ({ ...a, content: a.message, author_name: 'Admin User' }));
      return [rows];
    }

    // Parent dashboard recent announcements
    if (sql.includes("FROM announcements") && sql.includes("WHERE audience IN ('all', 'parents')")) {
      const rows = announcementsTable
        .filter(a => a.audience === 'all' || a.audience === 'parents')
        .map(a => ({ type: 'announcement', title: a.title, date: '2026-10-28' }));
      return [rows];
    }

    // Class Schedule INSERT
    if (sql.includes('INSERT INTO class_schedule')) {
      const id = nextSchedId++;
      const [class_id, course_id, teacher_id, academic_year, semester, day_of_week, start_time, end_time, room, period] = params;
      const record = {
        id,
        class_id: Number(class_id),
        course_id: Number(course_id),
        teacher_id: teacher_id ? Number(teacher_id) : null,
        academic_year,
        semester,
        day_of_week,
        start_time,
        end_time,
        room,
        period
      };
      classScheduleTable.push(record);
      return [{ insertId: id }];
    }

    // Class Schedule DELETE
    if (sql.includes('DELETE FROM class_schedule WHERE id = ?')) {
      const id = Number(params[0]);
      classScheduleTable = classScheduleTable.filter(s => s.id !== id);
      return [{ affectedRows: 1 }];
    }

    // Class Schedule lookup before delete
    if (sql.includes('SELECT class_id, teacher_id FROM class_schedule WHERE id = ?') || sql.includes('SELECT class_id FROM class_schedule WHERE id = ?')) {
      const id = Number(params[0]);
      const found = classScheduleTable.find(s => s.id === id);
      return [found ? [{ class_id: found.class_id, teacher_id: found.teacher_id }] : []];
    }

    // Teacher resolution queries
    if (sql.includes('SELECT teacher_id FROM teacher_course_assignments')) {
      return [[{ teacher_id: 1 }]];
    }
    if (sql.includes('SELECT teacher_id FROM courses WHERE id = ?')) {
      return [[{ teacher_id: 1 }]];
    }
    if (sql.includes('SELECT academic_year, semester FROM classes WHERE id = ?')) {
      return [[{ academic_year: '2025-2026', semester: 'Semester 1' }]];
    }

    // Class schedule query for class
    if (sql.includes('FROM class_schedule cs') && sql.includes('WHERE cs.class_id = ?')) {
      const classId = Number(params[0]);
      const rows = classScheduleTable.filter(s => s.class_id === classId).map(s => ({
        ...s,
        course_name: 'Mathematics',
        course_code: 'MTH101',
        credits: 3,
        teacher_name: s.teacher_id === 1 ? 'John Teacher' : 'Jane Staff'
      }));
      return [rows];
    }

    // Class schedule for teacher
    if (sql.includes('FROM class_schedule cs') && sql.includes('OR (cs.teacher_id = ?)')) {
      const teacherId = Number(params[0]);
      const rows = classScheduleTable.filter(s => s.teacher_id === teacherId).map(s => ({
        ...s,
        course_name: 'Mathematics',
        course_code: 'MTH101',
        class_name: 'Grade 9-A',
        grade: '9',
        section: 'A'
      }));
      return [rows];
    }

    // Teacher profile lookup
    if (sql.includes('SELECT id FROM teachers WHERE user_id = ?')) {
      return [[{ id: 1 }]];
    }

    // Students lookup
    if (sql.includes('SELECT id, class_id, grade_level, section FROM students WHERE user_id = ?')) {
      return [[{ id: 10, class_id: 1, grade_level: '9', section: 'A' }]];
    }
    if (sql.includes('SELECT s.*, u.first_name, u.last_name, c.name as class_name')) {
      const childId = Number(params[0]);
      if (childId === 10) {
        return [[{ id: 10, first_name: 'Alice', last_name: 'Student', class_id: 1, class_name: 'Grade 9-A' }]];
      }
      return [[]];
    }

    // Parents lookup
    if (sql.includes('SELECT id FROM parents WHERE user_id = ?')) {
      const uId = Number(params[0]);
      return uId === 50 ? [[{ id: 5 }]] : [[]];
    }

    // Parent student relation
    if (sql.includes('FROM parent_student_relations WHERE parent_id = ? AND student_id = ?')) {
      const pId = Number(params[0]);
      const sId = Number(params[1]);
      if (pId === 5 && sId === 10) return [[{ parent_id: 5, student_id: 10 }]];
      return [[]];
    }

    // Classes lookup
    if (sql.includes('SELECT * FROM classes WHERE id = ?')) {
      return [[{ id: Number(params[0]), name: 'Grade 9-A', grade: '9', section: 'A' }]];
    }
    if (sql.includes('SELECT id, course_name, course_code FROM courses')) {
      return [[{ id: 1, course_name: 'Mathematics', course_code: 'MTH101' }]];
    }
    if (sql.includes('SELECT t.id, CONCAT(u.first_name')) {
      return [[{ id: 1, teacher_name: 'John Teacher', department: 'Science' }]];
    }

    return [[]];
  }
};

const dbPath = require.resolve('../config/db');
const priorDbModule = require.cache[dbPath];
require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: { pool: db },
};

const adminRoutes = require('../routes/admin');
const teacherRoutes = require('../routes/teacher');
const studentRoutes = require('../routes/student');
const parentRoutes = require('../routes/parent');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Simulate session
app.use((req, res, next) => {
  const role = req.headers['x-test-role'] || 'admin';
  const userId = Number(req.headers['x-test-user'] || 1);
  req.session = {
    user: {
      id: userId,
      role: role,
      first_name: role === 'admin' ? 'Admin' : (role === 'teacher' ? 'John' : (role === 'student' ? 'Alice' : 'Robert')),
      last_name: 'User',
      username: `${role}_user`,
    }
  };
  req.teacherId = 1;
  res.render = (view, locals) => res.json({ view, locals });
  next();
});

app.use('/admin', adminRoutes);
app.use('/teacher', teacherRoutes);
app.use('/student', studentRoutes);
app.use('/parent', parentRoutes);

let server;
let baseUrl;

before(async () => {
  server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  if (priorDbModule) require.cache[dbPath] = priorDbModule;
  else delete require.cache[dbPath];
});

async function request(endpoint, { method = 'GET', role = 'admin', userId = 1, body = null } = {}) {
  const headers = {
    'x-test-role': role,
    'x-test-user': String(userId),
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  };
  return fetch(`${baseUrl}${endpoint}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual'
  });
}

test('1. Admin can add announcements targeted to students, teachers, parents, or global', async () => {
  // Global announcement
  await request('/admin/announcements/add', {
    method: 'POST',
    role: 'admin',
    body: { title: 'School Closed Tomorrow', message: 'Heavy snow expected.', audience: 'all', category: 'urgent' }
  });

  // Students-only announcement
  await request('/admin/announcements/add', {
    method: 'POST',
    role: 'admin',
    body: { title: 'Exam Schedule Out', message: 'Check your student portal.', audience: 'students', category: 'academic' }
  });

  // Teachers-only announcement
  await request('/admin/announcements/add', {
    method: 'POST',
    role: 'admin',
    body: { title: 'Staff Meeting', message: 'Staff room at 3 PM.', audience: 'teachers', category: 'general' }
  });

  // Parents-only announcement
  await request('/admin/announcements/add', {
    method: 'POST',
    role: 'admin',
    body: { title: 'PTA Meeting', message: 'Friday evening in auditorium.', audience: 'parents', category: 'event' }
  });

  assert.equal(announcementsTable.length, 4);
  assert.equal(announcementsTable[0].category, 'urgent');
  assert.equal(announcementsTable[3].audience, 'parents');
});

test('2. Admin can edit an existing announcement', async () => {
  const annId = announcementsTable[0].id;
  const res = await request(`/admin/announcements/edit/${annId}`, {
    method: 'POST',
    role: 'admin',
    body: {
      title: 'School Closed Tomorrow - Updated',
      message: 'All campus activities canceled.',
      audience: 'all',
      category: 'urgent'
    }
  });

  assert.equal(res.status, 200);
  const updated = announcementsTable.find(a => a.id === annId);
  assert.equal(updated.title, 'School Closed Tomorrow - Updated');
  assert.equal(updated.message, 'All campus activities canceled.');
});

test('3. Audience isolation: Student sees only all + students announcements', async () => {
  const res = await request('/student/announcements', { role: 'student', userId: 10 });
  assert.equal(res.status, 200);
  const data = await res.json();
  const titles = data.locals.announcements.map(a => a.title);
  assert.ok(titles.includes('School Closed Tomorrow - Updated'));
  assert.ok(titles.includes('Exam Schedule Out'));
  assert.ok(!titles.includes('Staff Meeting'), 'Student must NOT see teachers-only announcement');
  assert.ok(!titles.includes('PTA Meeting'), 'Student must NOT see parents-only announcement');
});

test('4. Audience isolation: Teacher sees only all + teachers announcements', async () => {
  const res = await request('/teacher/announcements', { role: 'teacher', userId: 1 });
  assert.equal(res.status, 200);
  const data = await res.json();
  const titles = data.locals.announcements.map(a => a.title);
  assert.ok(titles.includes('School Closed Tomorrow - Updated'));
  assert.ok(titles.includes('Staff Meeting'));
  assert.ok(!titles.includes('Exam Schedule Out'), 'Teacher must NOT see students-only announcement');
  assert.ok(!titles.includes('PTA Meeting'), 'Teacher must NOT see parents-only announcement');
  // Check that content property is populated
  assert.equal(data.locals.announcements[0].content, data.locals.announcements[0].message);
});

test('5. Audience isolation: Parent sees only all + parents announcements', async () => {
  const res = await request('/parent/announcements', { role: 'parent', userId: 50 });
  assert.equal(res.status, 200);
  const data = await res.json();
  const titles = data.locals.announcements.map(a => a.title);
  assert.ok(titles.includes('School Closed Tomorrow - Updated'));
  assert.ok(titles.includes('PTA Meeting'));
  assert.ok(!titles.includes('Staff Meeting'), 'Parent must NOT see teachers-only announcement');
  assert.ok(!titles.includes('Exam Schedule Out'), 'Parent must NOT see students-only announcement');
  // Check that content property is populated
  assert.equal(data.locals.announcements[0].content, data.locals.announcements[0].message);
});

test('6. Admin can delete an announcement', async () => {
  const annId = announcementsTable[3].id; // PTA Meeting
  const res = await request(`/admin/announcements/delete/${annId}`, {
    method: 'POST',
    role: 'admin'
  });
  assert.equal(res.status, 200);
  assert.equal(announcementsTable.length, 3);
  assert.ok(!announcementsTable.find(a => a.id === annId));
});

test('7. Admin can add a class schedule slot with teacher assignment and academic context', async () => {
  await request('/admin/classes/schedule/add', {
    method: 'POST',
    role: 'admin',
    body: {
      class_id: '1',
      course_id: '1',
      teacher_id: '1',
      day_of_week: 'Monday',
      start_time: '08:00',
      end_time: '09:00',
      room: 'Room 101',
      period: 'Period 1'
    }
  });

  assert.equal(classScheduleTable.length, 1);
  assert.equal(classScheduleTable[0].teacher_id, 1);
  assert.equal(classScheduleTable[0].academic_year, '2025-2026');
  assert.equal(classScheduleTable[0].period, 'Period 1');
});

test('8. Student can access schedule / timetable with teacher name displayed', async () => {
  // /student/schedule redirects to /student/timetable
  const redirectRes = await request('/student/schedule', { role: 'student', userId: 10 });
  assert.equal(redirectRes.status, 302);

  // /student/timetable renders timetable
  const res = await request('/student/timetable', { role: 'student', userId: 10 });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.locals.schedule.length, 1);
  assert.equal(data.locals.schedule[0].course_name, 'Mathematics');
  assert.equal(data.locals.schedule[0].teacher_name, 'John Teacher');
});

test('9. Teacher can view their personal weekly schedule with assigned classes', async () => {
  const res = await request('/teacher/schedule', { role: 'teacher', userId: 1 });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.locals.schedule.length, 1);
  assert.equal(data.locals.schedule[0].course_name, 'Mathematics');
  assert.equal(data.locals.schedule[0].class_name, 'Grade 9-A');
});

test('10. Parent can view linked child schedule, but cannot access unrelated child schedule', async () => {
  // Parent (userId: 50, parentId: 5) is linked to childId: 10
  const authRes = await request('/parent/schedule/10', { role: 'parent', userId: 50 });
  assert.equal(authRes.status, 200);
  const authData = await authRes.json();
  assert.equal(authData.locals.child.first_name, 'Alice');
  assert.equal(authData.locals.schedule.length, 1);
  assert.equal(authData.locals.schedule[0].teacher_name, 'John Teacher');

  // Unauthorized access attempt to childId: 99
  const unauthRes = await request('/parent/schedule/99', { role: 'parent', userId: 50 });
  assert.equal(unauthRes.status, 403);
});

test('11. Admin can delete a schedule slot', async () => {
  const slotId = classScheduleTable[0].id;
  await request(`/admin/classes/schedule/delete/${slotId}`, {
    method: 'POST',
    role: 'admin'
  });
  assert.equal(classScheduleTable.length, 0);
});
