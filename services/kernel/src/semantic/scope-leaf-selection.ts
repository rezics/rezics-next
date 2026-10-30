/** Private Source selection and bounded native IO; not a matcher or permission resolver. */
import type { IndexedStatement } from '../search/source.ts';
import type { Release } from '@rezics/definitions';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { ACCESS_WORK_AXES, AccessWorkAccounting, EMPTY_ACCESS_WORK, type AccessWork } from '../access/work.ts';
import { AccessUnavailableError, CommandUnavailableError } from '../access/unavailable.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { partitionOf } from '../route/route.ts';
import home from './scope-leaf-selection-home.sql';
import anchor from './scope-leaf-selection-anchor.sql';
import slot from './scope-leaf-selection-slot.sql';
import compact from './scope-leaf-selection-compact.sql';
import selected from './scope-leaf-selection-selected.sql';
import membership from './scope-leaf-selection-membership.sql';
import pairCompact from './scope-leaf-selection-pair-compact.sql';
import pairWitness from './scope-leaf-selection-pair-witness.sql';
import candidate from './scope-leaf-selection-candidate.sql';
import locator from './scope-leaf-selection-locator.sql';
import provenance from './scope-leaf-selection-provenance.sql';
import privacy from './scope-leaf-selection-privacy.sql';
import releaseLength from './scope-leaf-selection-release-length.sql';
import releaseBody from './scope-leaf-selection-release.sql';

export const sourceObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
export function selectedRank(value: unknown): 'normal' | 'preferred' | null {
  return value === 'normal' || value === 'preferred' ? value : null;
}
/** The Global adoption rank, never the proposal body's rank. Shared with SubjectSource. */
export function selectedCandidate(value: unknown): { candidate: string; rank: 'normal' | 'preferred' } | null {
  if (!sourceObject(value) || typeof value.candidate !== 'string') return null;
  const rank = selectedRank(value.rank);
  return rank ? { candidate: value.candidate, rank } : null;
}
export const sourceBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) ?? 'null');
export class LeafReservationUnavailable extends Error {}

/** One ledger, including Access and every failed/discarded native operation. */
export class LeafNativeWork {
  private reserved: AccessWork = { ...EMPTY_ACCESS_WORK };
  readonly accounting: AccessWorkAccounting;
  constructor(readonly budget: AccessWork, readonly deadline: number) {
    this.accounting = new AccessWorkAccounting({
      reserve: (_operation, bound) => {
        const axes = ACCESS_WORK_AXES;
        if (axes.some((axis) => this.reserved[axis] + bound[axis] > budget[axis]))
          throw new LeafReservationUnavailable();
        this.reserved = Object.fromEntries(axes.map((axis) => [axis, this.reserved[axis] + bound[axis]])) as AccessWork;
        return { settle: (actual) => {
          this.reserved = Object.fromEntries(axes.map((axis) => [axis, this.reserved[axis] - bound[axis] + actual[axis]])) as AccessWork;
        } };
      },
    }, deadline);
  }
  remaining(axis: keyof AccessWork): number { return this.budget[axis] - this.reserved[axis]; }
  usage(): AccessWork { return this.accounting.usage(); }

  /** All counts describe explicit native plans: exact probes, <=33 compact
   * operations or <=32 adoption entries. They are not returned-row estimates.
   * Native row reservations cannot be refunded; bytes include rejected data.
   * Bypass reylo's periodic catalogue checks using its compiled typed statement.
   */
  async query<I extends Record<string, unknown>, R extends QueryResultRow>(
    client: PoolClient,
    statement: { sql: string; params: readonly string[]; '~reylo': { input: I; element: R } },
    input: I,
    plan: { keys: number; points: number; rows: number; witnesses?: number; outputBytes?: number },
  ): Promise<R[]> {
    const parameters = statement.params.map((name) => {
      const value = input[name];
      return value !== null && typeof value === 'object' && !Array.isArray(value) ? JSON.stringify(value) : value;
    });
    const inputBytes = sourceBytes(parameters);
    const bound = {
      keys: plan.keys, points: plan.points, rows: plan.rows,
      witnesses: plan.witnesses ?? 0, bytes: inputBytes + (plan.outputBytes ?? 1024), emptySeeks: 1,
    };
    const query = { text: statement.sql, values: parameters,
      query_timeout: Math.max(1, this.deadline - Date.now()) };
    return this.accounting.run('semantic.scope-leaf.native', bound,
      async () => (await client.query<R>(query)).rows,
      (rows) => ({ ...bound, bytes: inputBytes + sourceBytes(rows), emptySeeks: rows.length ? 0 : 1 }));
  }

  async snapshot<T>(pool: Pool, route: number, read: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.accounting.run('semantic.scope-leaf.checkout', { ...EMPTY_ACCESS_WORK, points: 1 }, () =>
      withConnection(pool, async (client) => {
        await this.transaction(client, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        try {
          const state = (await this.query(client, home, { partition: partitionOf(route) }, { keys: 0, points: 1, rows: 1 }))[0];
          if (!state) throw new AccessUnavailableError('overloaded');
          if (state.write_state === 'moved') throw new CommandUnavailableError('moved', partitionOf(route));
          const value = await read(client);
          await this.transaction(client, 'COMMIT');
          return value;
        } catch (error) {
          // Cleanup is reserved with BEGIN; even budget failure must release the source.
          try { await client.query('ROLLBACK'); }
          catch (rollback) { discardConnection(client, rollback as Error); }
          throw error;
        }
      }));
  }
  private transaction(client: PoolClient, command: string): Promise<unknown> {
    // BEGIN reserves a possible ROLLBACK as well; COMMIT is charged separately.
    return this.accounting.run('semantic.scope-leaf.transaction', {
      ...EMPTY_ACCESS_WORK, points: command.startsWith('BEGIN') ? 2 : 1,
      bytes: Buffer.byteLength(command) + (command.startsWith('BEGIN') ? 8 : 0),
    }, () => client.query(command));
  }
  anchor(client: PoolClient, route: number, subject: string) {
    const maxBytes = Math.max(0, this.remaining('bytes') - 4096);
    return this.query(client, anchor, { route, subject_id: subject, max_bytes: maxBytes },
      { keys: 1, points: 3, rows: 7, outputBytes: maxBytes + 512 }).then((rows) => rows[0] ?? null);
  }
  slot(client: PoolClient, route: number, subject: string, id: string) {
    return this.query(client, slot, { route, subject_id: subject, slot_id: id },
      { keys: 0, points: 2, rows: 5 }).then((rows) => rows[0]!);
  }
  compact(client: PoolClient, route: number, subject: string, id: string, after: string | null) {
    return this.query(client, compact, { route, subject_id: subject, slot_id: id, after: after ?? '0' },
      { keys: 1, points: 1, rows: 1 }).then((rows) => rows[0] ?? null);
  }
  selected(client: PoolClient, route: number, subject: string, id: string, ordinal: number) {
    return this.query(client, selected, { route, subject_id: subject, slot_id: id, ordinal },
      { keys: 1, points: 1, rows: 2 }).then((rows) => selectedCandidate(rows[0]?.selected));
  }
  membership(client: PoolClient, route: number, subject: string, id: string, witness: string) {
    return this.query(client, membership, { route, subject_id: subject, slot_id: id, candidate_id: witness },
      { keys: 1, points: 1, rows: 34 }).then((rows) => selectedCandidate(rows[0]?.selected));
  }
  pair(client: PoolClient, route: number, subject: string, property: string, value: string,
    phase: 'compact' | 'witness', after: string | null) {
    const input = { route, subject_id: subject, property, value, after: phase === 'compact' ? after ?? '0' : after };
    return (phase === 'compact'
      ? this.query(client, pairCompact, { ...input, after: input.after ?? '0' }, { keys: 1, points: 1, rows: 1, witnesses: 1 })
      : this.query(client, pairWitness, input, { keys: 1, points: 1, rows: 1, witnesses: 1 }))
      .then((rows) => rows[0] ?? null);
  }
  locator(client: PoolClient, route: number, subject: string, witness: string) {
    return this.query(client, locator, { route, subject_id: subject, candidate_id: witness },
      { keys: 1, points: 2, rows: 5, witnesses: 1 }).then((rows) => rows[0]?.slot_id ?? null);
  }
  async candidate(client: PoolClient, route: number, subject: string, witness: string, maxBytes: number) {
    const row = (await this.query(client, candidate,
      { route, subject_id: subject, candidate_id: witness, max_bytes: maxBytes },
      { keys: 1, points: 2, rows: 7, witnesses: 1, outputBytes: maxBytes + 1024 }))[0];
    if (!row) return null;
    const maximum = Math.max(0, this.remaining('bytes') - 8192);
    const source = (await this.query(client, provenance,
      { routes: [route], subjects: [subject], candidates: [witness], max_bytes: maximum },
      { keys: 0, points: 4, rows: 12, outputBytes: maximum + 512 }))[0];
    if (!source) throw new AccessUnavailableError('contention');
    return { ...row, revision: source.revision, source_bytes: source.source_bytes, source: source.source };
  }
  concealed(client: PoolClient, route: number, subject: string, witness: string) {
    return this.query(client, privacy, { route, subject_id: subject, candidate_id: witness },
      { keys: 0, points: 3, rows: 7 }).then((rows) => rows[0]?.concealed !== false);
  }
  async release(pool: Pool, digest: string, names: readonly string[]): Promise<Release['properties']> {
    const properties = [...new Set(names)];
    const rows = properties.length + 3;
    return this.snapshot(pool, 0, async (client) => {
      const length = (await this.query(client, releaseLength, { digest, properties },
        { keys: 0, points: 1, rows }))[0];
      if (!length) return this.accounting.unavailable('Semantic composed release native work producer');
      const maximum = length.bytes;
      if (maximum === null || maximum + 2048 > this.remaining('bytes')) throw new LeafReservationUnavailable();
      const row = (await this.query(client, releaseBody, { digest, properties, max_bytes: maximum },
        { keys: 0, points: 1, rows, outputBytes: maximum + 32 }))[0];
      if (!row?.properties) throw new AccessUnavailableError('contention');
      // The native immutable release row is the same authority read by readRelease.
      // No partial body is passed off as a digest-verifiable complete Release.
      return row.properties as Release['properties'];
    });
  }
}

export type SourceStatementRow = { subject_id: string; property: string; rank: 'normal' | 'preferred'; body: unknown; release: string; ordinal: number };

function valueText(body: unknown, definition: Release['properties'][string] | undefined): string | null {
  if (!sourceObject(body) || !sourceObject(body.value)) return null;
  const value = body.value;
  if (value.type !== 'value' || !sourceObject(value.content)) {
    if (value.type !== 'value' || typeof value.content !== 'string') return null;
    return value.content;
  }
  const content = value.content;
  switch (definition?.datatype) {
    case 'time':
      return typeof content.time === 'string' ? content.time : null;
    case 'quantity':
      return typeof content.amount === 'string' ? content.amount : null;
    case 'monolingualtext':
      return typeof content.text === 'string' ? content.text : null;
    default:
      return null;
  }
}

function timeYear(time: string): number | null {
  const match = /^([+-])(\d+)-/.exec(time);
  if (!match) return null;
  const year = Number(`${match[1]}${match[2]}`);
  return Number.isSafeInteger(year) ? year : null;
}

export function indexedStatement(row: SourceStatementRow, release: Release): IndexedStatement | null {
  return normalizeSourceStatement(row.property, row.body, release.properties);
}

export function normalizeSourceStatement(property: string, body: unknown, properties: Release['properties']): IndexedStatement | null {
  if (!sourceObject(body)) return null;
  const definition = properties[property];
  const value = valueText(body, definition);
  if (value === null) return null;

  const statement: IndexedStatement = { property: property, value };
  if (definition?.datatype === 'wikibase-item') statement.facet = { kind: 'item' };
  else if (definition?.datatype === 'time') {
    const content = sourceObject(body.value) && sourceObject(body.value.content) ? body.value.content : undefined;
    const year = content && typeof content.time === 'string' ? timeYear(content.time) : null;
    if (year !== null) statement.facet = { kind: 'time', year };
  } else if (definition?.datatype === 'quantity') {
    const content = sourceObject(body.value) && sourceObject(body.value.content) ? body.value.content : undefined;
    const amount = content && typeof content.amount === 'string' ? Number(content.amount) : NaN;
    if (Number.isFinite(amount) && content && typeof content.unit === 'string')
      statement.facet = { kind: 'quantity', amount, unit: content.unit };
  } else if (
    definition?.datatype === 'string' &&
    sourceObject(definition.value) &&
    typeof definition.value.pattern === 'string'
  ) {
    statement.facet = { kind: 'code' };
  }

  if (Array.isArray(body.qualifiers)) {
    const qualifiers = body.qualifiers.flatMap((raw): { property: string; value: string }[] => {
      if (!sourceObject(raw) || typeof raw.property !== 'string' || !sourceObject(raw.value) || raw.value.type !== 'value')
        return [];
      const qualifierDefinition = properties[raw.property];
      const content = raw.value.content;
      return (qualifierDefinition?.datatype === 'wikibase-item' || qualifierDefinition?.datatype === 'string') &&
        typeof content === 'string'
        ? [{ property: raw.property, value: content }]
        : [];
    });
    if (qualifiers.length > 0) statement.qualifiers = qualifiers;
  }
  return statement;
}

