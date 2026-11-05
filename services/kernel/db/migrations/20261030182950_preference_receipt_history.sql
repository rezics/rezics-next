-- migrate:up
ALTER TABLE core.receipt ADD COLUMN payload_state text NOT NULL DEFAULT 'present'
  CHECK (payload_state IN ('present','minimized'));
ALTER TABLE core.receipt ADD CONSTRAINT receipt_minimized_response
  CHECK (payload_state <> 'minimized' OR response = 'null'::jsonb);
ALTER TABLE core.history_locator DROP CONSTRAINT history_locator_roles_check;
ALTER TABLE core.history_locator ADD CONSTRAINT history_locator_roles_check CHECK (roles BETWEEN 1 AND 262143);

-- Native applicability and restart cursor; DBOS holds only job_id and fixed result codes.
CREATE TABLE core.preference_history_job (
  job_id uuid PRIMARY KEY,
  partition_no integer NOT NULL REFERENCES core.partition(partition_no),
  account_route integer NOT NULL,
  account_id uuid NOT NULL,
  barrier_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','covered-pending')),
  cursor bytea CHECK (octet_length(cursor) BETWEEN 1 AND 256),
  CHECK (barrier_id = account_id),
  CHECK (partition_no = (account_route >> 4)),
  FOREIGN KEY (account_route,barrier_id) REFERENCES access.erasure(route,account_id)
);
CREATE INDEX history_locator_artifact ON core.history_locator
  (partition_no,artifact_type,locator,account_route,account_id);

-- migrate:down
-- Forward-only: erased responses cannot be restored.
