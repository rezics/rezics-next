WITH input AS NOT MATERIALIZED (SELECT :route::integer AS route, :subject_id::uuid AS subject_id),
current_descriptive AS NOT MATERIALIZED (
 SELECT * FROM semantic.current_term_fact
 UNION ALL SELECT * FROM semantic.fact WHERE kind='statement' AND NOT relation
),
subject_page_source_window_descriptive AS MATERIALIZED (
SELECT slot_id,log_seq FROM current_descriptive fact, input
WHERE fact.route=input.route AND fact.subject_id=input.subject_id AND NOT relation
AND (slot_id,log_seq)>(:after_slot::uuid,:after_seq::integer)
ORDER BY slot_id,log_seq LIMIT :limit::integer
)
SELECT w.slot_id::text,w.log_seq,f.kind,f.language,f.property,f.statement_id::text
FROM subject_page_source_window_descriptive w
JOIN current_descriptive f ON f.route=(SELECT route FROM input) AND f.subject_id=(SELECT subject_id FROM input)
AND f.slot_id=w.slot_id AND f.log_seq=w.log_seq ORDER BY w.slot_id,w.log_seq;
