-- Linkage has already been verified under the same evidence revision. Only
-- effect-bearing pages and the final Source seal need foreign verification.
WITH input AS (
  SELECT :partition_no::integer AS home,:observation::text AS observation,:execution::text AS execution
), next_page AS MATERIALIZED (
  SELECT p.ordinal,p.intent FROM search.public_filter_repair_page p CROSS JOIN input i
  WHERE (p.partition_no,p.observation,p.execution)=(i.home,i.observation,i.execution)
    AND p.has_repairs AND p.ordinal>:after::integer
  ORDER BY p.ordinal LIMIT 1
), selected AS (
  SELECT ordinal,intent FROM next_page
  UNION ALL
  SELECT p.ordinal,p.intent FROM search.public_filter_repair_page p CROSS JOIN input i
  WHERE (p.partition_no,p.observation,p.execution,p.ordinal)=(i.home,i.observation,i.execution,:terminal::integer)
    AND NOT EXISTS (SELECT 1 FROM next_page)
)
SELECT ordinal,intent FROM selected LIMIT 1;
