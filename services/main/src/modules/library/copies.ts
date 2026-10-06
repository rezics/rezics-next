import { createHash, randomUUID } from 'node:crypto';
import { t } from 'elysia';
import type { Pool, PoolClient } from 'pg';
import type { Static } from 'typebox';
import { Value } from 'typebox/value';
import { readId } from '../work/read-contract.ts';
import { decodeReadCursor, encodeReadCursor, WorkReadUnavailable } from '../work/read-session.ts';
import { resolveTargets } from '../target/resolve.ts';
import { GRAPHS, iri } from '../work/activate.ts';
import type { WorkReadSession } from '../work/read-session.ts';

const closed = { additionalProperties: false };
export const libraryParty = t.Union([
  t.Object({ kind: t.Literal('person'), person: readId }, closed),
  t.Object({ kind: t.Literal('name'), name: t.String({ minLength: 1, maxLength: 300 }) }, closed),
]);
export type LibraryParty = Static<typeof libraryParty>;
export const libraryTime = t.String({ format: 'date-time', maxLength: 40 });
export const copyChanges = {
  format: t.Optional(t.Nullable(t.String({ minLength: 1, maxLength: 100 }))),
  acquiredFrom: t.Optional(t.Nullable(libraryParty)),
  acquiredAt: t.Optional(t.Nullable(libraryTime)),
  ownedFrom: t.Optional(t.Nullable(libraryTime)),
  ownedThrough: t.Optional(t.Nullable(libraryTime)),
};
export const copyState = t.Object({ id: readId, work: readId, release: readId,
  format: t.Nullable(t.String()), acquiredFrom: t.Nullable(libraryParty),
  acquiredAt: t.Nullable(libraryTime), ownedFrom: t.Nullable(libraryTime), ownedThrough: t.Nullable(libraryTime),
  removed: t.Boolean(), version: t.Integer({ minimum: 1 }), changedAt: libraryTime }, closed);
export type CopyState = Static<typeof copyState>;
export type CopyChanges = Partial<Pick<CopyState, 'format' | 'acquiredFrom' | 'acquiredAt' | 'ownedFrom' | 'ownedThrough'>>;
export interface LibraryRecordCommand { agent: string; expectedVersion: number; idempotencyKey: string }
export class InvalidLibraryRecord extends Error {}
export class StaleLibraryRecord extends Error {}
export class LibraryRecordConflict extends Error {}
export class LibraryRecordMissing extends Error {}
export class LibraryRecordDenied extends Error {}
export const LIBRARY_RECORD_COST = { page: 20, pageRows: 21, pageStatements: 5,
  writeStatements: 18, releaseBatch: 1, ordering: 'indexed keyset O(log N + P)',
  writes: 'one owner, command and copy lock; O(log N)', responseBytes: 96 * 1024 } as const;
const key = /^[A-Za-z0-9:_./-]{1,128}$/;
export function validateLibraryCommand(input: LibraryRecordCommand) {
  if (!Value.Check(readId, input.agent) || !key.test(input.idempotencyKey)
    || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0
    || input.expectedVersion >= Number.MAX_SAFE_INTEGER) throw new InvalidLibraryRecord('Invalid library command');
}
export function libraryTimestamp(value: string): string {
  // Store millisecond UTC instants so PostgreSQL keysets and portable values agree.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    || !Value.Check(libraryTime, value)) throw new InvalidLibraryRecord('Use a valid timestamp with timezone');
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) {
    throw new InvalidLibraryRecord('Timestamp must be within years 0001 to 9999');
  }
  return date.toISOString();
}
export function validateLibraryParty(party: LibraryParty) {
  if (!Value.Check(libraryParty, party) || party.kind === 'name' && !party.name.trim()) {
    throw new InvalidLibraryRecord('Choose a Person reference or a nonempty name');
  }
}
const partyIntent = (party: LibraryParty | null) => party === null ? null
  : party.kind === 'person' ? ['person', party.person] : ['name', party.name];
export async function resolveCopyRelease(session: WorkReadSession, release: string) {
  const [target] = await resolveTargets(session, [release], 'session');
  if (!target || target.base !== 'release' || target.resource !== release || !target.work) {
    throw new InvalidLibraryRecord('A copy must reference an exact release');
  }
  return { work: target.work, release };
}
export async function resolveLibraryParty(session: WorkReadSession, party: LibraryParty) {
  validateLibraryParty(party);
  if (party.kind === 'name') return;
  const rows = await session.query(`SELECT ?person WHERE { GRAPH ${iri(GRAPHS.current)} {
    VALUES ?person { ${iri(party.person)} }
    ?person a rv:Agent ; rv:agentKind rv:PersonAgent ; rv:profileDisclosure rv:Public .
  } } LIMIT 2`, 1);
  if (rows.length !== 1) throw new InvalidLibraryRecord('Person reference is unavailable; use a free-text name');
}

/** Receipts precede target resolution so a lost-response retry still succeeds
 * after graph withdrawal. Every copy mutation and loan mutation shares its lock. */
export async function libraryRecordWrite<T extends object>(pool: Pool, input: LibraryRecordCommand,
  intent: unknown, copy: string | null, effect: (client: PoolClient) => Promise<T>,
  authorize?: () => Promise<void>): Promise<T & { replayed: boolean }> {
  validateLibraryCommand(input);
  const digest = createHash('sha256').update(JSON.stringify(intent)).digest('hex');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    // The erasure hook takes the same owner lock before removing private records.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify(['library-upload', input.agent])]);
    await authorize?.();
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
      [JSON.stringify(['library-copy-loan-key', input.agent, input.idempotencyKey])]);
    const prior = (await client.query<{ request_digest: string; result: T }>(`
      SELECT request_digest,result FROM reader.library_copy_loan_command WHERE agent=$1 AND idempotency_key=$2`,
    [input.agent, input.idempotencyKey])).rows[0];
    if (prior) {
      if (prior.request_digest !== digest) throw new LibraryRecordConflict('Idempotency-Key has another intent');
      await client.query('COMMIT');
      return { ...prior.result, replayed: true };
    }
    if (copy) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
      [JSON.stringify(['library-copy', input.agent, copy])]);
    const result = await effect(client);
    await authorize?.();
    await client.query(`INSERT INTO reader.library_copy_loan_command(agent,idempotency_key,request_digest,result)
      VALUES ($1,$2,$3,$4)`, [input.agent, input.idempotencyKey, digest, JSON.stringify(result)]);
    await client.query('COMMIT');
    return { ...result, replayed: false };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export async function libraryRecordPage<T>(pool: Pool, agent: string, binding: unknown,
  options: { limit?: number; cursor?: string },
  read: (client: PoolClient, after: string | null, limit: number) => Promise<Array<{ key: string; value: T }>>) {
  const limit = options.limit ?? LIBRARY_RECORD_COST.page;
  if (!Value.Check(readId, agent) || !Number.isSafeInteger(limit) || limit < 1 || limit > LIBRARY_RECORD_COST.page) {
    throw new InvalidLibraryRecord('Invalid library page');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout = '5s'");
    const owner = (await client.query<{ data_epoch: string; version: string }>(`SELECT c.data_epoch,
      coalesce(f.version,0)::text AS version FROM content.owner_control c
      LEFT JOIN reader.library_bundle_fence f ON f.agent=$1 WHERE c.singleton`, [agent])).rows[0];
    if (!owner) throw new WorkReadUnavailable('Library position unavailable');
    const position = { dataEpoch: owner.data_epoch, sequence: owner.version };
    const cursor = decodeReadCursor(options.cursor, binding, position);
    const rows = await read(client, cursor?.after ?? null, limit + 1);
    const page = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? encodeReadCursor(binding, position, page.at(-1)!.key) : null;
    await client.query('COMMIT');
    return { items: page.map(row => row.value), nextCursor };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export class LibraryCopyStore {
  constructor(private readonly pool: Pool) {}
  async page(agent: string, work: string, options: { limit?: number; cursor?: string }) {
    if (!Value.Check(readId, work)) throw new InvalidLibraryRecord('Invalid Work');
    return libraryRecordPage(this.pool, agent, ['library-copies-v1', agent, work], options, async (client, after, limit) => {
      if (after && !Value.Check(readId, after)) throw new InvalidLibraryRecord('Invalid copy cursor');
      const rows = await client.query<{ id: string; state: CopyState }>(`SELECT id,state FROM reader.library_copy
        WHERE agent=$1 AND work=$2 AND NOT removed AND id>$3 ORDER BY id LIMIT $4`, [agent, work, after ?? '', limit]);
      return rows.rows.map(row => ({ key: row.id, value: row.state }));
    });
  }
  async write(input: LibraryRecordCommand & { id?: string; release?: string; changes: CopyChanges; remove?: boolean },
    resolve: () => Promise<{ work: string; release: string }>, authorize?: () => Promise<void>,
    checkParty?: (party: LibraryParty) => Promise<void>) {
    const create = input.id === undefined;
    if (create && (input.expectedVersion !== 0 || !Value.Check(readId, input.release))
      || !create && (!Value.Check(readId, input.id) || input.release !== undefined)
      || !Value.Check(t.Object(copyChanges, closed), input.changes)
      || create && input.remove || !create && !input.remove && !Object.values(input.changes).some(value => value !== undefined)) {
      throw new InvalidLibraryRecord('Invalid copy operation');
    }
    const changes = Object.fromEntries(Object.entries(input.changes).filter(([, value]) => value !== undefined)) as CopyChanges;
    if (changes.acquiredFrom) validateLibraryParty(changes.acquiredFrom);
    const intent = ['copy', input.id ?? null, input.release ?? null, input.expectedVersion, input.remove ?? false,
      ...(['format', 'acquiredFrom', 'acquiredAt', 'ownedFrom', 'ownedThrough'] as const)
        .map(field => changes[field] === undefined ? ['keep'] : field === 'acquiredFrom'
          ? partyIntent(changes.acquiredFrom!) : changes[field])];
    return libraryRecordWrite(this.pool, input, intent, input.id ?? null, async client => {
      const id = input.id ?? `https://rezics.com/id/${randomUUID()}`;
      const current = create ? null : (await client.query<{ state: CopyState }>(`
        SELECT state FROM reader.library_copy WHERE agent=$1 AND id=$2 FOR UPDATE`, [input.agent, id])).rows[0]?.state;
      if (!create && (!current || current.removed)) throw new LibraryRecordMissing('Copy unavailable');
      if ((current?.version ?? 0) !== input.expectedVersion) throw new StaleLibraryRecord('Copy changed');
      if (input.remove && (await client.query(`SELECT 1 FROM reader.library_loan
        WHERE agent=$1 AND copy=$2 AND returned_at IS NULL LIMIT 1`, [input.agent, id])).rowCount) {
        throw new LibraryRecordConflict('Return the active loan before removing its copy');
      }
      const target = current ?? await resolve();
      if (changes.acquiredFrom) await checkParty?.(changes.acquiredFrom);
      const saved: CopyState = { id, work: target.work, release: target.release,
        format: current?.format ?? null, acquiredFrom: current?.acquiredFrom ?? null,
        acquiredAt: current?.acquiredAt ?? null, ownedFrom: current?.ownedFrom ?? null, ownedThrough: current?.ownedThrough ?? null,
        ...changes, removed: input.remove ?? false, version: input.expectedVersion + 1,
        changedAt: (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now.toISOString() };
      for (const field of ['acquiredAt', 'ownedFrom', 'ownedThrough'] as const) {
        if (saved[field] !== null) saved[field] = libraryTimestamp(saved[field]);
      }
      if (saved.ownedFrom && saved.ownedThrough && saved.ownedFrom > saved.ownedThrough) {
        throw new InvalidLibraryRecord('Ownership end precedes its start');
      }
      await client.query(`INSERT INTO reader.library_copy(agent,id,work,release,state,version,removed)
        VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(agent,id) DO UPDATE
        SET state=EXCLUDED.state,version=EXCLUDED.version,removed=EXCLUDED.removed`,
      [input.agent, id, saved.work, saved.release, JSON.stringify(saved), saved.version, saved.removed]);
      return saved;
    }, authorize);
  }
}
