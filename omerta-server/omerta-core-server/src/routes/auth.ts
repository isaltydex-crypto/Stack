import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { audit } from '../services/audit.js';
import { generateRefreshToken, hashSecret, sha256, verifySecret } from '../services/security.js';
import { consumeClientNonce } from '../services/replay.js';

const resolveSchema = z.object({ code: z.string().min(8) });
const activateSchema = z.object({
  code: z.string().min(8),
  nick: z.string().min(2).max(32),
  deviceHash: z.string().min(16),
  publicIdentityKey: z.string().optional(),
  clientPublicKey: z.string().optional(),
  pushToken: z.string().optional(),
  runtimeFlags: z.record(z.unknown()).optional()
});
const refreshSchema = z.object({ refreshToken: z.string().min(24), deviceHash: z.string().min(16), nonce: z.string().min(12), timestamp: z.number().int() });
const logoutSchema = z.object({ refreshToken: z.string().min(24), deviceHash: z.string().min(16) });
const configSchema = z.object({ deviceHash: z.string().min(16), nonce: z.string().min(12), timestamp: z.number().int() });
const commandAckSchema = z.object({ commandId: z.string().min(1), status: z.string().min(2).max(80) });

function assertFreshClientClock(timestamp?: number) {
  if (!timestamp) return true;
  return Math.abs(Date.now() - timestamp) < 120_000;
}

async function registerInviteFailure(codeHash: string, reason: string) {
  const lockedUntil = new Date(Date.now() + config.inviteLockMinutes * 60_000).toISOString();
  const result = await query<any>(
    `UPDATE invites
     SET failed_attempts = failed_attempts + 1,
         last_failed_at = now(),
         locked_until = CASE WHEN failed_attempts + 1 >= $2 THEN $3 ELSE locked_until END
     WHERE code_hash=$1
     RETURNING id, failed_attempts, locked_until`,
    [codeHash, config.inviteMaxAttempts, lockedUntil]
  );
  await audit('system', null, 'invite.resolve.failed', result.rows[0]?.id, {
    privacyRedacted: true,
    reason,
    locked: Boolean(result.rows[0]?.locked_until)
  });
}

export async function authRoutes(app: FastifyInstance) {
  app.post('/auth/resolve-invite', { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = resolveSchema.parse(req.body);
    const codeHash = sha256(body.code.trim().toUpperCase());
    const result = await query<any>(
      `SELECT invites.id, invites.used, invites.expires_at, invites.role, invites.failed_attempts, invites.locked_until,
              containers.name, containers.api_url, containers.ws_url, containers.kill_switch
       FROM invites JOIN containers ON containers.id = invites.container_id
       WHERE invites.code_hash = $1`,
      [codeHash]
    );
    const invite = result.rows[0];
    if (!invite) {
      await audit('system', null, 'invite.resolve.unknown', undefined, { privacyRedacted: true });
      return reply.code(404).send({ success: false, error: 'INVALID_OR_USED_CODE' });
    }
    if (invite.locked_until && new Date(invite.locked_until) > new Date()) {
      await audit('system', null, 'invite.resolve.locked', invite.id, { privacyRedacted: true });
      return reply.code(423).send({ success: false, error: 'INVITE_LOCKED' });
    }
    if (invite.used || invite.kill_switch || (invite.expires_at && new Date(invite.expires_at) < new Date())) {
      await registerInviteFailure(codeHash, invite.used ? 'USED' : invite.kill_switch ? 'KILL_SWITCH' : 'EXPIRED');
      return reply.code(404).send({ success: false, error: 'INVALID_OR_USED_CODE' });
    }
    return { success: true, role: invite.role, containerName: invite.name, apiUrl: invite.api_url, wsUrl: invite.ws_url, requiresNick: true };
  });

  app.post('/auth/activate-invite', { config: { rateLimit: { max: 8, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = activateSchema.parse(req.body);
    const codeHash = sha256(body.code.trim().toUpperCase());
    const client = await app.pg.connect();
    try {
      await client.query('BEGIN');
      const inviteRes = await client.query<any>(
        `SELECT invites.*, containers.kill_switch FROM invites JOIN containers ON containers.id=invites.container_id WHERE code_hash=$1 FOR UPDATE`,
        [codeHash]
      );
      const invite = inviteRes.rows[0];
      if (!invite) {
        await client.query('ROLLBACK');
        await audit('system', null, 'invite.activate.unknown', undefined, { privacyRedacted: true });
        return reply.code(404).send({ success: false, error: 'INVALID_OR_USED_CODE' });
      }
      if (invite.locked_until && new Date(invite.locked_until) > new Date()) {
        await client.query('ROLLBACK');
        await audit('system', null, 'invite.activate.locked', invite.id, { privacyRedacted: true });
        return reply.code(423).send({ success: false, error: 'INVITE_LOCKED' });
      }
      if (invite.used || invite.kill_switch || (invite.expires_at && new Date(invite.expires_at) < new Date())) {
        await client.query('ROLLBACK');
        await registerInviteFailure(codeHash, invite.used ? 'USED' : invite.kill_switch ? 'KILL_SWITCH' : 'EXPIRED');
        return reply.code(404).send({ success: false, error: 'INVALID_OR_USED_CODE' });
      }
      const userRes = await client.query<any>(
        `INSERT INTO users(container_id, nick, role, public_identity_key) VALUES($1,$2,$3,$4) RETURNING *`,
        [invite.container_id, body.nick, invite.role, body.publicIdentityKey ?? null]
      );
      const user = userRes.rows[0];
      const deviceRes = await client.query<any>(
        `INSERT INTO devices(user_id, device_hash, public_identity_key, client_public_key, push_token, runtime_flags) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
        [user.id, body.deviceHash, body.publicIdentityKey ?? null, body.clientPublicKey ?? null, body.pushToken ?? null, body.runtimeFlags ?? {}]
      );
      const device = deviceRes.rows[0];
      const refreshToken = generateRefreshToken();
      await client.query(
        `INSERT INTO sessions(user_id, device_id, refresh_token_hash, expires_at) VALUES($1,$2,$3,now()+interval '30 days')`,
        [user.id, device.id, await hashSecret(refreshToken)]
      );
      await client.query(`UPDATE invites SET used=true, used_by=$1, used_at=now(), failed_attempts=0, locked_until=NULL WHERE id=$2`, [user.id, invite.id]);
      await client.query('COMMIT');
      await audit('user', user.id, 'invite.activate', invite.id, { containerId: invite.container_id, deviceId: device.id });
      const accessToken = app.jwt.sign({ sub: user.id, role: user.role, deviceId: device.id, type: 'user' }, { expiresIn: '15m' });
      return { success: true, accessToken, refreshToken, userId: user.id, deviceId: device.id, nick: user.nick, role: user.role };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  });

  app.post('/auth/refresh', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = refreshSchema.parse(req.body);
    if (!assertFreshClientClock(body.timestamp)) {
      await audit('system', null, 'session.refresh.stale_timestamp', undefined, { privacyRedacted: true });
      return reply.code(401).send({ success: false, error: 'STALE_CLIENT_TIMESTAMP' });
    }
    const result = await query<any>(
      `SELECT sessions.*,
              sessions.revoked_at AS session_revoked_at,
              users.role, users.deleted_at, users.disabled_at,
              devices.device_hash, devices.revoked_at AS device_revoked_at,
              containers.kill_switch
       FROM sessions
       JOIN users ON users.id=sessions.user_id
       JOIN devices ON devices.id=sessions.device_id
       JOIN containers ON containers.id=users.container_id
       WHERE devices.device_hash=$1`,
      [body.deviceHash]
    );
    let matchedInactiveSession: any = null;
    for (const session of result.rows) {
      const ok = await verifySecret(session.refresh_token_hash, body.refreshToken);
      if (ok && !session.active) matchedInactiveSession = session;
      if (ok && session.active && !session.deleted_at && !session.disabled_at && !session.device_revoked_at && !session.kill_switch && !session.session_revoked_at && new Date(session.expires_at) > new Date()) {
        const nonceOk = await consumeClientNonce(session.device_id, body.nonce, body.timestamp);
        if (!nonceOk) {
          await audit('user', session.user_id, 'session.refresh.replay_detected', session.device_id, { privacyRedacted: true });
          return reply.code(401).send({ success: false, error: 'REPLAY_DETECTED' });
        }
        const newRefreshToken = generateRefreshToken();
        const inserted = await query<any>(
          `INSERT INTO sessions(user_id, device_id, refresh_token_hash, rotation_counter, expires_at, last_used_at)
           VALUES($1,$2,$3,$4,now()+interval '30 days',now())
           RETURNING id`,
          [session.user_id, session.device_id, await hashSecret(newRefreshToken), Number(session.rotation_counter ?? 0) + 1]
        );
        await query(
          `UPDATE sessions SET active=false, revoked_at=now(), replaced_by=$1, last_used_at=now() WHERE id=$2`,
          [inserted.rows[0].id, session.id]
        );
        await query(`UPDATE devices SET last_seen=now() WHERE device_hash=$1`, [body.deviceHash]);
        const accessToken = app.jwt.sign({ sub: session.user_id, role: session.role, deviceId: session.device_id, type: 'user' }, { expiresIn: '15m' });
        return { success: true, accessToken, refreshToken: newRefreshToken };
      }
    }
    if (matchedInactiveSession) {
      await query(`UPDATE sessions SET reuse_detected_at=now() WHERE id=$1`, [matchedInactiveSession.id]);
      await query(`UPDATE sessions SET active=false, revoked_at=COALESCE(revoked_at, now()) WHERE device_id=$1`, [matchedInactiveSession.device_id]);
      await audit('user', matchedInactiveSession.user_id, 'session.refresh.reuse_detected', matchedInactiveSession.id, { privacyRedacted: true });
      return reply.code(401).send({ success: false, error: 'REFRESH_REUSE_DETECTED' });
    }
    await audit('system', null, 'session.refresh.failed', undefined, { privacyRedacted: true });
    return reply.code(401).send({ success: false, error: 'INVALID_SESSION' });
  });

  app.post('/auth/config', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = configSchema.parse(req.body);
    if (!assertFreshClientClock(body.timestamp)) {
      await audit('system', null, 'runtime.config.stale_timestamp', undefined, { privacyRedacted: true });
      return reply.code(401).send({ success: false, error: 'STALE_CLIENT_TIMESTAMP' });
    }
    const result = await query<any>(
      `SELECT devices.id AS device_id, containers.remote_config, containers.feature_flags, containers.kill_switch, devices.revoked_at, users.disabled_at, users.deleted_at
       FROM devices JOIN users ON users.id=devices.user_id JOIN containers ON containers.id=users.container_id
       WHERE devices.device_hash=$1`,
      [body.deviceHash]
    );
    const row = result.rows[0];
    if (!row || row.revoked_at || row.disabled_at || row.deleted_at) {
      await audit('system', null, 'runtime.config.disabled_device', undefined, { privacyRedacted: true });
      return reply.code(401).send({ success: false, error: 'DEVICE_DISABLED' });
    }
    const nonceOk = await consumeClientNonce(row.device_id ?? row.id ?? body.deviceHash, body.nonce, body.timestamp);
    if (!nonceOk) {
      await audit('system', null, 'runtime.config.replay_detected', row.device_id, { privacyRedacted: true });
      return reply.code(401).send({ success: false, error: 'REPLAY_DETECTED' });
    }
    return { success: true, killSwitch: row.kill_switch, featureFlags: row.feature_flags, remoteConfig: row.remote_config };
  });


  app.get('/v1/commands', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const auth = req.headers.authorization;
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) {
      await audit('system', null, 'commands.poll.unauthorized', undefined, { privacyRedacted: true });
      return reply.code(401).send({ success: false, error: 'UNAUTHORIZED' });
    }
    try {
      const payload = app.jwt.verify<{ sub: string; deviceId: string; type: string }>(token);
      if (payload.type !== 'user') throw new Error('not user');
      const result = await query<any>(
        `SELECT wc.id, wc.scope, wc.target_id, wc.reason, wc.created_at, wc.wipe_type, wc.expires_at
         FROM wipe_commands wc
         JOIN devices d ON d.id=$1
         JOIN users u ON u.id=d.user_id
         WHERE wc.acknowledged_at IS NULL
           AND (
             wc.scope='all'
             OR (wc.scope='container' AND wc.target_id=u.container_id)
             OR (wc.scope='user' AND wc.target_id=u.id)
             OR (wc.scope='device' AND wc.target_id=d.id)
           )
         ORDER BY wc.created_at DESC`,
        [payload.deviceId]
      );
      const commands = result.rows.map((row) => ({
        id: row.id,
        type: row.wipe_type ?? 'APP_WIPE',
        scope: row.scope,
        targetId: row.target_id,
        reason: row.reason,
        createdAt: new Date(row.created_at).getTime(),
        expiresAt: row.expires_at ? new Date(row.expires_at).getTime() : null,
        payload: {
          wipeType: row.wipe_type ?? 'APP_WIPE',
          reason: row.reason ?? '',
          expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : ''
        }
      }));
      return commands;
    } catch {
      await audit('system', null, 'commands.poll.unauthorized', undefined, { privacyRedacted: true });
      return reply.code(401).send({ success: false, error: 'UNAUTHORIZED' });
    }
  });

  app.post('/v1/commands/ack', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const auth = req.headers.authorization;
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) {
      await audit('system', null, 'commands.ack.unauthorized', undefined, { privacyRedacted: true });
      return reply.code(401).send({ success: false, error: 'UNAUTHORIZED' });
    }
    try {
      const payload = app.jwt.verify<{ sub: string; deviceId: string; type: string }>(token);
      if (payload.type !== 'user') throw new Error('not user');
      const body = commandAckSchema.parse(req.body);
      const updated = await query<any>(
        `UPDATE wipe_commands wc
         SET acknowledged_at=now(), ack_status=$2
         FROM devices d JOIN users u ON u.id=d.user_id
         WHERE wc.id=$1
           AND d.id=$3
           AND wc.acknowledged_at IS NULL
           AND (
             wc.scope='all'
             OR (wc.scope='container' AND wc.target_id=u.container_id)
             OR (wc.scope='user' AND wc.target_id=u.id)
             OR (wc.scope='device' AND wc.target_id=d.id)
           )
         RETURNING wc.id, wc.wipe_type`,
        [body.commandId, body.status, payload.deviceId]
      );
      if (!updated.rows[0]) return reply.code(404).send({ success: false, error: 'COMMAND_NOT_FOUND' });
      await audit('user', payload.sub, 'wipe.command.ack', body.commandId, { privacyRedacted: true, status: body.status });
      return { success: true };
    } catch {
      await audit('system', null, 'commands.ack.unauthorized', undefined, { privacyRedacted: true });
      return reply.code(401).send({ success: false, error: 'UNAUTHORIZED' });
    }
  });


  app.post('/auth/logout-delete-account', { config: { rateLimit: { max: 8, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = logoutSchema.parse(req.body);
    const result = await query<any>(
      `SELECT sessions.*, devices.device_hash FROM sessions JOIN devices ON devices.id=sessions.device_id WHERE sessions.active=true AND devices.device_hash=$1`,
      [body.deviceHash]
    );
    for (const session of result.rows) {
      const ok = await verifySecret(session.refresh_token_hash, body.refreshToken);
      if (ok) {
        await query('UPDATE users SET deleted_at=now() WHERE id=$1', [session.user_id]);
        await query('UPDATE sessions SET active=false WHERE user_id=$1', [session.user_id]);
        await audit('user', session.user_id, 'account.delete.logout', session.user_id);
        return { success: true };
      }
    }
    await audit('system', null, 'account.delete.logout.failed', undefined, { privacyRedacted: true });
    return reply.code(401).send({ success: false, error: 'INVALID_SESSION' });
  });
}
