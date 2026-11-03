-- migrate:up
-- Content remains the only vote writer. These transaction-local consumers maintain Library's access path.
CREATE TABLE library.shelf_score_head (
  route integer NOT NULL,
  account_id uuid NOT NULL,
  generation uuid NOT NULL DEFAULT gen_random_uuid(),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  ready boolean NOT NULL DEFAULT false,
  after_subject uuid,
  PRIMARY KEY (route, account_id),
  CHECK (route = get_byte(uuid_send(account_id), 10) * 256 + get_byte(uuid_send(account_id), 11))
);
CREATE TABLE library.shelf_score (
  route integer NOT NULL,
  account_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  state text NOT NULL,
  type_id uuid,
  units integer CHECK (units BETWEEN 0 AND 4096),
  PRIMARY KEY (route, account_id, subject_id),
  FOREIGN KEY (route, account_id, subject_id) REFERENCES library.entry (route, account_id, subject_id)
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX shelf_score_asc ON library.shelf_score (route, account_id, (COALESCE(units, 4097)), subject_id);
CREATE INDEX shelf_score_asc_state ON library.shelf_score (route, account_id, state, (COALESCE(units, 4097)), subject_id);
CREATE INDEX shelf_score_asc_type ON library.shelf_score (route, account_id, type_id, (COALESCE(units, 4097)), subject_id);
CREATE INDEX shelf_score_asc_state_type ON library.shelf_score (route, account_id, state, type_id, (COALESCE(units, 4097)), subject_id);
CREATE INDEX shelf_score_desc ON library.shelf_score (route, account_id, (COALESCE(-units, 1)), subject_id);
CREATE INDEX shelf_score_desc_state ON library.shelf_score (route, account_id, state, (COALESCE(-units, 1)), subject_id);
CREATE INDEX shelf_score_desc_type ON library.shelf_score (route, account_id, type_id, (COALESCE(-units, 1)), subject_id);
CREATE INDEX shelf_score_desc_state_type ON library.shelf_score (route, account_id, state, type_id, (COALESCE(-units, 1)), subject_id);

CREATE FUNCTION library.shelf_score_sync(owner_route integer, owner_id uuid, subject uuid) RETURNS void
LANGUAGE sql VOLATILE AS $$
  INSERT INTO library.shelf_score(route, account_id, subject_id, state, type_id, units)
  SELECT e.route, e.account_id, e.subject_id, e.state, e.type_id, v.units
  FROM library.entry e
  LEFT JOIN rating.vote v ON v.route=e.route AND v.voter_id=e.account_id
    AND v.question_id='00000000-0000-7000-8000-000000000001'::uuid AND v.counted_target=e.subject_id
  WHERE e.route=owner_route AND e.account_id=owner_id AND e.subject_id=subject
  ON CONFLICT (route, account_id, subject_id) DO UPDATE
    SET state=EXCLUDED.state, type_id=EXCLUDED.type_id, units=EXCLUDED.units;
$$;

CREATE FUNCTION library.shelf_score_entry_lock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    INSERT INTO library.shelf_score_head(route, account_id) VALUES (OLD.route, OLD.account_id)
    ON CONFLICT (route, account_id) DO UPDATE SET revision=library.shelf_score_head.revision+1;
  END IF;
  IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND (NEW.route, NEW.account_id) IS DISTINCT FROM (OLD.route, OLD.account_id)) THEN
    INSERT INTO library.shelf_score_head(route, account_id) VALUES (NEW.route, NEW.account_id)
    ON CONFLICT (route, account_id) DO UPDATE SET revision=library.shelf_score_head.revision+1;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE FUNCTION library.shelf_score_entry_sync() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM library.shelf_score_sync(NEW.route, NEW.account_id, NEW.subject_id);
  RETURN NULL;
END;
$$;
CREATE TRIGGER shelf_score_entry_lock BEFORE INSERT OR UPDATE OR DELETE ON library.entry
FOR EACH ROW EXECUTE FUNCTION library.shelf_score_entry_lock();
CREATE TRIGGER shelf_score_entry_sync AFTER INSERT OR UPDATE ON library.entry
FOR EACH ROW EXECUTE FUNCTION library.shelf_score_entry_sync();

-- Even vote-only owners serialize their first vote/Entry under SERIALIZABLE commands.
-- Terminal cleanup must not recreate a head after Library's final erasure phase.
CREATE FUNCTION library.shelf_score_vote_touch(owner_route integer, owner_id uuid, allow_create boolean)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE library.shelf_score_head SET revision=revision+1 WHERE route=owner_route AND account_id=owner_id;
  IF NOT FOUND AND allow_create AND NOT EXISTS (
    SELECT 1 FROM access.account a WHERE a.route=owner_route AND a.account_id=owner_id AND a.state='deleted'
  ) THEN
    INSERT INTO library.shelf_score_head(route,account_id) VALUES(owner_route,owner_id)
    ON CONFLICT(route,account_id) DO UPDATE SET revision=library.shelf_score_head.revision+1;
  END IF;
END;
$$;
CREATE FUNCTION library.shelf_score_vote_lock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' AND OLD.question_id='00000000-0000-7000-8000-000000000001'::uuid THEN
    PERFORM library.shelf_score_vote_touch(OLD.route,OLD.voter_id,TG_OP<>'DELETE');
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.question_id='00000000-0000-7000-8000-000000000001'::uuid THEN
    PERFORM library.shelf_score_vote_touch(NEW.route,NEW.voter_id,true);
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE FUNCTION library.shelf_score_vote_sync() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' AND OLD.question_id='00000000-0000-7000-8000-000000000001'::uuid AND OLD.counted_target IS NOT NULL THEN
    PERFORM library.shelf_score_sync(OLD.route, OLD.voter_id, OLD.counted_target);
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.question_id='00000000-0000-7000-8000-000000000001'::uuid AND NEW.counted_target IS NOT NULL THEN
    PERFORM library.shelf_score_sync(NEW.route, NEW.voter_id, NEW.counted_target);
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER shelf_score_vote_lock BEFORE INSERT OR UPDATE OR DELETE ON rating.vote
FOR EACH ROW EXECUTE FUNCTION library.shelf_score_vote_lock();
CREATE TRIGGER shelf_score_vote_sync AFTER INSERT OR UPDATE OR DELETE ON rating.vote
FOR EACH ROW EXECUTE FUNCTION library.shelf_score_vote_sync();

-- Explicit preparation only: one owner lock, 101 entry keys, at most 100 exact native vote probes.
CREATE FUNCTION library.prepare_shelf_score(owner_route integer, owner_id uuid)
RETURNS TABLE(ready boolean, prepared integer) LANGUAGE plpgsql AS $$
DECLARE head library.shelf_score_head; ids uuid[]; subject uuid; n integer;
BEGIN
  INSERT INTO library.shelf_score_head(route, account_id) VALUES(owner_route, owner_id) ON CONFLICT DO NOTHING;
  SELECT * INTO STRICT head FROM library.shelf_score_head WHERE route=owner_route AND account_id=owner_id FOR UPDATE;
  IF head.ready THEN RETURN QUERY SELECT true, 0; RETURN; END IF;
  IF head.after_subject IS NULL THEN
    SELECT array_agg(p.subject_id ORDER BY p.subject_id) INTO ids FROM (
      SELECT e.subject_id FROM library.entry e WHERE e.route=owner_route AND e.account_id=owner_id
      ORDER BY e.subject_id LIMIT 101
    ) p;
  ELSE
    SELECT array_agg(p.subject_id ORDER BY p.subject_id) INTO ids FROM (
      SELECT e.subject_id FROM library.entry e WHERE e.route=owner_route AND e.account_id=owner_id
        AND e.subject_id>head.after_subject ORDER BY e.subject_id LIMIT 101
    ) p;
  END IF;
  n:=LEAST(COALESCE(cardinality(ids),0),100);
  IF n>0 THEN
    FOREACH subject IN ARRAY ids[1:n] LOOP
      PERFORM library.shelf_score_sync(owner_route,owner_id,subject);
    END LOOP;
  END IF;
  UPDATE library.shelf_score_head SET ready=COALESCE(cardinality(ids),0)<=100,
    after_subject=CASE WHEN n>0 THEN ids[n] ELSE after_subject END, revision=revision+1
    WHERE route=owner_route AND account_id=owner_id RETURNING shelf_score_head.ready INTO head.ready;
  RETURN QUERY SELECT head.ready,n;
END;
$$;

-- migrate:down
DROP TRIGGER shelf_score_vote_sync ON rating.vote;
DROP TRIGGER shelf_score_vote_lock ON rating.vote;
DROP TRIGGER shelf_score_entry_sync ON library.entry;
DROP TRIGGER shelf_score_entry_lock ON library.entry;
DROP FUNCTION library.prepare_shelf_score(integer, uuid);
DROP FUNCTION library.shelf_score_vote_sync();
DROP FUNCTION library.shelf_score_vote_lock();
DROP FUNCTION library.shelf_score_vote_touch(integer, uuid, boolean);
DROP FUNCTION library.shelf_score_entry_sync();
DROP FUNCTION library.shelf_score_entry_lock();
DROP FUNCTION library.shelf_score_sync(integer, uuid, uuid);
DROP TABLE library.shelf_score;
DROP TABLE library.shelf_score_head;
