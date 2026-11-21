-- migrate:up
-- A revision covers exactly the native Account, claim and enqueue fields read by
-- subject_access_heads_v1. It is only a shortcut for reopening an immutable cut.
CREATE TABLE semantic.subject_access_range_revision_v1 (
  first_home integer PRIMARY KEY CHECK (first_home BETWEEN 0 AND 4095 AND first_home%32=0),
  revision uuid NOT NULL DEFAULT gen_random_uuid()
);
INSERT INTO semantic.subject_access_range_revision_v1(first_home) SELECT generate_series(0,4095,32);

CREATE FUNCTION semantic.change_subject_access_range_v1() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_home integer; new_home integer;
BEGIN
  IF TG_OP='TRUNCATE' THEN
    UPDATE semantic.subject_access_range_revision_v1 SET revision=gen_random_uuid();
  ELSE
    IF TG_OP<>'INSERT' THEN old_home:=OLD.partition_no/32*32; END IF;
    IF TG_OP<>'DELETE' THEN new_home:=NEW.partition_no/32*32; END IF;
    UPDATE semantic.subject_access_range_revision_v1 SET revision=gen_random_uuid()
      WHERE first_home IN (old_home,new_home);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER subject_access_range_insert AFTER INSERT ON access.account_discovery_population
  FOR EACH ROW EXECUTE FUNCTION semantic.change_subject_access_range_v1();
CREATE TRIGGER subject_access_range_remove AFTER DELETE ON access.account_discovery_population
  FOR EACH ROW EXECUTE FUNCTION semantic.change_subject_access_range_v1();
CREATE TRIGGER subject_access_range_change AFTER UPDATE ON access.account_discovery_population
  FOR EACH ROW WHEN ((OLD.partition_no,OLD.revision,OLD.claim_revision) IS DISTINCT FROM
    (NEW.partition_no,NEW.revision,NEW.claim_revision)) EXECUTE FUNCTION semantic.change_subject_access_range_v1();
CREATE TRIGGER subject_access_range_truncate AFTER TRUNCATE ON access.account_discovery_population
  FOR EACH STATEMENT EXECUTE FUNCTION semantic.change_subject_access_range_v1();

CREATE TRIGGER subject_access_range_insert AFTER INSERT ON semantic.public_filter_privacy_pending
  FOR EACH ROW WHEN (NEW.input_key='["domain","accounts"]') EXECUTE FUNCTION semantic.change_subject_access_range_v1();
CREATE TRIGGER subject_access_range_remove AFTER DELETE ON semantic.public_filter_privacy_pending
  FOR EACH ROW WHEN (OLD.input_key='["domain","accounts"]') EXECUTE FUNCTION semantic.change_subject_access_range_v1();
CREATE TRIGGER subject_access_range_change AFTER UPDATE ON semantic.public_filter_privacy_pending
  FOR EACH ROW WHEN ((OLD.input_key='["domain","accounts"]' OR NEW.input_key='["domain","accounts"]') AND
    (OLD.partition_no,OLD.input_key,OLD.owner_epoch,OLD.native_revision,OLD.native_claim_revision,OLD.enqueue_revision)
    IS DISTINCT FROM
    (NEW.partition_no,NEW.input_key,NEW.owner_epoch,NEW.native_revision,NEW.native_claim_revision,NEW.enqueue_revision))
  EXECUTE FUNCTION semantic.change_subject_access_range_v1();
CREATE TRIGGER subject_access_range_truncate AFTER TRUNCATE ON semantic.public_filter_privacy_pending
  FOR EACH STATEMENT EXECUTE FUNCTION semantic.change_subject_access_range_v1();

ALTER TABLE semantic.subject_access_page_v1 ADD COLUMN access_revisions uuid[];
CREATE FUNCTION semantic.subject_access_range_revisions_v1(lo integer,hi integer) RETURNS uuid[]
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN count(*)=(hi-1)/32-lo/32+1 THEN array_agg(revision ORDER BY first_home) END
  FROM semantic.subject_access_range_revision_v1 WHERE first_home BETWEEN lo/32*32 AND (hi-1)/32*32
    AND lo BETWEEN 0 AND 4095 AND hi-lo BETWEEN 1 AND 32 AND hi<=4096
$$;

-- Sample before the existing bind trigger reads the actual Account heads. Any
-- later commit to those heads changes this stamp with them in the same transaction.
CREATE FUNCTION semantic.stamp_subject_access_range_v1() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.access_revisions:=semantic.subject_access_range_revisions_v1(NEW.first_home,NEW.end_home);
  RETURN NEW;
END $$;
CREATE TRIGGER subject_access_before_bind BEFORE INSERT ON semantic.subject_access_page_v1
  FOR EACH ROW EXECUTE FUNCTION semantic.stamp_subject_access_range_v1();
ALTER TABLE semantic.subject_access_page_v1 ENABLE ALWAYS TRIGGER subject_access_before_bind;
DO $$ DECLARE relation regclass; action text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['access.account_discovery_population'::regclass,'semantic.public_filter_privacy_pending'::regclass]
  LOOP
    FOREACH action IN ARRAY ARRAY['insert','remove','change','truncate'] LOOP
      EXECUTE format('ALTER TABLE %s ENABLE ALWAYS TRIGGER %I',relation,'subject_access_range_'||action);
    END LOOP;
  END LOOP;
END $$;

-- A changed stamp (or a page from before this migration) takes the native
-- comparison. Never refresh the original stamp with a later observation.
CREATE FUNCTION semantic.subject_access_range_current_v1(p semantic.subject_access_page_v1,lo integer,hi integer)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN lo<p.first_home OR hi>p.end_home OR hi<=lo THEN false
    WHEN p.access_revisions=semantic.subject_access_range_revisions_v1(p.first_home,p.end_home) THEN true
    ELSE (SELECT count(*)=hi-lo FROM generate_series(lo,hi-1) i
      CROSS JOIN LATERAL (SELECT p.cuts->(i-p.first_home) AS cut) x
      CROSS JOIN LATERAL semantic.subject_access_heads_v1(i,(x.cut->>'epoch')::integer) a
      WHERE a.account_revision>=(x.cut->>'account')::bigint AND a.claim_revision>=(x.cut->>'claim')::bigint
        AND (a.enqueue_revision>(x.cut->>'enqueue')::bigint OR
          (a.enqueue_revision,a.account_revision,a.claim_revision)=((x.cut->>'enqueue')::bigint,
            (x.cut->>'account')::bigint,(x.cut->>'claim')::bigint))) END
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
DO $$ BEGIN RAISE EXCEPTION 'Retained Subject Access revisions require forward migration'; END $$;
