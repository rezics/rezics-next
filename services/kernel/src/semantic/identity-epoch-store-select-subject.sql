SELECT s.recorded_transaction_id source_transaction,m.*,
        coalesce(d.revision,0) dirty_revision,coalesce(d.captured_revision,0) captured_revision,
        r.target current_target FROM semantic.subject s
        LEFT JOIN semantic.identity_epoch_mapping m ON (m.route,m.original)=(s.route,s.subject_id)
        LEFT JOIN semantic.identity_epoch_dirty d ON (d.route,d.original)=(s.route,s.subject_id)
        LEFT JOIN LATERAL(SELECT target FROM semantic.redirect WHERE route=s.route AND subject_id=s.subject_id ORDER BY sequence DESC LIMIT 1) r ON true
        WHERE (s.route,s.subject_id)=($1,$2);
