const { createUpload } = require('./uploadSecurity');
module.exports = { uploadProfileFiles: createUpload('image') };
