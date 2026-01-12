const express = require("express");
require("dotenv").config();
const cors = require("cors");
const path = require("path");

const router = require("./routes");
const purchaseRoutes = require("./routes/purchaseRoutes");
const { stripeWebhook } = require("./controller/stripeWebhookController");

const app = express();

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
  : ["http://localhost:5173", "http://localhost:5174", "http://localhost:3000", "https://taupe-empanada-b7dfa9.netlify.app"];

app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  })
);

// Serve uploaded videos statically
app.use("/uploads", express.static(path.join(__dirname, "../uploads")));

// Your API routes
app.use("/api", router);

// Purchase routes
app.use("/purchase", purchaseRoutes);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
  console.log(`📁 Uploads stored locally in: ${path.join(__dirname, "../uploads")}`);
  console.log(`🌐 CORS enabled for: http://localhost:5173, http://localhost:3000`);
});

module.exports = app;
