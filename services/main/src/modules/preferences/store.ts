import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { VerifiedPrincipal } from '../access/admission.ts';
import { agentPattern, controlRead, controlTransaction, ControlConflict, ControlDenied,
  ControlInvalid, ControlStale, requirePrincipal } from '../access/topology-control.ts';
import { baselineMemberProof } from '../access/baseline.ts';
import { followPrincipal } from '../follows/authority.ts';
import { canonicalReadingLanguages, invalidateHomePreferences, lockReadingPreferences,
  READING_LANGUAGE_LIMIT } from './languages.ts';

export interface PersonChoices {
  profileVisibility: 'public' | 'private';
  followPolicy: 'everyone' | 'nobody';
  hideReadingActivity: boolean;
  contentLanguages: string[];
  spoilerPolicy: 'hide-unread' | 'show';
  adultContent: boolean;
}
export interface PersonPreferences extends PersonChoices { profile: 'person-preferences-v1'; version: number;
  blockedPeople: string[]; replayed?: boolean }
export const DEFAULT_PERSON_CHOICES: PersonChoices = { profileVisibility: 'public', followPolicy: 'everyone',
  hideReadingActivity: false, contentLanguages: [], spoilerPolicy: 'hide-unread', adultContent: false };
/** One bounded settings row and at most 500 blocks; page admission checks at most 128 actors. */
export const PERSON_PREFERENCES_COST = { blocks: 500, actors: 128, readingActors: 256, readStatements: 4,
  writeStatements: 11, readerLanguageStatements: 2, languages: READING_LANGUAGE_LIMIT } as const;
const keyPattern = /^[A-Za-z0-9:_./-]{1,128}$/;
interface Row { profile_visibility: PersonChoices['profileVisibility']; follow_policy: PersonChoices['followPolicy'];
  hide_reading_activity: boolean; content_languages: string[]; spoiler_policy: PersonChoices['spoilerPolicy'];
  adult_content: boolean; version: number }
function choices(row?: Row): PersonChoices {
  return row ? { profileVisibility: row.profile_visibility, followPolicy: row.follow_policy,
    hideReadingActivity: row.hide_reading_activity, contentLanguages: row.content_languages,
    spoilerPolicy: row.spoiler_policy, adultContent: row.adult_content } : DEFAULT_PERSON_CHOICES;
}
function valid(value: PersonChoices): boolean {
  return !!value && ['public', 'private'].includes(value.profileVisibility)
    && ['everyone', 'nobody'].includes(value.followPolicy)
    && typeof value.hideReadingActivity === 'boolean' && value.adultContent === false
    && ['hide-unread', 'show'].includes(value.spoilerPolicy)
    && Array.isArray(value.contentLanguages) && value.contentLanguages.length <= READING_LANGUAGE_LIMIT;
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export class PersonPreferencesStore {
  constructor(private readonly pool: Pool) {}

  /** Display-language selection follows the reader's first active Person,
   * independently of an Organization or Service acting context. Two indexed
   * statements and one bounded language array; it grants no target authority. */
  async languagesForReader(principal: VerifiedPrincipal): Promise<string[]> {
    return controlRead(this.pool, async client => {
      const owner = await requirePrincipal(client, principal);
      if (!principal.emailVerified) return [];
      const row = (await client.query<{ content_languages: string[] | null }>(`SELECT p.content_languages
        FROM access.agent_provision a
        JOIN access.authority_subject s ON s.id = a.agent_id AND s.active
        JOIN access.representation r ON r.id = a.representation_id AND r.active
          AND r.principal_id = a.principal_id AND r.subject_id = a.agent_id
          AND r.action = 'agent.control' AND r.valid_until > clock_timestamp()
        LEFT JOIN access.person_preferences p ON p.agent_id = a.agent_id
        WHERE a.principal_id = $1 AND a.agent_kind = 'person' AND a.state = 'active'
        ORDER BY a.created_at, a.id LIMIT 1`, [owner.id])).rows[0];
      return row?.content_languages ?? [];
    });
  }

  async read(principal: VerifiedPrincipal, agent: string): Promise<PersonPreferences> {
    if (!agentPattern.test(agent)) throw new ControlInvalid('Invalid person Agent');
    return controlRead(this.pool, async client => {
      const owner = await followPrincipal(client, principal, agent);
      const row = (await client.query<Row>('SELECT * FROM access.person_preferences WHERE agent_id = $1', [agent])).rows[0];
      const blocks = (await client.query<{ target_agent: string }>(`SELECT target_agent FROM access.person_block
        WHERE principal_id = $1 ORDER BY target_agent LIMIT $2`, [owner, PERSON_PREFERENCES_COST.blocks + 1])).rows;
      if (blocks.length > PERSON_PREFERENCES_COST.blocks) throw new ControlInvalid('Block limit exceeded');
      return { profile: 'person-preferences-v1', ...choices(row), version: row?.version ?? 0,
        blockedPeople: blocks.map(item => item.target_agent) };
    });
  }

  async write(principal: VerifiedPrincipal, agent: string, value: PersonChoices, expectedVersion: number,
    key: string): Promise<PersonPreferences> {
    if (!agentPattern.test(agent) || !valid(value) || !Number.isSafeInteger(expectedVersion)
      || expectedVersion < 0 || !keyPattern.test(key)) throw new ControlInvalid('Invalid preferences command');
    value = { ...value, contentLanguages: canonicalReadingLanguages(value.contentLanguages) };
    return controlTransaction(this.pool, async client => {
      await lockReadingPreferences(client, agent);
      const owner = await followPrincipal(client, principal, agent);
      // A target follow takes a share lock on this row. Changing who may follow
      // and admitting a follow therefore have a single serial order.
      await client.query(`SELECT id FROM access.authority_subject WHERE id = $1 AND active FOR UPDATE`, [agent]);
      const intent = hash([agent, value, expectedVersion]);
      const receipt = (await client.query<{ request_digest: string; result: PersonPreferences }>(
        'SELECT request_digest, result FROM access.person_preferences_receipt WHERE principal_id = $1 AND idempotency_key = $2',
        [owner, key])).rows[0];
      if (receipt) {
        if (receipt.request_digest !== intent) throw new ControlConflict('Idempotency key has another preferences intent');
        return { ...receipt.result, replayed: true };
      }
      const current = (await client.query<Row>(`SELECT * FROM access.person_preferences
        WHERE agent_id = $1 FOR UPDATE`, [agent])).rows[0];
      if ((current?.version ?? 0) !== expectedVersion) throw new ControlStale('Preferences changed');
      const row = (await client.query<Row>(`INSERT INTO access.person_preferences (agent_id, profile_visibility,
        follow_policy, hide_reading_activity, content_languages, spoiler_policy, adult_content, version)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (agent_id) DO UPDATE SET
          profile_visibility = EXCLUDED.profile_visibility, follow_policy = EXCLUDED.follow_policy,
          hide_reading_activity = EXCLUDED.hide_reading_activity,
          content_languages = EXCLUDED.content_languages, spoiler_policy = EXCLUDED.spoiler_policy,
          adult_content = EXCLUDED.adult_content, version = EXCLUDED.version,
          updated_at = clock_timestamp() RETURNING *`, [agent, value.profileVisibility, value.followPolicy,
          value.hideReadingActivity, value.contentLanguages, value.spoilerPolicy, value.adultContent,
          expectedVersion + 1])).rows[0]!;
      await invalidateHomePreferences(client, owner);
      const blockedPeople = (await client.query<{ target_agent: string }>(`SELECT target_agent FROM access.person_block
        WHERE principal_id = $1 ORDER BY target_agent LIMIT $2`, [owner, PERSON_PREFERENCES_COST.blocks + 1])).rows
        .map(item => item.target_agent);
      const result: PersonPreferences = { profile: 'person-preferences-v1', ...choices(row),
        version: row.version, blockedPeople };
      await client.query(`INSERT INTO access.person_preferences_receipt
        (principal_id, idempotency_key, request_digest, result) VALUES ($1,$2,$3,$4)`, [owner, key, intent, result]);
      return result;
    });
  }

  async block(principal: VerifiedPrincipal, agent: string, target: string, blocked: boolean,
    key: string): Promise<{ target: string; blocked: boolean; replayed: boolean }> {
    if (!agentPattern.test(agent) || !(agentPattern.test(target) || /^@[a-z0-9_]{3,30}$/.test(target))
      || typeof blocked !== 'boolean' || !keyPattern.test(key)) throw new ControlInvalid('Invalid block command');
    return controlTransaction(this.pool, async client => {
      const owner = await followPrincipal(client, principal, agent);
      await client.query('SELECT id FROM access.principal WHERE id = $1 FOR UPDATE', [owner]);
      const intent = hash([agent, target, blocked]);
      const receipt = (await client.query<{ request_digest: string; result: { target: string; blocked: boolean } }>(
        'SELECT request_digest, result FROM access.person_block_receipt WHERE principal_id = $1 AND idempotency_key = $2',
        [owner, key])).rows[0];
      if (receipt) {
        if (receipt.request_digest !== intent) throw new ControlConflict('Idempotency key has another block intent');
        return { ...receipt.result, replayed: true };
      }
      const resolved = target.startsWith('@') ? (await client.query<{ agent_id: string }>(`SELECT agent_id
        FROM access.agent_handle WHERE handle = $1 AND state = 'current'`, [target.slice(1)])).rows[0]?.agent_id
        : target;
      if (!resolved || resolved === agent) throw new ControlInvalid('Invalid block target');
      if (blocked) {
        const active = await client.query(`SELECT 1 FROM access.authority_subject
          WHERE id = $1 AND kind = 'agent' AND active`, [resolved]);
        if (!active.rowCount) throw new ControlDenied('Person unavailable');
        const count = (await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM access.person_block
          WHERE principal_id = $1`, [owner])).rows[0]!;
        const already = await client.query(`SELECT 1 FROM access.person_block
          WHERE principal_id = $1 AND target_agent = $2`, [owner, resolved]);
        if (Number(count.count) >= PERSON_PREFERENCES_COST.blocks && !already.rowCount) {
          throw new ControlInvalid('Block limit reached');
        }
        await client.query(`INSERT INTO access.person_block (principal_id, target_agent) VALUES ($1,$2)
          ON CONFLICT DO NOTHING`, [owner, resolved]);
      } else await client.query(`DELETE FROM access.person_block WHERE principal_id = $1 AND target_agent = $2`,
        [owner, resolved]);
      const result = { target: resolved, blocked, replayed: false };
      await client.query(`INSERT INTO access.person_block_receipt
        (principal_id, idempotency_key, request_digest, result) VALUES ($1,$2,$3,$4)`, [owner, key, intent, result]);
      return result;
    });
  }

  async blockedActors(principal: VerifiedPrincipal, agent: string, actors: readonly string[]): Promise<Set<string>> {
    if (actors.length > PERSON_PREFERENCES_COST.actors || actors.some(actor => !agentPattern.test(actor))) {
      throw new ControlInvalid('Actor batch exceeds block budget');
    }
    if (!actors.length) return new Set();
    return controlRead(this.pool, async client => {
      const owner = await followPrincipal(client, principal, agent);
      const rows = await client.query<{ target_agent: string }>(`SELECT target_agent FROM access.person_block
        WHERE principal_id = $1 AND target_agent = ANY($2::text[])`, [owner, actors]);
      return new Set(rows.rows.map(row => row.target_agent));
    });
  }

  /** Home asks once for its bounded source authors, then once at disclosure. */
  async hiddenReadingActors(actors: readonly string[]): Promise<Set<string>> {
    if (actors.length > PERSON_PREFERENCES_COST.readingActors
      || actors.some(actor => !agentPattern.test(actor))) {
      throw new ControlInvalid('Reading activity actor batch exceeds budget');
    }
    if (!actors.length) return new Set();
    return controlRead(this.pool, async client => {
      const rows = await client.query<{ agent_id: string }>(`SELECT agent_id
        FROM access.person_preferences WHERE agent_id = ANY($1::text[])
          AND hide_reading_activity = true`, [actors]);
      return new Set(rows.rows.map(row => row.agent_id));
    });
  }

  async profileVisible(agent: string, principal: VerifiedPrincipal | null): Promise<boolean> {
    if (!agentPattern.test(agent)) return false;
    return controlRead(this.pool, async client => {
      const row = (await client.query<{ profile_visibility: 'public' | 'private' }>(
        'SELECT profile_visibility FROM access.person_preferences WHERE agent_id = $1', [agent])).rows[0];
      if (row?.profile_visibility !== 'private') return true;
      if (!principal) return false;
      const identity = await requirePrincipal(client, principal);
      return !!await baselineMemberProof(client, identity.id, agent);
    });
  }
}
