-- migrate:up
-- Retained owner-private evidence for recovery of one curated Collection from a completed v1 export.
CREATE TABLE library.collection_archive_recovery (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  account_id uuid NOT NULL,
  upload_id uuid NOT NULL,
  request_key text NOT NULL CHECK (octet_length(request_key) BETWEEN 1 AND 1024),
  upload_digest text NOT NULL CHECK (upload_digest ~ '^[0-9a-f]{64}$'),
  manifest jsonb NOT NULL,
  coverage jsonb NOT NULL,
  source_pins jsonb,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('preview','reviewed','applying','complete','partial','cancelled','expired')),
  source_record_count integer NOT NULL CHECK (source_record_count BETWEEN 0 AND 100000),
  source_membership_complete boolean NOT NULL,
  selected_collection_id uuid,
  selected_count integer NOT NULL DEFAULT 0 CHECK (selected_count BETWEEN 0 AND 1000),
  review_id uuid,
  review_epoch bigint NOT NULL DEFAULT 0 CHECK (review_epoch >= 0),
  review_key text,
  review_request_digest text,
  review_digest text,
  review_snapshot jsonb,
  native_collection_id uuid,
  last_added_member_id uuid,
  pin_state text NOT NULL DEFAULT 'none' CHECK (pin_state IN ('none','pending','applied','unsupported')),
  pin_reason text,
  pin_revision bigint,
  pin_after uuid,
  cancel_requested boolean NOT NULL DEFAULT false,
  inflight_action text CHECK (inflight_action IS NULL OR inflight_action IN ('create','member','note','order','pin')),
  inflight_source_id uuid,
  lease_id uuid,
  lease_until timestamptz,
  PRIMARY KEY (route, account_id, upload_id),
  UNIQUE (route, account_id, request_key),
  CHECK (route = (get_byte(uuid_send(account_id),10)*256 + get_byte(uuid_send(account_id),11))),
  CHECK (expires_at = created_at + interval '24 hours'),
  CHECK ((lease_id IS NULL) = (lease_until IS NULL)),
  CHECK ((inflight_action IS NULL AND inflight_source_id IS NULL)
      OR (inflight_action IN ('create','pin') AND inflight_source_id IS NULL)
      OR (inflight_action IN ('member','note','order') AND inflight_source_id IS NOT NULL))
);

CREATE TABLE library.collection_archive_recovery_record (
  route integer NOT NULL,
  account_id uuid NOT NULL,
  upload_id uuid NOT NULL,
  record_kind text NOT NULL CHECK (record_kind IN ('collection','occurrence')),
  collection_id text NOT NULL,
  source_id uuid NOT NULL,
  source_subject_id text,
  title text,
  description text,
  visibility text,
  membership_kind text,
  builtin_kind text,
  presentation_kind text,
  member_count integer NOT NULL DEFAULT 0 CHECK (member_count >= 0),
  ordered_count integer NOT NULL DEFAULT 0 CHECK (ordered_count >= 0),
  order_key text NOT NULL DEFAULT '',
  order_present boolean NOT NULL DEFAULT false,
  note text,
  note_present boolean NOT NULL DEFAULT false,
  note_valid boolean NOT NULL DEFAULT true,
  metadata_valid boolean NOT NULL DEFAULT true,
  review_id uuid,
  selected boolean NOT NULL DEFAULT false,
  target_subject_id text,
  add_state text NOT NULL DEFAULT 'pending' CHECK (add_state IN ('pending','applied','failed','unresolved','unsupported')),
  note_state text NOT NULL DEFAULT 'pending' CHECK (note_state IN ('pending','applied','failed','unsupported')),
  order_state text NOT NULL DEFAULT 'pending' CHECK (order_state IN ('pending','applied','failed','unsupported')),
  outcome_reason text,
  native_member_id uuid,
  PRIMARY KEY (route, account_id, upload_id, record_kind, collection_id, source_id)
);

CREATE INDEX collection_archive_recovery_owner_expiry
  ON library.collection_archive_recovery (route, account_id, expires_at, upload_id);
CREATE INDEX collection_archive_recovery_collection_page
  ON library.collection_archive_recovery_record (route, account_id, upload_id, source_id)
  WHERE record_kind = 'collection';
CREATE INDEX collection_archive_recovery_occurrence_page
  ON library.collection_archive_recovery_record
    (route, account_id, upload_id, collection_id, order_key COLLATE "C", source_id)
  WHERE record_kind = 'occurrence';
CREATE INDEX collection_archive_recovery_selected
  ON library.collection_archive_recovery_record (route, account_id, upload_id, review_id, source_id)
  WHERE record_kind = 'occurrence' AND selected;
CREATE INDEX collection_archive_recovery_selected_order
  ON library.collection_archive_recovery_record
    (route, account_id, upload_id, review_id, collection_id, order_key COLLATE "C", source_id)
  WHERE record_kind = 'occurrence' AND selected;
CREATE INDEX collection_archive_recovery_cleanup
  ON library.collection_archive_recovery_record (route, account_id, upload_id, record_kind, source_id);

-- migrate:down
-- Forward only: accepted private Collections remain native facts after evidence expiry or erasure.
