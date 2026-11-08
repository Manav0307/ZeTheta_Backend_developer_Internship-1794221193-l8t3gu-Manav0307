import { Router } from 'express';
import { WebhookController } from '../controllers/webhook.controller.js';

const router = Router();

router.post('/razorpay', WebhookController.handleRazorpay);
router.post('/stripe', WebhookController.handleStripe);
router.post('/payu', WebhookController.handlePayU);
router.post('/upi', WebhookController.handleUpi);

export default router;

