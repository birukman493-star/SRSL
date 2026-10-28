const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { after, before, test } = require('node:test');
const express = require('express');

// Mock data
let materialsTable = [];
let assignmentsTable = [];
let nextMaterialId = 1;
let nextAssignmentId = 1;

// Teachers: Teacher 1 (user 101), Teacher 2 (user 102)
// Students: Student 1 (user 201, Class 1), Student 2 (user 202, Class 2)
const db = {
  async execute(sql, params = []) {
    // Teacher resolution
    if (sql.includes('SELECT id FROM teachers WHERE user_id = ?')) {
      const userId = Number(params[0]);
      if (userId === 101) return [[{ id: 1 }]];
      if (userId === 102) return [[{ id: 2 }]];
      return [[]];
    }
    if (sql.includes('SELECT id FROM classes WHERE attendance_teacher_id = ?')) {
      return [[]];
    }
    // Student resolution
    if (sql.includes('SELECT id, grade_level, section FROM students WHERE user_id = ?')) {
      const userId = Number(params[0]);
      if (userId === 201) return [[{ id: 1, grade_level: '1', section: 'A' }]];
      if (userId === 202) return [[{ id: 2, grade_level: '2', section: 'B' }]];
      return [[]];
    }
    if (sql.includes('SELECT id FROM students WHERE user_id = ?')) {
      const userId = Number(params[0]);
      if (userId === 201) return [[{ id: 1 }]];
      if (userId === 202) return [[{ id: 2 }]];
      return [[]];
    }
    if (sql.includes('SELECT id, class_id, grade_level, section FROM students WHERE id = ?')) {
      const sId = Number(params[0]);
      if (sId === 1) return [[{ id: 1, class_id: 1, grade_level: '1', section: 'A' }]];
      if (sId === 2) return [[{ id: 2, class_id: 2, grade_level: '2', section: 'B' }]];
      return [[]];
    }
    // Student class IDs resolution
    if (sql.includes('SELECT DISTINCT c.id') && sql.includes('FROM classes c')) {
      const sId = Number(params[0]);
      if (sId === 1) return [[{ id: 1 }]];
      if (sId === 2) return [[{ id: 2 }]];
      return [[]];
    }
    // Teacher authorization check (isTeacherAssigned)
    if (sql.includes('FROM teacher_course_assignments') || sql.includes('FROM class_teachers') || sql.includes('FROM class_schedule')) {
      const teacherId = Number(params[0]);
      const classId = Number(params[1]);
      // Teacher 1 is authorized for Class 1 (Course 1 or 2). Teacher 2 is authorized for Class 2.
      if (teacherId === 1 && classId === 1) return [[{ id: 99 }]];
      if (teacherId === 2 && classId === 2) return [[{ id: 98 }]];
      return [[]];
    }
    // Teacher authorized pairs query
    if (sql.includes('auth_map') && sql.includes('WHERE auth_map.teacher_id = ?')) {
      const tId = Number(params[0]);
      if (tId === 1) {
        return [[{
          class_id: 1,
          class_name: 'Grade-1',
          grade: '1',
          section: 'A',
          course_id: 1,
          course_name: 'English',
          course_code: 'ENG101',
        }]];
      }
      return [[{
        class_id: 2,
        class_name: 'Grade-2',
        grade: '2',
        section: 'B',
        course_id: 2,
        course_name: 'Math',
        course_code: 'MTH101',
      }]];
    }
    // Student count query
    if (sql.includes('SELECT COUNT(DISTINCT s.id) as student_count')) {
      const classId = Number(params[0]);
      return [[{ student_count: classId === 1 ? 25 : 18 }]];
    }
    // Class details
    if (sql.includes('SELECT academic_year, semester FROM classes WHERE id = ?')) {
      return [[{ academic_year: '2025-2026', semester: '1' }]];
    }
    if (sql.includes('SELECT name FROM classes WHERE id = ?')) {
      return [[{ name: 'Grade-1' }]];
    }
    if (sql.includes('SELECT course_name FROM courses WHERE id = ?')) {
      return [[{ course_name: 'English' }]];
    }
    // Insert into materials
    if (sql.includes('INSERT INTO materials')) {
      const id = nextMaterialId++;
      const [class_id, teacher_id, course_id, title, description, file_name, file_path, file_size, mime_type, file_url, material_type, academic_year, semester] = params;
      materialsTable.push({
        id,
        class_id,
        teacher_id,
        course_id,
        title,
        description,
        file_name,
        file_path,
        file_size,
        mime_type,
        file_url: file_url || `/teacher/materials/download/${id}`,
        material_type,
        academic_year,
        semester,
        created_at: new Date(),
      });
      return [{ insertId: id }];
    }
    // Update materials file_url
    if (sql.includes('UPDATE materials SET file_url = ? WHERE id = ?')) {
      const mat = materialsTable.find(m => m.id === Number(params[1]));
      if (mat) mat.file_url = params[0];
      return [{ affectedRows: 1 }];
    }
    // Update materials details
    if (sql.includes('UPDATE materials') && sql.includes('SET class_id = ?')) {
      const matId = Number(params[params.length - 1]);
      const mat = materialsTable.find(m => m.id === matId);
      if (mat) {
        mat.class_id = params[0];
        mat.course_id = params[1];
        mat.title = params[2];
        mat.description = params[3];
        mat.material_type = params[4];
        if (params[5]) mat.file_name = params[5];
        if (params[6]) mat.file_path = params[6];
        if (params[7]) mat.file_size = params[7];
        if (params[8]) mat.mime_type = params[8];
        if (params[9]) mat.file_url = params[9];
      }
      return [{ affectedRows: 1 }];
    }
    // Query materials for teacher
    if (sql.includes('FROM materials m') && sql.includes('WHERE m.teacher_id = ?')) {
      const tId = Number(params[0]);
      const rows = materialsTable.filter(m => m.teacher_id === tId).map(m => ({
        ...m,
        class_name: 'Grade-1',
        grade: '1',
        section: 'A',
        course_name: 'English',
        course_code: 'ENG101',
        teacher_fname: 'Teacher',
        teacher_lname: 'One',
      }));
      return [rows];
    }
    // Query materials for student
    if (sql.includes('FROM materials m') && sql.includes('WHERE m.class_id IN')) {
      const cIds = params.map(Number);
      const rows = materialsTable.filter(m => cIds.includes(m.class_id)).map(m => ({
        ...m,
        class_name: 'Grade-1',
        grade: '1',
        section: 'A',
        course_name: 'English',
        course_code: 'ENG101',
        teacher_fname: 'Teacher',
        teacher_lname: 'One',
      }));
      return [rows];
    }
    // Select material by id and teacher_id
    if (sql.includes('SELECT * FROM materials WHERE id = ? AND teacher_id = ?') ||
        sql.includes('SELECT id, file_path, title FROM materials WHERE id = ? AND teacher_id = ?')) {
      const mId = Number(params[0]);
      const tId = Number(params[1]);
      const found = materialsTable.filter(m => m.id === mId && m.teacher_id === tId);
      return [found];
    }
    // Select material by id
    if (sql.includes('SELECT * FROM materials WHERE id = ?')) {
      const mId = Number(params[0]);
      const found = materialsTable.filter(m => m.id === mId);
      return [found];
    }
    // Delete material
    if (sql.includes('DELETE FROM materials WHERE id = ?')) {
      const mId = Number(params[0]);
      materialsTable = materialsTable.filter(m => m.id !== mId);
      return [{ affectedRows: 1 }];
    }

    // Insert assignment
    if (sql.includes('INSERT INTO assignments')) {
      const id = nextAssignmentId++;
      const [class_id, course_id, assignment_type, title, description, due_date, issue_date, max_points, visible_to_students, is_published, created_by, teacher_id, academic_year, semester, semester_id, file_name, file_path, file_size, mime_type, file_url] = params;
      assignmentsTable.push({
        id,
        class_id,
        course_id,
        assignment_type,
        title,
        description,
        due_date,
        issue_date,
        max_points,
        visible_to_students,
        is_published,
        created_by,
        teacher_id,
        academic_year,
        semester,
        file_name,
        file_path,
        file_size,
        mime_type,
        file_url: file_url || `/teacher/assignments/download/${id}`,
        created_at: new Date(),
      });
      return [{ insertId: id }];
    }
    // Update assignment file_url
    if (sql.includes('UPDATE assignments SET file_url = ? WHERE id = ?')) {
      const a = assignmentsTable.find(x => x.id === Number(params[1]));
      if (a) a.file_url = params[0];
      return [{ affectedRows: 1 }];
    }
    // Select assignments for teacher
    if (sql.includes('FROM assignments a') && sql.includes('WHERE a.teacher_id = ? OR a.created_by = ?')) {
      const tId = Number(params[0]);
      const rows = assignmentsTable.filter(a => a.teacher_id === tId || a.created_by === tId).map(a => ({
        ...a,
        class_name: 'Grade-1',
        grade: '1',
        section: 'A',
        course_name: 'English',
        course_code: 'ENG101',
      }));
      return [rows];
    }
    // Select assignments for student
    if (sql.includes('FROM assignments a') && sql.includes('WHERE a.class_id IN')) {
      const cIds = params.map(Number);
      const rows = assignmentsTable.filter(a => cIds.includes(a.class_id) && a.is_published).map(a => ({
        ...a,
        class_name: 'Grade-1',
        grade: '1',
        section: 'A',
        course_name: 'English',
        course_code: 'ENG101',
        teacher_fname: 'Teacher',
        teacher_lname: 'One',
      }));
      return [rows];
    }
    // Select assignment by id and teacher
    if (sql.includes('SELECT * FROM assignments WHERE id = ? AND (teacher_id = ? OR created_by = ?)') ||
        sql.includes('SELECT id, is_published, visible_to_students, title FROM assignments WHERE id = ? AND (teacher_id = ? OR created_by = ?)') ||
        sql.includes('SELECT id, file_path, title FROM assignments WHERE id = ? AND (teacher_id = ? OR created_by = ?)')) {
      const aId = Number(params[0]);
      const tId = Number(params[1]);
      const found = assignmentsTable.filter(a => a.id === aId && (a.teacher_id === tId || a.created_by === tId));
      return [found];
    }
    // Select assignment by id (published)
    if (sql.includes('SELECT * FROM assignments WHERE id = ?')) {
      const aId = Number(params[0]);
      const found = assignmentsTable.filter(a => a.id === aId);
      return [found];
    }
    // Toggle publish
    if (sql.includes('UPDATE assignments SET is_published = ?, visible_to_students = ? WHERE id = ?')) {
      const a = assignmentsTable.find(x => x.id === Number(params[2]));
      if (a) {
        a.is_published = params[0];
        a.visible_to_students = params[1];
      }
      return [{ affectedRows: 1 }];
    }
    // Update assignment details
    if (sql.includes('UPDATE assignments') && sql.includes('SET class_id = ?')) {
      const aId = Number(params[params.length - 1]);
      const a = assignmentsTable.find(x => x.id === aId);
      if (a) {
        a.class_id = params[0];
        a.course_id = params[1];
        a.assignment_type = params[2];
        a.title = params[3];
        a.description = params[4];
        a.due_date = params[5];
        a.issue_date = params[6];
        a.max_points = params[7];
        a.visible_to_students = params[8];
        a.is_published = params[9];
        if (params[10]) a.file_name = params[10];
        if (params[11]) a.file_path = params[11];
        if (params[12]) a.file_size = params[12];
        if (params[13]) a.mime_type = params[13];
        if (params[14]) a.file_url = params[14];
      }
      return [{ affectedRows: 1 }];
    }
    // Delete assignment
    if (sql.includes('DELETE FROM assignments WHERE id = ?')) {
      const aId = Number(params[0]);
      assignmentsTable = assignmentsTable.filter(a => a.id !== aId);
      return [{ affectedRows: 1 }];
    }
    // Activity log
    if (sql.includes('INSERT INTO teacher_activities')) {
      return [{ insertId: 1 }];
    }
    // Enrollments
    if (sql.includes('SELECT id FROM enrollments')) {
      return [[]];
    }
    return [[]];
  },
};

const dbPath = require.resolve('../config/db');
const priorDbModule = require.cache[dbPath];
require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: { pool: db },
};

const teacherRoutes = require('../routes/teacher');
const studentRoutes = require('../routes/student');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Test session simulation
app.use((req, res, next) => {
  const testRole = req.headers['x-test-role'] || 'teacher';
  const testUser = Number(req.headers['x-test-user'] || 101);
  req.session = {
    user: {
      id: testUser,
      role: testRole,
      first_name: testRole === 'teacher' ? 'Teacher' : 'Student',
      last_name: String(testUser),
    },
  };
  res.render = (view, locals) => res.json({ view, locals });
  next();
});

app.use('/teacher', teacherRoutes);
app.use('/student', studentRoutes);

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

// Helper for test requests
async function makeRequest(endpoint, { method = 'GET', role = 'teacher', userId = 101, body = null, isJson = true } = {}) {
  const headers = {
    'x-test-role': role,
    'x-test-user': String(userId),
  };
  if (isJson && body) {
    headers['Content-Type'] = 'application/json';
  }

  return fetch(`${baseUrl}${endpoint}`, {
    method,
    headers,
    body: isJson && body ? JSON.stringify(body) : body,
  });
}

test('1. Teacher can upload and publish course material for authorized class & course', async () => {
  const res = await makeRequest('/teacher/materials/create', {
    method: 'POST',
    role: 'teacher',
    userId: 101, // Teacher 1, authorized for Class 1, Course 1
    body: {
      title: 'Grammar Unit 1 Guide',
      classId: '1',
      courseId: '1',
      materialType: 'reading',
      description: 'Study chapter 1 thoroughly.',
    },
  });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.success, true);
  assert.equal(materialsTable.length, 1);
  assert.equal(materialsTable[0].title, 'Grammar Unit 1 Guide');
  assert.equal(materialsTable[0].teacher_id, 1);
  assert.equal(materialsTable[0].class_id, 1);
});

test('2. Teacher cannot upload material for an unauthorized class/course', async () => {
  const res = await makeRequest('/teacher/materials/create', {
    method: 'POST',
    role: 'teacher',
    userId: 101, // Teacher 1 is NOT authorized for Class 2
    body: {
      title: 'Unauthorized Material',
      classId: '2',
      courseId: '2',
      materialType: 'reading',
    },
  });

  assert.equal(res.status, 403);
  const data = await res.json();
  assert.match(data.message, /Access denied/);
});

test('3. Teacher can edit and delete their own material', async () => {
  const matId = materialsTable[0].id;

  // Edit material
  const editRes = await makeRequest(`/teacher/materials/edit/${matId}`, {
    method: 'POST',
    role: 'teacher',
    userId: 101,
    body: {
      title: 'Grammar Unit 1 Guide - Revised',
      classId: '1',
      courseId: '1',
      description: 'Updated study notes.',
    },
  });
  assert.equal(editRes.status, 200);
  assert.equal(materialsTable[0].title, 'Grammar Unit 1 Guide - Revised');

  // Teacher 2 cannot delete Teacher 1's material
  const unauthDelRes = await makeRequest(`/teacher/materials/delete/${matId}`, {
    method: 'POST',
    role: 'teacher',
    userId: 102, // Teacher 2
  });
  assert.equal(unauthDelRes.status, 403);
  assert.equal(materialsTable.length, 1);
});

test('4. Teacher can create assignment with due date, points, and publish status', async () => {
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);

  const res = await makeRequest('/teacher/assignments/create', {
    method: 'POST',
    role: 'teacher',
    userId: 101,
    body: {
      title: 'Essay on Climate Change',
      classId: '1',
      courseId: '1',
      assignmentType: 'homework',
      issueDate: today,
      dueDate: tomorrow,
      maxPoints: 50,
      description: 'Write a 500-word essay.',
      isPublished: 'true',
    },
  });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.success, true);
  assert.equal(assignmentsTable.length, 1);
  assert.equal(assignmentsTable[0].title, 'Essay on Climate Change');
  assert.equal(assignmentsTable[0].max_points, 50);
  assert.equal(assignmentsTable[0].is_published, 1);
});

test('5. Assignment due date validation rejects due dates before issue date', async () => {
  const res = await makeRequest('/teacher/assignments/create', {
    method: 'POST',
    role: 'teacher',
    userId: 101,
    body: {
      title: 'Impossible Assignment',
      classId: '1',
      courseId: '1',
      issueDate: '2026-10-29',
      dueDate: '2026-10-25', // before issue date!
      maxPoints: 100,
    },
  });

  assert.equal(res.status, 400);
  const data = await res.json();
  assert.match(data.message, /Due date cannot be before/);
});

test('6. Teacher can toggle assignment publish status', async () => {
  const aId = assignmentsTable[0].id;

  const toggleRes = await makeRequest(`/teacher/assignments/toggle-publish/${aId}`, {
    method: 'POST',
    role: 'teacher',
    userId: 101,
  });

  assert.equal(toggleRes.status, 200);
  const data = await toggleRes.json();
  assert.equal(data.success, true);
  assert.equal(assignmentsTable[0].is_published, 0); // was 1, now toggled to 0

  // Toggle back to published
  await makeRequest(`/teacher/assignments/toggle-publish/${aId}`, {
    method: 'POST',
    role: 'teacher',
    userId: 101,
  });
  assert.equal(assignmentsTable[0].is_published, 1);
});

test('7. Enrolled student can see materials for their class/course, but not for other classes', async () => {
  // Student 1 belongs to Class 1
  const res = await makeRequest('/student/materials', {
    method: 'GET',
    role: 'student',
    userId: 201, // Student 1
  });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.locals.materials.length, 1);
  assert.equal(data.locals.materials[0].title, 'Grammar Unit 1 Guide - Revised');

  // Student 2 belongs to Class 2 (must NOT see Class 1 materials)
  const resStudent2 = await makeRequest('/student/materials', {
    method: 'GET',
    role: 'student',
    userId: 202, // Student 2
  });

  assert.equal(resStudent2.status, 200);
  const data2 = await resStudent2.json();
  assert.equal(data2.locals.materials.length, 0); // Isolated!
});

test('8. Enrolled student can see published assignments with calculated status', async () => {
  // Student 1 belongs to Class 1
  const res = await makeRequest('/student/assignments', {
    method: 'GET',
    role: 'student',
    userId: 201, // Student 1
  });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.locals.assignments.length, 1);
  assert.equal(data.locals.assignments[0].title, 'Essay on Climate Change');
  assert.ok(data.locals.assignments[0].statusKey); // status calculated ('due_soon' or 'upcoming')
  assert.equal(data.locals.counts.total, 1);

  // Student 2 belongs to Class 2 (must NOT see Class 1 assignments)
  const resStudent2 = await makeRequest('/student/assignments', {
    method: 'GET',
    role: 'student',
    userId: 202, // Student 2
  });

  assert.equal(resStudent2.status, 200);
  const data2 = await resStudent2.json();
  assert.equal(data2.locals.assignments.length, 0); // Isolated!
});

test('9. Student cannot access download for material of an unrelated class', async () => {
  const matId = materialsTable[0].id; // Belong to Class 1

  // Student 2 belongs to Class 2
  const unauthDownload = await makeRequest(`/student/materials/download/${matId}`, {
    method: 'GET',
    role: 'student',
    userId: 202, // Student 2
  });

  assert.equal(unauthDownload.status, 403);
});

test('10. Student cannot access download for assignment of an unrelated class', async () => {
  const aId = assignmentsTable[0].id; // Belongs to Class 1

  // Student 2 belongs to Class 2
  const unauthDownload = await makeRequest(`/student/assignments/download/${aId}`, {
    method: 'GET',
    role: 'student',
    userId: 202, // Student 2
  });

  assert.equal(unauthDownload.status, 403);
});

test('11. Teacher assignment download route exists and handles requests', async () => {
  const aId = assignmentsTable[0].id;
  // Teacher 2 is unauthorized for Teacher 1's assignment
  const res = await makeRequest(`/teacher/assignments/download/${aId}`, {
    method: 'GET',
    role: 'teacher',
    userId: 102, // Teacher 2
  });
  // Should not be 404 Not Found route - returns 404 assignment not found / access denied for teacher 2
  assert.equal(res.status, 404);
});

test('12. Teacher can delete their own material and assignment', async () => {
  const matId = materialsTable[0].id;
  const aId = assignmentsTable[0].id;

  const delMat = await makeRequest(`/teacher/materials/delete/${matId}`, {
    method: 'POST',
    role: 'teacher',
    userId: 101,
  });
  assert.equal(delMat.status, 200);
  assert.equal(materialsTable.length, 0);

  const delAssign = await makeRequest(`/teacher/assignments/delete/${aId}`, {
    method: 'POST',
    role: 'teacher',
    userId: 101,
  });
  assert.equal(delAssign.status, 200);
  assert.equal(assignmentsTable.length, 0);
});
