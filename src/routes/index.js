const { Router } = require('express');
const userRoutes = require('./userRoutes');
const authRouter = require('./authRoutes');
const videoRoutes = require('./videoRoutes');
const purchaseRoutes = require('./purchaseRoutes');
const subjectRoutes = require('./subjectRoutes');
const scholarSubjectRouter = require('./scholarSubjects');
const scholarProfileRoutes = require('./scholarProfileRoutes');
const stripeConnectRoutes = require('./stripeConnectRoutes');
const statsRoutes = require('./statsRoutes');
const libraryRoutes = require('./libraryRoutes');
const passwordRoutes = require('./passwordRoutes');
const locationRoutes = require('./locationRoutes');
const adminRoutes = require('./adminRoutes');

const routes = Router();

routes.use("/users", userRoutes);
routes.use("/auth", authRouter);
routes.use("/videos", videoRoutes);
routes.use("/purchases", purchaseRoutes);
routes.use("/subjects", subjectRoutes);
routes.use("/scholar-subjects", scholarSubjectRouter);
routes.use("/scholar-profile", scholarProfileRoutes);
routes.use("/stripe-connect", stripeConnectRoutes);
routes.use("/stats", statsRoutes);
routes.use("/library", libraryRoutes);
routes.use("/password", passwordRoutes);
routes.use("/locations", locationRoutes);
routes.use("/admin", adminRoutes);

module.exports = routes;
