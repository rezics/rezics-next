SELECT intent FROM search.public_filter_repair_page
WHERE (partition_no,observation,execution,ordinal)=(:partition_no::integer,:observation::text,:execution::text,:ordinal::integer) LIMIT 1;
