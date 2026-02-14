const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const { pool } = require('../config/db');

/**
 * Generate 2FA secret for user
 */
const setup2FA = async (req, res) => {
    try {
        const userId = req.user.id;
        
        // Generate new secret
        const secret = speakeasy.generateSecret({
            name: `UniClips (${req.user.email})`,
            issuer: 'UniClips'
        });
        
        // Store secret temporarily (not enabled until verified)
        await pool.query(
            `UPDATE users SET two_factor_secret = ?, two_factor_enabled = 0 WHERE id = ?`,
            [secret.base32, userId]
        );
        
        // Generate QR code
        const qrCodeUrl = await QRCode.toDataURL(secret.otpauth_url);
        
        res.json({
            message: "2FA setup initiated",
            secret: secret.base32,
            qrCode: qrCodeUrl,
            manualEntry: secret.base32
        });
    } catch (error) {
        console.error("Error setting up 2FA:", error);
        res.status(500).json({ error: "Failed to setup 2FA" });
    }
};

/**
 * Verify and enable 2FA
 */
const verify2FA = async (req, res) => {
    try {
        const userId = req.user.id;
        const { token } = req.body;
        
        if (!token) {
            return res.status(400).json({ error: "Verification token required" });
        }
        
        // Get user's secret
        const [users] = await pool.query(
            `SELECT two_factor_secret FROM users WHERE id = ?`,
            [userId]
        );
        
        if (users.length === 0 || !users[0].two_factor_secret) {
            return res.status(400).json({ error: "2FA not set up. Please generate a secret first." });
        }
        
        // Verify token
        const verified = speakeasy.totp.verify({
            secret: users[0].two_factor_secret,
            encoding: 'base32',
            token: token,
            window: 2 // Allow 2 time steps tolerance
        });
        
        if (!verified) {
            return res.status(400).json({ error: "Invalid verification code" });
        }
        
        // Enable 2FA
        await pool.query(
            `UPDATE users SET two_factor_enabled = 1 WHERE id = ?`,
            [userId]
        );
        
        // Generate backup codes
        const backupCodes = generateBackupCodes();
        const hashedBackupCodes = backupCodes.map(code => ({
            code: code,
            hash: require('crypto').createHash('sha256').update(code).digest('hex'),
            used: false
        }));
        
        await pool.query(
            `UPDATE users SET two_factor_backup_codes = ? WHERE id = ?`,
            [JSON.stringify(hashedBackupCodes), userId]
        );
        
        res.json({
            message: "2FA enabled successfully",
            backupCodes: backupCodes // Show once, user must save these
        });
    } catch (error) {
        console.error("Error verifying 2FA:", error);
        res.status(500).json({ error: "Failed to verify 2FA" });
    }
};

/**
 * Validate 2FA token during login
 */
const validate2FA = async (req, res) => {
    try {
        const { userId, token, backupCode } = req.body;
        
        if (!userId || (!token && !backupCode)) {
            return res.status(400).json({ error: "User ID and token/backup code required" });
        }
        
        const [users] = await pool.query(
            `SELECT two_factor_secret, two_factor_backup_codes FROM users WHERE id = ?`,
            [userId]
        );
        
        if (users.length === 0) {
            return res.status(404).json({ error: "User not found" });
        }
        
        let verified = false;
        
        if (token) {
            // Verify TOTP token
            verified = speakeasy.totp.verify({
                secret: users[0].two_factor_secret,
                encoding: 'base32',
                token: token,
                window: 2
            });
        } else if (backupCode) {
            // Verify backup code
            const backupCodes = JSON.parse(users[0].two_factor_backup_codes || '[]');
            const codeHash = require('crypto').createHash('sha256').update(backupCode).digest('hex');
            
            const codeIndex = backupCodes.findIndex(c => c.hash === codeHash && !c.used);
            if (codeIndex !== -1) {
                verified = true;
                // Mark code as used
                backupCodes[codeIndex].used = true;
                await pool.query(
                    `UPDATE users SET two_factor_backup_codes = ? WHERE id = ?`,
                    [JSON.stringify(backupCodes), userId]
                );
            }
        }
        
        if (!verified) {
            return res.status(401).json({ error: "Invalid 2FA code" });
        }
        
        res.json({ 
            verified: true,
            message: "2FA verification successful"
        });
    } catch (error) {
        console.error("Error validating 2FA:", error);
        res.status(500).json({ error: "Failed to validate 2FA" });
    }
};

/**
 * Disable 2FA
 */
const disable2FA = async (req, res) => {
    try {
        const userId = req.user.id;
        const { token } = req.body;
        
        // Require current 2FA token to disable
        const [users] = await pool.query(
            `SELECT two_factor_secret FROM users WHERE id = ?`,
            [userId]
        );
        
        if (users.length === 0 || !users[0].two_factor_secret) {
            return res.status(400).json({ error: "2FA not enabled" });
        }
        
        const verified = speakeasy.totp.verify({
            secret: users[0].two_factor_secret,
            encoding: 'base32',
            token: token,
            window: 2
        });
        
        if (!verified) {
            return res.status(401).json({ error: "Invalid verification code" });
        }
        
        await pool.query(
            `UPDATE users SET two_factor_secret = NULL, two_factor_enabled = 0, two_factor_backup_codes = NULL WHERE id = ?`,
            [userId]
        );
        
        res.json({ message: "2FA disabled successfully" });
    } catch (error) {
        console.error("Error disabling 2FA:", error);
        res.status(500).json({ error: "Failed to disable 2FA" });
    }
};

/**
 * Get 2FA status
 */
const get2FAStatus = async (req, res) => {
    try {
        const userId = req.user.id;
        
        const [users] = await pool.query(
            `SELECT two_factor_enabled FROM users WHERE id = ?`,
            [userId]
        );
        
        res.json({
            enabled: users.length > 0 && users[0].two_factor_enabled === 1
        });
    } catch (error) {
        console.error("Error getting 2FA status:", error);
        res.status(500).json({ error: "Failed to get 2FA status" });
    }
};

/**
 * Generate random backup codes
 */
function generateBackupCodes(count = 10) {
    const codes = [];
    for (let i = 0; i < count; i++) {
        const code = require('crypto').randomBytes(4).toString('hex').toUpperCase();
        codes.push(`${code.slice(0, 4)}-${code.slice(4)}`);
    }
    return codes;
}

module.exports = {
    setup2FA,
    verify2FA,
    validate2FA,
    disable2FA,
    get2FAStatus
};
