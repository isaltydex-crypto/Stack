import type { FastifyInstance } from 'fastify';
import os from 'node:os';
import { pool } from '../db/pool.js';

const startedAt = Date.now();

async function dbStatus() {
  const started = Date.now();
  try {
    await pool.query('SELECT 1');
    return { ok: true, latencyMs: Date.now() - started };
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - started, error: error instanceof Error ? error.message : 'UNKNOWN_DB_ERROR' };
  }
}

export async function healthRoutes(app: FastifyInstance) {
  app.get('/health', async () => ({ ok: true, service: 'omerta-core', uptimeSec: Math.round(process.uptime()) }));

  app.get('/ready', async (_req, reply) => {
    const db = await dbStatus();
    if (!db.ok) return reply.code(503).send({ ok: false, service: 'omerta-core', db });
    return { ok: true, service: 'omerta-core', db };
  });

  app.get('/metrics', async (_req, reply) => {
    const db = await dbStatus();
    const rss = process.memoryUsage().rss;
    const heap = process.memoryUsage().heapUsed;
    const lines = [
      '# HELP omerta_up Service availability flag',
      '# TYPE omerta_up gauge',
      'omerta_up 1',
      '# HELP omerta_uptime_seconds Process uptime in seconds',
      '# TYPE omerta_uptime_seconds gauge',
      `omerta_uptime_seconds ${Math.round(process.uptime())}`,
      '# HELP omerta_memory_rss_bytes Resident memory usage',
      '# TYPE omerta_memory_rss_bytes gauge',
      `omerta_memory_rss_bytes ${rss}`,
      '# HELP omerta_memory_heap_used_bytes Heap memory usage',
      '# TYPE omerta_memory_heap_used_bytes gauge',
      `omerta_memory_heap_used_bytes ${heap}`,
      '# HELP omerta_db_ready Database readiness flag',
      '# TYPE omerta_db_ready gauge',
      `omerta_db_ready ${db.ok ? 1 : 0}`,
      '# HELP omerta_db_latency_ms Database ping latency',
      '# TYPE omerta_db_latency_ms gauge',
      `omerta_db_latency_ms ${db.latencyMs}`
    ];
    reply.header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    return lines.join('\n') + '\n';
  });

  app.get('/diagnostics', async () => {
    const db = await dbStatus();
    return {
      ok: db.ok,
      service: 'omerta-core',
      startedAt: new Date(startedAt).toISOString(),
      uptimeSec: Math.round(process.uptime()),
      node: process.version,
      platform: process.platform,
      cpuCount: os.cpus().length,
      loadAvg: os.loadavg(),
      memory: process.memoryUsage(),
      db
    };
  });
}
