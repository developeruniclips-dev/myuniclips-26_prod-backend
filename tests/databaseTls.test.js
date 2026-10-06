const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const tls = require('node:tls');
const { X509Certificate } = require('node:crypto');
const { buildPoolConfig, verifyDatabaseConnection } = require('../src/config/databaseTls');

// Reuse an already installed public trust root. Never generate/export a CA.
const ca = Buffer.from(tls.rootCertificates.find(pem => {
  const c = new X509Certificate(pem);
  return c.ca && Date.parse(c.validFrom) < Date.now() && Date.parse(c.validTo) > Date.now();
}));
const production = { NODE_ENV: 'production', DB_HOST: 'database.example.invalid',
  DB_USER: 'private_user_fixture', DB_PASS: 'private_password_fixture', DB_NAME: 'private_database_fixture',
  DB_SSL: 'true', DB_SSL_CA: '/fixture/ca.pem' };
const loadCA = () => ca;

test('production TLS builds only verified mysql2-supported options', () => {
  const config = buildPoolConfig(production, loadCA);
  assert.ok(config.ssl.ca === ca);
  assert.equal(config.ssl.rejectUnauthorized, true);
  assert.equal(config.ssl.verifyIdentity, true);
  assert.equal(config.ssl.minVersion, 'TLSv1.2');
});

for (const [label, value] of [['missing', undefined], ['empty', ''], ['false', 'false'],
  ['uppercase', 'TRUE'], ['whitespace', 'true '], ['unsupported', '1'], ['boolean', true]]) {
  test(`production DB_SSL ${label} fails before a CA read or pool creation`, () => {
    let reads = 0;
    assert.throws(() => buildPoolConfig({ ...production, DB_SSL: value }, () => { reads++; return ca; }),
      e => /^DB_(TLS_REQUIRED|SSL_INVALID)$/.test(e.code));
    assert.equal(reads, 0);
  });
}

test('missing/blank CA path fails; DB_SSL_CA is a path, never inline PEM/base64', () => {
  for (const value of [undefined, '', '   ']) assert.throws(() => buildPoolConfig({ ...production, DB_SSL_CA: value }, loadCA), { code: 'DB_TLS_CA_REQUIRED' });
  let requested;
  buildPoolConfig(production, p => { requested = p; return ca; });
  assert.equal(requested, '/fixture/ca.pem');
});

test('nonexistent/unreadable CA fails without forwarding sensitive filesystem errors', () => {
  for (const code of ['ENOENT', 'EACCES']) {
    assert.throws(() => buildPoolConfig(production, () => {
      throw Object.assign(new Error('private_host_fixture private_password_fixture private_path_fixture'), { code });
    }), e => {
      assert.equal(e.code, 'DB_TLS_CA_UNREADABLE');
      assert.equal(e.message, 'Database TLS configuration invalid (DB_TLS_CA_UNREADABLE)');
      assert.equal(e.cause, undefined); return true;
    });
  }
});

test('empty, malformed and mixed-content CA bundles fail closed', () => {
  for (const invalid of [Buffer.alloc(0), Buffer.from('invalid'),
    Buffer.from('-----BEGIN CERTIFICATE-----\ninvalid\n-----END CERTIFICATE-----'),
    Buffer.concat([ca, Buffer.from('\nprivate_key_or_garbage')])]) {
    assert.throws(() => buildPoolConfig(production, () => invalid), { code: 'DB_TLS_CA_INVALID' });
  }
});

test('expired and not-yet-valid CA certificates fail before pool creation', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/config/databaseTls.js'), 'utf8');
  for (const now of [0, Date.parse('2099-01-01')]) {
    const module = { exports: {} };
    vm.runInNewContext(source, { module, require, Date: { now: () => now, parse: Date.parse } });
    assert.throws(() => module.exports.buildPoolConfig(production, loadCA), { code: 'DB_TLS_CA_INVALID' });
  }
});

test('only explicit loopback development/test can use plaintext; unknown environment cannot', () => {
  for (const NODE_ENV of ['development', 'test']) for (const DB_HOST of ['127.0.0.1', 'localhost', '::1']) {
    assert.equal(buildPoolConfig({ NODE_ENV, DB_HOST, DB_SSL: 'false' }).ssl, undefined);
  }
  for (const NODE_ENV of [undefined, '', 'production', 'Production', 'production ', 'staging']) {
    assert.throws(() => buildPoolConfig({ NODE_ENV, DB_HOST: 'localhost' }), { code: 'DB_TLS_REQUIRED' });
  }
  for (const NODE_ENV of ['development', 'test']) {
    assert.throws(() => buildPoolConfig({ NODE_ENV, DB_HOST: 'database.example.invalid' }), { code: 'DB_TLS_REQUIRED' });
    assert.throws(() => buildPoolConfig({ ...production, NODE_ENV }, () => { throw Error('unreadable'); }), { code: 'DB_TLS_CA_UNREADABLE' });
  }
});

test('TLS refuses IP hosts because the installed driver skips its explicit identity check', () => {
  for (const DB_HOST of ['127.0.0.1', '::1', '192.0.2.1', 'https://example.invalid', '']) {
    assert.throws(() => buildPoolConfig({ ...production, DB_HOST }, loadCA), { code: 'DB_TLS_HOSTNAME_REQUIRED' });
  }
});

function connectionDouble(values) {
  const state = { queries: [], release: 0, destroy: 0, logs: [] };
  const connection = {
    query: async sql => { state.queries.push(sql); return [[{ Value: values[sql.includes('Ssl_cipher') ? 0 : 1] }]]; },
    release: () => state.release++, destroy: () => state.destroy++
  };
  return { state, connection, pool: { getConnection: async () => connection }, logger: { log: s => state.logs.push(s) } };
}

test('startup verifies cipher and version on the same acquired connection before logging TLS', async () => {
  const d = connectionDouble(['TLS_AES_128_GCM_SHA256', 'TLSv1.3']);
  await verifyDatabaseConnection(d.pool, buildPoolConfig(production, loadCA), d.logger);
  assert.deepEqual(d.state.queries, ["SHOW SESSION STATUS LIKE 'Ssl_cipher'", "SHOW SESSION STATUS LIKE 'Ssl_version'"]);
  assert.deepEqual(d.state.logs, ['Database connection established with TLS']);
  assert.equal(d.state.release, 1); assert.equal(d.state.destroy, 0);
});

test('missing cipher/version destroys the connection and never logs a TLS success', async () => {
  for (const values of [['', 'TLSv1.3'], ['TLS_AES_128_GCM_SHA256', ''], ['', '']]) {
    const d = connectionDouble(values);
    await assert.rejects(verifyDatabaseConnection(d.pool, buildPoolConfig(production, loadCA), d.logger), { code: 'DB_TLS_NOT_NEGOTIATED' });
    assert.equal(d.state.destroy, 1); assert.equal(d.state.release, 0); assert.deepEqual(d.state.logs, []);
  }
});

test('driver errors are fatal and sanitized; no second plaintext connection attempt', async () => {
  let attempts = 0;
  const pool = { getConnection: async () => { attempts++; throw Error(Object.values(production).join(' ')); } };
  await assert.rejects(verifyDatabaseConnection(pool, buildPoolConfig(production, loadCA)), e => {
    assert.equal(e.message, 'Database connection initialization failed');
    assert.equal(e.code, 'DB_CONNECTION_FAILED'); assert.equal(e.cause, undefined); return true;
  });
  assert.equal(attempts, 1);
});

test('actual db module rejects CA failure before createPool; successful logs contain no identifiers', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/config/db.js'), 'utf8');
  for (const invalid of [true, false]) {
    let pools = 0; const logs = [];
    const module = { exports: {} };
    const context = { module, console: { log: s => logs.push(s) }, require(name) {
      if (name === 'dotenv') return { config() {} };
      if (name === 'mysql2/promise') return { createPool: () => { pools++; return {}; } };
      if (name === './databaseTls') return { buildPoolConfig: () => buildPoolConfig(production, () => {
        if (invalid) throw Error('private_password_fixture'); return ca;
      }), verifyDatabaseConnection: async () => {} };
      throw Error('Unexpected dependency');
    } };
    if (invalid) assert.throws(() => vm.runInNewContext(source, context), { code: 'DB_TLS_CA_UNREADABLE' });
    else { vm.runInNewContext(source, context); await module.exports.initializeDatabase(); }
    assert.equal(pools, invalid ? 0 : 1);
    assert.deepEqual(logs, invalid ? [] : ['Database TLS configuration loaded']);
  }
});

function startupDouble(ready) {
  const state = { listens: 0, ended: 0, logs: [] }, processDouble = { env: { NODE_ENV: 'production' } };
  const app = { set() {}, use() {}, post() {}, get() {}, listen(port, callback) { state.listens++; callback(); } };
  const express = () => app; for (const key of ['raw', 'json', 'static']) express[key] = () => () => {};
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8'), {
    process: processDouble, module, __dirname: '/fixture/src', console: { log() {}, error: s => state.logs.push(s) }, require(name) {
      if (name === 'express') return express;
      if (name === 'dotenv') return { config() {} };
      if (name === 'path') return path;
      if (name === 'fs') return { existsSync: () => true, createWriteStream: () => ({}) };
      if (name === './config/db') return { initializeDatabase: () => ready, pool: { end: async () => state.ended++ } };
      if (name === './middleware/apiRateLimiter') return { createApiRateLimiter: () => () => {} };
      if (name === './controller/stripeWebhookController') return { stripeWebhook: () => {} };
      if (['cors', 'helmet', 'express-rate-limit', 'morgan'].includes(name)) return () => () => {};
      if (['./routes', './routes/purchaseRoutes'].includes(name)) return () => {};
      throw Error('Unexpected dependency');
    }
  });
  return { state, processDouble, startup: module.exports.startup };
}

test('HTTP does not listen before verified DB readiness; failure closes pool and exits unsuccessfully', async () => {
  let resolve; const good = startupDouble(new Promise(r => { resolve = r; }));
  assert.equal(good.state.listens, 0); resolve(); await good.startup; assert.equal(good.state.listens, 1);
  const bad = startupDouble(Promise.reject(Error('private_host_fixture private_password_fixture')));
  await bad.startup;
  assert.equal(bad.state.listens, 0); assert.equal(bad.state.ended, 1); assert.equal(bad.processDouble.exitCode, 1);
  assert.deepEqual(bad.state.logs, ['Database initialization failed; server not started']);
});
