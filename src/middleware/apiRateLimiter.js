const rateLimit = require('express-rate-limit');

// Dashboard reads must not exhaust the budget for signing in or saving work.
// These three auth routes have their own limiter in authRoutes.js.
function hasDedicatedAuthLimit(req) {
  const path = req.path.replace(/\/+$/, '') || '/';
  return req.method === 'POST' && ['/auth', '/auth/login', '/auth/refresh-token'].includes(path);
}

function createApiRateLimiter() {
  const options = {
    windowMs: 15 * 60 * 1000,
    message: { error: 'Too many requests, please try again later' },
    standardHeaders: true,
    legacyHeaders: false
  };
  const reads = rateLimit({ ...options, limit: 300 });
  const writes = rateLimit({ ...options, limit: 100 });
  return (req, res, next) => {
    if (hasDedicatedAuthLimit(req)) return next();
    return (['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? reads : writes)(req, res, next);
  };
}

module.exports = { createApiRateLimiter };
