import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { audit } from '../services/audit.js';

const releasePolicySchema = z.object({
  currentAppVersion: z.string().min(1).max(32).optional(),
  minimumAppVersion: z.string().min(1).max(32).optional(),
  serverVersion: z.string().min(1).max(32).optional(),
  dashboardVersion: z.string().min(1).max(32).optional(),
  updateRecommended: z.boolean().optional(),
  forceUpdate: z.boolean().optional(),
  maintenanceMode: z.boolean().optional(),
  killSwitch: z.boolean().optional(),
  allowedAppVersions: z.array(z.string().min(1).max(32)).optional(),
  blockedAppVersions: z.array(z.string().min(1).max(32)).optional(),
  message: z.string().max(500).nullable().optional(),
  remoteConfig: z.record(z.unknown()).optional(),
  featureFlags: z.record(z.unknown()).optional()
});

const checkQuerySchema = z.object({
  appVersion: z.string().min(1).max(32).default('unknown'),
  platform: z.string().min(1).max(32).default('android'),
  channel: z.string().min(1).max(32).default('stable')
});

async function requireCreator(req: FastifyRequest, reply: FastifyReply) {
  try { await req.jwtVerify(); if (req.user.type !== 'creator') throw new Error('not creator'); }
  catch { return reply.code(401).send({ success: false, error: 'UNAUTHORIZED' }); }
}

function normalize(row: any) {
  return {
    channel: row.channel,
    currentAppVersion: row.current_app_version,
    minimumAppVersion: row.minimum_app_version,
    serverVersion: row.server_version,
    dashboardVersion: row.dashboard_version,
    updateRecommended: row.update_recommended,
    forceUpdate: row.force_update,
    maintenanceMode: row.maintenance_mode,
    killSwitch: row.kill_switch,
    allowedAppVersions: row.allowed_app_versions ?? [],
    blockedAppVersions: row.blocked_app_versions ?? [],
    message: row.message,
    remoteConfig: row.remote_config ?? {},
    featureFlags: row.feature_flags ?? {},
    updatedAt: row.updated_at
  };
}

function compareSemverLike(a: string, b: string) {
  const parse = (v: string) => v.replace(/^v/i, '').split(/[.+-]/).map(x => Number.parseInt(x, 10)).filter(n => Number.isFinite(n));
  const aa = parse(a); const bb = parse(b); const len = Math.max(aa.length, bb.length, 3);
  for (let i = 0; i < len; i++) { const x = aa[i] ?? 0; const y = bb[i] ?? 0; if (x !== y) return x > y ? 1 : -1; }
  return 0;
}

export async function releaseRoutes(app: FastifyInstance) {
  app.get('/v1/release/check', async (req) => {
    const q = checkQuerySchema.parse(req.query);
    const res = await query<any>('SELECT * FROM release_policies WHERE id=1');
    const row = res.rows[0];
    const policy = normalize(row);
    const allowed = new Set<string>(policy.allowedAppVersions);
    const blocked = new Set<string>(policy.blockedAppVersions);

    let status: 'allowed' | 'update_recommended' | 'force_update' | 'blocked' | 'maintenance' = 'allowed';
    let reason: string | null = null;
    if (policy.killSwitch) { status = 'blocked'; reason = 'KILL_SWITCH'; }
    else if (policy.maintenanceMode) { status = 'maintenance'; reason = 'MAINTENANCE_MODE'; }
    else if (blocked.has(q.appVersion)) { status = 'blocked'; reason = 'VERSION_BLOCKED'; }
    else if (allowed.size > 0 && !allowed.has(q.appVersion)) { status = 'force_update'; reason = 'VERSION_NOT_ALLOWED'; }
    else if (compareSemverLike(q.appVersion, policy.minimumAppVersion) < 0) { status = 'force_update'; reason = 'BELOW_MINIMUM_VERSION'; }
    else if (policy.forceUpdate) { status = 'force_update'; reason = 'FORCE_UPDATE_ENABLED'; }
    else if (policy.updateRecommended || compareSemverLike(q.appVersion, policy.currentAppVersion) < 0) { status = 'update_recommended'; reason = 'NEWER_VERSION_AVAILABLE'; }

    return { success: true, status, reason, platform: q.platform, channel: q.channel, policy };
  });

  app.get('/creator/release-policy', { preHandler: requireCreator }, async () => {
    const [policy, events] = await Promise.all([
      query<any>('SELECT * FROM release_policies WHERE id=1'),
      query<any>('SELECT * FROM release_events ORDER BY created_at DESC LIMIT 50')
    ]);
    return { success: true, policy: normalize(policy.rows[0]), events: events.rows };
  });

  app.put('/creator/release-policy', { preHandler: requireCreator }, async (req) => {
    const body = releasePolicySchema.parse(req.body);
    const res = await query<any>(
      `UPDATE release_policies SET
        current_app_version=COALESCE($1,current_app_version),
        minimum_app_version=COALESCE($2,minimum_app_version),
        server_version=COALESCE($3,server_version),
        dashboard_version=COALESCE($4,dashboard_version),
        update_recommended=COALESCE($5,update_recommended),
        force_update=COALESCE($6,force_update),
        maintenance_mode=COALESCE($7,maintenance_mode),
        kill_switch=COALESCE($8,kill_switch),
        allowed_app_versions=COALESCE($9,allowed_app_versions),
        blocked_app_versions=COALESCE($10,blocked_app_versions),
        message=COALESCE($11,message),
        remote_config=COALESCE($12,remote_config),
        feature_flags=COALESCE($13,feature_flags),
        updated_by='creator', updated_at=now()
       WHERE id=1 RETURNING *`,
      [
        body.currentAppVersion ?? null,
        body.minimumAppVersion ?? null,
        body.serverVersion ?? null,
        body.dashboardVersion ?? null,
        body.updateRecommended ?? null,
        body.forceUpdate ?? null,
        body.maintenanceMode ?? null,
        body.killSwitch ?? null,
        body.allowedAppVersions ? JSON.stringify(body.allowedAppVersions) : null,
        body.blockedAppVersions ? JSON.stringify(body.blockedAppVersions) : null,
        body.message ?? null,
        body.remoteConfig ? JSON.stringify(body.remoteConfig) : null,
        body.featureFlags ? JSON.stringify(body.featureFlags) : null
      ]
    );
    const kind = body.forceUpdate ? 'FORCE_UPDATE' : body.maintenanceMode ? 'MAINTENANCE' : 'CONFIG_CHANGE';
    await query(`INSERT INTO release_events(version, kind, notes, metadata) VALUES($1,$2,$3,$4)`, [body.currentAppVersion ?? res.rows[0].current_app_version, kind, body.message ?? null, JSON.stringify(body)]);
    await audit('creator', 'creator', 'release.policy.update', 'release_policies:1', body);
    return { success: true, policy: normalize(res.rows[0]) };
  });
}
