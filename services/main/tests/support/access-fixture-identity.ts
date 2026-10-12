import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { VerifiedPrincipal } from '../../src/modules/access/admission.ts';

type Sql = Pick<Pool | PoolClient, 'query'>;

/** Prepare identities separately from fixture mandates and grants. Repeated
 * preparation preserves the canonical principal and existing subject state. */
export async function ensureFixturePrincipal(client: Sql, principal: VerifiedPrincipal): Promise<string> {
  await client.query(`INSERT INTO access.principal (id,account_issuer,account_subject)
    VALUES ($1,$2,$3) ON CONFLICT (account_issuer,account_subject) DO NOTHING`,
  [randomUUID(), principal.issuer, principal.subject]);
  const result = await client.query<{ id: string }>(
    'SELECT id FROM access.principal WHERE account_issuer=$1 AND account_subject=$2',
    [principal.issuer, principal.subject]);
  return result.rows[0]!.id;
}

export async function ensureFixtureAuthoritySubject(client: Sql, id: string,
  kind: 'agent' | 'institution' = 'agent'): Promise<void> {
  await client.query('INSERT INTO access.authority_subject (id,kind) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING',
    [id, kind]);
}
