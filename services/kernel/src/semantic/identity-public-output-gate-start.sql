INSERT INTO semantic.identity_public_output_gate(partition_no,capture_id,original_epoch,receiving_epoch)
WITH parameters AS (SELECT $3::bigint AS receiving_epoch)
SELECT $1,$2,receiving_epoch,receiving_epoch FROM parameters;
