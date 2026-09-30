import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { t } from 'elysia';
import { languageTag } from '../display-language/schema.ts';
import { canonicalLanguage } from '../display-language/select.ts';
import { ControlDenied, ControlInvalid } from '../access/topology-control.ts';

export const READING_LANGUAGE_LIMIT = 20;
export const readingLanguages = t.Array(languageTag, { maxItems: READING_LANGUAGE_LIMIT, uniqueItems: true });

/** The human's primary Person is independent of the current acting context.
 * The first-person index bounds this selection; both display and Home embed
 * it in the statement that reads the preference snapshot. */
export const PRIMARY_READING_PERSON_SQL = `SELECT a.agent_id
  FROM access.agent_provision a
  JOIN access.authority_subject s ON s.id = a.agent_id AND s.active
  JOIN access.representation r ON r.id = a.representation_id AND r.active
    AND r.principal_id = a.principal_id AND r.subject_id = a.agent_id
    AND r.action = 'agent.control' AND r.valid_until > clock_timestamp()
  WHERE a.principal_id = $1 AND a.agent_kind = 'person' AND a.state = 'active'
  ORDER BY a.created_at, a.id LIMIT 1`;

export async function primaryReadingPerson(client: PoolClient, owner: string): Promise<string> {
  const person = (await client.query<{ agent_id: string }>(PRIMARY_READING_PERSON_SQL, [owner])).rows[0];
  if (!person) throw new ControlDenied('A primary Person is required for reading preferences');
  return person.agent_id;
}

/** Canonical comparison tags, retaining reader priority rather than sorting. */
export function canonicalReadingLanguages(values: readonly string[]): string[] {
  if (!Array.isArray(values) || values.length > READING_LANGUAGE_LIMIT) {
    throw new ControlInvalid('Reading language limit exceeded');
  }
  const tags = values.map(canonicalLanguage);
  if (tags.some(tag => !tag)) throw new ControlInvalid('Invalid reading language');
  return [...new Set(tags as string[])];
}

/** Acquire before baselineMemberProof's share locks: concurrent settings and
 * Home writes must not both attempt to upgrade the same authority row. */
export async function lockReadingPreferences(client: PoolClient, agent: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`person-preferences:${agent}`]);
}

/** Home's CAS already admitted this transaction. Only change its language
 * field; advance the settings CAS without replacing unrelated choices. */
export async function writeReadingLanguages(client: PoolClient, agent: string, languages: string[]): Promise<void> {
  await client.query(`INSERT INTO access.person_preferences (agent_id, content_languages, version)
    VALUES ($1,$2,1) ON CONFLICT (agent_id) DO UPDATE SET
      content_languages = EXCLUDED.content_languages, version = access.person_preferences.version + 1,
      updated_at = clock_timestamp()`, [agent, languages]);
}

/** Settings writes invalidate Home cursors and stale Home commands too. */
export async function invalidateHomePreferences(client: PoolClient, owner: string): Promise<void> {
  await client.query(`INSERT INTO access.home_state (principal_id, revision) VALUES ($1,$2)
    ON CONFLICT (principal_id) DO UPDATE SET revision = EXCLUDED.revision`, [owner, randomUUID()]);
}
