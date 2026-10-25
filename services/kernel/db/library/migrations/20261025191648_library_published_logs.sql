-- migrate:up
CREATE TABLE library.published_log (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  log_id uuid NOT NULL,
  account_id uuid NOT NULL,
  session_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  session_state text NOT NULL CHECK (session_state IN ('active', 'completed', 'abandoned')),
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  note text,
  published_at timestamptz NOT NULL,
  transaction_id uuid NOT NULL,
  PRIMARY KEY (route, log_id),
  CHECK (route = get_byte(uuid_send(log_id), 10) * 256 + get_byte(uuid_send(log_id), 11)),
  CHECK (route = get_byte(uuid_send(account_id), 10) * 256 + get_byte(uuid_send(account_id), 11)),
  CHECK (route = get_byte(uuid_send(session_id), 10) * 256 + get_byte(uuid_send(session_id), 11)),
  CHECK (note IS NULL OR char_length(note) BETWEEN 0 AND 1000),
  CHECK ((session_state = 'completed') = (completed_at IS NOT NULL))
);

CREATE INDEX published_log_account_page
  ON library.published_log (route, account_id, published_at DESC, log_id);

-- migrate:down
-- Forward only: a published reading snapshot must not be discarded by rollback.
