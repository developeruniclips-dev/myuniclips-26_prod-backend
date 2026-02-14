require("dotenv").config({ path: require("path").resolve(__dirname, "../../.env") });
const mysql = require("mysql2/promise");

async function addSecurityColumns() {
    console.log("Adding security columns to users table...");
    
    const connection = await mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASS,
        database: process.env.DB_NAME,
        port: process.env.DB_PORT || 3306,
        ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : undefined,
    });

    const addColumnIfNotExists = async (table, column, definition) => {
        try {
            const [rows] = await connection.execute(
                `SELECT COUNT(*) as count FROM INFORMATION_SCHEMA.COLUMNS 
                 WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
                [process.env.DB_NAME, table, column]
            );
            if (rows[0].count === 0) {
                await connection.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
                console.log(`✅ Added column: ${column}`);
            } else {
                console.log(`⏭️  Column exists: ${column}`);
            }
        } catch (e) {
            console.error(`❌ Error adding ${column}:`, e.message);
        }
    };

    try {
        // 2FA columns
        await addColumnIfNotExists('users', 'two_factor_secret', 'VARCHAR(255) DEFAULT NULL');
        await addColumnIfNotExists('users', 'two_factor_enabled', 'TINYINT(1) DEFAULT 0');
        await addColumnIfNotExists('users', 'two_factor_backup_codes', 'TEXT DEFAULT NULL');

        // Account lockout columns
        await addColumnIfNotExists('users', 'failed_login_attempts', 'INT DEFAULT 0');
        await addColumnIfNotExists('users', 'locked_until', 'DATETIME DEFAULT NULL');
        await addColumnIfNotExists('users', 'last_failed_login', 'DATETIME DEFAULT NULL');

        // Password reset token columns
        await addColumnIfNotExists('users', 'reset_token_used', 'TINYINT(1) DEFAULT 0');

        // Session/refresh token columns
        await addColumnIfNotExists('users', 'refresh_token', 'VARCHAR(500) DEFAULT NULL');
        await addColumnIfNotExists('users', 'refresh_token_expires', 'DATETIME DEFAULT NULL');
        await addColumnIfNotExists('users', 'last_login', 'DATETIME DEFAULT NULL');
        await addColumnIfNotExists('users', 'last_activity', 'DATETIME DEFAULT NULL');

        console.log("\n✅ Security columns migration complete!");
    } catch (error) {
        console.error("Error in migration:", error);
    } finally {
        await connection.end();
    }
}

addSecurityColumns();
