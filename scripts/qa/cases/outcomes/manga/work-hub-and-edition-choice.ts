import { proved, rowOutcomes } from '../../outcome-cells.ts';
import type { Pool } from 'pg';
import { grantFixtureAuthority } from '../../../../../services/main/src/modules/access/fixture-authority.ts';

/** Fixture support for the four manga rows applies exact Access mandates through
 * the closed-gate-aware boundary to the actual Account's provisioned Person.
 * It runs no product commands and reads no reader state. */
export async function grantMangaFixtureAuthority(pool: Pool, person: {
  accountId: string | null; actingSubject: string | null;
}, scope: string, action: string): Promise<void> {
  if (!person.accountId || !person.actingSubject) throw new Error('Fixture authority requires a signed-in Person');
  const principal = await pool.query<{ id: string }>('SELECT id FROM access.principal WHERE account_subject = $1', [person.accountId]);
  if (principal.rows.length !== 1) throw new Error('Fixture Person must have exactly one Account principal');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await grantFixtureAuthority(client, { scope, requireDispatch: true,
      representations: [{ principalId: principal.rows[0]!.id, actor: person.actingSubject, action, lifetime: '8 hours' }],
      grant: { actor: person.actingSubject, action, lifetime: '8 hours' } });
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export default rowOutcomes('manga/work-hub-and-edition-choice', {
  visitor: proved('reads recorded and missing dates and named releases; private choice requires sign-in'),
  stranger: proved('retains an independent exact release and cannot read or change another reader’s choice'),
  member: proved('settles concurrent saves, replays the winner and retains the exact release pin'),
  owner: proved('maintains own release records and retains a private exact release choice'),
  moderator: proved('chooses as self; Realm moderation grants no foreign preference or Work editing authority'),
  operator: proved('platform authority grants no foreign preference; a separate Work mandate permits edition maintenance'),
}, { rights: {
  basis: 'original-contribution',
  credit: 'Original fictional manga text and native author credit belong to the fixture owner Person.',
} });
