import { Router } from 'express';
import { GatewayController } from '../controllers/gateway.controller.js';
import { adminAuthMiddleware, merchantAuthMiddleware } from '../middleware/auth.middleware.js';

const router = Router();

router.get('/', merchantAuthMiddleware, GatewayController.list);
router.get('/:name/health', merchantAuthMiddleware, GatewayController.getHealth);
router.get('/:name/metrics', merchantAuthMiddleware, GatewayController.getMetrics);
router.put('/:name/config', adminAuthMiddleware, GatewayController.updateConfig);

export default router;

