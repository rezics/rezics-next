-- migrate:up
ALTER TABLE semantic.identity_epoch_prearm_directory
  ADD COLUMN reclaim_after uuid,
  ADD COLUMN reclaim_transaction_id uuid,
  ADD COLUMN reclaimed boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT identity_epoch_prearm_directory_reclaim_check CHECK (
    (reclaim_transaction_id IS NULL AND reclaim_after IS NULL AND NOT reclaimed)
    OR (reclaim_transaction_id IS NOT NULL AND released AND release_transaction_id IS NOT NULL));

ALTER TABLE semantic.identity_epoch_prearm_directory
  ADD CONSTRAINT identity_epoch_prearm_directory_reclaim_commit_fkey
  FOREIGN KEY (partition_no, reclaim_transaction_id)
  REFERENCES semantic.identity_epoch_native_commit (partition_no, transaction_id);

CREATE UNIQUE INDEX identity_epoch_prearm_directory_reclaim_generation
  ON semantic.identity_epoch_prearm_directory (partition_no, generation)
  WHERE reclaim_transaction_id IS NOT NULL;

CREATE INDEX identity_epoch_group_generation
  ON semantic.identity_epoch_group (partition_no, generation);

CREATE INDEX identity_epoch_original_closure_hold
  ON semantic.identity_epoch_original (partition_no, generation, original)
  WHERE closure_reservation IS NOT NULL OR closure_claim IS NOT NULL OR closure_state IN ('preparing', 'withdrawn');

DO $$ DECLARE allowed text; BEGIN
 SELECT pg_get_expr(conbin,conrelid) INTO STRICT allowed FROM pg_constraint
 WHERE conrelid='semantic.identity_epoch_native_commit'::regclass
 AND conname='identity_epoch_native_commit_purpose_check';
 ALTER TABLE semantic.identity_epoch_native_commit DROP CONSTRAINT identity_epoch_native_commit_purpose_check;
 EXECUTE format('ALTER TABLE semantic.identity_epoch_native_commit ADD CONSTRAINT identity_epoch_native_commit_purpose_check CHECK ((%s) OR purpose=%L)',allowed,'identity-generation-reclaim');
END $$;

CREATE OR REPLACE FUNCTION semantic.guard_identity_prearm_membership() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE b semantic.identity_epoch_prearm_bridge;g uuid;h integer;
BEGIN
 g:=coalesce(NEW.generation,OLD.generation);h:=coalesce(NEW.partition_no,OLD.partition_no);
 SELECT * INTO b FROM semantic.identity_epoch_prearm_bridge WHERE partition_no=h AND generation=g FOR UPDATE;
 IF FOUND AND b.job_id IS NOT NULL
 THEN RAISE EXCEPTION 'identity_epoch_unavailable'; END IF;
 -- The bridge is also the fence for retired generation keysets.
 IF FOUND AND TG_OP<>'DELETE' AND EXISTS(
  SELECT 1 FROM semantic.identity_epoch_prearm_directory d
  WHERE d.partition_no=h AND d.generation=g AND d.reclaim_transaction_id IS NOT NULL)
 THEN RAISE EXCEPTION 'identity_effect_stale'; END IF;
 IF TG_OP='UPDATE' AND (NEW.partition_no,NEW.generation) IS DISTINCT FROM (OLD.partition_no,OLD.generation) THEN
  SELECT * INTO b FROM semantic.identity_epoch_prearm_bridge WHERE partition_no=OLD.partition_no AND generation=OLD.generation FOR UPDATE;
  IF FOUND AND b.job_id IS NOT NULL
  THEN RAISE EXCEPTION 'identity_epoch_unavailable'; END IF;
  IF FOUND AND EXISTS(SELECT 1 FROM semantic.identity_epoch_prearm_directory d
    WHERE d.partition_no=OLD.partition_no AND d.generation=OLD.generation AND d.reclaim_transaction_id IS NOT NULL)
  THEN RAISE EXCEPTION 'identity_effect_stale'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION semantic.capture_identity_prearm_erasure() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 -- Reclaim changes only the directory's physical deletion cursor and proof.
 IF TG_TABLE_NAME='identity_epoch_prearm_directory' AND TG_OP='UPDATE'
  AND to_jsonb(NEW)-ARRAY['reclaim_after','reclaim_transaction_id','reclaimed']
      = to_jsonb(OLD)-ARRAY['reclaim_after','reclaim_transaction_id','reclaimed']
 THEN RETURN NEW; END IF;
 native_tx:=coalesce((to_jsonb(NEW)->>'transaction_id')::uuid,
   nullif(current_setting('semantic.erasure_native_transaction',true),'')::uuid);
 PERFORM semantic.capture_erasure_roles(NEW.partition_no,TG_TABLE_NAME,NEW.erasure_key,native_tx);
 RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION semantic.bump_title_input_revision_partition() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  old_home integer;
  new_home integer;
BEGIN
  IF TG_TABLE_NAME = 'identity_epoch_original' AND TG_OP = 'DELETE' THEN
    -- The generation switch already changed the live title input.
    IF EXISTS (
      SELECT 1 FROM semantic.identity_epoch_prearm_directory d
      WHERE (d.partition_no,d.generation)=(OLD.partition_no,OLD.generation)
        AND d.reclaim_transaction_id IS NOT NULL
    ) THEN RETURN OLD; END IF;
  END IF;
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

CREATE OR REPLACE FUNCTION semantic.bump_title_input_revision_native_commit() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  affected_home integer;
  affected_transaction uuid;
  referenced boolean;
BEGIN
  IF coalesce(NEW.purpose, OLD.purpose) = 'identity-generation-reclaim' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
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

-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'Reclaimed identity generation payloads cannot be restored by schema rollback'; END $$;
