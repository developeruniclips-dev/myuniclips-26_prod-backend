const jwt = require("jsonwebtoken");
const { sessionTimeoutMiddleware } = require("./sessionTimeout");

const authMiddleware = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];

  if (!token) return res.status(401).json({ message: "No token provided" });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    console.log('Decoded token:', decoded);
    req.user = decoded; // contains id, email, name, roles
    
    // Check session timeout after authentication
    sessionTimeoutMiddleware(req, res, next);
  } catch (err) {
    console.error('Token verification error:', err.message);
    
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
