WITH parameters AS (SELECT $1::integer AS p1, $2::uuid AS p2, $3::uuid AS p3, $4::text AS p4, $5::text AS p5, $6::jsonb AS p6, $7::text AS p7, $8::integer AS p8, $9::integer AS p9, $10::uuid AS p10, $11::text AS p11, $12::jsonb AS p12, $13::uuid AS p13, $14::bigint AS p14, $15::bigint AS p15, $16::integer AS p16), native_inverse AS (
 INSERT INTO semantic.identity_epoch_prearm_inverse
 (partition_no,generation,original,scope_key,registration,scope,capture_id,source_partition,source_owner_epoch,transaction_id)
 VALUES((SELECT p1 FROM parameters),(SELECT p2 FROM parameters),(SELECT p3 FROM parameters),(SELECT p4 FROM parameters),(SELECT p5 FROM parameters),(SELECT p6 FROM parameters)::jsonb,(SELECT p7 FROM parameters),(SELECT p8 FROM parameters),(SELECT p9 FROM parameters),(SELECT p10 FROM parameters)) ON CONFLICT DO NOTHING
) , bridge_version AS (
 UPDATE semantic.identity_scope_bridge SET version=version+1
 WHERE partition_no=(SELECT p1 FROM parameters) AND generation=(SELECT p2 FROM parameters)
), scoped_inverse AS (
 INSERT INTO semantic.identity_scope_inverse
 (partition_no,generation,original,source_partition,source_key,scope_id,registration,capture_id,source,transaction_id)
 VALUES((SELECT p1 FROM parameters),(SELECT p2 FROM parameters),(SELECT p3 FROM parameters),(SELECT p8 FROM parameters),(SELECT p11 FROM parameters),(SELECT p7 FROM parameters),(SELECT p5 FROM parameters)::uuid,(SELECT p7 FROM parameters)::uuid,(SELECT p12 FROM parameters)::jsonb,(SELECT p10 FROM parameters)) ON CONFLICT DO NOTHING
)
INSERT INTO semantic.identity_public_output_subject_cut
(partition_no,capture_partition,capture_id,original,generation,terminal,mapping_epoch,scope_key,registration,
 native_epoch,native_position,transaction_id)
VALUES((SELECT p1 FROM parameters),(SELECT p8 FROM parameters),(SELECT p7 FROM parameters)::uuid,(SELECT p3 FROM parameters),(SELECT p2 FROM parameters),(SELECT p13 FROM parameters),(SELECT p14 FROM parameters),(SELECT p11 FROM parameters),(SELECT p5 FROM parameters)::uuid,(SELECT p16 FROM parameters),(SELECT p15 FROM parameters),(SELECT p10 FROM parameters));
