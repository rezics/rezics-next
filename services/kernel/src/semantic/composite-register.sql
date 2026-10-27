INSERT INTO semantic.release_composite (digest, parent_digest, extension_route, extension_context_id, extension_digest)
VALUES (:digest::text, :parent_digest::text, :extension_route::integer, :extension_context_id::uuid, :extension_digest::text)
ON CONFLICT (digest) DO NOTHING;
