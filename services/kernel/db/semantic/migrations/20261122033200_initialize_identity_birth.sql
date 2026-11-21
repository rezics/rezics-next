-- migrate:up
-- Birth is one command on one native home. Each statement observes the preceding
-- write, including its triggers, before the next record is enrolled.
CREATE FUNCTION semantic.initialize_identity_birth(subject_route integer, subject uuid)
RETURNS TABLE(status text, source_transaction uuid) LANGUAGE plpgsql AS $$
DECLARE
  home integer := subject_route / 16;
  home_epoch integer;
  previous record;
  group_generation uuid;
  group_epoch bigint;
BEGIN
  SELECT s.recorded_transaction_id INTO source_transaction
  FROM semantic.subject s JOIN semantic.revision r ON (r.route,r.subject_id,r.revision)=(s.route,s.subject_id,1)
  WHERE (s.route,s.subject_id)=(subject_route,subject) AND r.kind='create'
    AND s.recorded_transaction_id=r.recorded_transaction_id
    AND s.xmin::text=pg_current_xact_id()::text AND r.xmin::text=pg_current_xact_id()::text
    AND NOT EXISTS(SELECT 1 FROM semantic.revision later
      WHERE (later.route,later.subject_id)=(subject_route,subject) AND later.revision>1)
    AND NOT EXISTS(SELECT 1 FROM semantic.redirect d WHERE (d.route,d.subject_id)=(subject_route,subject));
  IF NOT FOUND THEN status:='missing'; RETURN NEXT; RETURN; END IF;

  SELECT p.epoch INTO home_epoch FROM core.partition p WHERE p.partition_no=home AND p.write_state='active';
  IF NOT FOUND THEN status:='unavailable'; RETURN NEXT; RETURN; END IF;
  SELECT m.terminal,m.owner_epoch,m.epoch,m.origin,m.recorded_transaction_id,
    g.recorded_transaction_id AS gate_transaction,g.pending_job,g.pending_epoch INTO previous
  FROM semantic.identity_epoch_mapping m LEFT JOIN semantic.identity_epoch_home_gate g
    ON (g.route,g.destination,g.original)=(m.route,m.original,m.original)
  WHERE (m.route,m.original)=(subject_route,subject);
  IF FOUND THEN
    status:=CASE WHEN previous.terminal=subject AND previous.owner_epoch=home_epoch AND previous.epoch>0
      AND previous.origin='creation' AND previous.recorded_transaction_id=source_transaction
      AND previous.gate_transaction=source_transaction AND previous.pending_job IS NULL AND previous.pending_epoch IS NULL
      THEN 'existing' ELSE 'conflict' END;
    RETURN NEXT; RETURN;
  END IF;

  INSERT INTO semantic.identity_epoch_group(partition_no,terminal,observed_count,generation,ready,owner_epoch)
    VALUES(home,subject,1,gen_random_uuid(),true,home_epoch) RETURNING generation,published_epoch INTO group_generation,group_epoch;
  IF NOT FOUND THEN status:='unavailable'; RETURN NEXT; RETURN; END IF;
  INSERT INTO semantic.identity_epoch_mapping
    (route,original,terminal,epoch,origin,recorded_transaction_id,control_partition,control_group,owner_epoch,source_revision)
    VALUES(subject_route,subject,subject,group_epoch,'creation',source_transaction,home,subject,home_epoch,
      (SELECT d.revision FROM semantic.identity_epoch_dirty d WHERE (d.route,d.original)=(subject_route,subject)));
  INSERT INTO semantic.identity_epoch_home_gate(route,destination,original,terminal,epoch,recorded_transaction_id)
    VALUES(subject_route,subject,subject,subject,group_epoch,source_transaction);
  INSERT INTO semantic.identity_epoch_original(partition_no,generation,original,terminal,source_partition,source_generation,present)
    VALUES(home,group_generation,subject,subject,home,0,true);
  UPDATE semantic.identity_epoch_dirty d SET captured_revision=d.revision WHERE (d.route,d.original)=(subject_route,subject);
  status:='created'; RETURN NEXT;
END $$;

-- migrate:down
DROP FUNCTION semantic.initialize_identity_birth(integer,uuid);
