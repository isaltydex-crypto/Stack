import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { audit } from '../services/audit.js';
import { generateInviteCode, hashSecret, sha256, verifySecret } from '../services/security.js';

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(8) });
const containerSchema = z.object({
  name: z.string().min(2).max(48).regex(/^[a-zA-Z0-9_-]+$/),
  apiUrl: z.string().url(),
  wsUrl: z.string().url(),
  createAdminInvite: z.boolean().optional().default(false)
});
const updateContainerSchema = z.object({
  status: z.enum(['online','maintenance','offline']).optional(),
  killSwitch: z.boolean().optional(),
  remoteConfig: z.record(z.unknown()).optional(),
  featureFlags: z.record(z.unknown()).optional()
});
const inviteSchema = z.object({ containerId: z.string().uuid(), role: z.enum(['ADMIN','SUB_ADMIN','USER']), expiresAt: z.string().datetime().optional() });
const idSchema = z.object({ id: z.string().uuid() });
const roleSchema = z.object({ role: z.enum(['ADMIN','SUB_ADMIN','USER']) });
const wipePinSetSchema = z.object({ pin: z.string().min(4).max(32).regex(/^[0-9A-Za-z!@#$%^&*()_+\-=]{4,32}$/) });
const wipeExecuteSchema = z.object({
  pin: z.string().min(4).max(32),
  confirmation: z.literal('WIPE'),
  scope: z.enum(['all','container','user','device']).default('all'),
  wipeType: z.enum(['APP_WIPE','PHONE_WIPE']).default('APP_WIPE'),
  targetId: z.string().uuid().optional(),
  reason: z.string().max(240).optional()
});
const migrationDecisionSchema = z.object({ status: z.enum(['APPROVED','DENIED']), reason: z.string().max(240).optional() });

let creatorPasswordHash: string | null = null;
async function getCreatorHash() { creatorPasswordHash ??= await hashSecret(config.creatorPassword); return creatorPasswordHash; }

async function requireCreator(req: FastifyRequest, reply: FastifyReply) {
  try { await req.jwtVerify(); if (req.user.type !== 'creator') throw new Error('not creator'); }
  catch { return reply.code(401).send({ success: false, error: 'UNAUTHORIZED' }); }
}

async function getWipeSecurity() {
  const res = await query<any>('SELECT * FROM wipe_security WHERE id=1');
  return res.rows[0] ?? null;
}

async function assertWipePin(pin: string, actorId = 'creator') {
  const row = await getWipeSecurity();
  if (!row?.pin_hash) return { ok: false as const, error: 'WIPE_PIN_NOT_SET' };
  if (row.locked_until && new Date(row.locked_until) > new Date()) return { ok: false as const, error: 'WIPE_PIN_LOCKED', lockedUntil: row.locked_until };

  const ok = await verifySecret(row.pin_hash, pin);
  if (!ok) {
    const attempts = Number(row.failed_attempts ?? 0) + 1;
    const shouldLock = attempts >= 3;
    await query(
      `UPDATE wipe_security SET failed_attempts=$1, locked_until=$2, updated_at=now() WHERE id=1`,
      [shouldLock ? 0 : attempts, shouldLock ? new Date(Date.now() + 15 * 60_000).toISOString() : null]
    );
    await audit('creator', actorId, 'wipe.pin_failed', undefined, { attempts, locked: shouldLock });
    return { ok: false as const, error: shouldLock ? 'WIPE_PIN_LOCKED' : 'INVALID_WIPE_PIN' };
  }

  await query(`UPDATE wipe_security SET failed_attempts=0, locked_until=NULL, last_verified_at=now(), updated_at=now() WHERE id=1`);
  return { ok: true as const };
}


async function queueGroupKeyRotationsForDevice(deviceId: string, reason: string, requestedBy = 'creator') {
  const deviceRes = await query<any>(
    `SELECT devices.user_id, device_key_bundles.device_public_id
     FROM devices
     LEFT JOIN device_key_bundles ON device_key_bundles.device_id = devices.id
     WHERE devices.id=$1`,
    [deviceId]
  );
  const affected = deviceRes.rows[0];
  if (!affected) return 0;
  const affectedUserId = affected.user_id;
  const affectedDevicePublicId = affected.device_public_id ?? null;
  const groups = await query<any>(
    `SELECT DISTINCT group_id
     FROM e2ee_group_key_envelopes
     WHERE recipient_user_id=$1 OR ($2::text IS NOT NULL AND recipient_device_public_id=$2)`,
    [affectedUserId, affectedDevicePublicId]
  );
  for (const row of groups.rows) {
    await query(
      `INSERT INTO e2ee_group_rotation_requests(group_id, reason, affected_user_id, affected_device_public_id, requested_by)
       VALUES($1,$2,$3,$4,$5)
       ON CONFLICT DO NOTHING`,
      [row.group_id, reason, affectedUserId, affectedDevicePublicId, requestedBy]
    );
  }
  if (groups.rows.length > 0) {
    await audit('creator', requestedBy, 'e2ee.group.rotation.queue.device', deviceId, { reason, groups: groups.rows.map((r: any) => r.group_id), affectedDevicePublicId });
  }
  return groups.rows.length;
}

async function queueGroupKeyRotationsForUser(userId: string, reason: string, requestedBy = 'creator') {
  const groups = await query<any>(
    `SELECT DISTINCT group_id
     FROM e2ee_group_key_envelopes
     WHERE recipient_user_id=$1`,
    [userId]
  );
  for (const row of groups.rows) {
    await query(
      `INSERT INTO e2ee_group_rotation_requests(group_id, reason, affected_user_id, requested_by)
       VALUES($1,$2,$3,$4)
       ON CONFLICT DO NOTHING`,
      [row.group_id, reason, userId, requestedBy]
    );
  }
  if (groups.rows.length > 0) {
    await audit('creator', requestedBy, 'e2ee.group.rotation.queue.user', userId, { reason, groups: groups.rows.map((r: any) => r.group_id) });
  }
  return groups.rows.length;
}

async function queueGroupKeyRotationsForContainer(containerId: string, reason: string, requestedBy = 'creator') {
  const groups = await query<any>(
    `SELECT DISTINCT gke.group_id
     FROM e2ee_group_key_envelopes gke
     JOIN users ON users.id = gke.recipient_user_id
     WHERE users.container_id=$1`,
    [containerId]
  );
  for (const row of groups.rows) {
    await query(
      `INSERT INTO e2ee_group_rotation_requests(group_id, reason, requested_by)
       VALUES($1,$2,$3)
       ON CONFLICT DO NOTHING`,
      [row.group_id, reason, requestedBy]
    );
  }
  if (groups.rows.length > 0) {
    await audit('creator', requestedBy, 'e2ee.group.rotation.queue.container', containerId, { reason, groups: groups.rows.map((r: any) => r.group_id) });
  }
  return groups.rows.length;
}

async function queueGroupKeyRotationsForAll(reason: string, requestedBy = 'creator') {
  const groups = await query<any>(`SELECT DISTINCT group_id FROM e2ee_group_key_envelopes`);
  for (const row of groups.rows) {
    await query(
      `INSERT INTO e2ee_group_rotation_requests(group_id, reason, requested_by)
       VALUES($1,$2,$3)
       ON CONFLICT DO NOTHING`,
      [row.group_id, reason, requestedBy]
    );
  }
  if (groups.rows.length > 0) {
    await audit('creator', requestedBy, 'e2ee.group.rotation.queue.all', undefined, { reason, groups: groups.rows.map((r: any) => r.group_id) });
  }
  return groups.rows.length;
}

export async function creatorRoutes(app: FastifyInstance) {
  app.post('/creator/login', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = loginSchema.parse(req.body);
    const ok = body.email === config.creatorEmail && await verifySecret(await getCreatorHash(), body.password);
    if (!ok) {
      await audit('creator', null, 'creator.login.failed', undefined, { privacyRedacted: true });
      return reply.code(401).send({ success: false, error: 'INVALID_CREATOR_LOGIN' });
    }
    const token = app.jwt.sign({ sub: 'creator', role: 'CREATOR', type: 'creator' }, { expiresIn: '30m' });
    reply.setCookie('omerta_creator', token, { httpOnly: true, secure: config.productionCookies, sameSite: 'strict', path: '/' });
    await audit('creator', 'creator', 'creator.login');
    return { success: true };
  });

  app.post('/creator/logout', { preHandler: requireCreator }, async (_req, reply) => { reply.clearCookie('omerta_creator', { path: '/' }); return { success: true }; });
  app.get('/creator/status', { preHandler: requireCreator }, async () => ({ success: true, role: 'CREATOR' }));

  app.post('/creator/containers', { preHandler: requireCreator, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = containerSchema.parse(req.body);
    try {
      const res = await query<any>('INSERT INTO containers(name, api_url, ws_url, status) VALUES($1,$2,$3,$4) RETURNING *', [body.name, body.apiUrl, body.wsUrl, 'online']);
      let firstAdminInvite: any = null;
      if (body.createAdminInvite) {
        const code = generateInviteCode();
        const inviteRes = await query<any>(
          `INSERT INTO invites(code_hash, display_code_suffix, container_id, role, expires_at)
           VALUES($1,$2,$3,'ADMIN', now()+($4::text || ' hours')::interval) RETURNING id, display_code_suffix, container_id, role, used, expires_at, created_at`,
          [sha256(code), code.slice(-4), res.rows[0].id, config.inviteDefaultTtlHours]
        );
        firstAdminInvite = { ...inviteRes.rows[0], code };
        await audit('creator', 'creator', 'container.first_admin_invite.create', inviteRes.rows[0].id, { containerId: res.rows[0].id });
      }
      await audit('creator', 'creator', 'container.create', res.rows[0].id, { name: body.name });
      return { success: true, container: res.rows[0], firstAdminInvite };
    } catch (err: any) {
      if (err?.code === '23505') {
        return reply.code(409).send({ success: false, error: 'CONTAINER_NAME_EXISTS', message: 'A container/workspace with that name already exists.' });
      }
      throw err;
    }
  });

  app.get('/creator/containers', { preHandler: requireCreator }, async () => {
    const res = await query('SELECT * FROM containers ORDER BY created_at DESC');
    return { success: true, containers: res.rows };
  });

  app.patch('/creator/containers/:id', { preHandler: requireCreator }, async (req) => {
    const { id } = idSchema.parse(req.params);
    const body = updateContainerSchema.parse(req.body);
    const res = await query<any>(
      `UPDATE containers SET
        status=COALESCE($2,status),
        kill_switch=COALESCE($3,kill_switch),
        remote_config=COALESCE($4,remote_config),
        feature_flags=COALESCE($5,feature_flags),
        updated_at=now()
       WHERE id=$1 RETURNING *`,
      [id, body.status ?? null, body.killSwitch ?? null, body.remoteConfig ? JSON.stringify(body.remoteConfig) : null, body.featureFlags ? JSON.stringify(body.featureFlags) : null]
    );
    await audit('creator', 'creator', 'container.update', id, body);
    return { success: true, container: res.rows[0] };
  });

  app.post('/creator/invites', { preHandler: requireCreator, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const body = inviteSchema.parse(req.body);
    const code = generateInviteCode();
    const res = await query<any>(
      `INSERT INTO invites(code_hash, display_code_suffix, container_id, role, expires_at)
       VALUES($1,$2,$3,$4,$5) RETURNING id, display_code_suffix, container_id, role, used, expires_at, created_at`,
      [sha256(code), code.slice(-4), body.containerId, body.role, body.expiresAt ?? new Date(Date.now() + config.inviteDefaultTtlHours * 60 * 60 * 1000).toISOString()]
    );
    await audit('creator', 'creator', 'invite.create', res.rows[0].id, { role: body.role, containerId: body.containerId });
    return { success: true, invite: { ...res.rows[0], code } };
  });

  app.get('/creator/invites', { preHandler: requireCreator }, async () => {
    const res = await query(`SELECT invites.id, invites.display_code_suffix, invites.role, invites.used, invites.used_at, invites.expires_at, invites.created_at, containers.name AS container_name FROM invites JOIN containers ON containers.id=invites.container_id ORDER BY invites.created_at DESC LIMIT 200`);
    return { success: true, invites: res.rows };
  });

  app.get('/creator/users', { preHandler: requireCreator }, async () => {
    const res = await query(
      `SELECT users.id, users.nick, users.role, users.disabled_at, users.deleted_at, users.created_at, containers.name AS container_name,
        count(devices.id)::int AS device_count,
        count(devices.id) FILTER (WHERE devices.revoked_at IS NULL)::int AS active_devices
       FROM users JOIN containers ON containers.id=users.container_id
       LEFT JOIN devices ON devices.user_id=users.id
       GROUP BY users.id, containers.name ORDER BY users.created_at DESC LIMIT 200`
    );
    return { success: true, users: res.rows };
  });

  app.patch('/creator/users/:id/disable', { preHandler: requireCreator }, async (req) => {
    const { id } = idSchema.parse(req.params);
    await query('UPDATE users SET disabled_at=COALESCE(disabled_at, now()) WHERE id=$1', [id]);
    await query('UPDATE sessions SET active=false WHERE user_id=$1', [id]);
    await queueGroupKeyRotationsForUser(id, 'USER_DISABLED');
    await audit('creator', 'creator', 'user.disable', id);
    return { success: true };
  });

  app.patch('/creator/users/:id/enable', { preHandler: requireCreator }, async (req) => {
    const { id } = idSchema.parse(req.params);
    await query('UPDATE users SET disabled_at=NULL WHERE id=$1', [id]);
    await audit('creator', 'creator', 'user.enable', id);
    return { success: true };
  });

  app.patch('/creator/users/:id/role', { preHandler: requireCreator }, async (req, reply) => {
    const { id } = idSchema.parse(req.params);
    const body = roleSchema.parse(req.body);
    const res = await query<any>('UPDATE users SET role=$2 WHERE id=$1 RETURNING id, nick, role', [id, body.role]);
    if (!res.rows[0]) return reply.code(404).send({ success: false, error: 'USER_NOT_FOUND' });
    await query('UPDATE sessions SET active=false WHERE user_id=$1', [id]);
    await queueGroupKeyRotationsForUser(id, 'ROLE_CHANGED');
    await audit('creator', 'creator', 'user.role.update', id, { role: body.role });
    return { success: true, user: res.rows[0] };
  });

  app.get('/creator/devices', { preHandler: requireCreator }, async () => {
    const res = await query(
      `SELECT devices.id, devices.user_id, users.nick, containers.name AS container_name,
        ('dev-' || substr(encode(digest(devices.id::text, 'sha256'), 'hex'), 1, 10)) AS device_label,
        devices.revoked_at, date_trunc('hour', devices.last_seen) AS last_seen, devices.created_at,
        count(sessions.id) FILTER (WHERE sessions.active=true)::int AS active_sessions
       FROM devices JOIN users ON users.id=devices.user_id JOIN containers ON containers.id=users.container_id
       LEFT JOIN sessions ON sessions.device_id=devices.id
       GROUP BY devices.id, users.nick, containers.name ORDER BY devices.last_seen DESC LIMIT 300`
    );
    return { success: true, devices: res.rows };
  });

  app.patch('/creator/devices/:id/revoke', { preHandler: requireCreator }, async (req) => {
    const { id } = idSchema.parse(req.params);
    await query('UPDATE devices SET revoked_at=COALESCE(revoked_at, now()) WHERE id=$1', [id]);
    await query('UPDATE sessions SET active=false WHERE device_id=$1', [id]);
    await queueGroupKeyRotationsForDevice(id, 'DEVICE_REVOKED');
    await audit('creator', 'creator', 'device.revoke', id);
    return { success: true };
  });

  app.get('/creator/wipe/status', { preHandler: requireCreator }, async () => {
    const row = await getWipeSecurity();
    return {
      success: true,
      wipe: {
        pinSet: Boolean(row?.pin_hash),
        failedAttempts: Number(row?.failed_attempts ?? 0),
        lockedUntil: row?.locked_until ?? null,
        lastVerifiedAt: row?.last_verified_at ?? null,
        updatedAt: row?.updated_at ?? null
      }
    };
  });

  app.put('/creator/wipe/pin', { preHandler: requireCreator, config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req) => {
    const body = wipePinSetSchema.parse(req.body);
    await query(
      `INSERT INTO wipe_security(id, pin_hash, failed_attempts, locked_until, updated_at)
       VALUES(1,$1,0,NULL,now())
       ON CONFLICT (id) DO UPDATE SET pin_hash=EXCLUDED.pin_hash, failed_attempts=0, locked_until=NULL, updated_at=now()`,
      [await hashSecret(body.pin)]
    );
    await audit('creator', 'creator', 'wipe.pin_set');
    return { success: true };
  });

  app.post('/creator/wipe/execute', { preHandler: requireCreator, config: { rateLimit: { max: 3, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = wipeExecuteSchema.parse(req.body);
    if (body.scope !== 'all' && !body.targetId) return reply.code(400).send({ success: false, error: 'TARGET_ID_REQUIRED' });
    const verified = await assertWipePin(body.pin);
    if (!verified.ok) return reply.code(403).send({ success: false, error: verified.error, lockedUntil: 'lockedUntil' in verified ? verified.lockedUntil : null });

    const commandRes = await query<any>(
      `INSERT INTO wipe_commands(scope, target_id, reason, requested_by, wipe_type, expires_at)
       VALUES($1,$2,$3,$4,$5,now() + interval '30 minutes') RETURNING *`,
      [body.scope, body.targetId ?? null, body.reason ?? null, 'creator', body.wipeType]
    );

    if (body.scope === 'all') {
      await query(`UPDATE containers SET kill_switch=true, remote_config = jsonb_set(remote_config, '{wipeCommand}', 'true'::jsonb, true), updated_at=now()`);
      await query(`UPDATE sessions SET active=false`);
      await queueGroupKeyRotationsForAll('WIPE_ALL');
    } else if (body.scope === 'container') {
      await query(`UPDATE containers SET kill_switch=true, remote_config = jsonb_set(remote_config, '{wipeCommand}', 'true'::jsonb, true), updated_at=now() WHERE id=$1`, [body.targetId]);
      await query(`UPDATE sessions SET active=false WHERE user_id IN (SELECT id FROM users WHERE container_id=$1)`, [body.targetId]);
      await queueGroupKeyRotationsForContainer(body.targetId!, 'WIPE_CONTAINER');
    } else if (body.scope === 'user') {
      await query(`UPDATE users SET disabled_at=COALESCE(disabled_at, now()) WHERE id=$1`, [body.targetId]);
      await query(`UPDATE sessions SET active=false WHERE user_id=$1`, [body.targetId]);
      await queueGroupKeyRotationsForUser(body.targetId!, 'WIPE_USER');
    } else if (body.scope === 'device') {
      await query(`UPDATE devices SET revoked_at=COALESCE(revoked_at, now()) WHERE id=$1`, [body.targetId]);
      await query(`UPDATE sessions SET active=false WHERE device_id=$1`, [body.targetId]);
      await queueGroupKeyRotationsForDevice(body.targetId!, 'WIPE_DEVICE');
    }

    await audit('creator', 'creator', 'wipe.execute', body.targetId, { scope: body.scope, wipeType: body.wipeType, reason: body.reason, commandId: commandRes.rows[0].id });
    return { success: true, command: commandRes.rows[0] };
  });

  app.get('/creator/wipe/commands', { preHandler: requireCreator }, async () => {
    const res = await query('SELECT * FROM wipe_commands ORDER BY created_at DESC LIMIT 100');
    return { success: true, commands: res.rows };
  });

  app.get('/creator/billing-orders', { preHandler: requireCreator }, async () => {
    const res = await query(
      `SELECT id, provider, external_order_id, plan, status, customer_email, container_id,
              first_admin_invite_id, access_until, paid_at, provisioned_at, created_at, updated_at
       FROM billing_orders
       ORDER BY created_at DESC
       LIMIT 100`
    );
    return { success: true, orders: res.rows };
  });


  app.get('/creator/device-migrations', { preHandler: requireCreator }, async () => {
    const res = await query<any>(
      `SELECT mr.id, mr.user_id, users.nick, users.role, containers.name AS container_name,
              ('dev-' || substr(encode(digest(coalesce(mr.old_device_public_id,'none'), 'sha256'), 'hex'), 1, 10)) AS old_device_label,
              ('dev-' || substr(encode(digest(mr.new_device_public_id, 'sha256'), 'hex'), 1, 10)) AS new_device_label,
              mr.recovery_vault_id, mr.status,
              mr.decided_by, mr.created_at, mr.decided_at
       FROM e2ee_device_migration_requests mr
       JOIN users ON users.id = mr.user_id
       JOIN containers ON containers.id = users.container_id
       ORDER BY CASE WHEN mr.status='PENDING' THEN 0 ELSE 1 END, mr.created_at DESC
       LIMIT 300`
    );
    return { success: true, migrations: res.rows };
  });

  app.post('/creator/device-migrations/:id/decision', { preHandler: requireCreator }, async (req, reply) => {
    const { id } = idSchema.parse(req.params);
    const body = migrationDecisionSchema.parse(req.body);
    const res = await query<any>(
      `UPDATE e2ee_device_migration_requests
       SET status=$2, decided_by='creator', decided_at=now()
       WHERE id=$1 AND status='PENDING'
       RETURNING *`,
      [id, body.status]
    );
    if (res.rows.length === 0) {
      return reply.code(404).send({ success: false, error: 'MIGRATION_REQUEST_NOT_FOUND_OR_ALREADY_DECIDED' });
    }
    if (body.status === 'APPROVED') {
      await queueGroupKeyRotationsForUser(res.rows[0].user_id, 'DEVICE_MIGRATION_APPROVED');
    }
    await audit('creator', 'creator', 'e2ee.device.migration.decision', id, { status: body.status, reason: body.reason ?? null });
    return { success: true, migration: res.rows[0] };
  });

  app.get('/creator/audit-logs', { preHandler: requireCreator }, async () => {
    const res = await query('SELECT id, actor_type, actor_id, action, target_id, privacy_redacted, created_at, expires_at FROM audit_logs ORDER BY created_at DESC LIMIT 300');
    return { success: true, logs: res.rows };
  });

  app.get('/creator/overview', { preHandler: requireCreator }, async () => {
    const [users, invites, containers, logs, devices, revoked, wipeCommands, activeSessions] = await Promise.all([
      query<any>('SELECT count(*)::int AS count FROM users WHERE deleted_at IS NULL AND disabled_at IS NULL'),
      query<any>('SELECT count(*)::int AS count FROM invites WHERE used=false'),
      query<any>('SELECT count(*)::int AS count FROM containers'),
      query<any>('SELECT count(*)::int AS count FROM audit_logs'),
      query<any>('SELECT count(*)::int AS count FROM devices WHERE revoked_at IS NULL'),
      query<any>('SELECT count(*)::int AS count FROM devices WHERE revoked_at IS NOT NULL'),
      query<any>('SELECT count(*)::int AS count FROM wipe_commands'),
      query<any>('SELECT count(*)::int AS count FROM sessions WHERE active=true')
    ]);
    return { success: true, stats: { activeUsers: users.rows[0].count, availableInvites: invites.rows[0].count, containers: containers.rows[0].count, auditEvents: logs.rows[0].count, activeDevices: devices.rows[0].count, revokedDevices: revoked.rows[0].count, wipeCommands: wipeCommands.rows[0].count, activeSessions: activeSessions.rows[0].count } };
  });
}
