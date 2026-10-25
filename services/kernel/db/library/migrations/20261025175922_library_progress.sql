-- migrate:up
CREATE SCHEMA IF NOT EXISTS library;

CREATE TABLE library.progress_session (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  session_id uuid NOT NULL,
  account_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  version_subject_id uuid,
  mode text NOT NULL CHECK (mode IN ('scalar_amount', 'cursor_position', 'completed_units')),
  unit text NOT NULL CHECK (unit IN ('page', 'chapter', 'episode', 'volume', 'minute', 'percent')),
  total numeric,
  amount numeric,
  locator text,
  position numeric,
  completed_unit_count integer NOT NULL CHECK (completed_unit_count BETWEEN 0 AND 20000),
  state text NOT NULL CHECK (state IN ('active', 'completed', 'abandoned')),
  revision integer NOT NULL CHECK (revision >= 1),
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  transaction_id uuid NOT NULL,
  PRIMARY KEY (route, session_id),
  CHECK (route = get_byte(uuid_send(session_id), 10) * 256 + get_byte(uuid_send(session_id), 11)),
  CHECK (route = get_byte(uuid_send(account_id), 10) * 256 + get_byte(uuid_send(account_id), 11)),
  CHECK (locator IS NULL OR char_length(locator) BETWEEN 1 AND 256),
  CHECK (amount IS NULL OR amount >= 0),
  CHECK (position IS NULL OR position >= 0),
  CHECK (total IS NULL OR total >= 0),
  CHECK (
    unit <> 'percent'
    OR ((amount IS NULL OR amount <= 100) AND (total IS NULL OR total <= 100))
  ),
  CHECK ((state = 'completed') = (completed_at IS NOT NULL)),
  CHECK (
    (
      mode = 'scalar_amount'
      AND locator IS NULL
      AND position IS NULL
      AND completed_unit_count = 0
    )
    OR (
      mode = 'cursor_position'
      AND amount IS NULL
      AND total IS NULL
      AND completed_unit_count = 0
      AND (
        (locator IS NULL AND position IS NULL)
        OR (locator IS NOT NULL AND position IS NOT NULL)
      )
    )
    OR (
      mode = 'completed_units'
      AND amount IS NULL
      AND total IS NULL
      AND locator IS NULL
      AND position IS NULL
    )
  )
);

CREATE INDEX progress_session_account_subject
  ON library.progress_session (route, account_id, subject_id, started_at DESC, session_id);

CREATE TABLE library.progress_unit (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  session_id uuid NOT NULL,
  unit_id text NOT NULL CHECK (char_length(unit_id) BETWEEN 1 AND 128),
  added_at timestamptz NOT NULL,
  PRIMARY KEY (route, session_id, unit_id),
  FOREIGN KEY (route, session_id) REFERENCES library.progress_session (route, session_id),
  CHECK (route = get_byte(uuid_send(session_id), 10) * 256 + get_byte(uuid_send(session_id), 11))
);

CREATE TABLE library.progress_change (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  session_id uuid NOT NULL,
  change_no integer NOT NULL CHECK (change_no >= 1),
  intent jsonb NOT NULL,
  recorded_at timestamptz NOT NULL,
  transaction_id uuid NOT NULL,
  PRIMARY KEY (route, session_id, change_no),
  FOREIGN KEY (route, session_id) REFERENCES library.progress_session (route, session_id),
  CHECK (route = get_byte(uuid_send(session_id), 10) * 256 + get_byte(uuid_send(session_id), 11))
);

-- migrate:down
-- Forward only: reading and viewing progress must not be discarded by rollback.
