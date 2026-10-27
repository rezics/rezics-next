-- migrate:up
-- Existing writers leave these fields null until the shelf writer/backfill cutover.
ALTER TABLE library.entry
  ADD COLUMN activity_at timestamptz,
  ADD COLUMN finished_at timestamptz,
  ADD COLUMN type_id uuid,
  ADD COLUMN type_source_id uuid,
  ADD COLUMN type_source_partition integer,
  ADD COLUMN type_source_epoch integer,
  ADD COLUMN type_source_position bigint,
  ADD COLUMN incarnation_id uuid,
  ADD CONSTRAINT entry_type_observation_check CHECK (
    (
      type_id IS NULL
      AND type_source_id IS NULL
      AND type_source_partition IS NULL
      AND type_source_epoch IS NULL
      AND type_source_position IS NULL
    )
    OR (
      type_id IS NOT NULL
      AND type_source_id IS NOT NULL
      AND type_source_partition IS NOT NULL
      AND type_source_epoch IS NOT NULL
      AND type_source_position IS NOT NULL
      AND type_source_partition BETWEEN 0 AND 4095
      AND type_source_epoch >= 1
      AND type_source_position >= 0
      AND type_source_partition = (
        (get_byte(uuid_send(type_source_id), 10) * 256 + get_byte(uuid_send(type_source_id), 11)) >> 4
      )
    )
  );

ALTER TABLE library.progress_session ADD COLUMN last_changed_at timestamptz;

CREATE TABLE library.progress_head (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  account_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  last_changed_at timestamptz,
  last_completed_at timestamptz,
  PRIMARY KEY (route, account_id, subject_id),
  CHECK (route = get_byte(uuid_send(account_id), 10) * 256 + get_byte(uuid_send(account_id), 11))
);

CREATE TABLE library.shelf_count (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  account_id uuid NOT NULL,
  bucket text NOT NULL CHECK (bucket IN ('planned', 'in_progress', 'completed', 'paused', 'dropped', 'all', 'collections')),
  type_id uuid NOT NULL,
  n bigint NOT NULL CHECK (n >= 0),
  PRIMARY KEY (route, account_id, bucket, type_id),
  CHECK (route = get_byte(uuid_send(account_id), 10) * 256 + get_byte(uuid_send(account_id), 11)),
  CHECK (bucket <> 'collections' OR type_id = '00000000-0000-0000-0000-000000000000'::uuid)
);

-- Each index also serves the exact reverse order by scanning backward.
CREATE INDEX entry_shelf_activity
  ON library.entry (route, account_id, activity_at DESC, subject_id ASC);
CREATE INDEX entry_shelf_activity_state
  ON library.entry (route, account_id, state, activity_at DESC, subject_id ASC);
CREATE INDEX entry_shelf_activity_type
  ON library.entry (route, account_id, type_id, activity_at DESC, subject_id ASC);
CREATE INDEX entry_shelf_activity_state_type
  ON library.entry (route, account_id, state, type_id, activity_at DESC, subject_id ASC);

CREATE INDEX entry_shelf_finished
  ON library.entry (route, account_id, finished_at DESC NULLS LAST, subject_id ASC);
CREATE INDEX entry_shelf_finished_state
  ON library.entry (route, account_id, state, finished_at DESC NULLS LAST, subject_id ASC);
CREATE INDEX entry_shelf_finished_type
  ON library.entry (route, account_id, type_id, finished_at DESC NULLS LAST, subject_id ASC);
CREATE INDEX entry_shelf_finished_state_type
  ON library.entry (route, account_id, state, type_id, finished_at DESC NULLS LAST, subject_id ASC);

CREATE INDEX entry_shelf_created
  ON library.entry (route, account_id, created_at DESC, subject_id ASC);
CREATE INDEX entry_shelf_created_state
  ON library.entry (route, account_id, state, created_at DESC, subject_id ASC);
CREATE INDEX entry_shelf_created_type
  ON library.entry (route, account_id, type_id, created_at DESC, subject_id ASC);
CREATE INDEX entry_shelf_created_state_type
  ON library.entry (route, account_id, state, type_id, created_at DESC, subject_id ASC);

-- Secondary holder discovery only; the authoritative entry key remains owner-scoped.
CREATE INDEX entry_type_source
  ON library.entry (type_source_id, route, account_id, subject_id);

CREATE INDEX progress_session_active
  ON library.progress_session (route, account_id, subject_id, last_changed_at DESC, session_id ASC)
  WHERE state = 'active';

CREATE INDEX shelf_count_types
  ON library.shelf_count (route, account_id, type_id)
  WHERE bucket = 'all' AND type_id <> '00000000-0000-0000-0000-000000000000'::uuid AND n > 0;

-- migrate:down
-- Forward only: private shelf heads and counters must not be discarded by rollback.
