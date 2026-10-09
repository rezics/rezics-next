/** A read projects the assessment the rights owner already recorded. */
export function projectAssessment(row: { outcome: string; obligations: { kind: string; notice: string | null }[] }): {
  outcome: string; notices: string[];
} {
  return {
    outcome: row.outcome,
    notices: row.obligations.flatMap(item => item.notice ? [item.notice] : []),
  };
}

export const assessmentProjectionSql = `SELECT a.outcome, o.kind, o.notice
  FROM rights.use_assessment a
  JOIN rights.obligation o ON o.assessment_id = a.id`;
