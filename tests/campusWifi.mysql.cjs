'use strict';
// Explicit, disposable loopback MySQL fixture only. No dotenv, real email,
// production credentials, Vimeo, Stripe or Paystack calls are used.
const test = require('node:test'), assert = require('node:assert/strict');
if (process.env.CAMPUS_WIFI_MYSQL_TEST !== '1') throw Error('Explicit isolated campus MySQL fixture required');
const mysql = require('mysql2/promise'), express = require('express');
const { randomBytes } = require('node:crypto');
process.env.JWT_SECRET = randomBytes(32).toString('hex');
const schema = 'uniclips_campus_wifi_test';
const config = { host: '127.0.0.1', port: 33316, user: 'root', password: '', connectTimeout: 5000 };
let pool;

test('200 shared-IP students complete real registration, login, refresh and authorized database reads', { timeout: 300000 }, async t => {
  const admin = await mysql.createConnection(config);
  try {
    const [existing] = await admin.query('SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME=?', [schema]);
    assert.equal(existing.length, 0, 'refuse to reuse or delete an existing fixture database');
    await admin.query('CREATE DATABASE ' + schema);
  } finally { await admin.end(); }
  pool = mysql.createPool({ ...config, database: schema, connectionLimit: 10, queueLimit: 20, waitForConnections: true });
  t.after(async () => { if (pool) await pool.end(); });
  const [[where]] = await pool.query('SELECT DATABASE() AS name'); assert.equal(where.name, schema);
  await pool.query('CREATE TABLE users (id INT AUTO_INCREMENT PRIMARY KEY,fname VARCHAR(100),lname VARCHAR(100),email VARCHAR(254) UNIQUE,password VARCHAR(255),isScholar TINYINT DEFAULT 0,refresh_token VARCHAR(500),refresh_token_expires DATETIME,last_login DATETIME,last_activity DATETIME,failed_login_attempts INT DEFAULT 0,locked_until DATETIME,last_failed_login DATETIME,password_reset_token VARCHAR(255),password_reset_expires DATETIME,reset_token_used TINYINT DEFAULT 0,two_factor_secret VARCHAR(255),two_factor_enabled TINYINT DEFAULT 0,two_factor_backup_codes TEXT)');
  await pool.query('CREATE TABLE roles (id INT PRIMARY KEY,name VARCHAR(30))');
  await pool.query("INSERT INTO roles VALUES (1,'Admin'),(2,'Learner'),(3,'Scholar'),(4,'SuperAdmin')");
  await pool.query('CREATE TABLE user_roles (user_id INT,role_id INT,PRIMARY KEY(user_id,role_id))');
  await pool.query('CREATE TABLE scholar_profile (id INT,user_id INT,approved TINYINT)');
  const dbFile = require.resolve('../src/config/db');
  require.cache[dbFile] = { id: dbFile, filename: dbFile, loaded: true, exports: { pool } };
  const { sharedAuthAdmission } = require('../src/middleware/authAdmission');
  const app = express(); app.use(express.json()); app.use('/api', require('../src/middleware/apiRateLimiter').createApiRateLimiter());
  app.use('/api/auth', require('../src/routes/authRoutes'));
  app.get('/api/me', require('../src/middleware/auth').authMiddleware, async (q, s) => {
    const [[row]] = await pool.query('SELECT id FROM users WHERE id=?', [q.user.id]); s.json({ id: row.id });
  });
  const server = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const root = 'http://127.0.0.1:' + server.address().port;
  const request = async (route, body, token) => {
    const response = await fetch(root + route, { method: body ? 'POST' : 'GET', headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {})
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = await response.json(); assert.ok(response.status < 500, 'no unhandled database or authentication error');
    return { status: response.status, body: result };
  };
  let completed = 0, maxActive = 0;
  const start = Date.now(), sampler = setInterval(() => { maxActive = Math.max(maxActive, sharedAuthAdmission.status().active); }, 5);
  try {
    // Ten overlapping journeys exercise queued admission without pretending
    // that 200 simultaneous password requests must all fit a small server.
    for (let batch = 0; batch < 200; batch += 10) await Promise.all(Array.from({ length: 10 }, async (_, offset) => {
      const index = batch + offset + 1, email = 'campus' + index + '@example.invalid', password = 'SyntheticStrong!9-' + index;
      const registration = await request('/api/auth', { fname: 'Synthetic', lname: 'Learner', email, password, isScholar: false });
      assert.equal(registration.status, 201, 'register ' + index);
      const login = await request('/api/auth/login', { email, password }); assert.equal(login.status, 200, 'login ' + index);
      const refresh = await request('/api/auth/refresh-token', { refreshToken: login.body.refreshToken }); assert.equal(refresh.status, 200, 'refresh ' + index);
      const profile = await request('/api/me', null, refresh.body.token); assert.equal(profile.status, 200, 'profile ' + index);
      assert.equal(profile.body.id, registration.body.user.id);
      if (index === 1) assert.equal((await request('/api/me', null, login.body.token)).status, 401, 'rotation still revokes the previous access binding');
      completed++;
    }));
  } finally { clearInterval(sampler); }
  const [[counts]] = await pool.query('SELECT (SELECT COUNT(*) FROM users) AS users,(SELECT COUNT(*) FROM user_roles WHERE role_id=2) AS learners,(SELECT COUNT(*) FROM users WHERE refresh_token IS NOT NULL) AS sessions,(SELECT COUNT(*) FROM users u LEFT JOIN user_roles r ON r.user_id=u.id WHERE r.user_id IS NULL) AS orphaned');
  assert.equal(completed, 200); assert.equal(Number(counts.users), 200); assert.equal(Number(counts.learners), 200); assert.equal(Number(counts.sessions), 200); assert.equal(Number(counts.orphaned), 0);
  assert.equal(sharedAuthAdmission.status().active, 0); assert.equal(sharedAuthAdmission.status().queued, 0); assert.ok(maxActive <= 2);
  console.log(JSON.stringify({ isolated: true, sharedIpStudents: completed, realArgon2AndMySQL: true, overlappingJourneys: 10, maxActiveAuthentication: maxActive,
    orphanedAccounts: 0, rotationRevocationVerified: true, durationMs: Date.now() - start, productionLoadTest: false }));
});
