export const schemaSql = `
CREATE TABLE IF NOT EXISTS certificates (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  version TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  domain TEXT NOT NULL,
  current_cert_id TEXT REFERENCES certificates(id),
  behavior TEXT NOT NULL DEFAULT 'succeed'
    CHECK (behavior IN ('succeed', 'fail', 'late_success')),
  last_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS releases (
  id TEXT PRIMARY KEY,
  priority TEXT NOT NULL CHECK (priority IN ('normal', 'emergency')),
  state TEXT NOT NULL CHECK (state IN (
    'draft', 'waiting_canary', 'paused', 'running', 'succeeded',
    'partial_failed', 'failed', 'superseded', 'cancelling',
    'cancel_partial', 'cancelled', 'rolling_back', 'rolled_back'
  )),
  domain TEXT NOT NULL,
  candidate_cert_id TEXT NOT NULL REFERENCES certificates(id),
  canary_node_id TEXT REFERENCES nodes(id),
  canary_approved BOOLEAN NOT NULL DEFAULT false,
  reason TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT 'operator',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  terminal_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS release_nodes (
  release_id TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL REFERENCES nodes(id),
  position INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'pending', 'dispatched', 'succeeded', 'failed', 'superseded',
    'restoring', 'restored', 'restore_skipped'
  )),
  previous_cert_id TEXT REFERENCES certificates(id),
  failure_reason TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (release_id, node_id)
);

CREATE TABLE IF NOT EXISTS node_controls (
  node_id TEXT PRIMARY KEY REFERENCES nodes(id),
  release_id TEXT NOT NULL REFERENCES releases(id),
  generation INTEGER NOT NULL,
  domain TEXT NOT NULL,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (node_id, release_id, generation)
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL REFERENCES releases(id),
  node_id TEXT NOT NULL REFERENCES nodes(id),
  generation INTEGER NOT NULL,
  cert_id TEXT NOT NULL REFERENCES certificates(id),
  state TEXT NOT NULL CHECK (state IN ('dispatched', 'succeeded', 'failed', 'stale_receipt', 'requeued')),
  attempt INTEGER NOT NULL DEFAULT 1,
  dispatched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  error TEXT NOT NULL DEFAULT '',
  UNIQUE (release_id, node_id, attempt)
);

CREATE TABLE IF NOT EXISTS node_cert_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES nodes(id),
  release_id TEXT NOT NULL REFERENCES releases(id),
  generation INTEGER NOT NULL,
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id),
  from_cert_id TEXT REFERENCES certificates(id),
  to_cert_id TEXT REFERENCES certificates(id),
  kind TEXT NOT NULL CHECK (kind IN ('switch', 'restore')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS node_receipts (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id),
  release_id TEXT NOT NULL REFERENCES releases(id),
  node_id TEXT NOT NULL REFERENCES nodes(id),
  generation INTEGER NOT NULL,
  success BOOLEAN NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  accepted BOOLEAN NOT NULL,
  rejection_reason TEXT NOT NULL DEFAULT '',
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS release_supersessions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  emergency_release_id TEXT NOT NULL REFERENCES releases(id),
  superseded_release_id TEXT NOT NULL REFERENCES releases(id),
  node_id TEXT NOT NULL REFERENCES nodes(id),
  previous_cert_id TEXT REFERENCES certificates(id),
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (emergency_release_id, superseded_release_id, node_id)
);

CREATE TABLE IF NOT EXISTS release_audit (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  release_id TEXT REFERENCES releases(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL DEFAULT 'system',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_release_nodes_state ON release_nodes(release_id, state);
CREATE INDEX IF NOT EXISTS idx_tasks_active ON tasks(state) WHERE state = 'dispatched';
CREATE INDEX IF NOT EXISTS idx_receipts_node ON node_receipts(node_id, received_at);
CREATE INDEX IF NOT EXISTS idx_supersessions_old ON release_supersessions(superseded_release_id);
`;
