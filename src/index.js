const express = require("express");
require("dotenv").config();
const cors = require("cors");
const path = require("path");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const morgan = require("morgan");
const fs = require("fs");

const router = require("./routes");
const purchaseRoutes = require("./routes/purchaseRoutes");
const { stripeWebhook } = require("./controller/stripeWebhookController");

const app = express();

// Trust first proxy (Render uses reverse proxy) - required for rate limiting to work correctly
app.set('trust proxy', 1);

// ===== SECURITY: API Request Logging =====
// Create logs directory if it doesn't exist
const logsDir = path.join(__dirname, '../logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Log to file in production, console in development
if (process.env.NODE_ENV === 'production') {
  const accessLogStream = fs.createWriteStream(
    path.join(logsDir, 'access.log'), 
    { flags: 'a' }
  );
  // Custom format that excludes sensitive data
  app.use(morgan(':remote-addr - :method :url :status :res[content-length] - :response-time ms', { 
    stream: accessLogStream,
    skip: (req, res) => {
      // Don't log health checks or static files
      return req.url === '/health' || req.url.startsWith('/uploads');
    }
  }));
} else {
  app.use(morgan('dev'));
}

// ===== SECURITY: Helmet.js for HTTP headers =====
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://js.stripe.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https:", "blob:", "https://*.onrender.com"],
      connectSrc: ["'self'", "https://api.stripe.com", "https://*.onrender.com"],
      frameSrc: ["'self'", "https://js.stripe.com", "https://hooks.stripe.com"],
    },
  },
  crossOriginEmbedderPolicy: false, // Allow embedding for video players
  crossOriginResourcePolicy: { policy: "cross-origin" }, // Allow cross-origin resource loading
}));

// ===== SECURITY: Rate Limiting =====
// General API rate limit
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requests per 15 minutes
  message: { error: "Too many requests, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
});

// Strict rate limit for auth endpoints (login, register, password reset)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 attempts per 15 minutes
  message: { error: "Too many login attempts, please try again in 15 minutes" },
  standardHeaders: true,
  legacyHeaders: false,
});

// Export authLimiter for use in routes
app.set('authLimiter', authLimiter);

// Stripe webhook needs raw body
app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  stripeWebhook
);

// Normal middleware (after webhook)
app.use(express.json());

// CORS configuration
const allowedOrigins = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',')
  : ["http://localhost:5173", "http://localhost:5174", "http://localhost:3000", "https://taupe-empanada-b7dfa9.netlify.app", "https://myuniclips.com", "https://www.myuniclips.com"];

app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  })
);

// Serve uploaded files statically with CORS headers
app.use("/uploads", (req, res, next) => {
  // Set Cross-Origin-Resource-Policy to allow cross-origin requests
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
}, express.static(path.join(__dirname, "../uploads")));

// Health check endpoint
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
});

// Apply general rate limiting to all API routes
app.use("/api", generalLimiter);

// Your API routes
app.use("/api", router);

// Purchase routes
app.use("/purchase", purchaseRoutes);

// ===== SECURITY: Global Error Handler (sanitized messages) =====
app.use((err, req, res, next) => {
  console.error("Error:", err); // Log full error for debugging
  
  // Don't expose internal error details to clients
  const statusCode = err.statusCode || 500;
  const message = statusCode === 500 
    ? "An internal server error occurred" 
    : err.message;
  
  res.status(statusCode).json({ 
    error: message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Endpoint not found" });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
  console.log(`📁 Uploads stored locally in: ${path.join(__dirname, "../uploads")}`);
  console.log(`🔒 Security: Helmet.js enabled, Rate limiting active`);

  // Auto-migrate: ensure TEXT columns where needed
  try {
    const { pool } = require('./config/db');
    await pool.query("ALTER TABLE scholar_subjects MODIFY COLUMN expertise TEXT");
    console.log('✅ Migration: expertise column set to TEXT');
  } catch (e) {
    // Ignore if already done or table doesn't exist
  }
});

module.exports = { app, authLimiter };
