WITH input AS NOT MATERIALIZED (
 SELECT :route::integer AS route,:subject::uuid AS subject,:candidate::uuid AS candidate
)
SELECT c.revision::double precision AS revision,c.statement AS body
FROM semantic.candidate c CROSS JOIN input
WHERE c.route=input.route AND c.subject_id=input.subject AND c.candidate_id=input.candidate
UNION ALL
SELECT r.revision::double precision,f.body FROM semantic.fact f CROSS JOIN input
JOIN semantic.revision r ON r.route=f.route AND r.subject_id=f.subject_id
 AND r.recorded_transaction_id=f.recorded_transaction_id
WHERE f.route=input.route AND f.subject_id=input.subject AND f.statement_id=input.candidate
 AND f.kind='statement' AND f.operation='assert'
LIMIT 1;
