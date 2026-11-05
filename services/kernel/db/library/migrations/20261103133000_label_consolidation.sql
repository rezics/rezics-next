-- migrate:up
CREATE TABLE library.label_consolidation (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  account_id uuid NOT NULL,
  consolidation_id uuid NOT NULL,
  source_label_id uuid NOT NULL,
  target_label_id uuid NOT NULL,
  source_label_revision integer NOT NULL CHECK (source_label_revision >= 1),
  target_label_revision integer NOT NULL CHECK (target_label_revision >= 1),
  selection_digest text COLLATE "C" NOT NULL CHECK (selection_digest ~ '^[0-9a-f]{64}$'),
  review_evidence jsonb NOT NULL CHECK (jsonb_typeof(review_evidence) = 'object'),
  item_count smallint NOT NULL CHECK (item_count BETWEEN 1 AND 16),
  next_item smallint NOT NULL DEFAULT 0 CHECK (next_item BETWEEN 0 AND 16),
  status text NOT NULL CHECK (status IN ('active', 'completed', 'cancelled')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  terminal_at timestamptz,
  transaction_id uuid NOT NULL,
  PRIMARY KEY (route, account_id, consolidation_id),
  CHECK (source_label_id <> target_label_id),
  CHECK (route = get_byte(uuid_send(account_id), 10) * 256 + get_byte(uuid_send(account_id), 11)),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '15 minutes'),
  CHECK ((status = 'active') = (terminal_at IS NULL))
);

CREATE INDEX label_consolidation_owner_expiry
  ON library.label_consolidation (route, account_id, expires_at, consolidation_id);

CREATE INDEX label_consolidation_expiry_due
  ON library.label_consolidation (route, expires_at, account_id, consolidation_id);

CREATE TABLE library.label_consolidation_item (
  route integer NOT NULL,
  account_id uuid NOT NULL,
  consolidation_id uuid NOT NULL,
  item_no smallint NOT NULL CHECK (item_no BETWEEN 0 AND 15),
  subject_id uuid NOT NULL,
  source_assignment_id uuid NOT NULL,
  source_revision integer NOT NULL CHECK (source_revision >= 1),
  target_assignment_id uuid,
  target_revision integer,
  target_effective boolean,
  target_request_key uuid NOT NULL,
  source_request_key uuid NOT NULL,
  status text NOT NULL CHECK (
    status IN ('pending', 'applying', 'moved', 'target_applied_source_retained', 'capacity_limited', 'changed', 'inaccessible')
  ),
  stage text CHECK (stage IN ('target_pending', 'target_started', 'target_accepted', 'source_started')),
  target_result_id uuid,
  target_result_revision integer,
  target_unchanged boolean,
  source_result_revision integer,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  transaction_id uuid NOT NULL,
  PRIMARY KEY (route, account_id, consolidation_id, item_no),
  UNIQUE (route, account_id, consolidation_id, subject_id),
  FOREIGN KEY (route, account_id, consolidation_id)
    REFERENCES library.label_consolidation (route, account_id, consolidation_id) ON DELETE CASCADE,
  CHECK ((target_assignment_id IS NULL) = (target_revision IS NULL)),
  CHECK ((target_assignment_id IS NULL) = (target_effective IS NULL)),
  CHECK ((status = 'applying') = (stage IS NOT NULL)),
  CHECK ((target_result_id IS NULL) = (target_result_revision IS NULL)),
  CHECK (target_result_revision IS NULL OR target_result_revision >= 1),
  CHECK (source_result_revision IS NULL OR source_result_revision >= 1)
);

CREATE INDEX label_consolidation_item_due
  ON library.label_consolidation_item (route, account_id, consolidation_id, status, item_no);

-- migrate:down
-- Forward only: original operation identities and confirmation evidence are finite but must not be replayed away.
