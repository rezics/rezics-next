UPDATE semantic.definition_catalogue_activation
SET native_position=native_position+1,state='invalidating',closed_generation=:generation::text::bigint,closed_sequence=:sequence::text::bigint
WHERE route=0 AND root_digest=:root::text AND activation_id=:activation_id::uuid AND state='closing';
