-- migrate:up
CREATE OR REPLACE FUNCTION access.account_discovery_before() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE p integer;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.route, NEW.account_id) IS DISTINCT FROM (OLD.route, OLD.account_id) THEN
    RAISE EXCEPTION 'Account discovery source keys are immutable';
  END IF;
  p := CASE WHEN TG_OP = 'DELETE' THEN OLD.route >> 4 ELSE NEW.route >> 4 END;
  -- Retain the original native owner while the same-home Source obligation commits.
  PERFORM 1 FROM core.partition WHERE partition_no=p AND write_state='active' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Account public-filter owner is unavailable'; END IF;
  -- Serialize allocation with the native head; a late commit must advance it too.
  PERFORM 1 FROM access.account_discovery_population WHERE partition_no = p FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Account discovery census is not installed'; END IF;
  -- Same local lock order as retained enrollment: Account head, then Source head.
  PERFORM 1 FROM semantic.public_filter_privacy_head WHERE partition_no=p FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Account public-filter Source head is missing'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  NEW.discovery_revision := nextval('access.account_discovery_revision');
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION access.account_discovery_after() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
  PERFORM semantic.enqueue_account_public_filter(partition_no,revision,claim_revision)
    FROM access.account_discovery_population WHERE partition_no=r >> 4;
  IF TG_OP <> 'UPDATE' OR NOT access.native_terminal_account_ready(OLD) THEN
    INSERT INTO access.account_discovery_intent VALUES (r, a, v)
      ON CONFLICT (route, account_id) DO UPDATE SET revision = EXCLUDED.revision;
  END IF;
  IF TG_OP = 'DELETE' OR NEW.state = 'deleted' THEN
    DELETE FROM access.account_discovery_claim_cursor WHERE route = r AND account_id = a;
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION access.account_discovery_claim_before() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE p integer;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.route, NEW.normalized_handle) IS DISTINCT FROM (OLD.route, OLD.normalized_handle) THEN
    RAISE EXCEPTION 'Account discovery claim keys are immutable';
  END IF;
  p := CASE WHEN TG_OP = 'DELETE' THEN OLD.route >> 4 ELSE NEW.route >> 4 END;
  -- Retain the original native owner while the same-home Source obligation commits.
  PERFORM 1 FROM core.partition WHERE partition_no=p AND write_state='active' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Account public-filter owner is unavailable'; END IF;
  PERFORM 1 FROM access.account_discovery_population WHERE partition_no = p FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Account discovery census is not installed'; END IF;
  -- Same local lock order as retained enrollment: Account head, then Source head.
  PERFORM 1 FROM semantic.public_filter_privacy_head WHERE partition_no=p FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Account public-filter Source head is missing'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  NEW.discovery_revision := nextval('access.account_discovery_revision');
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION access.account_discovery_claim_after() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE r integer; v bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD.route; v := nextval('access.account_discovery_revision');
  ELSE r := NEW.route; v := NEW.discovery_revision; END IF;
  UPDATE access.account_discovery_population SET claim_revision = v WHERE partition_no = r >> 4;
  PERFORM semantic.enqueue_account_public_filter(partition_no,revision,claim_revision)
    FROM access.account_discovery_population WHERE partition_no=r >> 4;
  IF TG_OP <> 'INSERT' AND OLD.account_id IS NOT NULL THEN
    INSERT INTO access.account_discovery_claim_intent VALUES (r, OLD.account_id, v)
      ON CONFLICT (route, account_id) DO UPDATE SET revision = EXCLUDED.revision;
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.account_id IS NOT NULL THEN
    INSERT INTO access.account_discovery_claim_intent VALUES (r, NEW.account_id, v)
      ON CONFLICT (route, account_id) DO UPDATE SET revision = EXCLUDED.revision;
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION access.account_discovery_preferences() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE access.account SET discovery_revision = discovery_revision WHERE route = OLD.route AND account_id = OLD.account_id;
  ELSE
    UPDATE access.account SET discovery_revision = discovery_revision WHERE route = NEW.route AND account_id = NEW.account_id;
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION access.account_discovery_truncate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE home integer;
BEGIN
  -- A table reset has no Account row identity. Each original native home remains
  -- independently dirty; no event delivery or clearing of intents retires it.
  FOR home IN SELECT partition_no FROM access.account_discovery_population ORDER BY partition_no LOOP
    PERFORM 1 FROM core.partition WHERE partition_no=home AND write_state='active' FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Account public-filter owner is unavailable'; END IF;
    PERFORM 1 FROM access.account_discovery_population WHERE partition_no=home FOR UPDATE;
    PERFORM 1 FROM semantic.public_filter_privacy_head WHERE partition_no=home FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Account public-filter Source head is missing'; END IF;
    IF TG_TABLE_NAME = 'account' THEN
      UPDATE access.account_discovery_population SET population=0,
        revision=nextval('access.account_discovery_revision') WHERE partition_no=home;
    ELSE
      UPDATE access.account_discovery_population SET claim_revision=nextval('access.account_discovery_revision')
        WHERE partition_no=home;
    END IF;
    PERFORM semantic.enqueue_account_public_filter(partition_no,revision,claim_revision)
      FROM access.account_discovery_population WHERE partition_no=home;
  END LOOP;
  RETURN NULL;
END $$;

-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'Account Source writer custody cannot be rolled back'; END $$;
