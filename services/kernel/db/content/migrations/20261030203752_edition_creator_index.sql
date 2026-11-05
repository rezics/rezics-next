-- migrate:up
-- Candidate locator only. Metadata and all current disclosure stay at the original edition home.
CREATE TABLE content.creator_edition (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  creator_account_id uuid NOT NULL,
  edition_id uuid NOT NULL,
  PRIMARY KEY (route, creator_account_id, edition_id),
  CHECK (route = get_byte(uuid_send(creator_account_id), 10) * 256 + get_byte(uuid_send(creator_account_id), 11))
);

-- migrate:down
DROP TABLE content.creator_edition;
