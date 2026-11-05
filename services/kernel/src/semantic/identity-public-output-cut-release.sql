WITH parameters AS (SELECT $1::integer AS p1, $2::integer AS p2, $3::uuid AS p3, $4::uuid AS p4, $5::integer AS p5, $6::bigint AS p6, $7::uuid AS p7), d AS (
 UPDATE semantic.identity_public_output_subject_slot SET released=true
 WHERE partition_no=(SELECT p1 FROM parameters) AND capture_partition=(SELECT p2 FROM parameters) AND capture_id=(SELECT p3 FROM parameters) AND original=(SELECT p4 FROM parameters)
)
INSERT INTO semantic.identity_public_output_subject_release
(partition_no,capture_partition,capture_id,original,native_epoch,native_position,transaction_id)
VALUES((SELECT p1 FROM parameters),(SELECT p2 FROM parameters),(SELECT p3 FROM parameters),(SELECT p4 FROM parameters),(SELECT p5 FROM parameters),(SELECT p6 FROM parameters),(SELECT p7 FROM parameters));
