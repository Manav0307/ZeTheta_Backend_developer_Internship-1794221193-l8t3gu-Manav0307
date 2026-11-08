import { WebhookService } from '../modules/webhooks/webhook.service.js';
import { logger } from '../shared/logging/logger.js';
import { config } from '../shared/config/index.js';

let running = true;

async function startWorker() {
  logger.info({ component: 'webhook_worker', message: 'Webhook Queue Worker started.' });

  while (running) {
    try {
      const processed = await WebhookService.processNextQueueItem();
      if (!processed) {
        // Queue empty, sleep for poll interval
        await new Promise((resolve) => setTimeout(resolve, config.WEBHOOK_WORKER_POLL_INTERVAL_MS));
      }
    } catch (err: any) {
      logger.error({ component: 'webhook_worker', error: err.message }, 'Error in webhook worker loop');
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

process.on('SIGINT', () => {
  logger.info('Stopping webhook worker...');
  running = false;
});

process.on('SIGTERM', () => {
  logger.info('Stopping webhook worker...');
  running = false;
});

startWorker();

