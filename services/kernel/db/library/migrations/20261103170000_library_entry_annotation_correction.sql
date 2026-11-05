-- migrate:up
CREATE TABLE library.entry_annotation_review (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  account_id uuid NOT NULL,
  review_id uuid NOT NULL,
  epoch uuid NOT NULL,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','confirmed','cancelled','expired')),
  item_count smallint NOT NULL CHECK (item_count BETWEEN 1 AND 16),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  purge_after timestamptz NOT NULL,
  PRIMARY KEY (route, account_id, review_id),
  UNIQUE (route, account_id, epoch),
  CHECK (route = get_byte(uuid_send(account_id), 10) * 256 + get_byte(uuid_send(account_id), 11)),
  CHECK (route = get_byte(uuid_send(review_id), 10) * 256 + get_byte(uuid_send(review_id), 11)),
  CHECK (route = get_byte(uuid_send(epoch), 10) * 256 + get_byte(uuid_send(epoch), 11)),
  CHECK (expires_at = created_at + interval '15 minutes'),
  CHECK (purge_after = expires_at + interval '15 minutes')
);

CREATE INDEX entry_annotation_review_due
  ON library.entry_annotation_review(route, purge_after, account_id, review_id);
CREATE INDEX entry_annotation_review_owner_expiry
  ON library.entry_annotation_review(route, account_id, expires_at, review_id);
CREATE INDEX entry_annotation_review_owner_retention
  ON library.entry_annotation_review(route, account_id, purge_after, review_id);

CREATE TABLE library.entry_annotation_review_item (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  account_id uuid NOT NULL,
  review_id uuid NOT NULL,
  position smallint NOT NULL CHECK (position BETWEEN 0 AND 15),
  subject_id uuid NOT NULL,
  entry_incarnation_id uuid NOT NULL,
  entry_revision integer NOT NULL CHECK (entry_revision BETWEEN 1 AND 2147483646),
  annotation_revision integer CHECK (annotation_revision BETWEEN 0 AND 2147483646),
  note_op text NOT NULL CHECK (note_op IN ('preserve','set','clear')),
  note_value text,
  priority_op text NOT NULL CHECK (priority_op IN ('preserve','set','clear')),
  priority_value smallint,
  preview_state text NOT NULL CHECK (preview_state IN ('ready','stale','unavailable')),
  outcome text CHECK (outcome IS NULL OR outcome IN ('accepted','unchanged','stale','unavailable','not-started')),
  request_id uuid NOT NULL,
  PRIMARY KEY (route, account_id, review_id, position),
  UNIQUE (route, account_id, review_id, subject_id),
  UNIQUE (route, account_id, request_id),
  FOREIGN KEY (route, account_id, review_id)
    REFERENCES library.entry_annotation_review(route, account_id, review_id) ON DELETE CASCADE,
  CHECK (route = get_byte(uuid_send(account_id), 10) * 256 + get_byte(uuid_send(account_id), 11)),
  CHECK (route = get_byte(uuid_send(review_id), 10) * 256 + get_byte(uuid_send(review_id), 11)),
  CHECK (route = get_byte(uuid_send(entry_incarnation_id), 10) * 256 + get_byte(uuid_send(entry_incarnation_id), 11)),
  CHECK (route = get_byte(uuid_send(request_id), 10) * 256 + get_byte(uuid_send(request_id), 11)),
  CHECK ((note_op = 'set' AND note_value IS NOT NULL AND octet_length(note_value) BETWEEN 1 AND 4096)
    OR (note_op IN ('preserve','clear') AND note_value IS NULL)),
  CHECK ((priority_op = 'set' AND priority_value IS NOT NULL AND priority_value BETWEEN 1 AND 100)
    OR (priority_op IN ('preserve','clear') AND priority_value IS NULL))
);

COMMENT ON TABLE library.entry_annotation_review IS
  'Finite private owner review state for exact selected entry annotation corrections. The owner and epoch bind selection and receipt identities; expiry and terminal erasure remove the bounded composition.';
COMMENT ON TABLE library.entry_annotation_review_item IS
  'At most sixteen fixed selected operands per private review. Set note bytes obey the native 4096-byte limit; item writes use the existing annotation command receipt.';

-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'Private review state requires an explicit fenced retirement'; END $$;
