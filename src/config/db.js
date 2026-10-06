const mysql = require('mysql2/promise');
require('dotenv').config();
const { buildPoolConfig, verifyDatabaseConnection } = require('./databaseTls');

const poolConfig = buildPoolConfig();
const pool = mysql.createPool(poolConfig);
if (poolConfig.ssl) console.log('Database TLS configuration loaded');

// HTTP startup explicitly awaits this check. Imports alone do not start a
// connection probe or suppress a failed connection with a plaintext fallback.
const initializeDatabase = () => verifyDatabaseConnection(pool, poolConfig);

module.exports = { pool, initializeDatabase };
