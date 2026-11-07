/** Native SQL, parameter order and finite projections for Library's observations. */

import type { Pool, PoolClient } from 'pg';
import { declareBound, repeatBound, sumBounds, type Bound } from '@rezics/bounds';
import { RELEASE_LIMITS } from '@rezics/definitions';
import { statementBytes } from '../../database/statement-bytes.ts';
import { partitionOf, routeOf } from '../../route/route.ts';
import type { WorkDimensions } from '../../library/contract/work-dimensions.ts';
import type {
  LibrarySemanticMapping,
  LibrarySemanticScopeKey,
  LibrarySemanticScopeObservation,
  LibrarySemanticScopeRegistration,
  LibrarySemanticScopeRevalidation,
  LibrarySemanticSummaryObservation,
} from '../../library/contract/semantic-observation.ts';
import type { IdentityMapping } from '../contract/identity-values.ts';
import type { IdentityScopeKey, IdentityScopeObservation, IdentityScopeWork } from '../identity-scope-types.ts';
import { createIdentityScopedObservations, identityScopeAddress } from '../identity-scoped-observations.ts';
import { readIdentityMapping, readIdentityMappings } from '../identity-adapters/read.ts';
import { readSubjectReference } from '../references.ts';
import { SubjectRedirectError } from '../contract/subject-errors.ts';
import { readItemIdentityVersion } from '../item-identity.ts';
import { readItemTypes } from '../subject.ts';
import { readSubjectSummaryObservation, type SummaryReaderDependencies } from '../summaries.ts';
import mappingOwners from '../identity-epoch-read-owners.sql';
import mappingSources from '../identity-epoch-read-sources.sql';
import mappingPending from '../identity-epoch-read-pending.sql';
import mappingCurrent from '../identity-terminal-closure-current.sql';
import reference from '../read-subject-reference.sql';
import representatives from '../summaries-representative-editions.sql';
import summaries from '../summaries-read.sql';
import releaseActive from '../definitions-active.sql';
import releaseExists from '../definitions-exists.sql';
import release from '../definitions-read.sql';
import partitions from '../../partition/read-batch.sql';
import partitionRead from '../../partition/read.sql';
import coverReferences from '../../content/read-cover-reference.sql';
import sourceFences from '../../content/read-source-fences.sql';
import commitCapture from '../identity-scoped-commit-capture.sql';
import identityVersion from '../read-item-identity-version.sql';
import itemTypes from '../read-item-types.sql';
import type { LibrarySemanticScopeResult } from '../../library/contract/semantic-observation.ts';

export type SemanticObservationNativeAdapter = Readonly<{
  canonical: Readonly<{
    mappingWork(originals: readonly string[]): WorkDimensions;
    scopeCommitWork(input: {
      route: number;
      collectionId: string;
      sourceFence: string;
      observation: LibrarySemanticScopeObservation;
    }): WorkDimensions;
    readMappings(pool: Pool, originals: readonly string[]): Promise<readonly LibrarySemanticMapping[]>;
    registerScope(pool: Pool, input: LibrarySemanticScopeRegistration): Promise<LibrarySemanticScopeResult>;
    revalidateScope(pool: Pool, input: LibrarySemanticScopeRevalidation): Promise<LibrarySemanticScopeResult>;
    commitScopeCapture(client: Pick<PoolClient, 'query'>, input: {
      route: number;
      collectionId: string;
      sourceFence: string;
      observation: LibrarySemanticScopeObservation;
    }): Promise<void>;
  }>;
  follow: Readonly<{
    mappingWork(originals: readonly string[]): WorkDimensions;
    subjectReferenceWork(subjectId: string): WorkDimensions;
    subjectSummaryWork(subjectIds: readonly string[]): WorkDimensions;
    subjectSummaryCurrentWork(subjectIds: readonly string[]): WorkDimensions;
    readMapping(pool: Pool, original: string): Promise<LibrarySemanticMapping>;
    readMappings(pool: Pool, originals: readonly string[]): Promise<readonly LibrarySemanticMapping[]>;
    readSubjectReference(input: {
      pool: Pool;
      subjectId: string;
      check(client: Pick<PoolClient, 'query'>): Promise<boolean>;
    }): Promise<Readonly<{ state: 'present' } | { state: 'absent' } | { state: 'redirect'; from: string; to: string }>>;
    observeSubjects(input: {
      context: SummaryReaderDependencies;
      ids: readonly string[];
    }): Promise<Omit<LibrarySemanticSummaryObservation, 'current'> & Readonly<{ current(): Promise<boolean> }>>;
  }>;
  shelf: Readonly<{
    identityVersionWork(subjectId: string): WorkDimensions;
    itemTypesWork(subjectIds: readonly string[], maxTypeBytes?: number): WorkDimensions;
    readIdentityVersion(client: Pick<PoolClient, 'query'>, subjectId: string): Promise<{
      revision: number;
      transactionId: string;
      redirect: string | null;
    } | null>;
    readItemTypes(client: Pick<PoolClient, 'query'>, subjectIds: readonly string[]): Promise<ReadonlyMap<string, string>>;
  }>;
}>;

const uuid = 'ffffffff-ffff-8fff-bfff-ffffffffffff';
const int8 = '-9223372036854775808';
const xid = 'x'.repeat(32);
const timestamp = 'x'.repeat(64);
const maxImportedSourceBytes = 65_536;
const size = (value: unknown) =>
  Buffer.byteLength(JSON.stringify(value, (_key, entry) => (typeof entry === 'bigint' ? entry.toString() : entry)));
const zero = (): Bound =>
  declareBound({
    candidateKeys: 0,
    nativeRows: 0,
    identityMetadataRows: 0,
    emptySeeks: 0,
    nativePoints: 0,
    witnessKeys: 0,
    statements: 0,
    bytes: 0,
    engineRequests: 0,
  });
const dimensions = (bound: Bound): WorkDimensions =>
  Object.freeze({
    candidateKeys: bound.candidateKeys,
    nativeRows: bound.nativeRows,
    identityMetadataRows: bound.identityMetadataRows,
    emptySeeks: bound.emptySeeks,
    nativePoints: bound.nativePoints,
    witnessKeys: bound.witnessKeys,
    statements: bound.statements,
    bytes: bound.bytes,
  });
const zeroWork = (): WorkDimensions => dimensions(zero());
const jsonBytes = (value: unknown) => size(value);
const maxRowBytes = (row: unknown, count = 1) => (size(row) + 1) * count;

type SqlShape = Readonly<{
  keys: number;
  rows: number;
  points: number;
  seeks: number;
  output: number;
  width: number;
  metadata?: number;
}>;
function sqlWork(sql: string, operands: unknown, shape: SqlShape): Bound {
  return declareBound({
    candidateKeys: shape.keys,
    nativeRows: shape.rows,
    identityMetadataRows: shape.metadata ?? 0,
    emptySeeks: shape.seeks,
    nativePoints: shape.points,
    witnessKeys: 0,
    statements: 1,
    bytes: Buffer.byteLength(sql) + size(operands) + 2 + shape.output * (shape.width + 1),
    engineRequests: 0,
  });
}
function operandsOf(query: { params: readonly string[] }, values: Record<string, unknown>): unknown[] {
  return query.params.map((name) => values[name]);
}
function mappingIdentityWork(subjectId: string, follow: boolean): WorkDimensions {
  const route = routeOf(subjectId);
  if (route === null) throw new TypeError('Semantic identity observations require routed originals');
  const ownerWidth = size({ partition_no: 4095, epoch: -2147483648, position: int8, write_state: 'draining' });
  const sourceWidth = size({
    subject_id: uuid,
    route: 65535,
    original: uuid,
    terminal: uuid,
    epoch: int8,
    origin: 'published',
    recorded_transaction_id: uuid,
    control_partition: 4095,
    control_group: uuid,
    source_revision: int8,
    owner_epoch: -2147483648,
    erasure_key: int8,
    closure_state: 'withdrawn',
    closure_enrollment: uuid,
    closure_generation: uuid,
    closure_incarnation: uuid,
    closure_immediate: uuid,
    closure_export_transaction: uuid,
    closure_hold_transaction: uuid,
    closure_hold_xid: xid,
    closure_registration_transaction: uuid,
    closure_install_transaction: uuid,
    closure_install_xid: xid,
    closure_ack_transaction: uuid,
    closure_ack_xid: xid,
    closure_source_reservation: uuid,
    closure_claim: uuid,
    closure_withdraw_transaction: uuid,
    closure_withdraw_xid: xid,
    closure_successor_ticket: uuid,
    closure_successor_original: uuid,
    closure_ticket_reservation: uuid,
    closure_mutation_xid: xid,
    closure_cancelled_successor: true,
    dirty_revision: int8,
    captured_revision: int8,
    current_target: uuid,
  });
  const pendingWidth = size({ partition_no: 4095, terminal: uuid, pending_job: uuid, pending_epoch: int8 });
  const currentWidth = size({
    partition_no: 4095,
    terminal: uuid,
    published_epoch: int8,
    owner_epoch: -2147483648,
    generation: int8,
    closure_state: 'receiving',
    closure_incarnation: uuid,
    requested_original: uuid,
    directory_state: 'receiving',
    directory_enrollment: int8,
    directory_incarnation: uuid,
    directory_install: uuid,
    directory_export: uuid,
    directory_revision: int8,
    directory_owner: -2147483648,
    registration_transaction: uuid,
    redirected: true,
  });
  const ownersValues = [[4095]];
  const sourceValues = [[subjectId], [route]];
  const pendingValues = [[4095], [uuid]];
  const currentValues = [[4095], [uuid], [subjectId]];
  const owner = sqlWork(mappingOwners.sql, ownersValues, {
    keys: follow ? 1 : 0,
    rows: follow ? 4 : 2,
    points: 1,
    seeks: 1,
    output: 1,
    width: ownerWidth,
    metadata: follow ? 1 : 0,
  });
  const sources = sqlWork(mappingSources.sql, sourceValues, {
    keys: follow ? 1 : 0,
    rows: follow ? 16 : 8,
    points: 4,
    seeks: follow ? 4 : 1,
    output: 1,
    width: sourceWidth,
    metadata: follow ? 4 : 0,
  });
  const pending = sqlWork(mappingPending.sql, pendingValues, {
    keys: follow ? 1 : 0,
    rows: follow ? 4 : 2,
    points: 1,
    seeks: follow ? 1 : 1,
    output: 1,
    width: pendingWidth,
    metadata: follow ? 1 : 0,
  });
  const current = sqlWork(mappingCurrent.sql, currentValues, {
    keys: follow ? 1 : 0,
    rows: follow ? 16 : 6,
    points: 4,
    seeks: follow ? 4 : 1,
    output: 1,
    width: currentWidth,
    metadata: follow ? 4 : 0,
  });
  // Each identity read collects source and control homes twice to establish currentness.
  const pass = follow ? [owner, sources, owner, pending, current] : [owner, sources, owner, pending, current];
  return dimensions(repeatBound(sumBounds(...pass), 2));
}

function followMappingDimensions(originals: readonly string[]): WorkDimensions {
  if (originals.length > 100) throw new RangeError('Follow identity reads accept at most 100 originals');
  if (!originals.length) return zeroWork();
  const sourceHomes = new Map<number, { ids: string[]; routes: number[] }>();
  for (const id of originals) {
    const route = routeOf(id);
    if (route === null) throw new TypeError('Follow identity reads require routed originals');
    const home = partitionOf(route);
    const group = sourceHomes.get(home) ?? { ids: [], routes: [] };
    group.ids.push(id);
    group.routes.push(route);
    sourceHomes.set(home, group);
  }
  const ownerWidth = size({ partition_no: 4095, epoch: -2147483648, position: int8, write_state: 'draining' });
  const sourceWidth = size({
    subject_id: uuid,
    route: 65535,
    original: uuid,
    terminal: uuid,
    epoch: int8,
    origin: 'published',
    recorded_transaction_id: uuid,
    control_partition: 4095,
    control_group: uuid,
    source_revision: int8,
    owner_epoch: -2147483648,
    erasure_key: int8,
    closure_state: 'withdrawn',
    closure_enrollment: uuid,
    closure_generation: uuid,
    closure_incarnation: uuid,
    closure_immediate: uuid,
    closure_export_transaction: uuid,
    closure_hold_transaction: uuid,
    closure_hold_xid: xid,
    closure_registration_transaction: uuid,
    closure_install_transaction: uuid,
    closure_install_xid: xid,
    closure_ack_transaction: uuid,
    closure_ack_xid: xid,
    closure_source_reservation: uuid,
    closure_claim: uuid,
    closure_withdraw_transaction: uuid,
    closure_withdraw_xid: xid,
    closure_successor_ticket: uuid,
    closure_successor_original: uuid,
    closure_ticket_reservation: uuid,
    closure_mutation_xid: xid,
    closure_cancelled_successor: true,
    dirty_revision: int8,
    captured_revision: int8,
    current_target: uuid,
  });
  const pendingWidth = size({ partition_no: 4095, terminal: uuid, pending_job: uuid, pending_epoch: int8 });
  const currentWidth = size({
    partition_no: 4095,
    terminal: uuid,
    published_epoch: int8,
    owner_epoch: -2147483648,
    generation: int8,
    closure_state: 'receiving',
    closure_incarnation: uuid,
    requested_original: uuid,
    directory_state: 'receiving',
    directory_enrollment: int8,
    directory_incarnation: uuid,
    directory_install: uuid,
    directory_export: uuid,
    directory_revision: int8,
    directory_owner: -2147483648,
    registration_transaction: uuid,
    redirected: true,
  });
  const sourceReads = [...sourceHomes].map(([home, group]) => {
    const ownerValues = [[home]];
    const sourceValues = [group.ids, group.routes];
    return sumBounds(
      sqlWork(mappingOwners.sql, ownerValues, {
        keys: 1,
        rows: 4,
        points: 1,
        seeks: 1,
        output: 1,
        width: ownerWidth,
        metadata: 1,
      }),
      sqlWork(mappingSources.sql, sourceValues, {
        keys: group.ids.length,
        rows: 16 * group.ids.length,
        points: 4 * group.ids.length,
        seeks: 4 * group.ids.length,
        output: group.ids.length,
        width: sourceWidth,
        metadata: 4 * group.ids.length,
      }),
    );
  });
  const controlReads = originals.map((id) => {
    const ownerValues = [[4095]];
    const pendingValues = [[4095], [uuid]];
    const currentValues = [[4095], [uuid], [id]];
    return sumBounds(
      sqlWork(mappingOwners.sql, ownerValues, {
        keys: 1,
        rows: 4,
        points: 1,
        seeks: 1,
        output: 1,
        width: ownerWidth,
        metadata: 1,
      }),
      sqlWork(mappingPending.sql, pendingValues, {
        keys: 1,
        rows: 4,
        points: 1,
        seeks: 1,
        output: 1,
        width: pendingWidth,
        metadata: 1,
      }),
      sqlWork(mappingCurrent.sql, currentValues, {
        keys: 1,
        rows: 16,
        points: 4,
        seeks: 4,
        output: 1,
        width: currentWidth,
        metadata: 4,
      }),
    );
  });
  return dimensions(sumBounds(repeatBound(sumBounds(...sourceReads), 2), repeatBound(sumBounds(...controlReads), 2)));
}

function summaryReferenceWork(subjectId: string): WorkDimensions {
  const route = routeOf(subjectId);
  if (route === null) throw new TypeError('Semantic reference observations require routed subjects');
  const partition = partitionOf(route);
  const partitionMetadata = sqlWork(
    partitionRead.sql,
    operandsOf(partitionRead, { partition_no: partition }),
    {
      keys: 1,
      rows: 2,
      points: 1,
      seeks: 1,
      output: 1,
      width:
        size({
          partitionNo: 4095,
          node: '',
          writeState: 'draining',
          movedTo: '',
          epoch: -2147483648,
          position: int8,
        }) +
        2 * 6 * (2 ** 30 - 1),
    },
  );
  return dimensions(
    sumBounds(
      partitionMetadata,
      sqlWork(reference.sql, operandsOf(reference, { route, subject_id: subjectId }), {
        keys: 1,
        rows: 6,
        points: 2,
        seeks: 2,
        output: 1,
        width: size({ id: uuid, redirect: uuid }),
      }),
    ),
  );
}

function summarySqlWork(subjectIds: readonly string[]): WorkDimensions {
  if (!subjectIds.length) return zeroWork();
  for (const id of subjectIds) {
    const route = routeOf(id);
    if (route === null) throw new TypeError('Semantic summary observations require routed subjects');
  }
  const subjectRead = (id: string) => {
    const route = routeOf(id)!;
    const subjects = [{ route, id }];
    const summarySubjects = [{ route, id, image: uuid, original: uuid }];
    const selected = Array.from({ length: 12 }, (_, ordinal) => ({ id: uuid, slot_id: uuid, ordinal }));
    const repOperands = operandsOf(representatives, { partition_no: partitionOf(route), subjects });
    const reps = sqlWork(representatives.sql, repOperands, {
      keys: 12,
      rows: 1 + 5 * 12,
      points: 1,
      seeks: 1,
      output: 12,
      width: size({ id: uuid, slot_id: uuid, ordinal: 12 }),
    });
    const summaryOperands = operandsOf(summaries, {
      partition_no: partitionOf(route),
      context_id: uuid,
      subjects: summarySubjects,
      representatives: selected,
      bounded_labels: true,
      label_languages: ['en'],
      display_fallback: true,
    });
    const slots = 2 + selected.length;
    const candidates = 32 * slots;
    const labels = 2 + 1;
    const summary = sqlWork(summaries.sql, summaryOperands, {
      keys: 1 + candidates + labels + 1,
      rows: 5 + 6 * labels + 9 * slots + 12 * candidates + 3,
      points: 1 + labels + 3 * slots + 5 * candidates + 1,
      seeks: 1 + labels + 3 * slots + 5 * candidates + 1,
      output: 1,
      width:
        size({ id: uuid, type: '', labels: {}, original: '', choices: [] }) +
        6 * RELEASE_LIMITS.bytes +
        2 * 6 * (2 ** 30 - 1),
    });
    return sumBounds(reps, summary);
  };
  const perSubject = subjectIds.map(subjectRead);
  // Representative planning can request one additional edition batch and the
  // bounded reader retries a changed plan at most twice after its first read.
  const projectionReads = repeatBound(sumBounds(...perSubject), 6);
  const coverIds = [...subjectIds];
  const variants = 2 * 6;
  const coverOperands = operandsOf(coverReferences, {
    partition: 4095,
    routes: [65535],
    media_ids: [coverIds[0]!],
  });
  const coverWidth =
    size({
      mediaId: uuid,
      containerId: uuid,
      sha256: 'f'.repeat(64),
      sourceUrl: '',
      credit: null,
      provenance: null,
      width: -2147483648,
      height: -2147483648,
      thumbhash: 'f'.repeat(44),
      color: '#ffffff',
      variantsJson: '',
      focalX: -1,
      focalY: -1,
    }) +
    6 * 2048 +
    6 * 8192 +
    6 * 65536 +
    2 * variants * size({ format: 'webp', width: 2560 });
  // Media and source-fence reads group by data discovered in the preceding
  // projection. Price one singleton group per possible result so a spread of
  // actual homes cannot hide SQL text or wire operands behind one assumed home.
  const cover = sumBounds(
    ...coverIds.map((id) =>
      sqlWork(
        coverReferences.sql,
        operandsOf(coverReferences, { partition: 4095, routes: [65535], media_ids: [id] }),
        {
          keys: 1 + variants,
          rows: 5 + 3 * variants,
          points: 2,
          seeks: 2,
          output: 1,
          width: coverWidth,
        },
      ),
    ),
  );
  const source = 'x'.repeat(32);
  const externalId = 'x'.repeat(maxImportedSourceBytes);
  const tuple = { route: 65535, source, external_id: externalId, field_group: 'cover' };
  const fenceWidth = size({
    route: 65535,
    source,
    external_id: externalId,
    field_group: 'cover',
    takenDown: false,
    securityRevision: int8,
    takenDownAt: timestamp,
    takedownId: uuid,
  });
  const fences = repeatBound(
    sqlWork(
      sourceFences.sql,
      operandsOf(sourceFences, { partition: 4095, tuples: [tuple] }),
      { keys: 1, rows: 5, points: 1, seeks: 1, output: 1, width: fenceWidth },
    ),
    subjectIds.length,
  );
  // A successful summary may read original, representative-edition, media and
  // imported-source homes, plus the global release home. Their exact homes
  // depend on native rows produced by the preceding owner reads.
  const homeCount = Math.min(4096, 1 + 4 * subjectIds.length);
  const maxHomes = Array.from({ length: homeCount }, (_, index) => 4095 - index);
  const partitionOperands = operandsOf(partitions, { partitions: maxHomes });
  const homeReads = sqlWork(partitions.sql, partitionOperands, {
    keys: homeCount,
    rows: 2 * homeCount,
    points: homeCount,
    seeks: homeCount,
    output: homeCount,
    width: size({ partition_no: 4095, epoch: -2147483648, position: int8, write_state: 'draining' }),
    metadata: homeCount,
  });
  const releaseInputs = { route: 0, digest: `sha256:${'f'.repeat(64)}` };
  const active = sqlWork(releaseActive.sql, operandsOf(releaseActive, releaseInputs), {
    keys: 1,
    rows: 2,
    points: 1,
    seeks: 1,
    output: 1,
    width: size({ digest: releaseInputs.digest, head: int8 }),
  });
  const exists = sqlWork(releaseExists.sql, operandsOf(releaseExists, releaseInputs), {
    keys: 1,
    rows: 2,
    points: 1,
    seeks: 1,
    output: 1,
    width: size({ digest: releaseInputs.digest }),
  });
  const body = sqlWork(release.sql, operandsOf(release, releaseInputs), {
    keys: 1,
    rows: 2,
    points: 1,
    seeks: 1,
    output: 1,
    width: size({ body: null }) + 6 * RELEASE_LIMITS.bytes,
  });
  return dimensions(sumBounds(projectionReads, cover, fences, repeatBound(homeReads, 4), active, exists, body));
}

function summaryCurrentSqlWork(subjectIds: readonly string[]): WorkDimensions {
  if (!subjectIds.length) return zeroWork();
  for (const id of subjectIds) if (routeOf(id) === null)
    throw new TypeError('Semantic summary currentness requires routed subjects');
  const homeCount = Math.min(4096, 1 + 4 * subjectIds.length);
  const homes = Array.from({ length: homeCount }, (_, index) => 4095 - index);
  const current = sqlWork(partitions.sql, operandsOf(partitions, { partitions: homes }), {
    keys: homeCount,
    rows: 2 * homeCount,
    points: homeCount,
    seeks: homeCount,
    output: homeCount,
    width: size({ partition_no: 4095, epoch: -2147483648, position: int8, write_state: 'draining' }),
    metadata: homeCount,
  });
  return dimensions(repeatBound(current, 2));
}

const scopeDimensions = (work: IdentityScopeWork): WorkDimensions =>
  work.outputWork
    ? Object.freeze({ ...work.outputWork.used })
    : Object.freeze({
        candidateKeys: 0,
        nativeRows: work.rows,
        identityMetadataRows: 0,
        emptySeeks: 0,
        nativePoints: work.points,
        witnessKeys: 0,
        statements: work.statements,
        bytes: work.bytes,
      });
function semanticScopeKey(key: LibrarySemanticScopeKey): IdentityScopeKey {
  return key as IdentityScopeKey;
}
function publicMapping(mapping: IdentityMapping): LibrarySemanticMapping {
  return mapping;
}
function identityVersionWork(subjectId: string): WorkDimensions {
  const route = routeOf(subjectId);
  if (route === null) throw new TypeError('Shelf identity observations require a routed subject');
  const values = operandsOf(identityVersion, { route, subject_id: subjectId });
  return dimensions(
    declareBound({
      candidateKeys: 0,
      nativeRows: 2,
      identityMetadataRows: 3,
      emptySeeks: 2,
      nativePoints: 2,
      witnessKeys: 0,
      statements: 1,
      bytes:
        statementBytes(identityVersion.sql) +
        jsonBytes(values) +
        maxRowBytes({ revision: 2147483647, transactionId: uuid, redirect: uuid }),
      engineRequests: 0,
    }),
  );
}

function itemTypesWork(subjectIds: readonly string[], maxTypeBytes = 0): WorkDimensions {
  if (!subjectIds.length) return zeroWork();
  const groups = new Map<number, string[]>();
  for (const id of subjectIds) {
    const route = routeOf(id);
    if (route === null) throw new TypeError('Shelf type observations require routed subjects');
    const home = partitionOf(route);
    const group = groups.get(home) ?? [];
    group.push(id);
    groups.set(home, group);
  }
  const outputBytes = size({ id: uuid, type: '', agent_account_id: uuid, agent_verified: true }) +
    6 * Math.max(0, maxTypeBytes) +
    1;
  const costs = [...groups].map(([partition, ids]) => {
    const values = operandsOf(itemTypes, {
      partition_no: partition,
      routes: ids.map((id) => routeOf(id)!),
      subject_ids: ids,
    });
    return declareBound({
      candidateKeys: 0,
      nativeRows: 2 * ids.length,
      identityMetadataRows: 0,
      emptySeeks: 2 * ids.length,
      nativePoints: 2 * ids.length,
      witnessKeys: 0,
      statements: 1,
      bytes: statementBytes(itemTypes.sql) + jsonBytes(values) + ids.length * outputBytes,
      engineRequests: 0,
    });
  });
  return dimensions(sumBounds(...costs));
}

export function createNativeLibraryObservationAdapter(): SemanticObservationNativeAdapter {
  function canonicalMappingWork(originals: readonly string[]): WorkDimensions {
    if (originals.length > 100) throw new RangeError('Canonical Source mapping page must contain at most 100 originals');
    if (!originals.length) return zeroWork();
    const costs = originals.map((subjectId) => {
      const route = routeOf(subjectId);
      if (route === null) throw new TypeError('Canonical Source mapping requires routed originals');
      return mappingIdentityWork(subjectId, false);
    });
    return dimensions(sumBounds(...costs));
  }
  function scopeCommitWork(input: {
    route: number;
    collectionId: string;
    sourceFence: string;
    observation: LibrarySemanticScopeObservation;
  }): WorkDimensions {
    const address = identityScopeAddress(semanticScopeKey(input.observation.key));
    const values = operandsOf(commitCapture, {
      route: input.route,
      collection_id: input.collectionId,
      source_fence: input.sourceFence,
      capture_id: input.observation.captureId,
      revision: input.observation.committedRevision.toString(),
      partition_no: address.partition,
      source_key: address.source,
      scope_id: address.scope,
    });
    return dimensions(
      declareBound({
        candidateKeys: 0,
        nativeRows: 12,
        identityMetadataRows: 0,
        emptySeeks: 1,
        nativePoints: 1,
        witnessKeys: 0,
        statements: 1,
        bytes: statementBytes(commitCapture.sql) + jsonBytes(values),
        engineRequests: 0,
      }),
    );
  }
  function followMappingWork(originals: readonly string[]): WorkDimensions {
    return followMappingDimensions(originals);
  }
  function subjectReferenceWork(subjectId: string): WorkDimensions {
    return summaryReferenceWork(subjectId);
  }
  return Object.freeze({
    canonical: Object.freeze({
      mappingWork: canonicalMappingWork,
      scopeCommitWork,
      async readMappings(pool, originals) {
        return (await readIdentityMappings(pool, originals)).map(publicMapping);
      },
      async registerScope(pool, input) {
        const registration = input as unknown as Parameters<ReturnType<typeof createIdentityScopedObservations>['register']>[0];
        const registered = await createIdentityScopedObservations(pool).register(registration);
        if (registered.status === 'registered')
          return { status: 'registered', observation: registered.observation, work: scopeDimensions(registered.work) };
        if (registered.status === 'pending') return { status: 'pending', work: scopeDimensions(registered.work) };
        return { status: 'unavailable', work: scopeDimensions(registered.work) };
      },
      async revalidateScope(pool, input) {
        const revalidated = await createIdentityScopedObservations(pool).revalidate({
          key: semanticScopeKey(input.key),
          expected: input.expected as IdentityScopeObservation,
          deadline: input.deadline,
        });
        if (revalidated.status === 'current')
          return { status: 'current', observation: revalidated.observation, work: scopeDimensions(revalidated.work) };
        return {
          status: revalidated.status === 'stale' ? 'stale' : 'unavailable',
          work: scopeDimensions(revalidated.work),
        };
      },
      async commitScopeCapture(client, input) {
        const address = identityScopeAddress(semanticScopeKey(input.observation.key));
        await commitCapture.run(client as PoolClient, {
          route: input.route,
          collection_id: input.collectionId,
          source_fence: input.sourceFence,
          capture_id: input.observation.captureId,
          revision: input.observation.committedRevision.toString(),
          partition_no: address.partition,
          source_key: address.source,
          scope_id: address.scope,
        });
      },
    }),
    follow: Object.freeze({
      mappingWork: followMappingWork,
      subjectReferenceWork,
      subjectSummaryWork(subjectIds) {
        return summarySqlWork(subjectIds);
      },
      subjectSummaryCurrentWork,
      async readMapping(pool, original) {
        return publicMapping(await readIdentityMapping(pool, original));
      },
      async readMappings(pool, originals) {
        return (await readIdentityMappings(pool, originals)).map(publicMapping);
      },
      async readSubjectReference(input) {
        try {
          const value = await readSubjectReference(input.pool, input.subjectId, input.check);
          return value ? { state: 'present' } : { state: 'absent' };
        } catch (error) {
          if (!(error instanceof SubjectRedirectError)) throw error;
          return { state: 'redirect', from: error.from, to: error.to };
        }
      },
      observeSubjects(input) {
        return readSubjectSummaryObservation(input.context, input.ids, { displayFallback: true });
      },
    }),
    shelf: Object.freeze({
      identityVersionWork,
      itemTypesWork,
      readIdentityVersion(client, subjectId) {
        return readItemIdentityVersion(client, subjectId);
      },
      readItemTypes(client, subjectIds) {
        return readItemTypes(client, subjectIds);
      },
    }),
  });
}

