const { URL } = require('node:url');

// Only known operational codes may accompany a fixed, caller-owned event label.
// Never serialize an error, message, stack, SQL, request, header or body.
const ERROR_CODES = new Set([
  'ER_DUP_ENTRY', 'ER_BAD_FIELD_ERROR', 'ER_NO_SUCH_TABLE',
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND',
  'EAUTH', 'ESOCKET', 'ECONNECTION', 'EENVELOPE', 'EMESSAGE'
]);
function logError(event, error, logger = console) {
  const code = ERROR_CODES.has(error?.code) ? error.code : 'UNEXPECTED_ERROR';
  logger.error(event, { code });
}

function requestPath(req) {
  try {
    // Also strips credentials/authority from an absolute-form request target.
    const pathname = new URL(req.originalUrl || req.url || '/', 'http://request.invalid').pathname;
    return pathname.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g,
      character => encodeURIComponent(character));
  } catch {
    // A malformed URL must not fall back to logging its raw contents.
    return '[invalid-path]';
  }
}

function requestLogger(morgan, { production = false, stream } = {}) {
  morgan.token('safe-path', requestPath);
  const format = production
    ? ':remote-addr - :method :safe-path :status :res[content-length] - :response-time ms'
    : ':method :safe-path :status :response-time ms - :res[content-length]';
  return morgan(format, {
    ...(stream && { stream }),
    skip: production ? req => {
      const pathname = requestPath(req);
      return pathname === '/health' || pathname === '/uploads' || pathname.startsWith('/uploads/');
    } : undefined
  });
}

module.exports = { logError, requestPath, requestLogger };
