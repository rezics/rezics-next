WITH next_page AS MATERIALIZED (
  SELECT partition_no,observation,execution,ordinal,intent FROM search.public_filter_repair_page
  WHERE (partition_no,observation,execution)=(:partition_no::integer,:observation::text,:execution::text)
    AND has_repairs AND ordinal>:after::integer
  ORDER BY ordinal LIMIT 1
)
SELECT n.ordinal,n.intent,p.intent AS previous_intent FROM next_page n
LEFT JOIN search.public_filter_repair_page p ON (p.partition_no,p.observation,p.execution,p.ordinal)=
  (n.partition_no,n.observation,n.execution,n.ordinal-1) AND n.ordinal>0;
