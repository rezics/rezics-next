-- Exact next ordinary event: a missing sequence/position is a gap, never an empty home.
SELECT epoch, event_count, type, subject
FROM core.outbox
WHERE partition_no = $1 AND position = $2::bigint AND event_seq = $3;
