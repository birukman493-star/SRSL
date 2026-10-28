const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Ensure upload directories exist
const materialsDir = path.join(__dirname, '..', 'uploads', 'materials');
const assignmentsDir = path.join(__dirname, '..', 'uploads', 'assignments');

[materialsDir, assignmentsDir].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Allowed file extensions and mime types
const ALLOWED_EXTENSIONS = new Set([
  '.pdf',
  '.doc',
  '.docx',
  '.ppt',
  '.pptx',
  '.xls',
  '.xlsx',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.txt',
]);

const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'text/plain',
  'application/octet-stream', // Fallback for some office/binary formats
]);

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB

function createStorage(targetDir) {
  return multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, targetDir);
    },
    filename: (req, file, cb) => {
      // Safe unique filename using crypto random bytes + sanitized extension
      const ext = path.extname(file.originalname).toLowerCase();
      const uniqueName = `${Date.now()}-${crypto.randomBytes(12).toString('hex')}${ext}`;
      cb(null, uniqueName);
    },
  });
}

function fileFilter(req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    const err = new Error(`Unsupported file type: ${ext}. Allowed formats: PDF, DOC, DOCX, PPT, PPTX, XLS, XLSX, PNG, JPG, WEBP, TXT`);
    err.code = 'INVALID_FILE_TYPE';
    return cb(err, false);
  }

  // Also check mime type if provided
  if (file.mimetype && !ALLOWED_MIME_TYPES.has(file.mimetype.toLowerCase())) {
    const err = new Error(`Unsupported file MIME type: ${file.mimetype}`);
    err.code = 'INVALID_FILE_TYPE';
    return cb(err, false);
  }

  cb(null, true);
}

const uploadMaterial = multer({
  storage: createStorage(materialsDir),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter,
});

const uploadAssignment = multer({
  storage: createStorage(assignmentsDir),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter,
});

// Middleware wrapper to catch Multer errors gracefully
function handleUpload(multerUpload) {
  return (req, res, next) => {
    multerUpload(req, res, (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({
            message: `File size exceeds the 25MB limit. Please upload a smaller file.`,
          });
        }
        if (err.code === 'INVALID_FILE_TYPE') {
          return res.status(400).json({ message: err.message });
        }
        return res.status(400).json({ message: err.message || 'File upload error' });
      }
      next();
    });
  };
}

// Safely delete a file from disk
function safelyDeleteFile(relativeOrAbsolutePath) {
  if (!relativeOrAbsolutePath) return;
  try {
    let fullPath = relativeOrAbsolutePath;
    if (!path.isAbsolute(fullPath)) {
      fullPath = path.join(__dirname, '..', relativeOrAbsolutePath.replace(/^\//, ''));
    }
    // Prevent deleting files outside uploads (case-insensitive check for Windows)
    const uploadsRoot = path.resolve(__dirname, '..', 'uploads').toLowerCase();
    const resolvedPath = path.resolve(fullPath);
    if (resolvedPath.toLowerCase().startsWith(uploadsRoot) && fs.existsSync(resolvedPath)) {
      fs.unlinkSync(resolvedPath);
    }
  } catch (err) {
    console.error('Error safely deleting file:', err);
  }
}

function streamSecureFile(res, filePath, originalName, mimeType, isView = false) {
  if (!filePath) {
    return res.status(404).render('500-modern', { title: 'File Missing', message: 'No file associated with this record.' });
  }

  let fullPath = filePath;
  if (!path.isAbsolute(fullPath)) {
    fullPath = path.join(__dirname, '..', filePath.replace(/^\//, ''));
  }

  const uploadsRoot = path.resolve(__dirname, '..', 'uploads').toLowerCase();
  const resolvedPath = path.resolve(fullPath);

  // Prevent path traversal outside uploads directory (case-insensitive for Windows)
  if (!resolvedPath.toLowerCase().startsWith(uploadsRoot)) {
    return res.status(403).render('500-modern', { title: 'Access Denied', message: 'Invalid file request.' });
  }

  if (!fs.existsSync(resolvedPath)) {
    return res.status(404).render('500-modern', { title: 'File Not Found', message: 'The requested file could not be found on the server.' });
  }

  const disposition = isView ? 'inline' : 'attachment';
  const cleanName = originalName || path.basename(resolvedPath);
  res.setHeader('Content-Disposition', `${disposition}; filename="${encodeURIComponent(cleanName)}"`);
  res.setHeader('Content-Type', mimeType || 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  const stream = fs.createReadStream(resolvedPath);
  stream.on('error', (streamErr) => {
    console.error('File stream error:', streamErr);
    if (!res.headersSent) {
      res.status(500).render('500-modern', { title: 'Server Error', message: 'Error streaming file.' });
    }
  });
  stream.pipe(res);
}

// Export default upload for backward compatibility with existing routes
module.exports = uploadMaterial;
module.exports.uploadMaterial = uploadMaterial;
module.exports.uploadAssignment = uploadAssignment;
module.exports.handleUpload = handleUpload;
module.exports.safelyDeleteFile = safelyDeleteFile;
module.exports.streamSecureFile = streamSecureFile;
module.exports.materialsDir = materialsDir;
module.exports.assignmentsDir = assignmentsDir;
module.exports.ALLOWED_EXTENSIONS = ALLOWED_EXTENSIONS;

