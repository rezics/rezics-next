WITH input AS NOT MATERIALIZED (SELECT :route::integer AS route, :subject_id::uuid AS subject_id),
subject_page_source_window_evidence AS MATERIALIZED (
SELECT candidate_id FROM semantic.candidate, input
WHERE candidate.route=input.route AND candidate.subject_id=input.subject_id AND candidate_id>:after_id::uuid
ORDER BY candidate_id LIMIT :limit::integer
)
SELECT w.candidate_id::text,c.property,c.slot_id::text,c.relation FROM subject_page_source_window_evidence w
JOIN semantic.candidate c ON c.route=(SELECT route FROM input) AND c.subject_id=(SELECT subject_id FROM input)
AND c.candidate_id=w.candidate_id ORDER BY w.candidate_id;
