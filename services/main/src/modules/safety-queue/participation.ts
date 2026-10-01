import type { Pool, PoolClient } from 'pg';
import { AdmissionDenied } from '../access/admission.ts';

/** Platform sanctions follow current representatives, including all of an Organization's representatives.
 * Case credentials do not use Main write admission and remain usable. */
export async function requirePlatformParticipation(
  client: Pool | PoolClient,
  principalId: string,
): Promise<void> {
  const restricted = await client.query(
    `SELECT 1 FROM access.governance_enforcement e
    WHERE e.authority_scope_id = 'governance:platform' AND e.context = 'urn:rezics:context:global'
      AND e.state = 'restricted' AND e.effect IN ('participation','capability')
      AND (e.expires_at IS NULL OR e.expires_at > clock_timestamp())
      AND (e.participant_subject IN (SELECT subject_id FROM access.representation WHERE principal_id = $1
          AND active AND valid_until > clock_timestamp())
        OR e.participant_subject IN (SELECT agent_id FROM access.agent_provision WHERE principal_id = $1))
    LIMIT 1`,
    [principalId],
  );
  if (restricted.rowCount) throw new AdmissionDenied('platform participation is restricted');
}
