-- migrate:up
-- Independent snapshots preserve the complete persisted fact, not the public Entry DTO.
-- The future delete writer supplies the actual incarnation and native transaction ID.
CREATE TABLE library.entry_deleted (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  account_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  requested_subject_id uuid,
  state text NOT NULL,
  revision integer NOT NULL CHECK (revision BETWEEN 1 AND 2147483644),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  transaction_id uuid NOT NULL,
  activity_at timestamptz,
  finished_at timestamptz,
  type_id uuid,
  type_source_id uuid,
  type_source_partition integer,
  type_source_epoch integer,
  type_source_position bigint,
  incarnation_id uuid NOT NULL,
  library_profile_pin jsonb,
  -- A deletion locator has no routability requirement of its own.
  deletion_id uuid NOT NULL,
  deleted_revision integer NOT NULL,
  deleted_at timestamptz NOT NULL,
  restore_until timestamptz NOT NULL,
  partition_no integer GENERATED ALWAYS AS (route >> 4) STORED,
  PRIMARY KEY (route, account_id, deletion_id),
  CHECK (route = get_byte(uuid_send(account_id), 10) * 256 + get_byte(uuid_send(account_id), 11)),
  CONSTRAINT entry_deleted_revision_step CHECK (deleted_revision = revision + 1),
  CONSTRAINT entry_deleted_restore_window CHECK (restore_until = deleted_at + interval '720 hours'),
  CONSTRAINT entry_deleted_library_profile_pin_check CHECK (
    library_profile_pin IS NULL OR library.library_profile_pin_valid(library_profile_pin)
  ),
  CONSTRAINT entry_deleted_legacy_state_check CHECK (
    library_profile_pin IS NOT NULL OR state IN ('planned', 'in_progress', 'completed', 'paused', 'dropped')
  ),
  CONSTRAINT entry_deleted_type_observation_check CHECK (
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
  )
);

-- Access paths only: future bounded source selection must separately check current holds and authority.
CREATE INDEX entry_deleted_due
  ON library.entry_deleted (partition_no, restore_until, route, account_id, deletion_id);

-- migrate:down
-- Forward only: retained private snapshots must survive rollback.
