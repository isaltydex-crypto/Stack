import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { audit } from '../services/audit.js';

const relayEnvelopeSchema = z.object({
  conversationId: z.string().min(1),
  kind: z.enum(['DM_MESSAGE','GROUP_MESSAGE','NOTE_UPDATE']),
  recipientUserId: z.string().uuid().optional().nullable(),
  recipientDeviceId: z.string().min(1),
  payload: z.object({
    algorithm: z.string().min(3),
    ciphertext: z.string().min(1),
    nonce: z.string().min(8),
    senderDeviceId: z.string().min(1),
    senderPublicKey: z.string().min(1),
    keyVersion: z.number().int().positive().default(1),
    aad: z.string().optional().nullable()
  }),
  ttlMinutes: z.number().int().min(1).max(4320).default(1440)
});

const ackSchema = z.object({
  status: z.enum(['DELIVERED','READ','FAILED']).default('DELIVERED')
});

function assertEncryptedPayload(payload: unknown) {
  const json = JSON.stringify(payload);
  if (Buffer.byteLength(json, 'utf8') > config.relayPayloadMaxBytes) {
    return { ok: false as const, error: 'RELAY_PAYLOAD_TOO_LARGE' };
  }
  const body = payload as { ciphertext?: unknown; algorithm?: unknown; nonce?: unknown };
  if (typeof body.ciphertext !== 'string' || typeof body.algorithm !== 'string' || typeof body.nonce !== 'string') {
    return { ok: false as const, error: 'ENCRYPTED_ENVELOPE_REQUIRED' };
  }
  const lower = body.ciphertext.toLowerCase();
  if (lower.includes('message') || lower.includes('plain') || lower.includes('body')) {
    return { ok: false as const, error: 'PLAINTEXT_RELAY_REJECTED' };
  }
  return { ok: true as const };
}

function requireUser(app: FastifyInstance) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const auth = req.headers.authorization;
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) return reply.code(401).send({ success: false, error: 'UNAUTHORIZED' });
    try {
      const payload = app.jwt.verify<{ sub: string; role: string; deviceId: string; type: string }>(token);
      if (payload.type !== 'user') throw new Error('not user');
      (req as any).user = payload;
    } catch {
      return reply.code(401).send({ success: false, error: 'UNAUTHORIZED' });
    }
  };
}

export async function relayRoutes(app: FastifyInstance) {
  const userAuth = requireUser(app);

  app.post('/v1/relay/outbox', { preHandler: userAuth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const auth = (req as any).user as { sub: string; deviceId: string };
    const body = relayEnvelopeSchema.parse(req.body);
    const encrypted = assertEncryptedPayload(body.payload);
    if (!encrypted.ok) return reply.code(400).send({ success: false, error: encrypted.error });
    const result = await query<any>(
      `INSERT INTO relay_payloads(conversation_id, kind, sender_user_id, sender_device_id, recipient_user_id, recipient_device_public_id, payload, expires_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,now()+($8::text || ' minutes')::interval)
       RETURNING id, conversation_id, kind, created_at, expires_at`,
      [body.conversationId, body.kind, auth.sub, auth.deviceId, body.recipientUserId ?? null, body.recipientDeviceId, JSON.stringify(body.payload), body.ttlMinutes]
    );
    await audit('user', auth.sub, 'relay.payload.enqueue', result.rows[0].id, { privacyRedacted: true, kind: body.kind });
    return {
      id: result.rows[0].id,
      conversationId: result.rows[0].conversation_id,
      kind: result.rows[0].kind,
      createdAt: new Date(result.rows[0].created_at).getTime(),
      expiresAt: new Date(result.rows[0].expires_at).getTime()
    };
  });

  app.get('/v1/relay/inbox/:deviceId', { preHandler: userAuth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const auth = (req as any).user as { sub: string };
    const params = z.object({ deviceId: z.string().min(1) }).parse(req.params);
    const ownsDevice = await query<any>(
      `SELECT 1 FROM device_key_bundles WHERE user_id=$1 AND device_public_id=$2 LIMIT 1`,
      [auth.sub, params.deviceId]
    );
    if (ownsDevice.rows.length === 0) return reply.code(403).send({ success: false, error: 'DEVICE_NOT_OWNED' });
    await query(`DELETE FROM relay_payloads WHERE expires_at < now() OR ack_status IN ('DELIVERED','READ')`);
    const result = await query<any>(
      `SELECT id, conversation_id, kind, sender_user_id, sender_device_id, payload, created_at, expires_at
       FROM relay_payloads
       WHERE recipient_device_public_id=$1 AND expires_at > now() AND ack_at IS NULL
       ORDER BY created_at ASC
       LIMIT 250`,
      [params.deviceId]
    );
    return result.rows.map((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      kind: row.kind,
      senderId: row.sender_user_id,
      senderDeviceId: row.sender_device_id,
      payload: row.payload,
      createdAt: new Date(row.created_at).getTime(),
      expiresAt: new Date(row.expires_at).getTime()
    }));
  });

  app.post('/v1/relay/payloads/:id/ack', { preHandler: userAuth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const auth = (req as any).user as { sub: string };
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = ackSchema.parse(req.body);
    const result = await query<any>(
      `UPDATE relay_payloads
       SET ack_status=$2, ack_at=now(), payload = CASE WHEN $2 IN ('DELIVERED','READ') THEN '{}'::jsonb ELSE payload END
       WHERE id=$1
       RETURNING id`,
      [params.id, body.status]
    );
    if (result.rows.length === 0) return reply.code(404).send({ success: false, error: 'PAYLOAD_NOT_FOUND' });
    await audit('user', auth.sub, 'relay.payload.ack', params.id, { privacyRedacted: true, status: body.status });
    return { success: true };
  });

  app.post('/v1/relay/cleanup', { preHandler: userAuth, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const auth = (req as any).user as { sub: string; role: string };
    if (!['ADMIN','SUB_ADMIN'].includes(auth.role)) return { success: false, error: 'FORBIDDEN' };
    const result = await query<any>(`DELETE FROM relay_payloads WHERE expires_at < now() OR ack_status IN ('DELIVERED','READ') RETURNING id`);
    await audit('user', auth.sub, 'relay.cleanup', undefined, { privacyRedacted: true, deleted: result.rowCount ?? 0 });
    return { success: true, deleted: result.rowCount ?? 0 };
  });
}
