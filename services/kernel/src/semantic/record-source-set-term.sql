SELECT r.revision::double precision AS revision
FROM semantic.fact f JOIN semantic.revision r
 ON r.route=f.route AND r.subject_id=f.subject_id AND r.recorded_transaction_id=f.recorded_transaction_id
WHERE f.route=:route::integer AND f.subject_id=:subject::uuid AND f.kind=:kind::text AND f.language=:language::text
ORDER BY f.log_seq DESC LIMIT 1;
