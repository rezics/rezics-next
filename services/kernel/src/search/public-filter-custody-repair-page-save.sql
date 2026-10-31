INSERT INTO search.public_filter_repair_page
(partition_no,observation,execution,ordinal,has_repairs,intent)
VALUES (:partition_no::integer,:observation::text,:execution::text,:ordinal::integer,:has_repairs::boolean,:intent::text)
ON CONFLICT DO NOTHING;
