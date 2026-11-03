SELECT k.subject_id AS "subjectId", k.association_id AS "associationId",
       c.binding_hash AS "bindingHash", c.revision::text AS revision
FROM jsonb_to_recordset(:keys::jsonb) AS k(subject_id uuid, association_id uuid, binding_hash text)
LEFT JOIN rating.classification_contribution c
  ON c.route = :route::integer AND c.subject_id = k.subject_id AND c.association_id = k.association_id
 AND c.actor_route = :actor_route::integer AND c.actor_id = :actor_id::uuid
 AND c.binding_hash = decode(k.binding_hash, 'hex');
