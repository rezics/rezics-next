INSERT INTO semantic.definition_catalogue_ticket(route,original_key,slot,kind,allowance)
SELECT 0,:original_key::text,:slot::integer,:kind::text,:allowance::text::bigint[]
RETURNING slot;
