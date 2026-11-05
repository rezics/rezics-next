WITH parameters AS (SELECT $1::integer AS p1, $2::uuid AS p2, $3::uuid AS p3, $4::integer AS p4, $5::uuid AS p5, $6::text AS p6, $7::text AS p7, $8::text AS p8)
SELECT 1 WHERE EXISTS (
 SELECT 1 FROM semantic.identity_epoch_prearm_inverse WHERE partition_no=(SELECT p1 FROM parameters) AND generation=(SELECT p2 FROM parameters) AND original=(SELECT p3 FROM parameters)
 AND source_partition=(SELECT p4 FROM parameters) AND capture_id=(SELECT p5 FROM parameters)::text AND registration=(SELECT p6 FROM parameters) AND scope_key=(SELECT p7 FROM parameters)
) OR EXISTS (
 SELECT 1 FROM semantic.identity_scope_inverse WHERE partition_no=(SELECT p1 FROM parameters) AND generation=(SELECT p2 FROM parameters) AND original=(SELECT p3 FROM parameters)
 AND source_partition=(SELECT p4 FROM parameters) AND capture_id=(SELECT p5 FROM parameters) AND registration=(SELECT p6 FROM parameters)::uuid AND source_key=(SELECT p8 FROM parameters)
);
