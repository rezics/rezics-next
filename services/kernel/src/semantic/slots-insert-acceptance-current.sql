INSERT INTO semantic.acceptance_current
(route, subject_id, context_id, candidate_id, slot_id, head, verdict, revision)
VALUES (:route::integer, :subject_id::uuid, :context_id::uuid, :candidate_id::uuid, :slot_id::uuid, :head::integer, :verdict::text, :revision::integer)
ON CONFLICT (route, subject_id, context_id, candidate_id)
DO UPDATE SET slot_id = EXCLUDED.slot_id, head = EXCLUDED.head,
              verdict = EXCLUDED.verdict, revision = EXCLUDED.revision;
