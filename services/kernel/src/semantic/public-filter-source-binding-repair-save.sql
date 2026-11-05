INSERT INTO semantic.public_filter_repair_step
  (partition_no,bootstrap,execution,step,predecessor,state,complete,input_limit,receipt_protocol,repair_locator_digests)
SELECT b.partition_no,b.bootstrap,:execution::text,:step::uuid,NULLIF(:predecessor::text, '')::uuid,:state::text,:complete::boolean,:input_limit::integer,1,:repair_locator_digests::bytea
FROM semantic.public_filter_bootstrap b JOIN core.partition p ON p.partition_no = b.partition_no
WHERE b.partition_no = 0 AND b.bootstrap = :bootstrap::uuid AND b.state = 'adopted'
  AND b.owner_epoch = p.epoch AND p.write_state = 'active'
ON CONFLICT DO NOTHING
RETURNING step::text;
