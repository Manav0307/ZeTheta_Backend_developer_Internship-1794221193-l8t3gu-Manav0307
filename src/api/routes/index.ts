import { Router } from 'express';
import paymentRoutes from './payment.routes.js';
import webhookRoutes from './webhook.routes.js';
import gatewayRoutes from './gateway.routes.js';
import routingRoutes from './routing.routes.js';
import reconciliationRoutes from './reconciliation.routes.js';
import analyticsRoutes from './analytics.routes.js';
import healthRoutes from './health.routes.js';
import adminRoutes from './admin.routes.js';

const router = Router();

router.use('/payments', paymentRoutes);
router.use('/transactions', paymentRoutes);
router.use('/webhooks', webhookRoutes);
router.use('/gateways', gatewayRoutes);
router.use('/routing', routingRoutes);
router.use('/reconciliation', reconciliationRoutes);
router.use('/analytics', analyticsRoutes);
router.use('/health', healthRoutes);
router.use('/admin', adminRoutes);

export default router;

