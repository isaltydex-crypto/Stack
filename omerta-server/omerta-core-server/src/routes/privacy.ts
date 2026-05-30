import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { audit } from '../services/audit.js';
import { getPrivacyPolicy } from '../services/privacy.js';

async function requireCreator(req: FastifyRequest, reply: FastifyReply) {
  try { await req.jwtVerify(); if ((req.user as any).type !== 'creator') throw new Error('not creator'); }
  catch { return reply.code(401).send({ success: false, error: 'UNAUTHORIZED' }); }
}

const runtimeReportSchema = z.object({
  appVersion: z.string().min(1).max(64).default('unknown'),
  result: z.enum(['passed','failed','limited','blocked','unknown']).default('unknown'),
  policyAction: z.enum(['allow','limited','block','unknown']).default('unknown'),
  coarseReason: z.enum(['runtime_integrity','debugger','root','emulator','tamper','unknown']).default('runtime_integrity')
});

const policySchema = z.object({
  auditRetentionDays: z.number().int().min(1).max(365).optional(),
  runtimeReportRetentionDays: z.number().int().min(1).max(365).optional(),
  hardeningBlockRoot: z.boolean().optional(),
  hardeningBlockDebugger: z.boolean().optional(),
  hardeningBlockEmulator: z.boolean().optional(),
  hardeningLimitedMode: z.boolean().optional(),
  notificationDefault: z.enum(['SILENT','LIMITED','FULL']).optional()
});

export async function privacyRoutes(app: FastifyInstance) {
  app.get('/v1/privacy/policy', async () => ({ success: true, policy: await getPrivacyPolicy() }));

  app.post('/v1/hardening/runtime-report', async (req) => {
    const body = runtimeReportSchema.parse(req.body ?? {});
    await query(
      `INSERT INTO runtime_integrity_daily_aggregates(day, app_version, result, policy_action, coarse_reason, count)
       VALUES (CURRENT_DATE, $1, $2, $3, $4, 1)
       ON CONFLICT(day, app_version, result, policy_action, coarse_reason)
       DO UPDATE SET count = runtime_integrity_daily_aggregates.count + 1, updated_at = now()`,
      [body.appVersion, body.result, body.policyAction, body.coarseReason]
    );
    return { success: true, stored: 'aggregate_only' };
  });

  app.get('/creator/privacy/status', { preHandler: requireCreator }, async () => {
    const policy = await getPrivacyPolicy();
    const runtime = await query<any>(
      `SELECT day, app_version, result, policy_action, coarse_reason, count
       FROM runtime_integrity_daily_aggregates
       WHERE day >= CURRENT_DATE - interval '30 days'
       ORDER BY day DESC, result ASC, policy_action ASC`
    );
    const auditStats = await query<any>(`SELECT count(*)::int AS total, count(*) FILTER (WHERE privacy_redacted=true)::int AS redacted FROM audit_logs`);
    return {
      success: true,
      privacy: {
        policy,
        runtimeAggregates: runtime.rows,
        audit: auditStats.rows[0],
        dashboardRuntimeDetail: 'aggregate_only',
        collected: ['coarse runtime result', 'policy action', 'app version', 'day bucket'],
        notCollected: ['IP address', 'device model', 'hardware fingerprint', 'root app list', 'location', 'full user-agent', 'recovery phrase', 'private keys']
      }
    };
  });

  app.put('/creator/privacy/policy', { preHandler: requireCreator }, async (req) => {
    const body = policySchema.parse(req.body ?? {});
    const current = await getPrivacyPolicy();
    const next = {
      auditRetentionDays: body.auditRetentionDays ?? current.audit_retention_days,
      runtimeReportRetentionDays: body.runtimeReportRetentionDays ?? current.runtime_report_retention_days,
      hardeningBlockRoot: body.hardeningBlockRoot ?? current.hardening_block_root,
      hardeningBlockDebugger: body.hardeningBlockDebugger ?? current.hardening_block_debugger,
      hardeningBlockEmulator: body.hardeningBlockEmulator ?? current.hardening_block_emulator,
      hardeningLimitedMode: body.hardeningLimitedMode ?? current.hardening_limited_mode,
      notificationDefault: body.notificationDefault ?? current.notification_default
    };
    await query(
      `UPDATE privacy_policies SET audit_retention_days=$1, runtime_report_retention_days=$2,
       hardening_block_root=$3, hardening_block_debugger=$4, hardening_block_emulator=$5,
       hardening_limited_mode=$6, notification_default=$7, dashboard_show_runtime_details=false, updated_at=now()
       WHERE id=1`,
      [next.auditRetentionDays, next.runtimeReportRetentionDays, next.hardeningBlockRoot, next.hardeningBlockDebugger, next.hardeningBlockEmulator, next.hardeningLimitedMode, next.notificationDefault]
    );
    await audit('creator', 'creator', 'privacy.policy.update', 'privacy_policies:1', { notificationDefault: next.notificationDefault });
    return { success: true, policy: await getPrivacyPolicy() };
  });

  app.post('/creator/privacy/cleanup', { preHandler: requireCreator }, async () => {
    const policy = await getPrivacyPolicy();
    const auditDeleted = await query<any>(`DELETE FROM audit_logs WHERE created_at < now() - ($1::text)::interval`, [`${policy.audit_retention_days} days`]);
    const runtimeDeleted = await query<any>(`DELETE FROM runtime_integrity_daily_aggregates WHERE day < CURRENT_DATE - ($1::text)::interval`, [`${policy.runtime_report_retention_days} days`]);
    const expiredInvites = await query<any>(`DELETE FROM invites WHERE used=false AND expires_at IS NOT NULL AND expires_at < now() - interval '7 days'`);
    const expiredMessageRelay = await query<any>(`DELETE FROM encrypted_messages WHERE relay_expires_at IS NOT NULL AND relay_expires_at < now()`);
    const expiredNoteRelay = await query<any>(`DELETE FROM encrypted_notes WHERE relay_expires_at IS NOT NULL AND relay_expires_at < now()`);
    await query(
      `INSERT INTO privacy_cleanup_runs(audit_deleted, runtime_aggregate_deleted, invite_deleted) VALUES($1,$2,$3)`,
      [auditDeleted.rowCount ?? 0, runtimeDeleted.rowCount ?? 0, expiredInvites.rowCount ?? 0]
    );
    await audit('creator', 'creator', 'privacy.cleanup.run', undefined, { count: (auditDeleted.rowCount ?? 0) + (runtimeDeleted.rowCount ?? 0) + (expiredInvites.rowCount ?? 0) + (expiredMessageRelay.rowCount ?? 0) + (expiredNoteRelay.rowCount ?? 0) });
    return { success: true, deleted: { audit: auditDeleted.rowCount ?? 0, runtimeAggregates: runtimeDeleted.rowCount ?? 0, expiredInvites: expiredInvites.rowCount ?? 0, messageRelay: expiredMessageRelay.rowCount ?? 0, noteRelay: expiredNoteRelay.rowCount ?? 0 } };
  });
}
