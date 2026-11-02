import { CATALOGUE_NATIVE_CONTROLS as nativeControl } from './definition-catalogue-work-cost.ts';
import type { Pool, PoolClient } from 'pg';
import {
  CatalogueArtifactError,
  CATALOGUE_FORMAT,
  KIND_FORMAT,
  KIND_REDUCTION,
  catalogueBytes,
  catalogueDigest,
  parseCatalogueJson,
  parseKindDeclaration,
  catalogueFail,
  parseCataloguePin,
  assertKindId,
  compatibilityKind,
  RELEASE_LIMITS,
  type KindCataloguePin,
  type PinnedKindDeclaration,
  type KindDeclarationV1,
} from '@rezics/definitions';
import { accessCheck, type Actor, type Access } from '../request/access.ts';
import { EMPTY_ACCESS_WORK, type AccessWorkAccounting } from '../access/work.ts';
import { AccessUnavailableError, CommandUnavailableError, throwAccessUnavailable } from '../access/unavailable.ts';
import { releaseOperationalTime, type AuthoritativeTime } from '../command/command.ts';
import { readNativeAccessTime } from '../access/authenticate.ts';
import { decodeCursor, encodeCursor, type CursorBinding } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { withReadTransaction } from './read.ts';
import { DefinitionAccessDeniedError, GLOBAL_CONTEXT, readRelease } from './definitions.ts';
import { globalReadEligibility } from './eligibility.ts';
import {
  catalogueKey,
  catalogueSort,
  readCatalogueBuild,
  type CatalogueBuildStatus,
} from './definition-catalogue-publication.ts';

import { authoritativeTimeValue, commandTime } from '../command/command.ts';
import {
  currentOperationalResources,
  hasLiveOperationalTransaction,
  type OperationalTransaction,
} from '../command/operational.ts';
import type { CollectionKindCapture } from '../library/collection-kind.ts';
import {
  admitCollectionKindPreparationStep,
  readCollectionKindWorkDefinition,
  type CollectionKindPreparationLocator,
} from '../library/collection-kind-work-admission.ts';
import type { NativeCollectionWork } from '../library/collection-source-work.ts';
import { ProblemError } from '../http/problem.ts';
import { lockKindCatalogueEnrollment } from './definition-catalogue-lifecycle.ts';
import {
  CATALOGUE_BODY_COST as bodyCost,
  catalogueBodyWork,
  catalogueSQLCost,
} from './definition-catalogue-work-cost.ts';
import enrollConsumer from './definition-catalogue-enroll.sql';
import consumerRead from './definition-catalogue-consumer-read.sql';

export type DefinitionCatalogueReadContext = Readonly<{ actor: Actor; deadline: number; work: AccessWorkAccounting }>;
type Page = Readonly<{ pin: KindCataloguePin; limit?: number; cursor: string | null }>;
export interface NativeDefinitionCatalogue {
  head(context: DefinitionCatalogueReadContext): Promise<Readonly<{ pin: KindCataloguePin; head: number }> | null>;
  kinds(
    input: Readonly<{ pin: KindCataloguePin; ids: readonly string[] }>,
    context: DefinitionCatalogueReadContext,
  ): Promise<readonly Readonly<{ id: string; value: PinnedKindDeclaration | null }>[]>;
  kindPage(
    input: Page & Readonly<{ query: string; language: string }>,
    context: DefinitionCatalogueReadContext,
  ): Promise<Readonly<{ kinds: readonly PinnedKindDeclaration[]; next: string | null }>>;
  kindCandidates(
    input: Page & Readonly<{ exactTypeId: string }>,
    context: DefinitionCatalogueReadContext,
  ): Promise<Readonly<{ candidates: readonly PinnedKindDeclaration[]; next: string | null }>>;
  build(
    input: { pin: KindCataloguePin },
    context: DefinitionCatalogueReadContext,
  ): Promise<CatalogueBuildStatus | null>;
}
const MAX_RESPONSE_BYTES = 1_048_576;
const cursorKeys = new WeakMap<Pool, KeyRing>();
/** Ordinary host composition supplies its existing cursor key ring; this never grants read authority. */
export function configureDefinitionCatalogue(pool: Pool, keys: KeyRing) {
  cursorKeys.set(pool, keys);
}
export const cataloguePin = (rootDigest: string): KindCataloguePin =>
  parseCataloguePin({ format: CATALOGUE_FORMAT, rootDigest, kindSpec: KIND_FORMAT, reduction: KIND_REDUCTION });
function unavailable(): never {
  throw new AccessUnavailableError('overloaded');
}
function limitOf(limit = 20) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) catalogueFail('invalid', 'Expected page size 1–100');
  return limit;
}
type KeyRow = { id_key: string; ordinal: string; size: number; precedence: number; label_sort?: Buffer };
type KindRow = { id_key: string; declaration_digest: string; body: KindDeclarationV1 };
/** Full keys are hashed only to fit bounded B-tree equality keys. Original IDs are always compared as well. */
async function query<R extends import('pg').QueryResultRow>(
  client: PoolClient,
  context: DefinitionCatalogueReadContext,
  sql: string,
  params: unknown[],
  rows: number,
  outputBytes: number,
): Promise<R[]> {
  const inputBytes = Buffer.byteLength(JSON.stringify(params));
  return context.work.run(
    'definitions.catalogue.query',
    {
      ...EMPTY_ACCESS_WORK,
      keys: rows,
      points: 1,
      rows,
      bytes: inputBytes + outputBytes,
      emptySeeks: 1,
    },
    async () => (await client.query<R>(sql, params)).rows,
    (value) => ({
      ...EMPTY_ACCESS_WORK,
      keys: rows,
      points: 1,
      rows,
      bytes: inputBytes + Buffer.byteLength(JSON.stringify(value)),
      emptySeeks: value.length ? 0 : 1,
    }),
  );
}
export function createNativeDefinitionCatalogue({
  pool,
  access,
}: Readonly<{ pool: Pool; access: Access }>): NativeDefinitionCatalogue {
  async function read<T>(
    context: DefinitionCatalogueReadContext,
    body: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    let time: AuthoritativeTime | undefined;
    try {
      // Release the original clock checkout before native Access preparation opens any dependency home.
      time = await readNativeAccessTime({ pool, deadline: context.deadline, work: context.work });
      const check = await accessCheck(
        access,
        context.actor,
        'definitions:read',
        {
          route: 0,
          id: GLOBAL_CONTEXT,
          eligibility: globalReadEligibility('definitions:read'),
        },
        { pool, deadline: context.deadline, time, work: context.work },
      );
      return await context.work.run(
        'definitions.catalogue.snapshot',
        { ...EMPTY_ACCESS_WORK, points: 5, bytes: 1024 },
        () =>
          withReadTransaction(
            pool,
            async (client) => {
              const home = (
                await query<{ write_state: string }>(
                  client,
                  context,
                  'SELECT write_state FROM core.partition WHERE partition_no=0',
                  [],
                  1,
                  128,
                )
              )[0];
              if (!home) unavailable();
              if (home.write_state === 'moved') throw new CommandUnavailableError('moved', 0);
              if (!(await check(client, time))) throw new DefinitionAccessDeniedError();
              return body(client);
            },
            context.deadline,
          ),
      );
    } catch (error) {
      throwAccessUnavailable(error, context.deadline);
      throw error;
    } finally {
      if (time) releaseOperationalTime(time);
    }
  }
  async function ready(client: PoolClient, pin: KindCataloguePin, context: DefinitionCatalogueReadContext) {
    const rows = await query<{ state: string }>(
      client,
      context,
      'SELECT state FROM semantic.definition_catalogue_build WHERE route=0 AND root_digest=$1',
      [pin.rootDigest],
      1,
      128,
    );
    if (rows[0]?.state !== 'ready') unavailable();
  }
  async function values(
    client: PoolClient,
    pin: KindCataloguePin,
    keys: readonly string[],
    context: DefinitionCatalogueReadContext,
  ): Promise<KindRow[]> {
    if (!keys.length) return [];
    return query<KindRow>(
      client,
      context,
      'SELECT id_key,declaration_digest,body FROM semantic.definition_catalogue_kind WHERE route=0 AND root_digest=$1 AND id_key=ANY($2::text[])',
      [pin.rootDigest, keys],
      keys.length,
      MAX_RESPONSE_BYTES,
    );
  }
  function pinned(pin: KindCataloguePin, row: KindRow): PinnedKindDeclaration {
    return { catalogue: pin, declarationDigest: row.declaration_digest, declaration: row.body };
  }
  function bytes(value: unknown) {
    if (catalogueBytes(value).length > MAX_RESPONSE_BYTES) unavailable();
  }
  function continuation(binding: CursorBinding, cursor: string | null): string | null {
    if (cursor === null) return null;
    const keys = cursorKeys.get(pool);
    if (!keys) unavailable();
    const decoded = decodeCursor(keys, binding, cursor);
    if (
      !decoded.ok ||
      decoded.after.length !== 1 ||
      typeof decoded.after[0] !== 'string' ||
      !/^[1-9][0-9]*$/.test(decoded.after[0])
    )
      catalogueFail('invalid', 'Invalid catalogue cursor');
    return decoded.after[0];
  }
  function next(binding: CursorBinding, ordinal: string): string {
    const keys = cursorKeys.get(pool);
    if (!keys) unavailable();
    return encodeCursor(keys, binding, { epoch: 1, after: [ordinal] });
  }
  async function page(
    input: Page & ({ query: string; language: string } | { exactTypeId: string }),
    context: DefinitionCatalogueReadContext,
  ) {
    const pin = parseCataloguePin(input.pin);
    const limit = limitOf(input.limit);
    const metadata = 'query' in input;
    const binding: CursorBinding = {
      operation: metadata ? 'definitions.catalogue.kinds' : 'definitions.catalogue.candidates',
      parameters: {
        root: pin.rootDigest,
        kindSpec: pin.kindSpec,
        reduction: pin.reduction,
        ...(metadata
          ? { query: input.query, language: input.language, sort: 'label-utf16-asc,kind-id-utf16-asc' }
          : { exactTypeId: input.exactTypeId, sort: 'precedence-desc,kind-id-utf16-asc' }),
      },
    };
    if (metadata) {
      if (
        typeof input.query !== 'string' ||
        input.query.length > 512 ||
        typeof input.language !== 'string' ||
        !input.language.length ||
        catalogueBytes(input.language).length > 65536
      )
        catalogueFail('invalid', 'Invalid literal metadata prefix or language');
    } else {
      assertKindId(input.exactTypeId);
      if (catalogueBytes(input.exactTypeId).length > 65536)
        catalogueFail('invalid', 'Exact Type selector exceeds the declaration bound');
    }
    const after = continuation(binding, input.cursor);
    return read(context, async (client) => {
      await ready(client, pin, context);
      let rows: KeyRow[];
      if (metadata) {
        const languageKey = catalogueKey(input.language);
        let afterLabel: Buffer = Buffer.alloc(0);
        let afterOrdinal = '0';
        if (after) {
          const boundary = (
            await query<{ label_sort: Buffer; language: string }>(
              client,
              context,
              'SELECT label_sort,language FROM semantic.definition_catalogue_label WHERE route=0 AND root_digest=$1 AND language_key=$2 AND ordinal=$3',
              [pin.rootDigest, languageKey, after],
              1,
              131072,
            )
          )[0];
          if (!boundary || boundary.language !== input.language)
            catalogueFail('invalid', 'Missing catalogue cursor boundary');
          afterLabel = boundary.label_sort;
          afterOrdinal = after;
        }
        const prefix = catalogueSort(input.query);
        const end = Buffer.from(prefix);
        let index = end.length - 1;
        while (index >= 0 && end[index] === 255) index--;
        let upper: Buffer | null = null;
        if (index >= 0) {
          end[index] = end[index]! + 1;
          upper = end.subarray(0, index + 1);
        }
        rows = await query<KeyRow>(
          client,
          context,
          `SELECT l.id_key,l.ordinal,l.label_sort,octet_length(k.body::text) AS size,k.precedence
           FROM (SELECT id_key,ordinal,label_sort FROM semantic.definition_catalogue_label
             WHERE route=0 AND root_digest=$1 AND language_key=$2 AND label_sort >= $3
             ${upper ? 'AND label_sort < $7' : ''} AND (label_sort,ordinal)>($4::bytea,$5::bigint)
             ORDER BY label_sort,ordinal LIMIT $6) l
           JOIN semantic.definition_catalogue_kind k ON k.route=0 AND k.root_digest=$1 AND k.ordinal=l.ordinal
           ORDER BY l.label_sort,l.ordinal`,
          [pin.rootDigest, languageKey, prefix, afterLabel, afterOrdinal, limit + 1, ...(upper ? [upper] : [])],
          (limit + 1) * 2,
          (limit + 1) * 4608,
        );
      } else {
        let precedence = 2147483647,
          ordinal = '0';
        if (after) {
          const boundary = (
            await query<{ precedence: number; exact_type_id: Buffer; eligible: boolean }>(
              client,
              context,
              'SELECT precedence,exact_type_id,eligible FROM semantic.definition_catalogue_kind WHERE route=0 AND root_digest=$1 AND ordinal=$2',
              [pin.rootDigest, after],
              1,
              4 * 65536 + 512,
            )
          )[0];
          if (!boundary || !boundary.eligible || boundary.exact_type_id.toString('utf8') !== input.exactTypeId)
            catalogueFail('invalid', 'Missing candidate cursor boundary');
          precedence = boundary.precedence;
          ordinal = after;
        }
        // Two disjoint index ranges avoid an OR that could filter an unbounded prefix of old candidates.
        const same = await query<KeyRow>(
          client,
          context,
          `SELECT id_key,ordinal,octet_length(body::text) AS size,precedence FROM semantic.definition_catalogue_kind
           WHERE route=0 AND root_digest=$1 AND exact_type_key=$2 AND eligible AND precedence=$3 AND ordinal>$4
           ORDER BY precedence DESC,ordinal LIMIT $5`,
          [pin.rootDigest, catalogueKey(input.exactTypeId), precedence, ordinal, limit + 1],
          limit + 1,
          (limit + 1) * 512,
        );
        const rest =
          same.length > limit
            ? []
            : await query<KeyRow>(
                client,
                context,
                `SELECT id_key,ordinal,octet_length(body::text) AS size,precedence FROM semantic.definition_catalogue_kind
           WHERE route=0 AND root_digest=$1 AND exact_type_key=$2 AND eligible AND precedence<$3
           ORDER BY precedence DESC,ordinal LIMIT $4`,
                [pin.rootDigest, catalogueKey(input.exactTypeId), precedence, limit + 1 - same.length],
                limit + 1 - same.length,
                (limit + 1 - same.length) * 512,
              );
        rows = [...same, ...rest];
      }
      let size = 8192;
      const selected: KeyRow[] = [];
      for (const row of rows.slice(0, limit)) {
        // Includes the immutable pin, digest, wrapper and escaped duplicate exact ID headroom.
        const record = row.size + 1024;
        if (record + 8192 > MAX_RESPONSE_BYTES) unavailable();
        if (size + record > MAX_RESPONSE_BYTES) break;
        selected.push(row);
        size += record;
      }
      const bodies = new Map(
        (
          await values(
            client,
            pin,
            selected.map((row) => row.id_key),
            context,
          )
        ).map((row) => [row.id_key, row]),
      );
      const declarations = selected.map((key) => {
        const row = bodies.get(key.id_key);
        if (!row) return unavailable();
        if (
          !metadata &&
          (row.body.condition.op !== 'exact-type' || row.body.condition.type.typeId !== input.exactTypeId)
        )
          return unavailable();
        return pinned(pin, row);
      });
      const cursor = selected.length < rows.length ? next(binding, selected.at(-1)!.ordinal) : null;
      const response = { declarations, next: cursor };
      bytes(response);
      return response;
    });
  }
  return {
    head: (context) =>
      read(context, async (client) => {
        const row = (
          await query<{ root_digest: string | null; head: number }>(
            client,
            context,
            'SELECT root_digest,head FROM semantic.definition_catalogue_head WHERE route=0',
            [],
            1,
            256,
          )
        )[0];
        if (!row) return unavailable();
        if (row.root_digest === null) return null;
        const pin = cataloguePin(row.root_digest);
        await ready(client, pin, context);
        return { pin, head: row.head };
      }),
    kinds(input, context) {
      const pin = parseCataloguePin(input.pin);
      const ids = [...input.ids];
      if (
        !ids.length ||
        ids.length > 100 ||
        new Set(ids).size !== ids.length ||
        catalogueBytes(ids).length > MAX_RESPONSE_BYTES
      )
        catalogueFail('invalid', 'Expected 1–100 unique exact Kind IDs');
      ids.forEach(assertKindId);
      return read(context, async (client) => {
        await ready(client, pin, context);
        const keys = ids.map(catalogueKey);
        const sizes = await query<{ id_key: string; size: number }>(
          client,
          context,
          'SELECT id_key,octet_length(body::text) AS size FROM semantic.definition_catalogue_kind WHERE route=0 AND root_digest=$1 AND id_key=ANY($2::text[])',
          [pin.rootDigest, keys],
          ids.length,
          ids.length * 256,
        );
        if (sizes.reduce((sum, row) => sum + row.size + 1024, catalogueBytes(ids).length) > MAX_RESPONSE_BYTES)
          unavailable();
        const bodies = new Map((await values(client, pin, keys, context)).map((row) => [row.id_key, row]));
        const response = ids.map((id) => {
          const row = bodies.get(catalogueKey(id));
          if (row && row.body.id !== id) return unavailable();
          return { id, value: row ? pinned(pin, row) : null };
        });
        bytes(response);
        return response;
      });
    },
    async kindPage(input, context) {
      const value = await page(input, context);
      return { kinds: value.declarations, next: value.next };
    },
    async kindCandidates(input, context) {
      const value = await page(input, context);
      return { candidates: value.declarations, next: value.next };
    },
    build(input, context) {
      const pin = parseCataloguePin(input.pin);
      return read(context, (client) =>
        context.work.run(
          'definitions.catalogue.build-status',
          {
            ...EMPTY_ACCESS_WORK,
            keys: 1,
            points: 1,
            rows: 1,
            bytes: 16384,
            emptySeeks: 1,
          },
          () => readCatalogueBuild(client, pin),
        ),
      );
    },
  };
}
/** Explicit bounded historical adapter. It never fabricates a catalogue root or changes a Release1 digest. */
export async function legacyReleaseKinds(pool: Pool, digest: string, ids: readonly string[]) {
  if (
    !ids.length ||
    ids.length > 100 ||
    new Set(ids).size !== ids.length ||
    catalogueBytes(ids).length > MAX_RESPONSE_BYTES
  )
    catalogueFail('invalid', 'Expected 1–100 bounded legacy keys');
  ids.forEach(assertKindId);
  const release = await readRelease(pool, digest, { composed: false });
  if (!release) return null;
  if (Object.keys(release.types).length > RELEASE_LIMITS.types || catalogueBytes(release).length > RELEASE_LIMITS.bytes)
    unavailable();
  try {
    const values = ids.map((id) => ({
      id,
      releaseDigest: digest,
      declaration: Object.hasOwn(release.types, id) ? compatibilityKind(release, digest, id) : null,
    }));
    if (catalogueBytes(values).length > MAX_RESPONSE_BYTES) unavailable();
    return values;
  } catch (error) {
    if (error instanceof CatalogueArtifactError) unavailable();
    throw error;
  }
}

export type {
  KindCatalogueConsumerKey,
  KindCatalogueConsumerRef,
  KindCatalogueNativeContext,
  PreparedKindCatalogueRead,
  KindCatalogueWorkRead,
  KindCatalogueWorkReadResult,
} from './definition-catalogue-types.ts';
import type {
  KindCatalogueConsumerKey,
  KindCatalogueConsumerRef,
  KindCatalogueNativeContext,
  PreparedKindCatalogueRead,
  KindCatalogueWorkRead,
  KindCatalogueWorkReadResult,
} from './definition-catalogue-types.ts';

type KindDeps = Readonly<{ pool: Pool; access: Access }>;
type KindPreparationContext = Readonly<{ time: AuthoritativeTime; work: NativeCollectionWork; deadline: number }>;
function kindCatalogueBodyWork<T>(
  context: Readonly<{ work: NativeCollectionWork; deadline: number }>,
  cost: import('../library/collection-source.ts').WorkDimensions,
  operation: () => Promise<T>,
) {
  return catalogueBodyWork(context.work, cost, operation, context.deadline);
}

type PreparedKindState = {
  pool: Pool;
  access: Access;
  input: Buffer;
  time: AuthoritativeTime;
  deadline: number;
  work: NativeCollectionWork;
  reservation: string;
  accounting: AccessWorkAccounting;
};
const preparedKindStates = new WeakMap<PreparedKindCatalogueRead, PreparedKindState>();

/** The current Accounts exports are two-argument refusing stubs. Neither takes the SAME
 * NativeCollectionWork. Core also has no hasOperationalAdmission(tx, work) producer.
 * Calling those stubs or restoring an Actor cannot create the missing admission.
 * Keep the owned SQL bodies below, but do not start foreign IO on an unadmitted original.
 */
export const KIND_CATALOGUE_MISSING_OPERANDS = Object.freeze([
  'library/collection-kind-work-admission.ts: bindCollectionKindPreparationStep(tx, locator, work) and work-bound admitCollectionKindPreparationStep/readCollectionKindWorkDefinition',
  'command/operational.ts: original per-home NativeCollectionWork admission (hasOperationalAdmission), including Global home association',
  'Source: committed catalogue-consumer withdrawal/nonrevival acknowledgement and current-owner verifier',
] as const);
function originalKindCatalogueAccounting(
  _deps: KindDeps | Readonly<{ pool: Pool }>,
  _context: KindPreparationContext,
): AccessWorkAccounting {
  // Reference the actual producer exports; no installed replacement, guessed price or receipt cast.
  void admitCollectionKindPreparationStep;
  void readCollectionKindWorkDefinition;
  throw new ProblemError('dependency_unavailable');
}
function originalKindCatalogueEnrollmentProvenance(
  _context: KindCatalogueNativeContext,
  _consumer: KindCatalogueConsumerKey,
): Buffer {
  throw new ProblemError('dependency_unavailable');
}
function assertKindGlobal(pool: Pool, context: KindCatalogueNativeContext, time?: AuthoritativeTime) {
  context.work.assertReady();
  if (
    !hasLiveOperationalTransaction(context.tx) ||
    !Number.isFinite(context.deadline) ||
    Date.now() >= context.deadline
  )
    throw new ProblemError('dependency_unavailable');
  const resources = currentOperationalResources(context.tx);
  const currentTime = commandTime(context.tx);
  if (
    resources.pool !== pool ||
    resources.partition !== 0 ||
    resources.mode !== 'work-step' ||
    context.deadline !== resources.deadline ||
    !currentTime ||
    (time && time !== currentTime)
  )
    throw new ProblemError('dependency_unavailable');
  authoritativeTimeValue(currentTime);
  return currentTime;
}
/** A live operational transaction is necessary, never sufficient. The Accounts
 * original and exact native provenance must both be present before lock dispatch.
 * This guard cannot issue publisher authority or accept a structural grant.
 */
export function assertKindCatalogueEnrollmentAdmission(context: KindCatalogueNativeContext): void {
  const resources = currentOperationalResources(context.tx);
  const time = assertKindGlobal(resources.pool, context);
  originalKindCatalogueAccounting({ pool: resources.pool }, { time, work: context.work, deadline: context.deadline });
  originalKindCatalogueEnrollmentProvenance(context, context.consumer);
}
function snapshotKindInput(input: KindCatalogueWorkRead): { input: KindCatalogueWorkRead; bytes: Buffer } {
  const bytes = Buffer.from(catalogueBytes(input));
  if (bytes.length > 65536) catalogueFail('invalid', 'Kind work input exceeds 64 KiB');
  const value = parseCatalogueJson(bytes, 65536) as KindCatalogueWorkRead;
  const allowed =
    value.op === 'head'
      ? ['op']
      : value.op === 'kinds'
        ? ['op', 'pin', 'ids']
        : value.op === 'candidates'
          ? ['op', 'pin', 'exactTypeId', 'limit', 'cursor']
          : [];
  if (
    !allowed.length ||
    Object.keys(value).length !== allowed.length ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    catalogueFail('invalid', 'Invalid closed Kind work input');
  if (value.op !== 'head') parseCataloguePin(value.pin);
  if (value.op === 'kinds') {
    if (
      !Array.isArray(value.ids) ||
      !value.ids.length ||
      value.ids.length > 100 ||
      new Set(value.ids).size !== value.ids.length
    )
      catalogueFail('invalid', 'Expected 1–100 unique exact Kind IDs');
    value.ids.forEach(assertKindId);
  }
  if (value.op === 'candidates') {
    assertKindId(value.exactTypeId);
    limitOf(value.limit);
    if (value.cursor !== null && (typeof value.cursor !== 'string' || value.cursor.length > 8192))
      catalogueFail('invalid', 'Invalid Kind work cursor');
  }
  return { input: value, bytes };
}

/** Access preparation happens before Global checkout. No clock checkout, Actor restoration or detached admission. */
export async function prepareKindCatalogueForWork(
  deps: KindDeps,
  input: KindCatalogueWorkRead,
  context: KindPreparationContext,
): Promise<PreparedKindCatalogueRead> {
  return kindCatalogueBodyWork(context, nativeControl.kindPrepareInput, async () => {
    context.work.assertReady();
    if (!Number.isFinite(context.deadline) || Date.now() >= context.deadline)
      throw new ProblemError('dependency_unavailable');
    authoritativeTimeValue(context.time);
    // Missing original admission/accounting refuses here, before Access preparation or any metadata I/O.
    const accounting = originalKindCatalogueAccounting(deps, context);
    const snapshot = snapshotKindInput(input);
    const handle = Object.freeze({}) as PreparedKindCatalogueRead;
    preparedKindStates.set(handle, {
      pool: deps.pool,
      access: deps.access,
      input: snapshot.bytes,
      time: context.time,
      deadline: context.deadline,
      work: context.work,
      reservation: context.work.receipt().reservationId,
      accounting,
    });
    return handle;
  });
}
async function kindBodyQuery<R extends import('pg').QueryResultRow>(
  context: KindCatalogueNativeContext,
  sql: string,
  params: unknown[],
  cost: import('../library/collection-source.ts').WorkDimensions,
): Promise<R[]> {
  context.work.assertReady();
  return kindCatalogueBodyWork(
    context,
    catalogueSQLCost(cost, sql, params),
    async () =>
      (
        await context.tx.query<R>({
          text: sql,
          values: params,
        })
      ).rows,
  );
}
function kindWorkBinding(pin: KindCataloguePin, type: string): CursorBinding {
  return {
    operation: 'definitions.catalogue.candidates',
    parameters: {
      root: pin.rootDigest,
      kindSpec: pin.kindSpec,
      reduction: pin.reduction,
      exactTypeId: type,
      sort: 'precedence-desc,kind-id-utf16-asc',
    },
  };
}
async function kindWorkValues(context: KindCatalogueNativeContext, pin: KindCataloguePin, ids: readonly string[]) {
  if (!ids.length) return [];
  const rows = await kindBodyQuery<{ id_key: string; declaration_digest: string; body: KindDeclarationV1 }>(
    context,
    'SELECT id_key,declaration_digest,body FROM semantic.definition_catalogue_kind WHERE route=0 AND root_digest=$1 AND id_key=ANY($2::text[])',
    [pin.rootDigest, ids],
    bodyCost.kindBodies,
  );
  return rows.map((row) => ({
    key: row.id_key,
    value: {
      catalogue: pin,
      declarationDigest: row.declaration_digest,
      declaration: parseKindDeclaration(row.body),
    },
  }));
}
/** Single-use original preparation, exact input/Pool/Access/time/ledger binding; all SQL uses context.tx. */
export async function readKindCatalogueForWork(
  deps: KindDeps,
  input: KindCatalogueWorkRead,
  context: KindCatalogueNativeContext & Readonly<{ prepared: PreparedKindCatalogueRead }>,
): Promise<KindCatalogueWorkReadResult> {
  const prepared = preparedKindStates.get(context.prepared);
  // Consume before checking stale/changed bindings as well. Failure cannot leave a reusable handle.
  preparedKindStates.delete(context.prepared);
  await kindCatalogueBodyWork(context, nativeControl.kindAdmission, async () => undefined);
  if (
    !prepared ||
    prepared.pool !== deps.pool ||
    prepared.access !== deps.access ||
    prepared.work !== context.work ||
    prepared.deadline !== context.deadline ||
    prepared.reservation !== context.work.receipt().reservationId
  )
    throw new ProblemError('dependency_unavailable');
  const time = assertKindGlobal(deps.pool, context, prepared.time);
  originalKindCatalogueAccounting(deps, { time, work: context.work, deadline: context.deadline });
  try {
    return await kindCatalogueBodyWork(context, nativeControl.kindDecision, async () => {
      const snapshot = snapshotKindInput(input);
      if (!prepared.input.equals(snapshot.bytes)) throw new ProblemError('dependency_unavailable');
      const read = snapshot.input;
      if (read.op === 'head') {
        const [head] = await kindBodyQuery<{ root_digest: string | null; head: number }>(
          context,
          'SELECT root_digest,head FROM semantic.definition_catalogue_head WHERE route=0',
          [],
          bodyCost.headRead,
        );
        if (!head) unavailable();
        // No immutable root exists to retain this negative dependency; never return an untracked decision.
        if (head.root_digest === null) return unavailable();
        const pin = cataloguePin(head.root_digest);
        if (
          !(await enrollKindCatalogueConsumer(
            deps,
            { catalogue: pin, consumer: context.consumer, dependency: read },
            context,
          ))
        )
          unavailable();
        await kindWorkReady(context, pin);
        return { op: 'head', value: { pin, head: head.head } };
      }
      const pin = parseCataloguePin(read.pin);
      if (
        !(await enrollKindCatalogueConsumer(
          deps,
          { catalogue: pin, consumer: context.consumer, dependency: read },
          context,
        ))
      )
        unavailable();
      await kindWorkReady(context, pin);
      if (read.op === 'kinds') {
        const keys = read.ids.map(catalogueKey);
        const sizes = await kindBodyQuery<{ size: number }>(
          context,
          'SELECT octet_length(body::text) AS size FROM semantic.definition_catalogue_kind WHERE route=0 AND root_digest=$1 AND id_key=ANY($2::text[])',
          [pin.rootDigest, keys],
          bodyCost.kindSizes,
        );
        if (sizes.reduce((sum, row) => sum + row.size + 1024, snapshot.bytes.length) > MAX_RESPONSE_BYTES)
          unavailable();
        const values = new Map((await kindWorkValues(context, pin, keys)).map((row) => [row.key, row.value]));
        const result = {
          op: 'kinds' as const,
          values: read.ids.map((id) => {
            const value = values.get(catalogueKey(id)) ?? null;
            if (value && value.declaration.id !== id) unavailable();
            return { id, value };
          }),
        };
        if (catalogueBytes(result).length > MAX_RESPONSE_BYTES) unavailable();
        return result;
      }
      const keys = cursorKeys.get(deps.pool);
      if (!keys) unavailable();
      // Same public candidate cursor identity and exact indexed ordering.
      const binding = kindWorkBinding(pin, read.exactTypeId);
      let precedence = 2147483647,
        ordinal = '0';
      if (read.cursor !== null) {
        const decoded = decodeCursor(keys, binding, read.cursor);
        if (
          !decoded.ok ||
          decoded.after.length !== 1 ||
          typeof decoded.after[0] !== 'string' ||
          !/^[1-9][0-9]*$/.test(decoded.after[0])
        )
          catalogueFail('invalid', 'Invalid catalogue cursor');
        ordinal = decoded.after[0];
        const [boundary] = await kindBodyQuery<{ precedence: number; exact_type_id: Buffer; eligible: boolean }>(
          context,
          'SELECT precedence,exact_type_id,eligible FROM semantic.definition_catalogue_kind WHERE route=0 AND root_digest=$1 AND ordinal=$2',
          [pin.rootDigest, ordinal],
          bodyCost.boundary,
        );
        if (!boundary?.eligible || boundary.exact_type_id.toString('utf8') !== read.exactTypeId)
          catalogueFail('invalid', 'Missing candidate cursor boundary');
        precedence = boundary.precedence;
      }
      const same = await kindBodyQuery<KeyRow>(
        context,
        'SELECT id_key,ordinal,octet_length(body::text) AS size,precedence FROM semantic.definition_catalogue_kind WHERE route=0 AND root_digest=$1 AND exact_type_key=$2 AND eligible AND precedence=$3 AND ordinal>$4 ORDER BY precedence DESC,ordinal LIMIT $5',
        [pin.rootDigest, catalogueKey(read.exactTypeId), precedence, ordinal, read.limit + 1],
        bodyCost.candidateRange,
      );
      const rest =
        same.length > read.limit
          ? []
          : await kindBodyQuery<KeyRow>(
              context,
              'SELECT id_key,ordinal,octet_length(body::text) AS size,precedence FROM semantic.definition_catalogue_kind WHERE route=0 AND root_digest=$1 AND exact_type_key=$2 AND eligible AND precedence<$3 ORDER BY precedence DESC,ordinal LIMIT $4',
              [pin.rootDigest, catalogueKey(read.exactTypeId), precedence, read.limit + 1 - same.length],
              bodyCost.candidateRange,
            );
      const rows = [...same, ...rest];
      let bytes = 8192;
      const selected: KeyRow[] = [];
      for (const row of rows.slice(0, read.limit)) {
        if (row.size + 9216 > MAX_RESPONSE_BYTES) unavailable();
        if (bytes + row.size + 1024 > MAX_RESPONSE_BYTES) break;
        bytes += row.size + 1024;
        selected.push(row);
      }
      const values = new Map(
        (
          await kindWorkValues(
            context,
            pin,
            selected.map((row) => row.id_key),
          )
        ).map((row) => [row.key, row.value]),
      );
      const result = {
        op: 'candidates' as const,
        values: selected.map((row) => {
          const value = values.get(row.id_key) ?? unavailable();
          if (
            value.declaration.condition.op !== 'exact-type' ||
            value.declaration.condition.type.typeId !== read.exactTypeId
          )
            unavailable();
          return value;
        }),
        next:
          selected.length < rows.length
            ? encodeCursor(keys, binding, { epoch: 1, after: [selected.at(-1)!.ordinal] })
            : null,
      };
      if (catalogueBytes(result).length > MAX_RESPONSE_BYTES) unavailable();
      return result;
    });
  } catch (error) {
    context.work.failure = error instanceof Error ? error : new Error('Catalogue native read failed');
    throw error;
  }
}
async function kindWorkReady(context: KindCatalogueNativeContext, pin: KindCataloguePin) {
  const [row] = await kindBodyQuery<{ state: string }>(
    context,
    'SELECT state FROM semantic.definition_catalogue_build WHERE route=0 AND root_digest=$1',
    [pin.rootDigest],
    bodyCost.buildRead,
  );
  if (row?.state !== 'ready') unavailable();
}
function consumerBytes(consumer: KindCatalogueConsumerKey): Buffer {
  const bytes = Buffer.from(catalogueBytes(consumer));
  if (bytes.length > 8192) catalogueFail('invalid', 'Consumer locator exceeds its retained byte bound');
  return bytes;
}

/** Every candidate decision, including pending binding/negative/in-flight work, enrolls as an obligation. */
export async function enrollKindCatalogueConsumer(
  deps: Readonly<{ pool: Pool }>,
  input: Readonly<{
    catalogue: KindCataloguePin;
    consumer: KindCatalogueConsumerKey;
    dependency?: KindCatalogueWorkRead;
  }>,
  context: KindCatalogueNativeContext,
): Promise<KindCatalogueConsumerRef | null> {
  await kindCatalogueBodyWork(context, nativeControl.kindAdmission, async () => undefined);
  const time = assertKindGlobal(deps.pool, context);
  originalKindCatalogueAccounting(deps, { time, work: context.work, deadline: context.deadline });
  const provenance = originalKindCatalogueEnrollmentProvenance(context, input.consumer);
  return kindCatalogueBodyWork(context, nativeControl.kindEnrollment, async () => {
    const catalogue = parseCataloguePin(input.catalogue),
      consumer = consumerBytes(input.consumer);
    const dependency = input.dependency ? snapshotKindInput(input.dependency).input : null;
    if (dependency && dependency.op !== 'head' && dependency.pin.rootDigest !== catalogue.rootDigest) unavailable();
    const dependencyBytes = Buffer.from(catalogueBytes(dependency));
    if (!provenance.length || provenance.length > 8192) throw new ProblemError('dependency_unavailable');
    const id = catalogueDigest(catalogueBytes({ catalogue, consumer: input.consumer, dependency }));
    const locked = await lockKindCatalogueEnrollment(context, catalogue.rootDigest);
    if (
      locked.head.root_digest !== catalogue.rootDigest ||
      locked.enrollment.protocol !== 1 ||
      locked.enrollment.state !== 'open'
    )
      return null;
    const params = { root: catalogue.rootDigest, id };
    const existing = await kindCatalogueBodyWork(
      context,
      catalogueSQLCost(bodyCost.consumerRead, consumerRead.sql, params),
      () => consumerRead.run(context.tx, params),
    );
    if (existing) {
      if (
        !Buffer.from(existing.consumer).equals(consumer) ||
        !Buffer.from(existing.provenance).equals(provenance) ||
        !Buffer.from(existing.dependency).equals(dependencyBytes) ||
        existing.enrollment_generation !== locked.enrollment.generation
      )
        throw new ProblemError('dependency_unavailable');
    } else {
      const params = {
        root: catalogue.rootDigest,
        id,
        consumer,
        provenance,
        dependency: dependencyBytes,
        generation: locked.enrollment.generation,
      };
      const saved = await kindCatalogueBodyWork(
        context,
        catalogueSQLCost(bodyCost.enroll, enrollConsumer.sql, params),
        () => enrollConsumer.run(context.tx, params),
      );
      if (!saved) return null;
    }
    return {
      id,
      catalogue,
      consumer: parseCatalogueJson(consumer, 8192) as KindCatalogueConsumerKey,
      enrollmentGeneration: locked.enrollment.generation,
      dependency,
    };
  });
}
/** Only admitted Global Kind invocations may hold this head lock through their original local commit. */
export async function lockCurrentKindCatalogueHead(
  deps: Readonly<{ pool: Pool }>,
  input: Readonly<{ expected: KindCataloguePin; consumer: KindCatalogueConsumerRef }>,
  context: KindCatalogueNativeContext,
): Promise<boolean> {
  await kindCatalogueBodyWork(context, nativeControl.kindAdmission, async () => undefined);
  const time = assertKindGlobal(deps.pool, context);
  originalKindCatalogueAccounting(deps, { time, work: context.work, deadline: context.deadline });
  const provenance = originalKindCatalogueEnrollmentProvenance(context, input.consumer.consumer);
  return kindCatalogueBodyWork(context, nativeControl.kindLock, async () => {
    const expected = parseCataloguePin(input.expected),
      reference = input.consumer;
    if (
      !Buffer.from(catalogueBytes(expected)).equals(Buffer.from(catalogueBytes(parseCataloguePin(reference.catalogue))))
    )
      return false;
    const locked = await lockKindCatalogueEnrollment(context, expected.rootDigest);
    if (
      locked.head.root_digest !== expected.rootDigest ||
      locked.enrollment.protocol !== 1 ||
      locked.enrollment.state !== 'open' ||
      locked.enrollment.generation !== reference.enrollmentGeneration
    )
      return false;
    const params = { root: expected.rootDigest, id: reference.id };
    const row = await kindCatalogueBodyWork(
      context,
      catalogueSQLCost(bodyCost.consumerRead, consumerRead.sql, params),
      () => consumerRead.run(context.tx, params),
    );
    return (
      !!row &&
      row.state !== 'invalidated' &&
      row.enrollment_generation === reference.enrollmentGeneration &&
      Buffer.from(row.consumer).equals(consumerBytes(reference.consumer)) &&
      Buffer.from(row.provenance).equals(provenance) &&
      Buffer.from(row.dependency).equals(Buffer.from(catalogueBytes(reference.dependency)))
    );
  });
}
