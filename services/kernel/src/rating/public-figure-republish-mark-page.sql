WITH input AS (
  SELECT :question_id::uuid AS question_id, :population_id::uuid AS population_id,
         :subject_ids::uuid[] AS subject_ids,
         :position::bigint AS position, :generation::bigint AS generation
), current_generation AS MATERIALIZED (
  SELECT prior.generation
  FROM rating.population_prior_epoch AS prior CROSS JOIN input
  WHERE prior.route = get_byte(uuid_send(input.population_id), 10) * 256 +
                      get_byte(uuid_send(input.population_id), 11)
    AND prior.question_id = input.question_id AND prior.population_id = input.population_id
    AND prior.generation = input.generation
)
INSERT INTO rating.public_figure
  (route, question_id, population_id, subject_id, pending_position, pending_prior_generation)
SELECT get_byte(uuid_send(subject_id), 10) * 256 + get_byte(uuid_send(subject_id), 11),
       input.question_id, input.population_id, subject_id, input.position, input.generation
FROM input CROSS JOIN current_generation
CROSS JOIN unnest(input.subject_ids) AS subject_id
ON CONFLICT (route, question_id, population_id, subject_id) DO UPDATE
SET pending_position = EXCLUDED.pending_position,
    pending_prior_generation = GREATEST(
      COALESCE(rating.public_figure.pending_prior_generation, 0), EXCLUDED.pending_prior_generation
    )
WHERE rating.public_figure.published_prior_generation < EXCLUDED.pending_prior_generation
RETURNING 1;
