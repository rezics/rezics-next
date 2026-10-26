WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :subject_id::uuid AS subject_id, :slot_id::uuid AS slot_id,
         :context_id::uuid AS context_id, :head::integer AS head
)
INSERT INTO semantic.adoption (route, subject_id, slot_id, context_id, head, mode, selection, revision)
SELECT input.route, input.subject_id, input.slot_id, input.context_id, input.head, :mode::text, :selection::jsonb, :revision::integer
FROM input
WHERE COALESCE((SELECT head FROM semantic.adoption
  WHERE route = input.route AND subject_id = input.subject_id AND slot_id = input.slot_id AND context_id = input.context_id
  ORDER BY head DESC LIMIT 1), 0) = input.head - 1
ON CONFLICT DO NOTHING RETURNING head;
