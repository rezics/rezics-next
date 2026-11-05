WITH input AS NOT MATERIALIZED (
  SELECT :parent::uuid AS parent_id,
         :scheme::uuid AS scheme_id,
         :after_route::integer AS after_route,
         :after_subject::uuid AS after_subject,
         :after_slot::uuid AS after_slot,
         :after_candidate::uuid AS after_candidate
)
SELECT broader.route,
       broader.subject_id::text AS child,
       broader.slot_id::text AS slot,
       broader.candidate_id::text AS candidate
FROM input
CROSS JOIN LATERAL (
  SELECT selected.route, selected.subject_id, selected.slot_id, selected.candidate_id
  FROM semantic.search_selected selected
  JOIN semantic.subject subject
    ON subject.route=selected.route AND subject.subject_id=selected.subject_id
  JOIN semantic.search_selection_state selection
    ON selection.route=selected.route AND selection.subject_id=selected.subject_id AND selection.ready
  WHERE selected.active AND selected.relation
    AND selected.property='skos:broader' COLLATE "C"
    AND selected.body #>> '{value,type}'='value'
    AND selected.body #>> '{value,content}' COLLATE "C"=input.parent_id::text COLLATE "C"
    AND subject.type='skos:Concept' COLLATE "C" AND subject.visibility='visible'
    AND EXISTS (
      SELECT 1 FROM semantic.search_selected membership
      WHERE membership.route=selected.route AND membership.subject_id=selected.subject_id
        AND membership.active AND membership.relation
        AND membership.property='skos:inScheme' COLLATE "C"
        AND membership.body #>> '{value,type}'='value'
        AND membership.body #>> '{value,content}' COLLATE "C"=input.scheme_id::text COLLATE "C"
    )
    AND (selected.route,selected.subject_id,selected.slot_id,selected.candidate_id)>
      (input.after_route,input.after_subject,input.after_slot,input.after_candidate)
  ORDER BY selected.route,selected.subject_id,selected.slot_id,selected.candidate_id
  LIMIT :limit::integer
) broader
ORDER BY broader.route,broader.subject_id,broader.slot_id,broader.candidate_id;
