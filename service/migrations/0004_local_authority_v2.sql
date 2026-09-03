-- Add the local-authority V2 transport contract without changing any V1 table.
-- Rules and full receipt history remain extension-owned. Raw action payload
-- columns are transient and may be cleared after local acknowledgement or TTL.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS v2_device_challenges (
  challenge_id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  public_jwk_json TEXT NOT NULL,
  jwk_thumbprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE INDEX IF NOT EXISTS v2_device_challenges_expiry
  ON v2_device_challenges(expires_at, consumed_at);

CREATE TABLE IF NOT EXISTS v2_devices (
  device_id TEXT PRIMARY KEY,
  public_jwk_json TEXT NOT NULL,
  jwk_thumbprint TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS v2_device_nonces (
  device_id TEXT NOT NULL REFERENCES v2_devices(device_id) ON DELETE CASCADE,
  nonce TEXT NOT NULL,
  request_method TEXT NOT NULL,
  request_path TEXT NOT NULL,
  request_timestamp TEXT NOT NULL,
  body_digest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (device_id, nonce)
);

CREATE INDEX IF NOT EXISTS v2_device_nonces_created
  ON v2_device_nonces(created_at);

CREATE TABLE IF NOT EXISTS v2_tasks (
  task_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES v2_devices(device_id),
  external_task_ref TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'ended', 'revoked')),
  created_at TEXT NOT NULL,
  last_active_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ended_at TEXT
);

CREATE INDEX IF NOT EXISTS v2_tasks_device_status
  ON v2_tasks(device_id, status, expires_at);

CREATE TABLE IF NOT EXISTS v2_actions (
  action_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES v2_devices(device_id),
  task_id TEXT NOT NULL REFERENCES v2_tasks(task_id),
  status TEXT NOT NULL,
  source_origin TEXT,
  source_url TEXT,
  tool_name TEXT,
  catalog_digest TEXT,
  tool_digest TEXT,
  schema_digest TEXT,
  request_digest TEXT,
  impact_json TEXT,
  request_payload_json TEXT,
  result_payload_json TEXT,
  payload_expires_at TEXT,
  local_ack_at TEXT,
  purged_at TEXT,
  receipt_digest TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS v2_actions_task_status
  ON v2_actions(task_id, status, created_at);

CREATE INDEX IF NOT EXISTS v2_actions_payload_expiry
  ON v2_actions(payload_expires_at, local_ack_at, purged_at);

CREATE TABLE IF NOT EXISTS v2_receipt_bindings (
  action_id TEXT PRIMARY KEY REFERENCES v2_actions(action_id),
  device_id TEXT NOT NULL REFERENCES v2_devices(device_id),
  task_id TEXT NOT NULL REFERENCES v2_tasks(task_id),
  receipt_digest TEXT NOT NULL,
  bound_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS v2_receipt_bindings_task
  ON v2_receipt_bindings(task_id, bound_at);

CREATE TABLE IF NOT EXISTS v2_connections (
  connection_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES v2_devices(device_id),
  task_id TEXT NOT NULL REFERENCES v2_tasks(task_id),
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS v2_connections_scope
  ON v2_connections(device_id, task_id, expires_at, revoked_at);
