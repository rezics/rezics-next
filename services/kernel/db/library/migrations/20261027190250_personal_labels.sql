-- migrate:up
CREATE TABLE library.personal_label (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  account_id uuid NOT NULL,
  label_id uuid NOT NULL,
  normalized_name text COLLATE "C" NOT NULL CHECK (char_length(normalized_name) BETWEEN 1 AND 100),
  revision integer NOT NULL CHECK (revision >= 1),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  transaction_id uuid NOT NULL,
  deleted_at timestamptz,
  purge_after timestamptz,
  PRIMARY KEY (route, account_id, label_id),
  CHECK (route = get_byte(uuid_send(account_id), 10) * 256 + get_byte(uuid_send(account_id), 11)),
  CHECK ((deleted_at IS NULL) = (purge_after IS NULL)),
  CHECK (purge_after = deleted_at + interval '720 hours')
);

-- Deleted names can be reused; restoring a conflicting name fails without replacing its new owner.
CREATE UNIQUE INDEX personal_label_live_name
  ON library.personal_label (route, account_id, normalized_name)
  WHERE deleted_at IS NULL;

CREATE INDEX personal_label_purge_due
  ON library.personal_label (route, purge_after, account_id, label_id)
  WHERE deleted_at IS NOT NULL;

CREATE TABLE library.label_assignment (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  account_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  label_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision >= 1),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  transaction_id uuid NOT NULL,
  deleted_at timestamptz,
  purge_after timestamptz,
  PRIMARY KEY (route, account_id, subject_id, label_id),
  FOREIGN KEY (route, account_id, label_id)
    REFERENCES library.personal_label (route, account_id, label_id) ON DELETE NO ACTION,
  CHECK (route = get_byte(uuid_send(account_id), 10) * 256 + get_byte(uuid_send(account_id), 11)),
  CHECK ((deleted_at IS NULL) = (purge_after IS NULL)),
  CHECK (purge_after = deleted_at + interval '720 hours')
);

CREATE INDEX label_assignment_owner_label
  ON library.label_assignment (route, account_id, label_id, subject_id);

CREATE INDEX label_assignment_purge_due
  ON library.label_assignment (route, purge_after, account_id, subject_id, label_id)
  WHERE deleted_at IS NOT NULL;

-- These keys prepare future bounded cleanup; no purge worker or legal-hold policy is installed here.
-- migrate:down
-- Forward only: private labels and assignments must not be discarded by rollback.
