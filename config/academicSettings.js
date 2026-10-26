const { getSetting, updateSetting } = require('./systemSettings');

async function getActiveSemester() {
  return await getSetting('semester', 'Semester 1');
}

async function setActiveSemester(sem) {
  if (!['Semester 1', 'Semester 2'].includes(sem)) {
    throw new Error('Invalid semester value');
  }
  await updateSetting('semester', sem, 'academic');
}

module.exports = { getActiveSemester, setActiveSemester };
