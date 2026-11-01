INSERT INTO library.native_public_output_hold
 (partition_no,capture_id,hold_id,role,route,collection_id,incarnation,output_generation,
  activation_transaction_id,activation_position,activation_source_generation,transaction_id)
SELECT partition_no,capture_id,$3,$5,
       route,collection_id,incarnation,output_generation,
       activation_transaction_id,activation_position,activation_source_generation,$4
FROM library.native_public_output_binding WHERE partition_no=$1 AND capture_id=$2;
