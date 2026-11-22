-- migrate:up
CREATE TABLE semantic.subject_privacy_fanout_v1 (
  partition_no integer NOT NULL CHECK (partition_no BETWEEN 0 AND 4095),
  input_key text COLLATE "C" NOT NULL CHECK (input_key<>'["domain","accounts"]'),
  enqueue_revision bigint NOT NULL CHECK (enqueue_revision>0),
  owner_epoch integer NOT NULL CHECK (owner_epoch>0),
  home_generation uuid NOT NULL,
  first_position bigint NOT NULL CHECK (first_position>0),
  through_position bigint NOT NULL CHECK (through_position>=first_position),
  membership_revision bigint NOT NULL CHECK (membership_revision>=0),
  after_birth bigint NOT NULL DEFAULT 0 CHECK (after_birth BETWEEN 0 AND membership_revision),
  complete boolean NOT NULL DEFAULT false,
  captured_by xid8 NOT NULL DEFAULT pg_current_xact_id(),
  PRIMARY KEY (partition_no,input_key,enqueue_revision)
);

-- Search writes this in its transaction that marks the shared home behind.
-- Semantic only reads it. A receipt stays available after the inbox is applied.
CREATE TABLE search.subject_privacy_intake_v1 (
  birth bigint NOT NULL,
  partition_no integer NOT NULL,
  input_key text COLLATE "C" NOT NULL,
  enqueue_revision bigint NOT NULL,
  privacy_base bigint NOT NULL CHECK (privacy_base>=0),
  received_by xid8 NOT NULL DEFAULT pg_current_xact_id(),
  PRIMARY KEY (birth,partition_no,input_key,enqueue_revision),
  FOREIGN KEY (input_key,birth) REFERENCES core.subject_subscription_key_v1,
  FOREIGN KEY (partition_no,input_key,enqueue_revision) REFERENCES semantic.subject_privacy_fanout_v1
);

ALTER TABLE semantic.public_filter_privacy_pending ADD COLUMN captured_shared_v1 boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT subject_privacy_capture_v1 CHECK (NOT captured_shared_v1 OR captured_revision IS NOT NULL);

-- The caller holds the home/head lock when capturing or retiring a pending row.
-- Serialize capture against both activation and birth. Old writers still enqueue
-- unchanged. Old maintainers may open a capture but cannot retire it prematurely.
CREATE FUNCTION semantic.guard_subject_privacy_pending_v1() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE installed boolean; revision bigint; native record;
BEGIN
  SELECT restore_generation IS NOT NULL INTO STRICT installed
    FROM core.subject_retention_domain WHERE singleton FOR SHARE;
  IF NOT installed THEN RETURN NEW; END IF;

  IF (NEW.partition_no,NEW.input_key,NEW.owner_epoch,NEW.through_position,NEW.enqueue_revision)
    IS DISTINCT FROM (OLD.partition_no,OLD.input_key,OLD.owner_epoch,OLD.through_position,OLD.enqueue_revision)
  THEN RAISE EXCEPTION 'Subject privacy capture changed its native queue' USING ERRCODE='23514'; END IF;

  revision:=core.subject_membership_revision_v1();
  SELECT * INTO native FROM core.subject_retention_heads_v1(OLD.partition_no);
  IF OLD.captured_revision IS NULL AND NEW.captured_revision IS NOT NULL AND OLD.live AND NEW.live THEN
    IF revision IS NULL OR native.epoch IS DISTINCT FROM OLD.owner_epoch THEN RETURN NULL; END IF;
    IF (NEW.captured_epoch,NEW.first_position,NEW.captured_through,NEW.captured_revision)
      IS DISTINCT FROM (OLD.owner_epoch,OLD.first_position,OLD.through_position,OLD.enqueue_revision)
      OR native.privacy_base<OLD.through_position THEN
      RAISE EXCEPTION 'Invalid Subject privacy capture' USING ERRCODE='23514';
    END IF;
    INSERT INTO semantic.subject_privacy_fanout_v1
      (partition_no,input_key,enqueue_revision,owner_epoch,home_generation,first_position,through_position,membership_revision)
      VALUES (OLD.partition_no,OLD.input_key,OLD.enqueue_revision,OLD.owner_epoch,native.generation,
        OLD.first_position,OLD.through_position,revision);
    NEW.captured_shared_v1:=true;
    RETURN NEW;
  END IF;

  IF revision IS NULL OR NOT OLD.live OR OLD.captured_revision IS NULL OR NEW.captured_revision IS NOT NULL
    OR (OLD.owner_epoch,OLD.captured_epoch) IS DISTINCT FROM (native.epoch,native.epoch)
    OR native.privacy_base<OLD.captured_through
    OR NEW.live IS DISTINCT FROM (OLD.enqueue_revision<>OLD.captured_revision)
    OR NEW.first_position IS DISTINCT FROM (CASE WHEN NEW.live THEN OLD.next_first_position ELSE OLD.first_position END)
    OR (OLD.captured_shared_v1 AND NOT EXISTS (
      SELECT FROM semantic.subject_privacy_fanout_v1 f
      WHERE (f.partition_no,f.input_key,f.enqueue_revision)=(OLD.partition_no,OLD.input_key,OLD.captured_revision)
        AND (f.owner_epoch,f.home_generation,f.first_position,f.through_position)=
            (native.epoch,native.generation,OLD.first_position,OLD.captured_through)
        AND f.complete))
  THEN
    RAISE EXCEPTION 'Subject privacy interval has no current disposition' USING ERRCODE='23514';
  END IF;
  -- An interval already captured at activation predates the first birth.
  NEW.captured_shared_v1:=false;
  RETURN NEW;
END $$;

CREATE TRIGGER subject_privacy_pending_v1
  BEFORE UPDATE ON semantic.public_filter_privacy_pending FOR EACH ROW
  WHEN (OLD.input_key<>'["domain","accounts"]' AND (
    (OLD.live AND NOT NEW.live) OR
    (OLD.captured_revision,OLD.captured_through,OLD.captured_epoch,OLD.captured_shared_v1) IS DISTINCT FROM
      (NEW.captured_revision,NEW.captured_through,NEW.captured_epoch,NEW.captured_shared_v1) OR
    (OLD.captured_revision IS NOT NULL AND OLD.first_position IS DISTINCT FROM NEW.first_position)))
  EXECUTE FUNCTION semantic.guard_subject_privacy_pending_v1();
ALTER TABLE semantic.public_filter_privacy_pending ENABLE ALWAYS TRIGGER subject_privacy_pending_v1;

-- One indexed predecessor seek in the gapless immutable page cover. The
-- member's cut must still identify the same home incarnation as the capture.
CREATE FUNCTION semantic.subject_privacy_member_base_v1(f semantic.subject_privacy_fanout_v1, member_birth bigint)
RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT (cut.doc->>'privacy')::bigint
  FROM core.subject_subscription_v1 s JOIN core.subject_retention_domain d
    ON d.singleton AND (s.registration_generation,s.restore_generation)=(d.registration_generation,d.restore_generation)
  CROSS JOIN LATERAL (
    SELECT p.end_home,p.xmin,p.cuts->(f.partition_no-p.first_home) AS doc
    FROM core.subject_retention_page_v1 p
    WHERE p.birth=s.birth AND p.first_home<=f.partition_no
    ORDER BY p.first_home DESC LIMIT 1
  ) cut
  WHERE s.birth=member_birth AND s.birth<=f.membership_revision AND f.partition_no<cut.end_home
    AND cut.xmin IS DISTINCT FROM pg_current_xact_id_if_assigned()::xid
    AND (cut.doc->>'home',cut.doc->>'epoch',cut.doc->>'generation')=
        (f.partition_no::text,f.owner_epoch::text,f.home_generation::text)
$$;

CREATE FUNCTION semantic.guard_subject_privacy_intake_v1() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE f semantic.subject_privacy_fanout_v1; base bigint;
BEGIN
  SELECT * INTO STRICT f FROM semantic.subject_privacy_fanout_v1
    WHERE (partition_no,input_key,enqueue_revision)=(NEW.partition_no,NEW.input_key,NEW.enqueue_revision);
  base:=semantic.subject_privacy_member_base_v1(f,NEW.birth);
  IF f.captured_by=pg_current_xact_id() OR base IS NULL OR base IS DISTINCT FROM NEW.privacy_base
    OR base>=f.through_position OR core.subject_membership_revision_v1() IS NULL OR NOT EXISTS (
      SELECT FROM core.subject_retention_heads_v1(f.partition_no) h
      WHERE (h.epoch,h.generation)=(f.owner_epoch,f.home_generation))
  THEN
    RAISE EXCEPTION 'Invalid Subject privacy intake' USING ERRCODE='23514';
  END IF;
  NEW.received_by:=pg_current_xact_id();
  RETURN NEW;
END $$;

CREATE TRIGGER subject_privacy_intake_v1 BEFORE INSERT ON search.subject_privacy_intake_v1
  FOR EACH ROW EXECUTE FUNCTION semantic.guard_subject_privacy_intake_v1();
CREATE TRIGGER subject_privacy_intake_immutable_v1 BEFORE UPDATE OR DELETE ON search.subject_privacy_intake_v1
  FOR EACH ROW EXECUTE FUNCTION core.retain_subject_original_v1();
CREATE TRIGGER subject_privacy_intake_truncate_v1 BEFORE TRUNCATE ON search.subject_privacy_intake_v1
  FOR EACH STATEMENT EXECUTE FUNCTION core.retain_subject_original_v1();

-- Called in the maintainer's final Source transaction after the legacy page
-- finishes. The prefix accounts for each matching birth by its immutable base
-- or a committed receiver intake for this exact interval.
CREATE FUNCTION semantic.advance_subject_privacy_fanout_v1(home integer, key text, captured bigint, page_limit integer)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE pending semantic.public_filter_privacy_pending; f semantic.subject_privacy_fanout_v1;
  native record; member_birth bigint; base bigint; frontier bigint; visited integer:=0; exhausted boolean:=true;
BEGIN
  IF page_limit IS NULL OR page_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Invalid Subject fanout limit'; END IF;
  SELECT * INTO pending FROM semantic.public_filter_privacy_pending p
    WHERE (p.partition_no,p.input_key,p.captured_revision)=(home,key,captured) AND p.live FOR UPDATE;
  IF NOT FOUND THEN RETURN 'pending'; END IF;
  IF NOT pending.captured_shared_v1 THEN RETURN 'pending'; END IF;

  IF core.subject_membership_revision_v1() IS NULL THEN RETURN 'pending'; END IF;
  SELECT * INTO native FROM core.subject_retention_heads_v1(home);
  IF (pending.owner_epoch,pending.captured_epoch) IS DISTINCT FROM (native.epoch,native.epoch)
    OR native.privacy_base<pending.captured_through THEN RETURN 'pending'; END IF;
  SELECT * INTO f FROM semantic.subject_privacy_fanout_v1
    WHERE (partition_no,input_key,enqueue_revision)=(home,key,captured);
  IF NOT FOUND OR f.captured_by=pg_current_xact_id()
    OR (f.owner_epoch,f.home_generation,f.first_position,f.through_position) IS DISTINCT FROM
      (native.epoch,native.generation,pending.first_position,pending.captured_through) THEN RETURN 'pending'; END IF;
  IF f.complete THEN RETURN 'complete'; END IF;

  frontier:=f.after_birth;
  FOR member_birth IN SELECT k.birth FROM core.subject_subscription_key_v1 k
    WHERE k.input_key=key AND k.birth>f.after_birth AND k.birth<=f.membership_revision
    ORDER BY k.birth LIMIT page_limit+1
  LOOP
    visited:=visited+1;
    IF visited>page_limit THEN exhausted:=false; EXIT; END IF;
    base:=semantic.subject_privacy_member_base_v1(f,member_birth);
    IF base IS NULL OR base>native.privacy_base OR (base<f.through_position AND NOT EXISTS (
      SELECT FROM search.subject_privacy_intake_v1 i
      WHERE (i.birth,i.partition_no,i.input_key,i.enqueue_revision,i.privacy_base)=
        (member_birth,f.partition_no,f.input_key,f.enqueue_revision,base)
        AND i.received_by<>pg_current_xact_id()))
    THEN exhausted:=false; EXIT; END IF;
    frontier:=member_birth;
  END LOOP;

  IF exhausted OR frontier>f.after_birth THEN
    UPDATE semantic.subject_privacy_fanout_v1 SET after_birth=frontier,complete=exhausted
      WHERE (partition_no,input_key,enqueue_revision)=(home,key,captured);
  END IF;
  RETURN CASE WHEN exhausted THEN 'complete' WHEN frontier>f.after_birth THEN 'progress' ELSE 'pending' END;
END $$;

-- migrate:down
DO $$ BEGIN
  RAISE EXCEPTION 'Retained Subject privacy dispositions require original retirement' USING ERRCODE='23514';
END $$;
