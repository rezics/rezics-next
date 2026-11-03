WITH input AS (
  SELECT :question_id::uuid AS question_id, :population_id::uuid AS population_id,
         :subject_ids::uuid[] AS subject_ids,
         :position::bigint AS position, :generation::bigint AS generation,
         :partition_no::integer AS partition_no
), current_generation AS MATERIALIZED (
  SELECT prior.generation, prior.question_identity
  FROM rating.subject_home_prior_input AS prior CROSS JOIN input
  WHERE prior.partition_no = input.partition_no
    AND prior.population_route = get_byte(uuid_send(input.population_id), 10) * 256 +
                      get_byte(uuid_send(input.population_id), 11)
    AND prior.question_id = input.question_id AND prior.population_id = input.population_id
    AND prior.generation >= input.generation AND prior.generation > 0
)
INSERT INTO rating.public_figure
  (route, question_id, population_id, subject_id, pending_position, pending_prior_generation, question_identity)
SELECT get_byte(uuid_send(subject_id), 10) * 256 + get_byte(uuid_send(subject_id), 11),
       input.question_id, input.population_id, subject_id, input.position, current_generation.generation, current_generation.question_identity
FROM input CROSS JOIN current_generation
CROSS JOIN unnest(input.subject_ids) AS subject_id
WHERE (get_byte(uuid_send(subject_id), 10) * 256 + get_byte(uuid_send(subject_id), 11)) >> 4 = input.partition_no
ON CONFLICT (route, question_id, population_id, subject_id) DO UPDATE
SET pending_position = EXCLUDED.pending_position,
    pending_prior_generation = GREATEST(
      COALESCE(rating.public_figure.pending_prior_generation, 0), EXCLUDED.pending_prior_generation
    )
WHERE rating.public_figure.published_prior_generation < EXCLUDED.pending_prior_generation
RETURNING 1;
