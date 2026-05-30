import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { query } from '../db/pool.js';

async function requireCreator(req: FastifyRequest, reply: FastifyReply) {
  try { await req.jwtVerify(); if (req.user.type !== 'creator') throw new Error('not creator'); }
  catch { return reply.code(401).send({ success: false, error: 'UNAUTHORIZED' }); }
}

export async function opsRoutes(app: FastifyInstance) {
  app.get('/creator/ops/status', { preHandler: requireCreator }, async () => {
    const [db, sessions, containers, audit, wipe, devices] = await Promise.all([
      query<any>('SELECT now() AS db_time'),
      query<any>(`SELECT count(*)::int AS active FROM sessions WHERE active=true AND expires_at > now()`),
      query<any>(`SELECT status, count(*)::int AS count FROM containers GROUP BY status ORDER BY status`),
      query<any>(`SELECT action, created_at FROM audit_logs ORDER BY created_at DESC LIMIT 8`),
      query<any>(`SELECT count(*)::int AS count FROM wipe_commands WHERE created_at > now() - interval '24 hours'`),
      query<any>(`SELECT count(*)::int AS stale FROM devices WHERE revoked_at IS NULL AND last_seen < now() - interval '7 days'`)
    ]);

    return {
      success: true,
      ops: {
        service: 'omerta-core',
        uptimeSec: Math.round(process.uptime()),
        node: process.version,
        dbTime: db.rows[0]?.db_time,
        activeSessions: sessions.rows[0]?.active ?? 0,
        containers: containers.rows,
        recentAudit: audit.rows,
        wipeCommands24h: wipe.rows[0]?.count ?? 0,
        staleDevices7d: devices.rows[0]?.stale ?? 0,
        memory: process.memoryUsage()
      }
    };
  });
}
