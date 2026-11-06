-- migrate:up
-- Platform capture commands have no editorial write_basis. Native inverse removal records
-- identity_epoch_native_commit and erasure_source_commit at the current core.partition
-- position in this xmin; capture_erasure_source_removal and validate_erasure_source_commit
-- accept those as custody.
DO $$ DECLARE allowed text; BEGIN
 SELECT pg_get_expr(conbin,conrelid) INTO STRICT allowed FROM pg_constraint
 WHERE conrelid='semantic.identity_epoch_native_commit'::regclass
 AND conname='identity_epoch_native_commit_purpose_check';
 ALTER TABLE semantic.identity_epoch_native_commit DROP CONSTRAINT identity_epoch_native_commit_purpose_check;
 EXECUTE format('ALTER TABLE semantic.identity_epoch_native_commit ADD CONSTRAINT identity_epoch_native_commit_purpose_check CHECK ((%s) OR purpose=%L)',allowed,'identity-platform-native-inverse-removal');
END $$;

CREATE OR REPLACE FUNCTION semantic.capture_erasure_source_removal() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE native_home integer; native_tx uuid;
BEGIN
 IF TG_TABLE_NAME='release_composite' THEN native_home:=OLD.extension_route/16;
 ELSIF TG_TABLE_NAME LIKE 'identity_epoch_%' AND TG_TABLE_NAME NOT IN ('identity_epoch_mapping','identity_epoch_home_gate') THEN native_home:=OLD.partition_no;
 ELSE native_home:=OLD.route/16;
 END IF;
 SELECT b.transaction_id INTO native_tx FROM core.partition p JOIN editorial.write_basis b
 ON b.partition_no=p.partition_no AND b.position=p.position
 WHERE p.partition_no=native_home AND b.xmin::text=pg_current_xact_id()::text;
 IF native_tx IS NULL THEN
  SELECT n.transaction_id INTO native_tx FROM core.partition p JOIN semantic.identity_epoch_native_commit n
  ON n.partition_no=p.partition_no AND n.position=p.position
  WHERE p.partition_no=native_home AND n.xmin::text=pg_current_xact_id()::text;
 END IF;
 IF native_tx IS NULL THEN
  SELECT c.transaction_id INTO native_tx FROM core.partition p JOIN semantic.erasure_source_commit c
  ON c.partition_no=p.partition_no AND c.position=p.position
  WHERE p.partition_no=native_home AND c.xmin::text=pg_current_xact_id()::text;
 END IF;
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN OLD; END IF;
 IF native_tx IS NULL THEN RAISE EXCEPTION 'Semantic source removal requires native command custody' USING ERRCODE='23514'; END IF;
 INSERT INTO semantic.erasure_source_commit(partition_no,transaction_id,epoch,position)
 SELECT native_home,native_tx,epoch,position FROM core.partition WHERE partition_no=native_home
 ON CONFLICT DO NOTHING;
 INSERT INTO semantic.erasure_source_disposition(partition_no,store,record_key,disposition,transaction_id)
 VALUES(native_home,TG_TABLE_NAME,OLD.erasure_key,'removed',native_tx)
 ON CONFLICT(partition_no,store,record_key) DO UPDATE SET disposition=EXCLUDED.disposition,transaction_id=EXCLUDED.transaction_id,native_xmin=NULL;
 RETURN OLD;
END; $$;

CREATE OR REPLACE FUNCTION semantic.validate_erasure_source_commit() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM editorial.write_basis b
   WHERE b.partition_no=NEW.partition_no AND b.transaction_id=NEW.transaction_id
     AND b.epoch=NEW.epoch AND b.position=NEW.position AND b.xmin::text=pg_current_xact_id()::text) THEN
  RETURN NEW;
 END IF;
 IF EXISTS(SELECT 1 FROM semantic.identity_epoch_native_commit n
   WHERE n.partition_no=NEW.partition_no AND n.transaction_id=NEW.transaction_id
     AND n.epoch=NEW.epoch AND n.position=NEW.position AND n.xmin::text=pg_current_xact_id()::text) THEN
  RETURN NEW;
 END IF;
 RAISE EXCEPTION 'Semantic Source receipt lacks same-command native custody' USING ERRCODE='23514';
END; $$;

-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'Platform-native source removal custody cannot be reversed'; END $$;
