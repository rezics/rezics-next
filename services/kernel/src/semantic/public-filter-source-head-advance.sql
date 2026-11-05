WITH input AS (
  SELECT :partition_no::integer AS partition_no, :owner_epoch::integer AS owner_epoch
)
UPDATE semantic.public_filter_privacy_head head
SET position = head.position + 1
FROM input
WHERE head.partition_no = input.partition_no
  AND EXISTS (
    SELECT 1 FROM core.partition p
    WHERE p.partition_no = input.partition_no AND p.epoch = input.owner_epoch
      AND p.write_state = 'active'
  )
RETURNING head.position::text;
