import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { audit } from '../services/audit.js';

const envelopeSchema = z.object({
  algorithm: z.string().min(3),
  ciphertext: z.string().min(1),
  nonce: z.string().min(8),
  senderDeviceId: z.string().min(1),
  senderPublicKey: z.string().min(1),
  recipientDeviceIds: z.array(z.string()).default([]),
  keyVersion: z.number().int().positive().default(1),
  aad: z.string().optional().nullable()
});

const keySchema = z.object({
  deviceId: z.string().min(8),
  identityPublicKey: z.string().min(16),
  keyVersion: z.number().int().positive().default(1),
  algorithm: z.string().default('OMERTA_ECDH_P256_AES_GCM_V1'),
  signedPreKey: z.string().optional().nullable(),
  oneTimePreKeys: z.array(z.string()).default([])
});

const sendMessageSchema = z.object({
  conversationId: z.string().min(1),
  receiverId: z.string().uuid().optional().nullable(),
  encryptedPayload: z.string().min(1),
  senderIdentityKey: z.string().min(1),
  envelope: envelopeSchema.optional()
});

const saveNoteSchema = z.object({
  id: z.string().uuid().optional().nullable(),
  encryptedTitle: envelopeSchema,
  encryptedBody: envelopeSchema
});


const recipientEnvelopeSchema = z.object({
  recipientUserId: z.string().uuid(),
  recipientDeviceId: z.string().min(1),
  envelope: envelopeSchema
});

const fanoutMessageSchema = z.object({
  conversationId: z.string().min(1),
  receiverId: z.string().uuid().optional().nullable(),
  recipients: z.array(recipientEnvelopeSchema).min(1).max(100)
});

const versionedSaveNoteSchema = z.object({
  id: z.string().uuid().optional().nullable(),
  encryptedTitle: envelopeSchema,
  encryptedBody: envelopeSchema,
  baseVersion: z.number().int().positive().optional().nullable(),
  isConflictCopy: z.boolean().default(false),
  conflictOfNoteId: z.string().uuid().optional().nullable(),
  conflictMeta: z.any().optional().nullable()
});

const deliveryAckSchema = z.object({
  deviceId: z.string().min(1),
  status: z.enum(['DELIVERED', 'READ'])
});

const groupRotationQuerySchema = z.object({
  groupId: z.string().min(1).optional()
});

const groupRotationAckSchema = z.object({
  groupId: z.string().min(1),
  keyVersion: z.number().int().positive()
});

const groupKeyEnvelopeSchema = z.object({
  groupId: z.string().min(1),
  recipientUserId: z.string().uuid(),
  recipientDeviceId: z.string().min(1),
  keyVersion: z.number().int().positive(),
  envelope: envelopeSchema
});

const rotateGroupKeySchema = z.object({
  groupId: z.string().min(1),
  keyVersion: z.number().int().positive(),
  memberEnvelopes: z.array(groupKeyEnvelopeSchema).min(1).max(500),
  reason: z.string().default('MEMBERSHIP_CHANGE')
});

const sendGroupMessageSchema = z.object({
  groupId: z.string().min(1),
  keyVersion: z.number().int().positive(),
  envelope: envelopeSchema
});

const recoveryVaultSchema = z.object({
  accountProfileId: z.string().min(1),
  deviceId: z.string().min(1),
  algorithm: z.string().min(3),
  kdf: z.string().min(3),
  iterations: z.number().int().positive(),
  salt: z.string().min(8),
  nonce: z.string().min(8),
  ciphertext: z.string().min(1)
});

const migrationRequestSchema = z.object({
  oldDeviceId: z.string().min(1).optional().nullable(),
  newDeviceId: z.string().min(1),
  recoveryVaultId: z.string().uuid().optional().nullable()
});

const migrationDecisionSchema = z.object({
  status: z.enum(['APPROVED', 'DENIED', 'CANCELLED']),
  reason: z.string().optional().nullable()
});

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


type AuthUser = { sub: string; role: string; deviceId: string };

type GroupActor = {
  userId: string;
  role: string;
  deviceId: string;
  publicDeviceId: string;
  isPrivileged: boolean;
  latestGroupKeyVersion: number | null;
};

function isPrivilegedGroupRole(role: string) {
  return role === 'ADMIN' || role === 'SUB_ADMIN';
}

async function resolvePublicDevice(auth: AuthUser) {
  const res = await query<any>(
    `SELECT dkb.device_public_id, dkb.identity_public_key, devices.revoked_at, users.disabled_at, users.deleted_at
     FROM device_key_bundles dkb
     JOIN devices ON devices.id = dkb.device_id
     JOIN users ON users.id = dkb.user_id
     WHERE dkb.user_id=$1 AND dkb.device_id=$2
     ORDER BY dkb.updated_at DESC
     LIMIT 1`,
    [auth.sub, auth.deviceId]
  );
  if (res.rows.length === 0) return null;
  const row = res.rows[0];
  if (row.revoked_at || row.disabled_at || row.deleted_at) return null;
  return { publicDeviceId: row.device_public_id as string, identityPublicKey: row.identity_public_key as string };
}

async function resolveGroupActor(auth: AuthUser, groupId: string): Promise<GroupActor | null> {
  const device = await resolvePublicDevice(auth);
  if (!device) return null;
  const keyRes = await query<any>(
    `SELECT MAX(key_version) AS latest_key_version
     FROM e2ee_group_key_envelopes
     WHERE group_id=$1 AND recipient_user_id=$2 AND recipient_device_public_id=$3`,
    [groupId, auth.sub, device.publicDeviceId]
  );
  const latest = keyRes.rows[0]?.latest_key_version == null ? null : Number(keyRes.rows[0].latest_key_version);
  return {
    userId: auth.sub,
    role: auth.role,
    deviceId: auth.deviceId,
    publicDeviceId: device.publicDeviceId,
    isPrivileged: isPrivilegedGroupRole(auth.role),
    latestGroupKeyVersion: latest
  };
}

async function requireGroupRotationAuthority(auth: AuthUser, groupId: string, reply: FastifyReply) {
  const actor = await resolveGroupActor(auth, groupId);
  if (!actor) {
    reply.code(403).send({ success: false, error: 'DEVICE_NOT_E2EE_REGISTERED_OR_REVOKED' });
    return null;
  }

  const groupHasKeys = await query<any>(
    `SELECT EXISTS(SELECT 1 FROM e2ee_group_key_envelopes WHERE group_id=$1) AS exists`,
    [groupId]
  );
  const hasExistingGroupKeys = Boolean(groupHasKeys.rows[0]?.exists);

  // First group key bootstrap is allowed for the first active device. After that,
  // rotation requires either an existing group key on this device or an elevated role.
  if (hasExistingGroupKeys && actor.latestGroupKeyVersion == null && !actor.isPrivileged) {
    reply.code(403).send({ success: false, error: 'GROUP_KEY_ROTATION_NOT_AUTHORIZED' });
    return null;
  }
  return actor;
}

async function requireGroupMessageAuthority(auth: AuthUser, groupId: string, keyVersion: number, reply: FastifyReply) {
  const actor = await resolveGroupActor(auth, groupId);
  if (!actor) {
    reply.code(403).send({ success: false, error: 'DEVICE_NOT_E2EE_REGISTERED_OR_REVOKED' });
    return null;
  }
  const ownKey = await query<any>(
    `SELECT 1 FROM e2ee_group_key_envelopes
     WHERE group_id=$1 AND recipient_user_id=$2 AND recipient_device_public_id=$3 AND key_version=$4
     LIMIT 1`,
    [groupId, auth.sub, actor.publicDeviceId, keyVersion]
  );
  if (ownKey.rows.length === 0) {
    reply.code(403).send({ success: false, error: 'GROUP_MESSAGE_KEY_NOT_AVAILABLE_FOR_DEVICE' });
    return null;
  }
  const pending = await query<any>(
    `SELECT 1 FROM e2ee_group_rotation_requests
     WHERE group_id=$1 AND rotated_at IS NULL
       AND (affected_user_id IS NULL OR affected_user_id <> $2)
       AND (affected_device_public_id IS NULL OR affected_device_public_id <> $3)
     LIMIT 1`,
    [groupId, auth.sub, actor.publicDeviceId]
  );
  if (pending.rows.length > 0) {
    reply.code(409).send({ success: false, error: 'GROUP_KEY_ROTATION_REQUIRED' });
    return null;
  }
  return actor;
}

function toEnvelope(row: any) {
  return {
    algorithm: row.algorithm,
    ciphertext: row.ciphertext,
    nonce: row.nonce,
    senderDeviceId: row.sender_public_device_id,
    senderPublicKey: row.sender_public_key,
    recipientDeviceIds: row.recipient_device_ids ?? [],
    keyVersion: row.key_version,
    aad: row.aad ?? null
  };
}


function toVersionedNote(row: any) {
  return {
    id: row.id,
    ownerId: row.owner_user_id,
    encryptedTitle: row.encrypted_title,
    encryptedBody: row.encrypted_body,
    version: Number(row.version ?? 1),
    baseVersion: row.base_version == null ? null : Number(row.base_version),
    updatedByDeviceId: row.updated_by_device_public_id ?? null,
    isConflictCopy: Boolean(row.is_conflict_copy),
    conflictOfNoteId: row.conflict_of_note_id ?? null,
    conflictMeta: row.conflict_meta ?? null,
    updatedAt: new Date(row.updated_at).getTime()
  };
}

function toGroupKeyRecord(row: any) {
  return {
    groupId: row.group_id,
    recipientUserId: row.recipient_user_id,
    recipientDeviceId: row.recipient_device_public_id,
    keyVersion: row.key_version,
    envelope: {
      algorithm: row.algorithm,
      ciphertext: row.ciphertext,
      nonce: row.nonce,
      senderDeviceId: row.sender_public_device_id,
      senderPublicKey: row.sender_public_key,
      recipientDeviceIds: [row.recipient_device_public_id],
      keyVersion: row.key_version,
      aad: row.aad ?? null
    },
    createdAt: new Date(row.created_at).getTime()
  };
}

function toGroupMessageRecord(row: any) {
  return {
    messageId: row.id,
    groupId: row.group_id,
    senderId: row.sender_user_id,
    keyVersion: row.key_version,
    envelope: {
      algorithm: row.algorithm,
      ciphertext: row.ciphertext,
      nonce: row.nonce,
      senderDeviceId: row.sender_public_device_id,
      senderPublicKey: row.sender_public_key,
      recipientDeviceIds: [`group:${row.group_id}`],
      keyVersion: row.key_version,
      aad: row.aad ?? null
    },
    createdAt: new Date(row.created_at).getTime(),
    deliveryStatus: row.delivery_status
  };
}

function toGroupRotationRecord(row: any) {
  return {
    id: row.id,
    groupId: row.group_id,
    reason: row.reason,
    affectedUserId: row.affected_user_id ?? null,
    affectedDeviceId: row.affected_device_public_id ?? null,
    requestedBy: row.requested_by,
    rotatedByUserId: row.rotated_by_user_id ?? null,
    rotatedByDeviceId: row.rotated_by_device_public_id ?? null,
    rotatedKeyVersion: row.rotated_key_version == null ? null : Number(row.rotated_key_version),
    createdAt: new Date(row.created_at).getTime(),
    rotatedAt: row.rotated_at ? new Date(row.rotated_at).getTime() : null
  };
}


export async function e2eeRoutes(app: FastifyInstance) {
  const userAuth = requireUser(app);

  app.post('/v1/e2ee/devices/keys', { preHandler: userAuth }, async (req) => {
    const auth = (req as any).user as { sub: string; deviceId: string };
    const body = keySchema.parse(req.body);
    const res = await query<any>(
      `INSERT INTO device_key_bundles(user_id, device_id, device_public_id, identity_public_key, key_version, algorithm, signed_pre_key, one_time_pre_keys, updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,now())
       ON CONFLICT(user_id, device_public_id)
       DO UPDATE SET identity_public_key=EXCLUDED.identity_public_key, key_version=EXCLUDED.key_version, algorithm=EXCLUDED.algorithm, signed_pre_key=EXCLUDED.signed_pre_key, one_time_pre_keys=EXCLUDED.one_time_pre_keys, updated_at=now()
       RETURNING *`,
      [auth.sub, auth.deviceId, body.deviceId, body.identityPublicKey, body.keyVersion, body.algorithm, body.signedPreKey ?? null, JSON.stringify(body.oneTimePreKeys)]
    );
    await query('UPDATE devices SET public_identity_key=$1 WHERE id=$2', [body.identityPublicKey, auth.deviceId]);
    await audit('user', auth.sub, 'e2ee.key.register', auth.deviceId, { devicePublicId: body.deviceId, keyVersion: body.keyVersion });
    const row = res.rows[0];
    return {
      userId: row.user_id,
      deviceId: row.device_public_id,
      identityPublicKey: row.identity_public_key,
      keyVersion: row.key_version,
      algorithm: row.algorithm,
      signedPreKey: row.signed_pre_key,
      oneTimePreKeys: row.one_time_pre_keys ?? [],
      updatedAt: row.updated_at
    };
  });

  app.get('/v1/e2ee/users/:userId/devices/keys', { preHandler: userAuth }, async (req) => {
    const params = z.object({ userId: z.string().uuid() }).parse(req.params);
    const res = await query<any>(
      `SELECT * FROM device_key_bundles WHERE user_id=$1 ORDER BY updated_at DESC`,
      [params.userId]
    );
    return res.rows.map((row) => ({
      userId: row.user_id,
      deviceId: row.device_public_id,
      identityPublicKey: row.identity_public_key,
      keyVersion: row.key_version,
      algorithm: row.algorithm,
      signedPreKey: row.signed_pre_key,
      oneTimePreKeys: row.one_time_pre_keys ?? [],
      updatedAt: row.updated_at
    }));
  });

  app.post('/v1/e2ee/messages', { preHandler: userAuth }, async (req) => {
    const auth = (req as any).user as { sub: string; deviceId: string };
    const body = sendMessageSchema.parse(req.body);
    const envelope = body.envelope ?? {
      algorithm: 'OMERTA_E2EE_V1_LEGACY_ENVELOPE',
      ciphertext: body.encryptedPayload,
      nonce: 'legacy',
      senderDeviceId: auth.deviceId,
      senderPublicKey: body.senderIdentityKey,
      recipientDeviceIds: [],
      keyVersion: 1,
      aad: null
    };
    const res = await query<any>(
      `INSERT INTO encrypted_messages(conversation_id, sender_user_id, sender_device_id, receiver_user_id, algorithm, ciphertext, nonce, sender_public_key, sender_public_device_id, recipient_device_ids, key_version, aad)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [body.conversationId, auth.sub, auth.deviceId, body.receiverId ?? null, envelope.algorithm, envelope.ciphertext, envelope.nonce, envelope.senderPublicKey, envelope.senderDeviceId, JSON.stringify(envelope.recipientDeviceIds ?? []), envelope.keyVersion, envelope.aad ?? null]
    );
    await audit('user', auth.sub, 'e2ee.message.store', res.rows[0].id, { conversationId: body.conversationId });
    const row = res.rows[0];
    return {
      id: row.id,
      conversationId: row.conversation_id,
      senderId: row.sender_user_id,
      receiverId: row.receiver_user_id,
      encryptedPayload: row.ciphertext,
      senderIdentityKey: row.sender_public_key,
      envelope: toEnvelope(row),
      createdAt: new Date(row.created_at).getTime(),
      deliveryStatus: row.delivery_status
    };
  });


  app.post('/v1/e2ee/messages/fanout', { preHandler: userAuth }, async (req) => {
    const auth = (req as any).user as { sub: string; deviceId: string };
    const body = fanoutMessageSchema.parse(req.body);
    const primary = body.recipients[0].envelope;
    const messageRes = await query<any>(
      `INSERT INTO encrypted_messages(conversation_id, sender_user_id, sender_device_id, receiver_user_id, algorithm, ciphertext, nonce, sender_public_key, sender_public_device_id, recipient_device_ids, key_version, aad)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [body.conversationId, auth.sub, auth.deviceId, body.receiverId ?? null, primary.algorithm, primary.ciphertext, primary.nonce, primary.senderPublicKey, primary.senderDeviceId, JSON.stringify(body.recipients.map((r) => r.recipientDeviceId)), primary.keyVersion, primary.aad ?? null]
    );
    const message = messageRes.rows[0];
    for (const recipient of body.recipients) {
      const envelope = recipient.envelope;
      await query(
        `INSERT INTO encrypted_message_recipients(message_id, recipient_user_id, recipient_device_public_id, algorithm, ciphertext, nonce, sender_public_key, sender_public_device_id, key_version, aad)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT(message_id, recipient_device_public_id) DO NOTHING`,
        [message.id, recipient.recipientUserId, recipient.recipientDeviceId, envelope.algorithm, envelope.ciphertext, envelope.nonce, envelope.senderPublicKey, envelope.senderDeviceId, envelope.keyVersion, envelope.aad ?? null]
      );
    }
    await audit('user', auth.sub, 'e2ee.message.fanout.store', message.id, { conversationId: body.conversationId, recipientCount: body.recipients.length });
    return {
      id: message.id,
      conversationId: message.conversation_id,
      senderId: message.sender_user_id,
      receiverId: message.receiver_user_id,
      encryptedPayload: message.ciphertext,
      senderIdentityKey: message.sender_public_key,
      envelope: toEnvelope(message),
      recipientEnvelopes: body.recipients,
      createdAt: new Date(message.created_at).getTime(),
      deliveryStatus: message.delivery_status
    };
  });

  app.get('/v1/e2ee/messages/:conversationId', { preHandler: userAuth }, async (req) => {
    const params = z.object({ conversationId: z.string().min(1) }).parse(req.params);
    const res = await query<any>(
      `SELECT * FROM encrypted_messages WHERE conversation_id=$1 ORDER BY created_at ASC LIMIT 500`,
      [params.conversationId]
    );
    return res.rows.map((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      senderId: row.sender_user_id,
      receiverId: row.receiver_user_id,
      encryptedPayload: row.ciphertext,
      senderIdentityKey: row.sender_public_key,
      envelope: toEnvelope(row),
      createdAt: new Date(row.created_at).getTime(),
      deliveryStatus: row.delivery_status
    }));
  });


  app.get('/v1/e2ee/messages/:conversationId/device/:deviceId', { preHandler: userAuth }, async (req) => {
    const params = z.object({
      conversationId: z.string().min(1),
      deviceId: z.string().min(1)
    }).parse(req.params);
    const res = await query<any>(
      `SELECT em.id AS message_id, em.conversation_id, em.sender_user_id, em.receiver_user_id,
              em.created_at, emr.delivery_status, emr.algorithm, emr.ciphertext, emr.nonce,
              emr.sender_public_key, emr.sender_public_device_id, emr.key_version, emr.aad
       FROM encrypted_message_recipients emr
       JOIN encrypted_messages em ON em.id = emr.message_id
       WHERE em.conversation_id=$1 AND emr.recipient_device_public_id=$2
       ORDER BY em.created_at ASC
       LIMIT 500`,
      [params.conversationId, params.deviceId]
    );
    return res.rows.map((row) => ({
      messageId: row.message_id,
      conversationId: row.conversation_id,
      senderId: row.sender_user_id,
      receiverId: row.receiver_user_id,
      envelope: {
        algorithm: row.algorithm,
        ciphertext: row.ciphertext,
        nonce: row.nonce,
        senderDeviceId: row.sender_public_device_id,
        senderPublicKey: row.sender_public_key,
        recipientDeviceIds: [params.deviceId],
        keyVersion: row.key_version,
        aad: row.aad ?? null
      },
      createdAt: new Date(row.created_at).getTime(),
      deliveryStatus: row.delivery_status
    }));
  });

  app.post('/v1/e2ee/messages/:messageId/delivery', { preHandler: userAuth }, async (req) => {
    const params = z.object({ messageId: z.string().uuid() }).parse(req.params);
    const body = deliveryAckSchema.parse(req.body);
    await query(
      `UPDATE encrypted_message_recipients
       SET delivery_status=$1
       WHERE message_id=$2 AND recipient_device_public_id=$3`,
      [body.status, params.messageId, body.deviceId]
    );
    await audit('user', ((req as any).user as { sub: string }).sub, 'e2ee.message.delivery', params.messageId, { deviceId: body.deviceId, status: body.status });
    return { success: true };
  });

  app.get('/v1/e2ee/notes', { preHandler: userAuth }, async (req) => {
    const auth = (req as any).user as { sub: string };
    const res = await query<any>(
      `SELECT * FROM encrypted_notes WHERE owner_user_id=$1 ORDER BY updated_at DESC LIMIT 300`,
      [auth.sub]
    );
    return res.rows.map((row) => ({
      id: row.id,
      ownerId: row.owner_user_id,
      encryptedTitle: row.encrypted_title,
      encryptedBody: row.encrypted_body,
      updatedAt: new Date(row.updated_at).getTime()
    }));
  });


  app.post('/v1/e2ee/notes/versioned', { preHandler: userAuth }, async (req, reply) => {
    const auth = (req as any).user as { sub: string; deviceId: string };
    const body = versionedSaveNoteSchema.parse(req.body);
    if (body.id && !body.isConflictCopy) {
      const current = await query<any>('SELECT * FROM encrypted_notes WHERE id=$1 AND owner_user_id=$2', [body.id, auth.sub]);
      if (current.rows.length > 0) {
        const row = current.rows[0];
        const currentVersion = Number(row.version ?? 1);
        if (body.baseVersion != null && body.baseVersion !== currentVersion) {
          await audit('user', auth.sub, 'e2ee.note.conflict', body.id, { baseVersion: body.baseVersion, serverVersion: currentVersion });
          return reply.code(409).send({
            success: false,
            error: 'NOTE_VERSION_CONFLICT',
            serverNote: toVersionedNote(row)
          });
        }
        const updated = await query<any>(
          `UPDATE encrypted_notes
           SET encrypted_title=$1, encrypted_body=$2, base_version=$3, updated_by_device_public_id=$4, version=version+1, updated_at=now()
           WHERE id=$5 AND owner_user_id=$6
           RETURNING *`,
          [JSON.stringify(body.encryptedTitle), JSON.stringify(body.encryptedBody), body.baseVersion ?? null, auth.deviceId, body.id, auth.sub]
        );
        await audit('user', auth.sub, 'e2ee.note.versioned.update', body.id, { baseVersion: body.baseVersion });
        return toVersionedNote(updated.rows[0]);
      }
    }

    const created = await query<any>(
      `INSERT INTO encrypted_notes(id, owner_user_id, owner_device_id, encrypted_title, encrypted_body, base_version, updated_by_device_public_id, is_conflict_copy, conflict_of_note_id, conflict_meta, version, updated_at)
       VALUES(COALESCE($1, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9, $10, 1, now())
       RETURNING *`,
      [body.id ?? null, auth.sub, auth.deviceId, JSON.stringify(body.encryptedTitle), JSON.stringify(body.encryptedBody), body.baseVersion ?? null, auth.deviceId, body.isConflictCopy, body.conflictOfNoteId ?? null, body.conflictMeta ? JSON.stringify(body.conflictMeta) : null]
    );
    await audit('user', auth.sub, body.isConflictCopy ? 'e2ee.note.conflict.copy' : 'e2ee.note.versioned.create', created.rows[0].id);
    return toVersionedNote(created.rows[0]);
  });


  app.get('/v1/e2ee/groups/rotation-requests', { preHandler: userAuth }, async (req) => {
    const auth = (req as any).user as { sub: string; deviceId: string };
    const queryParams = groupRotationQuerySchema.parse(req.query);
    const res = await query<any>(
      `SELECT DISTINCT gr.*
       FROM e2ee_group_rotation_requests gr
       JOIN e2ee_group_key_envelopes gke ON gke.group_id = gr.group_id
       WHERE gr.rotated_at IS NULL
         AND gke.recipient_user_id=$1
         AND ($2::text IS NULL OR gr.group_id=$2)
         AND (gr.affected_user_id IS NULL OR gr.affected_user_id <> $1)
         AND (gr.affected_device_public_id IS NULL OR gr.affected_device_public_id <> $3)
       ORDER BY gr.created_at ASC
       LIMIT 100`,
      [auth.sub, queryParams.groupId ?? null, auth.deviceId]
    );
    return res.rows.map(toGroupRotationRecord);
  });

  app.post('/v1/e2ee/groups/rotation-requests/:requestId/ack', { preHandler: userAuth }, async (req, reply) => {
    const auth = (req as any).user as AuthUser;
    const params = z.object({ requestId: z.string().uuid() }).parse(req.params);
    const body = groupRotationAckSchema.parse(req.body);
    const actor = await requireGroupRotationAuthority(auth, body.groupId, reply);
    if (!actor) return reply;
    const res = await query<any>(
      `UPDATE e2ee_group_rotation_requests
       SET rotated_at=now(), rotated_by_user_id=$2, rotated_by_device_public_id=$3, rotated_key_version=$4
       WHERE id=$1 AND group_id=$5 AND rotated_at IS NULL
       RETURNING *`,
      [params.requestId, auth.sub, actor.publicDeviceId, body.keyVersion, body.groupId]
    );
    if (res.rows.length === 0) {
      return reply.code(404).send({ success: false, error: 'GROUP_ROTATION_REQUEST_NOT_FOUND' });
    }
    await audit('user', auth.sub, 'e2ee.group.rotation.ack', params.requestId, { groupId: body.groupId, keyVersion: body.keyVersion, actorDeviceId: actor.publicDeviceId });
    return toGroupRotationRecord(res.rows[0]);
  });

  app.get('/v1/e2ee/groups/:groupId/members/devices', { preHandler: userAuth }, async (req) => {
    const params = z.object({ groupId: z.string().min(1) }).parse(req.params);
    const auth = (req as any).user as { sub: string };
    // Current bridge: group membership source can be added later. For now, return
    // devices that have active key bundles. The client can rotate keys again when
    // membership policy is wired to real groups.
    const res = await query<any>(
      `SELECT user_id, device_public_id, identity_public_key, key_version
       FROM device_key_bundles
       WHERE user_id=$1
       ORDER BY updated_at DESC`,
      [auth.sub]
    );
    await audit('user', auth.sub, 'e2ee.group.devices.resolve', params.groupId, { count: res.rows.length });
    return res.rows.map((row) => ({
      userId: row.user_id,
      deviceId: row.device_public_id,
      identityPublicKey: row.identity_public_key,
      keyVersion: row.key_version
    }));
  });

  app.post('/v1/e2ee/groups/:groupId/keys/rotate', { preHandler: userAuth }, async (req, reply) => {
    const params = z.object({ groupId: z.string().min(1) }).parse(req.params);
    const auth = (req as any).user as AuthUser;
    const body = rotateGroupKeySchema.parse(req.body);
    if (body.groupId !== params.groupId) {
      return reply.code(400).send({ success: false, error: 'GROUP_ID_MISMATCH' });
    }
    const actor = await requireGroupRotationAuthority(auth, params.groupId, reply);
    if (!actor) return reply;

    if (actor.latestGroupKeyVersion != null && body.keyVersion <= actor.latestGroupKeyVersion) {
      return reply.code(409).send({ success: false, error: 'GROUP_KEY_VERSION_NOT_INCREMENTED', latestKeyVersion: actor.latestGroupKeyVersion });
    }

    const invalidEnvelope = body.memberEnvelopes.find((item) => item.keyVersion !== body.keyVersion || item.envelope.keyVersion !== body.keyVersion || item.envelope.senderDeviceId !== actor.publicDeviceId);
    if (invalidEnvelope) {
      return reply.code(400).send({ success: false, error: 'GROUP_KEY_ENVELOPE_INVALID_OR_UNVERIFIED_SENDER' });
    }

    const records = [];
    for (const item of body.memberEnvelopes) {
      const envelope = item.envelope;
      const res = await query<any>(
        `INSERT INTO e2ee_group_key_envelopes(group_id, recipient_user_id, recipient_device_public_id, key_version, algorithm, ciphertext, nonce, sender_public_key, sender_public_device_id, aad)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT(group_id, recipient_device_public_id, key_version)
         DO UPDATE SET algorithm=EXCLUDED.algorithm, ciphertext=EXCLUDED.ciphertext, nonce=EXCLUDED.nonce, sender_public_key=EXCLUDED.sender_public_key, sender_public_device_id=EXCLUDED.sender_public_device_id, aad=EXCLUDED.aad
         RETURNING *`,
        [params.groupId, item.recipientUserId, item.recipientDeviceId, item.keyVersion, envelope.algorithm, envelope.ciphertext, envelope.nonce, envelope.senderPublicKey, envelope.senderDeviceId, envelope.aad ?? null]
      );
      records.push(toGroupKeyRecord(res.rows[0]));
    }
    await query(
      `UPDATE e2ee_group_rotation_requests
       SET rotated_at=now(), rotated_by_user_id=$2, rotated_by_device_public_id=$3, rotated_key_version=$4
       WHERE group_id=$1 AND rotated_at IS NULL`,
      [params.groupId, auth.sub, actor.publicDeviceId, body.keyVersion]
    );
    await audit('user', auth.sub, 'e2ee.group.key.rotate.authorized', params.groupId, { keyVersion: body.keyVersion, recipients: body.memberEnvelopes.length, reason: body.reason, actorDeviceId: actor.publicDeviceId, actorRole: actor.role });
    return records;
  });

  app.get('/v1/e2ee/groups/:groupId/keys/device/:deviceId', { preHandler: userAuth }, async (req, reply) => {
    const params = z.object({ groupId: z.string().min(1), deviceId: z.string().min(1) }).parse(req.params);
    const res = await query<any>(
      `SELECT * FROM e2ee_group_key_envelopes
       WHERE group_id=$1 AND recipient_device_public_id=$2
       ORDER BY key_version DESC, created_at DESC
       LIMIT 1`,
      [params.groupId, params.deviceId]
    );
    if (res.rows.length === 0) {
      return reply.code(404).send({ success: false, error: 'GROUP_KEY_NOT_FOUND' });
    }
    return toGroupKeyRecord(res.rows[0]);
  });

  app.get('/v1/e2ee/groups/:groupId/keys/device/:deviceId/all', { preHandler: userAuth }, async (req) => {
    const params = z.object({ groupId: z.string().min(1), deviceId: z.string().min(1) }).parse(req.params);
    const res = await query<any>(
      `SELECT * FROM e2ee_group_key_envelopes
       WHERE group_id=$1 AND recipient_device_public_id=$2
       ORDER BY key_version ASC, created_at ASC`,
      [params.groupId, params.deviceId]
    );
    return res.rows.map(toGroupKeyRecord);
  });

  app.post('/v1/e2ee/groups/:groupId/messages', { preHandler: userAuth }, async (req, reply) => {
    const params = z.object({ groupId: z.string().min(1) }).parse(req.params);
    const auth = (req as any).user as AuthUser;
    const body = sendGroupMessageSchema.parse(req.body);
    if (body.groupId !== params.groupId) {
      return reply.code(400).send({ success: false, error: 'GROUP_ID_MISMATCH' });
    }
    const actor = await requireGroupMessageAuthority(auth, params.groupId, body.keyVersion, reply);
    if (!actor) return reply;
    const envelope = body.envelope;
    if (envelope.senderDeviceId !== actor.publicDeviceId || envelope.keyVersion !== body.keyVersion) {
      return reply.code(400).send({ success: false, error: 'GROUP_MESSAGE_ENVELOPE_INVALID_OR_UNVERIFIED_SENDER' });
    }
    const res = await query<any>(
      `INSERT INTO e2ee_group_messages(group_id, sender_user_id, sender_device_id, key_version, algorithm, ciphertext, nonce, sender_public_key, sender_public_device_id, aad)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [params.groupId, auth.sub, auth.deviceId, body.keyVersion, envelope.algorithm, envelope.ciphertext, envelope.nonce, envelope.senderPublicKey, envelope.senderDeviceId, envelope.aad ?? null]
    );
    await audit('user', auth.sub, 'e2ee.group.message.store.verified', res.rows[0].id, { groupId: params.groupId, keyVersion: body.keyVersion, actorDeviceId: actor.publicDeviceId });
    return toGroupMessageRecord(res.rows[0]);
  });

  app.get('/v1/e2ee/groups/:groupId/messages', { preHandler: userAuth }, async (req) => {
    const params = z.object({ groupId: z.string().min(1) }).parse(req.params);
    const res = await query<any>(
      `SELECT * FROM e2ee_group_messages WHERE group_id=$1 ORDER BY created_at ASC LIMIT 500`,
      [params.groupId]
    );
    return res.rows.map(toGroupMessageRecord);
  });

  app.post('/v1/e2ee/notes', { preHandler: userAuth }, async (req) => {
    const auth = (req as any).user as { sub: string; deviceId: string };
    const body = saveNoteSchema.parse(req.body);
    const res = await query<any>(
      `INSERT INTO encrypted_notes(id, owner_user_id, owner_device_id, encrypted_title, encrypted_body, updated_at)
       VALUES(COALESCE($1, gen_random_uuid()), $2, $3, $4, $5, now())
       ON CONFLICT(id) DO UPDATE SET encrypted_title=EXCLUDED.encrypted_title, encrypted_body=EXCLUDED.encrypted_body, updated_at=now()
       RETURNING *`,
      [body.id ?? null, auth.sub, auth.deviceId, JSON.stringify(body.encryptedTitle), JSON.stringify(body.encryptedBody)]
    );
    await audit('user', auth.sub, 'e2ee.note.save', res.rows[0].id);
    const row = res.rows[0];
    return {
      id: row.id,
      ownerId: row.owner_user_id,
      encryptedTitle: row.encrypted_title,
      encryptedBody: row.encrypted_body,
      updatedAt: new Date(row.updated_at).getTime()
    };
  });

  app.post('/v1/e2ee/recovery/vaults', { preHandler: userAuth }, async (req) => {
    const auth = (req as any).user as AuthUser;
    const body = recoveryVaultSchema.parse(req.body);
    const res = await query<any>(
      `INSERT INTO e2ee_recovery_vaults(user_id, device_id, account_profile_id, device_public_id, algorithm, kdf, iterations, salt, nonce, ciphertext, updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
       RETURNING *`,
      [auth.sub, auth.deviceId, body.accountProfileId, body.deviceId, body.algorithm, body.kdf, body.iterations, body.salt, body.nonce, body.ciphertext]
    );
    await audit('user', auth.sub, 'e2ee.recovery.vault.create', res.rows[0].id, { devicePublicId: body.deviceId, accountProfileId: body.accountProfileId });
    return {
      id: res.rows[0].id,
      accountProfileId: res.rows[0].account_profile_id,
      deviceId: res.rows[0].device_public_id,
      algorithm: res.rows[0].algorithm,
      kdf: res.rows[0].kdf,
      iterations: res.rows[0].iterations,
      salt: res.rows[0].salt,
      nonce: res.rows[0].nonce,
      ciphertext: res.rows[0].ciphertext,
      createdAt: new Date(res.rows[0].created_at).getTime()
    };
  });

  app.get('/v1/e2ee/recovery/vaults', { preHandler: userAuth }, async (req) => {
    const auth = (req as any).user as AuthUser;
    const res = await query<any>(
      `SELECT * FROM e2ee_recovery_vaults WHERE user_id=$1 AND active=TRUE ORDER BY updated_at DESC LIMIT 10`,
      [auth.sub]
    );
    await audit('user', auth.sub, 'e2ee.recovery.vault.list', auth.sub, { count: res.rows.length });
    return res.rows.map((row) => ({
      id: row.id,
      accountProfileId: row.account_profile_id,
      deviceId: row.device_public_id,
      algorithm: row.algorithm,
      kdf: row.kdf,
      iterations: row.iterations,
      salt: row.salt,
      nonce: row.nonce,
      ciphertext: row.ciphertext,
      createdAt: new Date(row.created_at).getTime()
    }));
  });

  app.post('/v1/e2ee/device-migrations', { preHandler: userAuth }, async (req) => {
    const auth = (req as any).user as AuthUser;
    const body = migrationRequestSchema.parse(req.body);
    const res = await query<any>(
      `INSERT INTO e2ee_device_migration_requests(user_id, old_device_public_id, new_device_public_id, recovery_vault_id, requested_by_device_id)
       VALUES($1,$2,$3,$4,$5) RETURNING *`,
      [auth.sub, body.oldDeviceId ?? null, body.newDeviceId, body.recoveryVaultId ?? null, auth.deviceId]
    );
    await audit('user', auth.sub, 'e2ee.device.migration.request', res.rows[0].id, { oldDeviceId: body.oldDeviceId ?? null, newDeviceId: body.newDeviceId });
    return {
      id: res.rows[0].id,
      oldDeviceId: res.rows[0].old_device_public_id,
      newDeviceId: res.rows[0].new_device_public_id,
      recoveryVaultId: res.rows[0].recovery_vault_id,
      status: res.rows[0].status,
      createdAt: new Date(res.rows[0].created_at).getTime()
    };
  });

  app.get('/v1/e2ee/device-migrations', { preHandler: userAuth }, async (req) => {
    const auth = (req as any).user as AuthUser;
    const res = await query<any>(
      `SELECT * FROM e2ee_device_migration_requests WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100`,
      [auth.sub]
    );
    return res.rows.map((row) => ({
      id: row.id,
      oldDeviceId: row.old_device_public_id,
      newDeviceId: row.new_device_public_id,
      recoveryVaultId: row.recovery_vault_id,
      status: row.status,
      decidedBy: row.decided_by,
      createdAt: new Date(row.created_at).getTime(),
      decidedAt: row.decided_at ? new Date(row.decided_at).getTime() : null
    }));
  });

  app.post('/v1/e2ee/device-migrations/:requestId/decision', { preHandler: userAuth }, async (req, reply) => {
    const auth = (req as any).user as AuthUser;
    if (!isPrivilegedGroupRole(auth.role)) {
      return reply.code(403).send({ success: false, error: 'MIGRATION_DECISION_REQUIRES_ADMIN' });
    }
    const params = z.object({ requestId: z.string().uuid() }).parse(req.params);
    const body = migrationDecisionSchema.parse(req.body);
    const res = await query<any>(
      `UPDATE e2ee_device_migration_requests
       SET status=$2, decided_by=$3, decided_at=now()
       WHERE id=$1 AND status='PENDING'
       RETURNING *`,
      [params.requestId, body.status, auth.sub]
    );
    if (res.rows.length === 0) {
      return reply.code(404).send({ success: false, error: 'MIGRATION_REQUEST_NOT_FOUND' });
    }
    await audit('user', auth.sub, 'e2ee.device.migration.decision', params.requestId, { status: body.status, reason: body.reason ?? null });
    return { id: res.rows[0].id, status: res.rows[0].status, decidedAt: new Date(res.rows[0].decided_at).getTime() };
  });

}
