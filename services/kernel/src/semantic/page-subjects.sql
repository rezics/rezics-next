WITH input AS NOT MATERIALIZED (
  SELECT :partition_no::integer AS partition_no,
         :after_route::integer AS after_route,
         :after_id::uuid AS after_id,
         :limit::integer AS page_limit
), page AS (
  SELECT s.route, s.subject_id
  FROM semantic.subject AS s
  CROSS JOIN input
  WHERE s.route >= input.partition_no * 16
    AND s.route < (input.partition_no + 1) * 16
    AND (s.route, s.subject_id) > (input.after_route, input.after_id)
  ORDER BY s.route, s.subject_id
  LIMIT (SELECT page_limit FROM input)
)
SELECT page.route,
       page.subject_id::text AS id,
       f.slot_id::text AS slot_id,
       f.log_seq,
       f.operation,
       f.kind,
       f.language,
       f.property,
       f.statement_id::text AS statement_id,
       f.body
FROM page
CROSS JOIN input
LEFT JOIN semantic.fact AS f ON f.route = page.route AND f.subject_id = page.subject_id
  AND f.route >= input.partition_no * 16 AND f.route < (input.partition_no + 1) * 16
ORDER BY page.route, page.subject_id, f.slot_id, f.log_seq;
