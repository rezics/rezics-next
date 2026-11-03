import canonicalize from 'canonicalize';
import { t } from 'elysia';
import { Compile } from 'typebox/compile';
import type { Static } from 'typebox';
import type { Pool } from 'pg';
import { deadlineClient, within } from '../access/authenticate.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import { tupleRoute } from '../content/imported-contract.ts';
import { readFences, type SourceFenceTuple } from '../content/source-fences.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { readPartition } from '../partition/partition.ts';
import type { KernelClock } from '../clock.ts';
import { decodeCursor, encodeCursor, type CursorBinding, type CursorKey } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { AccountActor } from '../request/access.ts';
import { SourceFiguresSchema, SOURCE_OBSERVATION_MAX_BYTES, validSourceFigures } from './source-figures.ts';
import {
  SOURCE_OBSERVATION_PAYLOAD_VERSION,
  SOURCE_PROVIDER_IDS,
  sourceObservation,
  sourceProvider,
  type SourceObservation,
  type SourceProvider,
} from './source-provider.ts';
import headQuery from './source-observation-read-head.sql';
import exactQuery from './source-observation-read-exact.sql';
import nativeHistoryQuery from './source-observation-read-history-native.sql';
import legacyHistoryQuery from './source-observation-read-history-legacy.sql';
import payloadQuery from './source-observation-read-payload.sql';
import legacyPayloadQuery from './source-observation-read-legacy-payload.sql';

export const SOURCE_OBSERVATION_HISTORY_PAGE_SIZE = 1;
export const SOURCE_OBSERVATION_READ_MAX_BYTES = 68_000;
const HISTORY_CURSOR_OPERATION = 'rating.source-observation.history';
const HISTORY_CURSOR_FORMAT = 'source-observation-history.v1';

const closed = { additionalProperties: false } as const;
const digestSchema = t.String({ pattern: '^[0-9a-f]{64}$' });
const sourceAliasSchema = t.String({ pattern: '^[a-z][a-z0-9_-]{0,31}$' });
const sourceRecordIdSchema = t.String({ minLength: 1, maxLength: 1024 });
const sourceScaleSchema = t.Object(
  {
    min: t.Integer({ minimum: 0, maximum: 4096 }),
    max: t.Integer({ minimum: 1, maximum: 4096 }),
  },
  closed,
);
const positivePayloadSchema = t.Object(
  {
    sourceAlias: sourceAliasSchema,
    sourceRecordId: sourceRecordIdSchema,
    scale: sourceScaleSchema,
    mean: t.Number(),
    figures: t.Optional(SourceFiguresSchema),
    count: t.Integer({ minimum: 1, maximum: 2_147_483_647 }),
    asOf: t.String({ format: 'date' }),
    licence: t.String({ minLength: 1, maxLength: 1024 }),
    attribution: t.String({ minLength: 1, maxLength: 2000 }),
  },
  closed,
);
const clearPayloadSchema = t.Object(
  {
    sourceAlias: sourceAliasSchema,
    sourceRecordId: sourceRecordIdSchema,
    count: t.Literal(0),
    asOf: t.String({ format: 'date' }),
  },
  closed,
);
const observationPayloadSchema = t.Union([positivePayloadSchema, clearPayloadSchema]);
const observationValidator = Compile(observationPayloadSchema);
const observationSchema = t.Object(
  {
    digest: digestSchema,
    payloadVersion: t.Literal(SOURCE_OBSERVATION_PAYLOAD_VERSION),
    sourceAlias: sourceAliasSchema,
    sourceRecordId: sourceRecordIdSchema,
    asOf: t.String({ format: 'date' }),
    nativeOrder: t.Union([t.String({ pattern: '^[1-9][0-9]*$' }), t.Null()]),
    legacy: t.Boolean(),
    provenance: t.Object({ kind: t.Literal('unversioned'), digest: digestSchema }, closed),
    payload: observationPayloadSchema,
  },
  closed,
);
export const SourceObservationReadResponseSchema = t.Object(
  {
    source: t.Union(SOURCE_PROVIDER_IDS.map((provider) => t.Literal(provider))),
    head: t.Object(
      {
        digest: t.Union([digestSchema, t.Null()]),
        state: t.Union([t.Literal('empty'), t.Literal('published'), t.Literal('cleared')]),
        observation: t.Union([observationSchema, t.Null()]),
      },
      closed,
    ),
    resolution: t.Object(
      {
        put: t.Object({ expectedObservation: t.Union([digestSchema, t.Null()]) }, closed),
        clear: t.Object({ expectedObservation: t.Union([digestSchema, t.Null()]) }, closed),
      },
      closed,
    ),
    selectedObservation: t.Optional(observationSchema),
    history: t.Optional(
      t.Object(
        {
          items: t.Array(observationSchema, { maxItems: SOURCE_OBSERVATION_HISTORY_PAGE_SIZE }),
          nextCursor: t.Union([t.String({ maxLength: 512 }), t.Null()]),
        },
        closed,
      ),
    ),
  },
  closed,
);

export type SourceObservationPayload = Static<typeof observationPayloadSchema>;
export type SourceObservationReadItem = Static<typeof observationSchema>;
export type SourceObservationReadResponse = Static<typeof SourceObservationReadResponseSchema>;

export type SourceObservationReadDependencies = Readonly<{
  pool: Pool;
  routeKey: Uint8Array;
  tokens: KeyRing;
  clock?: KernelClock;
}>;
type MetaRow = Readonly<{
  digest: string | null;
  sourceAlias: string;
  sourceRecordId: string;
  asOf: string;
  payloadVersion: number;
  nativeOrder: string | null;
  lastOrder?: string;
  legacy: boolean;
  subjectEpoch: string | null;
}>;
type HistoryQueryRow = Readonly<{
  hasRow: boolean;
  cursorRetained: boolean;
  subjectEpoch: string | null;
  digest: string | null;
  sourceAlias: string | null;
  sourceRecordId: string | null;
  asOf: string | null;
  payloadVersion: number | null;
  nativeOrder: string | null;
  legacy: boolean | null;
}>;
type PayloadRow = Readonly<{ digest: string; payload: unknown; payloadVersion: number }>;
type Cursor = Readonly<{
  kind: 'native' | 'legacy';
  order: string | null;
  digest: string;
  nativeCeiling: string | null;
  legacyCeiling: string | null;
}>;
export type SourceObservationReadInput = Readonly<{
  subjectId: string;
  source: string;
  caller: AccountActor;
  digest?: string;
  cursor?: string;
  history?: boolean;
  deadline: number;
}>;
type DecodedCursor = Readonly<{ epoch: number; boundary: Cursor }>;
type FenceSnapshot = Readonly<{
  home: number;
  epoch: number;
  fence: Readonly<{ takenDown: boolean; securityRevision: string | null }>;
}>;

function invalidCursor(): never {
  throw new ProblemError('invalid_cursor');
}

function historyCursorBinding(input: SourceObservationReadInput, route: number, source: SourceProvider): CursorBinding {
  const home = partitionOf(route);
  return {
    operation: HISTORY_CURSOR_OPERATION,
    parameters: {
      account: input.caller.accountId,
      client: input.caller.clientId,
      delegator: input.caller.requestedBy,
      scopes: JSON.stringify([...new Set(input.caller.scopes)].sort()),
      authnEpoch: input.caller.authnEpoch,
      home,
      route,
      subjectId: input.subjectId,
      source,
      query: 'history=true',
      order: 'native.local-order-desc+legacy.digest-desc.v1',
      pageSize: SOURCE_OBSERVATION_HISTORY_PAGE_SIZE,
    },
  };
}

function validOrder(value: string): boolean {
  return /^[1-9][0-9]*$/.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n;
}

function cursorAfter(cursor: Cursor): CursorKey[] {
  return [
    HISTORY_CURSOR_FORMAT,
    cursor.kind,
    cursor.order ?? '',
    cursor.digest,
    cursor.nativeCeiling ?? '',
    cursor.legacyCeiling ?? '',
  ];
}

function readCursor(
  value: string,
  dependencies: SourceObservationReadDependencies,
  binding: CursorBinding,
): DecodedCursor {
  const decoded = decodeCursor(dependencies.tokens, binding, value, (dependencies.clock?.() ?? new Date()).getTime());
  if (!decoded.ok || decoded.after.length !== 6 || decoded.after.some((part) => typeof part !== 'string'))
    return invalidCursor();
  const [format, kind, order, digest, nativeCeiling, legacyCeiling] = decoded.after as string[];
  const normalizedOrder = order === '' ? null : order;
  const normalizedNativeCeiling = nativeCeiling === '' ? null : nativeCeiling;
  const normalizedLegacyCeiling = legacyCeiling === '' ? null : legacyCeiling;
  if (
    format !== HISTORY_CURSOR_FORMAT ||
    (kind !== 'native' && kind !== 'legacy') ||
    !/^[0-9a-f]{64}$/.test(digest!) ||
    (normalizedOrder !== null && !validOrder(normalizedOrder)) ||
    (normalizedNativeCeiling !== null && !validOrder(normalizedNativeCeiling)) ||
    (normalizedLegacyCeiling !== null && !/^[0-9a-f]{64}$/.test(normalizedLegacyCeiling)) ||
    (kind === 'native' &&
      (normalizedOrder === null ||
        normalizedNativeCeiling === null ||
        BigInt(normalizedOrder) > BigInt(normalizedNativeCeiling))) ||
    (kind === 'legacy' &&
      (normalizedOrder !== null || normalizedLegacyCeiling === null || digest! > normalizedLegacyCeiling))
  )
    return invalidCursor();
  return {
    epoch: decoded.epoch,
    boundary: {
      kind,
      order: normalizedOrder,
      digest: digest!,
      nativeCeiling: normalizedNativeCeiling,
      legacyCeiling: normalizedLegacyCeiling,
    },
  };
}

function encodeHistoryCursor(
  dependencies: SourceObservationReadDependencies,
  binding: CursorBinding,
  epoch: number,
  cursor: Cursor,
): string {
  return encodeCursor(
    dependencies.tokens,
    binding,
    { epoch, after: cursorAfter(cursor) },
    (dependencies.clock?.() ?? new Date()).getTime(),
  );
}

function historyItems(rows: readonly HistoryQueryRow[]): { items: MetaRow[]; cursorRetained: boolean } {
  const first = rows[0];
  if (!first) throw new ProblemError('partition_unavailable');
  const items = rows.flatMap((row) => {
    if (!row.hasRow) return [];
    if (
      row.digest === null ||
      row.sourceAlias === null ||
      row.sourceRecordId === null ||
      row.asOf === null ||
      row.payloadVersion === null ||
      row.legacy === null
    )
      throw new ProblemError('partition_unavailable');
    return [
      {
        digest: row.digest,
        sourceAlias: row.sourceAlias,
        sourceRecordId: row.sourceRecordId,
        asOf: row.asOf,
        payloadVersion: row.payloadVersion,
        nativeOrder: row.nativeOrder,
        legacy: row.legacy,
        subjectEpoch: row.subjectEpoch,
      },
    ];
  });
  return { items, cursorRetained: first.cursorRetained };
}

function subjectEpochOf(rows: readonly { subjectEpoch: string | null }[]): number | null {
  const value = rows[0]?.subjectEpoch;
  if (value === undefined || value === null) return null;
  const epoch = Number(value);
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new ProblemError('partition_unavailable');
  return epoch;
}

function mergeSubjectEpoch(current: number | null, next: number | null): number | null {
  if (current !== null && next !== null && current !== next) throw new ProblemError('conflict');
  return current ?? next;
}

function tupleFor(routeKey: Uint8Array, source: SourceProvider, sourceRecordId: string, sourceAlias: string) {
  const route = tupleRoute(routeKey, sourceAlias, sourceRecordId);
  return { route, source: sourceAlias, external_id: sourceRecordId, field_group: 'facts' } satisfies SourceFenceTuple;
}

function tupleKey(tuple: SourceFenceTuple): string {
  return `${tuple.route}:${tuple.source}:${tuple.external_id}:${tuple.field_group}`;
}

function metadataTuple(routeKey: Uint8Array, source: SourceProvider, row: MetaRow): SourceFenceTuple {
  if (
    !/^[a-z][a-z0-9_-]{0,31}$/.test(row.sourceAlias) ||
    row.sourceRecordId.length < 1 ||
    Buffer.byteLength(row.sourceRecordId, 'utf8') > 1024 ||
    !sourceProvider(source)?.record(row.sourceRecordId)
  )
    throw new ProblemError('partition_unavailable');
  return tupleFor(routeKey, source, row.sourceRecordId, row.sourceAlias);
}

async function readFenceSnapshot(
  dependencies: SourceObservationReadDependencies,
  tuple: SourceFenceTuple,
  deadline: number,
): Promise<FenceSnapshot> {
  return within(deadline, () =>
    withConnection(dependencies.pool, async (connection) => {
      const client = deadlineClient(connection, deadline);
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const home = partitionOf(tuple.route);
        const partition = await readPartition(client, home);
        if (!partition || partition.writeState === 'moved') throw new ProblemError('partition_unavailable');
        const [fence] = await readFences(client, [tuple]);
        if (!fence) throw new ProblemError('partition_unavailable');
        await client.query('COMMIT');
        return { home: partition.partitionNo, epoch: partition.epoch, fence };
      } catch (error) {
        try {
          await connection.query('ROLLBACK');
        } catch (rollbackError) {
          discardConnection(connection, rollbackError as Error);
        }
        throw error;
      }
    }),
  );
}

function payloadOf(
  row: PayloadRow,
  metadata: MetaRow,
  subjectId: string,
  source: SourceProvider,
): SourceObservationReadItem {
  if (row.payloadVersion !== SOURCE_OBSERVATION_PAYLOAD_VERSION)
    throw new ProblemError('partition_unavailable', { detail: 'Unsupported source observation payload version' });
  const payload = row.payload;
  if (!observationValidator.Check(payload)) throw new ProblemError('partition_unavailable');
  const observed = payload as SourceObservationPayload;
  if (
    row.digest !== metadata.digest ||
    observed.sourceAlias !== metadata.sourceAlias ||
    observed.sourceRecordId !== metadata.sourceRecordId ||
    observed.asOf !== metadata.asOf ||
    Buffer.byteLength(JSON.stringify(observed), 'utf8') > SOURCE_OBSERVATION_MAX_BYTES
  )
    throw new ProblemError('partition_unavailable');
  let computed: ReturnType<typeof sourceObservation>;
  try {
    computed = sourceObservation(subjectId, source, observed as SourceObservation);
  } catch {
    throw new ProblemError('partition_unavailable');
  }
  if (computed.digest !== row.digest || canonicalize(computed.payload) !== canonicalize(observed))
    throw new ProblemError('partition_unavailable');
  return {
    digest: row.digest,
    payloadVersion: SOURCE_OBSERVATION_PAYLOAD_VERSION,
    sourceAlias: metadata.sourceAlias,
    sourceRecordId: metadata.sourceRecordId,
    asOf: metadata.asOf,
    nativeOrder: metadata.nativeOrder,
    legacy: metadata.legacy,
    provenance: { kind: 'unversioned', digest: row.digest },
    payload: observed,
  };
}

function legacyPayloadOf(
  row: Record<string, unknown>,
  metadata: MetaRow,
  subjectId: string,
  source: SourceProvider,
): SourceObservationReadItem {
  if (
    row.source !== source ||
    row.sourceAlias !== metadata.sourceAlias ||
    row.sourceRecordId !== metadata.sourceRecordId ||
    row.asOf !== metadata.asOf
  )
    throw new ProblemError('conflict');
  const count = Number(row.count);
  const figures = row.figures == null ? undefined : row.figures;
  if (figures !== undefined && !validSourceFigures(source, figures, count))
    throw new ProblemError('partition_unavailable');
  const value = {
    sourceAlias: metadata.sourceAlias,
    sourceRecordId: metadata.sourceRecordId,
    ...(figures === undefined ? {} : { figures }),
    scale: { min: Number(row.scaleMin), max: Number(row.scaleMax) },
    mean: Number(row.mean),
    count,
    asOf: metadata.asOf,
    licence: String(row.licence),
    attribution: String(row.attribution),
  };
  const observed = sourceObservation(subjectId, source, value);
  if (!observationValidator.Check(observed.payload)) throw new ProblemError('partition_unavailable');
  if (metadata.digest !== null && metadata.digest !== observed.digest) throw new ProblemError('partition_unavailable');
  return {
    digest: observed.digest,
    payloadVersion: SOURCE_OBSERVATION_PAYLOAD_VERSION,
    sourceAlias: metadata.sourceAlias,
    sourceRecordId: metadata.sourceRecordId,
    asOf: metadata.asOf,
    nativeOrder: null,
    legacy: true,
    provenance: { kind: 'unversioned', digest: observed.digest },
    payload: observed.payload as SourceObservationPayload,
  };
}

function stateOf(observation: SourceObservationReadItem | null): 'empty' | 'published' | 'cleared' {
  if (observation === null) return 'empty';
  return observation.payload.count === 0 ? 'cleared' : 'published';
}

function sameRows(left: readonly MetaRow[], right: readonly MetaRow[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function createSourceObservationReadCommands(dependencies: SourceObservationReadDependencies) {
  async function query<T>(
    sql: { run: (client: ReturnType<typeof deadlineClient>, parameters: never) => Promise<unknown[]> },
    parameters: unknown,
    deadline: number,
  ): Promise<T[]> {
    return within(deadline, () =>
      withConnection(dependencies.pool, (connection) =>
        sql.run(deadlineClient(connection, deadline), parameters as never),
      ),
    ) as Promise<T[]>;
  }

  async function metadataFor(
    input: SourceObservationReadInput,
    source: SourceProvider,
    route: number,
    cursor: Cursor | null,
  ) {
    const currentRows = await query<MetaRow>(headQuery, { route, subject_id: input.subjectId, source }, input.deadline);
    const current = currentRows[0] ?? null;
    let subjectEpoch = subjectEpochOf(currentRows);
    if (input.digest !== undefined) {
      const selectedRows = await query<MetaRow>(
        exactQuery,
        { route, subject_id: input.subjectId, source, digest: input.digest },
        input.deadline,
      );
      subjectEpoch = mergeSubjectEpoch(subjectEpoch, subjectEpochOf(selectedRows));
      let selected = selectedRows[0] ?? null;
      const virtualLegacy = selected === null && current?.legacy && current.digest === null ? current : null;
      if (selected === null && virtualLegacy === null) throw new ProblemError('not_found');
      return {
        current,
        selected,
        legacySelection: virtualLegacy,
        historyItems: [] as MetaRow[],
        lookahead: null,
        subjectEpoch,
      };
    }
    if (input.cursor === undefined && !input.history)
      return {
        current,
        selected: null,
        legacySelection: null,
        historyItems: [] as MetaRow[],
        lookahead: null,
        subjectEpoch,
      };

    let native: MetaRow[] = [];
    let legacy: MetaRow[] = [];
    if (cursor?.kind !== 'legacy') {
      const nativeRows = await query<HistoryQueryRow>(
        nativeHistoryQuery,
        {
          route,
          subject_id: input.subjectId,
          source,
          cursor_order: cursor?.kind === 'native' ? cursor.order : null,
          cursor_digest: cursor?.kind === 'native' ? cursor.digest : null,
          ceiling_order: cursor?.nativeCeiling ?? null,
        },
        input.deadline,
      );
      subjectEpoch = mergeSubjectEpoch(subjectEpoch, subjectEpochOf(nativeRows));
      const nativePage = historyItems(nativeRows);
      if (!nativePage.cursorRetained) throw new ProblemError('conflict');
      native = nativePage.items;
      if (native.length < 2) {
        const legacyRows = await query<HistoryQueryRow>(
          legacyHistoryQuery,
          {
            route,
            subject_id: input.subjectId,
            source,
            cursor_digest: null,
            ceiling_digest: cursor?.legacyCeiling ?? null,
            boundary_digest: null,
          },
          input.deadline,
        );
        subjectEpoch = mergeSubjectEpoch(subjectEpoch, subjectEpochOf(legacyRows));
        const legacyPage = historyItems(legacyRows);
        if (!legacyPage.cursorRetained) throw new ProblemError('conflict');
        legacy = legacyPage.items;
      }
    } else {
      const legacyRows = await query<HistoryQueryRow>(
        legacyHistoryQuery,
        {
          route,
          subject_id: input.subjectId,
          source,
          cursor_digest: cursor.digest,
          ceiling_digest: cursor.legacyCeiling,
          boundary_digest: cursor.digest,
        },
        input.deadline,
      );
      subjectEpoch = mergeSubjectEpoch(subjectEpoch, subjectEpochOf(legacyRows));
      const legacyPage = historyItems(legacyRows);
      if (!legacyPage.cursorRetained) throw new ProblemError('conflict');
      legacy = legacyPage.items;
    }
    const page = native.length > 0 ? native : legacy;
    const selected = page[0] ?? null;
    const lookahead = native.length > 1 ? native[1]! : native.length === 1 ? (legacy[0] ?? null) : (legacy[1] ?? null);
    return {
      current,
      selected,
      legacySelection: null,
      historyItems: selected ? [selected] : [],
      lookahead,
      subjectEpoch,
    };
  }

  async function inspect(input: SourceObservationReadInput): Promise<SourceObservationReadResponse> {
    const route = routeOf(input.subjectId);
    const provider = sourceProvider(input.source);
    if (route === null || !provider) throw new ProblemError('not_found');
    if (
      (input.digest !== undefined && !/^[0-9a-f]{64}$/.test(input.digest)) ||
      (input.digest !== undefined && input.cursor !== undefined)
    )
      throw new ProblemError('invalid_request');
    const source = input.source as SourceProvider;
    const historyBinding =
      input.cursor !== undefined || input.history ? historyCursorBinding(input, route, source) : null;
    const cursor = input.cursor === undefined ? null : readCursor(input.cursor, dependencies, historyBinding!);
    const initial = await metadataFor(input, source, route, cursor?.boundary ?? null);
    if (cursor && (initial.subjectEpoch === null || cursor.epoch !== initial.subjectEpoch)) return invalidCursor();
    const currentMeta = initial.current;
    // Current and exact observations are required resources. History positions are
    // consumed independently of disclosure, including an unreturned lookahead.
    const required = [
      currentMeta,
      ...(input.digest === undefined ? [] : [initial.selected, initial.legacySelection]),
    ].filter((row): row is MetaRow => row !== null);
    const allForFence = [
      ...required,
      ...initial.historyItems,
      ...(initial.lookahead === null ? [] : [initial.lookahead]),
    ];
    const tuples = new Map<string, SourceFenceTuple>();
    for (const row of allForFence) {
      const tuple = metadataTuple(dependencies.routeKey, source, row);
      tuples.set(tupleKey(tuple), tuple);
    }
    const tupleList = [...tuples.values()];
    const before = new Map<string, FenceSnapshot>();
    for (const tuple of tupleList)
      before.set(tupleKey(tuple), await readFenceSnapshot(dependencies, tuple, input.deadline));
    for (const row of required) {
      const tuple = metadataTuple(dependencies.routeKey, source, row);
      const snapshot = before.get(tupleKey(tuple));
      if (!snapshot) throw new ProblemError('partition_unavailable');
      if (snapshot.fence.takenDown) throw new ProblemError('not_found');
    }

    // A concealed raw candidate still advances history, but never enters payload
    // acquisition, validation or presentation. A lookahead never enters hydration.
    const historyMeta = initial.historyItems[0] ?? null;
    const disclosedHistory =
      historyMeta !== null &&
      !before.get(tupleKey(metadataTuple(dependencies.routeKey, source, historyMeta)))?.fence.takenDown
        ? historyMeta
        : null;
    const hydrated = [...required, ...(disclosedHistory === null ? [] : [disclosedHistory])];
    const payloadDigests = [...new Set(hydrated.flatMap((row) => (row.digest === null ? [] : [row.digest])))];
    const storedPayloads = payloadDigests.length
      ? await query<PayloadRow>(
          payloadQuery,
          { route, subject_id: input.subjectId, source, digests: payloadDigests },
          input.deadline,
        )
      : [];
    const payloadByDigest = new Map(storedPayloads.map((row) => [row.digest, row]));
    const needsLegacyPayload = hydrated.some((row) => row.digest === null && row.legacy);
    let legacyRow: Record<string, unknown> | null = null;
    if (needsLegacyPayload) {
      const rows = await query<Record<string, unknown>>(
        legacyPayloadQuery,
        { route, subject_id: input.subjectId, source },
        input.deadline,
      );
      legacyRow = rows[0] ?? null;
      if (!legacyRow) throw new ProblemError('conflict');
    }

    const itemCache = new Map<string, SourceObservationReadItem>();
    const itemOf = (row: MetaRow): SourceObservationReadItem => {
      const key = row.digest ?? `legacy:${row.sourceAlias}:${row.sourceRecordId}:${row.asOf}`;
      const cached = itemCache.get(key);
      if (cached) return cached;
      if (row.digest === null) {
        if (!row.legacy || !legacyRow) throw new ProblemError('partition_unavailable');
        const item = legacyPayloadOf(legacyRow, row, input.subjectId, source);
        itemCache.set(key, item);
        return item;
      }
      const payload = payloadByDigest.get(row.digest);
      if (!payload) throw new ProblemError('partition_unavailable');
      const item = payloadOf(payload, row, input.subjectId, source);
      itemCache.set(key, item);
      return item;
    };
    const currentItem = currentMeta ? itemOf(currentMeta) : null;
    const selectedItem =
      input.digest === undefined
        ? null
        : initial.selected
          ? itemOf(initial.selected)
          : initial.legacySelection
            ? itemOf(initial.legacySelection)
            : null;
    if (input.digest !== undefined && selectedItem?.digest !== input.digest) throw new ProblemError('not_found');
    const historyItem = disclosedHistory ? itemOf(disclosedHistory) : null;

    const currentDigest = currentItem?.digest ?? null;
    const baseEpoch = initial.subjectEpoch ?? undefined;
    const nextCursor =
      historyMeta && initial.lookahead && historyMeta.digest !== null && historyBinding && baseEpoch !== undefined
        ? encodeHistoryCursor(dependencies, historyBinding, baseEpoch, {
            kind: historyMeta.nativeOrder === null ? 'legacy' : 'native',
            order: historyMeta.nativeOrder,
            digest: historyMeta.digest,
            nativeCeiling:
              cursor?.boundary.nativeCeiling ??
              initial.historyItems.find((item) => item.nativeOrder !== null)?.nativeOrder ??
              null,
            legacyCeiling:
              cursor?.boundary.legacyCeiling ??
              (historyMeta.nativeOrder === null
                ? historyMeta.digest
                : initial.lookahead.nativeOrder === null
                  ? initial.lookahead.digest
                  : null),
          })
        : null;
    const response: SourceObservationReadResponse = {
      source,
      head: {
        digest: currentDigest,
        state: stateOf(currentItem),
        observation: currentItem,
      },
      resolution: {
        put: { expectedObservation: currentDigest },
        clear: { expectedObservation: currentDigest },
      },
      ...(input.digest === undefined ? {} : { selectedObservation: selectedItem! }),
      ...(input.cursor === undefined && !input.history
        ? {}
        : {
            history: {
              items: historyItem ? [historyItem] : [],
              nextCursor,
            },
          }),
    };
    if (Buffer.byteLength(JSON.stringify(response), 'utf8') > SOURCE_OBSERVATION_READ_MAX_BYTES)
      throw new ProblemError('partition_unavailable');

    const finalMetadata = await metadataFor(input, source, route, cursor?.boundary ?? null);
    const initialRows = [
      ...(currentMeta ? [currentMeta] : []),
      ...(initial.selected ? [initial.selected] : []),
      ...(initial.legacySelection ? [initial.legacySelection] : []),
      ...initial.historyItems,
      ...(initial.lookahead ? [initial.lookahead] : []),
    ];
    const finalRows = [
      ...(finalMetadata.current ? [finalMetadata.current] : []),
      ...(finalMetadata.selected ? [finalMetadata.selected] : []),
      ...(finalMetadata.legacySelection ? [finalMetadata.legacySelection] : []),
      ...finalMetadata.historyItems,
      ...(finalMetadata.lookahead ? [finalMetadata.lookahead] : []),
    ];
    if (initial.subjectEpoch !== finalMetadata.subjectEpoch || !sameRows(initialRows, finalRows))
      throw new ProblemError('conflict');

    const after = new Map<string, FenceSnapshot>();
    for (const tuple of tupleList)
      after.set(tupleKey(tuple), await readFenceSnapshot(dependencies, tuple, input.deadline));
    for (const row of required) {
      const tuple = metadataTuple(dependencies.routeKey, source, row);
      if (after.get(tupleKey(tuple))?.fence.takenDown) throw new ProblemError('not_found');
    }
    for (const tuple of tupleList) {
      const prior = before.get(tupleKey(tuple))?.fence;
      const current = after.get(tupleKey(tuple))?.fence;
      const priorPartition = before.get(tupleKey(tuple));
      const currentPartition = after.get(tupleKey(tuple));
      if (
        !prior ||
        !current ||
        !priorPartition ||
        !currentPartition ||
        priorPartition.home !== currentPartition.home ||
        priorPartition.epoch !== currentPartition.epoch ||
        prior.takenDown !== current.takenDown ||
        prior.securityRevision !== current.securityRevision
      )
        throw new ProblemError('conflict');
    }
    return response;
  }

  return { inspect };
}
