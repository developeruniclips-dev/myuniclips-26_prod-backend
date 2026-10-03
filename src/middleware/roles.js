const authorizeRoles = (...allowedRoles) => async (req, res, next) => {
  if (!req.user) return res.status(401).json({ message: 'Not authenticated' });
  let roles = Array.isArray(req.user.roles) ? req.user.roles : [];
  const privileged = allowedRoles.some(role => ['Admin', 'SuperAdmin'].includes(role));
  if (privileged) {
    try {
      const { pool } = require('../config/db');
      const [rows] = await pool.query('SELECT r.name FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=?', [req.user.id]);
      roles = rows.map(row => row.name);
      req.user.roles = roles;
    } catch { return res.status(503).json({ message: 'Unable to verify current permissions' }); }
  }
  const permitted = allowedRoles.some(role => roles.includes(role) || (role === 'Admin' && roles.includes('SuperAdmin')));
  if (!permitted) return res.status(403).json({ message: 'Access denied' });
  next();
};
module.exports = { authorizeRoles };
