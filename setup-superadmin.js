require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool } = require('./src/config/db');

async function setup() {
    try {
        console.log('Setting up database...');
        
        // Create roles table
        await pool.query(`CREATE TABLE IF NOT EXISTS roles (
            id INT PRIMARY KEY AUTO_INCREMENT, 
            name VARCHAR(50) NOT NULL UNIQUE
        )`);
        console.log('✓ Created roles table');
        
        // Insert default roles
        await pool.query(`INSERT IGNORE INTO roles (id, name) VALUES 
            (1, 'Admin'), 
            (2, 'Learner'), 
            (3, 'Scholar'), 
            (4, 'SuperAdmin')`);
        console.log('✓ Inserted default roles');
        
        // Create users table if not exists
        await pool.query(`CREATE TABLE IF NOT EXISTS users (
            id INT PRIMARY KEY AUTO_INCREMENT,
            fname VARCHAR(100),
            lname VARCHAR(100),
            email VARCHAR(255) NOT NULL UNIQUE,
            password VARCHAR(255) NOT NULL,
            isScholar TINYINT DEFAULT 0,
            resetPasswordToken VARCHAR(255),
            resetPasswordExpires DATETIME,
            terms_agreed TINYINT DEFAULT 0,
            terms_agreed_at DATETIME,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )`);
        console.log('✓ Created users table');
        
        // Create user_roles table if not exists
        await pool.query(`CREATE TABLE IF NOT EXISTS user_roles (
            id INT PRIMARY KEY AUTO_INCREMENT,
            user_id INT NOT NULL,
            role_id INT NOT NULL,
            UNIQUE KEY unique_user_role (user_id, role_id)
        )`);
        console.log('✓ Created user_roles table');
        
        // Check if superadmin already exists
        const [existing] = await pool.query("SELECT * FROM users WHERE email = 'superadmin@uniclips.com'");
        
        if (existing.length > 0) {
            console.log('SuperAdmin user already exists, ensuring roles...');
            const userId = existing[0].id;
            await pool.query("INSERT IGNORE INTO user_roles (user_id, role_id) VALUES (?, 4)", [userId]);
            await pool.query("INSERT IGNORE INTO user_roles (user_id, role_id) VALUES (?, 1)", [userId]);
        } else {
            // Create SuperAdmin user
            const hashedPassword = await bcrypt.hash('SuperAdmin2026!', 10);
            const [result] = await pool.query(
                "INSERT INTO users (fname, lname, email, password, isScholar) VALUES (?, ?, ?, ?, 0)",
                ['Super', 'Admin', 'superadmin@uniclips.com', hashedPassword]
            );
            const userId = result.insertId;
            console.log('✓ Created SuperAdmin user (ID: ' + userId + ')');
            
            // Assign roles
            await pool.query("INSERT INTO user_roles (user_id, role_id) VALUES (?, 4)", [userId]);
            await pool.query("INSERT INTO user_roles (user_id, role_id) VALUES (?, 1)", [userId]);
            console.log('✓ Assigned SuperAdmin and Admin roles');
        }
        
        console.log('\n========================================');
        console.log('  SuperAdmin Login Credentials');
        console.log('========================================');
        console.log('  Email:    superadmin@uniclips.com');
        console.log('  Password: SuperAdmin2026!');
        console.log('========================================');
        console.log('\nLogin at: https://myuniclips.com/login');
        
        process.exit(0);
    } catch (error) {
        console.error('Error:', error.message);
        process.exit(1);
    }
}

setup();
