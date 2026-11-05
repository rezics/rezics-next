WITH parameters AS (SELECT $1::jsonb p1,$2::integer p2,$3::uuid p3)
INSERT INTO semantic.identity_epoch_mapping(route,original,terminal,epoch,origin,recorded_transaction_id,control_partition,control_group,source_revision,owner_epoch)
        SELECT r.route,r.original,r.terminal,r.mapping_epoch,'published',(SELECT p3 FROM parameters),
          (get_byte(uuid_send(r.terminal),10)*256+get_byte(uuid_send(r.terminal),11))/16,r.terminal,r.source_revision,(SELECT p2 FROM parameters)
        FROM jsonb_to_recordset((SELECT p1 FROM parameters)::jsonb) AS r(route integer,original uuid,terminal uuid,source_revision bigint,present boolean,mapping_epoch bigint)
        JOIN semantic.subject s ON (s.route,s.subject_id)=(r.route,r.original)
        LEFT JOIN semantic.identity_epoch_dirty d ON (d.route,d.original)=(r.route,r.original)
        WHERE r.present AND coalesce(d.revision,0)>=r.source_revision
        ON CONFLICT(route,original) DO UPDATE SET terminal=excluded.terminal,epoch=excluded.epoch,origin=excluded.origin,
          recorded_transaction_id=excluded.recorded_transaction_id,control_partition=excluded.control_partition,
          control_group=excluded.control_group,source_revision=excluded.source_revision,owner_epoch=excluded.owner_epoch;
