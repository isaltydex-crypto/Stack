import { query } from '../db/pool.js';

export function assertFreshTimestamp(timestamp?: number): boolean {
  if (!timestamp) return false;
  return Math.abs(Date.now() - timestamp) < 120_000;
}

export async function consumeClientNonce(deviceId: string, nonce: string, timestamp: number): Promise<boolean> {
  if (!assertFreshTimestamp(timestamp) || nonce.length < 12 || nonce.length > 128) return false;
  await query(`DELETE FROM client_nonces WHERE expires_at < now()`);
  try {
    await query(
      `INSERT INTO client_nonces(nonce, device_id, expires_at) VALUES($1,$2,now()+interval '5 minutes')`,
      [nonce, deviceId]
    );
    await query(`UPDATE devices SET last_seen=now(), last_nonce_at=now() WHERE id=$1`, [deviceId]);
    return true;
  } catch {
    return false;
  }
}
