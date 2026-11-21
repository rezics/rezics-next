-- One newest fact per declared property slot in the subject snapshot.
SELECT wanted.slot_id::text AS slot_id, head.operation
FROM unnest(:slot_ids::uuid[]) AS wanted(slot_id)
JOIN LATERAL (
  SELECT fact.operation FROM semantic.fact
  WHERE fact.route = :route::integer AND fact.subject_id = :subject_id::uuid
    AND fact.slot_id = wanted.slot_id
  ORDER BY fact.log_seq DESC LIMIT 1
) head ON true;
