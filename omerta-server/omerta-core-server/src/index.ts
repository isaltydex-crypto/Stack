import Fastify from 'fastify';
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

const app = Fastify({ logger: true, trustProxy: true });

await registerPlugins(app);
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
