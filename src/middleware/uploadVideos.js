const { createUpload } = require('./uploadSecurity');
// Admission has already selected and authorized the target course before parsing.
const uploadVideo = createUpload('video', { beforeFile(req) {
 if (req.body.subjectId !== undefined && Number(req.body.subjectId) !== req.uploadSubjectId) throw new Error('Course mismatch');
} });
module.exports = { uploadVideo };
