-- migrate:up
-- Operational custody only. Semantic owns support, receiving receipts and publication.
CREATE TABLE search.identity_receiving_native_plan (
  partition_no integer NOT NULL CHECK (partition_no BETWEEN 0 AND 4095),
  plan_id uuid NOT NULL,
  job_id uuid NOT NULL,
  job_epoch bigint NOT NULL CHECK (job_epoch > 0),
  original_id uuid NOT NULL,
  document_id uuid NOT NULL,
  physical_target text COLLATE "C" NOT NULL CHECK (octet_length(physical_target) <= 256),
  effect_key text COLLATE "C" NOT NULL CHECK (octet_length(effect_key) BETWEEN 1 AND 256),
  scope_digest text NOT NULL CHECK (scope_digest ~ '^[a-f0-9]{64}$'),
  source jsonb NOT NULL CHECK (octet_length(source::text) <= 8192),
  obligations jsonb NOT NULL CHECK (octet_length(obligations::text) <= 8192),
  action_digest text NOT NULL CHECK (action_digest ~ '^[a-f0-9]{64}$'),
  initial_copy_count integer NOT NULL CHECK (initial_copy_count BETWEEN 0 AND 100),
  transaction_id uuid NOT NULL,
  PRIMARY KEY (partition_no, plan_id),
  UNIQUE (partition_no, job_id, job_epoch, effect_key)
);
CREATE TABLE search.identity_receiving_native_document (
  partition_no integer NOT NULL CHECK (partition_no BETWEEN 0 AND 4095),
  physical_target text COLLATE "C" NOT NULL,
  document_id uuid NOT NULL,
  PRIMARY KEY (partition_no, physical_target, document_id)
);
-- Outstanding custody only: retired plan history is never traversed by a drain probe.
CREATE TABLE search.identity_receiving_native_pending (
  partition_no integer NOT NULL,
  physical_target text COLLATE "C" NOT NULL,
  plan_id uuid NOT NULL,
  PRIMARY KEY (partition_no, physical_target, plan_id),
  FOREIGN KEY (partition_no, plan_id) REFERENCES search.identity_receiving_native_plan
);
CREATE TABLE search.identity_receiving_native_hold (
  partition_no integer NOT NULL,
  plan_id uuid NOT NULL,
  hold_id uuid NOT NULL,
  accepted_transaction_id uuid NOT NULL,
  accepted_epoch integer CHECK (accepted_epoch > 0),
  accepted_position bigint CHECK (accepted_position > 0),
  released_transaction_id uuid,
  PRIMARY KEY (partition_no, plan_id),
  UNIQUE (partition_no, hold_id),
  FOREIGN KEY (partition_no, plan_id) REFERENCES search.identity_receiving_native_plan,
  CHECK ((accepted_epoch IS NULL) = (accepted_position IS NULL))
);
CREATE TABLE search.identity_receiving_native_operation (
  partition_no integer NOT NULL,
  plan_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  hold_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('dispatched','visible','applied')),
  writer_token uuid NOT NULL,
  writer_locator text NOT NULL CHECK (octet_length(writer_locator) BETWEEN 1 AND 8192),
  writer_transaction_id uuid NOT NULL,
  writer_position bigint NOT NULL CHECK (writer_position > 0),
  dispatch_transaction_id uuid NOT NULL,
  visible_transaction_id uuid,
  visible_position bigint CHECK (visible_position > 0),
  writer_evidence_digest text CHECK (writer_evidence_digest ~ '^[a-f0-9]{64}$'),
  applied_transaction_id uuid,
  frontier jsonb CHECK (octet_length(frontier::text) <= 2048),
  PRIMARY KEY (partition_no, plan_id, operation_id),
  UNIQUE (partition_no, plan_id),
  FOREIGN KEY (partition_no, hold_id) REFERENCES search.identity_receiving_native_hold (partition_no, hold_id),
  CHECK ((state='dispatched') = (visible_transaction_id IS NULL)),
  CHECK ((visible_transaction_id IS NULL) = (visible_position IS NULL)),
  CHECK ((visible_transaction_id IS NULL) = (writer_evidence_digest IS NULL)),
  CHECK ((state='applied') = (applied_transaction_id IS NOT NULL)),
  CHECK ((applied_transaction_id IS NULL) = (frontier IS NULL))
);
CREATE TABLE search.identity_receiving_native_copy (
  partition_no integer NOT NULL,
  plan_id uuid NOT NULL,
  copy_no integer NOT NULL CHECK (copy_no >= 0),
  locator jsonb NOT NULL CHECK (octet_length(locator::text) <= 2048),
  transaction_id uuid NOT NULL,
  reconciled_transaction_id uuid,
  settlement jsonb CHECK (octet_length(settlement::text) <= 512),
  PRIMARY KEY (partition_no, plan_id, copy_no),
  FOREIGN KEY (partition_no, plan_id) REFERENCES search.identity_receiving_native_plan,
  CHECK ((reconciled_transaction_id IS NULL) = (settlement IS NULL))
);
CREATE INDEX identity_receiving_native_copy_pending
  ON search.identity_receiving_native_copy(partition_no, plan_id, copy_no)
  WHERE reconciled_transaction_id IS NULL;
CREATE FUNCTION search.prevent_receiving_plan_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Native receiving plans are immutable'; END; $$;
CREATE TRIGGER identity_receiving_native_plan_immutable
 BEFORE UPDATE OR DELETE ON search.identity_receiving_native_plan
 FOR EACH ROW EXECUTE FUNCTION search.prevent_receiving_plan_mutation();

-- migrate:down
DROP TABLE search.identity_receiving_native_copy;
DROP TABLE search.identity_receiving_native_operation;
DROP TABLE search.identity_receiving_native_hold;
DROP TABLE search.identity_receiving_native_pending;
DROP TABLE search.identity_receiving_native_document;
DROP TABLE search.identity_receiving_native_plan;
DROP FUNCTION search.prevent_receiving_plan_mutation();
