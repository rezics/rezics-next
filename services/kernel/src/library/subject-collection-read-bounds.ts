import { declareBound, repeatBound, sumBounds, type Bound } from '@rezics/bounds';
import partitionRead from '../partition/read.sql';
import subjectReference from '../semantic/read-subject-reference.sql';
import identityOwners from '../semantic/identity-epoch-read-owners.sql';
import identitySources from '../semantic/identity-epoch-read-sources.sql';
import identityPending from '../semantic/identity-epoch-read-pending.sql';
import identityCurrent from '../semantic/identity-terminal-closure-current.sql';
import { partitionOf, routeOf } from '../route/route.ts';
import {
  collectionDirectoryRowPlan,
  collectionCursorTokenProjection,
  composeCollectionReadOperation,
  publicCollectionViewBound,
  subjectCollectionPresentationBound,
  type CollectionReadOperationPlan,
} from './collection-directory-bounds.ts';
import page from './listing-page.sql';
import counts from './listing-counts.sql';

// listing.ts has already admitted a numeric helper limit; PostgreSQL's generic
// LIMIT bind also accepts string/bigint, which are not this caller's contract.
type PageInput = Omit<Parameters<typeof page.run>[1], 'limit'> & { limit: number };

/** A native pair-seek leaf; Subject admission and FULL disclosure are enclosing work. */
export type SubjectCollectionPairPlan = Readonly<{
  kind: 'subject.collections.pairs';
  input: Readonly<PageInput>;
  total: Bound;
}>;

// UUIDs are 36 characters, route/multiplicity are PostgreSQL int4, and the
// timestamp projection allows PostgreSQL's full range, zone and BC suffix.
// Escaped JSON also bounds the positional SQL response payload.
const projectedPairBytes =
  Buffer.byteLength(
    JSON.stringify({
      collectionId: 'f'.repeat(36),
      collectionRoute: -2147483648,
      multiplicity: -2147483648,
      updatedAt: '\0'.repeat(64),
      transactionId: 'f'.repeat(36),
    }),
  ) + 1;

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

/** Keep the caller's original seek and sentinel, independently of rows returned. */
export function subjectCollectionPairPlan(input: PageInput): SubjectCollectionPairPlan {
  const original = Object.freeze({ ...input });
  return Object.freeze({
    kind: 'subject.collections.pairs',
    input: original,
    total: sumBounds(
      declareBound({
        candidateKeys: input.limit,
        // The subject-leading positive-pair index feeds one LIMIT node.
        nativeRows: 2 * input.limit,
        identityMetadataRows: 0,
        nativePoints: 1,
        witnessKeys: 0,
        statements: 1,
        bytes: 0,
        emptySeeks: 1,
        // This leaf dispatches only listing-page.sql, never Search.
        engineRequests: 0,
      }),
      bytes(Buffer.byteLength(page.sql) + Buffer.byteLength(JSON.stringify(original)) + 2),
      repeatBound(bytes(projectedPairBytes), input.limit),
    ),
  });
}

/** Dispatch exactly the frozen operands on the connection owned by listing.ts. */
export function executeSubjectCollectionPairs(
  client: Parameters<typeof page.run>[0],
  plan: SubjectCollectionPairPlan,
): ReturnType<typeof page.run> {
  return page.run(client, plan.input);
}

/** Maintained public-pair counts are independent observations, never a visible-row recomputation. */
export function subjectCollectionCountPlan(input: Parameters<typeof counts.run>[1]) {
  const subjects = [...input.subject_ids];
  Object.freeze(subjects);
  const original = Object.freeze({ ...input, subject_ids: subjects });
  const keys = original.subject_ids.length;
  const total = sumBounds(
    declareBound({
      candidateKeys: keys,
      // unnest, full-key point, LIMIT and lateral join per requested Subject.
      nativeRows: 4 * keys,
      identityMetadataRows: 0,
      nativePoints: keys,
      witnessKeys: 0,
      statements: 1,
      bytes: 0,
      emptySeeks: keys,
      engineRequests: 0,
    }),
    bytes(Buffer.byteLength(counts.sql) + Buffer.byteLength(JSON.stringify(original)) + 2),
    repeatBound(
      bytes(
        Buffer.byteLength(
          JSON.stringify({
            subjectId: 'f'.repeat(36),
            publicCollectionCount: -2147483648,
          }),
        ) + 1,
      ),
      keys,
    ),
  );
  return Object.freeze({
    input: original,
    total,
    run: (client: Parameters<typeof counts.run>[0]) => counts.run(client, original),
  });
}

const uuid = 'f'.repeat(36);
const escaped = (size: number) => '\0'.repeat(size);
const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

function partitionPoint(partition: number): Bound {
  const input = { partition_no: partition };
  return sumBounds(
    declareBound({
      candidateKeys: 1,
      nativeRows: 1,
      identityMetadataRows: 0,
      nativePoints: 1,
      witnessKeys: 0,
      statements: 1,
      bytes: 0,
      emptySeeks: 1,
      engineRequests: 0,
    }),
    bytes(Buffer.byteLength(partitionRead.sql) + jsonBytes(input) + jsonBytes({
      partitionNo: 65535,
      node: escaped(256),
      writeState: 'fenced',
      movedTo: uuid,
      epoch: 2147483647,
      position: '9'.repeat(19),
    }) + 1),
  );
}

function bytes(amount: number): Bound {
  return declareBound({
    candidateKeys: 0,
    nativeRows: 0,
    identityMetadataRows: 0,
    nativePoints: 0,
    witnessKeys: 0,
    statements: 0,
    bytes: amount,
    emptySeeks: 0,
    engineRequests: 0,
  });
}

function queryBytes(sql: string, input: unknown, projection: unknown, rows = 1): number {
  return Buffer.byteLength(sql) + jsonBytes(input) + 2 + rows * (jsonBytes(projection) + 1);
}

const identityReadControls = declareBound({
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
const subjectReadControls = declareBound({
  candidateKeys: 0,
  nativeRows: 0,
  identityMetadataRows: 0,
  nativePoints: 0,
  witnessKeys: 0,
  statements: 3,
  bytes:
    Buffer.byteLength('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY') +
    Buffer.byteLength('COMMIT') +
    Buffer.byteLength('ROLLBACK'),
  emptySeeks: 0,
  engineRequests: 0,
});

/** One mapping follows the current reader's two observations and its actual SQL owners. */
function subjectMappingBound(): Bound {
  const home = 65535;
  const sourceOwner = { partition_no: home, epoch: 2147483647, position: '9'.repeat(19), write_state: 'active' };
  const sourceRow = {
    subject_id: uuid, original: uuid, control_partition: home, control_group: uuid, epoch: '9'.repeat(19),
    owner_epoch: 2147483647, dirty_revision: '9'.repeat(19), captured_revision: '9'.repeat(19), terminal: uuid,
    closure_state: 'active', closure_immediate: uuid, current_target: uuid, source_revision: '9'.repeat(19),
    closure_enrollment: uuid, closure_generation: uuid, closure_incarnation: uuid,
    closure_install_transaction: uuid, closure_registration_transaction: uuid, closure_export_transaction: uuid,
  };
  const pendingRow = { partition_no: home, terminal: uuid, pending_job: uuid, pending_epoch: '9'.repeat(19) };
  const currentRow = {
    partition_no: home, terminal: uuid, requested_original: uuid, redirected: true, owner_epoch: 2147483647,
    closure_state: 'open', directory_state: 'installed', directory_enrollment: uuid, generation: uuid,
    closure_incarnation: uuid, directory_incarnation: uuid, directory_install: uuid,
    registration_transaction: uuid, directory_export: uuid, directory_owner: 2147483647,
    directory_revision: '9'.repeat(19), published_epoch: '9'.repeat(19),
  };
  const dataBytes =
    4 * queryBytes(identityOwners.sql, [[home]], sourceOwner) +
    2 * queryBytes(identitySources.sql, [[uuid], [routeOf(uuid)]], sourceRow) +
    2 * queryBytes(identityPending.sql, [[home], [uuid]], pendingRow) +
    2 * queryBytes(identityCurrent.sql, [[home], [uuid], [uuid]], currentRow);
  const data = declareBound({
    candidateKeys: 2,
    nativeRows: 16,
    identityMetadataRows: 0,
    nativePoints: 8,
    witnessKeys: 0,
    statements: 10,
    bytes: dataBytes,
    emptySeeks: 8,
    engineRequests: 0,
  });
  // Two collection passes each open a source and control snapshot.
  return sumBounds(data, repeatBound(identityReadControls, 4));
}

/** One reference includes its exact SQL, input and maximum returned key projection. */
function subjectReferenceBound(): Bound {
  const input = { route: 65535, subject_id: uuid };
  const data = sumBounds(
    declareBound({
      candidateKeys: 1,
      nativeRows: 2,
      identityMetadataRows: 0,
      nativePoints: 2,
      witnessKeys: 0,
      statements: 2,
      bytes: 0,
      emptySeeks: 2,
      engineRequests: 0,
    }),
    bytes(
      Buffer.byteLength(partitionRead.sql) +
        jsonBytes({ partition_no: 65535 }) +
        jsonBytes({
          partitionNo: 65535,
          node: escaped(256),
          writeState: 'fenced',
          movedTo: uuid,
          epoch: 2147483647,
          position: '9'.repeat(19),
        }) +
        Buffer.byteLength(subjectReference.sql) +
        jsonBytes(input) +
        jsonBytes({ id: uuid, redirect: uuid }) +
        2,
    ),
  );
  return sumBounds(data, identityReadControls);
}

/** Complete Subject discovery operation, including the second disclosure/currentness pass. */
export function subjectCollectionOperationPlan(input: {
  subjectId: string;
  limit: number;
  mountedFullView: boolean;
}): CollectionReadOperationPlan {
  const route = routeOf(input.subjectId)!;
  const pageLimit = input.limit + 1;
  const pair = subjectCollectionPairPlan({
    route,
    subject_id: input.subjectId,
    after: '00000000-0000-0000-0000-000000000000',
    limit: pageLimit,
  });
  const count = subjectCollectionCountPlan({
    partition_no: partitionOf(route),
    subject_ids: [input.subjectId],
  });
  const collectionRow = collectionDirectoryRowPlan({ route: 15, id: uuid }).total;
  const curatorProjection = { id: uuid, handle: escaped(64), displayName: escaped(4096) };
  const responseItemBytes = jsonBytes({
    id: uuid,
    curatorAccountId: uuid,
    title: escaped(200),
    multiplicity: 2147483647,
    ...(input.mountedFullView ? { curator: curatorProjection } : {}),
  });
  const responseShell = {
    collections: [],
    count: { value: 2147483647, exact: true },
    next: collectionCursorTokenProjection([uuid]),
  };
  const terms = {
    subjectResolution: sumBounds(
      repeatBound(subjectMappingBound(), 2),
      repeatBound(subjectReferenceBound(), 4),
    ),
    subjectCount: count.total,
    subjectPartition: repeatBound(partitionPoint(partitionOf(route)), 2),
    subjectPairPage: pair.total,
    subjectCollectionPage: sumBounds(
      repeatBound(collectionRow, input.limit),
      publicCollectionViewBound(input.limit),
      subjectReadControls,
    ),
    subjectCollectionTerminal: sumBounds(
      repeatBound(collectionRow, input.limit),
      publicCollectionViewBound(input.limit),
      subjectReadControls,
    ),
    fullViewAccount: subjectCollectionPresentationBound(input.limit, input.mountedFullView),
    responseSerialization: bytes(
      jsonBytes(responseShell) + input.limit * responseItemBytes + Math.max(0, input.limit - 1),
    ),
  };
  return composeCollectionReadOperation('subject.collections', terms);
}
