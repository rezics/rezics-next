-- migrate:up
CREATE SCHEMA IF NOT EXISTS rating;

CREATE TABLE rating.question (
  id uuid PRIMARY KEY,
  owner_id uuid,
  revision integer NOT NULL CHECK (revision >= 1),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 200),
  grain text NOT NULL CHECK (grain IN ('work', 'release', 'episode', 'character')),
  minimum_units integer NOT NULL,
  maximum_units integer NOT NULL,
  step_units integer NOT NULL,
  CHECK (minimum_units >= 0 AND maximum_units >= minimum_units AND step_units > 0),
  CHECK ((maximum_units - minimum_units) % step_units = 0)
);

INSERT INTO rating.question (id, owner_id, revision, label, grain, minimum_units, maximum_units, step_units)
VALUES ('00000000-0000-7000-8000-000000000001', NULL, 1, 'How much did you like this work?', 'work', 0, 20, 1);

CREATE TABLE rating.vote (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  voter_id uuid NOT NULL,
  question_id uuid NOT NULL REFERENCES rating.question (id),
  target_id uuid NOT NULL,
  units integer CHECK (units IS NULL OR units BETWEEN 0 AND 20),
  revision integer NOT NULL CHECK (revision >= 1),
  changed_at timestamptz NOT NULL,
  transaction_id uuid NOT NULL,
  PRIMARY KEY (route, voter_id, question_id, target_id),
  CHECK (route = get_byte(uuid_send(voter_id), 10) * 256 + get_byte(uuid_send(voter_id), 11))
);

-- migrate:down
-- Forward only: native votes and their history must not be discarded by rollback.
