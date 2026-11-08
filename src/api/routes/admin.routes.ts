import { Router } from 'express';
import { AdminDlqController } from '../controllers/admin-dlq.controller.js';
import { adminAuthMiddleware } from '../middleware/auth.middleware.js';

const router = Router();

router.use(adminAuthMiddleware);

router.get('/dlq', AdminDlqController.list);
router.post('/dlq/:id/replay', AdminDlqController.replay);

export default router;

