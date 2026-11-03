import canonicalize from 'canonicalize';
import { createHmac, timingSafeEqual } from 'node:crypto';
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

type Dependencies = Readonly<{ pool: Pool; routeKey: Uint8Array; clock?: KernelClock }>;
type MetaRow = Readonly<{
  digest: string | null;
  sourceAlias: string;
  sourceRecordId: string;
  asOf: string;
  payloadVersion: number;
  nativeOrder: string | null;
  lastOrder?: string;
  legacy: boolean;
}>;
type PayloadRow = Readonly<{ digest: string; payload: unknown; payloadVersion: number }>;
type Cursor = Readonly<{
  version: 1;
  route: number;
  subjectId: string;
  source: SourceProvider;
  kind: 'native' | 'legacy';
  order: string | null;
  digest: string;
}>;
type ReadInput = Readonly<{
  subjectId: string;
  source: string;
  digest?: string;
  cursor?: string;
  history?: boolean;
  deadline: number;
}>;
type FenceSnapshot = Readonly<{ fence: Readonly<{ takenDown: boolean; securityRevision: string | null }> }>;

function invalidCursor(): never {
  throw new ProblemError('invalid_request');
}

function signCursor(cursor: Cursor, key: Uint8Array): string {
  const payload = Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
  const signature = createHmac('sha256', key).update(payload, 'utf8').digest('base64url');
  return `${payload}.${signature}`;
}

function readCursor(value: string, key: Uint8Array, route: number, subjectId: string, source: SourceProvider): Cursor {
  if (value.length > 512) return invalidCursor();
  const [payload, signature, extra] = value.split('.');
  if (!payload || !signature || extra !== undefined) return invalidCursor();
  const expected = createHmac('sha256', key).update(payload, 'utf8').digest();
  let supplied: Buffer;
  let bytes: Buffer;
  try {
    supplied = Buffer.from(signature, 'base64url');
    bytes = Buffer.from(payload, 'base64url');
  } catch {
    return invalidCursor();
  }
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected) ||
    bytes.toString('base64url') !== payload
  )
    return invalidCursor();
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    return invalidCursor();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return invalidCursor();
  const candidate = parsed as Record<string, unknown>;
  const keys = Object.keys(candidate).sort().join(',');
  if (
    keys !== 'digest,kind,order,route,source,subjectId,version' ||
    candidate.version !== 1 ||
    candidate.route !== route ||
    candidate.subjectId !== subjectId ||
    candidate.source !== source ||
    (candidate.kind !== 'native' && candidate.kind !== 'legacy') ||
    typeof candidate.digest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(candidate.digest) ||
    (candidate.kind === 'native' && (typeof candidate.order !== 'string' || !/^[1-9][0-9]*$/.test(candidate.order))) ||
    (candidate.kind === 'legacy' && candidate.order !== null)
  )
    return invalidCursor();
  if (JSON.stringify(candidate) !== bytes.toString('utf8')) return invalidCursor();
  if (candidate.kind === 'native' && BigInt(candidate.order as string) > 9_223_372_036_854_775_807n)
    return invalidCursor();
  return candidate as Cursor;
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
  dependencies: Dependencies,
  tuple: SourceFenceTuple,
  deadline: number,
): Promise<FenceSnapshot> {
  return within(deadline, () =>
    withConnection(dependencies.pool, async (connection) => {
      const client = deadlineClient(connection, deadline);
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const partition = await readPartition(client, partitionOf(tuple.route));
        if (!partition || partition.writeState === 'moved') throw new ProblemError('partition_unavailable');
        const [fence] = await readFences(client, [tuple]);
        if (!fence) throw new ProblemError('partition_unavailable');
        await client.query('COMMIT');
        return { fence };
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

export function createSourceObservationReadCommands(dependencies: Dependencies) {
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

  async function metadataFor(input: ReadInput, source: SourceProvider, route: number, cursor: Cursor | null) {
    const currentRows = await query<MetaRow>(headQuery, { route, subject_id: input.subjectId, source }, input.deadline);
    const current = currentRows[0] ?? null;
    if (input.digest !== undefined) {
      const selectedRows = await query<MetaRow>(
        exactQuery,
        { route, subject_id: input.subjectId, source, digest: input.digest },
        input.deadline,
      );
      let selected = selectedRows[0] ?? null;
      const virtualLegacy = selected === null && current?.legacy && current.digest === null ? current : null;
      if (selected === null && virtualLegacy === null) throw new ProblemError('not_found');
      return { current, selected, legacySelection: virtualLegacy, historyItems: [] as MetaRow[], lookahead: null };
    }
    if (input.cursor === undefined && !input.history)
      return { current, selected: null, legacySelection: null, historyItems: [] as MetaRow[], lookahead: null };

    let native: MetaRow[] = [];
    let legacy: MetaRow[] = [];
    if (cursor?.kind !== 'legacy') {
      native = await query<MetaRow>(
        nativeHistoryQuery,
        { route, subject_id: input.subjectId, source, cursor_order: cursor?.order ?? null },
        input.deadline,
      );
      if (native.length < 2)
        legacy = await query<MetaRow>(
          legacyHistoryQuery,
          { route, subject_id: input.subjectId, source, cursor_digest: null },
          input.deadline,
        );
    } else {
      legacy = await query<MetaRow>(
        legacyHistoryQuery,
        { route, subject_id: input.subjectId, source, cursor_digest: cursor.digest },
        input.deadline,
      );
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
    };
  }

  async function inspect(input: ReadInput): Promise<SourceObservationReadResponse> {
    const route = routeOf(input.subjectId);
    const provider = sourceProvider(input.source);
    if (route === null || !provider) throw new ProblemError('not_found');
    if (
      (input.digest !== undefined && !/^[0-9a-f]{64}$/.test(input.digest)) ||
      (input.digest !== undefined && input.cursor !== undefined)
    )
      throw new ProblemError('invalid_request');
    const source = input.source as SourceProvider;
    const cursor =
      input.cursor === undefined
        ? null
        : readCursor(input.cursor, dependencies.routeKey, route, input.subjectId, source);
    const initial = await metadataFor(input, source, route, cursor);
    const currentMeta = initial.current;
    const required = [currentMeta, initial.selected, initial.legacySelection, ...initial.historyItems].filter(
      (row): row is MetaRow => row !== null,
    );
    const allForFence = [...required, ...(initial.lookahead === null ? [] : [initial.lookahead])];
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
      if (before.get(tupleKey(tuple))?.fence.takenDown) throw new ProblemError('not_found');
    }

    const payloadDigests = [...new Set(required.flatMap((row) => (row.digest === null ? [] : [row.digest])))];
    const storedPayloads = payloadDigests.length
      ? await query<PayloadRow>(
          payloadQuery,
          { route, subject_id: input.subjectId, source, digests: payloadDigests },
          input.deadline,
        )
      : [];
    const payloadByDigest = new Map(storedPayloads.map((row) => [row.digest, row]));
    const needsLegacyPayload = required.some((row) => row.digest === null && row.legacy);
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

    const itemOf = (row: MetaRow): SourceObservationReadItem => {
      if (row.digest === null) {
        if (!row.legacy || !legacyRow) throw new ProblemError('partition_unavailable');
        return legacyPayloadOf(legacyRow, row, input.subjectId, source);
      }
      const payload = payloadByDigest.get(row.digest);
      if (!payload) throw new ProblemError('partition_unavailable');
      return payloadOf(payload, row, input.subjectId, source);
    };
    const currentItem = currentMeta ? itemOf(currentMeta) : null;
    const selectedItem = initial.selected
      ? itemOf(initial.selected)
      : initial.legacySelection
        ? itemOf(initial.legacySelection)
        : null;
    if (input.digest !== undefined && selectedItem?.digest !== input.digest) throw new ProblemError('not_found');
    const historyItem = initial.historyItems[0] ? itemOf(initial.historyItems[0]) : null;

    const finalMetadata = await metadataFor(input, source, route, cursor);
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
    if (!sameRows(initialRows, finalRows)) throw new ProblemError('conflict');

    const after = new Map<string, FenceSnapshot>();
    for (const tuple of tupleList)
      after.set(tupleKey(tuple), await readFenceSnapshot(dependencies, tuple, input.deadline));
    for (const tuple of tupleList) {
      const prior = before.get(tupleKey(tuple))?.fence;
      const current = after.get(tupleKey(tuple))?.fence;
      if (
        !prior ||
        !current ||
        prior.takenDown ||
        current.takenDown ||
        prior.securityRevision !== current.securityRevision
      )
        throw new ProblemError('not_found');
    }

    const currentDigest = currentItem?.digest ?? null;
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
              nextCursor:
                historyItem &&
                initial.lookahead &&
                !before.get(tupleKey(metadataTuple(dependencies.routeKey, source, initial.lookahead)))?.fence.takenDown
                  ? signCursor(
                      {
                        version: 1,
                        route,
                        subjectId: input.subjectId,
                        source,
                        kind: historyItem.nativeOrder === null ? 'legacy' : 'native',
                        order: historyItem.nativeOrder,
                        digest: historyItem.digest,
                      },
                      dependencies.routeKey,
                    )
                  : null,
            },
          }),
    };
    if (Buffer.byteLength(JSON.stringify(response), 'utf8') > SOURCE_OBSERVATION_READ_MAX_BYTES)
      throw new ProblemError('partition_unavailable');
    return response;
  }

  return { inspect };
}
