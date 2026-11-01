INSERT INTO semantic.identity_public_output_stage
(partition_no,capture_id,hold_id,binding_digest,original_receiving_epoch,kind,purpose,
 successor_hold_id,cancellation_epoch,manifest_digest,seal_transaction_id,native_epoch,native_position,transaction_id)
WITH parameters AS (SELECT $5::text AS kind,$11::integer AS epoch,$12::bigint AS position)
SELECT a.partition_no,a.capture_id,a.hold_id,a.binding_digest,g.original_epoch,
 (SELECT kind FROM parameters),$6,$7,$8,$9,$10,(SELECT epoch FROM parameters),(SELECT position FROM parameters),$13
FROM semantic.identity_public_output_accepted a
JOIN semantic.identity_public_output_gate g USING(partition_no,capture_id)
JOIN core.partition p ON p.partition_no=a.partition_no AND p.epoch=a.native_epoch
WHERE a.partition_no=$1 AND a.capture_id=$2 AND a.hold_id=$3 AND a.binding_digest=$4
 AND p.epoch=(SELECT epoch FROM parameters) AND p.position+1=(SELECT position FROM parameters)
 AND p.write_state='active' AND p.moved_to IS NULL
 AND g.state=(SELECT kind FROM parameters) AND g.enrolled_count=0 AND g.receiving_epoch=g.original_epoch+1
RETURNING capture_id;
