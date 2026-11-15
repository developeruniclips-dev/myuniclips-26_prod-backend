'use strict';
const { createHash } = require('node:crypto');
const jwt = require('jsonwebtoken');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { normalizeEmail } = require('../utils/authSecurity');

// One process, one campus network: allow 200 learners with retry headroom.
// These are request budgets, not a promise of 200 simultaneous password hashes.
const WINDOW_MS = 15 * 60 * 1000;
const AUTH_LIMITS = Object.freeze({ register: 600, login: 1200, refresh: 1200, recovery: 600, factor: 600 });
const digest = value => createHash('sha256').update(value).digest('hex');
const networkKey = req => ipKeyGenerator(req.ip);

// This only selects a rate-limit bucket. Routes still perform their complete
// database/session/role authorization; a signed token here grants no access.
function signedIdentity(req, purpose = 'access') {
  const header = req.headers.authorization;
  const token = purpose === 'second-factor' ? req.body?.challengeToken
    : typeof header === 'string' && /^Bearer ([^\s]+)$/i.exec(header)?.[1];
  if (typeof token !== 'string' || token.length > 4096 || !process.env.JWT_SECRET) return null;
  try {
    const value = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    if (value.purpose !== purpose || !Number.isSafeInteger(value.id) || value.id < 1) return null;
    if (purpose === 'access' && !/^[a-f0-9]{64}$/.test(value.session || '')) return null;
    if (purpose === 'second-factor' && (!/^[a-f0-9]{64}$/.test(value.binding || '') || !/^[a-f0-9]{64}$/.test(value.jti || ''))) return null;
    return 'account:' + value.id;
  } catch { return null; }
}

function limiter(limit, extra = {}) {
  return rateLimit({ windowMs: WINDOW_MS, limit, standardHeaders: true, legacyHeaders: false,
    message: { message: 'Too many attempts. Please try again later.', code: 'AUTH_RATE_LIMITED' }, ...extra });
}

function createAuthRateLimits() {
  const emailKey = async req => {
    const email = await normalizeEmail(req.body?.email);
    return email ? 'email:' + digest(email) : 'network:' + networkKey(req);
  };
  return {
    registerNetwork: limiter(AUTH_LIMITS.register),
    loginNetwork: limiter(AUTH_LIMITS.login),
    refreshNetwork: limiter(AUTH_LIMITS.refresh),
    recoveryNetwork: limiter(AUTH_LIMITS.recovery),
    factorNetwork: limiter(AUTH_LIMITS.factor),
    registerAccount: limiter(5, { keyGenerator: emailKey }),
    // Successful sign-in (including the password-to-2FA step) and temporary
    // server overload must not consume the failed-login allowance.
    loginFailures: limiter(10, { keyGenerator: emailKey, skipSuccessfulRequests: true,
      requestWasSuccessful: (_req, res) => res.statusCode < 400 || res.statusCode >= 500 }),
    recoveryEmail: limiter(5, { keyGenerator: emailKey }),
    resetEmail: limiter(5, { keyGenerator: emailKey }),
    factorAccount: limiter(5, { keyGenerator: req => signedIdentity(req, 'second-factor') || 'network:' + networkKey(req) }),
    protectedFactorAccount: limiter(5, { keyGenerator: req => 'account:' + req.user.id })
  };
}
module.exports = { createAuthRateLimits, signedIdentity, networkKey, AUTH_LIMITS, WINDOW_MS };
