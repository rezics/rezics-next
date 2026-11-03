/** Private Source selection and bounded native IO; not a matcher or permission resolver. */
import type { IndexedStatement } from '../search/source.ts';
import { readNativeCalendarDate } from '@rezics/filter';
import type { Release } from '@rezics/definitions';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { ACCESS_WORK_AXES, AccessWorkAccounting, EMPTY_ACCESS_WORK, type AccessWork } from '../access/work.ts';
import { AccessUnavailableError, CommandUnavailableError } from '../access/unavailable.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { authoritativeTimeValue, commandTime } from '../command/command.ts';
import {
  currentOperationalResources,
  hasLiveOperationalTransaction,
  type OperationalTransaction,
} from '../command/operational.ts';
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
import kindTypeAnchor from './scope-leaf-selection-kind-type.sql';
import kindTypeLock from './scope-leaf-selection-kind-type-lock.sql';
import type { NativeCollectionWork } from '../library/collection-source-work.ts';
import type { WorkDimensions } from '../library/collection-source.ts';
import { isDeepStrictEqual } from 'node:util';

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

/** The narrow native projection shared by Source Type evidence. This is raw
 * dependency data, not permission, admission, EOF or a transferable certificate.
 * Its caller must already hold this exact admitted native home; it never checks
 * out a connection or retains a transaction across foreign preparation.
 */
export type NativeKindTypeAnchor = Readonly<{
  subject_id: string;
  present: boolean;
  writer_enrolled: boolean;
  writer_version: string;
  visibility: string | null;
  security_revision: string | null;
  current_release: string | null;
  type: string | null;
  type_oversized: boolean;
  revision: number | null;
  revision_transaction: string | null;
  revision_epoch: number | null;
  revision_position: string | null;
  redirect: string | null;
  redirect_sequence: number | null;
  redirect_transaction: string | null;
  redirect_epoch: number | null;
  redirect_position: string | null;
  account_id: string | null;
}>;

export const KIND_TYPE_MAX_BYTES = 4096;
/** Eight exact/indexed head points: subject, fence, revision, revision write
 * basis, redirect, redirect write basis and agent link (seven), plus the wanted
 * key. Two additional exact provenance row locks serialize native write-basis
 * erasure/updates. No history payload, candidate, label, account or tuple hydration.
 */
export function kindTypeAnchorFootprint(inputBytes: number): WorkDimensions {
  return {
    candidateKeys: 1,
    nativeRows: 10,
    identityMetadataRows: 0,
    nativePoints: 10,
    witnessKeys: 0,
    statements: 1,
    // A bounded native text field can expand sixfold in the JSON row receipt
    // (for example U+0001 becomes \\u0001). Pay for that projection even when
    // the later contribution-envelope check rejects the Type.
    bytes: inputBytes + 6 * KIND_TYPE_MAX_BYTES + 2048,
    emptySeeks: 1,
  };
}

/** INSERT/conflict enrollment plus the exact fence point. The row lock is held
 * by the caller's native transaction; absent keys use the same full declaration.
 */
export function kindTypeAnchorLockFootprint(inputBytes: number): WorkDimensions {
  return {
    candidateKeys: 1,
    nativeRows: 3,
    identityMetadataRows: 0,
    nativePoints: 3,
    witnessKeys: 0,
    statements: 1,
    bytes: inputBytes + 128,
    emptySeeks: 1,
  };
}

/** Necessary native-home liveness, not Library Kind admission or Accounts
 * permission. A structural client or a live transaction on another home cannot
 * dispatch this projection. The public producer still awaits those owner bodies.
 */
function requireKindTypeHome(
  client: OperationalTransaction,
  input: Readonly<{ route: number; subjectId: string }>,
  deadline: number,
): void {
  if (
    !hasLiveOperationalTransaction(client) ||
    routeOf(input.subjectId) !== input.route ||
    !Number.isFinite(deadline) ||
    Date.now() >= deadline
  )
    throw new AccessUnavailableError('contention');
  const resources = currentOperationalResources(client);
  const time = commandTime(client);
  if (
    !time ||
    resources.mode !== 'work-step' ||
    resources.partition !== partitionOf(input.route) ||
    deadline > resources.deadline
  )
    throw new AccessUnavailableError('contention');
  authoritativeTimeValue(time);
}

export async function readNativeKindTypeAnchor(
  client: OperationalTransaction,
  input: Readonly<{ route: number; subjectId: string; includeType: boolean }>,
  work: NativeCollectionWork,
  deadline: number,
): Promise<NativeKindTypeAnchor> {
  // Enrollment and observation must use the same key and disclosure projection
  // across both awaits, even if the caller mutates its lookup object meanwhile.
  const lookup = Object.freeze({ ...input });
  requireKindTypeHome(client, lookup, deadline);
  const lockInput = { route: lookup.route, subject_id: lookup.subjectId };
  const lockValues = kindTypeLock.params.map((name) => lockInput[name as keyof typeof lockInput]);
  const lockBytes = Buffer.byteLength(kindTypeLock.sql) + sourceBytes(lockValues);
  const lockReservation = work.reserve(kindTypeAnchorLockFootprint(lockBytes));
  lockReservation.dispatch();
  try {
    const query = {
      text: kindTypeLock.sql,
      values: lockValues,
      query_timeout: Math.max(1, deadline - Date.now()),
    };
    const locked = await lockReservation.query(() => client.query<{ version: string }>(query));
    requireKindTypeHome(client, lookup, deadline);
    if (locked.rows.length !== 1) throw new AccessUnavailableError('contention');
    lockReservation.settle({ bytes: lockBytes + sourceBytes(locked.rows), emptySeeks: 0 });
  } catch (error) {
    lockReservation.settle();
    if (error instanceof Error) Object.defineProperty(error, 'work', { get: () => work.receipt(), configurable: true });
    throw error;
  }
  const parameters = {
    route: lookup.route,
    subject_id: lookup.subjectId,
    include_type: lookup.includeType,
    max_type_bytes: KIND_TYPE_MAX_BYTES,
  };
  const values = kindTypeAnchor.params.map((name) => parameters[name as keyof typeof parameters]);
  const inputBytes = Buffer.byteLength(kindTypeAnchor.sql) + sourceBytes(values);
  requireKindTypeHome(client, lookup, deadline);
  const reservation = work.reserve(kindTypeAnchorFootprint(inputBytes));
  reservation.dispatch();
  try {
    const query = {
      text: kindTypeAnchor.sql,
      values,
      query_timeout: Math.max(1, deadline - Date.now()),
    };
    const result = await reservation.query(() => client.query<NativeKindTypeAnchor>(query));
    requireKindTypeHome(client, lookup, deadline);
    const row = result.rows[0];
    if (result.rows.length !== 1 || !row || !row.writer_enrolled || row.subject_id !== lookup.subjectId)
      throw new AccessUnavailableError('contention');
    // Rows always charge the full native plan, including absent and denied keys.
    reservation.settle({ bytes: inputBytes + sourceBytes(result.rows), emptySeeks: row.present ? 0 : 1 });
    return row;
  } catch (error) {
    // A failure after dispatch burns the whole declared native footprint.
    reservation.settle();
    if (error instanceof Error) Object.defineProperty(error, 'work', { get: () => work.receipt(), configurable: true });
    throw error;
  }
}

/** Local native comparison only. Both the original and terminal, including a
 * negative key, must pass this under their actual home fence. A foreign expected
 * key requires its own admitted invocation; it cannot be checked from Source by
 * opening another pool. This comparison alone grants no audience authority.
 */
export async function verifyNativeKindTypeAnchor(
  client: OperationalTransaction,
  input: Readonly<{ route: number; expected: NativeKindTypeAnchor; includeType: boolean }>,
  work: NativeCollectionWork,
  deadline: number,
): Promise<boolean> {
  const expected = structuredClone(input.expected);
  const current = await readNativeKindTypeAnchor(
    client,
    { route: input.route, subjectId: expected.subject_id, includeType: input.includeType },
    work,
    deadline,
  );
  return current.writer_enrolled && isDeepStrictEqual(current, expected);
}

/** One ledger, including Access and every failed/discarded native operation. */
export class LeafNativeWork {
  private reserved: AccessWork = { ...EMPTY_ACCESS_WORK };
  readonly accounting: AccessWorkAccounting;
  constructor(
    readonly budget: AccessWork,
    readonly deadline: number,
  ) {
    this.accounting = new AccessWorkAccounting(
      {
        reserve: (_operation, bound) => {
          const axes = ACCESS_WORK_AXES;
          if (axes.some((axis) => this.reserved[axis] + bound[axis] > budget[axis]))
            throw new LeafReservationUnavailable();
          this.reserved = Object.fromEntries(
            axes.map((axis) => [axis, this.reserved[axis] + bound[axis]]),
          ) as AccessWork;
          return {
            settle: (actual) => {
              this.reserved = Object.fromEntries(
                axes.map((axis) => [axis, this.reserved[axis] - bound[axis] + actual[axis]]),
              ) as AccessWork;
            },
          };
        },
      },
      deadline,
    );
  }
  remaining(axis: keyof AccessWork): number {
    return this.budget[axis] - this.reserved[axis];
  }
  usage(): AccessWork {
    return this.accounting.usage();
  }

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
      keys: plan.keys,
      points: plan.points,
      rows: plan.rows,
      witnesses: plan.witnesses ?? 0,
      bytes: inputBytes + (plan.outputBytes ?? 1024),
      emptySeeks: 1,
    };
    const query = { text: statement.sql, values: parameters, query_timeout: Math.max(1, this.deadline - Date.now()) };
    return this.accounting.run(
      'semantic.scope-leaf.native',
      bound,
      async () => (await client.query<R>(query)).rows,
      (rows) => ({ ...bound, bytes: inputBytes + sourceBytes(rows), emptySeeks: rows.length ? 0 : 1 }),
    );
  }

  async snapshot<T>(pool: Pool, route: number, read: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.accounting.run('semantic.scope-leaf.checkout', { ...EMPTY_ACCESS_WORK, points: 1 }, () =>
      withConnection(pool, async (client) => {
        await this.transaction(client, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        try {
          const state = (
            await this.query(client, home, { partition: partitionOf(route) }, { keys: 0, points: 1, rows: 1 })
          )[0];
          if (!state) throw new AccessUnavailableError('overloaded');
          if (state.write_state === 'moved') throw new CommandUnavailableError('moved', partitionOf(route));
          const value = await read(client);
          await this.transaction(client, 'COMMIT');
          return value;
        } catch (error) {
          // Cleanup is reserved with BEGIN; even budget failure must release the source.
          try {
            await client.query('ROLLBACK');
          } catch (rollback) {
            discardConnection(client, rollback as Error);
          }
          throw error;
        }
      }),
    );
  }
  private transaction(client: PoolClient, command: string): Promise<unknown> {
    // BEGIN reserves a possible ROLLBACK as well; COMMIT is charged separately.
    return this.accounting.run(
      'semantic.scope-leaf.transaction',
      {
        ...EMPTY_ACCESS_WORK,
        points: command.startsWith('BEGIN') ? 2 : 1,
        bytes: Buffer.byteLength(command) + (command.startsWith('BEGIN') ? 8 : 0),
      },
      () => client.query(command),
    );
  }
  anchor(client: PoolClient, route: number, subject: string) {
    const maxBytes = Math.max(0, this.remaining('bytes') - 4096);
    return this.query(
      client,
      anchor,
      { route, subject_id: subject, max_bytes: maxBytes },
      { keys: 1, points: 3, rows: 7, outputBytes: maxBytes + 512 },
    ).then((rows) => rows[0] ?? null);
  }
  slot(client: PoolClient, route: number, subject: string, id: string) {
    return this.query(client, slot, { route, subject_id: subject, slot_id: id }, { keys: 0, points: 2, rows: 5 }).then(
      (rows) => rows[0]!,
    );
  }
  compact(client: PoolClient, route: number, subject: string, id: string, after: string | null) {
    return this.query(
      client,
      compact,
      { route, subject_id: subject, slot_id: id, after: after ?? '0' },
      { keys: 1, points: 1, rows: 1 },
    ).then((rows) => rows[0] ?? null);
  }
  selected(client: PoolClient, route: number, subject: string, id: string, ordinal: number) {
    return this.query(
      client,
      selected,
      { route, subject_id: subject, slot_id: id, ordinal },
      { keys: 1, points: 1, rows: 2 },
    ).then((rows) => selectedCandidate(rows[0]?.selected));
  }
  membership(client: PoolClient, route: number, subject: string, id: string, witness: string) {
    return this.query(
      client,
      membership,
      { route, subject_id: subject, slot_id: id, candidate_id: witness },
      { keys: 1, points: 1, rows: 34 },
    ).then((rows) => selectedCandidate(rows[0]?.selected));
  }
  pair(
    client: PoolClient,
    route: number,
    subject: string,
    property: string,
    value: string,
    phase: 'compact' | 'witness',
    after: string | null,
  ) {
    const common = { route, subject_id: subject, property, value };
    if (phase === 'compact')
      return this.query(
        client,
        pairCompact,
        { ...common, after: after ?? '0', has_after: after !== null },
        { keys: 1, points: 1, rows: 1, witnesses: 1 },
      ).then((rows) => rows[0] ?? null);
    return this.query(
      client,
      pairWitness,
      {
        ...common,
        after: after ?? '00000000-0000-0000-0000-000000000000',
        has_after: after !== null,
      },
      { keys: 1, points: 1, rows: 1, witnesses: 1 },
    ).then((rows) => rows[0] ?? null);
  }
  locator(client: PoolClient, route: number, subject: string, witness: string) {
    return this.query(
      client,
      locator,
      { route, subject_id: subject, candidate_id: witness },
      { keys: 1, points: 2, rows: 5, witnesses: 1 },
    ).then((rows) => rows[0]?.slot_id ?? null);
  }
  async candidate(client: PoolClient, route: number, subject: string, witness: string, maxBytes: number) {
    const row = (
      await this.query(
        client,
        candidate,
        { route, subject_id: subject, candidate_id: witness, max_bytes: maxBytes },
        { keys: 1, points: 2, rows: 7, witnesses: 1, outputBytes: maxBytes + 1024 },
      )
    )[0];
    if (!row) return null;
    const maximum = Math.max(0, this.remaining('bytes') - 8192);
    const source = (
      await this.query(
        client,
        provenance,
        { routes: [route], subjects: [subject], candidates: [witness], max_bytes: maximum },
        { keys: 0, points: 4, rows: 12, outputBytes: maximum + 512 },
      )
    )[0];
    if (!source) throw new AccessUnavailableError('contention');
    return { ...row, revision: source.revision, source_bytes: source.source_bytes, source: source.source };
  }
  concealed(client: PoolClient, route: number, subject: string, witness: string) {
    return this.query(
      client,
      privacy,
      { route, subject_id: subject, candidate_id: witness },
      { keys: 0, points: 3, rows: 7 },
    ).then((rows) => rows[0]?.concealed !== false);
  }
  async release(pool: Pool, digest: string, names: readonly string[]): Promise<Release['properties']> {
    const properties = [...new Set(names)];
    const rows = properties.length + 3;
    return this.snapshot(pool, 0, async (client) => {
      const length = (await this.query(client, releaseLength, { digest, properties }, { keys: 0, points: 1, rows }))[0];
      if (!length) return this.accounting.unavailable('Semantic composed release native work producer');
      const maximum = length.bytes;
      if (maximum === null || maximum + 2048 > this.remaining('bytes')) throw new LeafReservationUnavailable();
      const row = (
        await this.query(
          client,
          releaseBody,
          { digest, properties, max_bytes: maximum },
          { keys: 0, points: 1, rows, outputBytes: maximum + 32 },
        )
      )[0];
      if (!row?.properties) throw new AccessUnavailableError('contention');
      // The native immutable release row is the same authority read by readRelease.
      // No partial body is passed off as a digest-verifiable complete Release.
      return row.properties as Release['properties'];
    });
  }
}

export type SourceStatementRow = {
  subject_id: string;
  property: string;
  rank: 'normal' | 'preferred';
  body: unknown;
  release: string;
  ordinal: number;
};

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

export function indexedStatement(row: SourceStatementRow, release: Release): IndexedStatement | null {
  return normalizeSourceStatement(row.property, row.body, release.properties);
}

export function normalizeSourceStatement(
  property: string,
  body: unknown,
  properties: Release['properties'],
): IndexedStatement | null {
  if (!sourceObject(body)) return null;
  const definition = properties[property];
  const value = valueText(body, definition);
  if (value === null) return null;

  const statement: IndexedStatement = { property: property, value };
  if (definition?.datatype === 'wikibase-item') statement.facet = { kind: 'item' };
  else if (definition?.datatype === 'time') {
    const content = sourceObject(body.value) && sourceObject(body.value.content) ? body.value.content : undefined;
    const date = readNativeCalendarDate(content);
    if (date) statement.facet = { kind: 'time', ...date };
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
      if (
        !sourceObject(raw) ||
        typeof raw.property !== 'string' ||
        !sourceObject(raw.value) ||
        raw.value.type !== 'value'
      )
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
