WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route,:collection_id::uuid AS collection_id,:audience::text AS audience,
         :generation::uuid AS generation,:version::text::bigint AS version,
         :frontier::nullable(text) AS frontier,:after_subject::nullable(uuid) AS after_subject,:complete::boolean AS complete
), updated AS (
  UPDATE library.collection_kind_observation AS observation
  SET frontier=input.frontier,after_subject=input.after_subject,version=observation.version+1,complete=input.complete,
      winner=CASE WHEN input.complete THEN (
        SELECT counts.type_id FROM library.collection_kind_count AS counts
        WHERE counts.route=input.route AND counts.collection_id=input.collection_id
          AND counts.audience=input.audience AND counts.generation=input.generation
        ORDER BY counts.votes DESC,counts.type_id LIMIT 1
      ) ELSE NULL END
  FROM input
  WHERE observation.route=input.route AND observation.collection_id=input.collection_id AND observation.audience=input.audience
    AND observation.generation=input.generation AND observation.version=input.version AND NOT observation.complete
  RETURNING observation.version::text
)
SELECT version FROM updated LIMIT 1;
