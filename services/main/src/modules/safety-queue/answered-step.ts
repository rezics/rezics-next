/** Accepting an answer records intent. Deadlines remain actionable until every
 * owner effect confirms; cancellation cannot count as a completed response. */
export function completedSafetyAnswerSql(step: 's.id' | 'a.step_id'): string {
  return `SELECT 1 FROM access.moderation_decision d WHERE d.answers_step_id = ${step}
    AND NOT EXISTS (SELECT 1 FROM access.safety_decision_operation op
      WHERE op.decision_id = d.id AND op.cancelled)
    AND NOT EXISTS (SELECT 1 FROM access.safety_decision_effect e
      WHERE e.decision_id = d.id AND e.state <> 'confirmed')`;
}
