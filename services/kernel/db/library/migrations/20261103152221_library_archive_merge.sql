-- migrate:up
CREATE TABLE library.library_archive_merge_upload (
  route integer NOT NULL,
  account_id uuid NOT NULL,
  upload_id uuid NOT NULL,
  manifest jsonb NOT NULL CHECK (octet_length(manifest::text) <= 131072),
  coverage jsonb NOT NULL CHECK (octet_length(coverage::text) <= 8192),
  row_count integer NOT NULL CHECK (row_count BETWEEN 0 AND 100000),
  record_bytes integer NOT NULL CHECK (record_bytes BETWEEN 0 AND 33554432),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  cancelled_at timestamptz,
  CONSTRAINT library_archive_merge_upload_pkey PRIMARY KEY (route, account_id),
  UNIQUE (route, account_id, upload_id),
  CONSTRAINT library_archive_merge_upload_route_check CHECK (route BETWEEN 0 AND 65535),
  CONSTRAINT library_archive_merge_upload_account_route_check
    CHECK (route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11))),
  CONSTRAINT library_archive_merge_upload_id_route_check
    CHECK (route = ((get_byte(uuid_send(upload_id), 10) * 256) + get_byte(uuid_send(upload_id), 11)))
);
CREATE INDEX library_archive_merge_upload_expiry
  ON library.library_archive_merge_upload (expires_at, route, account_id);

CREATE TABLE library.library_archive_merge_item (
  route integer NOT NULL,
  account_id uuid NOT NULL,
  upload_id uuid NOT NULL,
  ordinal integer NOT NULL,
  section text NOT NULL,
  source_subject_id uuid,
  source_label_id uuid,
  record_json text NOT NULL,
  status text NOT NULL,
  review jsonb,
  review_revision integer NOT NULL DEFAULT 0,
  native_command_kind text,
  native_request_key text,
  native_operands jsonb,
  result jsonb,
  CONSTRAINT library_archive_merge_item_pkey PRIMARY KEY (route, account_id, upload_id, ordinal),
  CONSTRAINT library_archive_merge_item_ordinal_check CHECK (ordinal BETWEEN 0 AND 99999),
  CONSTRAINT library_archive_merge_item_section_check CHECK (section IN (
    'entries','labels','assignments','sessions','holdings','collections','collectionPins',
    'bangumiUploads','bangumiEvidence','malImports','units','history','occurrences','malEvidence'
  )),
  CONSTRAINT library_archive_merge_item_record_json_check CHECK (octet_length(record_json) <= 120000),
  CONSTRAINT library_archive_merge_item_status_check CHECK (status IN (
    'unresolved','unsupported','create','already_equal','current_conflict','mapped','preserved','applying','acknowledged'
  )),
  CONSTRAINT library_archive_merge_item_review_check CHECK (review IS NULL OR octet_length(review::text) <= 16384),
  CONSTRAINT library_archive_merge_item_review_revision_check CHECK (review_revision >= 0),
  CONSTRAINT library_archive_merge_item_native_command_kind_check
    CHECK (native_command_kind IS NULL OR octet_length(native_command_kind) <= 64),
  CONSTRAINT library_archive_merge_item_native_request_key_check
    CHECK (native_request_key IS NULL OR octet_length(native_request_key) <= 128),
  CONSTRAINT library_archive_merge_item_native_operands_check
    CHECK (native_operands IS NULL OR octet_length(native_operands::text) <= 16384),
  CONSTRAINT library_archive_merge_item_result_check CHECK (result IS NULL OR octet_length(result::text) <= 8192),
  FOREIGN KEY (route, account_id, upload_id)
    REFERENCES library.library_archive_merge_upload (route, account_id, upload_id)
);
CREATE INDEX library_archive_merge_item_source_label
  ON library.library_archive_merge_item (route, account_id, upload_id, source_label_id)
  WHERE section = 'labels';

-- migrate:down
DROP TABLE library.library_archive_merge_item;
DROP TABLE library.library_archive_merge_upload;
