-- migrate:up
-- Extend the existing native reservation tables without replacing retained rows or their identities.
ALTER TABLE library.members_preparation
  ALTER COLUMN observation TYPE text USING observation::text,
  ADD COLUMN next_position bigint NOT NULL DEFAULT 0,
  ADD COLUMN source_exhausted boolean NOT NULL DEFAULT false,
  ADD COLUMN original_custody_id uuid,
  ADD COLUMN original_transaction_id uuid,
  ADD COLUMN original_epoch integer,
  ADD COLUMN original_generation bigint,
  ADD COLUMN original_position bigint,
  ADD COLUMN selected_workflow_id text,
  ADD COLUMN selected_function_id integer,
  ADD CONSTRAINT members_preparation_runtime_position_check CHECK (next_position >= 0),
  ADD CONSTRAINT members_preparation_runtime_checkpoint_check CHECK (octet_length(checkpoint) <= 4096),
  ADD CONSTRAINT members_preparation_runtime_observation_check CHECK (octet_length(observation) <= 4096),
  ADD CONSTRAINT members_preparation_runtime_failure_check CHECK (failure_code IN ('dependency_unavailable', 'failed')),
  ADD CONSTRAINT members_preparation_runtime_source_check CHECK ((source_incarnation IS NULL) = (source_generation IS NULL)),
  ADD CONSTRAINT members_preparation_runtime_complete_check CHECK (NOT complete OR observation IS NOT NULL),
  ADD CONSTRAINT members_preparation_runtime_original_check CHECK (
    (original_custody_id IS NULL AND original_transaction_id IS NULL AND original_epoch IS NULL
      AND original_generation IS NULL AND original_position IS NULL)
    OR (original_custody_id IS NOT NULL AND original_transaction_id IS NOT NULL AND original_epoch IS NOT NULL
      AND original_generation IS NOT NULL AND original_position IS NOT NULL
      AND original_generation > 0 AND original_position > 0)),
  ADD CONSTRAINT members_preparation_runtime_workflow_check CHECK (octet_length(selected_workflow_id) <= 256),
  ADD CONSTRAINT members_preparation_runtime_function_check CHECK (selected_function_id BETWEEN 0 AND 63),
  ADD CONSTRAINT members_preparation_runtime_selected_check CHECK ((selected_workflow_id IS NULL) = (selected_function_id IS NULL));

-- Existing candidates have no runtime position or original association. Preserve them for bounded retirement;
-- a migration does not confer completion authority or invent a Source ordering.
ALTER TABLE library.members_preparation_result
  ADD COLUMN position bigint,
  ADD CONSTRAINT members_preparation_result_runtime_position_check CHECK (position > 0);
CREATE UNIQUE INDEX members_preparation_result_runtime_position
  ON library.members_preparation_result (route, owner_account_id, collection_id, episode_id, position)
  WHERE position IS NOT NULL;
CREATE INDEX members_preparation_idle
  ON library.members_preparation ((route >> 4), last_read_at, route, owner_account_id, collection_id, episode_id)
  WHERE state = 'live';
CREATE INDEX members_preparation_idle_retired
  ON library.members_preparation ((route >> 4), last_read_at, route, owner_account_id, collection_id, episode_id)
  WHERE state = 'retired';

-- migrate:down
-- Forward only: retain native rows and exact invocation associations across recovery.
