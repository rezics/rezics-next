WITH input AS NOT MATERIALIZED (SELECT :route::integer AS route, :delta::integer AS delta)
UPDATE library.collection collection
SET member_count=member_count+input.delta, source_generation=source_generation+1,
    revision=revision+1, order_epoch=order_epoch+:respace::integer,
    updated_at=:time::timestamptz, transaction_id=:transaction_id::uuid
FROM input
WHERE collection.route=input.route AND collection.collection_id=:collection_id::uuid
  AND collection.state='active' AND collection.revision=:revision::integer
  AND collection.member_count::bigint+input.delta BETWEEN 0 AND 2147483647
RETURNING collection.collection_id AS id;
