import 'dotenv/config';

const nodeEnv = process.env.NODE_ENV ?? 'development';

function readBoolean(name: string, fallback: boolean) {
  const value = process.env[name];
  if (!value) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

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

function readNumber(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export const config = {
  nodeEnv,
  port: readNumber('PORT', 8080),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://omerta:omerta_dev_password@localhost:5432/omerta',
  jwtSecret: readSecret('JWT_SECRET', 'dev-only-change-me'),
  cookieSecret: readSecret('COOKIE_SECRET', 'dev-cookie-change-me'),
  creatorEmail: process.env.CREATOR_EMAIL ?? 'creator@omerta.local',
  creatorPassword: readSecret('CREATOR_PASSWORD', 'change-me-now'),
  dashboardOrigin: process.env.DASHBOARD_ORIGIN ?? 'http://localhost:5173',
  publicApiUrl: process.env.PUBLIC_API_URL ?? 'http://localhost:8080',
  publicWsUrl: process.env.PUBLIC_WS_URL ?? 'ws://localhost:8080/ws',
  provisioningSecret: process.env.OMERTA_PROVISIONING_SECRET ?? '',
  productionCookies: readBoolean('OMERTA_SECURE_COOKIES', false),
  maxBodyBytes: readNumber('OMERTA_MAX_BODY_BYTES', 262144),
  globalRateLimitMax: readNumber('OMERTA_RATE_LIMIT_MAX', nodeEnv === 'production' ? 60 : 120),
  globalRateLimitWindow: process.env.OMERTA_RATE_LIMIT_WINDOW ?? '1 minute',
  relayPayloadMaxBytes: readNumber('RELAY_PAYLOAD_MAX_BYTES', 32768),
  inviteDefaultTtlHours: readNumber('INVITE_DEFAULT_TTL_HOURS', 72),
  inviteMaxAttempts: readNumber('INVITE_MAX_ATTEMPTS', 8),
  inviteLockMinutes: readNumber('INVITE_LOCK_MINUTES', 30),
  nowPaymentsApiBaseUrl: process.env.NOWPAYMENTS_API_BASE_URL ?? 'https://api.nowpayments.io/v1',
  nowPaymentsApiKey: process.env.NOWPAYMENTS_API_KEY ?? '',
  nowPaymentsIpnSecret: process.env.NOWPAYMENTS_IPN_SECRET ?? '',
  nowPaymentsPriceCurrency: process.env.NOWPAYMENTS_PRICE_CURRENCY ?? 'usd',
  nowPaymentsPayoutCurrency: process.env.NOWPAYMENTS_PAYOUT_CURRENCY ?? 'usdttrc20',
  nowPaymentsMonthlyUsd: readNumber('NOWPAYMENTS_MONTHLY_USD', 29),
  nowPaymentsSixMonthsUsd: readNumber('NOWPAYMENTS_SIX_MONTHS_USD', 149),
  nowPaymentsYearlyUsd: readNumber('NOWPAYMENTS_YEARLY_USD', 249),
  billingReturnUrl: process.env.BILLING_RETURN_URL ?? 'omerta://billing/return',
  billingCancelUrl: process.env.BILLING_CANCEL_URL ?? 'omerta://billing/cancel'
};
