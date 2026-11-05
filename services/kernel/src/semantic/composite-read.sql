SELECT parent_digest, extension_route, extension_context_id, extension_digest
FROM semantic.release_composite
WHERE digest = :digest::text;
