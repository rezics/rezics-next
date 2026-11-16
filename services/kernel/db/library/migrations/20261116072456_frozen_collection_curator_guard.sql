-- migrate:up
CREATE OR REPLACE FUNCTION library.guard_retained_public_output() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item record; step integer; retained boolean; frozen_generation uuid;
BEGIN
 FOR step IN 1..2 LOOP
  IF step=1 THEN
   IF TG_OP='INSERT' THEN CONTINUE; END IF;
   item:=OLD;
  ELSE
   IF TG_OP='DELETE' THEN CONTINUE; END IF;
   item:=NEW;
  END IF;
  PERFORM 1 FROM library.collection WHERE route=item.route AND collection_id=item.collection_id FOR UPDATE;
  PERFORM 1 FROM core.partition WHERE partition_no=item.route >> 4 FOR SHARE;
  IF TG_TABLE_NAME='collection' THEN
   IF TG_OP='UPDATE' AND (NEW.route,NEW.collection_id,NEW.created_at,NEW.curator_account_id)
     IS NOT DISTINCT FROM (OLD.route,OLD.collection_id,OLD.created_at,OLD.curator_account_id)
     AND NOT (OLD.state='deleted' AND NEW.state='active') THEN CONTINUE; END IF;
   IF TG_OP='UPDATE' AND NEW.curator_account_id IS NULL AND OLD.curator_account_id IS NOT NULL
     -- PostgreSQL computes the stored partition number after BEFORE triggers; the route still must match.
     AND (to_jsonb(NEW)-ARRAY['curator_account_id','partition_no'])=
         (to_jsonb(OLD)-ARRAY['curator_account_id','partition_no']) THEN
     SELECT f.generation INTO frozen_generation FROM library.collection_retained_output f
     WHERE f.route=item.route AND f.collection_id=item.collection_id;
     IF library.may_deidentify_frozen_output(item.route,item.collection_id,frozen_generation) THEN CONTINUE; END IF;
   END IF;
   SELECT EXISTS(SELECT 1 FROM library.native_public_output_hold
     WHERE route=item.route AND collection_id=item.collection_id AND consumed_by IS NULL LIMIT 1) INTO retained;
  ELSE
   IF TG_TABLE_NAME='collection_source_output' AND TG_OP='UPDATE' THEN
     IF NEW.account_id IS NULL AND OLD.account_id IS NOT NULL
       AND (to_jsonb(NEW)-'account_id')=(to_jsonb(OLD)-'account_id')
       AND library.may_deidentify_frozen_output(item.route,item.collection_id,item.generation)
     THEN CONTINUE; END IF;
   ELSIF TG_TABLE_NAME='collection_source_output_publication' AND TG_OP='DELETE' THEN
     IF library.may_deidentify_frozen_output(item.route,item.collection_id,item.generation) THEN CONTINUE; END IF;
   END IF;
   SELECT EXISTS(SELECT 1 FROM library.native_public_output_hold
     WHERE route=item.route AND collection_id=item.collection_id AND output_generation=item.generation
       AND consumed_by IS NULL LIMIT 1) INTO retained;
  END IF;
  IF retained THEN RAISE EXCEPTION 'native_public_output_retained'; END IF;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END; $$;

-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'Frozen Collection curator guard requires a forward migration'; END; $$;
