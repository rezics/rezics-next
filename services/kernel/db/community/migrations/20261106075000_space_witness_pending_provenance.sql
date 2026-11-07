-- migrate:up
-- Pending work keeps its own provenance. Reference removals use the locked witness
-- epoch and position; the reference table has neither column. Qualify the intended
-- Space and Realm heads so a missing revision row cannot advance the witness.
CREATE OR REPLACE FUNCTION community.refresh_space_discovery_tuple_witness(r integer, id uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE current_space_revision uuid; current_realm_id uuid; current_realm_revision uuid;
        current_state text; p integer; next_generation bigint;
        old_producer_epoch numeric(20,0); old_source_position numeric(20,0);
BEGIN
  SELECT s.head_revision_id, h.realm_id, h.head_revision_id
    INTO current_space_revision, current_realm_id, current_realm_revision
    FROM community.space s
    JOIN community.space_revision sv
      ON sv.route=s.route AND sv.space_id=s.space_id AND sv.revision_id=s.head_revision_id
    LEFT JOIN community.realm h ON h.route=s.route AND h.space_id=s.space_id
    LEFT JOIN community.realm_revision hv
      ON hv.route=h.route AND hv.realm_id=h.realm_id AND hv.revision_id=h.head_revision_id
    WHERE s.route=r AND s.space_id=id
      AND (h.realm_id IS NULL OR hv.revision_id IS NOT NULL);
  IF NOT FOUND THEN RETURN; END IF;
  p := r / 16;
  -- Locked committed witness provenance, read before any advance. Reference removals use it.
  SELECT state,producer_epoch,source_position INTO current_state,old_producer_epoch,old_source_position
    FROM community.space_discovery_tuple_witness
    WHERE route=r AND space_id=id FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO community.space_discovery_tuple_witness
      (route,space_id,space_revision,realm_id,realm_revision,state)
    VALUES(r,id,current_space_revision,current_realm_id,current_realm_revision,'unavailable');
    UPDATE community.space_discovery_tuple_capability
      SET required=required+1,pending=pending+1,cut=cut+1 WHERE partition_no=p;
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM community.space_discovery_tuple_witness
    WHERE route=r AND space_id=id
      AND (space_revision IS DISTINCT FROM current_space_revision
        OR realm_id IS DISTINCT FROM current_realm_id
        OR realm_revision IS DISTINCT FROM current_realm_revision)
  ) THEN
    next_generation := nextval('community.space_discovery_tuple_witness_key');
    IF current_state='ready' THEN
      UPDATE community.space_discovery_tuple_capability
        SET witnessed=witnessed-1,pending=pending+1,cut=cut+1 WHERE partition_no=p;
    ELSE
      UPDATE community.space_discovery_tuple_capability
        SET cut=cut+1 WHERE partition_no=p;
    END IF;
    UPDATE community.space_discovery_tuple_witness
      SET witness_generation=next_generation,
          space_revision=current_space_revision,realm_id=current_realm_id,
          realm_revision=current_realm_revision,
          tuple_count=0,state='unavailable'
      WHERE route=r AND space_id=id;
    DELETE FROM community.space_discovery_tuple_expected WHERE route=r AND space_id=id;
    -- Pending work owns its provenance: each pending tuple is removed with the epoch and position it carries.
    INSERT INTO community.space_discovery_tuple_work
      (route,space_id,witness_generation,tuple_route,source,external_id,field_group,action,producer_epoch,source_position)
    SELECT r,id,next_generation,pending.tuple_route,pending.source,pending.external_id,pending.field_group,'remove',
           pending.producer_epoch,pending.source_position
      FROM community.space_discovery_tuple_work pending
      WHERE pending.route=r AND pending.space_id=id
    ON CONFLICT DO NOTHING;
    -- Reference removals carry the locked old committed witness epoch and position, never a column they lack.
    INSERT INTO community.space_discovery_tuple_work
      (route,space_id,witness_generation,tuple_route,source,external_id,field_group,action,producer_epoch,source_position)
    SELECT r,id,next_generation,ref.tuple_route,ref.source,ref.external_id,ref.field_group,'remove',
           old_producer_epoch,old_source_position
      FROM community.space_discovery_tuple_reference ref
      WHERE ref.route=r AND ref.space_id=id
    ON CONFLICT DO NOTHING;
    DELETE FROM community.space_discovery_tuple_work WHERE route=r AND space_id=id
      AND witness_generation<>next_generation;
  END IF;
END;
$$;

-- migrate:down
-- Forward only: later migrations must keep pending-work provenance and locked witness reference removals.
