'use strict';
// Loopback HTTP, synthetic credentials and controller doubles only. No dotenv,
// production database, SMTP, media provider or payment endpoint is loaded.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { randomBytes } = require('node:crypto');
const express = require('express'), jwt = require('jsonwebtoken');
process.env.JWT_SECRET = randomBytes(32).toString('hex');
const { createAuthRateLimits, signedIdentity } = require('../src/middleware/authRateLimits');
const { createAuthAdmission } = require('../src/middleware/authAdmission');
const { createApiRateLimiter } = require('../src/middleware/apiRateLimiter');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(r => setImmediate(r));
const access = (id, extra = {}, key = process.env.JWT_SECRET) => jwt.sign({ id, purpose: 'access', session: 'a'.repeat(64), ...extra }, key, { ...('exp' in extra ? {} : { expiresIn: '1h' }), algorithm: 'HS256' });
const challenge = id => jwt.sign({ id, purpose: 'second-factor', binding: 'b'.repeat(64), jti: 'c'.repeat(64) }, process.env.JWT_SECRET, { expiresIn: '5m' });

async function serverFor(t, app) {
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const root = 'http://127.0.0.1:' + server.address().port;
  return async (url, body, token, signal) => {
    const response = await fetch(root + url, { method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal });
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
}

// Mount the real auth route declarations, replacing business effects only.
function authRoutes(controllers, admission) {
  const module = { exports: {} }, noop = (_q, _s, next) => next();
  const replacements = {
    '../controller/authController': controllers,
    '../middleware/auth': { authMiddleware: noop },
    '../middleware/validators': { registerValidation: [noop], loginValidation: [noop] },
    '../middleware/uploadSecurity': { createUpload: () => noop },
    '../middleware/uploadAdmission': { applicantAdmission: noop },
    '../utils/uploadBarrier': { shared: { ingress: () => noop, wrap: handler => handler } },
    '../middleware/authRateLimits': { createAuthRateLimits },
    '../middleware/authAdmission': { sharedAuthAdmission: admission }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/routes/authRoutes.js'), 'utf8'), {
    module, require: name => name in replacements ? replacements[name] : require(name)
  });
  return module.exports;
}

test('200 students on one real shared IP can each register, sign in, refresh and browse', async t => {
  const app = express(), users = new Map(), admission = createAuthAdmission();
  let nextId = 0;
  app.use(express.json()); app.use('/api', createApiRateLimiter());
  app.use('/api/auth', authRoutes({
    userRegister: async (q, s) => { users.set(q.body.email, ++nextId); s.status(201).json({ id: nextId }); },
    login: async (q, s) => s.json({ token: access(users.get(q.body.email)) }),
    refreshAccessToken: async (_q, s) => s.json({ refreshed: true }),
    becomeScholar: (_q, s) => s.json({}), logout: (_q, s) => s.json({})
  }, admission));
  app.get('/api/courses', (_q, s) => s.json({ courses: [] }));
  const request = await serverFor(t, app);
  for (let n = 1; n <= 200; n++) {
    const email = 'student' + n + '@example.invalid';
    assert.equal((await request('/api/auth', { email })).status, 201, 'registration ' + n);
    const login = await request('/api/auth/login', { email }); assert.equal(login.status, 200, 'login ' + n);
    assert.equal((await request('/api/auth/refresh-token', { refreshToken: 'synthetic' })).status, 200, 'refresh ' + n);
    for (let read = 0; read < 5; read++) assert.equal((await request('/api/courses', undefined, login.body.token)).status, 200, 'browse ' + n);
  }
  assert.equal(users.size, 200); assert.equal(admission.status().active, 0); assert.equal(admission.status().queued, 0);
});

test('one noisy signed-in student is limited without blocking others on the same Wi-Fi', async t => {
  const app = express(); app.use('/api', createApiRateLimiter()); app.get('/api/course', (_q, s) => s.json({ ok: true }));
  const request = await serverFor(t, app), first = access(1), second = access(2);
  for (let n = 0; n < 300; n++) assert.equal((await request('/api/course', undefined, first)).status, 200);
  assert.equal((await request('/api/course', undefined, first)).status, 429);
  assert.equal((await request('/api/course', undefined, second)).status, 200);
});

test('successful logins do not exhaust the failure budget; normalized email failures remain bounded', async t => {
  const app = express(), limits = createAuthRateLimits(); app.use(express.json());
  app.post('/', limits.loginNetwork, limits.loginFailures, (q, s) => s.status(q.body.good ? 200 : 401).json({}));
  const request = await serverFor(t, app);
  for (let n = 0; n < 20; n++) assert.equal((await request('/', { email: 'learner@example.invalid', good: true })).status, 200);
  for (let n = 0; n < 10; n++) assert.equal((await request('/', { email: n % 2 ? 'Learner@EXAMPLE.INVALID' : 'learner@example.invalid' })).status, 401);
  const limited = await request('/', { email: 'learner@example.invalid' });
  assert.equal(limited.status, 429); assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.equal((await request('/', { email: 'other@example.invalid', good: true })).status, 200);
});

test('temporary overload does not count as a bad password', async t => {
  const app = express(), limits = createAuthRateLimits(); app.use(express.json());
  app.post('/', limits.loginFailures, (q, s) => s.status(q.body.good ? 200 : 503).json({}));
  const request = await serverFor(t, app);
  for (let n = 0; n < 12; n++) assert.equal((await request('/', { email: 'busy@example.invalid' })).status, 503);
  assert.equal((await request('/', { email: 'busy@example.invalid', good: true })).status, 200);
});

test('recovery and second-factor attempts are isolated by normalized account on shared Wi-Fi', async t => {
  const app = express(), limits = createAuthRateLimits(); app.use(express.json());
  app.post('/recovery', limits.recoveryNetwork, limits.recoveryEmail, (_q, s) => s.json({}));
  app.post('/factor', limits.factorNetwork, limits.factorAccount, (_q, s) => s.json({}));
  const request = await serverFor(t, app);
  for (let id = 1; id <= 200; id++) {
    assert.equal((await request('/recovery', { email: 'person' + id + '@example.invalid' })).status, 200);
    assert.equal((await request('/factor', { challengeToken: challenge(id) })).status, 200);
  }
  for (let n = 0; n < 4; n++) assert.equal((await request('/factor', { challengeToken: challenge(1) })).status, 200);
  assert.equal((await request('/factor', { challengeToken: challenge(1) })).status, 429);
  assert.equal((await request('/factor', { challengeToken: challenge(201) })).status, 200);
});

test('only a verified, unexpired token of the right purpose selects an account bucket', () => {
  const request = token => ({ headers: { authorization: 'Bearer ' + token } });
  assert.equal(signedIdentity(request(access(7))), 'account:7');
  for (const token of [access(7, {}, 'wrong-synthetic-key'), access(7, { exp: 1 }), access(7, { purpose: 'second-factor' }), access('7'), access(7, { session: 'invalid' }), 'x'.repeat(4097), jwt.sign({ id: 7, purpose: 'access', session: 'a'.repeat(64) }, '', { algorithm: 'none' })]) {
    assert.equal(signedIdentity(request(token)), null);
  }
  assert.equal(signedIdentity({ headers: {}, user: { id: 99 } }), null, 'unverified req.user is not a bucket authority');
});

test('distinct IPv6 addresses in the same campus subnet share the network guard', async t => {
  const app = express(), limits = createAuthRateLimits(); app.set('trust proxy', 1); app.use(express.json());
  app.post('/', limits.registerNetwork, (_q, s) => s.json({}));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
  for (let n = 0; n <= 600; n++) {
    const result = await fetch('http://127.0.0.1:' + server.address().port, { method: 'POST', headers: { 'X-Forwarded-For': '2001:db8:1::' + (n + 1).toString(16) } });
    assert.equal(result.status, n < 600 ? 200 : 429); await result.json();
  }
});

test('authentication burst keeps active and queued work bounded, then drains without leaks', async () => {
  const admission = createAuthAdmission(), gate = deferred(); let peak = 0, started = 0;
  const work = Array.from({ length: 200 }, () => admission.run(async () => {
    started++; peak = Math.max(peak, admission.status().active); await gate.promise;
  }).then(() => 'done', e => e.code));
  await tick(); assert.deepEqual(admission.status(), { active: 2, queued: 40, maxActive: 2, maxQueued: 40 });
  gate.resolve(); const results = await Promise.all(work);
  assert.equal(peak, 2); assert.equal(started, 42);
  assert.equal(results.filter(r => r === 'AUTH_CAPACITY_BUSY').length, 158);
  assert.equal(admission.status().active, 0); assert.equal(admission.status().queued, 0);
});

test('expired and cancelled queued requests never run and do not leak slots', async () => {
  const admission = createAuthAdmission({ maxActive: 1, maxQueued: 2, waitMs: 30 }), gate = deferred(), controller = new AbortController();
  const active = admission.run(() => gate.promise); let writes = 0;
  const timeout = admission.run(() => { writes++; }).catch(e => e.code);
  const cancelled = admission.run(() => { writes++; }, { signal: controller.signal }).catch(e => e.code);
  controller.abort(); assert.equal(await cancelled, 'AUTH_REQUEST_CANCELLED');
  assert.equal(await timeout, 'AUTH_CAPACITY_BUSY'); assert.equal(writes, 0);
  gate.resolve(); await active;
  await assert.rejects(admission.run(() => { throw Error('fixture'); }), /fixture/);
  assert.equal(admission.status().active, 0); assert.equal(admission.status().queued, 0);
});

test('an active disconnected handler holds capacity until actual work finishes', async t => {
  const admission = createAuthAdmission({ maxActive: 1, maxQueued: 0 }), started = deferred(), gate = deferred();
  const app = express();
  app.post('/', admission.wrap(async (_q, s) => { started.resolve(); await gate.promise; if (!s.destroyed) s.json({}); }));
  const request = await serverFor(t, app), controller = new AbortController();
  const first = request('/', {}, undefined, controller.signal).catch(() => null);
  await started.promise; controller.abort(); await first; await tick();
  assert.equal(admission.status().active, 1);
  const second = await request('/', {}); assert.equal(second.status, 503); assert.equal(second.body.code, 'AUTH_CAPACITY_BUSY'); assert.equal(second.headers.get('retry-after'), '2');
  gate.resolve(); while (admission.status().active) await tick();
  assert.equal(admission.status().active, 0);
});

test('slow reset email delivery cannot occupy the sign-in work budget', async t => {
  const app = express(), admission = createAuthAdmission(), recoveryAdmission = createAuthAdmission({ maxActive: 1, maxQueued: 1 });
  const mail = deferred(), module = { exports: {} }, noop = (_q, _s, next) => next();
  const replacements = {
    '../middleware/authRateLimits': { createAuthRateLimits },
    '../middleware/authAdmission': { sharedAuthAdmission: admission, sharedRecoveryAdmission: recoveryAdmission },
    '../middleware/auth': { authMiddleware: noop },
    '../controller/passwordController': {
      requestPasswordReset: async (_q, s) => { s.json({}); await mail.promise; },
      resetPassword: async (_q, s) => s.json({}), changePassword: async (_q, s) => s.json({})
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/routes/passwordRoutes.js'), 'utf8'), {
    module, require: name => name in replacements ? replacements[name] : require(name)
  });
  app.use(express.json()); app.use('/password', module.exports);
  app.post('/login', admission.wrap(async (_q, s) => s.json({ signedIn: true })));
  const request = await serverFor(t, app);
  assert.equal((await request('/password/forgot', { email: 'person@example.invalid' })).status, 200);
  assert.equal(recoveryAdmission.status().active, 1);
  assert.equal(admission.status().active, 0);
  assert.equal((await request('/login', {})).status, 200);
  mail.resolve(); while (recoveryAdmission.status().active) await tick();
});
