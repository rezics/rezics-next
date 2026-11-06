import { memoizedValue } from '../memoized.ts';
import { statementBytes } from '../database/statement-bytes.ts';
import { declareBound, repeatBound, sumBounds, type Bound } from '@rezics/bounds';
import { RELEASE_LIMITS } from '@rezics/definitions';
import type { PoolClient } from 'pg';
import type { CollectionListFilter } from '../access/policy-filter.ts';
import curatorPage from './collection-reads-curator.sql';
import publicPage from './collection-reads-curator-public.sql';
import collectionRead from './collection-reads-collection.sql';
import membersRead from './collection-preview-members.sql';
import fencesRead from './collection-preview-fences.sql';

type Client = Pick<PoolClient, 'query'>;
type Statement<Input extends object, Output> = {
  sql: string;
  run(client: Client, input: Input): Promise<Output>;
};

/** A SQL declaration owns its operands, but never a connection, grant or work allowance. */
export type CollectionReadStatement<Output> = Readonly<{
  total: Bound;
  run(client: Client): Promise<Output>;
}>;

const uuid = 'f'.repeat(36);
const escaped = (characters: number) => '\0'.repeat(characters);
const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const bytes = (value: number): Bound =>
  declareBound({
    candidateKeys: 0,
    nativeRows: 0,
    identityMetadataRows: 0,
    nativePoints: 0,
    witnessKeys: 0,
    statements: 0,
    bytes: value,
    emptySeeks: 0,
    engineRequests: 0,
  });

// Collection schema: 200/2000 characters, UUIDs, int4 counters, int8 generation.
// Presentation Types come from a validated immutable release. Its byte ceiling
// bounds that identifier even though the Collection column itself is text.
const collectionProjection = {
  id: uuid,
  curatorAccountId: uuid,
  title: escaped(200),
  description: escaped(2000),
  visibility: 'unlisted',
  presentationKind: '',
  coverMediaId: uuid,
  sourceGeneration: '9'.repeat(19),
  membershipKind: 'curated',
  revision: -2147483648,
  memberCount: -2147483648,
  orderEpoch: -2147483648,
  createdAt: escaped(64),
  updatedAt: escaped(64),
};
function collectionBytes() {
  return memoizedValue(collectionBytes, () => jsonBytes(collectionProjection) + 6 * RELEASE_LIMITS.bytes);
}
function directoryBytes() {
  return memoizedValue(directoryBytes, () => collectionBytes() + jsonBytes({ updatedAtExact: escaped(27) }));
}
function storedCollectionBytes() {
  return memoizedValue(storedCollectionBytes, () => collectionBytes() + jsonBytes({ state: 'deleted' }));
}

function statement<Input extends object, Output>(
  query: Statement<Input, Output>,
  input: Input,
  shape: { candidateKeys: number; nativeRows: number; nativePoints: number; emptySeeks: number },
  projectionBytes: number,
  projectedRows: number,
): CollectionReadStatement<Output> {
  const original = Object.freeze({ ...input });
  const total = sumBounds(
    declareBound({
      ...shape,
      identityMetadataRows: 0,
      witnessKeys: 0,
      statements: 1,
      bytes: 0,
      // These execution closures dispatch exactly one native SQL statement.
      engineRequests: 0,
    }),
    bytes(statementBytes(query) + jsonBytes(original) + 2),
    repeatBound(bytes(projectionBytes + 1), projectedRows),
  );
  return Object.freeze({ total, run: (client: Client) => query.run(client, original) });
}

/** Both candidate arms retain their own LIMIT, including negative/discarded/sentinel work. */
export function collectionDirectoryPagePlan(
  input: Parameters<typeof curatorPage.run>[1] & { limit: number },
  policy: Extract<CollectionListFilter, { status: 'ready' }>,
) {
  const shape = {
    candidateKeys: 2 * input.limit,
    // Two index/Limit producers, Append, Sort and final Limit; three scalar LIMIT binds.
    nativeRows: 9 * input.limit + 3,
    nativePoints: 2,
    emptySeeks: 2,
  };
  return policy.source === 'curator'
    ? statement(curatorPage, input, shape, directoryBytes(), input.limit)
    : statement(publicPage, { ...input, ...policy.parameters }, shape, directoryBytes(), input.limit);
}

/** The same full-key original is used for initial and terminal Collection observations. */
export function collectionDirectoryRowPlan(input: Parameters<typeof collectionRead.run>[1]) {
  return statement(
    collectionRead,
    input,
    { candidateKeys: 1, nativeRows: 2, nativePoints: 1, emptySeeks: 1 },
    storedCollectionBytes(),
    1,
  );
}

type PreviewInput = Parameters<typeof fencesRead.run>[1];
function frozenOperands<T>(values: readonly T[]): T[] {
  const original = [...values];
  Object.freeze(original);
  // Generated SQL signatures use mutable arrays; their runner only serializes them.
  return original;
}
function previewOriginal(input: PreviewInput): PreviewInput {
  // Freeze every array; caller mutation must not change any deferred dispatch.
  return Object.freeze({
    routes: frozenOperands(input.routes),
    collection_ids: frozenOperands(input.collection_ids),
    source_generations: frozenOperands(input.source_generations),
    revisions: frozenOperands(input.revisions),
  });
}

/** Raw occurrences, including deleted and duplicate originals, precede display coalescing. */
export function collectionPreviewStatements(input: PreviewInput, perParent: number) {
  const original = previewOriginal(input);
  const parents = original.collection_ids.length;
  const raw = parents * perParent;
  const members = statement(
    membersRead,
    { ...original, per_parent: perParent },
    {
      candidateKeys: raw,
      // Requested rows, parent point/Limit/join, fence point/join, and member
      // scan/Limit/left-join/order. Empty parents still produce one outer row.
      nativeRows: 6 * parents + 4 * Math.max(raw, parents),
      nativePoints: 3 * parents,
      emptySeeks: 3 * parents,
    },
    jsonBytes({ collectionId: uuid, nativeGeneration: '9'.repeat(19), subjectId: uuid, deletionId: uuid }),
    Math.max(raw, parents),
  );
  const fences = statement(
    fencesRead,
    original,
    { candidateKeys: parents, nativeRows: 5 * parents, nativePoints: 2 * parents, emptySeeks: 2 * parents },
    jsonBytes({ collectionId: uuid, nativeGeneration: '9'.repeat(19) }),
    parents,
  );
  return Object.freeze({ members, fences, total: sumBounds(members.total, fences.total) });
}
