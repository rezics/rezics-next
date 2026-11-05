SELECT state, complete, predecessor::text, input_limit, receipt_protocol,
       encode(repair_locator_digests,'hex') AS repair_locator_digests
FROM semantic.public_filter_repair_step
WHERE partition_no = 0 AND bootstrap = :bootstrap::uuid AND execution = :execution::text AND step = :step::uuid;
