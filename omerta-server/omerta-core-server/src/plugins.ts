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
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    frameguard: { action: 'deny' },
    hsts: config.nodeEnv === 'production' ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
    noSniff: true,
    referrerPolicy: { policy: 'no-referrer' }
  });
  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin || origin === config.dashboardOrigin) return cb(null, true);
      return cb(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
  });
  await app.register(cookie, { secret: config.cookieSecret });
  await app.register(jwt, {
    secret: config.jwtSecret,
    cookie: { cookieName: 'omerta_creator', signed: false }
  });
  await app.register(rateLimit, {
    max: config.globalRateLimitMax,
    timeWindow: config.globalRateLimitWindow,
    addHeaders: {
      'x-ratelimit-limit': true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset': true,
      'retry-after': true
    }
  });
  await app.register(websocket);
}
