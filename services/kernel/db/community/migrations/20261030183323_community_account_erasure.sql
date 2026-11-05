-- migrate:up
CREATE TABLE community.account_erasure_progress (
  route integer NOT NULL,
  account_id uuid NOT NULL,
  step bigint NOT NULL DEFAULT 0 CHECK (step >= 0),
  phase text NOT NULL CHECK (phase IN ('close','memberships','revisions','records','notices','rating','proof','complete')),
  cursor jsonb,
  erased_at timestamptz NOT NULL,
  community_found boolean NOT NULL DEFAULT false,
  phase_pending boolean NOT NULL DEFAULT false,
  reasons_kept_until timestamptz,
  rating_had_votes boolean NOT NULL DEFAULT false,
  PRIMARY KEY (route, account_id),
  CHECK (route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11))),
  CHECK (isfinite(erased_at)),
  CHECK (reasons_kept_until IS NULL OR isfinite(reasons_kept_until))
);

-- migrate:down
-- Forward only: this participant cursor records irreversible erasure progress.
