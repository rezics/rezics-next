-- migrate:up
ALTER TABLE access.erasure ADD COLUMN frontier jsonb;
ALTER TABLE access.erasure ADD COLUMN workflow_until bigint;
ALTER TABLE access.erasure ADD CONSTRAINT erasure_frontier_check
  CHECK (frontier IS NULL OR jsonb_typeof(frontier) = 'array');

CREATE TABLE access.erasure_late_item (
  route integer NOT NULL,
  account_id uuid NOT NULL,
  participant text NOT NULL,
  locator text NOT NULL CHECK (locator COLLATE "C" ~ '^[ -~]{1,255}$'),
  resolved_at timestamptz,
  PRIMARY KEY (route, account_id, participant, locator),
  FOREIGN KEY (route, account_id) REFERENCES access.erasure (route, account_id)
);
CREATE INDEX erasure_late_item_open ON access.erasure_late_item (route, account_id)
  WHERE resolved_at IS NULL;

-- migrate:down
DROP TABLE access.erasure_late_item;
ALTER TABLE access.erasure DROP CONSTRAINT erasure_frontier_check;
ALTER TABLE access.erasure DROP COLUMN workflow_until;
ALTER TABLE access.erasure DROP COLUMN frontier;
