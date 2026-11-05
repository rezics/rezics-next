SELECT activation_id::text,previous_root,expected_head,state,closed_generation::text,closed_sequence::text,staged_sequence::text
FROM semantic.definition_catalogue_activation WHERE route=0 AND root_digest=:root::text LIMIT 1 FOR UPDATE;
