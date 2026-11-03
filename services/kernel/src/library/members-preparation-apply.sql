WITH args AS NOT MATERIALIZED (SELECT :incarnation::text AS incarnation, :source_generation::bigint AS source_generation, :subjects::uuid[] AS subjects),
current_header AS MATERIALIZED (
  SELECT h.route, h.owner_account_id, h.collection_id, h.episode_id, h.next_position
  FROM library.members_preparation AS h
  WHERE h.route = :route::integer AND h.owner_account_id = :owner_account_id::uuid
    AND h.collection_id = :collection_id::uuid AND h.episode_id = :episode_id::uuid
    AND h.state = 'live' AND NOT h.complete AND h.progress_version = :version::bigint
    AND h.last_read_at > :at::timestamptz - interval '24 hours'
    AND EXISTS (SELECT 1 FROM library.collection AS c
      WHERE c.route = h.route AND c.collection_id = h.collection_id
        AND c.curator_account_id = h.owner_account_id AND c.state = 'active' AND c.membership_kind = 'curated'
        AND c.collection_id::text || ':' || extract(epoch FROM c.created_at)::text = (SELECT incarnation FROM args)
        AND c.source_generation = (SELECT source_generation FROM args))
  FOR UPDATE OF h
), inserted AS (
  INSERT INTO library.members_preparation_result
    (route, owner_account_id, collection_id, episode_id, position, subject_id, sort_key)
  SELECT h.route, h.owner_account_id, h.collection_id, h.episode_id, h.next_position + new.ordinality, new.subject_id,
         lpad((h.next_position + new.ordinality)::text, 19, '0')
  FROM current_header AS h, unnest((SELECT subjects FROM args)) WITH ORDINALITY AS new(subject_id, ordinality)
  ON CONFLICT (route, owner_account_id, collection_id, episode_id, subject_id) DO NOTHING
  RETURNING position
)
UPDATE library.members_preparation AS h
SET failure_code = :failure::nullable(text), progress_version = h.progress_version + 1, checkpoint = :checkpoint::text, observation = :observation::text,
    source_incarnation = (SELECT incarnation FROM args), source_generation = (SELECT source_generation::text FROM args),
    result_count = h.result_count + (SELECT count(*)::integer FROM inserted),
    next_position = h.next_position + cardinality((SELECT subjects FROM args)), complete = :complete::boolean, source_exhausted = :exhausted::boolean
FROM current_header AS current
WHERE h.route = current.route AND h.owner_account_id = current.owner_account_id
  AND h.collection_id = current.collection_id AND h.episode_id = current.episode_id
  AND (SELECT count(*) FROM inserted) >= 0
RETURNING h.progress_version::text AS version;
