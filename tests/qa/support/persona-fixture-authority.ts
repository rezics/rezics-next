import { Pool } from 'pg';
import { grantFixtureAuthority } from '../../../services/main/src/modules/access/fixture-authority.ts';
import type { PersonaSession } from './personas.ts';

/** Explicit scaffold mandates for an already provisioned HTTP persona.
 * Product authority observations must still use that person's public API. */
export async function grantPersonaFixtureAuthority(
  person: PersonaSession,
  grants: readonly { scope: string; action: string }[],
): Promise<void> {
  if (!person.accountId || !person.actingSubject) throw new Error('Fixture mandate requires an authenticated persona');
  const pool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
  try {
    const principal = await pool.query<{ id: string }>(
      'SELECT id FROM access.principal WHERE account_subject=$1', [person.accountId]);
    if (principal.rows.length !== 1) throw new Error('Fixture mandate requires one provisioned principal');
    for (const { scope, action } of grants) await grantFixtureAuthority(pool, {
      scope, requireDispatch: true,
      representations: [{ principalId: principal.rows[0]!.id, actor: person.actingSubject, action, lifetime: '8 hours' }],
      grant: { actor: person.actingSubject, action, lifetime: '8 hours' },
    });
  } finally { await pool.end(); }
}
