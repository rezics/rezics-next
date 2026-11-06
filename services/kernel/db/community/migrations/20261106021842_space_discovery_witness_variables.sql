-- migrate:up
-- The fence declared local variables named like the witness columns it selects, so each
-- column reference in its statements was ambiguous. Renaming only the locals keeps the
-- fence semantics and changes no stored row.
CREATE OR REPLACE FUNCTION community.refresh_space_discovery_tuple_witness(r integer, id uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE current_space_revision uuid; current_realm_id uuid; current_realm_revision uuid;
        current_state text; p integer; next_generation bigint; witness_producer_epoch numeric(20,0);
        witness_source_position numeric(20,0);
BEGIN
  SELECT s.head_revision_id, h.realm_id, h.head_revision_id
    INTO current_space_revision, current_realm_id, current_realm_revision
    FROM community.space s
    LEFT JOIN community.realm h ON h.route=s.route AND h.space_id=s.space_id
    WHERE s.route=r AND s.space_id=id;
  IF NOT FOUND THEN RETURN; END IF;
  p := r / 16;
  SELECT state,producer_epoch,source_position INTO current_state,witness_producer_epoch,witness_source_position
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
    INSERT INTO community.space_discovery_tuple_work
      (route,space_id,witness_generation,tuple_route,source,external_id,field_group,action,producer_epoch,source_position)
    SELECT r,id,next_generation,old.tuple_route,old.source,old.external_id,old.field_group,'remove',
           old.producer_epoch,old.source_position
      FROM (
        SELECT tuple_route,source,external_id,field_group,producer_epoch,source_position
          FROM community.space_discovery_tuple_reference WHERE route=r AND space_id=id
        UNION
        SELECT tuple_route,source,external_id,field_group,producer_epoch,source_position
          FROM community.space_discovery_tuple_work WHERE route=r AND space_id=id
      ) old
    ON CONFLICT DO NOTHING;
    DELETE FROM community.space_discovery_tuple_work WHERE route=r AND space_id=id
      AND witness_generation<>next_generation;
  END IF;
END;
$$;

-- migrate:down
-- Forward only: the corrected fence retains every stored witness and tuple.
