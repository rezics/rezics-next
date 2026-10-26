-- Read reaction totals for thread IDs routed to one source partition.
WITH input AS NOT MATERIALIZED (
  SELECT :partition::integer AS partition
),
requested AS MATERIALIZED (
  SELECT item.route, item.thread_id
  FROM jsonb_to_recordset(:threads::jsonb) AS item(route integer, thread_id uuid)
  CROSS JOIN input
  WHERE item.route >= input.partition * 16
    AND item.route < (input.partition + 1) * 16
)
SELECT totals.target_id::text AS thread_id, totals.kind, totals.count
FROM requested
JOIN LATERAL (
  SELECT stored.target_id, stored.kind, stored.count
  FROM content.reaction_total AS stored CROSS JOIN input
  WHERE stored.route >= input.partition * 16
    AND stored.route < (input.partition + 1) * 16
    AND stored.route = requested.route
    AND stored.target_id = requested.thread_id
) AS totals ON true;
