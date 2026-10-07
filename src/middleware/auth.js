const jwt = require("jsonwebtoken");
const { sessionTimeoutMiddleware } = require("./sessionTimeout");
const { logError } = require('../utils/safeLogging');

const authMiddleware = (req, res, next) => {
  const match = typeof req.headers.authorization === 'string' && req.headers.authorization.match(/^Bearer ([^\s]+)$/i);
  const token = match && match[1];

  if (!token) return res.status(401).json({ message: "No token provided" });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    if (decoded.purpose !== 'access' || !Number.isSafeInteger(decoded.id) || typeof decoded.session !== 'string') {
      return res.status(401).json({ message: 'Please sign in again', code: 'SESSION_REVOKED' });
    }
    req.user = decoded; // contains id, email, name, roles
    
    // Check session timeout after authentication
    return sessionTimeoutMiddleware(req, res, next);
  } catch (err) {
    logError('Token verification failed', err);
    
    // Check if token is expired
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ 
        message: "Token expired. Please refresh your token.",
        tokenExpired: true,
        code: 'TOKEN_EXPIRED'
      });
    }
    
    return res.status(403).json({ message: "Invalid token" });
  }
};

module.exports = { authMiddleware };
