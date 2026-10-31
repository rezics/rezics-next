SELECT ordinal,intent FROM search.public_filter_repair_page
WHERE (partition_no,observation,execution)=(:partition_no::integer,:observation::text,:execution::text)
  AND has_repairs AND ordinal>:after::integer
ORDER BY ordinal LIMIT 1;
