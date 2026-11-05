-- migrate:up
CREATE TYPE core.history_store_kind AS ENUM ('kernel');

-- The open seal is also the producer guard, including for an empty locator prefix.
-- access.erasure has one immutable identity per account: (route, account_id).
CREATE TABLE core.history_seal (
  partition_no integer NOT NULL REFERENCES core.partition (partition_no) CHECK (partition_no BETWEEN 0 AND 4095),
  account_route integer NOT NULL CHECK (account_route BETWEEN 0 AND 65535),
  account_id uuid NOT NULL,
  barrier_id uuid,
  phase text NOT NULL DEFAULT 'open' CHECK (phase IN ('open', 'sealed', 'complete')),
  PRIMARY KEY (partition_no, account_route, account_id),
  FOREIGN KEY (account_route, barrier_id) REFERENCES access.erasure (route, account_id),
  CHECK (account_route = get_byte(uuid_send(account_id), 10) * 256 + get_byte(uuid_send(account_id), 11)),
  CHECK ((phase = 'open' AND barrier_id IS NULL) OR
         (phase <> 'open' AND barrier_id IS NOT NULL AND barrier_id = account_id))
);

CREATE TABLE core.history_locator (
  partition_no integer NOT NULL REFERENCES core.partition (partition_no) CHECK (partition_no BETWEEN 0 AND 4095),
  account_route integer NOT NULL CHECK (account_route BETWEEN 0 AND 65535),
  account_id uuid NOT NULL,
  artifact_type text COLLATE "C" NOT NULL CHECK (artifact_type IN ('command-receipt/v1', 'outbox-event/v1', 'durable-work/v1')),
  locator bytea NOT NULL CHECK (octet_length(locator) BETWEEN 1 AND 256),
  roles integer NOT NULL CHECK (roles BETWEEN 1 AND 63),
  minimizer_version integer NOT NULL CHECK (minimizer_version = 1),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'minimized')),
  proof_barrier uuid,
  PRIMARY KEY (partition_no, account_route, account_id, artifact_type, locator),
  FOREIGN KEY (account_route, proof_barrier) REFERENCES access.erasure (route, account_id),
  CHECK (account_route = get_byte(uuid_send(account_id), 10) * 256 + get_byte(uuid_send(account_id), 11)),
  CHECK ((state = 'pending' AND proof_barrier IS NULL) OR
         (state = 'minimized' AND proof_barrier IS NOT NULL AND proof_barrier = account_id))
);
CREATE INDEX history_locator_pending ON core.history_locator
  (partition_no, account_route, account_id, artifact_type, locator) WHERE state = 'pending';

CREATE TABLE core.history_progress (
  account_route integer NOT NULL CHECK (account_route BETWEEN 0 AND 65535),
  account_id uuid NOT NULL,
  barrier_id uuid NOT NULL,
  store_kind core.history_store_kind NOT NULL,
  partition_no integer NOT NULL REFERENCES core.partition (partition_no) CHECK (partition_no BETWEEN 0 AND 4095),
  partition_epoch integer NOT NULL CHECK (partition_epoch > 0),
  artifact_type text COLLATE "C" CHECK (artifact_type IN ('command-receipt/v1', 'outbox-event/v1', 'durable-work/v1')),
  locator bytea CHECK (octet_length(locator) BETWEEN 1 AND 256),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'complete')),
  proof text CHECK (proof IN ('erased', 'none')),
  PRIMARY KEY (account_route, account_id, barrier_id, store_kind, partition_no),
  FOREIGN KEY (account_route, barrier_id) REFERENCES access.erasure (route, account_id),
  CHECK (barrier_id = account_id),
  CHECK (account_route = get_byte(uuid_send(account_id), 10) * 256 + get_byte(uuid_send(account_id), 11)),
  CHECK ((artifact_type IS NULL) = (locator IS NULL)),
  CHECK ((state = 'pending') = (proof IS NULL))
);

CREATE TABLE core.history_work (
  partition_no integer NOT NULL REFERENCES core.partition (partition_no) CHECK (partition_no BETWEEN 0 AND 4095),
  work_id uuid NOT NULL,
  request_digest bytea NOT NULL CHECK (octet_length(request_digest) = 32),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'ready', 'retired')),
  owner_ready boolean NOT NULL DEFAULT false,
  retired_at timestamptz,
  PRIMARY KEY (partition_no, work_id),
  CHECK (state <> 'ready' OR owner_ready),
  CHECK ((state = 'retired') = (retired_at IS NOT NULL))
);

CREATE FUNCTION core.history_guard_locator() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE guard_phase text;
BEGIN
  INSERT INTO core.history_seal (partition_no, account_route, account_id)
    VALUES (NEW.partition_no, NEW.account_route, NEW.account_id) ON CONFLICT DO NOTHING;
  SELECT phase INTO STRICT guard_phase FROM core.history_seal
    WHERE partition_no = NEW.partition_no AND account_route = NEW.account_route AND account_id = NEW.account_id
    FOR SHARE;
  IF guard_phase <> 'open' THEN
    RAISE EXCEPTION 'history account partition is sealed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER history_locator_guard BEFORE INSERT OR UPDATE OF
  partition_no, account_route, account_id, artifact_type, locator, roles, minimizer_version
  ON core.history_locator FOR EACH ROW EXECUTE FUNCTION core.history_guard_locator();

-- UPDATE of the guard takes the row lock conflicting with every producer's FOR SHARE.
-- Neither deletion nor a phase/key rewrite may reopen a committed seal.
CREATE FUNCTION core.history_preserve_seal() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.phase <> 'open' THEN
      RAISE EXCEPTION 'history seal is irreversible' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF (NEW.partition_no, NEW.account_route, NEW.account_id) IS DISTINCT FROM
     (OLD.partition_no, OLD.account_route, OLD.account_id) OR
     (OLD.phase <> 'open' AND (NEW.barrier_id IS DISTINCT FROM OLD.barrier_id OR NEW.phase = 'open')) OR
     (OLD.phase = 'complete' AND NEW.phase <> 'complete') THEN
    RAISE EXCEPTION 'history seal is irreversible' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER history_seal_preserve BEFORE UPDATE OR DELETE ON core.history_seal
  FOR EACH ROW EXECUTE FUNCTION core.history_preserve_seal();

-- migrate:down
DROP TABLE core.history_work, core.history_progress, core.history_locator, core.history_seal;
DROP FUNCTION core.history_guard_locator(), core.history_preserve_seal();
DROP TYPE core.history_store_kind;
