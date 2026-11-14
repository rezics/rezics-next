-- migrate:up
-- Hold every title-source writer out until the complete clock and its triggers are installed.
LOCK TABLE semantic.adoption, semantic.candidate, semantic.fact, semantic.hidden_candidate,
  semantic.identity_epoch_dirty, semantic.identity_epoch_group, semantic.identity_epoch_mapping,
  semantic.identity_epoch_native_commit, semantic.identity_epoch_original, semantic.record_lifecycle,
  semantic.redirect, semantic.retraction, semantic.revision, semantic.statement_disclosure, semantic.subject,
  semantic.term_head IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE semantic.title_input_home_revision (
  partition_no integer PRIMARY KEY CHECK (partition_no BETWEEN 0 AND 4095),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0)
);
INSERT INTO semantic.title_input_home_revision(partition_no)
SELECT partition_no FROM generate_series(0,4095) AS home(partition_no);

CREATE FUNCTION semantic.bump_title_input_home_revision(home integer) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF home IS NULL OR home < 0 OR home > 4095 THEN
    RAISE EXCEPTION 'Invalid Semantic title-input home %', home USING ERRCODE = '23514';
  END IF;
  INSERT INTO semantic.title_input_home_revision(partition_no,revision)
  VALUES(home,1)
  ON CONFLICT(partition_no) DO UPDATE
    SET revision=semantic.title_input_home_revision.revision+1;
END;
$$;

CREATE FUNCTION semantic.bump_title_input_revision_route() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  old_home integer;
  new_home integer;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    old_home := (to_jsonb(OLD)->>TG_ARGV[0])::integer / 16;
    PERFORM semantic.bump_title_input_home_revision(old_home);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    new_home := (to_jsonb(NEW)->>TG_ARGV[0])::integer / 16;
    IF new_home IS DISTINCT FROM old_home THEN
      PERFORM semantic.bump_title_input_home_revision(new_home);
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION semantic.bump_title_input_revision_partition() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  old_home integer;
  new_home integer;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    old_home := (to_jsonb(OLD)->>TG_ARGV[0])::integer;
    PERFORM semantic.bump_title_input_home_revision(old_home);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    new_home := (to_jsonb(NEW)->>TG_ARGV[0])::integer;
    IF new_home IS DISTINCT FROM old_home THEN
      PERFORM semantic.bump_title_input_home_revision(new_home);
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION semantic.bump_title_input_revision_identity_mapping() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  old_source integer;
  old_control integer;
  new_source integer;
  new_control integer;
  home integer;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    old_source := (to_jsonb(OLD)->>'route')::integer / 16;
    old_control := (to_jsonb(OLD)->>'control_partition')::integer;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    new_source := (to_jsonb(NEW)->>'route')::integer / 16;
    new_control := (to_jsonb(NEW)->>'control_partition')::integer;
  END IF;
  FOR home IN
    SELECT DISTINCT affected.home
    FROM unnest(ARRAY[old_source,old_control,new_source,new_control]) AS affected(home)
    WHERE affected.home IS NOT NULL
    ORDER BY affected.home
  LOOP
    PERFORM semantic.bump_title_input_home_revision(home);
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION semantic.bump_title_input_revision_native_commit() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  affected_home integer;
  affected_transaction uuid;
  referenced boolean;
BEGIN
  IF TG_WHEN = 'BEFORE' THEN
    affected_home := OLD.partition_no;
    affected_transaction := OLD.transaction_id;
  ELSE
    affected_home := NEW.partition_no;
    affected_transaction := NEW.transaction_id;
  END IF;
  SELECT EXISTS (
    SELECT 1
    FROM semantic.identity_epoch_original original
    JOIN semantic.identity_epoch_native_commit native
      ON native.partition_no=original.partition_no
     AND native.transaction_id=original.closure_registration_transaction
     AND native.xmin::text=original.closure_registration_xid
    WHERE native.partition_no=affected_home AND native.transaction_id=affected_transaction
  ) INTO referenced;
  IF referenced THEN PERFORM semantic.bump_title_input_home_revision(affected_home); END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION semantic.bump_title_input_revision_all_homes() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE semantic.title_input_home_revision SET revision=revision+1;
  RETURN NULL;
END;
$$;

CREATE TRIGGER title_input_revision_subject AFTER INSERT OR UPDATE OR DELETE ON semantic.subject
  FOR EACH ROW EXECUTE FUNCTION semantic.bump_title_input_revision_route('route');
CREATE TRIGGER title_input_revision_revision AFTER INSERT OR UPDATE OR DELETE ON semantic.revision
  FOR EACH ROW EXECUTE FUNCTION semantic.bump_title_input_revision_route('route');
CREATE TRIGGER title_input_revision_redirect AFTER INSERT OR UPDATE OR DELETE ON semantic.redirect
  FOR EACH ROW EXECUTE FUNCTION semantic.bump_title_input_revision_route('route');
CREATE TRIGGER title_input_revision_fact AFTER INSERT OR UPDATE OR DELETE ON semantic.fact
  FOR EACH ROW EXECUTE FUNCTION semantic.bump_title_input_revision_route('route');
CREATE TRIGGER title_input_revision_term_head AFTER INSERT OR UPDATE OR DELETE ON semantic.term_head
  FOR EACH ROW EXECUTE FUNCTION semantic.bump_title_input_revision_route('route');
CREATE TRIGGER title_input_revision_adoption AFTER INSERT OR UPDATE OR DELETE ON semantic.adoption
  FOR EACH ROW EXECUTE FUNCTION semantic.bump_title_input_revision_route('route');
CREATE TRIGGER title_input_revision_candidate AFTER INSERT OR UPDATE OR DELETE ON semantic.candidate
  FOR EACH ROW EXECUTE FUNCTION semantic.bump_title_input_revision_route('route');
CREATE TRIGGER title_input_revision_hidden_candidate AFTER INSERT OR UPDATE OR DELETE ON semantic.hidden_candidate
  FOR EACH ROW EXECUTE FUNCTION semantic.bump_title_input_revision_route('route');
CREATE TRIGGER title_input_revision_record_lifecycle AFTER INSERT OR UPDATE OR DELETE ON semantic.record_lifecycle
  FOR EACH ROW EXECUTE FUNCTION semantic.bump_title_input_revision_route('route');
CREATE TRIGGER title_input_revision_statement_disclosure AFTER INSERT OR UPDATE OR DELETE ON semantic.statement_disclosure
  FOR EACH ROW EXECUTE FUNCTION semantic.bump_title_input_revision_route('route');
CREATE TRIGGER title_input_revision_retraction AFTER INSERT OR UPDATE OR DELETE ON semantic.retraction
  FOR EACH ROW EXECUTE FUNCTION semantic.bump_title_input_revision_route('route');
CREATE TRIGGER title_input_revision_identity_mapping AFTER INSERT OR UPDATE OR DELETE ON semantic.identity_epoch_mapping
  FOR EACH ROW EXECUTE FUNCTION semantic.bump_title_input_revision_identity_mapping();
CREATE TRIGGER title_input_revision_identity_dirty AFTER INSERT OR UPDATE OR DELETE ON semantic.identity_epoch_dirty
  FOR EACH ROW EXECUTE FUNCTION semantic.bump_title_input_revision_route('route');
CREATE TRIGGER title_input_revision_identity_group AFTER INSERT OR UPDATE OR DELETE ON semantic.identity_epoch_group
  FOR EACH ROW EXECUTE FUNCTION semantic.bump_title_input_revision_partition('partition_no');
CREATE TRIGGER title_input_revision_identity_original AFTER INSERT OR UPDATE OR DELETE ON semantic.identity_epoch_original
  FOR EACH ROW EXECUTE FUNCTION semantic.bump_title_input_revision_partition('partition_no');
CREATE TRIGGER title_input_revision_identity_native_commit_before BEFORE UPDATE OR DELETE ON semantic.identity_epoch_native_commit
  FOR EACH ROW EXECUTE FUNCTION semantic.bump_title_input_revision_native_commit();
CREATE TRIGGER title_input_revision_identity_native_commit_after AFTER INSERT OR UPDATE ON semantic.identity_epoch_native_commit
  FOR EACH ROW EXECUTE FUNCTION semantic.bump_title_input_revision_native_commit();

CREATE TRIGGER title_input_revision_subject_truncate AFTER TRUNCATE ON semantic.subject
  FOR EACH STATEMENT EXECUTE FUNCTION semantic.bump_title_input_revision_all_homes();
CREATE TRIGGER title_input_revision_revision_truncate AFTER TRUNCATE ON semantic.revision
  FOR EACH STATEMENT EXECUTE FUNCTION semantic.bump_title_input_revision_all_homes();
CREATE TRIGGER title_input_revision_redirect_truncate AFTER TRUNCATE ON semantic.redirect
  FOR EACH STATEMENT EXECUTE FUNCTION semantic.bump_title_input_revision_all_homes();
CREATE TRIGGER title_input_revision_fact_truncate AFTER TRUNCATE ON semantic.fact
  FOR EACH STATEMENT EXECUTE FUNCTION semantic.bump_title_input_revision_all_homes();
CREATE TRIGGER title_input_revision_term_head_truncate AFTER TRUNCATE ON semantic.term_head
  FOR EACH STATEMENT EXECUTE FUNCTION semantic.bump_title_input_revision_all_homes();
CREATE TRIGGER title_input_revision_adoption_truncate AFTER TRUNCATE ON semantic.adoption
  FOR EACH STATEMENT EXECUTE FUNCTION semantic.bump_title_input_revision_all_homes();
CREATE TRIGGER title_input_revision_candidate_truncate AFTER TRUNCATE ON semantic.candidate
  FOR EACH STATEMENT EXECUTE FUNCTION semantic.bump_title_input_revision_all_homes();
CREATE TRIGGER title_input_revision_hidden_candidate_truncate AFTER TRUNCATE ON semantic.hidden_candidate
  FOR EACH STATEMENT EXECUTE FUNCTION semantic.bump_title_input_revision_all_homes();
CREATE TRIGGER title_input_revision_record_lifecycle_truncate AFTER TRUNCATE ON semantic.record_lifecycle
  FOR EACH STATEMENT EXECUTE FUNCTION semantic.bump_title_input_revision_all_homes();
CREATE TRIGGER title_input_revision_statement_disclosure_truncate AFTER TRUNCATE ON semantic.statement_disclosure
  FOR EACH STATEMENT EXECUTE FUNCTION semantic.bump_title_input_revision_all_homes();
CREATE TRIGGER title_input_revision_retraction_truncate AFTER TRUNCATE ON semantic.retraction
  FOR EACH STATEMENT EXECUTE FUNCTION semantic.bump_title_input_revision_all_homes();
CREATE TRIGGER title_input_revision_identity_mapping_truncate AFTER TRUNCATE ON semantic.identity_epoch_mapping
  FOR EACH STATEMENT EXECUTE FUNCTION semantic.bump_title_input_revision_all_homes();
CREATE TRIGGER title_input_revision_identity_dirty_truncate AFTER TRUNCATE ON semantic.identity_epoch_dirty
  FOR EACH STATEMENT EXECUTE FUNCTION semantic.bump_title_input_revision_all_homes();
CREATE TRIGGER title_input_revision_identity_group_truncate AFTER TRUNCATE ON semantic.identity_epoch_group
  FOR EACH STATEMENT EXECUTE FUNCTION semantic.bump_title_input_revision_all_homes();
CREATE TRIGGER title_input_revision_identity_original_truncate AFTER TRUNCATE ON semantic.identity_epoch_original
  FOR EACH STATEMENT EXECUTE FUNCTION semantic.bump_title_input_revision_all_homes();
CREATE TRIGGER title_input_revision_identity_native_commit_truncate AFTER TRUNCATE ON semantic.identity_epoch_native_commit
  FOR EACH STATEMENT EXECUTE FUNCTION semantic.bump_title_input_revision_all_homes();

-- migrate:down
DROP TRIGGER title_input_revision_identity_native_commit_truncate ON semantic.identity_epoch_native_commit;
DROP TRIGGER title_input_revision_identity_original_truncate ON semantic.identity_epoch_original;
DROP TRIGGER title_input_revision_identity_group_truncate ON semantic.identity_epoch_group;
DROP TRIGGER title_input_revision_identity_dirty_truncate ON semantic.identity_epoch_dirty;
DROP TRIGGER title_input_revision_identity_mapping_truncate ON semantic.identity_epoch_mapping;
DROP TRIGGER title_input_revision_retraction_truncate ON semantic.retraction;
DROP TRIGGER title_input_revision_statement_disclosure_truncate ON semantic.statement_disclosure;
DROP TRIGGER title_input_revision_record_lifecycle_truncate ON semantic.record_lifecycle;
DROP TRIGGER title_input_revision_hidden_candidate_truncate ON semantic.hidden_candidate;
DROP TRIGGER title_input_revision_candidate_truncate ON semantic.candidate;
DROP TRIGGER title_input_revision_adoption_truncate ON semantic.adoption;
DROP TRIGGER title_input_revision_term_head_truncate ON semantic.term_head;
DROP TRIGGER title_input_revision_fact_truncate ON semantic.fact;
DROP TRIGGER title_input_revision_redirect_truncate ON semantic.redirect;
DROP TRIGGER title_input_revision_revision_truncate ON semantic.revision;
DROP TRIGGER title_input_revision_subject_truncate ON semantic.subject;
DROP TRIGGER title_input_revision_identity_original ON semantic.identity_epoch_original;
DROP TRIGGER title_input_revision_identity_group ON semantic.identity_epoch_group;
DROP TRIGGER title_input_revision_identity_dirty ON semantic.identity_epoch_dirty;
DROP TRIGGER title_input_revision_identity_mapping ON semantic.identity_epoch_mapping;
DROP TRIGGER title_input_revision_identity_native_commit_after ON semantic.identity_epoch_native_commit;
DROP TRIGGER title_input_revision_identity_native_commit_before ON semantic.identity_epoch_native_commit;
DROP TRIGGER title_input_revision_retraction ON semantic.retraction;
DROP TRIGGER title_input_revision_statement_disclosure ON semantic.statement_disclosure;
DROP TRIGGER title_input_revision_record_lifecycle ON semantic.record_lifecycle;
DROP TRIGGER title_input_revision_hidden_candidate ON semantic.hidden_candidate;
DROP TRIGGER title_input_revision_candidate ON semantic.candidate;
DROP TRIGGER title_input_revision_adoption ON semantic.adoption;
DROP TRIGGER title_input_revision_term_head ON semantic.term_head;
DROP TRIGGER title_input_revision_fact ON semantic.fact;
DROP TRIGGER title_input_revision_redirect ON semantic.redirect;
DROP TRIGGER title_input_revision_revision ON semantic.revision;
DROP TRIGGER title_input_revision_subject ON semantic.subject;
DROP FUNCTION semantic.bump_title_input_revision_all_homes();
DROP FUNCTION semantic.bump_title_input_revision_native_commit();
DROP FUNCTION semantic.bump_title_input_revision_identity_mapping();
DROP FUNCTION semantic.bump_title_input_revision_partition();
DROP FUNCTION semantic.bump_title_input_revision_route();
DROP FUNCTION semantic.bump_title_input_home_revision(integer);
DROP TABLE semantic.title_input_home_revision;
