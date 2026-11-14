import type { RatingCapabilities } from './contract/capabilities.ts';
import { ratingCapabilities } from './adapters/ambient.ts';
import { memoizedValue } from '../memoized.ts';
import canonicalize from 'canonicalize';
import { t } from 'elysia';
import { Compile } from 'typebox/compile';
import type { Static } from 'typebox';
import type { Pool } from 'pg';
import { withSourceRatingReadConnection, type SourceRatingReadClient } from './source-rating-read-connection.ts';
import { ProblemError } from '../http/problem-error.ts';
import { tupleRoute } from '../content/imported-contract.ts';
import { readFences, type SourceFenceTuple } from '../content/source-fences.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { readPartition } from '../partition/partition.ts';
import type { KernelClock } from '../clock.ts';
import { decodeCursor, encodeCursor, type CursorBinding, type CursorKey } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { AccountActor } from '../request/access.ts';
import { SourceFiguresSchema, SOURCE_OBSERVATION_MAX_BYTES } from './source-figures.ts';
import {
  SOURCE_OBSERVATION_PAYLOAD_VERSION,
  sourceObservation,
  sourceProvider,
  type SourceObservation,
  type SourceProvider,
} from './source-provider.ts';
import headQuery from './source-observation-read-head.sql';
import exactQuery from './source-observation-read-exact.sql';
import historyQuery from './source-observation-read-history.sql';
import payloadQuery from './source-observation-read-payload.sql';

export const SOURCE_OBSERVATION_HISTORY_PAGE_SIZE = 1;
export const SOURCE_OBSERVATION_READ_MAX_BYTES = 68_000;
const HISTORY_CURSOR_OPERATION = 'rating.source-observation.history';
const HISTORY_CURSOR_FORMAT = 'source-observation-history.seek.v1';

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
function positivePayloadSchema() {
  return memoizedValue(positivePayloadSchema, () =>
    t.Object(
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
    ),
  );
}
const clearPayloadSchema = t.Object(
  {
    sourceAlias: sourceAliasSchema,
    sourceRecordId: sourceRecordIdSchema,
    count: t.Literal(0),
    asOf: t.String({ format: 'date' }),
  },
  closed,
);
function observationPayloadSchema() {
  return memoizedValue(observationPayloadSchema, () => t.Union([positivePayloadSchema(), clearPayloadSchema]));
}
function observationValidator() {
  return memoizedValue(observationValidator, () => Compile(observationPayloadSchema()));
}
function observationSchema() {
  return memoizedValue(observationSchema, () =>
    t.Object(
      {
        digest: digestSchema,
        payloadVersion: t.Literal(SOURCE_OBSERVATION_PAYLOAD_VERSION),
        sourceAlias: sourceAliasSchema,
        sourceRecordId: sourceRecordIdSchema,
        asOf: t.String({ format: 'date' }),
        nativeOrder: t.Union([t.String({ pattern: '^[1-9][0-9]*$' }), t.Null()]),
        legacy: t.Boolean(),
        provenance: t.Object({ kind: t.Literal('unversioned'), digest: digestSchema }, closed),
        payload: observationPayloadSchema(),
      },
      closed,
    ),
  );
}
export function SourceObservationReadResponseSchema() {
  return memoizedValue(SourceObservationReadResponseSchema, () =>
    t.Object(
      {
        source: t.Union([t.Literal('vndb'), t.Literal('bangumi')]),
        head: t.Object(
          {
            digest: t.Union([digestSchema, t.Null()]),
            state: t.Union([t.Literal('empty'), t.Literal('published'), t.Literal('cleared')]),
            observation: t.Union([observationSchema(), t.Null()]),
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
        selectedObservation: t.Optional(observationSchema()),
        history: t.Optional(
          t.Object(
            {
              items: t.Array(observationSchema(), { maxItems: SOURCE_OBSERVATION_HISTORY_PAGE_SIZE }),
              nextCursor: t.Union([t.String({ maxLength: 512 }), t.Null()]),
            },
            closed,
          ),
        ),
      },
      closed,
    ),
  );
}

export type SourceObservationPayload = Static<ReturnType<typeof observationPayloadSchema>>;
export type SourceObservationReadItem = Static<ReturnType<typeof observationSchema>>;
export type SourceObservationReadResponse = Static<ReturnType<typeof SourceObservationReadResponseSchema>>;

export type SourceObservationReadDependencies = Readonly<{
  pool: Pool;
  routeKey: Uint8Array;
  tokens: KeyRing;
  capabilities?: RatingCapabilities;
  clock?: KernelClock;
}>;
type MetaRow = Readonly<{
  digest: string;
  seekOrder: string;
  projectionExists?: boolean;
  sourceAlias: string;
  sourceRecordId: string;
  asOf: string;
  payloadVersion: number;
  nativeOrder: string | null;
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
  seekOrder: string | null;
  legacy: boolean | null;
}>;
type PayloadRow = Readonly<{ digest: string; payload: unknown; payloadVersion: number }>;
type Cursor = Readonly<{
  order: string;
  digest: string;
  ceiling: string;
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
      order: 'storage.seek-order-desc.v1',
      pageSize: SOURCE_OBSERVATION_HISTORY_PAGE_SIZE,
    },
  };
}

function validOrder(value: string): boolean {
  return /^[1-9][0-9]*$/.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n;
}

function cursorAfter(cursor: Cursor): CursorKey[] {
  return [HISTORY_CURSOR_FORMAT, cursor.order, cursor.digest, cursor.ceiling];
}

function readCursor(
  value: string,
  dependencies: SourceObservationReadDependencies,
  binding: CursorBinding,
): DecodedCursor {
  const decoded = decodeCursor(dependencies.tokens, binding, value, ratingCapabilities(dependencies).clock().getTime());
  if (!decoded.ok || decoded.after.length !== 4 || decoded.after.some((part) => typeof part !== 'string'))
    return invalidCursor();
  const [format, order, digest, ceiling] = decoded.after as [string, string, string, string];
  if (
    format !== HISTORY_CURSOR_FORMAT || !validOrder(order) || !validOrder(ceiling) ||
    !/^[0-9a-f]{64}$/.test(digest) || BigInt(order) > BigInt(ceiling)
  ) return invalidCursor();
  return { epoch: decoded.epoch, boundary: { order, digest, ceiling } };
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
    ratingCapabilities(dependencies).clock().getTime(),
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
      row.seekOrder === null ||
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
        seekOrder: row.seekOrder,
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
  return withSourceRatingReadConnection(
    dependencies.pool,
    deadline,
    async (client) => {
      const home = partitionOf(tuple.route);
      const partition = await readPartition(client, home);
      if (!partition || partition.writeState === 'moved') throw new ProblemError('partition_unavailable');
      const [fence] = await readFences(client, [tuple]);
      if (!fence) throw new ProblemError('partition_unavailable');
      return { home: partition.partitionNo, epoch: partition.epoch, fence };
    },
    { repeatableRead: true },
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
  if (!observationValidator().Check(payload)) throw new ProblemError('partition_unavailable');
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

function stateOf(observation: SourceObservationReadItem | null): 'empty' | 'published' | 'cleared' {
  if (observation === null) return 'empty';
  return observation.payload.count === 0 ? 'cleared' : 'published';
}

function sameRows(left: readonly MetaRow[], right: readonly MetaRow[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function createSourceObservationReadCommands(dependencies: SourceObservationReadDependencies) {
  async function query<T>(
    sql: { run: (client: SourceRatingReadClient, parameters: never) => Promise<unknown[]> },
    parameters: unknown,
    deadline: number,
  ): Promise<T[]> {
    return withSourceRatingReadConnection(dependencies.pool, deadline, (client) =>
      sql.run(client, parameters as never),
    ) as Promise<T[]>;
  }

  async function metadataFor(
    input: SourceObservationReadInput,
    source: SourceProvider,
    route: number,
    cursor: Cursor | null,
  ) {
    const currentRows = await query<MetaRow & { needsMaterialization: boolean; emptySubjectEpoch: string }>(
      headQuery, { route, subject_id: input.subjectId, source }, input.deadline,
    );
    if (currentRows[0]?.needsMaterialization) throw new ProblemError('partition_unavailable');
    const current = currentRows[0]?.digest ? currentRows[0] : null;
    let subjectEpoch = subjectEpochOf(currentRows.map((row) => ({ subjectEpoch: row.subjectEpoch ?? row.emptySubjectEpoch })));
    if (input.digest !== undefined) {
      const selectedRows = await query<MetaRow>(
        exactQuery,
        { route, subject_id: input.subjectId, source, digest: input.digest },
        input.deadline,
      );
      subjectEpoch = mergeSubjectEpoch(subjectEpoch, subjectEpochOf(selectedRows));
      const selected = selectedRows[0] ?? null;
      if (selected === null) throw new ProblemError('not_found');
      return {
        current,
        selected,
        historyItems: [] as MetaRow[],
        lookahead: null,
        subjectEpoch,
      };
    }
    if (input.cursor === undefined && !input.history)
      return {
        current,
        selected: null,
        historyItems: [] as MetaRow[],
        lookahead: null,
        subjectEpoch,
      };

    const rows = await query<HistoryQueryRow>(
      historyQuery,
      {
        route, subject_id: input.subjectId, source,
        cursor_order: cursor?.order ?? null,
        cursor_digest: cursor?.digest ?? null,
        ceiling_order: cursor?.ceiling ?? null,
      },
      input.deadline,
    );
    subjectEpoch = mergeSubjectEpoch(subjectEpoch, subjectEpochOf(rows));
    const page = historyItems(rows);
    if (!page.cursorRetained) throw new ProblemError('conflict');
    const selected = page.items[0] ?? null;
    return {
      current, selected,
      historyItems: selected ? [selected] : [],
      lookahead: page.items[1] ?? null,
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
      ...(input.digest === undefined ? [] : [initial.selected]),
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
    const payloadDigests = [...new Set(hydrated.map((row) => row.digest))];
    const storedPayloads = payloadDigests.length
      ? await query<PayloadRow>(
          payloadQuery,
          { route, subject_id: input.subjectId, source, digests: payloadDigests },
          input.deadline,
        )
      : [];
    const payloadByDigest = new Map(storedPayloads.map((row) => [row.digest, row]));
    const itemCache = new Map<string, SourceObservationReadItem>();
    const itemOf = (row: MetaRow): SourceObservationReadItem => {
      const key = row.digest;
      const cached = itemCache.get(key);
      if (cached) return cached;
      const payload = payloadByDigest.get(row.digest);
      if (!payload) throw new ProblemError('partition_unavailable');
      const item = payloadOf(payload, row, input.subjectId, source);
      itemCache.set(key, item);
      return item;
    };
    const currentItem = currentMeta ? itemOf(currentMeta) : null;
    if (currentItem && (currentItem.payload.count > 0) !== currentMeta!.projectionExists)
      throw new ProblemError('partition_unavailable');
    const selectedItem = input.digest !== undefined && initial.selected ? itemOf(initial.selected) : null;
    if (input.digest !== undefined && selectedItem?.digest !== input.digest) throw new ProblemError('not_found');
    const historyItem = disclosedHistory ? itemOf(disclosedHistory) : null;

    const currentDigest = currentItem?.digest ?? null;
    const baseEpoch = initial.subjectEpoch ?? undefined;
    const nextCursor =
      historyMeta && initial.lookahead && historyBinding && baseEpoch !== undefined
        ? encodeHistoryCursor(dependencies, historyBinding, baseEpoch, {
            order: historyMeta.seekOrder,
            digest: historyMeta.digest,
            ceiling: cursor?.boundary.ceiling ?? historyMeta.seekOrder,
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
      ...initial.historyItems,
      ...(initial.lookahead ? [initial.lookahead] : []),
    ];
    const finalRows = [
      ...(finalMetadata.current ? [finalMetadata.current] : []),
      ...(finalMetadata.selected ? [finalMetadata.selected] : []),
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
