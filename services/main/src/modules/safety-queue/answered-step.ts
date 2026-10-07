/** Admission holds the case/step locks and never appends after a live answer.
 * Thus the latest answer alone determines current state. Seek before checking
 * cancellation or effects so immutable cancelled history cannot grow the read. */
export function latestSafetyAnswerSql(step: '$1' | '$2' | 's.id' | 'a.step_id'): string {
  return `SELECT id,case_sequence,principal_id,kind,idempotency_key
    FROM access.moderation_decision WHERE answers_step_id = ${step}
    ORDER BY case_sequence DESC LIMIT 1`;
}

/** Accepting an answer records intent. Deadlines remain actionable until every
 * owner effect confirms; cancellation cannot count as a completed response. */
export function completedSafetyAnswerSql(step: 's.id' | 'a.step_id'): string {
  return `SELECT 1 FROM (${latestSafetyAnswerSql(step)}) d
    WHERE NOT EXISTS (SELECT 1 FROM access.safety_decision_operation op
      WHERE op.decision_id = d.id AND op.cancelled)
    AND NOT EXISTS (SELECT 1 FROM access.safety_decision_effect e
      WHERE e.decision_id = d.id AND e.state <> 'confirmed')`;
}
