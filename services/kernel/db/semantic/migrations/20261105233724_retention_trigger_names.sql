-- migrate:up
CREATE OR REPLACE FUNCTION semantic.capture_record_retention() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_kind text; v_owner_id uuid; v_record_id uuid; at timestamptz; deleted boolean; restarted boolean;
BEGIN
 IF TG_TABLE_NAME='record_lifecycle' THEN
  v_kind:='candidate';v_owner_id:=NEW.subject_id;v_record_id:=NEW.candidate_id;
  at:=NEW.deleted_at;deleted:=NEW.state IN ('deleted','purging');
 ELSIF TG_TABLE_NAME='context' THEN
  v_kind:='context';v_owner_id:=NEW.context_id;v_record_id:=NEW.context_id;
  at:=NEW.deleted_at;deleted:=NEW.state='deleted';
 ELSE
  v_kind:='zone';v_owner_id:=NEW.zone_id;v_record_id:=NEW.zone_id;
  at:=NEW.deleted_at;deleted:=NEW.state='deleted';
 END IF;
 restarted:=TG_OP='INSERT';
 IF TG_OP='UPDATE' THEN restarted:=NEW.state='deleted' AND OLD.state='active'; END IF;
 IF deleted THEN
  INSERT INTO semantic.record_retention_home(partition_no) VALUES(NEW.route/16) ON CONFLICT DO NOTHING;
  INSERT INTO semantic.record_retention_key(partition_no,route,kind,owner_id,record_id,deleted_at)
   VALUES(NEW.route/16,NEW.route,v_kind,v_owner_id,v_record_id,at)
   ON CONFLICT(route,kind,owner_id,record_id) DO UPDATE SET
    generation=CASE WHEN restarted OR record_retention_key.deleted_at<>EXCLUDED.deleted_at THEN gen_random_uuid() ELSE record_retention_key.generation END,
    phase=CASE WHEN restarted OR record_retention_key.deleted_at<>EXCLUDED.deleted_at THEN 'local' ELSE record_retention_key.phase END,
    fragment_store=CASE WHEN restarted OR record_retention_key.deleted_at<>EXCLUDED.deleted_at THEN 0 ELSE record_retention_key.fragment_store END,
    fragment_key=CASE WHEN restarted OR record_retention_key.deleted_at<>EXCLUDED.deleted_at THEN 0 ELSE record_retention_key.fragment_key END,
    deleted_at=EXCLUDED.deleted_at;
 END IF;
 RETURN NEW;
END; $$;

-- migrate:down
CREATE OR REPLACE FUNCTION semantic.capture_record_retention() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE kind text; owner_id uuid; record_id uuid; at timestamptz; deleted boolean; restarted boolean;
BEGIN
 IF TG_TABLE_NAME='record_lifecycle' THEN
  kind:='candidate';owner_id:=NEW.subject_id;record_id:=NEW.candidate_id;
  at:=NEW.deleted_at;deleted:=NEW.state IN ('deleted','purging');
 ELSIF TG_TABLE_NAME='context' THEN
  kind:='context';owner_id:=NEW.context_id;record_id:=NEW.context_id;
  at:=NEW.deleted_at;deleted:=NEW.state='deleted';
 ELSE
  kind:='zone';owner_id:=NEW.zone_id;record_id:=NEW.zone_id;
  at:=NEW.deleted_at;deleted:=NEW.state='deleted';
 END IF;
 restarted:=TG_OP='INSERT';
 IF TG_OP='UPDATE' THEN restarted:=NEW.state='deleted' AND OLD.state='active'; END IF;
 IF deleted THEN
  INSERT INTO semantic.record_retention_home(partition_no) VALUES(NEW.route/16) ON CONFLICT DO NOTHING;
  INSERT INTO semantic.record_retention_key(partition_no,route,kind,owner_id,record_id,deleted_at)
   VALUES(NEW.route/16,NEW.route,kind,owner_id,record_id,at)
   ON CONFLICT(route,kind,owner_id,record_id) DO UPDATE SET
    generation=CASE WHEN restarted OR record_retention_key.deleted_at<>EXCLUDED.deleted_at THEN gen_random_uuid() ELSE record_retention_key.generation END,
    phase=CASE WHEN restarted OR record_retention_key.deleted_at<>EXCLUDED.deleted_at THEN 'local' ELSE record_retention_key.phase END,
    fragment_store=CASE WHEN restarted OR record_retention_key.deleted_at<>EXCLUDED.deleted_at THEN 0 ELSE record_retention_key.fragment_store END,
    fragment_key=CASE WHEN restarted OR record_retention_key.deleted_at<>EXCLUDED.deleted_at THEN 0 ELSE record_retention_key.fragment_key END,
    deleted_at=EXCLUDED.deleted_at;
 END IF;
 RETURN NEW;
END; $$;
