-- migrate:up
ALTER TABLE semantic.identity_epoch_prearm_bridge
  ADD COLUMN reclaim_transaction_id uuid,
  ADD CONSTRAINT identity_epoch_prearm_bridge_reclaim_unclaimed
    CHECK (reclaim_transaction_id IS NULL OR job_id IS NULL),
  ADD CONSTRAINT identity_epoch_prearm_bridge_reclaim_commit_fkey
    FOREIGN KEY (partition_no, reclaim_transaction_id)
    REFERENCES semantic.identity_epoch_native_commit(partition_no, transaction_id);

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
 IF FOUND AND TG_OP<>'DELETE' AND b.reclaim_transaction_id IS NOT NULL THEN RAISE EXCEPTION 'identity_effect_stale'; END IF;
 IF TG_OP='UPDATE' AND (NEW.partition_no,NEW.generation) IS DISTINCT FROM (OLD.partition_no,OLD.generation) THEN
  SELECT * INTO b FROM semantic.identity_epoch_prearm_bridge WHERE partition_no=OLD.partition_no AND generation=OLD.generation FOR UPDATE;
  IF FOUND AND b.job_id IS NOT NULL
  THEN RAISE EXCEPTION 'identity_epoch_unavailable'; END IF;
  IF FOUND AND b.reclaim_transaction_id IS NOT NULL
  THEN RAISE EXCEPTION 'identity_effect_stale'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
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
      SELECT 1 FROM semantic.identity_epoch_prearm_bridge d
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
 IF TG_TABLE_NAME='identity_epoch_prearm_bridge' AND TG_OP='UPDATE'
  AND to_jsonb(NEW)-'reclaim_transaction_id'=to_jsonb(OLD)-'reclaim_transaction_id'
 THEN RETURN NEW; END IF;
 native_tx:=coalesce((to_jsonb(NEW)->>'transaction_id')::uuid,
   nullif(current_setting('semantic.erasure_native_transaction',true),'')::uuid);
 PERFORM semantic.capture_erasure_roles(NEW.partition_no,TG_TABLE_NAME,NEW.erasure_key,native_tx);
 RETURN NEW;
END; $$;

-- Carry over a fence from any generation already being reclaimed on this schema line.
UPDATE semantic.identity_epoch_prearm_bridge b SET reclaim_transaction_id=d.reclaim_transaction_id
FROM semantic.identity_epoch_prearm_directory d
WHERE (b.partition_no,b.generation)=(d.partition_no,d.generation) AND d.reclaim_transaction_id IS NOT NULL;

DROP INDEX semantic.identity_epoch_prearm_directory_reclaim_generation;

-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'Retired identity generation fences cannot be reversed'; END $$;
