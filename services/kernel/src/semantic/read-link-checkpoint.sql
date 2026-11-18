-- A session and the Subject anchor can require two positions from the same home.
WITH behind AS (
  SELECT seen.partition_no, seen.epoch, seen.position,
         checkpoint.epoch AS checkpoint_epoch, checkpoint.position AS checkpoint_position
  FROM unnest(:partitions::integer[], :epochs::integer[], :positions::bigint[])
       WITH ORDINALITY AS seen(partition_no, epoch, position, ordinal)
  LEFT JOIN LATERAL (
    SELECT c.epoch, c.position FROM core.consumer_checkpoint AS c
    WHERE c.partition_no = seen.partition_no AND c.consumer = :consumer::text
    LIMIT 1
  ) AS checkpoint ON true
  WHERE checkpoint.epoch IS NULL OR (checkpoint.epoch, checkpoint.position) < (seen.epoch, seen.position)
  ORDER BY seen.ordinal
  LIMIT 1
)
SELECT behind.*, observation.*
FROM behind
-- Only the marked catalogue GET observes the missing row's owner in the refusing snapshot.
LEFT JOIN LATERAL (
  SELECT owner.write_state AS owner_state, owner.epoch AS owner_epoch, owner.position AS owner_position,
         owner.position < behind.position AS owner_behind,
         first_event.event_seq IS NOT NULL AS first_present, scan.consumer IS NOT NULL AS scan_recorded,
         scan.observed_at >= first_event.recorded_at AS scan_since_first,
         effects.partition_no IS NOT NULL AS effects_registered,
         (effects.epoch, effects.position) >= (behind.epoch, behind.position) AS effects_covers
  FROM (VALUES (behind.partition_no)) AS required(home)
  LEFT JOIN core.partition AS owner ON owner.partition_no = required.home
  LEFT JOIN core.outbox AS first_event
    ON first_event.partition_no = required.home AND first_event.position = 1 AND first_event.event_seq = 0
  LEFT JOIN core.consumer_lag AS scan ON scan.consumer = :consumer::text
  LEFT JOIN core.consumer_checkpoint AS effects ON effects.partition_no = required.home AND effects.consumer = 'effects'
  WHERE :observe_missing::boolean AND behind.checkpoint_position IS NULL AND behind.position > 0
  LIMIT 1
) AS observation ON true
LIMIT 1;
