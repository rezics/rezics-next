-- migrate:up
-- Obligation progress only: this is neither a source inventory nor a per-subject tombstone.
CREATE TABLE search.erasure_progress (
  partition_no integer NOT NULL CHECK (partition_no BETWEEN 0 AND 4095),
  account_id uuid NOT NULL,
  version integer NOT NULL CHECK (version = 1),
  at timestamptz NOT NULL,
  protocol integer NOT NULL CHECK (protocol = 1),
  phase text NOT NULL CHECK (phase IN ('sealing','source','copies','repair','drain','finalize','done')),
  pending_reason text CHECK (pending_reason IN ('source-unavailable','configuration-unavailable')),
  ever_applied boolean NOT NULL DEFAULT false,
  PRIMARY KEY (partition_no, account_id)
);
-- Mark immutable prepared generations before erasing their payload so captures cannot recreate them.
ALTER TABLE search.public_filter_prepared ADD COLUMN state text NOT NULL DEFAULT 'active'
  CHECK (state IN ('active','erasing'));
-- Retained observations are enumerated inside their existing registration home, never by JSON scanning.
CREATE INDEX public_filter_observation_registration
  ON search.public_filter_observation(partition_no,registration,observation);
CREATE INDEX public_filter_registration_target
  ON search.public_filter_registration(partition_no,physical_target,id);
-- migrate:down
-- Forward only: obligation progress and prepared-generation refusal must survive rollback.
