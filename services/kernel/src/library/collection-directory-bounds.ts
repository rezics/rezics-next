import { declareBound, repeatBound, sumBounds, type Bound } from '@rezics/bounds';
import { RELEASE_LIMITS } from '@rezics/definitions';
import type { PoolClient } from 'pg';
import type { WorkDimensions } from './collection-source.ts';
import { COVER_CREDIT_JSON_MAX_BYTES, COVER_PROVENANCE_JSON_MAX_BYTES } from '../content/cover-reference.ts';
import accountRead from '../access/account-read.sql';
import accountPublicRead from '../access/account-public-read.sql';
import publicViewsRead from '../access/account-views-read.sql';
import coverReferenceRead from '../content/read-cover-reference.sql';
import downloadMediaRead from '../content/read-download-media.sql';
import sourceFencesRead from '../content/read-source-fences.sql';
import subjectExistsRead from '../semantic/subject-exists.sql';
import subjectSummaryStatesRead from '../semantic/subject-summary-states.sql';
import subjectSummaryRead from '../semantic/summaries-read.sql';
import representativeEditionsRead from '../semantic/summaries-representative-editions.sql';
import partitionRead from '../partition/read.sql';
import {
  BUILTIN_NATIVE_PRESENCE_SQL,
  BUILTIN_STATE_LABELS_SQL,
  BUILTIN_STATE_SUCCESSORS_SQL,
  BUILTIN_STORED_COLLECTION_SQL,
} from './builtin-runtime.ts';
import { OWNER_INDEX_FRONTIER_READ_SQL } from './owner-index.ts';
import { OWNER_INDEX_NEXT_PIN_SQL } from './owner-index-metadata.ts';
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
const responseBodyBytes = RELEASE_LIMITS.bytes + 65_536;
const responseBodyStringLength = Math.floor(responseBodyBytes / 6);
const responseBodyStringBytes = 6 * responseBodyStringLength;
const releaseStringLength = Math.floor(RELEASE_LIMITS.bytes / 6);
const releaseStringBytes = 6 * releaseStringLength;
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
const collectionBytes = jsonBytes(collectionProjection) + 6 * RELEASE_LIMITS.bytes;
const directoryBytes = collectionBytes + jsonBytes({ updatedAtExact: escaped(27) });
const storedCollectionBytes = collectionBytes + jsonBytes({ state: 'deleted' });
const accountId = uuid;

const avatarSummaryProjection = {
  media: uuid,
  width: 40_000_000,
  height: 40_000_000,
  placeholder: { thumbhash: escaped(44), color: '#ffffff' },
  variants: Array.from({ length: 12 }, (_, index) => ({ format: index % 2 ? 'webp' : 'avif', width: 2560 })),
  focalPoint: { x: 1, y: 1 },
  credit: null,
};
const publicAccountProjection = {
  accountId,
  kind: 'organization',
  state: 'active',
  avatar: avatarSummaryProjection,
  publicViews: { posts: true, reviews: true, collections: true, realms: true },
  speakersListed: true,
  handle: escaped(64),
  displayName: escaped(4096),
  avatarUrl: escaped(2048),
  biography: escaped(4096),
  links: Array.from({ length: 5 }, () => ({ label: escaped(64), url: escaped(2048) })),
  operatorAccountId: uuid,
  agentVerified: true,
  agentSubjectId: uuid,
};
const accountProjection = {
  route: 2147483647,
  accountId,
  kind: 'organization',
  handle: escaped(64),
  displayName: escaped(4096),
  avatarUrl: escaped(2048),
  biography: escaped(4096),
  state: 'active',
  operatorAccountId: uuid,
  controllerId: uuid,
  birthDate: '9999-12-31',
  contentPreferences: { language: 'en', media: true },
  suspensionReason: escaped(4096),
  minimumAuthnEpoch: '9'.repeat(19),
  fenced: true,
  createdAt: 9007199254740991,
  rateTier: 'standard',
  transactionId: uuid,
};

function zeroOperationBound(): Bound {
  return declareBound({
    candidateKeys: 0,
    nativeRows: 0,
    identityMetadataRows: 0,
    nativePoints: 0,
    witnessKeys: 0,
    statements: 0,
    bytes: 0,
    emptySeeks: 0,
    engineRequests: 0,
  });
}

/** The public operation is immutable; each native owner receives its own closed term. */
export type CollectionReadOperationPlan = Readonly<{
  kind: 'collection.directory' | 'subject.collections';
  terms: Readonly<Record<string, Bound>>;
  total: Bound;
}>;

export function composeCollectionReadOperation(
  kind: CollectionReadOperationPlan['kind'],
  terms: Readonly<Record<string, Bound>>,
): CollectionReadOperationPlan {
  const frozenTerms = Object.freeze(
    Object.fromEntries(Object.entries(terms).map(([name, term]) => [name, declareBound(term)])),
  );
  return Object.freeze({ kind, terms: frozenTerms, total: sumBounds(...Object.values(frozenTerms)) });
}

/** Explicit adapter for the existing native eight-axis receipt; engine requests stay a separate ninth axis. */
export function collectionReadWorkDimensions(bound: Bound): WorkDimensions {
  const value = declareBound(bound);
  return Object.freeze({
    candidateKeys: value.candidateKeys,
    nativeRows: value.nativeRows,
    identityMetadataRows: value.identityMetadataRows,
    emptySeeks: value.emptySeeks,
    nativePoints: value.nativePoints,
    witnessKeys: value.witnessKeys,
    statements: value.statements,
    bytes: value.bytes,
  });
}

export type CollectionReadOperationReceipt = Readonly<{
  work: WorkDimensions;
  engineRequests: number;
}>;

export type CollectionReadOperationUse = Readonly<{
  plan: CollectionReadOperationPlan;
  owner: object;
  pool: object;
  deadline: number;
  consume(name: string): void;
  release(): CollectionReadOperationReceipt;
}>;

/** A route-owned receipt context; terms describe planned work and never grant or reserve it. */
export function bindCollectionReadOperation(
  plan: CollectionReadOperationPlan,
  owner: object,
  pool: object,
  deadline: number,
): CollectionReadOperationUse {
  const consumed = new Set<string>();
  let used = zeroOperationBound();
  let engineRequests = 0;
  let released = false;
  return Object.freeze({
    plan,
    owner,
    pool,
    deadline,
    consume(name: string) {
      if (released) throw new TypeError('Collection read operation is already released');
      const ceiling = plan.terms[name];
      if (!ceiling) throw new TypeError(`Collection read operation has no ${name} term`);
      if (consumed.has(name)) return;
      // Translate every reached native term through the existing eight-axis shape, retaining
      // engineRequests independently instead of silently dropping the ninth axis.
      collectionReadWorkDimensions(ceiling);
      consumed.add(name);
      used = sumBounds(used, ceiling);
      engineRequests += ceiling.engineRequests;
    },
    release(): CollectionReadOperationReceipt {
      if (released) throw new TypeError('Collection read operation is already released');
      released = true;
      return Object.freeze({
        work: collectionReadWorkDimensions(used),
        engineRequests,
      });
    },
  });
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
    bytes(Buffer.byteLength(query.sql) + jsonBytes(original) + 2),
    repeatBound(bytes(projectionBytes + 1), projectedRows),
  );
  return Object.freeze({ total, run: (client: Client) => query.run(client, original) });
}

function rawStatement(
  sql: string,
  input: unknown,
  shape: {
    candidateKeys: number;
    nativeRows: number;
    nativePoints: number;
    emptySeeks: number;
  },
  projectionBytes: number,
  projectedRows = 1,
): Bound {
  return sumBounds(
    declareBound({
      ...shape,
      identityMetadataRows: 0,
      witnessKeys: 0,
      statements: 1,
      bytes: 0,
      engineRequests: 0,
    }),
    bytes(Buffer.byteLength(sql) + jsonBytes(input) + 2),
    repeatBound(bytes(projectionBytes + 1), projectedRows),
  );
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
    ? statement(curatorPage, input, shape, directoryBytes, input.limit)
    : statement(publicPage, { ...input, ...policy.parameters }, shape, directoryBytes, input.limit);
}

/** The same full-key original is used for initial and terminal Collection observations. */
export function collectionDirectoryRowPlan(input: Parameters<typeof collectionRead.run>[1]) {
  return statement(
    collectionRead,
    input,
    { candidateKeys: 1, nativeRows: 2, nativePoints: 1, emptySeeks: 1 },
    storedCollectionBytes,
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

function maximumBound(left: Bound, right: Bound): Bound {
  return declareBound({
    candidateKeys: Math.max(left.candidateKeys, right.candidateKeys),
    nativeRows: Math.max(left.nativeRows, right.nativeRows),
    identityMetadataRows: Math.max(left.identityMetadataRows, right.identityMetadataRows),
    nativePoints: Math.max(left.nativePoints, right.nativePoints),
    witnessKeys: Math.max(left.witnessKeys, right.witnessKeys),
    statements: Math.max(left.statements, right.statements),
    bytes: Math.max(left.bytes, right.bytes),
    emptySeeks: Math.max(left.emptySeeks, right.emptySeeks),
    engineRequests: Math.max(left.engineRequests, right.engineRequests),
  });
}

function point<Input extends object, Output>(
  query: Statement<Input, Output>,
  input: Input,
  projection: unknown,
): Bound {
  return statement(
    query,
    input,
    { candidateKeys: 1, nativeRows: 1, nativePoints: 1, emptySeeks: 1 },
    jsonBytes(projection),
    1,
  ).total;
}

const publicViewPoint = point(
  publicViewsRead,
  { partition: 15, routes: [15], account_ids: [uuid] },
  { accountId: uuid, publicViews: { posts: true, reviews: true, collections: true } },
);
const publicAccountPoint = point(
  accountPublicRead,
  { route: 15, account_id: uuid },
  publicAccountProjection,
);
const accountPoint = point(
  accountRead,
  { route: 15, account_id: uuid },
  accountProjection,
);
const pageControls = declareBound({
  candidateKeys: 0,
  nativeRows: 0,
  identityMetadataRows: 0,
  nativePoints: 0,
  witnessKeys: 0,
  // BEGIN plus either COMMIT or ROLLBACK; a failed COMMIT can dispatch the rollback too.
  statements: 3,
  bytes:
    Buffer.byteLength('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY') +
    Buffer.byteLength('COMMIT') +
    Buffer.byteLength('ROLLBACK'),
  emptySeeks: 0,
  engineRequests: 0,
});
const snapshotControls = declareBound({
  candidateKeys: 0,
  nativeRows: 0,
  identityMetadataRows: 0,
  nativePoints: 0,
  witnessKeys: 0,
  statements: 4,
  bytes:
    Buffer.byteLength('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY') +
    Buffer.byteLength(`SET LOCAL statement_timeout = '${Number.MAX_SAFE_INTEGER}ms'`) +
    Buffer.byteLength('COMMIT') +
    Buffer.byteLength('ROLLBACK'),
  emptySeeks: 0,
  engineRequests: 0,
});
const mediaSnapshotControls = pageControls;

const coverCreditProjection = {
  rightsHolder: escaped(1024),
  via: { name: escaped(1024), url: escaped(1024) },
  license: escaped(80),
  obligations: ['cc:Attribution', 'cc:ShareAlike', 'cc:Notice', 'cc:SourceCode'],
};
const coverSummaryProjection = {
  media: uuid,
  width: 40_000_000,
  height: 40_000_000,
  placeholder: { thumbhash: escaped(44), color: '#ffffff' },
  variants: Array.from({ length: 12 }, (_, index) => ({ format: index % 2 ? 'webp' : 'avif', width: 2560 })),
  focalPoint: { x: 1, y: 1 },
  credit: coverCreditProjection,
};
const coverReferencePoint = statement(
  coverReferenceRead,
  { partition: 15, routes: [15], media_ids: [uuid] },
  { candidateKeys: 1, nativeRows: 15, nativePoints: 1, emptySeeks: 1 },
  jsonBytes({
    mediaId: uuid,
    containerId: uuid,
    sha256: 'f'.repeat(64),
    sourceUrl: escaped(2048),
    width: 40_000_000,
    height: 40_000_000,
    thumbhash: escaped(44),
    color: '#ffffff',
    variantsJson: JSON.stringify(Array.from({ length: 12 }, (_, index) => ({ format: index % 2 ? 'webp' : 'avif', width: 2560 }))),
    focalX: 1,
    focalY: 1,
  }) + COVER_CREDIT_JSON_MAX_BYTES + COVER_PROVENANCE_JSON_MAX_BYTES,
  1,
).total;
const coverMediaProjection = {
  media_id: uuid,
  container_id: uuid,
  claimed_item_id: uuid,
  uploader_id: uuid,
  purpose: 'cover',
  state: 'available',
  claimed_at: escaped(64),
  key: `m/${uuid}/webp-2560`,
  sha256: 'f'.repeat(64),
  media_type: 'image/webp',
  actual_byte_count: '9'.repeat(19),
  erased: false,
  collection_pending: false,
  taken_down: false,
  security_revision: '9'.repeat(19),
  provenance: null,
  width: 40_000_000,
  height: 40_000_000,
  thumbhash: escaped(44),
  average_color: '#ffffff',
  focal_x: 1,
  focal_y: 1,
  credit: null,
  variant_key: `m/${uuid}/webp-2560`,
  variant_sha256: 'f'.repeat(64),
  variant_media_type: 'image/webp',
  variant_byte_count: '9'.repeat(19),
  variant_format: 'webp',
  variant_width: 2560,
  variant_height: 2147483647,
};
const coverDownloadPoint = statement(
  downloadMediaRead,
  { route: 15, media_id: uuid, format: 'webp', width: 2560 },
  { candidateKeys: 2, nativeRows: 6, nativePoints: 2, emptySeeks: 2 },
  jsonBytes(coverMediaProjection) + COVER_CREDIT_JSON_MAX_BYTES + COVER_PROVENANCE_JSON_MAX_BYTES,
  1,
).total;
const coverFencePoint = statement(
  sourceFencesRead,
  { partition: 15, tuples: [{ route: 15, source: 'source', external_id: escaped(1024), field_group: 'cover' }] },
  { candidateKeys: 1, nativeRows: 1, nativePoints: 1, emptySeeks: 1 },
  jsonBytes({ route: 15, source: escaped(32), external_id: escaped(1024), field_group: 'cover', takenDown: true,
    securityRevision: '9'.repeat(19), takenDownAt: escaped(64), takedownId: uuid }),
  1,
).total;
const coverSubjectExistsPoint = statement(
  subjectExistsRead,
  { route: 15, subject_id: uuid },
  { candidateKeys: 1, nativeRows: 1, nativePoints: 1, emptySeeks: 1 },
  jsonBytes({ found: 1 }),
  1,
).total;
const coverPartitionPoint = statement(
  partitionRead,
  { partition_no: 15 },
  { candidateKeys: 1, nativeRows: 1, nativePoints: 1, emptySeeks: 1 },
  jsonBytes({ partitionNo: 65535, node: escaped(256), writeState: 'fenced', movedTo: uuid, epoch: 2147483647,
    position: '9'.repeat(19) }),
  1,
).total;
const coverReadBound = sumBounds(
  repeatBound(coverReferencePoint, 2),
  repeatBound(coverDownloadPoint, 3),
  repeatBound(coverFencePoint, 2),
  coverSubjectExistsPoint,
  repeatBound(coverPartitionPoint, 4),
  repeatBound(mediaSnapshotControls, 4),
);

function directoryPageBound(limit: number): Bound {
  const input = {
    route: 15,
    curator_account_id: uuid,
    after_updated_at: escaped(27),
    after_id: uuid,
    has_cursor: true,
    limit: limit + 1,
  };
  const shape = {
    candidateKeys: 2 * input.limit,
    nativeRows: 9 * input.limit + 3,
    nativePoints: 2,
    emptySeeks: 2,
  };
  const curator = statement(curatorPage, input, shape, directoryBytes, input.limit).total;
  const publicList = statement(
    publicPage,
    { ...input, policy_visibility: 'public' },
    shape,
    directoryBytes,
    input.limit,
  ).total;
  const partition = statement(
    partitionRead,
    { partition_no: 15 },
    { candidateKeys: 1, nativeRows: 1, nativePoints: 1, emptySeeks: 1 },
    jsonBytes({ partitionNo: 65535, node: escaped(256), writeState: 'fenced', movedTo: uuid, epoch: 2147483647,
      position: '9'.repeat(19) }),
    1,
  ).total;
  return sumBounds(maximumBound(curator, publicList), repeatBound(partition, 2), pageControls);
}

const curatorSummaryProjection = { id: uuid, handle: escaped(64), displayName: escaped(4096) };
const builtinDescriptorProjection = {
  id: uuid,
  curatorAccountId: uuid,
  membershipKind: 'dynamic',
  builtinKind: 'state',
  builtin: { kind: 'state', profileId: uuid, stateSetId: uuid, stateId: uuid },
  builtinLabels: { label: '' },
  visibility: 'private',
  title: null,
  description: null,
  revision: 2147483647,
  presentationKind: '',
  presentationKindSource: 'mixed',
  cover: null,
  coverSource: 'none',
};
const builtinDescriptorBytes = jsonBytes(builtinDescriptorProjection) + 2 * releaseStringBytes;
const curatedDirectoryItemBaseBytes = jsonBytes({
  ...collectionProjection,
  description: escaped(2000),
  presentationKindSource: 'owner',
  cover: coverSummaryProjection,
  coverSource: 'pending',
});
function propertyContribution(key: string, value: unknown): number {
  return jsonBytes({ [key]: value }) - 1;
}

/** The signed cursor is a bounded base64url body and a fixed SHA-256 MAC. */
export function collectionCursorTokenProjection(after: readonly (string | number)[]): string {
  const payload = JSON.stringify({ e: 2147483647, a: after, t: Number.MAX_SAFE_INTEGER });
  const body = Buffer.concat([Buffer.from([1, 255]), Buffer.from(payload, 'utf8')]).toString('base64url');
  return `${body}.${'A'.repeat(43)}`;
}

function directoryItemBytes(input: {
  mountedFullView: boolean;
  ownerManagement: boolean;
  preview: boolean;
  publicOnly: boolean;
}): number {
  const curatorBytes = input.mountedFullView ? propertyContribution('curator', curatorSummaryProjection) : 0;
  const previewBytes = input.preview
    ? propertyContribution('previewMembers', []) +
      propertyContribution('previewStatus', 'pending') +
      3 * subjectSummaryMemberBytes +
      2
    : 0;
  const curatedBytes =
    curatedDirectoryItemBaseBytes +
    responseBodyStringBytes +
    (input.ownerManagement ? propertyContribution('allowedVisibilityActions', ['private', 'unlisted']) : 0) +
    curatorBytes +
    previewBytes;
  const builtinBytes =
    builtinDescriptorBytes +
    (input.ownerManagement ? propertyContribution('allowedVisibilityActions', []) : 0) +
    curatorBytes +
    previewBytes;
  return input.publicOnly ? curatedBytes : Math.max(curatedBytes, builtinBytes);
}

function directoryResponseBytes(input: {
  limit: number;
  publicOnly: boolean;
  ownerManagement: boolean;
  mountedFullView: boolean;
  preview: boolean;
}): number {
  const token = collectionCursorTokenProjection([escaped(27), uuid]);
  const shell = {
    collections: [],
    next: token,
    ...(input.ownerManagement ? { ownerManagement: 'owner', ownerAccountId: uuid } : {}),
  };
  const item = directoryItemBytes(input);
  return jsonBytes(shell) + input.limit * item + Math.max(0, input.limit - 1);
}

function collectionPreviewReadBound(parents: number): Bound {
  let selected = zeroOperationBound();
  for (let count = 1; count <= parents; count++) {
    const plan = collectionPreviewStatements(
      {
        routes: Array.from({ length: count }, () => 15),
        collection_ids: Array.from({ length: count }, (_, index) => `${String(index).padStart(8, '0')}-ffff-ffff-ffff-ffffffffffff`),
        source_generations: Array.from({ length: count }, () => '9'.repeat(19)),
        revisions: Array.from({ length: count }, () => 2147483647),
      },
      Math.floor(100 / count),
    );
    selected = maximumBound(selected, plan.total);
  }
  return sumBounds(selected, repeatBound(snapshotControls, 2));
}

function builtinDiscoveryBound(limit: number): Bound {
  const selected = limit + 1;
  const route = 15;
  const accountId = uuid;
  const nativePresence = rawStatement(
    BUILTIN_NATIVE_PRESENCE_SQL,
    [route, accountId],
    { candidateKeys: 4, nativeRows: 4, nativePoints: 4, emptySeeks: 4 },
    jsonBytes({ entry: true, session: true, copy: true, label: true }),
  );
  const frontier = rawStatement(
    OWNER_INDEX_FRONTIER_READ_SQL,
    [route, accountId],
    { candidateKeys: 1, nativeRows: 1, nativePoints: 1, emptySeeks: 1 },
    jsonBytes({ phase: 'entry', subject: uuid, fact: uuid }),
  );
  const nextPin = rawStatement(
    OWNER_INDEX_NEXT_PIN_SQL,
    [route, accountId],
    { candidateKeys: 1, nativeRows: 1, nativePoints: 1, emptySeeks: 1 },
    jsonBytes({ releaseDigest: 'f'.repeat(64), profileId: uuid, stateSetId: uuid }),
  );
  const successors = rawStatement(
    BUILTIN_STATE_SUCCESSORS_SQL,
    [route, accountId, uuid, selected],
    { candidateKeys: selected, nativeRows: 3 * selected, nativePoints: 2 * selected, emptySeeks: selected },
    jsonBytes({ profileId: uuid, stateSetId: uuid, stateId: uuid }),
    selected,
  );
  const labels = rawStatement(
    BUILTIN_STATE_LABELS_SQL,
    [route, accountId, uuid],
    { candidateKeys: 1, nativeRows: 1, nativePoints: 1, emptySeeks: 1 },
    jsonBytes({ labels: escaped(RELEASE_LIMITS.bytes) }),
  );
  const stored = rawStatement(
    BUILTIN_STORED_COLLECTION_SQL,
    [route, uuid],
    { candidateKeys: 1, nativeRows: 1, nativePoints: 1, emptySeeks: 1 },
    jsonBytes({
      kind: 'state', owner: accountId, membership: 'dynamic', state: 'active', visibility: 'private',
      title: escaped(200), description: escaped(2000), revision: -2147483648,
      presentationKind: null, coverMediaId: null,
    }),
  );
  // Admission, presence, optional owner-index fences and the successor query are
  // independent statements. Every selected descriptor receives its stored-row
  // point; state descriptors also read their released labels point.
  return sumBounds(
    accountPoint,
    nativePresence,
    frontier,
    nextPin,
    successors,
    repeatBound(stored, selected),
    repeatBound(labels, selected),
    pageControls,
  );
}

const subjectSummaryProjection = {
    id: uuid,
    type: '',
    // The selected definitions release is at most 4 MiB in total; the union of type
    // identifiers and display labels cannot exceed its canonical byte ceiling.
    types: [''],
    label: { value: '', language: '' },
    creativeWork: true,
    cover: coverSummaryProjection,
  };
const emptySubjectSummaryBytes = jsonBytes(subjectSummaryProjection);
export const collectionSubjectSummaryProjectionBytes =
  emptySubjectSummaryBytes + 12 * releaseStringLength + 12 * responseBodyStringLength;
const subjectSummaryMemberBytes =
  jsonBytes({ subjectId: uuid, subject: subjectSummaryProjection }) +
  collectionSubjectSummaryProjectionBytes -
  emptySubjectSummaryBytes;

function subjectSummaryBound(keys: number): Bound {
  const sqlBytes =
    Buffer.byteLength(subjectSummaryStatesRead.sql) +
    Buffer.byteLength(subjectSummaryRead.sql) +
    Buffer.byteLength(representativeEditionsRead.sql) +
    Buffer.byteLength(coverReferenceRead.sql) +
    Buffer.byteLength(sourceFencesRead.sql);
  const inputBytesPerKey =
    jsonBytes({ partition_no: 65535, routes: [15], subject_ids: [uuid] }) +
    jsonBytes({ partition_no: 65535, context_id: uuid, subjects: [{ route: 15, id: uuid, image: uuid, original: uuid }] }) +
    12 * jsonBytes({ id: uuid, slot_id: uuid, ordinal: 2147483647 }) +
    jsonBytes({ partition: 65535, routes: [15], media_ids: [uuid] }) +
    jsonBytes({ partition: 65535, tuples: [{ route: 15, source: escaped(32), external_id: escaped(1024), field_group: 'cover' }] });
  const data = declareBound({
    candidateKeys: keys,
    // One indexed summary point plus the bounded representative/selected edition and source tuple probes.
    nativeRows: 32 * keys,
    identityMetadataRows: 0,
    nativePoints: 12 * keys,
    witnessKeys: 0,
    statements: 6 * keys + 5,
    // The result cover is capped by Content's imported credit/provenance envelope;
    // no anonymous 2 KiB allowance is substituted for its actual nested rows.
    bytes: keys * (
      collectionSubjectSummaryProjectionBytes +
      COVER_CREDIT_JSON_MAX_BYTES +
      COVER_PROVENANCE_JSON_MAX_BYTES +
      sqlBytes * 6 +
      inputBytesPerKey
    ),
    emptySeeks: 6 * keys,
    engineRequests: 0,
  });
  // Three semantic plan attempts are fixed by readSummaryBatch. The other three
  // snapshots are the original and two currentness observations in the wrapper.
  return sumBounds(repeatBound(data, 3), repeatBound(snapshotControls, 6));
}

/** Complete request-frozen composition for curator and public Account Collection directories. */
export function collectionDirectoryOperationPlan(input: {
  limit: number;
  publicOnly: boolean;
  ownerManagement: boolean;
  mountedFullView: boolean;
  preview: boolean;
}): CollectionReadOperationPlan {
  const zero = zeroOperationBound();
  const pageLimit = Math.min(input.limit, 20);
  const previewBound = input.preview && !input.publicOnly && pageLimit > 0
    ? collectionPreviewReadBound(pageLimit)
    : null;
  const collectionObservationBound = sumBounds(
    collectionDirectoryRowPlan({ route: 15, id: accountId }).total,
    repeatBound(accountPoint, 2),
    pageControls,
  );
  const observationsPerResult = input.preview ? 3 : 1;
  const terms = {
    directoryAdmission: sumBounds(repeatBound(publicViewPoint, 2), repeatBound(accountPoint, 2)),
    builtinDiscovery: !input.publicOnly ? builtinDiscoveryBound(input.limit) : zero,
    directoryPage: directoryPageBound(input.limit),
    // Terminal parent checks always run; preview adds its before/after parent checks.
    collectionObservations: repeatBound(collectionObservationBound, input.limit * observationsPerResult),
    // Presentation can reload a parent when it has a cover or owner-management fields.
    presentationCurrentness: repeatBound(collectionObservationBound, input.limit),
    // The Access update formula remains owned by Access; it adds no Library SQL point.
    ownerManagement: zero,
    fullViewAccount: input.mountedFullView ? publicAccountPoint : zero,
    coverPresentation: repeatBound(coverReadBound, input.limit),
    previewSql: previewBound ?? zero,
    previewSubjects: previewBound !== null ? subjectSummaryBound(100) : zero,
    responseSerialization: declareBound({
      candidateKeys: 0,
      nativeRows: 0,
      identityMetadataRows: 0,
      nativePoints: 0,
      witnessKeys: 0,
      statements: 0,
      bytes: directoryResponseBytes(input),
      emptySeeks: 0,
      engineRequests: 0,
    }),
  };
  return composeCollectionReadOperation('collection.directory', terms);
}

/** The preview path is also used by trusted readers without an HTTP presentation callback. */
export function collectionPreviewOperationPlan(limit: number): CollectionReadOperationPlan {
  return collectionDirectoryOperationPlan({
    limit,
    publicOnly: false,
    ownerManagement: false,
    mountedFullView: false,
    preview: true,
  });
}

/** The mounted Subject page can reveal at most one current curator summary per considered pair. */
export function subjectCollectionPresentationBound(limit: number, fullView: boolean): Bound {
  return fullView ? repeatBound(publicAccountPoint, limit) : zeroOperationBound();
}

export function collectionCoverPresentationBound(limit: number): Bound {
  return repeatBound(coverReadBound, limit);
}

export function publicCollectionViewBound(keys: number): Bound {
  return repeatBound(publicViewPoint, keys);
}

export function privateCollectionAccountBound(keys: number): Bound {
  return repeatBound(accountPoint, keys);
}

export function collectionSubjectSummaryBound(keys: number): Bound {
  return subjectSummaryBound(keys);
}
