WITH fence AS (
 UPDATE core.partition SET position=position+1
 WHERE partition_no=:partition_no AND epoch=:owner_epoch AND write_state='active' AND moved_to IS NULL
 RETURNING epoch,position
), completed AS (
 UPDATE library.native_source_capture SET complete=true
 WHERE route=:route AND capture_id=:capture_id AND driver='done' AND NOT complete AND EXISTS(SELECT 1 FROM fence)
 RETURNING route,capture_id
)
INSERT INTO library.native_source_receipt(route,capture_id,transaction_id,owner_epoch,position)
SELECT c.route,c.capture_id,:transaction_id,f.epoch,f.position FROM completed c CROSS JOIN fence f
RETURNING transaction_id::text AS "transactionId",position::text AS position;
