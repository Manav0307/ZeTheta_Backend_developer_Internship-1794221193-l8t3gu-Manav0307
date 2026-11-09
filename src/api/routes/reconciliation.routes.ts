import { Router } from 'express';
import { ReconciliationController } from '../controllers/reconciliation.controller.js';
import { adminAuthMiddleware } from '../middleware/auth.middleware.js';

const router = Router();

router.use(adminAuthMiddleware);

router.post('/trigger', ReconciliationController.trigger);
router.post('/settlements', ReconciliationController.reconcileSettlements);
router.get('/reports/:run_id', ReconciliationController.getReport);


export default router;

