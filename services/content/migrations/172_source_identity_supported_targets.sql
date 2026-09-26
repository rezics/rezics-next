-- A proposal must name actual, active support. A reserved field slot or a
-- withdrawn source claim is historical evidence, not current target support.
-- Existing proposals remain immutable and readable after later withdrawal.
CREATE OR REPLACE FUNCTION source.record_supports_target(owner uuid, source_record uuid, native_target text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM source.field_support s
      JOIN source.field_support_head h ON h.support_id = s.id
      JOIN source.field_support_outcome o ON o.step_id = h.settled_step_id
      WHERE s.principal_id = owner AND s.target = native_target AND s.record_id = source_record
        AND o.outcome IN ('applied', 'attached', 'returned')
        AND NOT EXISTS (SELECT 1 FROM source.field_support_withdrawal w WHERE w.support_id = s.id))
    OR EXISTS (SELECT 1 FROM source.native_work_binding b
      JOIN source.native_work_proposal p ON p.id = b.proposal_id
      WHERE b.work = native_target AND b.principal_id = owner AND p.record_id = source_record
        AND NOT EXISTS (SELECT 1 FROM source.native_work_support_withdrawal w WHERE w.binding_id = b.id))
    OR EXISTS (SELECT 1 FROM source.native_work_support_attachment a
      WHERE a.work = native_target AND a.principal_id = owner AND a.record_id = source_record
        AND NOT EXISTS (SELECT 1 FROM source.native_work_attachment_withdrawal w WHERE w.attachment_id = a.id))
    OR EXISTS (SELECT 1 FROM source.author_credit_intent c
      JOIN source.author_credit_application app ON app.intent_id = c.id
      WHERE c.credit = native_target AND c.principal_id = owner AND c.record_id = source_record
        AND NOT EXISTS (SELECT 1 FROM source.author_credit_withdrawal w WHERE w.intent_id = c.id))
$$;
