import { createApp } from './app.js';
import { config } from './shared/config/index.js';
import { logger } from './shared/logging/logger.js';
import { checkDatabaseHealth } from './database/connection.js';

const app = createApp();

async function start() {
  const dbHealth = await checkDatabaseHealth();
  if (!dbHealth.healthy) {
    logger.warn({ dbHealth }, 'Database health check failed during server startup');
  } else {
    logger.info({ database: dbHealth.database }, 'Database connection established successfully');
  }

  const server = app.listen(config.PORT, () => {
    logger.info(`Zetheta Payment Orchestrator running on http://localhost:${config.PORT}`);
    logger.info(`Swagger API Documentation available at http://localhost:${config.PORT}/docs`);
  });

  const shutdown = () => {
    logger.info('Shutting down server gracefully...');
    server.close(() => {
      logger.info('Server stopped.');
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

start().catch((err) => {
  logger.fatal({ err }, 'Failed to start server');
  process.exit(1);
});

