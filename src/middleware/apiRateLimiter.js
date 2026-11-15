const rateLimit = require('express-rate-limit');
const { signedIdentity } = require('./authRateLimits');

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
  // A network can represent an entire campus. Keep a broad network ceiling,
  // with the existing individual allowance for cryptographically signed users.
  const reads = rateLimit({ ...options, limit: 12000 });
  const writes = rateLimit({ ...options, limit: 4000 });
  const accountReads = rateLimit({ ...options, limit: 300, keyGenerator: req => req.rateLimitAccount });
  const accountWrites = rateLimit({ ...options, limit: 100, keyGenerator: req => req.rateLimitAccount });
  return (req, res, next) => {
    if (hasDedicatedAuthLimit(req)) return next();
    const read = ['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    return (read ? reads : writes)(req, res, error => {
      if (error) return next(error);
      const identity = signedIdentity(req);
      if (!identity) return next();
      req.rateLimitAccount = identity;
      return (read ? accountReads : accountWrites)(req, res, next);
    });
  };
}

module.exports = { createApiRateLimiter };
