import type { Pool } from 'pg';

export const fixtureReasons = {
  facts: 'The retained report and exact target were reviewed.',
  scope: 'The declared decision targets.',
  duration: 'Until a later staff decision.',
  automation: false,
  appealRoute: '/v1/public-reports/{caseId}/correspondence' as const,
  contentLanguage: 'en',
};

/** Legacy fixtures isolate authority scopes; the real platform claim API is covered by G-565. */
export async function claimFixture(pool: Pool, caseId: string, principalId: string, actor: string) {
  await pool.query(
    `INSERT INTO access.safety_case_claim
    (case_id,principal_id,acting_subject,case_generation,claimed_at,expires_at)
    SELECT id,$2,$3,generation,clock_timestamp(),clock_timestamp() + interval '30 minutes'
    FROM access.governance_case WHERE id = $1 ON CONFLICT (case_id) DO UPDATE SET
      principal_id = EXCLUDED.principal_id,acting_subject = EXCLUDED.acting_subject,
      case_generation = EXCLUDED.case_generation,claimed_at = EXCLUDED.claimed_at,expires_at = EXCLUDED.expires_at`,
    [caseId, principalId, actor],
  );
}
