import type { Pool } from 'pg';
import type { VerifiedPrincipal } from '../access/admission.ts';

/** Two indexed reads at most per onboarding request: the first active Person
 * and the exact provision returned by the saga. No private Account profile. */
export class OnboardingPersons {
  constructor(private readonly pool: Pool) {}

  async activeName(principal: VerifiedPrincipal): Promise<string | null> {
    const row = (await this.pool.query<{ display_name: string }>(`SELECT a.display_name
      FROM access.principal p JOIN LATERAL (
        SELECT display_name FROM access.agent_provision
        WHERE principal_id = p.id AND agent_kind = 'person' AND state = 'active'
        ORDER BY created_at, id LIMIT 1
      ) a ON true
      WHERE p.account_issuer = $1 AND p.account_subject = $2 AND p.active`,
    [principal.issuer, principal.subject])).rows[0];
    return row?.display_name ?? null;
  }

  async provisionName(agent: string): Promise<string | null> {
    return (await this.pool.query<{ display_name: string }>(`SELECT display_name
      FROM access.agent_provision WHERE agent_id = $1`, [agent])).rows[0]?.display_name ?? null;
  }
}
