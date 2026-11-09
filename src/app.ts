import express, { Express, Request, Response } from 'express';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yaml';
import fs from 'fs';
import path from 'path';
import { traceMiddleware } from './api/middleware/trace.middleware.js';
import { errorMiddleware } from './api/middleware/error.middleware.js';
import apiRouter from './api/routes/index.js';
import { createMockGatewayApp } from './modules/gateway-mocks/app.js';


export function createApp(): Express {
  const app = express();

  // Capture raw body for webhook signature verification
  app.use(
    express.json({
      verify: (req: Request, _res: Response, buf: Buffer) => {
        req.rawBody = buf;
      }
    })
  );

  app.use(express.urlencoded({ extended: true }));
  app.use(traceMiddleware);

  // Serve OpenAPI Documentation
  try {
    const openApiPath = path.resolve(process.cwd(), 'docs', 'openapi.yaml');
    if (fs.existsSync(openApiPath)) {
      const openApiFile = fs.readFileSync(openApiPath, 'utf8');
      const swaggerDocument = YAML.parse(openApiFile);

      app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));
      app.get('/openapi.json', (_req: Request, res: Response) => {
        res.status(200).json(swaggerDocument);
      });
    }
  } catch (err) {
    console.warn('Failed to initialize OpenAPI docs:', err);
  }

  // API Router & Compatibility Aliases
  app.use('/api/v1', apiRouter);
  app.use('/v1', apiRouter);

  // Deterministic Mock Gateways for Part B Simulation
  app.use('/mock', createMockGatewayApp());

  // Optional Presentation Dashboard (Disabled by default, enabled via ENABLE_DASHBOARD=true)
  if (process.env.ENABLE_DASHBOARD === 'true') {
    const dashboardPath = path.resolve(process.cwd(), 'dashboard');
    if (fs.existsSync(dashboardPath)) {
      app.use('/dashboard', express.static(dashboardPath));
    }
  }

  // Health check alias at root
  app.get('/health', (_req, res) => res.redirect('/api/v1/health'));

  // 404 handler
  app.use((_req: Request, res: Response) => {
    res.status(404).json({
      error: {
        code: 'NOT_FOUND',
        message: 'The requested route does not exist.',
        details: {},
        request_id: (_req as any).traceId || 'unknown',
        timestamp: new Date().toISOString()
      }
    });
  });

  // Central error handler
  app.use(errorMiddleware);

  return app;
}

