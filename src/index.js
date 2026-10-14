const express = require("express");
require("dotenv").config();
const cors = require("cors");
const path = require("path");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { createApiRateLimiter } = require('./middleware/apiRateLimiter');
const morgan = require("morgan");
const { createBoundedAccessLog } = require('./utils/boundedAccessLog');
const { errorHandler } = require('./middleware/publicErrors');
const { requestLogger, logError } = require('./utils/safeLogging');
const { pool, initializeDatabase } = require('./config/db');
const {shared:uploadBarrier}=require('./utils/uploadBarrier');
const {startUploadOperator}=require('./utils/uploadOperator');
const {createGracefulShutdown}=require('./utils/gracefulShutdown');
const shutdown=createGracefulShutdown({barrier:uploadBarrier,pool});

const router = require("./routes");
const purchaseRoutes = require("./routes/purchaseRoutes");
const { stripeWebhook } = require("./controller/stripeWebhookController");

const app = express();
app.use(shutdown.admit);

// Trust first proxy (Render uses reverse proxy) - required for rate limiting to work correctly
app.set('trust proxy', 1);

// ===== SECURITY: API Request Logging =====
// Create logs directory if it doesn't exist
const logsDir = path.join(__dirname, '../logs');
const accessLogStream = process.env.NODE_ENV === 'production' ? createBoundedAccessLog(logsDir) : undefined;
app.use(requestLogger(morgan, { production: process.env.NODE_ENV === 'production', stream: accessLogStream }));
process.once('beforeExit', () => accessLogStream?.end());

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
const generalLimiter = createApiRateLimiter();

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
  ["/webhook", "/api/purchases/webhook"],
  express.raw({ type: "application/json" }),
  stripeWebhook
);

// Normal middleware (after webhook)
// Escaped Unicode metadata can exceed the default JSON limit without exceeding
// the character limits. Increase capacity only for lesson metadata editing.
app.use('/api/videos/my/:id', express.json({ limit: '256kb' }));
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
app.use("/uploads", require('./controller/taskCardController').publicUploadBoundary, (req, res, next) => {
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
app.use(errorHandler);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Endpoint not found" });
});

const PORT = process.env.PORT || 3001;
let uploadOperator;
shutdown.instrument(app);
const startup = initializeDatabase().then(async () => {
 if(shutdown.stopping){shutdown.ready();return;}
 uploadOperator=await startUploadOperator(uploadBarrier);
 if(shutdown.stopping){shutdown.ready(undefined,uploadOperator);return;}
 const server=app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
  console.log(`📁 Uploads stored locally in: ${path.join(__dirname, "../uploads")}`);
  console.log(`🔒 Security: Helmet.js enabled, Rate limiting active`);

  // Schema changes belong to separately authorized, explicit migration scripts.
 });
 shutdown.ready(server,uploadOperator);
 return server;
}).catch(async () => {
  console.error('Database initialization failed; server not started');
  process.exitCode = 1;
  shutdown.ready(undefined,uploadOperator);
  await shutdown.begin();
});

module.exports = { app, authLimiter, startup };
