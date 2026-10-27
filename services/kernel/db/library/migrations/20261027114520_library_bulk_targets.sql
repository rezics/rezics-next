-- migrate:up
-- Source-owned private manifest. Writers freeze the complete target and receipt once;
-- later transitions change only outcome accounting, with the source's fixed counters.
CREATE TABLE library.bulk_target (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  operation_id uuid NOT NULL,
  ordinal bigint NOT NULL CHECK (ordinal >= 0),
  account_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  target_kind text NOT NULL CHECK (target_kind IN ('subject', 'occurrence')),
  collection_id uuid,
  member_id uuid,
  target jsonb NOT NULL CHECK (jsonb_typeof(target) = 'object'),
  source_digest text NOT NULL CHECK (source_digest ~ '^[0-9a-f]{64}$'),
  receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt) = 'object'),
  created_transaction_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('pending', 'reconciling', 'applied', 'no_effect', 'conflict', 'denied', 'failed', 'cancelled')),
  reason text CHECK (reason IN (
    'revision_mismatch', 'incarnation_mismatch', 'missing_target', 'authority_lost',
    'target_denied', 'collection_full', 'invalid_subject', 'dependency_unavailable',
    'deadline', 'cancel_requested', 'evidence_missing', 'execution_expired'
  )),
  resulting_member_id uuid,
  evidence jsonb CHECK (jsonb_typeof(evidence) = 'object'),
  chunk_index integer NOT NULL CHECK (chunk_index >= 0),
  PRIMARY KEY (route, operation_id, ordinal),
  CHECK (route = get_byte(uuid_send(operation_id), 10) * 256 + get_byte(uuid_send(operation_id), 11)),
  CHECK (route = get_byte(uuid_send(account_id), 10) * 256 + get_byte(uuid_send(account_id), 11)),
  CHECK (
    (target_kind = 'subject' AND collection_id IS NULL AND member_id IS NULL)
    OR (target_kind = 'occurrence' AND collection_id IS NOT NULL AND member_id IS NOT NULL)
  ),
  -- A remote occurrence stays bound to its Collection, not the source account route.
  CHECK (
    get_byte(uuid_send(collection_id), 10) * 256 + get_byte(uuid_send(collection_id), 11)
    = get_byte(uuid_send(member_id), 10) * 256 + get_byte(uuid_send(member_id), 11)
  )
);

CREATE UNIQUE INDEX bulk_target_subject
  ON library.bulk_target (route, operation_id, subject_id) WHERE target_kind = 'subject';
CREATE UNIQUE INDEX bulk_target_occurrence
  ON library.bulk_target (route, operation_id, collection_id, member_id) WHERE target_kind = 'occurrence';
CREATE INDEX bulk_target_state
  ON library.bulk_target (route, operation_id, state, ordinal);
CREATE INDEX bulk_target_pending
  ON library.bulk_target (route, operation_id, ordinal) WHERE state IN ('pending', 'reconciling');

-- Exact private evidence committed with the native receipt in the target command.
-- Immutable target/source/receipt bindings prove only an earlier commit: they never
-- replace independent source, creation-receipt or live Access checks for an effect.
CREATE TABLE library.bulk_effect (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  operation_id uuid NOT NULL,
  ordinal bigint NOT NULL CHECK (ordinal >= 0),
  target_anchor_id uuid NOT NULL,
  account_id uuid NOT NULL,
  source_route integer NOT NULL CHECK (source_route BETWEEN 0 AND 65535),
  source_id uuid NOT NULL,
  source_digest text NOT NULL CHECK (source_digest ~ '^[0-9a-f]{64}$'),
  target jsonb NOT NULL CHECK (jsonb_typeof(target) = 'object'),
  receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt) = 'object'),
  command_kind text NOT NULL CHECK (char_length(command_kind) BETWEEN 1 AND 255),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 255),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  transaction_id uuid NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('applied', 'no_effect', 'conflict', 'denied', 'failed', 'cancelled')),
  reason text CHECK (reason IN (
    'revision_mismatch', 'incarnation_mismatch', 'missing_target', 'authority_lost',
    'target_denied', 'collection_full', 'invalid_subject', 'dependency_unavailable',
    'deadline', 'cancel_requested', 'evidence_missing', 'execution_expired'
  )),
  resulting_member_id uuid,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (route, operation_id, ordinal),
  CHECK (route = get_byte(uuid_send(target_anchor_id), 10) * 256 + get_byte(uuid_send(target_anchor_id), 11)),
  CHECK (source_route = get_byte(uuid_send(source_id), 10) * 256 + get_byte(uuid_send(source_id), 11))
);

CREATE INDEX bulk_effect_expiry
  ON library.bulk_effect (route, expires_at, operation_id, ordinal);

-- No source/root foreign key: evidence can live on a remote Collection partition.
-- Bounded native cleanup orders explicit phases after terminal/closed work and the
-- advertised results horizon; expires_at alone does not authorize deletion.
-- migrate:down
-- Forward only: manifests and committed target evidence must not be discarded by rollback.
