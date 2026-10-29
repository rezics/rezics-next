-- migrate:up
-- dbmate commits the tables and hook together. No legacy scan or ready-zero cutover.
LOCK TABLE library.follow IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE library.follow_count_owner (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  account_id uuid NOT NULL,
  observed_live_count bigint NOT NULL DEFAULT 0 CHECK (observed_live_count >= 0),
  bootstrap_complete boolean NOT NULL DEFAULT false,
  PRIMARY KEY (route, account_id),
  CHECK (route = get_byte(uuid_send(account_id), 10) * 256 + get_byte(uuid_send(account_id), 11))
);
COMMENT ON TABLE library.follow_count_owner IS
  'Private source coverage, not a disclosed total. Missing or bootstrap_complete=false is unready. observed_live_count counts following pairs represented in follow_count_source only. No writer or reader here completes bootstrap.';

CREATE TABLE library.follow_count_source (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  account_id uuid NOT NULL,
  target_type text NOT NULL CHECK (target_type IN ('subject', 'collection', 'space')),
  target_id uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  source_following boolean NOT NULL,
  desired_eligible boolean NOT NULL,
  pending_since timestamptz,
  PRIMARY KEY (route, account_id, target_type, target_id),
  CHECK (route = get_byte(uuid_send(account_id), 10) * 256 + get_byte(uuid_send(account_id), 11)),
  CHECK (NOT desired_eligible OR source_following)
);
CREATE INDEX follow_count_source_pending
  ON library.follow_count_source (route, account_id, pending_since, target_type, target_id)
  WHERE pending_since IS NOT NULL;
COMMENT ON TABLE library.follow_count_source IS
  'Current replacement per original, never a second graph or permission. Revision 1 is first observation, not legacy version zero. Retain negative rows and revisions until fenced terminal withdrawal and erasure. Delivery must reread current native account/follow under the account writer barrier.';

CREATE FUNCTION library.record_follow_count_source() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  edge library.follow;
  live boolean;
  previous_live boolean;
  eligible boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (OLD.route, OLD.account_id, OLD.target_type, OLD.target_id)
       IS DISTINCT FROM (NEW.route, NEW.account_id, NEW.target_type, NEW.target_id) THEN
      RAISE EXCEPTION 'Follow original identity and owner route cannot change' USING ERRCODE = '23514';
    END IF;
    IF OLD IS NOT DISTINCT FROM NEW THEN RETURN NULL; END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN edge := OLD; ELSE edge := NEW; END IF;
  live := TG_OP <> 'DELETE' AND edge.state = 'following';

  -- The native command already holds shareAccount. This is only a keyed data read,
  -- never Access authorization or a write in an account transition transaction.
  SELECT live AND a.state = 'active' AND NOT a.authn_fenced INTO eligible
    FROM access.account a WHERE a.route = edge.route AND a.account_id = edge.account_id;

  -- Owner-local mutex also arbitrates future bounded bootstrap. Absence is incomplete,
  -- so a first touch of a legacy live row adds its CURRENT state, not an unknown delta.
  INSERT INTO library.follow_count_owner AS owner (route, account_id)
    VALUES (edge.route, edge.account_id)
    ON CONFLICT (route, account_id) DO UPDATE
      SET observed_live_count = owner.observed_live_count;
  SELECT s.source_following INTO previous_live FROM library.follow_count_source s
    WHERE s.route = edge.route AND s.account_id = edge.account_id
      AND s.target_type = edge.target_type AND s.target_id = edge.target_id
    FOR UPDATE;

  INSERT INTO library.follow_count_source AS source
    (route, account_id, target_type, target_id, revision, source_following, desired_eligible, pending_since)
    VALUES (edge.route, edge.account_id, edge.target_type, edge.target_id, 1,
            live, COALESCE(eligible, false), statement_timestamp())
    ON CONFLICT (route, account_id, target_type, target_id) DO UPDATE
      SET revision = source.revision + 1,
          source_following = EXCLUDED.source_following,
          desired_eligible = EXCLUDED.desired_eligible,
          pending_since = LEAST(source.pending_since, EXCLUDED.pending_since);

  IF live IS DISTINCT FROM COALESCE(previous_live, false) THEN
    UPDATE library.follow_count_owner
      SET observed_live_count = observed_live_count + CASE WHEN live THEN 1 ELSE -1 END
      WHERE route = edge.route AND account_id = edge.account_id;
  END IF;
  -- Native bigint overflow aborts the entire source statement and command transaction.
  RETURN NULL;
END;
$$;

CREATE TRIGGER follow_count_source_change
  AFTER INSERT OR UPDATE OR DELETE ON library.follow
  FOR EACH ROW EXECUTE FUNCTION library.record_follow_count_source();

-- migrate:down
-- Forward only: no revision reuse, history GC, reset or loss of negative replacements.
