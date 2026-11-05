-- unbound: a private audience range spans holder partitions for the target inverse; subject and account indexes bound it.
WITH input AS NOT MATERIALIZED (
  SELECT :inbound::boolean AS inbound,
         :moderator::boolean AS moderator,
         :account_id::uuid AS account_id,
         :subject_id::uuid AS subject_id,
         :property::text AS property,
         :cross_property::boolean AS cross_property,
         :after_order::text AS after_order,
         :after_subject::uuid AS after_subject,
         :after_statement::uuid AS after_statement,
         :page_limit::integer AS page_limit
),
selected AS MATERIALIZED (
  SELECT d.*, c.slot_id, c.statement, c.release, c.revision, c.rank,
         holder.type AS source_type, target.type AS target_type,
         CASE WHEN input.inbound THEN d.source_order_key ELSE d.target_order_key END AS order_key
  FROM input CROSS JOIN semantic.statement_disclosure d
  CROSS JOIN LATERAL (
    SELECT slot_id, statement, release, revision, rank FROM semantic.candidate
    WHERE route = d.route AND subject_id = d.subject_id AND candidate_id = d.candidate_id
    LIMIT 1
  ) c
  JOIN semantic.subject holder ON holder.route = d.route AND holder.subject_id = d.subject_id
  JOIN semantic.subject target ON target.route = get_byte(uuid_send(d.target_id), 10) * 256 + get_byte(uuid_send(d.target_id), 11)
    AND target.subject_id = d.target_id
  WHERE NOT d.disclosed AND (input.moderator OR d.account_id = input.account_id)
    AND ((input.inbound AND d.target_id = input.subject_id)
      OR (NOT input.inbound AND d.subject_id = input.subject_id))
    AND (input.property = '' OR d.property = input.property)
    AND NOT EXISTS (SELECT 1 FROM semantic.retraction t
      WHERE t.route = d.route AND t.subject_id = d.subject_id AND t.candidate_id = d.candidate_id)
    AND holder.visibility = 'visible' AND target.visibility = 'visible'
    AND NOT EXISTS (SELECT 1 FROM semantic.hidden_candidate h
      WHERE h.route = d.route AND h.subject_id = d.subject_id AND h.candidate_id = d.candidate_id)
    AND NOT EXISTS (SELECT 1 FROM semantic.record_lifecycle lifecycle
      WHERE lifecycle.route=d.route AND lifecycle.subject_id=d.subject_id AND lifecycle.candidate_id=d.candidate_id
        AND lifecycle.state IN ('deleted','purging','purged'))
    AND EXISTS (SELECT 1 FROM semantic.adoption a
      WHERE a.route = d.route AND a.subject_id = d.subject_id AND a.slot_id = c.slot_id
        AND a.context_id = '00000000-0000-8000-8000-000000000000'::uuid
        AND a.mode = 'replace' AND a.selection @> jsonb_build_array(jsonb_build_object('candidate', d.candidate_id))
        AND NOT EXISTS (SELECT 1 FROM semantic.adoption newer
          WHERE newer.route = a.route AND newer.subject_id = a.subject_id AND newer.slot_id = a.slot_id
            AND newer.context_id = a.context_id AND newer.head > a.head))
), page AS (
  SELECT selected.* FROM selected CROSS JOIN input
  WHERE (CASE WHEN input.cross_property THEN selected.property ELSE selected.order_key END COLLATE "C",
         CASE WHEN input.inbound THEN selected.subject_id ELSE selected.target_id END, selected.candidate_id)
      > (input.after_order COLLATE "C", input.after_subject, input.after_statement)
  ORDER BY CASE WHEN input.cross_property THEN selected.property ELSE selected.order_key END COLLATE "C",
           CASE WHEN input.inbound THEN selected.subject_id ELSE selected.target_id END, selected.candidate_id
  LIMIT (SELECT page_limit FROM input)
)
SELECT COALESCE((SELECT jsonb_agg(to_jsonb(page)) FROM page), '[]'::jsonb) AS entries;
