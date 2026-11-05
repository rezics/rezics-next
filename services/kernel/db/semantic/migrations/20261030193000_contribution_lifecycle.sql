-- migrate:up
CREATE TABLE semantic.contribution_lifecycle (
  route integer NOT NULL,
  subject_id uuid NOT NULL,
  candidate_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'deleted',
  deleted_at timestamptz NOT NULL,
  purge_after timestamptz NOT NULL,
  held boolean NOT NULL DEFAULT false,
  security_revision bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (route, subject_id, candidate_id),
  CHECK (purge_after = deleted_at + interval '720 hours'),
  CHECK (state IN ('active', 'deleted', 'purged')),
  CHECK (route = get_byte(uuid_send(subject_id), 10) * 256 + get_byte(uuid_send(subject_id), 11)),
  CHECK (route = get_byte(uuid_send(candidate_id), 10) * 256 + get_byte(uuid_send(candidate_id), 11)),
  CHECK (security_revision > 0)
);

-- migrate:down
DROP TABLE semantic.contribution_lifecycle;
