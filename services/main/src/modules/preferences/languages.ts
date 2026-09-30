import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { t } from 'elysia';
import { languageTag } from '../display-language/schema.ts';
import { canonicalLanguage } from '../display-language/select.ts';
import { ControlInvalid } from '../access/topology-control.ts';

export const READING_LANGUAGE_LIMIT = 20;
export const readingLanguages = t.Array(languageTag, { maxItems: READING_LANGUAGE_LIMIT, uniqueItems: true });

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
