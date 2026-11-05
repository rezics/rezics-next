-- migrate:up
-- One retained Source projection window per original subject and immutable meaning.
-- It stores only source anchors and bounded dependency-home heads, never statements or verdicts.
CREATE TABLE semantic.public_filter_projection_build (
  partition_no integer NOT NULL REFERENCES core.partition(partition_no),
  route integer NOT NULL,
  subject_id uuid NOT NULL,
  meaning_digest text NOT NULL,
  meaning_type text NOT NULL,
  build_id uuid NOT NULL UNIQUE,
  generation bigint NOT NULL CHECK (generation > 0),
  owner_epoch integer NOT NULL CHECK (owner_epoch > 0),
  source_position bigint NOT NULL CHECK (source_position >= 0),
  privacy_position bigint NOT NULL CHECK (privacy_position >= 0),
  terminal_id uuid NOT NULL,
  subject_revision integer NOT NULL CHECK (subject_revision > 0),
  security_revision bigint NOT NULL CHECK (security_revision >= 0),
  current_release text NOT NULL,
  PRIMARY KEY (partition_no, subject_id),
  CHECK (route >= partition_no * 16 AND route < (partition_no + 1) * 16),
  FOREIGN KEY (route, subject_id) REFERENCES semantic.subject(route, subject_id)
);

CREATE TABLE semantic.public_filter_projection_head (
  build_id uuid NOT NULL REFERENCES semantic.public_filter_projection_build(build_id) ON DELETE CASCADE,
  partition_no integer NOT NULL REFERENCES core.partition(partition_no),
  owner_epoch integer NOT NULL CHECK (owner_epoch > 0),
  position bigint NOT NULL CHECK (position >= 0),
  PRIMARY KEY (build_id, partition_no)
);

-- migrate:down
DROP TABLE semantic.public_filter_projection_head;
DROP TABLE semantic.public_filter_projection_build;
