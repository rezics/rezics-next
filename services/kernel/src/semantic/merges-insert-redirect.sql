WITH input AS (
  SELECT :route::integer AS route, :subject_id::uuid AS subject_id
)
INSERT INTO semantic.redirect (route, subject_id, sequence, target, recorded_transaction_id)
SELECT input.route, input.subject_id, coalesce((
  SELECT sequence FROM semantic.redirect
  WHERE route = input.route AND subject_id = input.subject_id
  ORDER BY sequence DESC LIMIT 1
), 0) + 1, :target::uuid, :transaction_id::uuid
FROM input;
