import type { PoolClient } from 'pg';
import {
  GovernanceDenied,
  GovernanceInvalid,
  GovernanceStale,
  type DecisionInput,
} from './store.ts';

/** Fixed indexed basis/automation reads plus one membership probe per cited
 * target (at most 64); no retained report or evidence list leaves PostgreSQL. */
export const GOVERNANCE_VALIDATION_COST = {
  basisReads: 1,
  membershipReadsPerTarget: 1,
  automationReads: 1,
} as const;

export async function validateDecisionEvidence(
  client: Pick<PoolClient, 'query'>,
  input: DecisionInput,
): Promise<string> {
  const basis = (
    await client.query<{ id: string }>(
      `SELECT id FROM access.governance_report
    WHERE case_id = $1 AND evidence_digest = $2 LIMIT 1`,
      [input.caseId, input.evidenceDigest],
    )
  ).rows[0];
  if (!basis) throw new GovernanceStale('evidence basis is not retained');
  if (
    input.reasons?.automation === false &&
    (
      await client.query(
        `SELECT 1
    FROM access.governance_case_evidence WHERE case_id = $1 AND automated LIMIT 1`,
        [input.caseId],
      )
    ).rowCount
  ) {
    throw new GovernanceInvalid('reasons must disclose retained automation involvement');
  }
  const restricted = ['reject', 'restrict', 'interim_restrict', 'final_restrict'].includes(
    input.outcome,
  );
  for (const target of input.targets) {
    if (
      !(
        await client.query(
          `SELECT 1 FROM access.governance_case_evidence
      WHERE case_id = $1 AND target_key = access.governance_target_key($2,$3,$4,$5,$6)
        AND ($7::boolean = false OR available) LIMIT 1`,
          [
            input.caseId,
            target.owner,
            target.resource,
            target.component,
            target.locator,
            target.scopeKind === 'component' ? null : target.revision,
            restricted,
          ],
        )
      ).rowCount
    ) {
      throw new GovernanceDenied('decision target is outside the reported evidence');
    }
  }
  return basis.id;
}
