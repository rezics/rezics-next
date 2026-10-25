WITH input AS NOT MATERIALIZED (
  SELECT :delta::integer AS delta, :source_epoch::integer AS source_epoch, :source_position::bigint AS source_position
)
UPDATE content.reaction_count AS stored
SET count = GREATEST(stored.count + input.delta, 0),
    source_epoch = input.source_epoch,
    source_position = input.source_position
FROM input
WHERE stored.route = :route::integer
  AND stored.target_id = :target_id::uuid
  AND stored.source_partition = :source_partition::integer
  AND stored.kind = :kind::text
  AND (stored.source_epoch, stored.source_position) < (input.source_epoch, input.source_position);
