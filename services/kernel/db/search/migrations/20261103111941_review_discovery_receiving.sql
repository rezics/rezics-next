-- migrate:up
CREATE TABLE search.review_discovery_receiving (
  prefix text COLLATE "C" NOT NULL,
  generation bigint NOT NULL,
  index_uuid text NOT NULL,
  incarnation uuid NOT NULL,
  meaning text NOT NULL,
  partition_no integer NOT NULL CHECK (partition_no BETWEEN 0 AND 4095),
  acknowledged bigint NOT NULL DEFAULT 0 CHECK (acknowledged >= 0),
  requested bigint NOT NULL DEFAULT 0 CHECK (requested >= 0),
  through bigint CHECK (through >= acknowledged),
  completed_cut bigint NOT NULL DEFAULT 0 CHECK (completed_cut >= 0),
  native_position bigint CHECK (native_position >= 0),
  status text NOT NULL DEFAULT 'preparing' CHECK (status IN ('preparing','ready','unavailable')),
  pending boolean NOT NULL DEFAULT false,
  claim uuid,
  claim_until timestamptz,
  stage jsonb CHECK (octet_length(stage::text) <= 2097152),
  PRIMARY KEY (prefix,generation,index_uuid,incarnation,meaning,partition_no),
  CHECK ((claim IS NULL) = (claim_until IS NULL))
);
CREATE INDEX review_discovery_receiving_pending ON search.review_discovery_receiving
  (prefix,generation,index_uuid,incarnation,meaning,partition_no) WHERE pending;
CREATE TABLE search.review_discovery_receiving_scan (
  prefix text COLLATE "C" NOT NULL,
  generation bigint NOT NULL,
  index_uuid text NOT NULL,
  incarnation uuid NOT NULL,
  meaning text NOT NULL,
  partition_no integer NOT NULL DEFAULT 0 CHECK (partition_no BETWEEN 0 AND 4095),
  PRIMARY KEY (prefix,generation,index_uuid,incarnation,meaning)
);
-- migrate:down
-- Forward only: unacknowledged removals and exact-target progress survive rollback.
