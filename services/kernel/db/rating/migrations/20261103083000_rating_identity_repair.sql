-- migrate:up
CREATE TABLE rating.identity_work_frame (
  route integer NOT NULL,
  voter_id uuid NOT NULL,
  generation bigint NOT NULL,
  work_id uuid NOT NULL,
  state text NOT NULL,
  mode text NOT NULL,
  cursor jsonb,
  through_key jsonb,
  selected jsonb,
  PRIMARY KEY (route, voter_id),
  CONSTRAINT identity_work_frame_route_check CHECK (route BETWEEN 0 AND 65535),
  CONSTRAINT identity_work_frame_generation_check CHECK (generation > 0),
  CONSTRAINT identity_work_frame_state_check CHECK (state IN ('active', 'complete', 'cancelled')),
  CONSTRAINT identity_work_frame_mode_check CHECK (mode IN ('repair', 'withdrawal')),
  CONSTRAINT identity_work_frame_selected_check CHECK (octet_length(jsonb_send(selected)) <= 65537),
  CONSTRAINT identity_work_frame_voter_route_check CHECK
    (route = get_byte(uuid_send(voter_id), 10) * 256 + get_byte(uuid_send(voter_id), 11))
);

CREATE TABLE rating.identity_repair_receipt (
  route integer NOT NULL,
  voter_id uuid NOT NULL,
  page_id uuid NOT NULL,
  work_id uuid NOT NULL,
  generation bigint NOT NULL,
  digest text NOT NULL,
  transaction_id uuid NOT NULL,
  obligation_id text,
  mapping_digest text,
  CONSTRAINT identity_repair_receipt_authority_check CHECK ((mode = 'repair' AND obligation_id IS NOT NULL AND mapping_digest IS NOT NULL)
    OR (mode = 'withdrawal' AND obligation_id IS NULL AND mapping_digest IS NULL)),
  checkpoint jsonb,
  terminal boolean NOT NULL,
  mode text NOT NULL,
  PRIMARY KEY (route, voter_id, page_id),
  CONSTRAINT identity_repair_receipt_route_check CHECK (route BETWEEN 0 AND 65535),
  CONSTRAINT identity_repair_receipt_generation_check CHECK (generation > 0),
  CONSTRAINT identity_repair_receipt_digest_check CHECK (digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT identity_repair_receipt_obligation_id_check CHECK (octet_length(obligation_id) <= 255),
  CONSTRAINT identity_repair_receipt_mapping_digest_check CHECK (mapping_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT identity_repair_receipt_mode_check CHECK (mode IN ('repair', 'withdrawal')),
  CONSTRAINT identity_repair_receipt_voter_route_check CHECK
    (route = get_byte(uuid_send(voter_id), 10) * 256 + get_byte(uuid_send(voter_id), 11))
);

-- migrate:down
DROP TABLE rating.identity_repair_receipt;
DROP TABLE rating.identity_work_frame;
