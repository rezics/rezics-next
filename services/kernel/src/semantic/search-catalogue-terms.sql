WITH home AS MATERIALIZED (
  SELECT position, write_state FROM core.partition WHERE partition_no=:partition_no::integer
), requested AS MATERIALIZED (
  SELECT :subject_id::uuid AS id, :route::integer AS route
)
SELECT i.id::text AS id,home.position::text AS position,home.write_state AS home,
       s.type,s.visibility,s.security_revision::text AS revision,redirect.target::text AS redirect,
       COALESCE(state.ready,false) AS ready,
       EXISTS (SELECT 1 FROM semantic.search_selected sel
               WHERE (sel.route,sel.subject_id)=(i.route,i.id) AND sel.active) AS selected,
       terms.facts
FROM requested i CROSS JOIN home
LEFT JOIN semantic.subject s ON (s.route,s.subject_id)=(i.route,i.id)
LEFT JOIN semantic.search_selection_state state ON (state.route,state.subject_id)=(i.route,i.id)
LEFT JOIN LATERAL (
  SELECT target FROM semantic.redirect WHERE route=i.route AND subject_id=i.id ORDER BY sequence DESC LIMIT 1
) redirect ON true
LEFT JOIN LATERAL (
  SELECT jsonb_agg(jsonb_build_array(f.kind,f.language,f.operation,f.body) ORDER BY f.slot_id,f.log_seq) AS facts
  FROM (
    SELECT f.kind,f.language,f.operation,f.body,f.slot_id,f.log_seq FROM semantic.current_term_fact f
    WHERE (f.route,f.subject_id)=(i.route,i.id) AND f.kind<>'statement'
    ORDER BY f.slot_id,f.log_seq LIMIT 65
  ) f
) terms ON true;
