WITH fence AS (
 UPDATE core.partition SET position=position+1
 WHERE partition_no=:partition_no AND epoch=:owner_epoch AND write_state='active' AND moved_to IS NULL
 RETURNING partition_no,epoch,position
), completed AS (
 UPDATE library.native_source_capture SET complete=true
 WHERE route=:route AND capture_id=:capture_id AND driver='done' AND NOT complete AND EXISTS(SELECT 1 FROM fence)
 RETURNING route,capture_id
), receipt AS (
 INSERT INTO library.native_source_receipt(route,capture_id,transaction_id,owner_epoch,position)
 SELECT c.route,c.capture_id,:transaction_id,f.epoch,f.position FROM completed c CROSS JOIN fence f
 RETURNING transaction_id,owner_epoch,position
), append AS (
 INSERT INTO core.outbox(partition_no,position,event_seq,event_count,epoch,id,type,data)
 SELECT f.partition_no,r.position,0,1,r.owner_epoch,uuidv7(),'com.rezics.library.collection.source-capture-completed.v1','{}'
 FROM receipt r CROSS JOIN fence f
)
SELECT transaction_id::text AS "transactionId",position::text AS position FROM receipt;
