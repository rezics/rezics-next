-- migrate:up
-- Zero is the native lower bound on a command position. A sparse index lets
-- Source stop at the first nonempty command history without reading every home.
CREATE INDEX subject_nonzero_command_home ON core.partition(partition_no) WHERE position>0;
ALTER TABLE semantic.subject_access_page_v1 ADD COLUMN quiet_digest text;

-- The bind trigger has already captured the Core and Access originals. Sample
-- raw inventory and the actual command bases in that same producer transaction.
CREATE FUNCTION semantic.bind_subject_quiet_range_v1() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.quiet_digest:=NULL;
  IF NEW.first_home%32=0 AND NEW.end_home=NEW.first_home+32
    AND NOT EXISTS (SELECT FROM semantic.subject WHERE route>=16*NEW.first_home AND route<16*NEW.end_home)
    AND NOT EXISTS (SELECT FROM jsonb_array_elements(NEW.cuts) e WHERE (e->>'command')::bigint<>0)
  THEN
    NEW.quiet_digest:=encode(sha256(convert_to(jsonb_build_array(NEW.birth,NEW.first_home,NEW.end_home,
      NEW.definition_digest,NEW.cuts)::text,'UTF8')),'hex');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER subject_quiet_range BEFORE INSERT ON semantic.subject_access_page_v1
  FOR EACH ROW EXECUTE FUNCTION semantic.bind_subject_quiet_range_v1();

ALTER TABLE semantic.subject_access_page_v1 ENABLE ALWAYS TRIGGER subject_quiet_range;

-- Access already stamps each interval before binding it. Include every change
-- that could revoke the original owner, privacy head, generation or retention.
-- Forward command and privacy heads preserve an already captured finite end.
CREATE FUNCTION semantic.invalidate_subject_cut_range_v1() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE lo integer; hi integer;
BEGIN
  IF TG_OP='TRUNCATE' THEN
    UPDATE semantic.subject_access_range_revision_v1 SET revision=gen_random_uuid();
  ELSE
    IF TG_OP<>'INSERT' THEN lo:=(to_jsonb(OLD)->>TG_ARGV[0])::integer/32*32; END IF;
    IF TG_OP<>'DELETE' THEN hi:=(to_jsonb(NEW)->>TG_ARGV[0])::integer/32*32; END IF;
    UPDATE semantic.subject_access_range_revision_v1 SET revision=gen_random_uuid() WHERE first_home IN (lo,hi);
  END IF;
  IF TG_TABLE_NAME <> 'subject_cleanup_v1' THEN
    PERFORM search.advance_public_filter_repair_authority('@ack-retention',coalesce(lo,hi,0)/32);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER subject_cut_rows AFTER INSERT OR DELETE ON core.partition
  FOR EACH ROW EXECUTE FUNCTION semantic.invalidate_subject_cut_range_v1('partition_no');
ALTER TABLE core.partition ENABLE ALWAYS TRIGGER subject_cut_rows;
CREATE TRIGGER subject_cut_changed AFTER UPDATE ON core.partition
  FOR EACH ROW WHEN ((OLD.partition_no,OLD.epoch,OLD.write_state) IS DISTINCT FROM (NEW.partition_no,NEW.epoch,NEW.write_state) OR NEW.position<OLD.position) EXECUTE FUNCTION semantic.invalidate_subject_cut_range_v1('partition_no');
ALTER TABLE core.partition ENABLE ALWAYS TRIGGER subject_cut_changed;
CREATE TRIGGER subject_cut_truncated AFTER TRUNCATE ON core.partition
  FOR EACH STATEMENT EXECUTE FUNCTION semantic.invalidate_subject_cut_range_v1('partition_no');
ALTER TABLE core.partition ENABLE ALWAYS TRIGGER subject_cut_truncated;
CREATE TRIGGER subject_cut_rows AFTER INSERT OR DELETE ON core.publication_authority_epoch
  FOR EACH ROW EXECUTE FUNCTION semantic.invalidate_subject_cut_range_v1('home_no');
ALTER TABLE core.publication_authority_epoch ENABLE ALWAYS TRIGGER subject_cut_rows;
CREATE TRIGGER subject_cut_changed AFTER UPDATE ON core.publication_authority_epoch
  FOR EACH ROW WHEN ((OLD.home_no,OLD.generation) IS DISTINCT FROM (NEW.home_no,NEW.generation)) EXECUTE FUNCTION semantic.invalidate_subject_cut_range_v1('home_no');
ALTER TABLE core.publication_authority_epoch ENABLE ALWAYS TRIGGER subject_cut_changed;
CREATE TRIGGER subject_cut_truncated AFTER TRUNCATE ON core.publication_authority_epoch
  FOR EACH STATEMENT EXECUTE FUNCTION semantic.invalidate_subject_cut_range_v1('home_no');
ALTER TABLE core.publication_authority_epoch ENABLE ALWAYS TRIGGER subject_cut_truncated;
CREATE TRIGGER subject_cut_rows AFTER INSERT OR DELETE ON semantic.public_filter_privacy_head
  FOR EACH ROW EXECUTE FUNCTION semantic.invalidate_subject_cut_range_v1('partition_no');
ALTER TABLE semantic.public_filter_privacy_head ENABLE ALWAYS TRIGGER subject_cut_rows;
CREATE TRIGGER subject_cut_changed AFTER UPDATE ON semantic.public_filter_privacy_head
  FOR EACH ROW WHEN ((OLD.partition_no,OLD.owner_epoch,OLD.population_fenced) IS DISTINCT FROM (NEW.partition_no,NEW.owner_epoch,NEW.population_fenced) OR NEW.position<OLD.position) EXECUTE FUNCTION semantic.invalidate_subject_cut_range_v1('partition_no');
ALTER TABLE semantic.public_filter_privacy_head ENABLE ALWAYS TRIGGER subject_cut_changed;
CREATE TRIGGER subject_cut_truncated AFTER TRUNCATE ON semantic.public_filter_privacy_head
  FOR EACH STATEMENT EXECUTE FUNCTION semantic.invalidate_subject_cut_range_v1('partition_no');
ALTER TABLE semantic.public_filter_privacy_head ENABLE ALWAYS TRIGGER subject_cut_truncated;
CREATE TRIGGER subject_cut_rows AFTER INSERT OR DELETE ON core.subject_cleanup_v1
  FOR EACH ROW EXECUTE FUNCTION semantic.invalidate_subject_cut_range_v1('home');
ALTER TABLE core.subject_cleanup_v1 ENABLE ALWAYS TRIGGER subject_cut_rows;
CREATE TRIGGER subject_cut_changed AFTER UPDATE ON core.subject_cleanup_v1
  FOR EACH ROW WHEN (OLD IS DISTINCT FROM NEW) EXECUTE FUNCTION semantic.invalidate_subject_cut_range_v1('home');
ALTER TABLE core.subject_cleanup_v1 ENABLE ALWAYS TRIGGER subject_cut_changed;
CREATE TRIGGER subject_cut_truncated AFTER TRUNCATE ON core.subject_cleanup_v1
  FOR EACH STATEMENT EXECUTE FUNCTION semantic.invalidate_subject_cut_range_v1('home');
ALTER TABLE core.subject_cleanup_v1 ENABLE ALWAYS TRIGGER subject_cut_truncated;

-- Replays may outlive an unrelated Account change or a later cleanup that
-- still retains the cut. Reopen at most one stale original per repair turn.
CREATE TABLE semantic.subject_quiet_recheck_v1 (
  birth bigint NOT NULL,
  first_home integer NOT NULL,
  revision uuid NOT NULL,
  PRIMARY KEY(birth,first_home),
  FOREIGN KEY(birth,first_home) REFERENCES semantic.subject_access_page_v1
);
CREATE FUNCTION semantic.verify_subject_quiet_recheck_v1() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p semantic.subject_access_page_v1;
BEGIN
  SELECT * INTO STRICT p FROM semantic.subject_access_page_v1 WHERE (birth,first_home)=(NEW.birth,NEW.first_home);
  IF p.quiet_digest IS NULL THEN RAISE EXCEPTION 'Missing original empty Subject interval'; END IF;
  SELECT revision INTO STRICT NEW.revision FROM semantic.subject_access_range_revision_v1 WHERE first_home=p.first_home;
  IF semantic.capture_subject_access_page_v1(p.birth,p.first_home,p.end_home) IS DISTINCT FROM p.cuts
    THEN RAISE EXCEPTION 'Subject interval changed'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER subject_quiet_recheck BEFORE INSERT OR UPDATE ON semantic.subject_quiet_recheck_v1
  FOR EACH ROW EXECUTE FUNCTION semantic.verify_subject_quiet_recheck_v1();
ALTER TABLE semantic.subject_quiet_recheck_v1 ENABLE ALWAYS TRIGGER subject_quiet_recheck;

CREATE FUNCTION semantic.subject_quiet_page_current_v1(p semantic.subject_access_page_v1)
RETURNS boolean LANGUAGE sql STABLE STRICT AS $$
  SELECT p.quiet_digest IS NOT NULL AND EXISTS (
    SELECT FROM semantic.subject_access_range_revision_v1 s WHERE s.first_home=p.first_home AND
      (p.access_revisions=ARRAY[s.revision] OR EXISTS (SELECT FROM semantic.subject_quiet_recheck_v1 q
        WHERE (q.birth,q.first_home,q.revision)=(p.birth,p.first_home,s.revision))))
$$;

CREATE OR REPLACE FUNCTION semantic.capture_subject_access_page_v1(member_birth bigint,lo integer,hi integer)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE saved semantic.subject_access_page_v1; original jsonb;
BEGIN
  -- Serialize both fresh calls and uncertain-commit retries with Core capture.
  PERFORM FROM core.subject_retention_domain WHERE singleton FOR SHARE;
  PERFORM FROM core.subject_subscription_v1 WHERE birth=member_birth FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Missing Subject membership'; END IF;
  SELECT * INTO saved FROM semantic.subject_access_page_v1 WHERE (birth,first_home)=(member_birth,lo);
  IF NOT FOUND THEN
    INSERT INTO semantic.subject_access_page_v1(birth,first_home,end_home)
      VALUES(member_birth,lo,hi) RETURNING * INTO saved;
  ELSE
    IF saved.end_home IS DISTINCT FROM hi THEN RAISE EXCEPTION 'Original Subject Access interval mismatch'; END IF;
    IF semantic.subject_access_definition_v1(member_birth) IS DISTINCT FROM saved.definition_digest
      THEN RAISE EXCEPTION 'Original Subject definition or membership keys changed'; END IF;
    -- The domain and membership are locked above. Reopen shared registration,
    -- store and restore lineage once, then compare the two original pages
    -- against the current native owner, privacy head and cleanup of every home.
    SELECT c.cuts INTO STRICT original FROM core.subject_retention_page_v1 c
      JOIN core.subject_subscription_v1 m USING(birth)
      JOIN core.subject_retention_domain d ON d.singleton AND NOT d.fenced AND
        (d.restore_generation,d.registration_generation)=(m.restore_generation,m.registration_generation)
      CROSS JOIN LATERAL core.subject_retention_heads_v1(lo) anchor
      WHERE (c.birth,c.first_home,c.end_home)=(member_birth,lo,hi) AND anchor.restore=m.restore_generation
        AND m.opened_xid<>pg_current_xact_id();
    -- The stamp binds the original comparison. Membership, definition and
    -- store/restore lineage above are still reopened on each receiver call.
    IF semantic.subject_quiet_page_current_v1(saved) THEN RETURN saved.cuts; END IF;
    IF NOT semantic.subject_access_range_current_v1(saved,lo,hi) OR
      (SELECT count(*) FROM jsonb_array_elements(saved.cuts) WITH ORDINALITY s(cut,ordinal)
       CROSS JOIN LATERAL (SELECT lo+ordinal::integer-1 AS home) i
       CROSS JOIN LATERAL (SELECT epoch,position FROM core.partition WHERE partition_no=i.home AND write_state='active' LIMIT 1) h
       CROSS JOIN LATERAL (SELECT generation FROM core.publication_authority_epoch WHERE home_no=i.home LIMIT 1) g
       CROSS JOIN LATERAL (SELECT position FROM semantic.public_filter_privacy_head WHERE partition_no=i.home
         AND owner_epoch=h.epoch AND NOT population_fenced LIMIT 1) n
       LEFT JOIN core.subject_cleanup_v1 permit ON permit.home=i.home
       WHERE cut @> (original->(ordinal::integer-1)) AND
         (cut->>'home',cut->>'epoch',cut->>'generation')=(i.home::text,h.epoch::text,g.generation::text)
         AND (cut->>'command')::bigint<=h.position AND (cut->>'privacy')::bigint<=n.position
         AND (permit.home IS NULL OR ((permit.owner_epoch,permit.home_generation,permit.restore_generation)=
           (h.epoch,g.generation,(SELECT restore_generation FROM core.subject_subscription_v1 WHERE birth=member_birth))
           AND permit.command_through<=(cut->>'command')::bigint AND permit.privacy_through<=(cut->>'privacy')::bigint)))<>hi-lo
      THEN RAISE EXCEPTION 'Original Subject Access authority changed'; END IF;
  END IF;
  RETURN saved.cuts;
END $$;

-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'Retained Subject range proofs require forward migration'; END $$;
