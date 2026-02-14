const bcrypt = require("bcryptjs");
const { pool } = require("../config/db");

async function createAdmin() {
  try {
    const email = process.env.ADMIN_EMAIL || "admin@uniclips.com";
    const password = process.env.ADMIN_PASSWORD;
    
    if (!password) {
      console.error("ERROR: ADMIN_PASSWORD environment variable is required");
      process.exit(1);
    }
    
    const hashedPassword = await bcrypt.hash(password, 10);

    // Check if admin already exists
    const [existing] = await pool.query("SELECT * FROM users WHERE email = ?", [email]);
    
    if (existing.length > 0) {
      console.log("Admin user already exists!");
      
      // Make sure they have Admin role
      const userId = existing[0].id;
      const [roleCheck] = await pool.query(
        "SELECT * FROM user_roles WHERE user_id = ? AND role_id = 1",
        [userId]
      );
      
      if (roleCheck.length === 0) {
        await pool.query("INSERT INTO user_roles (user_id, role_id) VALUES (?, 1)", [userId]);
        console.log("Admin role assigned to existing user!");
      }
      
      process.exit(0);
    }

    // Create admin user
    const [result] = await pool.query(
      "INSERT INTO users (fname, lname, email, password, isScholar) VALUES (?, ?, ?, ?, ?)",
      ["Admin", "User", email, hashedPassword, 0]
    );

    const userId = result.insertId;

    // Assign Admin role (role_id = 1)
    await pool.query("INSERT INTO user_roles (user_id, role_id) VALUES (?, 1)", [userId]);

    console.log("✅ Admin user created successfully!");
    console.log("Email: admin@uniclips.com");
    console.log("Password: admin");
    
    process.exit(0);
  } catch (error) {
    console.error("Error creating admin:", error);
    process.exit(1);
  }
}

createAdmin();
