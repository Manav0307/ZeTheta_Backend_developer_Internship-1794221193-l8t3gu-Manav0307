import { ReconciliationService } from '../modules/reconciliation/reconciliation.service.js';
import { logger } from '../shared/logging/logger.js';
import { config } from '../shared/config/index.js';

let running = true;

async function runLoop() {
  logger.info({
    component: 'reconciliation_worker',
    intervalMinutes: config.RECONCILIATION_INTERVAL_MINUTES,
    message: 'Reconciliation Worker started.'
  });

  const intervalMs = config.RECONCILIATION_INTERVAL_MINUTES * 60 * 1000;

  while (running) {
    try {
      logger.info('Executing scheduled reconciliation cycle...');
      const result = await ReconciliationService.triggerRun('SCHEDULED', config.RECONCILIATION_STALE_MINUTES);
      logger.info({ component: 'reconciliation_worker', result }, 'Scheduled reconciliation cycle completed.');
    } catch (err: any) {
      logger.error({ component: 'reconciliation_worker', error: err.message }, 'Scheduled reconciliation failed');
    }

    // Wait interval
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

process.on('SIGINT', () => {
  logger.info('Stopping reconciliation worker...');
  running = false;
});

process.on('SIGTERM', () => {
  logger.info('Stopping reconciliation worker...');
  running = false;
});

runLoop();

