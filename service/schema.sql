PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS browser_sessions (
  session_id TEXT PRIMARY KEY,
  mcp_session_key TEXT NOT NULL UNIQUE,
  control_key_hash TEXT NOT NULL,
  source_origin TEXT NOT NULL,
  source_url TEXT NOT NULL,
  authority_mode TEXT NOT NULL CHECK (authority_mode IN ('transaction_authorized', 'delegated_authority')),
  review_profile TEXT NOT NULL CHECK (review_profile IN ('ask_on_exception', 'autonomous_within_bounds')),
  catalog_revision TEXT,
  catalog_digest TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_tools (
  session_id TEXT NOT NULL REFERENCES browser_sessions(session_id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  relay_name TEXT NOT NULL,
  description TEXT NOT NULL,
  input_schema_json TEXT NOT NULL,
  output_schema_json TEXT,
  annotations_json TEXT,
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  catalog_revision TEXT NOT NULL,
  tool_digest TEXT NOT NULL,
  PRIMARY KEY (session_id, tool_name),
  UNIQUE (session_id, relay_name)
);

CREATE TABLE IF NOT EXISTS grants (
  grant_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode = 'delegated_authority'),
  profile TEXT NOT NULL CHECK (profile IN ('ask_on_exception', 'autonomous_within_bounds')),
  session_id TEXT NOT NULL REFERENCES browser_sessions(session_id),
  source_origin TEXT NOT NULL,
  source_url TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_digest TEXT NOT NULL,
  constraints_json TEXT NOT NULL,
  constraints_digest TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  active_key TEXT UNIQUE
);

CREATE TABLE IF NOT EXISTS executions (
  execution_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES browser_sessions(session_id),
  mcp_request_key TEXT NOT NULL,
  source_origin TEXT NOT NULL,
  source_url TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  relay_name TEXT NOT NULL,
  catalog_revision TEXT NOT NULL,
  tool_digest TEXT NOT NULL,
  output_schema_json TEXT,
  arguments_json TEXT NOT NULL,
  action_digest TEXT NOT NULL,
  authority_mode TEXT NOT NULL,
  review_profile TEXT NOT NULL,
  grant_id TEXT REFERENCES grants(grant_id),
  docket_id TEXT,
  authority_state TEXT NOT NULL,
  status TEXT NOT NULL,
  dispatch_claimed INTEGER NOT NULL DEFAULT 0 CHECK (dispatch_claimed IN (0, 1)),
  result_status TEXT,
  result_json TEXT,
  result_digest TEXT,
  result_verification TEXT,
  outcome TEXT,
  receipt_digest TEXT,
  created_at TEXT NOT NULL,
  authorized_at TEXT,
  dispatched_at TEXT,
  result_deadline_at TEXT,
  completed_at TEXT,
  UNIQUE (session_id, mcp_request_key)
);

CREATE INDEX IF NOT EXISTS executions_session_queue
  ON executions(session_id, status, dispatch_claimed, created_at);

CREATE TABLE IF NOT EXISTS dockets (
  docket_id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL UNIQUE REFERENCES executions(execution_id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'authorizing', 'denying', 'authorized', 'denied')),
  reason_code TEXT NOT NULL,
  exact_decision_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  decided_at TEXT
);

CREATE TABLE IF NOT EXISTS receipt_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  execution_id TEXT NOT NULL REFERENCES executions(execution_id),
  event_key TEXT NOT NULL,
  event_type TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (execution_id, event_key)
);

CREATE INDEX IF NOT EXISTS receipt_events_execution
  ON receipt_events(execution_id, event_id);

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
