-- unbound: bounded diagnostic sample of one advanced home; no subject or payload leaves the log.
SELECT position::text AS position, event_seq,
       CASE WHEN octet_length(type) <= 160 THEN type END AS kind
FROM core.outbox
WHERE partition_no = $1::integer AND position > $2::bigint AND position <= $3::bigint
ORDER BY core.outbox.position, event_seq
LIMIT 9;
