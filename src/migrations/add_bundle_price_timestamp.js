/**
 * Migration: Add bundle_price_updated_at column to subjects table
 * Run this on the production database to track when bundle prices are changed
 */

require('dotenv').config();
const mysql = require('mysql2/promise');

async function runMigration() {
    const connection = await mysql.createConnection({
        host: process.env.DB_HOST,
        port: process.env.DB_PORT || 25060,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
    });

    try {
        console.log('Adding bundle_price_updated_at column to subjects table...');
        
        // Check if column already exists
        const [columns] = await connection.query(`
            SELECT COLUMN_NAME 
            FROM INFORMATION_SCHEMA.COLUMNS 
            WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'subjects' AND COLUMN_NAME = 'bundle_price_updated_at'
        `, [process.env.DB_NAME]);
        
        if (columns.length > 0) {
            console.log('Column bundle_price_updated_at already exists. Skipping.');
        } else {
            await connection.query(`
                ALTER TABLE subjects 
                ADD COLUMN bundle_price_updated_at DATETIME NULL DEFAULT NULL
                AFTER bundle_price
            `);
            console.log('✅ Column bundle_price_updated_at added successfully!');
        }
        
    } catch (error) {
        console.error('Migration error:', error.message);
        throw error;
    } finally {
        await connection.end();
    }
}

runMigration()
    .then(() => {
        console.log('Migration completed successfully.');
        process.exit(0);
    })
    .catch((err) => {
        console.error('Migration failed:', err);
        process.exit(1);
    });
