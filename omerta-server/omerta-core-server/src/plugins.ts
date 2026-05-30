import type { FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { config } from './config.js';
import { pool } from './db/pool.js';

declare module 'fastify' {
  interface FastifyInstance {
    pg: typeof pool;
  }
}

export async function registerPlugins(app: FastifyInstance) {
  app.decorate('pg', pool);
  await app.register(helmet, {
    contentSecurityPolicy: config.nodeEnv === 'production' ? undefined : false,
    hsts: config.nodeEnv === 'production' ? { maxAge: 15552000, includeSubDomains: true } : false
  });
  await app.register(cors, { origin: [config.dashboardOrigin], credentials: true });
  await app.register(cookie, { secret: config.cookieSecret });
  await app.register(jwt, {
    secret: config.jwtSecret,
    cookie: { cookieName: 'omerta_creator', signed: false }
  });
  await app.register(rateLimit, {
    max: config.nodeEnv === 'production' ? 60 : 120,
    timeWindow: '1 minute'
  });
  await app.register(websocket);
}
