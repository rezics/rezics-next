-- migrate:up
-- Page witnesses commit with source-vote deletion. They are removed only after
-- every destination command commits; terminal witnesses retain prior-vote evidence.
CREATE TABLE rating.erasure_page (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  voter_id uuid NOT NULL,
  page_id uuid NOT NULL,
  terminal boolean NOT NULL,
  had_votes boolean NOT NULL DEFAULT false,
  PRIMARY KEY (route, voter_id, page_id),
  CHECK (route = get_byte(uuid_send(voter_id), 10) * 256 + get_byte(uuid_send(voter_id), 11))
);
CREATE INDEX erasure_page_pending_idx ON rating.erasure_page (route, voter_id, page_id) WHERE NOT terminal;

-- migrate:down
-- Forward only: outstanding removals and prior-vote evidence must survive replay.
