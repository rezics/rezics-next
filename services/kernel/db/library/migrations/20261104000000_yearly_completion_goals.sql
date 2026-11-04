-- migrate:up
-- One target fence per owner and reported Gregorian year. A cleared target keeps its
-- revision row so a stale edit cannot recreate a target after an intervening clear.
CREATE TABLE library.yearly_completion_goal (
  route integer NOT NULL,
  account_id uuid NOT NULL,
  year integer NOT NULL CHECK (year BETWEEN 1 AND 9999),
  target integer CHECK (target BETWEEN 1 AND 1000),
  revision bigint NOT NULL CHECK (revision > 0),
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (route, account_id, year)
);

-- migrate:down
DROP TABLE library.yearly_completion_goal;
