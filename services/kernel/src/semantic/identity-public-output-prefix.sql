WITH parameters AS (SELECT $1::integer AS p1, $2::uuid AS p2, $3::uuid AS p3, $4::integer AS p4)
SELECT terminal::text FROM semantic.identity_public_output_member
WHERE partition_no=(SELECT p1 FROM parameters) AND capture_id=(SELECT p2 FROM parameters) AND ((SELECT p3 FROM parameters)::uuid IS NULL OR terminal>(SELECT p3 FROM parameters)::uuid)
ORDER BY terminal LIMIT (SELECT p4 FROM parameters);
