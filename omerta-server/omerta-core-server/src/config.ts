import 'dotenv/config';

const nodeEnv = process.env.NODE_ENV ?? 'development';

function readSecret(name: string, fallback: string) {
  const value = process.env[name] ?? fallback;
  if (nodeEnv === 'production') {
    const unsafe =
      !process.env[name] ||
      value.startsWith('CHANGE_') ||
      value.includes('change-me') ||
      value.includes('dev-only') ||
      value.includes('dev-cookie');
    if (unsafe) {
      throw new Error(`Refusing to start production with unsafe ${name}`);
    }
    if (value.length < 32) {
      throw new Error(`Refusing to start production with short ${name}; use at least 32 characters`);
    }
  }
  return value;
}

export const config = {
  nodeEnv,
  port: Number(process.env.PORT ?? 8080),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://omerta:omerta_dev_password@localhost:5432/omerta',
  jwtSecret: readSecret('JWT_SECRET', 'dev-only-change-me'),
  cookieSecret: readSecret('COOKIE_SECRET', 'dev-cookie-change-me'),
  creatorEmail: process.env.CREATOR_EMAIL ?? 'creator@omerta.local',
  creatorPassword: readSecret('CREATOR_PASSWORD', 'change-me-now'),
  dashboardOrigin: process.env.DASHBOARD_ORIGIN ?? 'http://localhost:5173',
  productionCookies: nodeEnv === 'production',
  relayPayloadMaxBytes: Number(process.env.RELAY_PAYLOAD_MAX_BYTES ?? 32768),
  inviteDefaultTtlHours: Number(process.env.INVITE_DEFAULT_TTL_HOURS ?? 72),
  inviteMaxAttempts: Number(process.env.INVITE_MAX_ATTEMPTS ?? 8),
  inviteLockMinutes: Number(process.env.INVITE_LOCK_MINUTES ?? 30)
};
