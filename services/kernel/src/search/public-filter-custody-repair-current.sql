SELECT repair_settlement FROM search.public_filter_execution
WHERE (partition_no,observation,id)=(:partition_no::integer,:observation::text,:execution::text) LIMIT 1;
