import { Router } from 'express';
import { AnalyticsController } from '../controllers/analytics.controller.js';
import { merchantAuthMiddleware } from '../middleware/auth.middleware.js';

const router = Router();

router.use(merchantAuthMiddleware);

router.get('/success-rate', AnalyticsController.getSuccessRate);
router.get('/volume', AnalyticsController.getVolume);

export default router;

