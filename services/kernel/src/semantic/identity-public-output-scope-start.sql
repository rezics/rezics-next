WITH parameters AS (SELECT $1::integer AS p1, $2::text AS p2, $3::text AS p3, $4::jsonb AS p4, $5::uuid AS p5, $6::jsonb AS p6)
INSERT INTO semantic.identity_scope_summary
(partition_no,source_key,scope_id,source,registration,capture_id,capture,state,scan_complete)
VALUES((SELECT p1 FROM parameters),(SELECT p2 FROM parameters),(SELECT p3 FROM parameters),(SELECT p4 FROM parameters)::jsonb,(SELECT p5 FROM parameters),(SELECT p3 FROM parameters)::uuid,(SELECT p6 FROM parameters)::jsonb,'capturing',false);
