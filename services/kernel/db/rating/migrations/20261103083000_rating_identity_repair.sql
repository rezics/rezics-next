-- migrate:up
CREATE TABLE rating.identity_work_frame (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  voter_id uuid NOT NULL,
  generation bigint NOT NULL CHECK (generation > 0),
  work_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('active', 'complete', 'cancelled')),
  mode text NOT NULL CHECK (mode IN ('repair', 'withdrawal')),
  cursor jsonb,
  through_key jsonb,
  selected jsonb CHECK (octet_length(selected::text) <= 65536),
  PRIMARY KEY (route, voter_id),
  CHECK (route = get_byte(uuid_send(voter_id), 10) * 256 + get_byte(uuid_send(voter_id), 11))
);

CREATE TABLE rating.identity_repair_receipt (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  voter_id uuid NOT NULL,
  page_id uuid NOT NULL,
  work_id uuid NOT NULL,
  generation bigint NOT NULL CHECK (generation > 0),
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  transaction_id uuid NOT NULL,
  obligation_id text CHECK (octet_length(obligation_id) <= 255),
  mapping_digest text CHECK (mapping_digest ~ '^[0-9a-f]{64}$'),
  CHECK ((mode = 'repair' AND obligation_id IS NOT NULL AND mapping_digest IS NOT NULL)
    OR (mode = 'withdrawal' AND obligation_id IS NULL AND mapping_digest IS NULL)),
  checkpoint jsonb,
  terminal boolean NOT NULL,
  mode text NOT NULL CHECK (mode IN ('repair', 'withdrawal')),
  PRIMARY KEY (route, voter_id, page_id),
  CHECK (route = get_byte(uuid_send(voter_id), 10) * 256 + get_byte(uuid_send(voter_id), 11))
);

-- migrate:down
DROP TABLE rating.identity_repair_receipt;
DROP TABLE rating.identity_work_frame;
