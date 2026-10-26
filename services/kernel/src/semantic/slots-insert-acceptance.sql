WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :subject_id::uuid AS subject_id, :context_id::uuid AS context_id,
         :candidate_id::uuid AS candidate_id, :head::integer AS head, :verdict::text AS verdict,
         :revision::integer AS revision
)
INSERT INTO semantic.acceptance (route, subject_id, context_id, candidate_id, head, verdict, revision)
SELECT input.route, input.subject_id, input.context_id, input.candidate_id, input.head, input.verdict, input.revision
FROM input
WHERE COALESCE((SELECT head FROM semantic.acceptance
  WHERE route = input.route AND subject_id = input.subject_id AND context_id = input.context_id AND candidate_id = input.candidate_id
  ORDER BY head DESC LIMIT 1), 0) = input.head - 1
ON CONFLICT DO NOTHING RETURNING head;
