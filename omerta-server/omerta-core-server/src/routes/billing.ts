import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import crypto from 'crypto';
import { z } from 'zod';
import { config } from '../config.js';
import { pool, query } from '../db/pool.js';
import { audit } from '../services/audit.js';
import { generateInviteCode, sha256 } from '../services/security.js';

const createOrderSchema = z.object({
  plan: z.enum(['monthly', 'six_months', 'yearly']),
  customerEmail: z.string().email().optional()
});
const provisionSchema = z.object({
  externalOrderId: z.string().min(3).max(160),
  plan: z.enum(['monthly', 'six_months', 'yearly']),
  customerEmail: z.string().email().optional(),
  amountUsd: z.number().positive().optional(),
  source: z.string().min(2).max(80).default('webshop'),
  metadata: z.record(z.unknown()).optional()
});
const statusParamsSchema = z.object({ orderId: z.string().uuid() });

const paidStatuses = new Set(['confirmed', 'finished']);
const failedStatuses = new Set(['failed', 'expired', 'cancelled', 'refunded']);

function planConfig(plan: 'monthly' | 'six_months' | 'yearly') {
  if (plan === 'six_months') return { months: 6, amountUsd: config.nowPaymentsSixMonthsUsd, label: '6 months' };
  if (plan === 'yearly') return { months: 12, amountUsd: config.nowPaymentsYearlyUsd, label: '1 year' };
  return { months: 1, amountUsd: config.nowPaymentsMonthlyUsd, label: '1 month' };
}

function sortObject(value: any): any {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc: Record<string, unknown>, key) => {
      acc[key] = sortObject(value[key]);
      return acc;
    }, {});
  }
  return value;
}

function verifyNowPaymentsSignature(body: unknown, signature: string | undefined) {
  if (!config.nowPaymentsIpnSecret || !signature) return false;
  const hmac = crypto.createHmac('sha512', config.nowPaymentsIpnSecret);
  hmac.update(JSON.stringify(sortObject(body)));
  const expected = hmac.digest('hex');
  const actual = signature.trim();
  if (!/^[a-f0-9]+$/i.test(actual)) return false;
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'));
}

function verifyProvisioningAuth(req: FastifyRequest) {
  if (!config.provisioningSecret) return false;
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
  if (!token || token.length !== config.provisioningSecret.length) return false;
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(config.provisioningSecret));
}

function publicOrder(order: any) {
  return {
    success: true,
    orderId: order.id,
    provider: order.provider,
    plan: order.plan,
    accessMonths: Number(order.access_months),
    amountUsd: Number(order.amount_usd),
    status: order.status,
    providerPaymentStatus: order.provider_payment_status ?? null,
    invoiceUrl: order.invoice_url ?? null,
    accessUntil: order.access_until ?? null,
    provisioned: Boolean(order.provisioned_at),
    containerName: order.container_name ?? null,
    apiUrl: order.api_url ?? config.publicApiUrl,
    wsUrl: order.ws_url ?? config.publicWsUrl,
    inviteCode: order.provisioned_at ? order.first_admin_invite_code : null
  };
}

async function provisionPaidOrder(orderId: string) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const orderRes = await client.query<any>(
      `SELECT * FROM billing_orders WHERE id=$1 FOR UPDATE`,
      [orderId]
    );
    const order = orderRes.rows[0];
    if (!order || order.provisioned_at) {
      await client.query('COMMIT');
      return order;
    }

    const suffix = order.id.replace(/-/g, '').slice(0, 10);
    const containerName = `omerta-${suffix}`;
    const containerRes = await client.query<any>(
      `INSERT INTO containers(name, api_url, ws_url, status)
       VALUES($1,$2,$3,'online')
       ON CONFLICT(name) DO UPDATE SET updated_at=now()
       RETURNING *`,
      [containerName, config.publicApiUrl, config.publicWsUrl]
    );
    const container = containerRes.rows[0];
    const code = generateInviteCode();
    const inviteRes = await client.query<any>(
      `INSERT INTO invites(code_hash, display_code_suffix, container_id, role, expires_at)
       VALUES($1,$2,$3,'ADMIN', now()+($4::text || ' hours')::interval)
       RETURNING id`,
      [sha256(code), code.slice(-4), container.id, config.inviteDefaultTtlHours]
    );
    const accessUntilRes = await client.query<any>(
      `UPDATE billing_orders
       SET status='paid',
           container_id=$2,
           first_admin_invite_id=$3,
           first_admin_invite_code=$4,
           access_until=now()+($5::text || ' months')::interval,
           provisioned_at=now(),
           paid_at=COALESCE(paid_at, now()),
           updated_at=now()
       WHERE id=$1
       RETURNING *`,
      [orderId, container.id, inviteRes.rows[0].id, code, order.access_months]
    );
    await client.query('COMMIT');
    await audit('system', null, 'billing.order.provision', orderId, { provider: 'nowpayments', containerId: container.id });
    return accessUntilRes.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function billingRoutes(app: FastifyInstance) {
  app.post('/internal/billing/provision', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!config.provisioningSecret) {
      return reply.code(503).send({ success: false, error: 'PROVISIONING_NOT_CONFIGURED' });
    }
    if (!verifyProvisioningAuth(req)) {
      await audit('system', null, 'billing.provision.unauthorized', undefined, { privacyRedacted: true });
      return reply.code(401).send({ success: false, error: 'UNAUTHORIZED' });
    }

    const body = provisionSchema.parse(req.body);
    const plan = planConfig(body.plan);
    const provider = body.source || 'webshop';
    const rawPayload = JSON.stringify({
      externalOrderId: body.externalOrderId,
      source: provider,
      customerEmail: body.customerEmail ?? null,
      metadata: body.metadata ?? {}
    });

    const orderRes = await query<any>(
      `INSERT INTO billing_orders(provider, external_order_id, plan, access_months, amount_usd, price_currency, payout_currency, status, provider_invoice_id, customer_email, raw_provider_payload, paid_at)
       VALUES($1,$2,$3,$4,$5,'usd','external','paid',$2,$6,$7,now())
       ON CONFLICT(provider, external_order_id) WHERE external_order_id IS NOT NULL
       DO UPDATE SET updated_at=now()
       RETURNING *`,
      [provider, body.externalOrderId, body.plan, plan.months, body.amountUsd ?? plan.amountUsd, body.customerEmail ?? null, rawPayload]
    );
    const order = orderRes.rows[0];
    const provisioned = order.provisioned_at ? order : await provisionPaidOrder(order.id);
    const publicRes = await query<any>(
      `SELECT billing_orders.*, containers.name AS container_name, containers.api_url, containers.ws_url
       FROM billing_orders
       LEFT JOIN containers ON containers.id=billing_orders.container_id
       WHERE billing_orders.id=$1`,
      [provisioned.id]
    );
    await audit('system', null, 'billing.provision.external', order.id, { provider, externalOrderId: body.externalOrderId, plan: body.plan });
    return publicOrder(publicRes.rows[0]);
  });

  app.post('/billing/nowpayments/create-invoice', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!config.nowPaymentsApiKey) {
      return reply.code(503).send({ success: false, error: 'NOWPAYMENTS_NOT_CONFIGURED' });
    }
    const body = createOrderSchema.parse(req.body);
    const plan = planConfig(body.plan);
    const orderRes = await query<any>(
      `INSERT INTO billing_orders(plan, access_months, amount_usd, price_currency, payout_currency, customer_email)
       VALUES($1,$2,$3,$4,$5,$6)
       RETURNING *`,
      [body.plan, plan.months, plan.amountUsd, config.nowPaymentsPriceCurrency, config.nowPaymentsPayoutCurrency, body.customerEmail ?? null]
    );
    const order = orderRes.rows[0];
    const apiPayload = {
      price_amount: plan.amountUsd,
      price_currency: config.nowPaymentsPriceCurrency,
      pay_currency: config.nowPaymentsPayoutCurrency,
      order_id: order.id,
      order_description: `Omerta Private Network - ${plan.label}`,
      ipn_callback_url: `${config.publicApiUrl.replace(/\/$/, '')}/billing/nowpayments/ipn`,
      success_url: config.billingReturnUrl,
      cancel_url: config.billingCancelUrl
    };
    const response = await fetch(`${config.nowPaymentsApiBaseUrl.replace(/\/$/, '')}/invoice`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.nowPaymentsApiKey
      },
      body: JSON.stringify(apiPayload)
    });
    const data: any = await response.json().catch(() => ({}));
    if (!response.ok) {
      await query(`UPDATE billing_orders SET status='failed', raw_provider_payload=$2, updated_at=now() WHERE id=$1`, [order.id, JSON.stringify(data)]);
      return reply.code(502).send({ success: false, error: 'NOWPAYMENTS_CREATE_INVOICE_FAILED', details: data });
    }
    const invoiceUrl = data.invoice_url ?? data.invoiceUrl ?? data.payment_url ?? data.url ?? null;
    const updated = await query<any>(
      `UPDATE billing_orders
       SET provider_invoice_id=$2, invoice_url=$3, raw_provider_payload=$4, status='waiting', updated_at=now()
       WHERE id=$1
       RETURNING *`,
      [order.id, String(data.id ?? data.invoice_id ?? ''), invoiceUrl, JSON.stringify(data)]
    );
    await audit('system', null, 'billing.order.create', order.id, { provider: 'nowpayments', plan: body.plan });
    return publicOrder(updated.rows[0]);
  });

  app.get('/billing/nowpayments/status/:orderId', async (req, reply) => {
    const { orderId } = statusParamsSchema.parse(req.params);
    const res = await query<any>(
      `SELECT billing_orders.*, containers.name AS container_name, containers.api_url, containers.ws_url
       FROM billing_orders
       LEFT JOIN containers ON containers.id=billing_orders.container_id
       WHERE billing_orders.id=$1`,
      [orderId]
    );
    if (!res.rows[0]) return reply.code(404).send({ success: false, error: 'ORDER_NOT_FOUND' });
    return publicOrder(res.rows[0]);
  });

  app.post('/billing/nowpayments/ipn', async (req: FastifyRequest, reply: FastifyReply) => {
    const signature = req.headers['x-nowpayments-sig'];
    if (!verifyNowPaymentsSignature(req.body, Array.isArray(signature) ? signature[0] : signature)) {
      await audit('system', null, 'billing.ipn.invalid_signature', undefined, { provider: 'nowpayments' });
      return reply.code(401).send({ success: false, error: 'INVALID_SIGNATURE' });
    }
    const body = req.body as any;
    const orderId = String(body.order_id ?? '');
    const parsed = statusParamsSchema.safeParse({ orderId });
    if (!parsed.success) return reply.code(400).send({ success: false, error: 'INVALID_ORDER_ID' });

    const providerStatus = String(body.payment_status ?? body.invoice_status ?? '').toLowerCase();
    const status = paidStatuses.has(providerStatus)
      ? 'paid'
      : failedStatuses.has(providerStatus)
        ? providerStatus === 'expired' ? 'expired' : providerStatus === 'cancelled' ? 'cancelled' : 'failed'
        : providerStatus === 'confirming' ? 'confirming' : 'waiting';

    await query(
      `UPDATE billing_orders
       SET status=$2,
           provider_payment_status=$3,
           provider_payment_id=COALESCE($4, provider_payment_id),
           raw_provider_payload=$5,
           paid_at=CASE WHEN $2='paid' THEN COALESCE(paid_at, now()) ELSE paid_at END,
           updated_at=now()
       WHERE id=$1`,
      [orderId, status, providerStatus, body.payment_id ? String(body.payment_id) : null, JSON.stringify(body)]
    );
    if (status === 'paid') await provisionPaidOrder(orderId);
    await audit('system', null, 'billing.ipn.received', orderId, { provider: 'nowpayments', providerStatus, status });
    return { success: true };
  });
}
