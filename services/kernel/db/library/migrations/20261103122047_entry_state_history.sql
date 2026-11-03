-- migrate:up
CREATE TABLE library.entry_state_change (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  account_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  incarnation_id uuid NOT NULL,
  prior_revision integer,
  revision integer NOT NULL CHECK (revision BETWEEN 1 AND 2147483644),
  before_state text,
  before_profile_pin jsonb,
  after_state text NOT NULL,
  after_profile_pin jsonb,
  command_id uuid NOT NULL,
  command_kind text NOT NULL CHECK (command_kind IN ('library.entry.put', 'library.entry.state.restore')),
  changed_at timestamptz NOT NULL,
  coverage_complete boolean NOT NULL,
  PRIMARY KEY (route, account_id, subject_id, incarnation_id, revision),
  CHECK (route = get_byte(uuid_send(account_id), 10) * 256 + get_byte(uuid_send(account_id), 11)),
  CHECK (
    (prior_revision IS NULL AND revision = 1 AND before_state IS NULL AND before_profile_pin IS NULL)
    OR
    (prior_revision IS NOT NULL AND prior_revision >= 1 AND revision = prior_revision + 1 AND before_state IS NOT NULL)
  ),
  CHECK (before_profile_pin IS NULL OR library.library_profile_pin_valid(before_profile_pin)),
  CHECK (after_profile_pin IS NULL OR library.library_profile_pin_valid(after_profile_pin))
);

CREATE INDEX entry_state_change_account_subject
  ON library.entry_state_change (route, account_id, subject_id, incarnation_id, revision DESC);
CREATE INDEX entry_state_change_subject_retention
  ON library.entry_state_change (route, account_id, subject_id, changed_at DESC, incarnation_id, revision DESC);

-- migrate:down
-- Forward only: state history is private evidence and is not discarded by rollback.
