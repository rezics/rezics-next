-- Public evidence ignores all request owner/moderator overlays. Each branch is an exact key.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :subject_id::uuid AS subject_id, :candidate_id::uuid AS candidate_id
)
SELECT EXISTS (SELECT 1 FROM semantic.hidden_candidate h
               WHERE h.route = input.route AND h.subject_id = input.subject_id AND h.candidate_id = input.candidate_id)
    OR EXISTS (SELECT 1 FROM semantic.retraction t
               WHERE t.route = input.route AND t.subject_id = input.subject_id AND t.candidate_id = input.candidate_id)
    OR EXISTS (SELECT 1 FROM semantic.statement_disclosure d
               WHERE d.route = input.route AND d.subject_id = input.subject_id AND d.candidate_id = input.candidate_id
                 AND NOT disclosed) AS concealed FROM input;
