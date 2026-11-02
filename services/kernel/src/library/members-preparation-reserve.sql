WITH input AS NOT MATERIALIZED (SELECT :route::integer AS route, :owner_account_id::uuid AS owner_account_id,
  :collection_id::uuid AS collection_id),
retired AS (
  UPDATE library.members_preparation AS h SET state = 'retired'
  FROM unnest(:retired_collections::uuid[], :retired_episodes::uuid[]) AS old(collection_id, episode_id)
  WHERE h.route = (SELECT route FROM input) AND h.owner_account_id = (SELECT owner_account_id FROM input)
    AND h.collection_id = old.collection_id AND h.episode_id = old.episode_id AND h.state = 'live'
  RETURNING h.collection_id, h.episode_id
), inserted AS (
  INSERT INTO library.members_preparation
    (route, owner_account_id, collection_id, episode_id, reserved_incarnation, reserved_generation, canonical_basis, basis_digest, state, last_read_at, workflow_id)
  SELECT (SELECT route FROM input), (SELECT owner_account_id FROM input), (SELECT collection_id FROM input), new.episode_id,
         c.collection_id::text || ':' || extract(epoch FROM c.created_at)::text, c.source_generation::text,
         new.basis, new.digest, 'live', :at::timestamptz, :workflow_id::text
  FROM unnest(:episodes::uuid[], :bases::text[], :digests::bytea[]) AS new(episode_id, basis, digest), library.collection AS c
  -- Retire an expired digest before testing its partial unique key.
  WHERE c.route = (SELECT route FROM input) AND c.collection_id = (SELECT collection_id FROM input)
    AND (SELECT count(*) FROM retired) >= 0
  ON CONFLICT DO NOTHING
  RETURNING collection_id, episode_id, reserved_incarnation, reserved_generation, canonical_basis, basis_digest
), control AS (
UPDATE library.members_preparation_owner
SET live_count = live_count + (SELECT count(*)::integer FROM inserted) - (SELECT count(*)::integer FROM retired)
WHERE route = (SELECT route FROM input) AND owner_account_id = (SELECT owner_account_id FROM input)
RETURNING (SELECT count(*)::integer FROM inserted) AS created,
          (SELECT count(*)::integer FROM retired) AS retired
)
SELECT control.created, control.retired, inserted.collection_id AS "collectionId", inserted.episode_id AS "episodeId",
       inserted.reserved_incarnation AS "reservedIncarnation", inserted.reserved_generation::text AS "reservedGeneration",
       inserted.canonical_basis AS "canonicalBasis", encode(inserted.basis_digest, 'hex') AS "basisDigest"
FROM control, inserted ORDER BY inserted.collection_id, inserted.episode_id;
