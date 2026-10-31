SELECT receipt FROM search.public_filter_repair_effect
WHERE (partition_no,observation,execution,page,item)=(:partition_no::integer,:observation::text,:execution::text,:page::integer,:item::integer) LIMIT 1;
