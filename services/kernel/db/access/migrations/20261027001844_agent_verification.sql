-- migrate:up
ALTER TABLE access.exposure_opening
  DROP CONSTRAINT exposure_opening_group_check,
  ADD CONSTRAINT exposure_opening_group_check CHECK ("group" ~ '^[a-z][a-z_-]{0,62}$');

ALTER TABLE access.account
  ADD COLUMN agent_verified boolean NOT NULL DEFAULT false,
  ADD COLUMN agent_subject_id uuid,
  ADD COLUMN agent_verification_receipt_id uuid,
  ADD COLUMN pending_agent_subject_id uuid,
  ADD COLUMN pending_agent_receipt_id uuid,
  ADD CONSTRAINT account_agent_verification_check CHECK (
    (pending_agent_subject_id IS NULL) = (pending_agent_receipt_id IS NULL)
    AND (
      (agent_verified AND agent_subject_id IS NOT NULL AND agent_verification_receipt_id IS NOT NULL
        AND pending_agent_subject_id IS NULL)
      OR
      (NOT agent_verified AND agent_subject_id IS NULL AND agent_verification_receipt_id IS NULL)
    )
  );

CREATE TABLE access.agent_verification_request (
  route integer NOT NULL CHECK (route = 0),
  request_id uuid NOT NULL,
  account_id uuid NOT NULL,
  account_kind text NOT NULL CHECK (account_kind IN ('actor', 'organization')),
  requested_by uuid NOT NULL,
  catalogue_subject_id uuid NOT NULL,
  statement text NOT NULL CHECK (char_length(statement) BETWEEN 1 AND 2000),
  links jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(links) = 'array' AND jsonb_array_length(links) <= 5),
  state text NOT NULL CHECK (state IN ('pending', 'approving', 'approved', 'rejected', 'withdrawn', 'failed')),
  reason text CHECK (reason IS NULL OR char_length(reason) <= 500),
  problem_type text CHECK (problem_type IS NULL OR char_length(problem_type) BETWEEN 1 AND 128),
  problem_detail text CHECK (problem_detail IS NULL OR char_length(problem_detail) <= 512),
  decision_receipt_id uuid,
  decided_by uuid,
  created_at timestamp with time zone NOT NULL DEFAULT statement_timestamp() CHECK (isfinite(created_at)),
  updated_at timestamp with time zone NOT NULL DEFAULT statement_timestamp() CHECK (isfinite(updated_at)),
  transaction_id uuid NOT NULL,
  PRIMARY KEY (route, request_id),
  CHECK (route = get_byte(uuid_send(request_id), 10) * 256 + get_byte(uuid_send(request_id), 11)),
  CHECK ((state IN ('approving', 'approved', 'rejected', 'failed')) = (decision_receipt_id IS NOT NULL)),
  CHECK ((state IN ('approving', 'approved', 'rejected', 'failed')) = (decided_by IS NOT NULL)),
  CHECK ((problem_type IS NULL) = (problem_detail IS NULL))
);

CREATE UNIQUE INDEX agent_verification_active_account_idx
  ON access.agent_verification_request (route, account_id)
  WHERE state IN ('pending', 'approving');

CREATE INDEX agent_verification_pending_page_idx
  ON access.agent_verification_request (route, created_at, request_id)
  WHERE state = 'pending';

CREATE INDEX agent_verification_account_latest_idx
  ON access.agent_verification_request (route, account_id, created_at DESC, request_id DESC);

-- migrate:down
DROP TABLE access.agent_verification_request;
ALTER TABLE access.account
  DROP CONSTRAINT account_agent_verification_check,
  DROP COLUMN pending_agent_receipt_id,
  DROP COLUMN pending_agent_subject_id,
  DROP COLUMN agent_verification_receipt_id,
  DROP COLUMN agent_subject_id,
  DROP COLUMN agent_verified;
ALTER TABLE access.exposure_opening
  DROP CONSTRAINT exposure_opening_group_check,
  ADD CONSTRAINT exposure_opening_group_check CHECK ("group" ~ '^[a-z][a-z_]{0,62}$');
