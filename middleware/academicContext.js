const { getAcademicContext } = require('../config/systemSettings');

module.exports = async (req, res, next) => {
  try {
    const ctx = await getAcademicContext();
    req.academicYear = ctx.academicYear;
    req.semester = ctx.semester;
    req.semesterLabel = ctx.semesterLabel;
    next();
  } catch (e) {
    next(e);
  }
};
