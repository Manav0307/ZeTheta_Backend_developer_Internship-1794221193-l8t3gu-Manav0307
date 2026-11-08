import { Router } from 'express';
import { RoutingController } from '../controllers/routing.controller.js';
import { adminAuthMiddleware, merchantAuthMiddleware } from '../middleware/auth.middleware.js';

const router = Router();

router.get('/config', merchantAuthMiddleware, RoutingController.getConfig);
router.put('/config', adminAuthMiddleware, RoutingController.updateConfig);

export default router;

