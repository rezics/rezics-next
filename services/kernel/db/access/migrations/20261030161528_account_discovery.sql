-- migrate:up
-- The install cut excludes every Account/claim/preferences writer until the census,
-- existing row revisions and hooks are installed in this migration transaction.
LOCK TABLE access.account, access.handle_claim, access.account_preferences IN ACCESS EXCLUSIVE MODE;

CREATE SEQUENCE access.account_discovery_revision AS bigint NO CYCLE;
ALTER TABLE access.account ADD COLUMN discovery_revision bigint NOT NULL DEFAULT 0;
ALTER TABLE access.handle_claim ADD COLUMN discovery_revision bigint NOT NULL DEFAULT 0;

CREATE TABLE access.account_discovery_population (
  partition_no integer PRIMARY KEY CHECK (partition_no BETWEEN 0 AND 4095),
  population bigint NOT NULL CHECK (population >= 0),
  revision bigint NOT NULL,
  claim_revision bigint NOT NULL
);
INSERT INTO access.account_discovery_population
SELECT p, 0, nextval('access.account_discovery_revision'), nextval('access.account_discovery_revision')
FROM generate_series(0, 4095) p;
UPDATE access.account SET discovery_revision = nextval('access.account_discovery_revision');
UPDATE access.handle_claim SET discovery_revision = nextval('access.account_discovery_revision');
UPDATE access.account_discovery_population p SET population = c.n
FROM (SELECT route >> 4 AS partition_no, count(*) AS n FROM access.account
      WHERE state = 'active' AND NOT authn_fenced GROUP BY route >> 4) c
WHERE p.partition_no = c.partition_no;

-- One coalescing source intent per Account key on each native anchor. No public
-- profile/text copies, receipts or history. The worker acknowledges only an exact
-- revision, so a concurrent writer cannot lose a newer obligation.
CREATE TABLE access.account_discovery_intent (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  account_id uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  PRIMARY KEY (route, account_id)
);
CREATE INDEX account_discovery_intent_account ON access.account_discovery_intent(account_id, route);
CREATE TABLE access.account_discovery_claim_intent (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  account_id uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  PRIMARY KEY (route, account_id)
);
CREATE INDEX account_discovery_claim_intent_account ON access.account_discovery_claim_intent(account_id, route);
CREATE TABLE access.account_discovery_claim_cursor (
  route integer NOT NULL,
  account_id uuid NOT NULL,
  claim_partition integer NOT NULL CHECK (claim_partition BETWEEN 0 AND 4095),
  revision bigint NOT NULL CHECK (revision > 0),
  PRIMARY KEY (route, account_id, claim_partition),
  FOREIGN KEY (route, account_id) REFERENCES access.account(route, account_id) ON DELETE CASCADE
);
INSERT INTO access.account_discovery_intent SELECT route, account_id, discovery_revision FROM access.account;
INSERT INTO access.account_discovery_claim_intent
SELECT route, account_id, max(discovery_revision) FROM access.handle_claim GROUP BY route, account_id;

CREATE FUNCTION access.account_discovery_before() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p integer;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.route, NEW.account_id) IS DISTINCT FROM (OLD.route, OLD.account_id) THEN
    RAISE EXCEPTION 'Account discovery source keys are immutable';
  END IF;
  p := CASE WHEN TG_OP = 'DELETE' THEN OLD.route >> 4 ELSE NEW.route >> 4 END;
  -- Serialize allocation with the native head; a late commit must advance it too.
  PERFORM 1 FROM access.account_discovery_population WHERE partition_no = p FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Account discovery census is not installed'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  NEW.discovery_revision := nextval('access.account_discovery_revision');
  RETURN NEW;
END $$;
CREATE FUNCTION access.account_discovery_after() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r integer; a uuid; v bigint; delta integer := 0;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    IF OLD.state = 'active' AND NOT OLD.authn_fenced THEN delta := delta - 1; END IF;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    IF NEW.state = 'active' AND NOT NEW.authn_fenced THEN delta := delta + 1; END IF;
    r := NEW.route; a := NEW.account_id; v := NEW.discovery_revision;
  ELSE
    r := OLD.route; a := OLD.account_id; v := nextval('access.account_discovery_revision');
  END IF;
  UPDATE access.account_discovery_population SET population = population + delta, revision = v WHERE partition_no = r >> 4;
  INSERT INTO access.account_discovery_intent VALUES (r, a, v)
    ON CONFLICT (route, account_id) DO UPDATE SET revision = EXCLUDED.revision;
  IF TG_OP = 'DELETE' OR NEW.state = 'deleted' THEN
    DELETE FROM access.account_discovery_claim_cursor WHERE route = r AND account_id = a;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER account_discovery_before BEFORE INSERT OR UPDATE OR DELETE ON access.account
FOR EACH ROW EXECUTE FUNCTION access.account_discovery_before();
CREATE TRIGGER account_discovery_after AFTER INSERT OR UPDATE OR DELETE ON access.account
FOR EACH ROW EXECUTE FUNCTION access.account_discovery_after();

CREATE FUNCTION access.account_discovery_claim_before() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p integer;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.route, NEW.normalized_handle) IS DISTINCT FROM (OLD.route, OLD.normalized_handle) THEN
    RAISE EXCEPTION 'Account discovery claim keys are immutable';
  END IF;
  p := CASE WHEN TG_OP = 'DELETE' THEN OLD.route >> 4 ELSE NEW.route >> 4 END;
  PERFORM 1 FROM access.account_discovery_population WHERE partition_no = p FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Account discovery census is not installed'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  NEW.discovery_revision := nextval('access.account_discovery_revision');
  RETURN NEW;
END $$;
CREATE FUNCTION access.account_discovery_claim_after() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r integer; v bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD.route; v := nextval('access.account_discovery_revision');
  ELSE r := NEW.route; v := NEW.discovery_revision; END IF;
  UPDATE access.account_discovery_population SET claim_revision = v WHERE partition_no = r >> 4;
  IF TG_OP <> 'INSERT' THEN
    INSERT INTO access.account_discovery_claim_intent VALUES (r, OLD.account_id, v)
      ON CONFLICT (route, account_id) DO UPDATE SET revision = EXCLUDED.revision;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    INSERT INTO access.account_discovery_claim_intent VALUES (r, NEW.account_id, v)
      ON CONFLICT (route, account_id) DO UPDATE SET revision = EXCLUDED.revision;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER account_discovery_claim_before BEFORE INSERT OR UPDATE OR DELETE ON access.handle_claim
FOR EACH ROW EXECUTE FUNCTION access.account_discovery_claim_before();
CREATE TRIGGER account_discovery_claim_after AFTER INSERT OR UPDATE OR DELETE ON access.handle_claim
FOR EACH ROW EXECUTE FUNCTION access.account_discovery_claim_after();

-- Preferences share the Account anchor. All writers, including native internal
-- commands, dirty current summaries through the same source revision hook.
CREATE FUNCTION access.account_discovery_preferences() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE access.account SET discovery_revision = discovery_revision WHERE route = OLD.route AND account_id = OLD.account_id;
  ELSE
    UPDATE access.account SET discovery_revision = discovery_revision WHERE route = NEW.route AND account_id = NEW.account_id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER account_discovery_preferences AFTER INSERT OR UPDATE OR DELETE ON access.account_preferences
FOR EACH ROW EXECUTE FUNCTION access.account_discovery_preferences();

-- TRUNCATE is an administrative writer too; preserve sequence high water and
-- invalidate all observations while clearing the finite census in this cut.
CREATE FUNCTION access.account_discovery_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'account' THEN
    UPDATE access.account_discovery_population SET population = 0, revision = nextval('access.account_discovery_revision');
  ELSE
    UPDATE access.account_discovery_population SET claim_revision = nextval('access.account_discovery_revision');
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER account_discovery_truncate AFTER TRUNCATE ON access.account
FOR EACH STATEMENT EXECUTE FUNCTION access.account_discovery_truncate();
CREATE TRIGGER account_discovery_claim_truncate AFTER TRUNCATE ON access.handle_claim
FOR EACH STATEMENT EXECUTE FUNCTION access.account_discovery_truncate();

-- migrate:down
-- Revisions and reduction custody must survive binary rollback. Disable the
-- Search registry entry before rollback; do not drop these native safety hooks.
