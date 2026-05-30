import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { audit } from '../services/audit.js';
import { generateInviteCode, hashSecret, sha256, verifySecret } from '../services/security.js';

const createInviteSchema = z.object({
  role: z.enum(['USER','SUB_ADMIN','SOLDATO','CAPO']).default('USER'),
  groupIds: z.array(z.string().uuid()).default([]),
  noteIds: z.array(z.string().uuid()).default([]),
  expiresInHours: z.number().int().min(1).max(720).default(72)
});

const updateWipePinsSchema = z.object({
  appWipePin: z.string().min(4).max(64).optional(),
  phoneWipePin: z.string().min(4).max(64).optional()
});

const remoteWipeSchema = z.object({
  targetUserId: z.string().uuid().or(z.string().min(1)),
  type: z.enum(['APP_WIPE','PHONE_WIPE']).default('APP_WIPE'),
  pin: z.string().optional(),
  confirmation: z.string().optional(),
  reason: z.string().max(120).optional()
});


async function requireContainerAdmin(req: FastifyRequest, reply: FastifyReply) {
  try {
    await req.jwtVerify();
    const user = req.user as any;
    if (user.type !== 'user' || !['ADMIN','SUB_ADMIN'].includes(user.role)) throw new Error('not admin');
    const res = await query<any>('SELECT id, container_id, role, disabled_at, deleted_at FROM users WHERE id=$1', [user.sub]);
    const row = res.rows[0];
    if (!row || row.disabled_at || row.deleted_at) throw new Error('disabled');
    return row;
  } catch {
    reply.code(401).send({ success: false, error: 'UNAUTHORIZED' });
    return null;
  }
}

export async function adminRoutes(app: FastifyInstance) {
  app.get('/v1/admin/invites', async (req, reply) => {
    const actor = await requireContainerAdmin(req, reply); if (!actor) return;
    const res = await query<any>(
      `SELECT id, display_code_suffix, role, used, expires_at, created_at
       FROM invites WHERE container_id=$1 ORDER BY created_at DESC LIMIT 50`,
      [actor.container_id]
    );
    return res.rows.map((r) => ({
      id: r.id,
      code: `••••-${r.display_code_suffix}`,
      role: r.role,
      used: r.used,
      createdAt: new Date(r.created_at).getTime(),
      expiresAt: r.expires_at ? new Date(r.expires_at).getTime() : null
    }));
  });

  app.post('/v1/admin/invites', async (req, reply) => {
    const actor = await requireContainerAdmin(req, reply); if (!actor) return;
    const body = createInviteSchema.parse(req.body);
    const normalizedRole = body.role === 'SOLDATO' ? 'USER' : body.role === 'CAPO' ? 'SUB_ADMIN' : body.role;
    if (actor.role === 'SUB_ADMIN' && normalizedRole !== 'USER') {
      return reply.code(403).send({ success: false, error: 'SUB_ADMIN_CAN_ONLY_CREATE_USER_INVITES' });
    }
    const code = generateInviteCode();
    const suffix = code.slice(-4);
    const expiresAt = new Date(Date.now() + body.expiresInHours * 60 * 60 * 1000).toISOString();
    const res = await query<any>(
      `INSERT INTO invites(code_hash, display_code_suffix, container_id, role, expires_at)
       VALUES($1,$2,$3,$4,$5) RETURNING id, role, used, expires_at, created_at`,
      [sha256(code), suffix, actor.container_id, normalizedRole, expiresAt]
    );
    await audit('user', actor.id, 'admin.invite.create', res.rows[0].id, { role: normalizedRole, privacyRedacted: true });
    const row = res.rows[0];
    return {
      id: row.id,
      code,
      role: row.role,
      used: row.used,
      createdAt: new Date(row.created_at).getTime(),
      expiresAt: row.expires_at ? new Date(row.expires_at).getTime() : null
    };
  });
  app.get('/v1/admin/wipe/status', async (req, reply) => {
    const actor = await requireContainerAdmin(req, reply); if (!actor) return;
    const res = await query<any>('SELECT app_wipe_pin_hash IS NOT NULL AS app_pin_set, phone_wipe_pin_hash IS NOT NULL AS phone_pin_set, phone_failed_attempts, phone_locked_until FROM wipe_security WHERE id=1');
    const row = res.rows[0] || {};
    return {
      appWipePinSet: !!row.app_pin_set,
      phoneWipePinSet: !!row.phone_pin_set,
      phoneFailedAttempts: row.phone_failed_attempts ?? 0,
      phoneLockedUntil: row.phone_locked_until ?? null
    };
  });

  app.put('/v1/admin/wipe/pins', async (req, reply) => {
    const actor = await requireContainerAdmin(req, reply); if (!actor) return;
    const body = updateWipePinsSchema.parse(req.body);
    if (!body.appWipePin && !body.phoneWipePin) return reply.code(400).send({ success: false, error: 'NO_PIN_PROVIDED' });
    await query(
      `INSERT INTO wipe_security(id, app_wipe_pin_hash, phone_wipe_pin_hash, updated_at)
       VALUES(1, $1, $2, now())
       ON CONFLICT (id) DO UPDATE SET
         app_wipe_pin_hash = COALESCE(EXCLUDED.app_wipe_pin_hash, wipe_security.app_wipe_pin_hash),
         phone_wipe_pin_hash = COALESCE(EXCLUDED.phone_wipe_pin_hash, wipe_security.phone_wipe_pin_hash),
         updated_at = now()`,
      [body.appWipePin ? await hashSecret(body.appWipePin) : null, body.phoneWipePin ? await hashSecret(body.phoneWipePin) : null]
    );
    await audit('user', actor.id, 'admin.wipe.pins.update', undefined, { privacyRedacted: true, appPinChanged: !!body.appWipePin, phonePinChanged: !!body.phoneWipePin });
    return { success: true };
  });

  app.post('/v1/users/remote-wipe', async (req, reply) => {
    const actor = await requireContainerAdmin(req, reply); if (!actor) return;
    const body = remoteWipeSchema.parse(req.body);
    const target = await query<any>('SELECT id, container_id, disabled_at, deleted_at FROM users WHERE id=$1 AND container_id=$2', [body.targetUserId, actor.container_id]);
    if (!target.rows[0]) return reply.code(404).send({ success: false, error: 'TARGET_NOT_FOUND' });

    if (body.type === 'PHONE_WIPE') {
      if (body.confirmation !== 'WIPE') return reply.code(400).send({ success: false, error: 'WIPE_CONFIRMATION_REQUIRED' });
      const sec = await query<any>('SELECT phone_wipe_pin_hash, phone_failed_attempts, phone_locked_until FROM wipe_security WHERE id=1');
      const row = sec.rows[0];
      if (!row?.phone_wipe_pin_hash) return reply.code(400).send({ success: false, error: 'PHONE_WIPE_PIN_NOT_SET' });
      if (row.phone_locked_until && new Date(row.phone_locked_until).getTime() > Date.now()) return reply.code(423).send({ success: false, error: 'PHONE_WIPE_PIN_LOCKED' });
      const validPin = body.pin
        ? row.phone_wipe_pin_hash.startsWith('$argon2')
          ? await verifySecret(row.phone_wipe_pin_hash, body.pin)
          : sha256(body.pin) === row.phone_wipe_pin_hash
        : false;
      if (!validPin) {
        const attempts = (row.phone_failed_attempts ?? 0) + 1;
        const lockedUntil = attempts >= 3 ? new Date(Date.now() + 10 * 60 * 1000).toISOString() : null;
        await query('UPDATE wipe_security SET phone_failed_attempts=$1, phone_locked_until=$2, updated_at=now() WHERE id=1', [attempts, lockedUntil]);
        await audit('user', actor.id, 'admin.wipe.phone.pin_failed', body.targetUserId, { privacyRedacted: true, locked: !!lockedUntil });
        return reply.code(403).send({ success: false, error: 'INVALID_PHONE_WIPE_PIN' });
      }
      await query('UPDATE wipe_security SET phone_failed_attempts=0, phone_locked_until=NULL, updated_at=now() WHERE id=1');
    }

    const command = await query<any>(
      `INSERT INTO wipe_commands(scope, target_id, reason, requested_by, wipe_type, expires_at)
       VALUES('user', $1, $2, $3, $4, now() + interval '30 minutes') RETURNING id, created_at`,
      [body.targetUserId, body.reason ?? (body.type === 'PHONE_WIPE' ? 'admin-phone-wipe' : 'admin-app-wipe'), actor.id, body.type]
    );
    await audit('user', actor.id, body.type === 'PHONE_WIPE' ? 'admin.wipe.phone.create' : 'admin.wipe.app.create', body.targetUserId, { privacyRedacted: true, commandId: command.rows[0].id });
    return { success: true, id: command.rows[0].id, type: body.type, createdAt: command.rows[0].created_at };
  });

}
