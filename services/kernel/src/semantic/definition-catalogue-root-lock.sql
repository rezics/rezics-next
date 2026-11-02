SELECT protocol,state,generation::text,last_sequence::text,closed_generation::text,closed_sequence::text
FROM semantic.definition_catalogue_enrollment WHERE route=0 AND root_digest=:root::text LIMIT 1 FOR UPDATE;
