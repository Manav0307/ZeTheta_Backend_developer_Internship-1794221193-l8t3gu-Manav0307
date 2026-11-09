import { Router } from 'express';
import { PaymentController } from '../controllers/payment.controller.js';
import { merchantAuthMiddleware } from '../middleware/auth.middleware.js';

const router = Router();

router.use(merchantAuthMiddleware);

router.post('/', PaymentController.create);
router.get('/', PaymentController.getByIdOrOrder);
router.get('/:id', PaymentController.getByIdOrOrder);
router.post('/:id/capture', PaymentController.capture);
router.post('/:id/void', PaymentController.void);
router.post('/:id/refund', PaymentController.refund);
router.post('/:id/transition', PaymentController.transition);
router.post('/:id/expire', PaymentController.expire);
router.post('/:id/void-remainder', PaymentController.voidRemainder);
router.get('/:id/refunds', PaymentController.getRefunds);
router.get('/:id/timeline', PaymentController.getTimeline);


export default router;

