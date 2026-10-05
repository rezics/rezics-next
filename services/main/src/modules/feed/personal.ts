import { randomUUID } from 'node:crypto';
import { t } from 'elysia';
import type { Static } from 'typebox';
import type { Pool } from 'pg';
import type { VerifiedPrincipal } from '../access/admission.ts';
import { controlRead, controlTransaction, ControlConflict, ControlInvalid, ControlStale,
  requirePrincipal } from '../access/topology-control.ts';
import { followPrincipal } from '../follows/authority.ts';
import { commandKey } from '../follows/store.ts';
import { digest } from '../recommendation/derived-generation.ts';
import { readId, readUuid } from '../work/read-contract.ts';
import { canonicalReadingLanguages, lockReadingPreferences, readingLanguages,
  primaryReadingPerson, PRIMARY_READING_PERSON_SQL, writeReadingLanguages } from '../preferences/languages.ts';

export const homePreferences = t.Object({ tab: t.Union([t.Literal('following'), t.Literal('all')]),
  sort: t.Union([t.Literal('best'), t.Literal('new'), t.Literal('top')]),
  density: t.Union([t.Literal('card'), t.Literal('compact')]),
  contentLanguages: readingLanguages,
  recommendations: t.Boolean() }, { additionalProperties: false });
export type HomePreferences = Static<typeof homePreferences>;
export const preferencesCommand = t.Object({ actingSubject: readId, expectedRevision: t.Nullable(readUuid),
  preferences: homePreferences }, { additionalProperties: false });
export const exclusionKind = t.Union([t.Literal('activity'), t.Literal('realm'), t.Literal('tag'),
  t.Literal('kind'), t.Literal('person'), t.Literal('work'), t.Literal('continue')]);
export type ExclusionKind = Static<typeof exclusionKind>;
export const exclusionCommand = t.Object({ actingSubject: readId, kind: exclusionKind,
  target: t.String({ minLength: 1, maxLength: 200 }),
  strength: t.Union([t.Literal('hide'), t.Literal('fewer'), t.Literal('mute'),
    t.Literal('not-interested'), t.Literal('clear')]) },
{ additionalProperties: false });
export type ExclusionCommand = Static<typeof exclusionCommand>;
export const watermarkScope = t.Union([t.Literal('following'), t.Literal('all'),
  t.String({ pattern: '^realm:https://rezics\\.com/id/[0-9a-f-]{36}$' })]);
export const watermarkCommand = t.Object({ actingSubject: readId, scope: watermarkScope,
  dataEpoch: t.String({ minLength: 1, maxLength: 128 }), sequence: t.String({ pattern: '^\\d{1,30}$' }) },
{ additionalProperties: false });
export type WatermarkCommand = Static<typeof watermarkCommand>;
export interface HomeExclusion { kind: ExclusionKind; target: string;
  strength: 'hide' | 'fewer' | 'mute' | 'not-interested' }
export const HOME_COST = { exclusions: 1000, pageCandidates: 8, headCandidates: 101,
  watermarks: 1002, preferenceReadStatements: 4, preferenceWriteStatements: 12,
  responseBytes: 64 * 1024 } as const;
export const defaultPreferences: HomePreferences = { tab: 'following', sort: 'best', density: 'card',
  contentLanguages: [], recommendations: true };

export class HomePersonalStore {
  constructor(private readonly pool: Pool) {}

  /** The closing read needs only the owner revision, not E exclusions again.
   * All preference/language/exclusion writes advance home_state in their own
   * transaction. Recheck current authority and recovery, then seek one PK:
   * eight SQL statements, <=1 state row, independent of E/follows/history.
   * A fresh Read Committed statement sees completed intervening writes:
   * https://www.postgresql.org/docs/18/transaction-iso.html#XACT-READ-COMMITTED
   * (reviewed 2026-10-04). Reusing the opening snapshot or a cached permission
   * would miss changes; reloading the full inventory adds no fence evidence. */
  async fence(principal: VerifiedPrincipal, agent: string): Promise<{ revision: string | null }> {
    return controlRead(this.pool, async client => {
      const owner = await followPrincipal(client, principal, agent);
      const row = (await client.query<{ revision: string }>(
        'SELECT revision FROM access.home_state WHERE principal_id = $1', [owner])).rows[0];
      return { revision: row?.revision ?? null };
    });
  }

  async read(principal: VerifiedPrincipal, agent: string) {
    return controlRead(this.pool, async client => {
      const owner = await followPrincipal(client, principal, agent);
      // Revision and languages must share one statement snapshot: a settings
      // write changes both atomically, including when Home has no row yet.
      const state = (await client.query<{ revision: string | null;
        preferences: Omit<HomePreferences, 'contentLanguages'> | null; content_languages: string[] | null }>(
        `SELECT h.revision, h.preferences, p.content_languages
          FROM (SELECT $1::uuid AS principal_id) principal
          LEFT JOIN access.home_state h ON h.principal_id = principal.principal_id
          LEFT JOIN (${PRIMARY_READING_PERSON_SQL}) reader ON true
          LEFT JOIN access.person_preferences p ON p.agent_id = reader.agent_id`, [owner])).rows[0];
      const rows = (await client.query<HomeExclusion>(`SELECT kind, target, strength FROM access.home_exclusion
        WHERE principal_id = $1 ORDER BY kind, target LIMIT $2`, [owner, HOME_COST.exclusions + 1])).rows;
      if (rows.length > HOME_COST.exclusions) throw new ControlInvalid('Home exclusion budget exceeded');
      return { owner, revision: state?.revision ?? null,
        preferences: { ...(state?.preferences ?? defaultPreferences),
          contentLanguages: state?.content_languages ?? [] }, exclusions: rows };
    });
  }

  async preferences(principal: VerifiedPrincipal, input: Static<typeof preferencesCommand>, key: string) {
    commandKey(key);
    if (input.preferences.tab === 'following' && input.preferences.sort === 'top') {
      throw new ControlInvalid('Top requires All');
    }
    input = { ...input, preferences: { ...input.preferences,
      contentLanguages: canonicalReadingLanguages(input.preferences.contentLanguages) } };
    return controlTransaction(this.pool, async client => {
      const identity = await requirePrincipal(client, principal);
      const languageAgent = await primaryReadingPerson(client, identity.id);
      await lockReadingPreferences(client, languageAgent);
      const owner = await followPrincipal(client, principal, input.actingSubject);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`home:${owner}`]);
      const intent = digest(input);
      const receipt = (await client.query<{ request_digest: string; result: object }>(
        'SELECT request_digest, result FROM access.home_command_receipt WHERE principal_id = $1 AND idempotency_key = $2',
        [owner, key])).rows[0];
      if (receipt) {
        if (receipt.request_digest !== intent) throw new ControlConflict('Idempotency key has another home intent');
        return { ...receipt.result, replayed: true };
      }
      const prior = (await client.query<{ revision: string }>(
        'SELECT revision FROM access.home_state WHERE principal_id = $1 FOR UPDATE', [owner])).rows[0];
      if ((prior?.revision ?? null) !== input.expectedRevision) throw new ControlStale('Home preferences changed');
      const revision = randomUUID();
      const { contentLanguages, ...preferences } = input.preferences;
      await writeReadingLanguages(client, languageAgent, contentLanguages);
      await client.query(`INSERT INTO access.home_state (principal_id, revision, preferences) VALUES ($1,$2,$3)
        ON CONFLICT (principal_id) DO UPDATE SET revision = EXCLUDED.revision, preferences = EXCLUDED.preferences`,
      [owner, revision, preferences]);
      const result = { profile: 'home-preferences-v1', revision, preferences: input.preferences, replayed: false };
      await client.query(`INSERT INTO access.home_command_receipt (principal_id, idempotency_key, request_digest, result)
        VALUES ($1,$2,$3,$4)`, [owner, key, intent, result]);
      return result;
    });
  }

  async exclusion(principal: VerifiedPrincipal, input: ExclusionCommand, key: string) {
    commandKey(key);
    if (input.kind === 'kind' ? !['work', 'added', 'contribution', 'adoption', 'decision', 'discussion', 'reply', 'collection', 'review'].includes(input.target)
      : !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(input.target)) {
      throw new ControlInvalid('Invalid exclusion target');
    }
    if (input.strength === 'hide' && !['activity', 'work', 'continue'].includes(input.kind)
      || input.strength === 'fewer' && input.kind === 'activity'
      || input.strength === 'mute' && !['realm', 'tag', 'person'].includes(input.kind)
      || input.strength === 'not-interested' && input.kind !== 'work') {
      throw new ControlInvalid('Invalid exclusion action');
    }
    if (input.kind === 'continue' && !['hide', 'clear'].includes(input.strength)) {
      throw new ControlInvalid('Invalid Continue command');
    }
    return controlTransaction(this.pool, async client => {
      const owner = await followPrincipal(client, principal, input.actingSubject);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`home:${owner}`]);
      const intent = digest(input);
      const receipt = (await client.query<{ request_digest: string; result: object }>(
        'SELECT request_digest, result FROM access.home_command_receipt WHERE principal_id = $1 AND idempotency_key = $2',
        [owner, key])).rows[0];
      if (receipt) {
        if (receipt.request_digest !== intent) throw new ControlConflict('Idempotency key has another home intent');
        return { ...receipt.result, replayed: true };
      }
      const count = (await client.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM access.home_exclusion WHERE principal_id = $1', [owner])).rows[0]!;
      const existing = (await client.query(`SELECT 1 FROM access.home_exclusion
        WHERE principal_id = $1 AND kind = $2 AND target = $3`,
      [owner, input.kind, input.target])).rowCount;
      if (Number(count.count) >= HOME_COST.exclusions && !existing && input.strength !== 'clear') {
        throw new ControlInvalid('Home exclusion limit reached');
      }
      if (input.kind === 'tag' && input.strength !== 'clear') {
        const tags = (await client.query<{ count: string }>(`SELECT count(*)::text AS count
          FROM access.home_exclusion WHERE principal_id = $1 AND kind = 'tag' AND target <> $2`,
        [owner, input.target])).rows[0]!;
        if (Number(tags.count) >= 3) throw new ControlInvalid('At most three muted tags are supported');
      }
      if (input.strength === 'clear') await client.query(`DELETE FROM access.home_exclusion
        WHERE principal_id = $1 AND kind = $2 AND target = $3`, [owner, input.kind, input.target]);
      else await client.query(`INSERT INTO access.home_exclusion (principal_id, kind, target, strength)
        VALUES ($1,$2,$3,$4) ON CONFLICT (principal_id, kind, target) DO UPDATE
        SET strength = EXCLUDED.strength, updated_at = clock_timestamp()`,
      [owner, input.kind, input.target, input.strength]);
      const revision = randomUUID();
      await client.query(`INSERT INTO access.home_state (principal_id, revision) VALUES ($1,$2)
        ON CONFLICT (principal_id) DO UPDATE SET revision = EXCLUDED.revision`, [owner, revision]);
      const result = { profile: 'home-exclusion-v1', ...input, revision, replayed: false };
      await client.query(`INSERT INTO access.home_command_receipt (principal_id, idempotency_key, request_digest, result)
        VALUES ($1,$2,$3,$4)`, [owner, key, intent, result]);
      return result;
    });
  }

  async watermark(principal: VerifiedPrincipal, input: WatermarkCommand, key: string, epoch: string) {
    commandKey(key);
    if (input.dataEpoch !== epoch) throw new ControlStale('Feed epoch changed');
    return controlTransaction(this.pool, async client => {
      const owner = await followPrincipal(client, principal, input.actingSubject);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`home:${owner}`]);
      const intent = digest(input);
      const receipt = (await client.query<{ request_digest: string; result: object }>(
        'SELECT request_digest, result FROM access.home_command_receipt WHERE principal_id = $1 AND idempotency_key = $2',
        [owner, key])).rows[0];
      if (receipt) {
        if (receipt.request_digest !== intent) throw new ControlConflict('Idempotency key has another home intent');
        return { ...receipt.result, replayed: true };
      }
      // A plain read: the sequence only grows within an epoch, and a row
      // stamped with a replaced epoch reads as no watermark. Share-locking the
      // singleton queued every PUT behind the projection's writers.
      const checkpoint = (await client.query<{ sequence: string; data_epoch: string }>(
        'SELECT sequence::text AS sequence, data_epoch FROM access.feed_checkpoint WHERE id')).rows[0];
      if (!checkpoint || checkpoint.data_epoch !== epoch || BigInt(input.sequence) > BigInt(checkpoint.sequence)) {
        throw new ControlStale('Feed position changed');
      }
      const inventory = (await client.query<{ count: string; present: boolean }>(`SELECT count(*)::text AS count,
        bool_or(scope = $2) AS present FROM access.home_watermark WHERE principal_id = $1`,
      [owner, input.scope])).rows[0]!;
      if (Number(inventory.count) >= HOME_COST.watermarks && !inventory.present) {
        throw new ControlInvalid('Home watermark limit reached');
      }
      const written = (await client.query<{ sequence: string }>(`INSERT INTO access.home_watermark (principal_id, scope, data_epoch, sequence)
        VALUES ($1,$2,$3,$4) ON CONFLICT (principal_id, scope) DO UPDATE SET
        data_epoch = EXCLUDED.data_epoch,
        sequence = CASE WHEN access.home_watermark.data_epoch = EXCLUDED.data_epoch
          THEN greatest(access.home_watermark.sequence, EXCLUDED.sequence) ELSE EXCLUDED.sequence END,
        updated_at = clock_timestamp() RETURNING sequence::text AS sequence`,
      [owner, input.scope, epoch, input.sequence])).rows[0]!;
      const result = { profile: 'home-watermark-v1', scope: input.scope, dataEpoch: epoch,
        sequence: written.sequence, replayed: false };
      await client.query(`INSERT INTO access.home_command_receipt (principal_id, idempotency_key, request_digest, result)
        VALUES ($1,$2,$3,$4)`, [owner, key, intent, result]);
      return result;
    });
  }

  async watermarks(principal: VerifiedPrincipal, agent: string) {
    return controlRead(this.pool, async client => {
      const owner = await followPrincipal(client, principal, agent);
      const rows = (await client.query<{ scope: string; data_epoch: string; sequence: string; updated_at: Date }>(
        `SELECT scope, data_epoch, sequence::text AS sequence, updated_at FROM access.home_watermark
          WHERE principal_id = $1 ORDER BY scope LIMIT $2`, [owner, HOME_COST.watermarks + 1])).rows;
      if (rows.length > HOME_COST.watermarks) throw new ControlInvalid('Home watermark budget exceeded');
      return rows;
    });
  }

  async getWatermark(principal: VerifiedPrincipal, agent: string, scope: string) {
    return controlRead(this.pool, async client => {
      const owner = await followPrincipal(client, principal, agent);
      return (await client.query<{ data_epoch: string; sequence: string; updated_at: Date }>(
        `SELECT data_epoch, sequence::text AS sequence, updated_at FROM access.home_watermark
          WHERE principal_id = $1 AND scope = $2`, [owner, scope])).rows[0] ?? null;
    });
  }
}
