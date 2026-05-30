import { createHash } from 'crypto';
import { query } from '../db/pool.js';

type PrivacyPolicy = {
  audit_retention_days: number;
  runtime_report_retention_days: number;
  hardening_block_root: boolean;
  hardening_block_debugger: boolean;
  hardening_block_emulator: boolean;
  hardening_limited_mode: boolean;
  notification_default: 'SILENT' | 'LIMITED' | 'FULL';
  dashboard_show_runtime_details: boolean;
};

const DEFAULT_POLICY: PrivacyPolicy = {
  audit_retention_days: 60,
  runtime_report_retention_days: 30,
  hardening_block_root: true,
  hardening_block_debugger: true,
  hardening_block_emulator: false,
  hardening_limited_mode: true,
  notification_default: 'LIMITED',
  dashboard_show_runtime_details: false
};

const SENSITIVE_KEYS = new Set([
  'ip', 'ipAddress', 'userAgent', 'deviceModel', 'hardwareFingerprint', 'fingerprint',
  'rootApps', 'debugDetails', 'network', 'location', 'latitude', 'longitude', 'pushToken',
  'recoveryPhrase', 'privateKey', 'token', 'refreshToken', 'accessToken', 'deviceHash'
]);

const ALLOWED_METADATA_KEYS = new Set([
  'scope', 'role', 'status', 'containerId', 'reason', 'count', 'keyVersion', 'recipientCount',
  'baseVersion', 'serverVersion', 'policyAction', 'coarseReason', 'privacyRedacted',
  'groups', 'locked', 'attempts'
]);

export function pseudonymize(value: string | null | undefined): string | null {
  if (!value) return null;
  const salt = process.env.AUDIT_PSEUDONYM_SALT ?? 'omerta-local-dev-salt';
  return `p_${createHash('sha256').update(`${salt}:${value}`).digest('hex').slice(0, 16)}`;
}

export function redactTarget(action: string, targetId?: string): string | null {
  if (!targetId) return null;
  if (action.includes('wipe') || action.includes('device') || action.includes('migration') || action.includes('recovery')) {
    return pseudonymize(targetId);
  }
  return targetId;
}

export function sanitizeMetadata(metadata: Record<string, unknown> = {}): Record<string, unknown> {
  const safe: Record<string, unknown> = { privacyRedacted: true };
  for (const [key, value] of Object.entries(metadata)) {
    if (SENSITIVE_KEYS.has(key)) continue;
    if (!ALLOWED_METADATA_KEYS.has(key)) continue;
    if (Array.isArray(value)) safe[key] = value.length;
    else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) safe[key] = value;
  }
  return safe;
}

export async function getPrivacyPolicy(): Promise<PrivacyPolicy> {
  const res = await query<any>('SELECT * FROM privacy_policies WHERE id=1');
  if (!res.rows[0]) return DEFAULT_POLICY;
  const row = res.rows[0];
  return {
    audit_retention_days: row.audit_retention_days ?? DEFAULT_POLICY.audit_retention_days,
    runtime_report_retention_days: row.runtime_report_retention_days ?? DEFAULT_POLICY.runtime_report_retention_days,
    hardening_block_root: row.hardening_block_root ?? DEFAULT_POLICY.hardening_block_root,
    hardening_block_debugger: row.hardening_block_debugger ?? DEFAULT_POLICY.hardening_block_debugger,
    hardening_block_emulator: row.hardening_block_emulator ?? DEFAULT_POLICY.hardening_block_emulator,
    hardening_limited_mode: row.hardening_limited_mode ?? DEFAULT_POLICY.hardening_limited_mode,
    notification_default: row.notification_default ?? DEFAULT_POLICY.notification_default,
    dashboard_show_runtime_details: false
  };
}

export async function retentionExpirySql(): Promise<string> {
  const p = await getPrivacyPolicy();
  return `${Math.max(1, Math.min(365, p.audit_retention_days))} days`;
}
