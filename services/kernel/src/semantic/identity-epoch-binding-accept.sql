WITH parameters AS (SELECT $4::uuid p4,$5::bigint p5)
UPDATE semantic.identity_epoch_receipt_binding b SET state='accepted',accepted_job=(SELECT p4 FROM parameters),accepted_epoch=(SELECT p5 FROM parameters)
WHERE b.partition_no=$1 AND b.receipt_key=$2 AND b.generation=$3 AND b.state IN ('pending','accepted')
 AND (b.accepted_job IS NULL OR (b.accepted_job,b.accepted_epoch)=((SELECT p4 FROM parameters)::uuid,(SELECT p5 FROM parameters)::bigint));
