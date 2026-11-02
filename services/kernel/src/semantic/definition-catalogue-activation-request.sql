WITH requested AS (
INSERT INTO semantic.definition_catalogue_activation(route,root_digest,activation_id,previous_root,expected_head,recorded_transaction_id)
VALUES(0,:root::text,:activation_id::uuid,:previous::nullable(text),:head::integer,:transaction_id::uuid)
ON CONFLICT DO NOTHING RETURNING activation_id::text
) SELECT activation_id FROM requested LIMIT 1;
