SELECT k.subject_id AS "subjectId", k.association_id AS "associationId",
       a.support_count AS "supportCount", a.oppose_count AS "opposeCount",
       a.false_positive_count AS "falsePositiveCount", a.generation::text AS generation,
       a.as_of AS "asOf"
FROM jsonb_to_recordset(:keys::jsonb) AS k(subject_id uuid, association_id uuid, binding_hash text)
LEFT JOIN rating.classification_aggregate a
  ON a.route = :route::integer AND a.subject_id = k.subject_id AND a.association_id = k.association_id
 AND a.binding_hash = decode(k.binding_hash, 'hex');
