INSERT INTO semantic.identity_epoch_mapping(route,original,terminal,epoch,origin,recorded_transaction_id,control_partition,control_group,source_revision,owner_epoch)
        SELECT r.route,r.original,r.terminal,$2,'published',$3,
          (get_byte(uuid_send(r.terminal),10)*256+get_byte(uuid_send(r.terminal),11))/16,r.terminal,r.source_revision,$2
        FROM jsonb_to_recordset($1::jsonb) AS r(route integer,original uuid,terminal uuid,source_revision bigint,present boolean)
        JOIN semantic.subject s ON (s.route,s.subject_id)=(r.route,r.original)
        LEFT JOIN semantic.identity_epoch_dirty d ON (d.route,d.original)=(r.route,r.original)
        WHERE r.present AND coalesce(d.revision,0)=r.source_revision
        ON CONFLICT(route,original) DO UPDATE SET terminal=excluded.terminal,epoch=excluded.epoch,origin=excluded.origin,
          recorded_transaction_id=excluded.recorded_transaction_id,control_partition=excluded.control_partition,
          control_group=excluded.control_group,source_revision=excluded.source_revision,owner_epoch=excluded.owner_epoch;
