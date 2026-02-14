const express = require("express");
require("dotenv").config();
const cors = require("cors");
const path = require("path");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const router = require("./routes");
const purchaseRoutes = require("./routes/purchaseRoutes");
const { stripeWebhook } = require("./controller/stripeWebhookController");

const app = express();

// ===== SECURITY: Helmet.js for HTTP headers =====
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://js.stripe.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https:", "blob:"],
      connectSrc: ["'self'", "https://api.stripe.com", "https://*.onrender.com"],
      frameSrc: ["'self'", "https://js.stripe.com", "https://hooks.stripe.com"],
    },
  },
  crossOriginEmbedderPolicy: false, // Allow embedding for video players
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

// Serve uploaded videos statically
app.use("/uploads", express.static(path.join(__dirname, "../uploads")));

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
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
  console.log(`📁 Uploads stored locally in: ${path.join(__dirname, "../uploads")}`);
  console.log(`🔒 Security: Helmet.js enabled, Rate limiting active`);
});

module.exports = { app, authLimiter };
