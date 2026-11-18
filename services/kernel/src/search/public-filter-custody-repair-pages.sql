WITH next_page AS MATERIALIZED (
  SELECT partition_no,observation,execution,ordinal,intent FROM search.public_filter_repair_page
  WHERE (partition_no,observation,execution)=(:partition_no::integer,:observation::text,:execution::text)
    AND has_repairs AND ordinal>:after::integer
  ORDER BY ordinal LIMIT :width::integer
)
SELECT n.ordinal,n.intent,p.intent AS previous_intent FROM next_page n
LEFT JOIN LATERAL (
  SELECT intent FROM search.public_filter_repair_page
  WHERE (partition_no,observation,execution,ordinal)=
    (n.partition_no,n.observation,n.execution,n.ordinal-1) AND n.ordinal>0
  OFFSET 0
) p ON true
ORDER BY n.ordinal;
