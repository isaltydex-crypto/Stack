import { query } from '../db/pool.js';
import { pseudonymize, redactTarget, retentionExpirySql, sanitizeMetadata } from './privacy.js';

export async function audit(actorType: string, actorId: string | null, action: string, targetId?: string, metadata: Record<string, unknown> = {}) {
  const expiry = await retentionExpirySql();
  await query(
    `INSERT INTO audit_logs(actor_type, actor_id, action, target_id, metadata, privacy_redacted, expires_at)
     VALUES($1,$2,$3,$4,$5,true, now() + ($6::text)::interval)`,
    [actorType, pseudonymize(actorId), action, redactTarget(action, targetId), sanitizeMetadata(metadata), expiry]
  );
}
