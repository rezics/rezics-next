-- migrate:up
CREATE TABLE content.realm_subject_generation (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  realm_id uuid NOT NULL,
  generation uuid NOT NULL DEFAULT gen_random_uuid(),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  unresolved bigint NOT NULL DEFAULT 0 CHECK (unresolved >= 0),
  PRIMARY KEY (route, realm_id)
);
CREATE TABLE content.realm_subject_thread_fence (
  route integer NOT NULL,
  realm_id uuid NOT NULL,
  thread_id uuid NOT NULL,
  source_epoch integer NOT NULL CHECK (source_epoch > 0),
  source_position bigint NOT NULL CHECK (source_position > 0),
  PRIMARY KEY (route, realm_id, thread_id)
);
CREATE TABLE content.realm_subject_candidate (
  route integer NOT NULL,
  realm_id uuid NOT NULL,
  original_id uuid NOT NULL,
  thread_id uuid NOT NULL,
  opening_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  board_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('discussion', 'review')),
  terminal_id uuid,
  identity_epoch bigint,
  active boolean NOT NULL,
  live boolean NOT NULL,
  source_epoch integer NOT NULL CHECK (source_epoch > 0),
  source_position bigint NOT NULL CHECK (source_position >= 0),
  PRIMARY KEY (route, realm_id, original_id, thread_id),
  CHECK ((terminal_id IS NULL) = (identity_epoch IS NULL)),
  CHECK (identity_epoch IS NULL OR identity_epoch >= 0)
);
CREATE INDEX realm_subject_candidate_prefix ON content.realm_subject_candidate
  (route, realm_id, terminal_id, original_id, thread_id) WHERE active AND terminal_id IS NOT NULL;
CREATE INDEX realm_subject_candidate_thread ON content.realm_subject_candidate
  (route, realm_id, thread_id, original_id);
CREATE INDEX realm_subject_candidate_unresolved ON content.realm_subject_candidate
  (route, realm_id, original_id, thread_id) WHERE active AND terminal_id IS NULL;
CREATE TABLE content.realm_subject_census (
  route integer PRIMARY KEY CHECK (route BETWEEN 0 AND 65535),
  generation uuid NOT NULL DEFAULT gen_random_uuid(),
  cut_epoch integer NOT NULL CHECK (cut_epoch > 0),
  cut_position bigint NOT NULL CHECK (cut_position >= 0),
  upper_id uuid,
  after_id uuid,
  pending jsonb,
  ordinal integer NOT NULL DEFAULT 0 CHECK (ordinal BETWEEN 0 AND 128),
  exhausted boolean NOT NULL DEFAULT false
);
-- migrate:down
-- Forward only: structural progress and live removal fences must survive restart.
