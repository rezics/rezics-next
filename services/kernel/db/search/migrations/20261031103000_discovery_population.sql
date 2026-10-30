-- migrate:up
-- Only native keys and versions are retained here; public text belongs exclusively to the engine.
CREATE TABLE search.discovery_generation (
  partition_no integer NOT NULL DEFAULT 0 CHECK (partition_no = 0),
  prefix text COLLATE "C" NOT NULL,
  generation bigint NOT NULL CHECK (generation > 0),
  index_uuid text COLLATE "C",
  incarnation uuid NOT NULL,
  kinds text[] NOT NULL,
  state text NOT NULL CHECK (state IN ('allocated','populating','replaying','reconciling','ready','active','retiring','retired','quarantined')),
  activated_at timestamptz,
  PRIMARY KEY (partition_no,prefix,generation)
);
CREATE TABLE search.discovery_population (
  partition_no integer NOT NULL CHECK (partition_no BETWEEN 0 AND 4095),
  prefix text COLLATE "C" NOT NULL,
  generation bigint NOT NULL,
  owner text NOT NULL CHECK (owner IN ('accounts','semantic')),
  after_route integer,
  after_id uuid,
  complete boolean NOT NULL DEFAULT false,
  certified boolean NOT NULL DEFAULT false,
  indexed bigint NOT NULL DEFAULT 0,
  census bigint NOT NULL DEFAULT 0,
  reconcile_position bigint,
  position bigint NOT NULL DEFAULT 0 CHECK (position >= 0),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  claim_revision bigint NOT NULL DEFAULT 0 CHECK (claim_revision >= 0),
  PRIMARY KEY (partition_no,prefix,generation,owner),
  CHECK ((after_route IS NULL) = (after_id IS NULL)),
  CHECK (after_route IS NULL OR after_route / 16 = partition_no)
);
CREATE INDEX discovery_population_pending ON search.discovery_population(prefix,generation,partition_no,owner)
WHERE NOT complete;
-- A permanent per-key high water protects native deletes after engine tombstone pruning.
-- Account rows also locate all active/building/retiring physical copies for the erasure participant.
CREATE TABLE search.discovery_copy (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  source_id uuid NOT NULL,
  prefix text COLLATE "C" NOT NULL,
  generation bigint NOT NULL,
  kind text COLLATE "C" NOT NULL,
  position bigint NOT NULL DEFAULT 0 CHECK (position >= 0),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  deleted boolean NOT NULL DEFAULT false,
  settled boolean NOT NULL DEFAULT false,
  PRIMARY KEY (route,source_id,prefix,generation,kind),
  CHECK (route = get_byte(uuid_send(source_id),10)*256 + get_byte(uuid_send(source_id),11))
);
CREATE INDEX discovery_copy_generation ON search.discovery_copy(prefix,generation,route,source_id,kind);
-- Participant progress survives bounded copy pages and replay; it never stores profile text.
CREATE TABLE search.discovery_erasure (
  route integer NOT NULL,
  account_id uuid NOT NULL,
  PRIMARY KEY(route,account_id),
  CHECK (route = get_byte(uuid_send(account_id),10)*256 + get_byte(uuid_send(account_id),11))
);
-- migrate:down
-- Forward only: physical locators and deletion high water survive binary rollback.
