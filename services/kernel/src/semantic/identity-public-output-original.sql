WITH parameters AS (SELECT $1::integer AS p1, $2::uuid AS p2, $3::jsonb AS p3), input AS (SELECT * FROM jsonb_to_recordset((SELECT p3 FROM parameters)::jsonb) AS x(original uuid,terminal uuid,epoch text)),
originals AS (
 INSERT INTO semantic.identity_public_output_original(partition_no,capture_id,original,terminal,mapping_epoch)
 SELECT (SELECT p1 FROM parameters),(SELECT p2 FROM parameters),original,terminal,epoch::bigint FROM input ON CONFLICT DO NOTHING RETURNING original
)
INSERT INTO semantic.identity_public_output_member(partition_no,capture_id,terminal)
SELECT DISTINCT (SELECT p1 FROM parameters),(SELECT p2 FROM parameters),terminal FROM input ON CONFLICT DO NOTHING RETURNING terminal;
