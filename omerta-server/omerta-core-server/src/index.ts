import Fastify from 'fastify';
import { ZodError } from 'zod';
import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { registerPlugins } from './plugins.js';
import { authRoutes } from './routes/auth.js';
import { creatorRoutes } from './routes/creator.js';
import { healthRoutes } from './routes/health.js';
import { opsRoutes } from './routes/ops.js';
import { e2eeRoutes } from './routes/e2ee.js';
import { releaseRoutes } from './routes/release.js';
import { adminRoutes } from './routes/admin.js';
import { privacyRoutes } from './routes/privacy.js';
import { relayRoutes } from './routes/relay.js';
import { appRuntimeRoutes } from './routes/appRuntime.js';
import { billingRoutes } from './routes/billing.js';
import { messageWebSocket } from './websocket/messages.js';

const app = Fastify({
  logger: true,
  trustProxy: true,
  bodyLimit: config.maxBodyBytes
});

await registerPlugins(app);

app.setErrorHandler((error, req, reply) => {
  if (error instanceof ZodError) {
    req.log.warn({ err: error, path: req.url }, 'request validation failed');
    return reply.code(400).send({ success: false, error: 'BAD_REQUEST' });
  }
  if ((error as { statusCode?: number }).statusCode === 429) {
    return reply.code(429).send({ success: false, error: 'RATE_LIMITED' });
  }
  req.log.error({ err: error, path: req.url }, 'request failed');
  const statusCode = (error as { statusCode?: number }).statusCode;
  if (statusCode && statusCode >= 400 && statusCode < 500) {
    return reply.code(statusCode).send({ success: false, error: 'REQUEST_FAILED' });
  }
  return reply.code(500).send({ success: false, error: 'INTERNAL_ERROR' });
});

await migrate();
await healthRoutes(app);
await authRoutes(app);
await creatorRoutes(app);
await opsRoutes(app);
await e2eeRoutes(app);
await releaseRoutes(app);
await adminRoutes(app);
await privacyRoutes(app);
await relayRoutes(app);
await appRuntimeRoutes(app);
await billingRoutes(app);
await messageWebSocket(app);

await app.listen({ host: '0.0.0.0', port: config.port });
