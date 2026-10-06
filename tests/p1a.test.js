// Synthetic rows/tokens and in-memory DB/email doubles only. Never loads dotenv.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const http = require('node:http');
const express = require('express'), morgan = require('morgan');
const { Writable } = require('node:stream');
const { userResponse, scholarProfileResponse } = require('../src/utils/userResponses');
const { logError, requestPath, requestLogger } = require('../src/utils/safeLogging');

const security = {
  password: 'SYNTHETIC_PASSWORD_HASH', refresh_token: 'SYNTHETIC_OLD_REFRESH',
  password_reset_token: 'SYNTHETIC_RESET_HASH', password_reset_expires: new Date(),
  two_factor_secret: 'SYNTHETIC_TOTP_SECRET', two_factor_backup_codes: 'SYNTHETIC_BACKUP_CODES',
  refresh_token_expires: new Date(), reset_token_used: 0, failed_login_attempts: 0,
  locked_until: null, future_auth_credential: 'SYNTHETIC_FUTURE_CREDENTIAL',
  unknown_column: 'SYNTHETIC_UNRECOGNIZED_DATA'
};
const product = {
  id: 7, fname: 'Synthetic', lname: 'Learner', name: 'Synthetic Learner',
  email: 'synthetic@example.invalid', isScholar: 1, is_scholar: 1,
  created_at: new Date('2026-01-01T00:00:00Z'), updated_at: null,
  bio: 'Fixture bio', favorite_subject: 'Mathematics', favorite_food: 'Rice',
  hobbies: 'Reading', profile_image_url: 'uploads/profile-images/fixture.png',
  avatar_id: 'avatar_08', university_id: 1, degree_programme: 'Engineering'
};
const scholar = {
  id: 4, user_id: 7, university: 'Fixture University', degree: 'Engineering',
  year: '2028', approved: 1, task_card_url: 'uploads/task-cards/fixture.pdf',
  created_at: product.created_at, updated_at: null, university_id: 1,
  country_id: 1, country_name: 'Finland', country_code: 'FI',
  stripe_account_id: 'acct_synthetic_identifier', stripe_onboarding_complete: 1,
  stripe_charges_enabled: 1, stripe_payouts_enabled: 1, stripe_details_submitted: 1
};
function response() {
  return { statusCode: 200, status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; } };
}
function noSecurityFields(value) {
  assert.ok(value);
  for (const key of Object.keys(security)) assert.equal(Object.hasOwn(value, key), false, key);
}
function load(file, overrides = {}) {
  const logs = [], logger = Object.fromEntries(['log', 'warn', 'error'].map(level => [level, (...args) => logs.push({ level, args })]));
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), {
    module, console: logger, Date, Buffer,
    process: { env: { JWT_SECRET: 'SYNTHETIC_SIGNING_KEY', FRONTEND_URL: 'https://frontend.example.invalid' } },
    require(name) {
      if (Object.hasOwn(overrides, name)) return overrides[name];
      if (name === '../utils/userResponses') return { userResponse, scholarProfileResponse };
      if (['../utils/safeLogging', './safeLogging'].includes(name)) return { logError: (event, error) => logError(event, error, logger) };
      if (name === 'bcryptjs' || name === 'crypto') return require(name);
      throw Error('Unexpected dependency: ' + name);
    }
  }, { filename: file });
  return { controller: module.exports, logs };
}
function userController(row) {
  return load('controller/userController.js', {
    '../models/User': { UserModel: { findById: async () => [[row]] } },
    '../config/db': { pool: { query: async () => [[{ role_name: 'Learner' }]] } },
    '../utils/learnerPreferences': { learnerPreferences: async () => ({}) }
  });
}

for (const [label, hidden] of [['populated', security], ['null', Object.fromEntries(Object.keys(security).map(key => [key, null]))]]) {
  test(`self-profile excludes ${label} security columns and preserves product fields`, async () => {
    const row = { ...product, ...hidden };
    const { controller } = userController(row), res = response();
    await controller.getUserProfile({ user: { id: 7 } }, res);
    noSecurityFields(res.body);
    for (const [key, value] of Object.entries(product)) assert.deepEqual(res.body[key], value, key);
    assert.deepEqual(Array.from(res.body.roles), ['Learner']);
    assert.deepEqual(row, { ...product, ...hidden }, 'serialization must not mutate the model row');
  });
}
test('allowlists reject future columns and arbitrary nested values in scalar fields', () => {
  const projected = userResponse({ ...product, ...security, bio: { authentication_secret: 'SYNTHETIC_NESTED' } });
  noSecurityFields(projected);
  assert.equal(Object.hasOwn(projected, 'bio'), false);
  const inherited = Object.create({ email: 'inherited@example.invalid' });
  inherited.id = 7;
  assert.deepEqual(userResponse(inherited), { id: 7 });
});
test('missing optional preferences stay absent; available null preferences stay present', () => {
  assert.equal(Object.hasOwn(userResponse({ id: 7 }), 'avatar_id'), false);
  const value = userResponse({ id: 7, avatar_id: null, university_id: null, degree_programme: null });
  assert.deepEqual(value, { id: 7, avatar_id: null, university_id: null, degree_programme: null });
});
test('legacy individual and list user responses use the same credential exclusions', async () => {
  const { controller } = userController({ ...product, ...security }), res = response();
  await controller.getOneUser({ params: { id: 7 } }, res);
  noSecurityFields(res.body[0]);
  assert.equal(res.body[0].email, product.email);
  const lists = load('controller/userController.js', {
    '../models/User': { UserModel: {} }, '../utils/learnerPreferences': {},
    '../config/db': { pool: { query: async () => [[{ ...product, ...security, roles: 'Learner,Scholar' }]] } }
  });
  for (const method of ['getAllUsers', 'getAllUsersWithRoles']) {
    const result = response(); await lists.controller[method]({}, result);
    noSecurityFields(result.body[0]); assert.equal(result.body[0].is_scholar, 1);
    if (method.endsWith('WithRoles')) assert.deepEqual(Array.from(result.body[0].roles), ['Learner', 'Scholar']);
  }
});

function authHarness({ register = false, failure } = {}) {
  const row = { ...product, ...security, two_factor_enabled: 0 }, mutations = [];
  const model = {
    findByEmail: async () => [register ? [] : [row]], findById: async () => [[row]],
    create: async () => [{ insertId: 7 }], resetFailedAttempts: async () => {}, updateLastLogin: async () => {},
    updateRefreshToken: async (...args) => mutations.push(args), updateLastActivity: async () => {}
  };
  const result = load('controller/authController.js', {
    '../models/User': { UserModel: model },
    '../models/userRole': { UserRoleModel: { assignRole: async () => {}, getRolesById: async () => [[{ name: 'Learner' }, { name: 'Scholar' }]] } },
    '../models/scholarProfile': { ScholarProfileModel: { create: async () => {}, findByUserId: async () => [[{ ...scholar, ...security }]] } },
    '../utils/passwordHasher': { hashPassword: async () => 'SYNTHETIC_HASH', verifyPassword: async () => ({ valid: true, needsRehash: false }) },
    '../config/db': { pool: { query: async () => { if (failure) throw failure; return [[row]]; } } },
    jsonwebtoken: { sign: () => 'SYNTHETIC_NEW_ACCESS_TOKEN' }
  });
  return { ...result, mutations, row };
}
test('registration projects user and nested Scholar product data, not credential rows', async () => {
  const h = authHarness({ register: true }), res = response();
  await h.controller.userRegister({ body: { fname: 'Synthetic', lname: 'User', email: product.email,
    password: 'SyntheticStrong!9', isScholar: true, scholarData: { university: scholar.university, degree: scholar.degree, year: scholar.year } } }, res);
  assert.equal(res.statusCode, 201); noSecurityFields(res.body.user); noSecurityFields(res.body.user.scholarProfile);
  assert.equal(res.body.user.scholarProfile.degree, scholar.degree);
  assert.equal(res.body.token, 'SYNTHETIC_NEW_ACCESS_TOKEN');
  assert.equal(h.row.password, security.password, 'model credentials remain internal and unchanged');
});
test('login excludes stored credentials but retains intentional new token envelope and role/product fields', async () => {
  const h = authHarness(), res = response();
  await h.controller.login({ body: { email: product.email, password: 'SYNTHETIC_PASSWORD' } }, res);
  assert.equal(res.statusCode, 200); noSecurityFields(res.body.user); noSecurityFields(res.body.scholarProfile);
  assert.deepEqual(res.body.user, product);
  assert.deepEqual(Array.from(res.body.roles), ['Learner', 'Scholar']);
  assert.equal(res.body.token, 'SYNTHETIC_NEW_ACCESS_TOKEN');
  assert.equal(res.body.refreshToken, h.mutations[0][1]);
  assert.notEqual(res.body.refreshToken, security.refresh_token);
  assert.equal(res.body.expiresIn, 3600);
});
test('refresh keeps its explicit token-only envelope and never serializes the selected User row', async () => {
  const h = authHarness(), res = response();
  await h.controller.refreshAccessToken({ body: { refreshToken: 'SYNTHETIC_INPUT_REFRESH' } }, res);
  assert.deepEqual(Object.keys(res.body).sort(), ['expiresIn', 'refreshToken', 'token']);
  assert.equal(res.body.refreshToken, h.mutations[0][1]);
  assert.equal(res.body.expiresIn, 3600);
  assert.equal(JSON.stringify(res.body).includes(security.password), false);
});
test('Scholar status preserves academic and onboarding fields while excluding unknown credentials', async () => {
  const h = load('controller/scholarProfileController.js', {
    '../config/db': { pool: { query: async sql => [sql.includes('SELECT isScholar') ? [{ isScholar: 1 }] : [{ approved: 1 }]] } },
    '../utils/academicContext': { scholarContext: async () => ({ ...scholar, ...security }) }
  }), res = response();
  await h.controller.getScholarProfileStatus({ user: { id: 7 } }, res);
  noSecurityFields(res.body.profile); assert.deepEqual(res.body.profile, scholar);
  assert.equal(res.body.approved, true);
  assert.equal(scholarProfileResponse(null), null);
});
test('profile failure responses/logs never serialize a raw credential-bearing database error', async () => {
  const sensitive = Object.assign(new Error('SYNTHETIC_ERROR_SECRET'), { code: 'ER_BAD_FIELD_ERROR', sql: 'SYNTHETIC_SQL_SECRET', authorization: 'SYNTHETIC_AUTH' });
  const h = load('controller/userController.js', {
    '../models/User': { UserModel: { findById: async () => { throw sensitive; } } },
    '../config/db': { pool: {} }, '../utils/learnerPreferences': {}
  }), res = response();
  await h.controller.getUserProfile({ user: { id: 7 } }, res);
  assert.equal(res.statusCode, 500);
  assert.equal(Object.hasOwn(res.body, 'error'), false);
  assert.equal(JSON.stringify([res.body, h.logs]).includes('SYNTHETIC_ERROR_SECRET'), false);
  assert.equal(JSON.stringify(h.logs).includes('SYNTHETIC_SQL_SECRET'), false);
});

const sentinel = 'SYNTHETIC_NEVER_LOG';
function assertNoSentinels(logs, secrets = [sentinel]) {
  const text = JSON.stringify(logs);
  for (const secret of secrets) assert.equal(text.includes(secret), false, 'sensitive value reached logs');
}
test('safe error logging drops message/stack/SQL/body/headers and unrecognized error codes', () => {
  const logs = [], logger = { error: (...args) => logs.push(args) };
  const err = Object.assign(new Error(sentinel), { code: sentinel, sql: sentinel, body: { refreshToken: sentinel }, headers: { authorization: sentinel, cookie: sentinel } });
  logError('Operation failed', err, logger);
  assert.deepEqual(logs, [['Operation failed', { code: 'UNEXPECTED_ERROR' }]]);
  err.code = 'EAUTH'; logError('Email delivery failed', err, logger);
  assert.deepEqual(logs[1], ['Email delivery failed', { code: 'EAUTH' }]);
  assertNoSentinels(logs);
});
test('password-reset email failure never logs reset URL/token, recipient, Authorization or cookies', async () => {
  let resetURL;
  const h = load('controller/passwordController.js', {
    '../models/User': { UserModel: { findByEmail: async () => [[{ id: 7, fname: 'Synthetic' }]] } },
    '../models/userRole': { UserRoleModel: { getRolesById: async () => [[{ name: 'Learner' }]] } },
    '../config/db': { pool: { query: async sql => { assert.doesNotMatch(sql, /ALTER TABLE/); return [sql.startsWith('SELECT COLUMN_NAME') ? [{}, {}] : []]; } } },
    '../utils/emailService': { sendPasswordResetEmail: async (email, url) => { resetURL = url; return { success: false, error: sentinel }; } },
    '../utils/passwordHasher': {}
  }), res = response();
  await h.controller.requestPasswordReset({ body: { email: 'synthetic-recipient@example.invalid' }, headers: { authorization: sentinel, cookie: sentinel } }, res);
  assert.equal(res.statusCode, 200);
  assert.ok(resetURL.startsWith('https://frontend.example.invalid/reset-password?token='));
  const token = new URL(resetURL).searchParams.get('token');
  assertNoSentinels(h.logs, [sentinel, resetURL, token, 'synthetic-recipient@example.invalid']);
  assert.ok(h.logs.some(log => log.args[0] === 'Password reset email delivery failed'));
});
test('real email helper with an SMTP double keeps reset link in mail but not failure logs/result', async () => {
  let mail;
  const error = Object.assign(new Error(sentinel), { code: 'EAUTH', command: sentinel, response: sentinel });
  const h = load('utils/emailService.js', {
    nodemailer: { createTransport: () => ({ sendMail: async options => { mail = options; throw error; } }) }
  });
  const url = 'https://frontend.example.invalid/reset-password?token=' + sentinel;
  const result = await h.controller.sendPasswordResetEmail('synthetic@example.invalid', url, 'Synthetic');
  assert.ok(mail.text.includes(url), 'existing reset email content must remain functional');
  assert.equal(result.success, false); assert.equal(result.error, 'Email delivery failed');
  assertNoSentinels(h.logs);
});
test('refresh query failures cannot log the supplied bearer credential or raw driver fields', async () => {
  const h = authHarness({ failure: Object.assign(new Error(sentinel), { code: 'ER_BAD_FIELD_ERROR', sql: sentinel }) }), res = response();
  await h.controller.refreshAccessToken({ body: { refreshToken: sentinel }, headers: { authorization: sentinel, cookie: sentinel } }, res);
  assert.equal(res.statusCode, 500); assertNoSentinels(h.logs);
});
test('request pathname excludes every query value, fragment and absolute-target credentials', () => {
  for (const target of ['/example?token=' + sentinel + '&normal=value',
    '/example?futureCredential=' + sentinel, '/example#' + sentinel,
    'https://user:' + sentinel + '@example.invalid/example?x=' + sentinel]) {
    assert.equal(requestPath({ originalUrl: target, url: '/router-relative' }), '/example');
  }
  assert.equal(requestPath({ url: 'http://[invalid]?token=' + sentinel }), '[invalid-path]');
});
test('pathname cannot inject raw control or Unicode line separators into logs', () => {
  const pathname = requestPath({ url: '/example\u2028FORGED\u0085LINE?token=' + sentinel });
  assert.doesNotMatch(pathname, /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
  assert.equal(pathname.includes(sentinel), false);
});
async function request(server, target) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: server.address().port, path: target,
      headers: { Authorization: 'Bearer ' + sentinel, Cookie: sentinel, Connection: 'close' } }, res => {
      res.resume(); res.on('end', resolve);
    });
    req.on('error', reject);
  });
}
for (const production of [false, true]) {
  test(`${production ? 'production file' : 'development console'} access format preserves method/path/status but omits secrets`, async t => {
    let output = '';
    const stream = new Writable({ write(chunk, encoding, callback) { output += chunk.toString(); callback(); } });
    const app = express(); app.use(requestLogger(morgan, { production, stream }));
    app.get('/example', (req, res) => res.status(200).send('ok'));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    await request(server, '/example?token=' + sentinel + '&normal=value');
    await request(server, '/example');
    assert.equal(output.includes(sentinel), false); assert.equal(output.includes('normal='), false);
    assert.match(output, /GET \/example 200/);
    assert.equal(output.trim().split('\n').length, 2);
  });
}
test('production logging still skips health and uploads without leaking their query values', async t => {
  let output = '';
  const stream = new Writable({ write(chunk, encoding, callback) { output += chunk; callback(); } });
  const app = express(); app.use(requestLogger(morgan, { production: true, stream }));
  app.use((req, res) => res.sendStatus(200));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  for (const target of ['/health?token=' + sentinel, '/uploads/file.png?token=' + sentinel]) await request(server, target);
  assert.equal(output, '');
});
