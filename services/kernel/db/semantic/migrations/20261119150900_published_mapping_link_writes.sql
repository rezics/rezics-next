-- migrate:up
CREATE OR REPLACE FUNCTION semantic.guard_identity_epoch_mapping_links() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE r integer; id uuid;
BEGIN
 IF TG_OP='DELETE' THEN r:=OLD.route;id:=OLD.subject_id; ELSE r:=NEW.route;id:=NEW.subject_id; END IF;
 -- The subject lock orders a writer predating the fence with the first fence.
 PERFORM 1 FROM semantic.subject WHERE route=r AND subject_id=id FOR UPDATE;
 IF EXISTS (
   SELECT 1 FROM semantic.identity_epoch_mapping_fence f
   WHERE (f.route,f.destination)=(r,id)
     AND NOT semantic.identity_epoch_mapping_owns(r,id)
     AND (EXISTS (
       SELECT 1 FROM semantic.identity_epoch_admission_source_hold h
       WHERE (h.partition_no,h.route,h.original)=(r/16,r,id) AND NOT h.closed
     ) OR NOT EXISTS (
       -- The retained point still serializes future jobs. Ordinary link writes
       -- resume only after this exact native effect reached its published job.
       SELECT 1 FROM semantic.identity_epoch_mapping_effect e
       JOIN semantic.identity_epoch_native_commit n
         ON (n.partition_no,n.transaction_id)=(e.partition_no,e.transaction_id)
         AND n.xmin=e.xmin AND n.purpose='mapping'
       JOIN core.partition local_owner ON local_owner.partition_no=n.partition_no
         AND local_owner.epoch=n.epoch AND local_owner.position>=n.position
         AND local_owner.write_state='active' AND local_owner.moved_to IS NULL
       JOIN semantic.identity_epoch_job j
         ON j.partition_no=(get_byte(uuid_send(f.job_id),10)*256+get_byte(uuid_send(f.job_id),11))/16
         AND (j.job_id,j.epoch,j.scope_digest)=(e.job_id,e.job_epoch,e.scope_digest) AND j.state='published'
       JOIN semantic.identity_epoch_native_commit a
         ON (a.partition_no,a.transaction_id)=(j.partition_no,j.recorded_transaction_id) AND a.purpose='admission'
       JOIN core.partition control_owner ON control_owner.partition_no=a.partition_no
         AND control_owner.epoch=a.epoch AND control_owner.position>=a.position
         AND control_owner.write_state='active' AND control_owner.moved_to IS NULL
       JOIN semantic.identity_epoch_effect_receipt receipt
         ON (receipt.partition_no,receipt.job_id,receipt.step,receipt.effect_key)=(j.partition_no,j.job_id,'mapping',e.unit::text)
         AND (receipt.native_partition,receipt.native_epoch,receipt.native_position,receipt.native_transaction_id)=
             (n.partition_no,n.epoch,n.position,n.transaction_id)
       WHERE (e.partition_no,e.job_id,e.job_epoch,e.transaction_id)=(r/16,f.job_id,f.job_epoch,f.transaction_id)
         AND e.xmin=f.xmin
     ))
 )
 THEN RAISE EXCEPTION 'identity_epoch_unavailable'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END; $$;

-- migrate:down
CREATE OR REPLACE FUNCTION semantic.guard_identity_epoch_mapping_links() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE r integer; id uuid;
BEGIN
 IF TG_OP='DELETE' THEN r:=OLD.route;id:=OLD.subject_id; ELSE r:=NEW.route;id:=NEW.subject_id; END IF;
 -- The subject lock orders a writer predating the fence with the first fence.
 PERFORM 1 FROM semantic.subject WHERE route=r AND subject_id=id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM semantic.identity_epoch_mapping_fence WHERE route=r AND destination=id)
   AND NOT semantic.identity_epoch_mapping_owns(r,id)
 THEN RAISE EXCEPTION 'identity_epoch_unavailable'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END; $$;
