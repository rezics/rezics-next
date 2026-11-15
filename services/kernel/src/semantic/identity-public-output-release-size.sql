SELECT octet_length(body::text)+2048 AS bytes FROM semantic.definition_release
WHERE route=0 AND digest=$1;
