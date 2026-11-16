-- migrate:up
CREATE OR REPLACE FUNCTION semantic.capture_identity_epoch_step_erasure() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 IF NEW.step='search-canonical-index' AND NEW.partition_no<>
    (get_byte(uuid_send(NEW.job_id),10)*256+get_byte(uuid_send(NEW.job_id),11))/16 THEN
  -- The foreign receiving command binds the admitted roles to its own native step transaction.
  native_tx:=NEW.transaction_id;
 ELSE
  native_tx:=(SELECT recorded_transaction_id FROM semantic.identity_epoch_job WHERE partition_no=NEW.partition_no AND job_id=NEW.job_id);
 END IF;
 PERFORM semantic.capture_erasure_roles(NEW.partition_no,'identity_epoch_step',NEW.erasure_key,native_tx);

 RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION semantic.enqueue_identity_receiving_capture() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF current_setting('semantic.identity_receiving_capture',true) IS DISTINCT FROM 'on'
    OR current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='identity_epoch_step' THEN
  IF NEW.step='search-canonical-index' AND NEW.partition_no<>
     (get_byte(uuid_send(NEW.job_id),10)*256+get_byte(uuid_send(NEW.job_id),11))/16 THEN
   INSERT INTO semantic.identity_receiving_capture_pending(transaction_xid,partition_no,store,record_key,source_transaction_id)
    VALUES(pg_current_xact_id()::text,NEW.partition_no,TG_TABLE_NAME,NEW.erasure_key,NEW.transaction_id);
   RETURN NEW;
  END IF;
 END IF;
 IF TG_TABLE_NAME IN ('identity_epoch_effect_receipt','identity_epoch_step') THEN
  INSERT INTO semantic.identity_receiving_capture_pending(transaction_xid,partition_no,store,record_key,job_id)
   VALUES(pg_current_xact_id()::text,NEW.partition_no,TG_TABLE_NAME,NEW.erasure_key,NEW.job_id);
 ELSE
  INSERT INTO semantic.identity_receiving_capture_pending(transaction_xid,partition_no,store,record_key,source_transaction_id)
   VALUES(pg_current_xact_id()::text,NEW.partition_no,TG_TABLE_NAME,NEW.erasure_key,NEW.transaction_id);
 END IF;
 RETURN NEW;
END; $$;

-- migrate:down
CREATE OR REPLACE FUNCTION semantic.capture_identity_epoch_step_erasure() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=(SELECT recorded_transaction_id FROM semantic.identity_epoch_job WHERE partition_no=NEW.partition_no AND job_id=NEW.job_id);
 PERFORM semantic.capture_erasure_roles(NEW.partition_no,'identity_epoch_step',NEW.erasure_key,native_tx);

 RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION semantic.enqueue_identity_receiving_capture() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF current_setting('semantic.identity_receiving_capture',true) IS DISTINCT FROM 'on'
    OR current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME IN ('identity_epoch_effect_receipt','identity_epoch_step') THEN
  INSERT INTO semantic.identity_receiving_capture_pending(transaction_xid,partition_no,store,record_key,job_id)
   VALUES(pg_current_xact_id()::text,NEW.partition_no,TG_TABLE_NAME,NEW.erasure_key,NEW.job_id);
 ELSE
  INSERT INTO semantic.identity_receiving_capture_pending(transaction_xid,partition_no,store,record_key,source_transaction_id)
   VALUES(pg_current_xact_id()::text,NEW.partition_no,TG_TABLE_NAME,NEW.erasure_key,NEW.transaction_id);
 END IF;
 RETURN NEW;
END; $$;
