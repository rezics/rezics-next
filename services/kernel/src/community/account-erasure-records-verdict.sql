UPDATE community.publication SET actor = NULL
WHERE route = :owner_route::integer AND publication_id = :owner_id::uuid AND actor = :account_id::uuid
RETURNING publication_id;
