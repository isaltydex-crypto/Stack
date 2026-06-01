CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS containers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  api_url TEXT NOT NULL,
  ws_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'online',
  remote_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  kill_switch BOOLEAN NOT NULL DEFAULT FALSE,
  feature_flags JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  container_id UUID REFERENCES containers(id) ON DELETE CASCADE,
  nick TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('ADMIN','SUB_ADMIN','USER')),
  public_identity_key TEXT,
  disabled_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash TEXT NOT NULL UNIQUE,
  display_code_suffix TEXT NOT NULL,
  container_id UUID REFERENCES containers(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('ADMIN','SUB_ADMIN','USER')),
  used BOOLEAN NOT NULL DEFAULT FALSE,
  used_by UUID REFERENCES users(id) ON DELETE SET NULL,
  expires_at TIMESTAMPTZ,
  failed_attempts INT NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  last_failed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  used_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  device_hash TEXT NOT NULL,
  public_identity_key TEXT,
  push_token TEXT,
  owner_mode BOOLEAN NOT NULL DEFAULT FALSE,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, device_hash)
);

CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  device_id UUID REFERENCES devices(id) ON DELETE CASCADE,
  refresh_token_hash TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  revoked_at TIMESTAMPTZ,
  replaced_by UUID,
  reuse_detected_at TIMESTAMPTZ,
  rotation_counter INT NOT NULL DEFAULT 0,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  target_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Safe migrations for older local builds
ALTER TABLE containers ADD COLUMN IF NOT EXISTS remote_config JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE containers ADD COLUMN IF NOT EXISTS kill_switch BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE containers ADD COLUMN IF NOT EXISTS feature_flags JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE containers ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS public_identity_key TEXT;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS rotation_counter INT NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS replaced_by UUID;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS reuse_detected_at TIMESTAMPTZ;
ALTER TABLE invites ADD COLUMN IF NOT EXISTS failed_attempts INT NOT NULL DEFAULT 0;
ALTER TABLE invites ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;
ALTER TABLE invites ADD COLUMN IF NOT EXISTS last_failed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_sessions_device_active ON sessions(device_id, active);
CREATE INDEX IF NOT EXISTS idx_sessions_refresh_hash ON sessions(refresh_token_hash);
CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);
CREATE INDEX IF NOT EXISTS idx_invites_code_hash ON invites(code_hash);
CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_logs(created_at DESC);


CREATE TABLE IF NOT EXISTS client_nonces (
  nonce TEXT PRIMARY KEY,
  device_id UUID REFERENCES devices(id) ON DELETE CASCADE,
  seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '5 minutes'
);

ALTER TABLE devices ADD COLUMN IF NOT EXISTS client_public_key TEXT;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS attestation_level TEXT NOT NULL DEFAULT 'software';
ALTER TABLE devices ADD COLUMN IF NOT EXISTS runtime_flags JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_nonce_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_client_nonces_expires_at ON client_nonces(expires_at);
CREATE INDEX IF NOT EXISTS idx_devices_revoked_at ON devices(revoked_at);

CREATE TABLE IF NOT EXISTS wipe_security (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  pin_hash TEXT,
  failed_attempts INT NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  last_verified_at TIMESTAMPTZ,
  app_wipe_pin_hash TEXT,
  phone_wipe_pin_hash TEXT,
  app_failed_attempts INT NOT NULL DEFAULT 0,
  app_locked_until TIMESTAMPTZ,
  phone_failed_attempts INT NOT NULL DEFAULT 0,
  phone_locked_until TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wipe_commands (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope TEXT NOT NULL CHECK (scope IN ('all','container','user','device')),
  target_id UUID,
  reason TEXT,
  requested_by TEXT NOT NULL,
  wipe_type TEXT NOT NULL DEFAULT 'APP_WIPE' CHECK (wipe_type IN ('APP_WIPE','PHONE_WIPE','LEGACY_WIPE')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  acknowledged_at TIMESTAMPTZ
);


ALTER TABLE wipe_security ADD COLUMN IF NOT EXISTS app_wipe_pin_hash TEXT;
ALTER TABLE wipe_security ADD COLUMN IF NOT EXISTS phone_wipe_pin_hash TEXT;
ALTER TABLE wipe_security ADD COLUMN IF NOT EXISTS app_failed_attempts INT NOT NULL DEFAULT 0;
ALTER TABLE wipe_security ADD COLUMN IF NOT EXISTS app_locked_until TIMESTAMPTZ;
ALTER TABLE wipe_security ADD COLUMN IF NOT EXISTS phone_failed_attempts INT NOT NULL DEFAULT 0;
ALTER TABLE wipe_security ADD COLUMN IF NOT EXISTS phone_locked_until TIMESTAMPTZ;
ALTER TABLE wipe_commands ADD COLUMN IF NOT EXISTS wipe_type TEXT NOT NULL DEFAULT 'APP_WIPE';
ALTER TABLE wipe_commands ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
INSERT INTO wipe_security(id) VALUES(1) ON CONFLICT (id) DO NOTHING;
CREATE INDEX IF NOT EXISTS idx_wipe_commands_created_at ON wipe_commands(created_at DESC);

-- v2.4.2 E2EE Foundation. Server stores public keys and ciphertext only.
CREATE TABLE IF NOT EXISTS device_key_bundles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  device_id UUID REFERENCES devices(id) ON DELETE CASCADE,
  device_public_id TEXT NOT NULL,
  identity_public_key TEXT NOT NULL,
  key_version INT NOT NULL DEFAULT 1,
  algorithm TEXT NOT NULL DEFAULT 'OMERTA_ECDH_P256_AES_GCM_V1',
  signed_pre_key TEXT,
  one_time_pre_keys JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, device_public_id)
);

CREATE TABLE IF NOT EXISTS encrypted_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id TEXT NOT NULL,
  sender_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  sender_device_id UUID REFERENCES devices(id) ON DELETE SET NULL,
  receiver_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  algorithm TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  nonce TEXT NOT NULL,
  sender_public_key TEXT NOT NULL,
  sender_public_device_id TEXT NOT NULL,
  recipient_device_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  key_version INT NOT NULL DEFAULT 1,
  aad TEXT,
  delivery_status TEXT NOT NULL DEFAULT 'SENT',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS encrypted_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  owner_device_id UUID REFERENCES devices(id) ON DELETE SET NULL,
  encrypted_title JSONB NOT NULL,
  encrypted_body JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_device_key_bundles_user ON device_key_bundles(user_id);
CREATE INDEX IF NOT EXISTS idx_encrypted_messages_conversation ON encrypted_messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_encrypted_notes_owner ON encrypted_notes(owner_user_id, updated_at DESC);

-- v2.4.3 E2EE DM fanout + Note Sync Guard.
CREATE TABLE IF NOT EXISTS encrypted_message_recipients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID REFERENCES encrypted_messages(id) ON DELETE CASCADE,
  recipient_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  recipient_device_public_id TEXT NOT NULL,
  algorithm TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  nonce TEXT NOT NULL,
  sender_public_key TEXT NOT NULL,
  sender_public_device_id TEXT NOT NULL,
  key_version INT NOT NULL DEFAULT 1,
  aad TEXT,
  delivery_status TEXT NOT NULL DEFAULT 'SENT',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(message_id, recipient_device_public_id)
);

ALTER TABLE encrypted_notes ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 1;
ALTER TABLE encrypted_notes ADD COLUMN IF NOT EXISTS base_version BIGINT;
ALTER TABLE encrypted_notes ADD COLUMN IF NOT EXISTS updated_by_device_public_id TEXT;
ALTER TABLE encrypted_notes ADD COLUMN IF NOT EXISTS is_conflict_copy BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE encrypted_notes ADD COLUMN IF NOT EXISTS conflict_of_note_id UUID REFERENCES encrypted_notes(id) ON DELETE SET NULL;
ALTER TABLE encrypted_notes ADD COLUMN IF NOT EXISTS conflict_meta JSONB;

CREATE INDEX IF NOT EXISTS idx_encrypted_message_recipients_message ON encrypted_message_recipients(message_id);
CREATE INDEX IF NOT EXISTS idx_encrypted_message_recipients_device ON encrypted_message_recipients(recipient_device_public_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_encrypted_notes_conflict ON encrypted_notes(conflict_of_note_id) WHERE is_conflict_copy = TRUE;


-- v2.4.4 Group E2EE. Group keys are encrypted per member device.
CREATE TABLE IF NOT EXISTS e2ee_group_key_envelopes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id TEXT NOT NULL,
  recipient_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  recipient_device_public_id TEXT NOT NULL,
  key_version INT NOT NULL,
  algorithm TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  nonce TEXT NOT NULL,
  sender_public_key TEXT NOT NULL,
  sender_public_device_id TEXT NOT NULL,
  aad TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(group_id, recipient_device_public_id, key_version)
);

CREATE TABLE IF NOT EXISTS e2ee_group_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id TEXT NOT NULL,
  sender_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  sender_device_id UUID REFERENCES devices(id) ON DELETE SET NULL,
  key_version INT NOT NULL,
  algorithm TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  nonce TEXT NOT NULL,
  sender_public_key TEXT NOT NULL,
  sender_public_device_id TEXT NOT NULL,
  aad TEXT,
  delivery_status TEXT NOT NULL DEFAULT 'SENT',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_group_key_envelopes_device ON e2ee_group_key_envelopes(group_id, recipient_device_public_id, key_version DESC);
CREATE INDEX IF NOT EXISTS idx_group_messages_group ON e2ee_group_messages(group_id, created_at);


-- v2.4.4 revocation-aware Group E2EE.
-- When a user/device is revoked or wiped, existing group content keys must be
-- rotated by an active member device before new group messages are sent.
CREATE TABLE IF NOT EXISTS e2ee_group_rotation_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  affected_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  affected_device_public_id TEXT,
  requested_by TEXT NOT NULL,
  rotated_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  rotated_by_device_public_id TEXT,
  rotated_key_version INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  rotated_at TIMESTAMPTZ,
  UNIQUE(group_id, affected_user_id, affected_device_public_id, reason, rotated_at)
);

CREATE INDEX IF NOT EXISTS idx_group_rotation_requests_pending ON e2ee_group_rotation_requests(group_id, created_at DESC) WHERE rotated_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_group_rotation_requests_user ON e2ee_group_rotation_requests(affected_user_id, created_at DESC);

-- v2.4.5 Key Recovery + Device Migration.
-- Recovery phrase never reaches the server. Server stores only encrypted vaults
-- and migration approval state.
CREATE TABLE IF NOT EXISTS e2ee_recovery_vaults (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  device_id UUID REFERENCES devices(id) ON DELETE SET NULL,
  account_profile_id TEXT NOT NULL,
  device_public_id TEXT NOT NULL,
  algorithm TEXT NOT NULL,
  kdf TEXT NOT NULL,
  iterations INT NOT NULL,
  salt TEXT NOT NULL,
  nonce TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS e2ee_device_migration_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  old_device_public_id TEXT,
  new_device_public_id TEXT NOT NULL,
  recovery_vault_id UUID REFERENCES e2ee_recovery_vaults(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','DENIED','CANCELLED')),
  requested_by_device_id UUID REFERENCES devices(id) ON DELETE SET NULL,
  decided_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_recovery_vaults_user ON e2ee_recovery_vaults(user_id, active, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_device_migration_user ON e2ee_device_migration_requests(user_id, status, created_at DESC);


-- v2.5 Release Pipeline + Remote Updates.
CREATE TABLE IF NOT EXISTS release_policies (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  channel TEXT NOT NULL DEFAULT 'stable',
  current_app_version TEXT NOT NULL DEFAULT '2.4.5',
  minimum_app_version TEXT NOT NULL DEFAULT '2.4.1',
  server_version TEXT NOT NULL DEFAULT '2.5.0',
  dashboard_version TEXT NOT NULL DEFAULT '2.5.0',
  update_recommended BOOLEAN NOT NULL DEFAULT FALSE,
  force_update BOOLEAN NOT NULL DEFAULT FALSE,
  maintenance_mode BOOLEAN NOT NULL DEFAULT FALSE,
  kill_switch BOOLEAN NOT NULL DEFAULT FALSE,
  allowed_app_versions JSONB NOT NULL DEFAULT '[]'::jsonb,
  blocked_app_versions JSONB NOT NULL DEFAULT '[]'::jsonb,
  message TEXT,
  remote_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  feature_flags JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS release_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'stable',
  kind TEXT NOT NULL CHECK (kind IN ('RELEASE','ROLLBACK','CONFIG_CHANGE','FORCE_UPDATE','MAINTENANCE')),
  notes TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by TEXT NOT NULL DEFAULT 'creator',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO release_policies(id) VALUES(1) ON CONFLICT (id) DO NOTHING;
CREATE INDEX IF NOT EXISTS idx_release_events_created_at ON release_events(created_at DESC);


-- v2.6 Privacy-Preserving Hardening
-- Runtime integrity is intentionally aggregated/minimal. No IP, user-agent, device model,
-- physical fingerprint, or per-person hardening details are stored for dashboard use.
CREATE TABLE IF NOT EXISTS privacy_policies (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  audit_retention_days INT NOT NULL DEFAULT 60,
  runtime_report_retention_days INT NOT NULL DEFAULT 30,
  hardening_block_root BOOLEAN NOT NULL DEFAULT TRUE,
  hardening_block_debugger BOOLEAN NOT NULL DEFAULT TRUE,
  hardening_block_emulator BOOLEAN NOT NULL DEFAULT FALSE,
  hardening_limited_mode BOOLEAN NOT NULL DEFAULT TRUE,
  notification_default TEXT NOT NULL DEFAULT 'LIMITED' CHECK (notification_default IN ('SILENT','LIMITED','FULL')),
  dashboard_show_runtime_details BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO privacy_policies(id) VALUES(1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS runtime_integrity_daily_aggregates (
  day DATE NOT NULL,
  app_version TEXT NOT NULL DEFAULT 'unknown',
  result TEXT NOT NULL CHECK (result IN ('passed','failed','limited','blocked','unknown')),
  policy_action TEXT NOT NULL CHECK (policy_action IN ('allow','limited','block','unknown')),
  coarse_reason TEXT NOT NULL DEFAULT 'runtime_integrity',
  count INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(day, app_version, result, policy_action, coarse_reason)
);

CREATE TABLE IF NOT EXISTS privacy_cleanup_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_deleted INT NOT NULL DEFAULT 0,
  runtime_aggregate_deleted INT NOT NULL DEFAULT 0,
  wipe_deleted INT NOT NULL DEFAULT 0,
  migration_deleted INT NOT NULL DEFAULT 0,
  invite_deleted INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS privacy_redacted BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_audit_expires_at ON audit_logs(expires_at);
CREATE INDEX IF NOT EXISTS idx_runtime_integrity_daily ON runtime_integrity_daily_aggregates(day DESC);

-- v2.7.4 Local-only data mode: encrypted content tables are relay queues, not history.
-- Payloads must expire and should be deleted after recipient/device ack.
ALTER TABLE encrypted_messages ADD COLUMN IF NOT EXISTS relay_expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '72 hours';
ALTER TABLE encrypted_messages ADD COLUMN IF NOT EXISTS relay_ack_delete BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE encrypted_messages ADD COLUMN IF NOT EXISTS relay_deleted_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_encrypted_messages_relay_expiry ON encrypted_messages(relay_expires_at);

ALTER TABLE encrypted_notes ADD COLUMN IF NOT EXISTS relay_expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '72 hours';
ALTER TABLE encrypted_notes ADD COLUMN IF NOT EXISTS relay_ack_delete BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE encrypted_notes ADD COLUMN IF NOT EXISTS relay_deleted_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_encrypted_notes_relay_expiry ON encrypted_notes(relay_expires_at);

-- v2.7.7 FMD-style wipe execution acknowledgements
ALTER TABLE wipe_commands ADD COLUMN IF NOT EXISTS ack_status TEXT;
CREATE INDEX IF NOT EXISTS idx_wipe_commands_pending ON wipe_commands(acknowledged_at, expires_at);

-- v2.8 VPS Deploy Bridge + local-only data mode relay.
-- Messages/notes should not be permanent server history. This queue only holds
-- encrypted payloads until recipient devices fetch and acknowledge them, or until TTL expiry.
CREATE TABLE IF NOT EXISTS relay_payloads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('DM_MESSAGE','GROUP_MESSAGE','NOTE_UPDATE')),
  sender_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  sender_device_id UUID REFERENCES devices(id) ON DELETE SET NULL,
  recipient_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  recipient_device_public_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  ack_status TEXT,
  ack_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '24 hours'
);

CREATE INDEX IF NOT EXISTS idx_relay_payloads_device_pending ON relay_payloads(recipient_device_public_id, created_at) WHERE ack_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_relay_payloads_expires ON relay_payloads(expires_at);
CREATE INDEX IF NOT EXISTS idx_relay_payloads_cleanup ON relay_payloads(ack_status, ack_at);

-- v2.8 app runtime metadata. No message/note bodies are stored here.
CREATE TABLE IF NOT EXISTS app_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  container_id UUID REFERENCES containers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_note_meta (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  container_id UUID REFERENCES containers(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'Untitled',
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_app_groups_container ON app_groups(container_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_app_note_meta_container ON app_note_meta(container_id, updated_at DESC);

-- v2.9 crypto period access. NOWPayments purchases grant fixed access periods,
-- then provision one Omerta container plus a first admin invite after IPN payment confirmation.
CREATE TABLE IF NOT EXISTS billing_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL DEFAULT 'nowpayments',
  plan TEXT NOT NULL CHECK (plan IN ('monthly','six_months','yearly')),
  access_months INT NOT NULL,
  amount_usd NUMERIC(12,2) NOT NULL,
  price_currency TEXT NOT NULL DEFAULT 'usd',
  payout_currency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','waiting','confirming','paid','failed','expired','cancelled')),
  provider_invoice_id TEXT,
  provider_payment_id TEXT,
  provider_payment_status TEXT,
  invoice_url TEXT,
  customer_email TEXT,
  container_id UUID REFERENCES containers(id) ON DELETE SET NULL,
  first_admin_invite_id UUID REFERENCES invites(id) ON DELETE SET NULL,
  first_admin_invite_code TEXT,
  access_until TIMESTAMPTZ,
  raw_provider_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at TIMESTAMPTZ,
  provisioned_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_billing_orders_status ON billing_orders(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_billing_orders_provider_payment ON billing_orders(provider, provider_payment_id);
