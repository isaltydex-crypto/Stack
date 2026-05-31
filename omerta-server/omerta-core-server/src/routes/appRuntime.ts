import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { query } from '../db/pool.js';
import { audit } from '../services/audit.js';

const createGroupSchema = z.object({ name: z.string().min(1).max(80) });
const createUserSchema = z.object({
  nick: z.string().min(1).max(80),
  role: z.enum(['USER','SUB_ADMIN','ADMIN']).default('USER')
});
const accessSchema = z.object({ targetId: z.string().min(1), userIds: z.array(z.string()).default([]), mode: z.string().optional() });
const noteSchema = z.object({ id: z.string().optional().nullable(), title: z.string().default('Untitled'), body: z.string().default(''), updatedAt: z.number().optional() });
const sendMessageSchema = z.object({ chatId: z.string().min(1), text: z.string().default(''), kind: z.string().default('text') });
const roleSchema = z.object({ userId: z.string().uuid(), role: z.enum(['USER','SUB_ADMIN','ADMIN']) });

function requireUser(app: FastifyInstance) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const auth = req.headers.authorization;
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) return reply.code(401).send({ success: false, error: 'UNAUTHORIZED' });
    try {
      const payload = app.jwt.verify<{ sub: string; role: string; deviceId: string; type: string }>(token);
      if (payload.type !== 'user') throw new Error('not user');
      const user = await query<any>('SELECT id, container_id, nick, role, disabled_at, deleted_at FROM users WHERE id=$1', [payload.sub]);
      const row = user.rows[0];
      if (!row || row.disabled_at || row.deleted_at) throw new Error('disabled');
      (req as any).user = { ...payload, containerId: row.container_id, nick: row.nick };
    } catch {
      return reply.code(401).send({ success: false, error: 'UNAUTHORIZED' });
    }
  };
}

function toUser(row: any) {
  return { id: row.id, nick: row.nick, role: row.role, disabled: !!row.disabled_at, createdAt: new Date(row.created_at).getTime() };
}

export async function appRuntimeRoutes(app: FastifyInstance) {
  const userAuth = requireUser(app);

  app.get('/v1/users', { preHandler: userAuth }, async (req) => {
    const auth = (req as any).user as { containerId: string };
    const res = await query<any>('SELECT id, nick, role, disabled_at, created_at FROM users WHERE container_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 500', [auth.containerId]);
    return res.rows.map(toUser);
  });

  app.post('/v1/users/role', { preHandler: userAuth }, async (req, reply) => {
    const auth = (req as any).user as { sub: string; role: string; containerId: string };
    if (!['ADMIN','SUB_ADMIN'].includes(auth.role)) return reply.code(403).send({ success: false, error: 'FORBIDDEN' });
    const body = roleSchema.parse(req.body);
    if (auth.role === 'SUB_ADMIN' && body.role !== 'USER') return reply.code(403).send({ success: false, error: 'SUB_ADMIN_CAN_ONLY_SET_USER' });
    const res = await query<any>('UPDATE users SET role=$1 WHERE id=$2 AND container_id=$3 RETURNING id, nick, role, disabled_at, created_at', [body.role, body.userId, auth.containerId]);
    if (res.rows.length === 0) return reply.code(404).send({ success: false, error: 'USER_NOT_FOUND' });
    await audit('user', auth.sub, 'app.user.role.update', body.userId, { privacyRedacted: true, role: body.role });
    return toUser(res.rows[0]);
  });

  app.post('/v1/users', { preHandler: userAuth }, async (req, reply) => {
    const auth = (req as any).user as { sub: string; role: string; containerId: string };
    if (!['ADMIN','SUB_ADMIN'].includes(auth.role)) return reply.code(403).send({ success: false, error: 'FORBIDDEN' });
    const body = createUserSchema.parse(req.body);
    if (auth.role === 'SUB_ADMIN' && body.role !== 'USER') return reply.code(403).send({ success: false, error: 'SUB_ADMIN_CAN_ONLY_CREATE_USER' });
    const res = await query<any>(
      'INSERT INTO users(container_id, nick, role) VALUES($1,$2,$3) RETURNING id, nick, role, disabled_at, created_at',
      [auth.containerId, body.nick, body.role]
    );
    await audit('user', auth.sub, 'app.user.create', res.rows[0].id, { privacyRedacted: true, role: body.role });
    return toUser(res.rows[0]);
  });

  app.delete('/v1/users/:id', { preHandler: userAuth }, async (req, reply) => {
    const auth = (req as any).user as { sub: string; role: string; containerId: string };
    if (!['ADMIN','SUB_ADMIN'].includes(auth.role)) return reply.code(403).send({ success: false, error: 'FORBIDDEN' });
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    await query('UPDATE users SET deleted_at=now() WHERE id=$1 AND container_id=$2', [params.id, auth.containerId]);
    await audit('user', auth.sub, 'app.user.delete', params.id, { privacyRedacted: true });
    return { success: true };
  });

  app.get('/v1/groups', { preHandler: userAuth }, async (req) => {
    const auth = (req as any).user as { containerId: string };
    const res = await query<any>('SELECT id, name, created_at FROM app_groups WHERE container_id=$1 ORDER BY created_at DESC LIMIT 200', [auth.containerId]);
    return res.rows.map((r) => ({ id: r.id, name: r.name, memberCount: 0, lastMessagePreview: '', updatedAt: new Date(r.created_at).getTime() }));
  });

  app.post('/v1/groups', { preHandler: userAuth }, async (req, reply) => {
    const auth = (req as any).user as { sub: string; role: string; containerId: string };
    if (!['ADMIN','SUB_ADMIN'].includes(auth.role)) return reply.code(403).send({ success: false, error: 'FORBIDDEN' });
    const body = createGroupSchema.parse(req.body);
    const res = await query<any>('INSERT INTO app_groups(container_id, name, created_by) VALUES($1,$2,$3) RETURNING id, name, created_at', [auth.containerId, body.name, auth.sub]);
    await audit('user', auth.sub, 'app.group.create', res.rows[0].id, { privacyRedacted: true });
    return { id: res.rows[0].id, name: res.rows[0].name, memberCount: 1, lastMessagePreview: '', updatedAt: new Date(res.rows[0].created_at).getTime() };
  });

  app.post('/v1/groups/access', { preHandler: userAuth }, async (req, reply) => {
    const auth = (req as any).user as { sub: string; role: string; containerId: string };
    if (!['ADMIN','SUB_ADMIN'].includes(auth.role)) return reply.code(403).send({ success: false, error: 'FORBIDDEN' });
    const body = accessSchema.parse(req.body);
    await audit('user', auth.sub, 'app.group.access.update', body.targetId, { privacyRedacted: true, count: body.userIds.length });
    return { success: true };
  });

  app.get('/v1/dm', { preHandler: userAuth }, async (req) => {
    const auth = (req as any).user as { sub: string; containerId: string };
    const res = await query<any>('SELECT id, nick, role, created_at FROM users WHERE container_id=$1 AND id<>$2 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 200', [auth.containerId, auth.sub]);
    return res.rows.map((u) => ({ id: `dm:${u.id}`, userId: u.id, nick: u.nick, role: u.role, lastMessagePreview: '', updatedAt: new Date(u.created_at).getTime() }));
  });

  app.get('/v1/notes', { preHandler: userAuth }, async (req) => {
    const auth = (req as any).user as { containerId: string };
    const res = await query<any>('SELECT id, title, updated_at FROM app_note_meta WHERE container_id=$1 ORDER BY updated_at DESC LIMIT 200', [auth.containerId]);
    return res.rows.map((r) => ({ id: r.id, title: r.title, body: '', updatedAt: new Date(r.updated_at).getTime() }));
  });

  app.post('/v1/notes', { preHandler: userAuth }, async (req) => {
    const auth = (req as any).user as { sub: string; containerId: string };
    const body = noteSchema.parse(req.body);
    const res = await query<any>(
      `INSERT INTO app_note_meta(id, container_id, title, updated_by, updated_at)
       VALUES(COALESCE($1, gen_random_uuid()),$2,$3,$4,now())
       ON CONFLICT(id) DO UPDATE SET title=EXCLUDED.title, updated_by=EXCLUDED.updated_by, updated_at=now()
       RETURNING id, title, updated_at`,
      [body.id ?? null, auth.containerId, body.title, auth.sub]
    );
    return { id: res.rows[0].id, title: res.rows[0].title, body: body.body, updatedAt: new Date(res.rows[0].updated_at).getTime() };
  });

  app.post('/v1/notes/access', { preHandler: userAuth }, async (req, reply) => {
    const auth = (req as any).user as { sub: string; role: string };
    if (!['ADMIN','SUB_ADMIN'].includes(auth.role)) return reply.code(403).send({ success: false, error: 'FORBIDDEN' });
    const body = accessSchema.parse(req.body);
    await audit('user', auth.sub, 'app.note.access.update', body.targetId, { privacyRedacted: true, count: body.userIds.length });
    return { success: true };
  });

  app.get('/v1/messages/:chatId', { preHandler: userAuth }, async () => []);

  app.post('/v1/messages', { preHandler: userAuth }, async (req) => {
    const body = sendMessageSchema.parse(req.body);
    return { id: randomUUID(), chatId: body.chatId, text: body.text, senderId: 'local', createdAt: Date.now(), kind: body.kind };
  });
}
