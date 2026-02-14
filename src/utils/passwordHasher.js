/**
 * Secure Password Hashing Utility
 * Uses Argon2id for new passwords with bcrypt fallback for existing users
 */
const argon2 = require('argon2');
const bcrypt = require('bcryptjs');

// Argon2id configuration (OWASP recommended)
const ARGON2_OPTIONS = {
    type: argon2.argon2id,
    memoryCost: 65536,      // 64MB
    timeCost: 3,            // 3 iterations
    parallelism: 4,         // 4 parallel threads
    hashLength: 32          // 32 bytes output
};

/**
 * Hash a password using Argon2id
 * @param {string} password - Plain text password
 * @returns {Promise<string>} Argon2id hash
 */
const hashPassword = async (password) => {
    try {
        return await argon2.hash(password, ARGON2_OPTIONS);
    } catch (error) {
        console.error('Error hashing password with Argon2:', error);
        throw new Error('Failed to hash password');
    }
};

/**
 * Verify a password against a hash
 * Automatically detects bcrypt vs argon2 hashes for backwards compatibility
 * @param {string} password - Plain text password
 * @param {string} hash - Stored password hash
 * @returns {Promise<{valid: boolean, needsRehash: boolean}>}
 */
const verifyPassword = async (password, hash) => {
    try {
        // Detect hash type by prefix
        if (hash.startsWith('$argon2')) {
            // Argon2 hash
            const valid = await argon2.verify(hash, password);
            const needsRehash = await argon2.needsRehash(hash, ARGON2_OPTIONS);
            return { valid, needsRehash };
        } else if (hash.startsWith('$2a$') || hash.startsWith('$2b$') || hash.startsWith('$2y$')) {
            // bcrypt hash - valid but needs rehash to upgrade to Argon2
            const valid = await bcrypt.compare(password, hash);
            return { valid, needsRehash: true };
        } else {
            // Unknown hash format
            console.warn('Unknown password hash format');
            return { valid: false, needsRehash: false };
        }
    } catch (error) {
        console.error('Error verifying password:', error);
        return { valid: false, needsRehash: false };
    }
};

/**
 * Check if a hash needs to be upgraded to Argon2
 * @param {string} hash - Password hash to check
 * @returns {boolean}
 */
const needsUpgrade = (hash) => {
    // bcrypt hashes should be upgraded to Argon2
    return hash.startsWith('$2a$') || hash.startsWith('$2b$') || hash.startsWith('$2y$');
};

module.exports = {
    hashPassword,
    verifyPassword,
    needsUpgrade,
    ARGON2_OPTIONS
};
