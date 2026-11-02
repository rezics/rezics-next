-- Cutover belongs to the actor source home, and is read before target checkout.
SELECT source_epoch, source_position
FROM content.reaction_projection_baseline
WHERE source_partition = :source_partition::integer;
