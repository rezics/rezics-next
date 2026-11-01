import type { Pool, PoolClient } from 'pg';
import {
  CatalogueArtifactError,
  CATALOGUE_FORMAT,
  KIND_FORMAT,
  KIND_REDUCTION,
  catalogueBytes,
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
