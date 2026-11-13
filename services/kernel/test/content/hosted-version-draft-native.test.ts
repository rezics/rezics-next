import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { routeOf } from '../../src/route/route.ts';
import {
  type VersionedOutlineSequenceNode,
  type VersionedOutlineSequenceReadWriteSet,
} from '../../src/content/versioned-outline-sequence.ts';
import {
  commitHostedVersionRevision,
  type HostedVersionRevisionSnapshot,
} from '../../src/content/hosted-version-revision.ts';
import {
  commitHostedVersionWrite,
  createHostedVersionGeneration,
  createHostedVersionWrite,
  hostedVersionSequence,
  readHostedVersionHead,
  readHostedVersionOccurrence,
  readHostedVersionSnapshot,
  stageHostedVersionOccurrence,
  stageHostedVersionSiblingRoot,
  stageHostedVersionSnapshotRoots,
} from '../../src/content/hosted-version-store.ts';
import type { HostedVersionDraftMoveNativeAdapter } from '../../src/content/hosted-version-draft-edit-model.ts';
import { moveHostedVersionDraftOccurrence } from '../../src/content/hosted-version-draft-edit-command.ts';
import { createHostedVersionDraftMoveNativeAdapter } from '../../src/content/hosted-version-draft-native.ts';
import { RevisionPreconditionError } from '../../src/content/commands.ts';
import type { HostedVersionDraftMoveStoredValue } from '../../src/content/hosted-version-draft-native-model.ts';
import type { CommandTransaction } from '../../src/command/command.ts';
import type { HostedChapterTarget } from '../../src/content/hosted-chapters-model.ts';
import { hostedChaptersFixture } from './support/hosted-chapters-fixture.ts';
import { observeSql, type SqlObserver } from './support/sql-observer.ts';
import readNode from '../../src/content/hosted-version-read-node.sql';
import readOccurrence from '../../src/content/hosted-version-read-occurrence.sql';
import readSiblingRoot from '../../src/content/hosted-version-read-sibling-root.sql';
import commitVersion from '../../src/content/hosted-version-commit.sql';

setDefaultTimeout(180_000);

type StoredValue = HostedVersionDraftMoveStoredValue &
  Readonly<{
    title: string;
    target: HostedChapterTarget | null;
  }>;

type OccurrenceFact = Readonly<{
  occurrenceId: string;
  parentId: string | null;
  subtreeSize: bigint;
  value: StoredValue;
}>;

type EncodedValue =
  | Readonly<{ kind: 'bigint'; value: string }>
  | Readonly<{ kind: 'array'; value: readonly EncodedValue[] }>
  | Readonly<{ kind: 'object'; value: readonly (readonly [string, EncodedValue])[] }>
  | Readonly<{ kind: 'primitive'; value: string | number | boolean | null }>;

type StoredNode = Readonly<{
  id: string;
  leftId: string | null;
  rightId: string | null;
  value: string;
}>;

let activeObserver: SqlObserver | undefined;
let closeFixture: (() => Promise<void>) | undefined;
afterEach(async () => {
  await activeObserver?.close();
  activeObserver = undefined;
  await closeFixture?.();
  closeFixture = undefined;
});

function buildBalancedSequence(
  access: VersionedOutlineSequenceReadWriteSet<string>,
  values: readonly string[],
  chapterIds: ReadonlySet<string>,
): string | null {
  function build(start: number, end: number, parentId: string | null): string | null {
    if (start >= end) return null;
    const middle = Math.floor((start + end) / 2);
    const id = values[middle]!;
    const leftId = build(start, middle, id);
    const rightId = build(middle + 1, end, id);
    const left = leftId === null ? null : access.nodeWrites.get(leftId)!;
    const right = rightId === null ? null : access.nodeWrites.get(rightId)!;
    const chapterWeight = chapterIds.has(id) ? 1n : 0n;
    const node: VersionedOutlineSequenceNode<string> = {
      id,
      value: id,
      leftId,
      rightId,
      treeParentId: parentId,
      height: Math.max(left?.height ?? 0, right?.height ?? 0) + 1,
      count: 1n + (left?.count ?? 0n) + (right?.count ?? 0n),
      chapterWeight,
      chapterCount: chapterWeight + (left?.chapterCount ?? 0n) + (right?.chapterCount ?? 0n),
    };
    access.writeNode(node);
    return id;
  }
  return build(0, values.length, null);
}

function decodeStoreValue(value: EncodedValue): unknown {
  if (value.kind === 'bigint') return BigInt(value.value);
  if (value.kind === 'array') return value.value.map(decodeStoreValue);
  if (value.kind === 'object')
    return Object.fromEntries(value.value.map(([key, child]) => [key, decodeStoreValue(child)]));
  return value.value;
}

async function readStoredOrder(
  pool: Awaited<ReturnType<typeof hostedChaptersFixture>>['native']['pool'],
  route: number,
  catalogueId: string,
  generationId: string,
  sequence: bigint,
  indexKind: 'sibling' | 'preorder' | 'chapter',
  rootId: string | null,
): Promise<string[]> {
  if (rootId === null) return [];
  const rows = await pool.query<{ id: string; node_state: EncodedValue }>(
    `SELECT node_id::text AS id,node_state
     FROM (
       SELECT DISTINCT ON (node_id) node_id,node_state,is_deleted
       FROM content.hosted_order_node_version
       WHERE route=$1 AND catalogue_id=$2 AND generation_id=$3 AND index_kind=$4 AND sequence<=$5
       ORDER BY node_id,sequence DESC
     ) selected
     WHERE NOT is_deleted`,
    [route, catalogueId, generationId, indexKind, sequence.toString()],
  );
  const nodes = new Map<string, StoredNode>();
  for (const row of rows.rows) {
    const state = decodeStoreValue(row.node_state) as Omit<VersionedOutlineSequenceNode<string>, 'id' | 'treeParentId'>;
    nodes.set(row.id, { id: row.id, leftId: state.leftId, rightId: state.rightId, value: state.value });
  }
  const result: string[] = [];
  function visit(id: string | null): void {
    if (id === null) return;
    const node = nodes.get(id);
    if (!node) throw new Error('Native move test found a missing immutable sequence node');
    visit(node.leftId);
    result.push(node.value);
    visit(node.rightId);
  }
  visit(rootId);
  return result;
}

function commandContext(idempotencyKey = crypto.randomUUID()) {
  return {
    idempotencyKey,
    deadline: Date.now() + 120_000,
    requestId: crypto.randomUUID(),
  };
}

test('persists a 12,001-occurrence cross-parent move on one snapshot overlay with bounded path work', async () => {
  const fixture = await hostedChaptersFixture();
  closeFixture = fixture.close;
  const { native, catalogueId, newOccurrenceId, target: resolveTarget } = fixture;
  const route = routeOf(catalogueId)!;

  const existing = newOccurrenceId();
  const base = await native.command('/v1/hostedCatalogues', {
    postId: catalogueId,
    threadId: fixture.threadId,
    placements: [{ occurrenceId: existing, parentId: null, position: 0, title: 'Seed', kind: 'part' }],
  });
  const sourceTarget = resolveTarget(await native.thread());
  const parentA = newOccurrenceId();
  const parentB = newOccurrenceId();
  const beforeA = newOccurrenceId();
  const source = newOccurrenceId();
  const afterA = newOccurrenceId();
  const beforeB = newOccurrenceId();
  const afterB = newOccurrenceId();
  const outsideTail = newOccurrenceId();
  const descendants = Array.from({ length: 12_000 }, () => newOccurrenceId());
  const chapterIds = new Set([beforeA, ...descendants, afterA, beforeB, afterB, outsideTail]);
  const facts = new Map<string, OccurrenceFact>();
  const add = (
    occurrenceId: string,
    parentId: string | null,
    kind: 'part' | 'chapter',
    subtreeSize: bigint,
    subtreeHeight: number,
    chapterCount: bigint,
    title: string,
  ) => {
    facts.set(occurrenceId, {
      occurrenceId,
      parentId,
      subtreeSize,
      value: {
        kind,
        subtreeHeight,
        chapterCount,
        title,
        target: kind === 'chapter' ? sourceTarget : null,
      },
    });
  };
  add(parentA, null, 'part', 12_004n, 2, 12_002n, 'Source parent');
  add(parentB, null, 'part', 3n, 1, 2n, 'Destination parent');
  add(beforeA, parentA, 'chapter', 1n, 0, 1n, 'Before source');
  add(source, parentA, 'part', 12_001n, 1, 12_000n, 'Moved subtree');
  add(afterA, parentA, 'chapter', 1n, 0, 1n, 'After source');
  add(beforeB, parentB, 'chapter', 1n, 0, 1n, 'Destination anchor');
  add(afterB, parentB, 'chapter', 1n, 0, 1n, 'Destination tail');
  add(outsideTail, null, 'chapter', 1n, 0, 1n, 'Outside tail');
  descendants.forEach((id, index) => add(id, source, 'chapter', 1n, 0, 1n, `Moved chapter ${index}`));

  await native.pool.query(
    `INSERT INTO content.hosted_occurrence(route,catalogue_id,occurrence_id,kind,thread_id,post_id)
     SELECT $1,$2,x.occurrence_id,x.kind,x.thread_id,x.post_id
     FROM jsonb_to_recordset($3::jsonb) AS x(occurrence_id uuid,kind text,thread_id uuid,post_id uuid)`,
    [
      route,
      catalogueId,
      JSON.stringify(
        [...facts.values()].map(({ occurrenceId, value }) => ({
          occurrence_id: occurrenceId,
          kind: value.kind,
          thread_id: value.target?.threadId ?? null,
          post_id: value.target?.postId ?? null,
        })),
      ),
    ],
  );

  const generationId = newOccurrenceId();
  const empty = await createHostedVersionGeneration(native.pool, catalogueId, generationId, 'draft');
  const write = createHostedVersionWrite<StoredValue>(native.pool, empty);
  // The fixture builds planner indexes from occurrence IDs. The store write
  // carries object-valued occurrence payloads on the same generic overlay.
  const siblingIndex = hostedVersionSequence(
    write,
    'sibling',
  ) as unknown as VersionedOutlineSequenceReadWriteSet<string>;
  const preorderIndex = hostedVersionSequence(
    write,
    'preorder',
  ) as unknown as VersionedOutlineSequenceReadWriteSet<string>;
  const chapterIndex = hostedVersionSequence(
    write,
    'chapter',
  ) as unknown as VersionedOutlineSequenceReadWriteSet<string>;
  const siblingRoots = new Map<string | null, string | null>([
    [null, buildBalancedSequence(siblingIndex, [parentA, parentB, outsideTail], chapterIds)],
    [parentA, buildBalancedSequence(siblingIndex, [beforeA, source, afterA], chapterIds)],
    [source, buildBalancedSequence(siblingIndex, descendants, chapterIds)],
    [parentB, buildBalancedSequence(siblingIndex, [beforeB, afterB], chapterIds)],
  ]);
  const preorderIds = [parentA, beforeA, source, ...descendants, afterA, parentB, beforeB, afterB, outsideTail];
  const preorderRootId = buildBalancedSequence(preorderIndex, preorderIds, chapterIds);
  const chapterSequence = preorderIds.filter((id) => chapterIds.has(id));
  const chapterRootId = buildBalancedSequence(chapterIndex, chapterSequence, chapterIds);

  for (const fact of facts.values()) {
    stageHostedVersionOccurrence(write, fact.occurrenceId, {
      parentOccurrenceId: fact.parentId,
      subtreeSize: fact.subtreeSize,
      value: fact.value,
    });
  }
  for (const [parentId, rootId] of siblingRoots) stageHostedVersionSiblingRoot(write, parentId, rootId);
  stageHostedVersionSnapshotRoots(write, {
    preorderRootId,
    chapterRootId,
    placementCount: BigInt(facts.size),
    chapterCount: BigInt(chapterSequence.length),
  });

  const seedRevisionId = newOccurrenceId();
  const client = await native.pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    const committed = await commitHostedVersionWrite(client, write);
    const revisionSnapshot: HostedVersionRevisionSnapshot<'draft'> = {
      ...committed,
      generationKind: 'draft',
    };
    await commitHostedVersionRevision(client, {
      revisionId: seedRevisionId,
      snapshot: revisionSnapshot,
      recordedTransactionId: newOccurrenceId(),
      recordedAt: new Date().toISOString(),
      revisionKind: 'structure',
      expectedDraftRevisionId: base.revisionId,
    });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  const oldSnapshot = await readHostedVersionSnapshot(native.pool, catalogueId, generationId, 1n);
  expect(oldSnapshot).not.toBeNull();
  expect(oldSnapshot?.placementCount).toBe(12_008n);
  expect(oldSnapshot?.chapterCount).toBe(12_005n);
  const adapter = createHostedVersionDraftMoveNativeAdapter();
  const dependencies = {
    pool: native.pool,
    access: native.system.access,
    tokens: native.system.tokenKeys,
    routeKey: native.system.routeKey,
    clock: () => new Date(),
    versionAdapter: adapter,
  };
  const observer = observeSql(native.pool);
  activeObserver = observer;

  const input = {
    expectedRevisionId: seedRevisionId,
    occurrenceId: source,
    parentId: parentB,
    beforeOccurrenceId: beforeB,
  } as const;
  const movePath = `/v1/hostedCatalogues/${catalogueId}:moveDraftPoint`;
  expect((await native.call('POST', movePath, input, { other: true })).status).toBe(403);
  expect((await native.call('POST', movePath, input, { anonymous: true })).status).toBe(401);
  expect((await native.call('POST', movePath, { ...input, extra: true })).status).toBe(400);
  const firstMoveStart = observer.records.length;
  const replayKey = crypto.randomUUID();
  const moved = await native.call('POST', movePath, input, { key: replayKey });
  expect(moved.status).toBe(200);
  expect(moved.value).toEqual({ catalogueId, revisionId: expect.any(String) });
  const firstMoveSql = observer.records.slice(firstMoveStart);
  const movedRevisionId = moved.value.revisionId as string;
  expect(movedRevisionId).not.toBe(seedRevisionId);

  const versionHead = await readHostedVersionHead(native.pool, catalogueId, generationId);
  expect(versionHead?.sequence).toBe(2n);
  const movedSnapshot = await readHostedVersionSnapshot(native.pool, catalogueId, generationId, 2n);
  expect(movedSnapshot).not.toBeNull();
  const expectedPreorder = [parentA, beforeA, afterA, parentB, beforeB, source, ...descendants, afterB, outsideTail];
  const expectedChapters = [beforeA, afterA, ...descendants, beforeB, afterB, outsideTail];
  expect(
    await readStoredOrder(native.pool, route, catalogueId, generationId, 1n, 'preorder', oldSnapshot!.preorderRootId),
  ).toEqual(preorderIds);
  expect(
    await readStoredOrder(native.pool, route, catalogueId, generationId, 1n, 'chapter', oldSnapshot!.chapterRootId),
  ).toEqual(chapterSequence);
  expect(
    await readStoredOrder(native.pool, route, catalogueId, generationId, 2n, 'preorder', movedSnapshot!.preorderRootId),
  ).toEqual(expectedPreorder);
  expect(
    await readStoredOrder(native.pool, route, catalogueId, generationId, 2n, 'chapter', movedSnapshot!.chapterRootId),
  ).toEqual(expectedChapters);
  const oldSource = await readHostedVersionOccurrence<StoredValue>(native.pool, oldSnapshot!, source);
  const currentSource = await readHostedVersionOccurrence<StoredValue>(native.pool, movedSnapshot!, source);
  const oldChapter = await readHostedVersionOccurrence<StoredValue>(native.pool, oldSnapshot!, descendants[6]!);
  const currentChapter = await readHostedVersionOccurrence<StoredValue>(native.pool, movedSnapshot!, descendants[6]!);
  expect(oldSource?.parentOccurrenceId).toBe(parentA);
  expect(currentSource?.parentOccurrenceId).toBe(parentB);
  expect(currentSource?.value).toEqual(oldSource?.value);
  expect(currentChapter?.value).toEqual(oldChapter?.value);
  expect(currentChapter?.value.target).toEqual(sourceTarget);

  const indexHeightBound = Math.ceil(Math.log2(facts.size + 1));
  const pathWorkBound = 96 * (indexHeightBound + 8);
  const probeStatements: readonly string[] = [readNode.sql, readOccurrence.sql, readSiblingRoot.sql];
  const physicalProbes = firstMoveSql.filter((entry) => probeStatements.includes(entry.statement)).length;
  expect(physicalProbes).toBeLessThan(pathWorkBound);
  expect(physicalProbes).toBeLessThan(descendants.length);
  const storeCommit = firstMoveSql.find((entry) => entry.statement === commitVersion.sql);
  expect(storeCommit).toBeDefined();
  const nodeRows = JSON.parse(String(storeCommit!.parameters[5])) as unknown[];
  const occurrenceRows = JSON.parse(String(storeCommit!.parameters[6])) as unknown[];
  const siblingRootRows = JSON.parse(String(storeCommit!.parameters[7])) as unknown[];
  expect(nodeRows.length).toBeLessThan(pathWorkBound);
  expect(nodeRows.length).toBeLessThan(descendants.length);
  expect(occurrenceRows.length).toBeLessThan(16);
  expect(siblingRootRows.length).toBe(2);

  const writesBeforeReplay = observer.records.filter((entry) => entry.statement === commitVersion.sql).length;
  const replay = await native.call('POST', movePath, input, { key: replayKey });
  expect(replay.status).toBe(200);
  expect(replay.value.revisionId).toBe(movedRevisionId);
  expect((await readHostedVersionHead(native.pool, catalogueId, generationId))?.sequence).toBe(2n);
  expect(observer.records.filter((entry) => entry.statement === commitVersion.sql).length).toBe(writesBeforeReplay);

  const adjacentNoop = await native.call('POST', movePath, { ...input, expectedRevisionId: movedRevisionId });
  expect(adjacentNoop.status).toBe(200);
  expect(adjacentNoop.value.revisionId).toBe(movedRevisionId);
  expect((await readHostedVersionHead(native.pool, catalogueId, generationId))?.sequence).toBe(2n);
  expect(observer.records.filter((entry) => entry.statement === commitVersion.sql).length).toBe(writesBeforeReplay);

  const invalidAnchor = await native.call('POST', movePath, {
    ...input,
    expectedRevisionId: movedRevisionId,
    beforeOccurrenceId: afterA,
  });
  expect(invalidAnchor.status).toBe(400);
  const stale = await native.call('POST', movePath, input);
  expect(stale.status).toBe(412);
  expect((await readHostedVersionHead(native.pool, catalogueId, generationId))?.sequence).toBe(2n);

  expect((await readHostedVersionHead(native.pool, catalogueId, generationId))?.sequence).toBe(2n);

  const revisionsBeforeLostCas = await native.pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM content.hosted_structure_revision WHERE route=$1 AND catalogue_id=$2',
    [route, catalogueId],
  );
  const casAdapter: HostedVersionDraftMoveNativeAdapter<CommandTransaction> = {
    async selectExpectedSnapshot(tx, selectedCatalogueId, selectedInput, revision) {
      const selected = await adapter.selectExpectedSnapshot(tx, selectedCatalogueId, selectedInput, revision);
      await tx.query(`UPDATE content.hosted_catalogue SET head_revision_id=$3 WHERE route=$1 AND catalogue_id=$2`, [
        route,
        catalogueId,
        base.revisionId,
      ]);
      return selected;
    },
    commitMove: adapter.commitMove,
  };
  const casFailure = moveHostedVersionDraftOccurrence(
    { ...dependencies, versionAdapter: casAdapter },
    native.author.actor,
    catalogueId,
    { expectedRevisionId: movedRevisionId, occurrenceId: source, parentId: parentA, beforeOccurrenceId: afterA },
    commandContext(),
  );
  await expect(casFailure).rejects.toBeInstanceOf(RevisionPreconditionError);
  expect((await readHostedVersionHead(native.pool, catalogueId, generationId))?.sequence).toBe(2n);
  const catalogueHead = await native.pool.query<{ head_revision_id: string }>(
    'SELECT head_revision_id::text FROM content.hosted_catalogue WHERE route=$1 AND catalogue_id=$2',
    [route, catalogueId],
  );
  expect(catalogueHead.rows[0]?.head_revision_id).toBe(movedRevisionId);
  const revisionsAfterLostCas = await native.pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM content.hosted_structure_revision WHERE route=$1 AND catalogue_id=$2',
    [route, catalogueId],
  );
  expect(revisionsAfterLostCas.rows[0]?.count).toBe(revisionsBeforeLostCas.rows[0]?.count);
});
