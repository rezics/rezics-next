UPDATE semantic.definition_catalogue_activation SET native_position=native_position+1,state='closing'
WHERE route=0 AND root_digest=:root::text AND activation_id=:activation_id::uuid AND state='ready';
