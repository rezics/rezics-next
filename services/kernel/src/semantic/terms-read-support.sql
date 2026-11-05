SELECT h.kind,h.language,r.revision,r.source
FROM jsonb_to_recordset(:entries::jsonb) entry(kind text,language text)
JOIN semantic.term_head h ON h.route=:route::integer AND h.subject_id=:subject_id::uuid
 AND h.kind=entry.kind AND h.language=entry.language
JOIN LATERAL (
 SELECT revision,source FROM semantic.revision r
 WHERE r.route=h.route AND r.subject_id=h.subject_id AND r.recorded_transaction_id=h.support_transaction_id
 LIMIT 1
) r ON true;
