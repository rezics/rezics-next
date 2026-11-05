WITH input AS NOT MATERIALIZED (
  SELECT :concept::uuid AS concept_id,
         :scheme::uuid AS scheme_id,
         :route::integer AS route
)
SELECT concept.type AS concept_type,
       concept.visibility AS concept_visibility,
       concept.security_revision::text AS concept_security_revision,
       concept.current_release AS concept_release,
       COALESCE(concept_selection.ready,false) AS concept_ready,
       scheme.type AS scheme_type,
       scheme.visibility AS scheme_visibility,
       COALESCE(scheme_selection.ready,false) AS scheme_ready,
       EXISTS (
         SELECT 1 FROM semantic.search_selected membership
         WHERE membership.route=input.route AND membership.subject_id=input.concept_id
           AND membership.active AND membership.relation
           AND membership.property='skos:inScheme' COLLATE "C"
           AND membership.body #>> '{value,type}'='value'
           AND membership.body #>> '{value,content}' COLLATE "C"=input.scheme_id::text COLLATE "C"
       ) AS member
FROM input
LEFT JOIN semantic.subject concept ON concept.route=input.route AND concept.subject_id=input.concept_id
LEFT JOIN semantic.search_selection_state concept_selection
  ON concept_selection.route=concept.route AND concept_selection.subject_id=concept.subject_id
LEFT JOIN semantic.subject scheme ON scheme.subject_id=input.scheme_id
  AND scheme.route=((get_byte(uuid_send(input.scheme_id),10)*256)+get_byte(uuid_send(input.scheme_id),11))
LEFT JOIN semantic.search_selection_state scheme_selection
  ON scheme_selection.route=scheme.route AND scheme_selection.subject_id=scheme.subject_id;
