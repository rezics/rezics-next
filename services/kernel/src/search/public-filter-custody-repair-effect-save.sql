INSERT INTO search.public_filter_repair_effect
(partition_no,observation,execution,page,item,receipt)
VALUES (:partition_no::integer,:observation::text,:execution::text,:page::integer,:item::integer,:receipt::text)
ON CONFLICT DO NOTHING;
