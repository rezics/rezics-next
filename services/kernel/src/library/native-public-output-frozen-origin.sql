SELECT generation::text,transaction_id::text AS "transactionId",activation_position::text AS position,
 native_xid AS "nativeXid",source_generation::text AS "sourceGeneration",
 member_fence::text AS "memberFence",members::text,incarnation,epoch,current_position::text AS "currentPosition"
FROM library.frozen_public_output_origin($1,$2,$3);
