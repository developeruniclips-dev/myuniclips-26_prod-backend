/**
 * Admin IP Whitelisting Middleware
 * Restricts admin routes to specific IP addresses when enabled
 */

// Parse comma-separated IP list from environment variable
const getWhitelistedIPs = () => {
    const ipList = process.env.ADMIN_WHITELISTED_IPS || '';
    if (!ipList.trim()) return [];
    return ipList.split(',').map(ip => ip.trim()).filter(ip => ip);
};

// Private IP ranges (always allowed for development)
const PRIVATE_IP_RANGES = [
    /^127\./, // localhost
    /^10\./, // Class A private
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./, // Class B private
    /^192\.168\./, // Class C private
    /^::1$/, // IPv6 localhost
    /^::ffff:127\./, // IPv6-mapped IPv4 localhost
];

/**
 * Check if an IP is in private range
 * @param {string} ip - IP address to check
 * @returns {boolean}
 */
const isPrivateIP = (ip) => {
    return PRIVATE_IP_RANGES.some(range => range.test(ip));
};

/**
 * Get client IP address from request
 * Handles proxies (X-Forwarded-For) and direct connections
 * @param {object} req - Express request object
 * @returns {string} Client IP address
 */
const getClientIP = (req) => {
    // Check X-Forwarded-For header (for proxied requests)
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
        // Take first IP in the chain (original client)
        return forwarded.split(',')[0].trim();
    }
    
    // Check X-Real-IP header
    if (req.headers['x-real-ip']) {
        return req.headers['x-real-ip'];
    }
    
    // Fall back to direct connection IP
    return req.connection?.remoteAddress || 
           req.socket?.remoteAddress || 
           req.ip;
};

/**
 * IP Whitelist middleware for admin routes
 * Only enforced when ADMIN_IP_WHITELIST_ENABLED=true
 */
const adminIPWhitelist = (req, res, next) => {
    // Check if IP whitelisting is enabled
    const isEnabled = process.env.ADMIN_IP_WHITELIST_ENABLED === 'true';
    
    if (!isEnabled) {
        // Whitelisting disabled, allow all
        return next();
    }
    
    const clientIP = getClientIP(req);
    const whitelistedIPs = getWhitelistedIPs();
    
    // Always allow private IPs (development)
    if (isPrivateIP(clientIP)) {
        return next();
    }
    
    // Check if no whitelist configured (allow all if empty)
    if (whitelistedIPs.length === 0) {
        console.warn('Admin IP whitelist enabled but no IPs configured. Allowing all.');
        return next();
    }
    
    // Check if client IP is whitelisted
    if (whitelistedIPs.includes(clientIP)) {
        return next();
    }
    
    // IP not whitelisted - log and reject
    console.warn(`Admin access denied for IP: ${clientIP}. Not in whitelist.`);
    
    return res.status(403).json({
        message: 'Access denied. Your IP address is not authorized for admin access.',
        code: 'IP_NOT_WHITELISTED'
    });
};

/**
 * Strict IP whitelist - requires exact match, no private IP bypass
 * Use for extremely sensitive operations
 */
const strictIPWhitelist = (req, res, next) => {
    const isEnabled = process.env.ADMIN_IP_WHITELIST_ENABLED === 'true';
    
    if (!isEnabled) {
        return next();
    }
    
    const clientIP = getClientIP(req);
    const whitelistedIPs = getWhitelistedIPs();
    
    if (whitelistedIPs.length === 0) {
        console.warn('Strict IP whitelist enabled but no IPs configured. Denying all.');
        return res.status(403).json({
            message: 'Access denied. No authorized IPs configured.',
            code: 'NO_WHITELIST_CONFIGURED'
        });
    }
    
    if (whitelistedIPs.includes(clientIP)) {
        return next();
    }
    
    console.warn(`Strict admin access denied for IP: ${clientIP}`);
    
    return res.status(403).json({
        message: 'Access denied. Your IP address is not authorized.',
        code: 'IP_NOT_WHITELISTED'
    });
};

module.exports = {
    adminIPWhitelist,
    strictIPWhitelist,
    getClientIP,
    isPrivateIP,
    getWhitelistedIPs
};
