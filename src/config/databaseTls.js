const fs = require('node:fs');
const net = require('node:net');
const tls = require('node:tls');
const { X509Certificate } = require('node:crypto');

function configurationError(code) {
  // Never include an environment value, filesystem error or provider message.
  const error = new Error(`Database TLS configuration invalid (${code})`);
  error.code = code;
  return error;
}

function buildPoolConfig(env = process.env, readCA = fs.readFileSync) {
  const config = {
    host: env.DB_HOST || '127.0.0.1', user: env.DB_USER || 'root',
    password: env.DB_PASS || '', database: env.DB_NAME || 'uniclips',
    port: env.DB_PORT ? Number(env.DB_PORT) : 3306,
    waitForConnections: true, connectionLimit: 10, queueLimit: 0
  };
  // Plaintext is permitted only for explicitly selected, loopback development
  // or tests. Omitted/unknown NODE_ENV never selects that exception.
  const localPlaintext = ['development', 'test'].includes(env.NODE_ENV)
    && ['127.0.0.1', '::1', 'localhost'].includes(config.host);
  const flag = env.DB_SSL;
  if (flag !== undefined && !['true', 'false', ''].includes(flag)) {
    throw configurationError('DB_SSL_INVALID');
  }
  if (flag !== 'true') {
    if (!localPlaintext) throw configurationError('DB_TLS_REQUIRED');
    return config;
  }
  // mysql2 3.16 skips its explicit identity check for an IP host.
  // Require a name whenever TLS is selected, including local TLS tests.
  if (net.isIP(config.host) || !/^[a-z0-9_.-]+$/i.test(config.host)) {
    throw configurationError('DB_TLS_HOSTNAME_REQUIRED');
  }
  if (typeof env.DB_SSL_CA !== 'string' || !env.DB_SSL_CA.trim()) {
    throw configurationError('DB_TLS_CA_REQUIRED');
  }
  let ca;
  try { ca = readCA(env.DB_SSL_CA); }
  catch { throw configurationError('DB_TLS_CA_UNREADABLE'); }
  try {
    const text = ca.toString('utf8');
    const pattern = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;
    const certificates = text.match(pattern);
    if (!certificates?.length || text.replace(pattern, '').trim()) throw new Error('Invalid CA bundle');
    for (const pem of certificates) {
      const certificate = new X509Certificate(pem);
      if (!certificate.ca || Date.parse(certificate.validFrom) > Date.now()
        || Date.parse(certificate.validTo) <= Date.now()) throw new Error('Invalid CA certificate');
    }
    tls.createSecureContext({ ca });
  } catch { throw configurationError('DB_TLS_CA_INVALID'); }
  config.ssl = { ca, rejectUnauthorized: true, verifyIdentity: true, minVersion: 'TLSv1.2' };
  return config;
}

async function verifyDatabaseConnection(pool, config, logger = console) {
  let connection;
  let healthy = false;
  try {
    connection = await pool.getConnection();
    if (config.ssl) {
      const [cipher] = await connection.query("SHOW SESSION STATUS LIKE 'Ssl_cipher'");
      const [version] = await connection.query("SHOW SESSION STATUS LIKE 'Ssl_version'");
      if (!cipher[0]?.Value || !version[0]?.Value) throw configurationError('DB_TLS_NOT_NEGOTIATED');
      logger.log('Database connection established with TLS');
    } else {
      logger.log('Local development/test database connection established without TLS');
    }
    healthy = true;
  } catch (cause) {
    const error = new Error('Database connection initialization failed');
    error.code = cause.code === 'DB_TLS_NOT_NEGOTIATED' ? cause.code : 'DB_CONNECTION_FAILED';
    throw error;
  } finally {
    if (connection) {
      if (healthy) connection.release();
      else connection.destroy();
    }
  }
}

module.exports = { buildPoolConfig, verifyDatabaseConnection };
