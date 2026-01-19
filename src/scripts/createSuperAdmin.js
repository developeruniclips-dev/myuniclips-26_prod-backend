/**
 * Script to create a SuperAdmin user directly in the database
 * Run with: node src/scripts/createSuperAdmin.js
 */

require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool } = require('../config/db');

const createSuperAdmin = async () => {
    const email = 'superadmin@uniclips.com';
    const password = 'SuperAdmin2026!';
    const fname = 'Super';
    const lname = 'Admin';

    try {
        console.log('Connecting to database...');
        
        // Check if SuperAdmin role exists (role_id = 4)
        const [roles] = await pool.query("SELECT * FROM roles WHERE id = 4");
        if (roles.length === 0) {
            console.log('Creating SuperAdmin role...');
            await pool.query("INSERT INTO roles (id, name) VALUES (4, 'SuperAdmin')");
        }

        // Check if user already exists
        const [existing] = await pool.query("SELECT * FROM users WHERE email = ?", [email]);
        if (existing.length > 0) {
            console.log('User already exists. Checking if they have SuperAdmin role...');
            const userId = existing[0].id;
            
            // Check if already has SuperAdmin role
            const [hasRole] = await pool.query(
                "SELECT * FROM user_roles WHERE user_id = ? AND role_id = 4", 
                [userId]
            );
            
            if (hasRole.length === 0) {
                await pool.query("INSERT INTO user_roles (user_id, role_id) VALUES (?, 4)", [userId]);
                console.log('SuperAdmin role assigned to existing user!');
            } else {
                console.log('User already has SuperAdmin role.');
            }
            
            console.log('\n=== SuperAdmin Login ===');
            console.log(`Email: ${email}`);
            console.log(`Password: ${password}`);
            process.exit(0);
            return;
        }

        // Create new user
        console.log('Creating SuperAdmin user...');
        const hashedPassword = await bcrypt.hash(password, 10);
        const [result] = await pool.query(
            "INSERT INTO users (fname, lname, email, password, isScholar) VALUES (?, ?, ?, ?, 0)",
            [fname, lname, email, hashedPassword]
        );
        
        const userId = result.insertId;
        console.log(`User created with ID: ${userId}`);

        // Assign SuperAdmin role (role_id = 4)
        await pool.query("INSERT INTO user_roles (user_id, role_id) VALUES (?, 4)", [userId]);
        console.log('SuperAdmin role assigned!');
        
        // Also assign Admin role for backwards compatibility
        await pool.query("INSERT IGNORE INTO user_roles (user_id, role_id) VALUES (?, 1)", [userId]);
        console.log('Admin role assigned!');

        console.log('\n=== SuperAdmin Created Successfully! ===');
        console.log(`Email: ${email}`);
        console.log(`Password: ${password}`);
        console.log('\nYou can now login at: https://myuniclips.com/login');

        process.exit(0);
    } catch (error) {
        console.error('Error creating SuperAdmin:', error);
        process.exit(1);
    }
};

createSuperAdmin();
