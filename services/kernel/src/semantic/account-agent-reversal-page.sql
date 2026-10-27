WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :receipt_id::text AS receipt_id,
         :account_id::uuid AS account_id, :survivor::uuid AS survivor,
         :moved_from::uuid AS moved_from, :after_property::text AS after_property,
         :after_source::uuid AS after_source, :after_statement::uuid AS after_statement,
         :after_filter::uuid AS after_filter
), page AS (
  SELECT moved.route, moved.receipt_id, moved.moved_from, moved.statement_id,
         moved.property, moved.source_subject_id, moved.filter_value, moved.reversal_prepared,
         moved.source_revision AS saved_source_revision,
         moved.source_security_revision AS saved_source_security_revision,
         moved.present AS saved_present, moved.source_type AS saved_source_type,
         moved.order_key AS saved_order_key,
         link.source_revision AS current_source_revision,
         link.source_security_revision AS current_source_security_revision,
         link.present AS current_present, link.source_type AS current_source_type,
         link.order_key AS current_order_key
  FROM input
  JOIN semantic.account_agent_moved_link AS moved
    ON moved.route = input.route AND moved.receipt_id = input.receipt_id
   AND moved.account_id = input.account_id AND moved.survivor = input.survivor
   AND moved.moved_from = input.moved_from
   AND (moved.property, moved.source_subject_id, moved.statement_id, moved.filter_value) >
       (input.after_property, input.after_source, input.after_statement, input.after_filter)
  LEFT JOIN LATERAL (
    SELECT link.source_revision, link.source_security_revision, link.present, link.source_type, link.order_key
    FROM semantic.inbound_link AS link
    WHERE link.route = input.route AND link.subject_id = moved.survivor
      AND link.property = moved.property AND link.source_subject_id = moved.source_subject_id
      AND link.statement_id = moved.statement_id AND link.filter_value = moved.filter_value
    LIMIT 1
  ) AS link ON true
  WHERE NOT moved.reversed
  ORDER BY moved.property, moved.source_subject_id, moved.statement_id, moved.filter_value
  LIMIT 100
), prepared AS (
  UPDATE semantic.account_agent_moved_link AS moved
  SET source_revision = CASE WHEN page.reversal_prepared THEN page.saved_source_revision ELSE page.current_source_revision END,
      source_security_revision = CASE WHEN page.reversal_prepared THEN page.saved_source_security_revision ELSE page.current_source_security_revision END,
      present = CASE WHEN page.reversal_prepared THEN page.saved_present ELSE page.current_present END,
      source_type = CASE WHEN page.reversal_prepared THEN page.saved_source_type ELSE page.current_source_type END,
      order_key = CASE WHEN page.reversal_prepared THEN page.saved_order_key ELSE page.current_order_key END,
      reversal_prepared = true
  FROM page, input
  WHERE moved.route = input.route AND moved.receipt_id = page.receipt_id
    AND moved.moved_from = page.moved_from AND moved.property = page.property
    AND moved.source_subject_id = page.source_subject_id AND moved.statement_id = page.statement_id
    AND moved.filter_value = page.filter_value
  RETURNING moved.statement_id::text AS statement_id, moved.property,
            moved.source_subject_id::text AS source_subject_id, moved.filter_value::text AS filter_value,
            moved.source_revision, moved.source_security_revision::text AS source_security_revision,
            moved.present, moved.source_type, moved.order_key
)
SELECT * FROM prepared ORDER BY property, source_subject_id, statement_id, filter_value;
