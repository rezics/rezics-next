UPDATE search.public_filter_execution SET repair_settlement=:next::text
WHERE (partition_no,observation,id)=(:partition_no::integer,:observation::text,:execution::text)
  AND repair_settlement=:previous::text RETURNING id;
