-- migrate:up
-- Keep one opaque revision fence for every owner/Subject that has ever saved a checkpoint.
-- Existing checkpoints retain their current write token across migration.
CREATE TABLE library.hosted_reading_fence (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  account_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision >= 0),
  PRIMARY KEY (route, account_id, subject_id),
  CONSTRAINT hosted_reading_fence_account_route_check
    CHECK (route = get_byte(uuid_send(account_id), 10) * 256 + get_byte(uuid_send(account_id), 11))
);

INSERT INTO library.hosted_reading_fence (route, account_id, subject_id, revision)
SELECT route, account_id, subject_id, revision
FROM library.hosted_reading;

-- migrate:down
DROP TABLE library.hosted_reading_fence;
