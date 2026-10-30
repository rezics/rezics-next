SELECT f.operation, f.log_seq, a.head, a.mode,
       CASE WHEN a.mode = 'replace' THEN jsonb_array_length(a.selection) ELSE 0 END AS selected
FROM (SELECT :route::integer AS route, :subject_id::uuid AS subject_id, :slot_id::uuid AS slot_id) i
LEFT JOIN LATERAL (
  SELECT operation, log_seq FROM semantic.fact
  WHERE route = i.route AND subject_id = i.subject_id AND slot_id = i.slot_id
  ORDER BY log_seq DESC LIMIT 1
) f ON true
LEFT JOIN LATERAL (
  SELECT head, mode, selection FROM semantic.adoption
  WHERE f.operation = 'expand' AND route = i.route AND subject_id = i.subject_id AND slot_id = i.slot_id
    AND context_id = '00000000-0000-8000-8000-000000000000'
  ORDER BY head DESC LIMIT 1
) a ON true;
