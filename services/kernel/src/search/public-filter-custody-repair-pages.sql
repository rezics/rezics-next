SELECT ordinal,intent FROM search.public_filter_repair_page
WHERE (partition_no,observation,execution)=($1,$2,$3) AND has_repairs
ORDER BY ordinal LIMIT 1001
