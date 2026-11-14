import type { AccessClient } from '../request/access.ts';
import { ContentNotFoundError } from './reads.ts';
import {
  InvalidHostedCursorError,
  InvalidHostedStructureError,
  type OrderedHostedPlacement,
} from './hosted-chapters-model.ts';
import { HostedVersionReadAnchorError, type HostedVersionReadIndex } from './hosted-version-read-pages-model.ts';
import {
  readHostedVersionChapterPage,
  readHostedVersionChildrenPage,
  readHostedVersionOutlinePage,
} from './hosted-version-read-pages.ts';
import {
  createHostedVersionSequenceReadAccess,
  createHostedVersionWrite,
  hostedVersionSequence,
  readHostedVersionOccurrence,
  readHostedVersionSiblingRoot,
  readHostedVersionOccurrences,
  readHostedVersionSiblingRoots,
  type HostedVersionWrite,
} from './hosted-version-store.ts';
import type { HostedVersionPointValue } from './hosted-version-draft-write.ts';
import type { HostedVersionOccurrenceValue, HostedVersionSnapshot } from './hosted-version-model.ts';
import {
  chapterRankVersionedOutlineSequenceNode,
  rankVersionedOutlineSequenceNode,
  rankVersionedOutlineSequenceNodes,
  selectVersionedOutlineSequenceNode,
} from './versioned-outline-sequence.ts';

export type HostedVersionedPageQuery = Readonly<{
  mode: 'children' | 'previous' | 'next' | 'outline';
  parentId: string | null;
  occurrenceId: string | null;
  cursorAfter: number | null;
  limit: number;
}>;

export type HostedVersionedPage = Readonly<{
  placements: readonly OrderedHostedPlacement[];
  origin: number;
  lastAfter: number | null;
  hasMore: boolean;
}>;

function asPlacement(
  occurrenceId: string,
  parentId: string | null,
  position: number,
  ordinal: number,
  value: HostedVersionPointValue,
): OrderedHostedPlacement {
  if (value.kind === 'chapter') {
    if (!value.target) throw new Error('Hosted version chapter is missing its exact target');
    return {
      occurrenceId,
      parentId,
      position,
      ordinal,
      title: value.title,
      kind: 'chapter',
      target: value.target,
    };
  }
  return { occurrenceId, parentId, position, ordinal, title: value.title, kind: 'part' };
}

function wireRank(rank: bigint): number {
  if (rank < 0n || rank > BigInt(Number.MAX_SAFE_INTEGER))
    throw new RangeError('Hosted version rank exceeds the exact numeric wire range');
  return Number(rank);
}

function indexes(client: AccessClient, snapshot: HostedVersionSnapshot) {
  const write = createHostedVersionWrite<HostedVersionPointValue>(client, snapshot);
  return {
    write,
    sibling(rootId: string | null): HostedVersionReadIndex<HostedVersionPointValue> {
      return { rootId, access: hostedVersionSequence(write, 'sibling') };
    },
    preorder(): HostedVersionReadIndex<HostedVersionPointValue> {
      return { rootId: snapshot.preorderRootId, access: hostedVersionSequence(write, 'preorder') };
    },
    chapter(): HostedVersionReadIndex<HostedVersionPointValue> {
      return { rootId: snapshot.chapterRootId, access: hostedVersionSequence(write, 'chapter') };
    },
  };
}

function pageIndexes(client: AccessClient, snapshot: HostedVersionSnapshot) {
  return {
    sibling: createHostedVersionSequenceReadAccess<HostedVersionPointValue>(client, snapshot, 'sibling'),
    preorder: createHostedVersionSequenceReadAccess<HostedVersionPointValue>(client, snapshot, 'preorder'),
    chapter: createHostedVersionSequenceReadAccess<HostedVersionPointValue>(client, snapshot, 'chapter'),
  };
}

function siblingPageIndex(
  access: ReturnType<typeof pageIndexes>['sibling'],
  rootId: string | null,
): HostedVersionReadIndex<HostedVersionPointValue> {
  return { rootId, access };
}

async function continuationNode(
  index: HostedVersionReadIndex<HostedVersionPointValue>,
  after: number,
): Promise<string> {
  const selected = await selectVersionedOutlineSequenceNode(index.access, index.rootId, BigInt(after));
  if (!selected) throw new InvalidHostedCursorError();
  return selected.id;
}

async function siblingPosition(
  write: HostedVersionWrite<HostedVersionPointValue>,
  siblingRootId: string | null,
  occurrenceId: string,
): Promise<number> {
  const rank = await rankVersionedOutlineSequenceNode(
    hostedVersionSequence(write, 'sibling'),
    siblingRootId,
    occurrenceId,
  );
  if (rank === null) throw new Error('Hosted version occurrence is missing from its sibling index');
  return wireRank(rank);
}

type HostedPlacementCandidate = Readonly<{ nodeId: string }>;
type HydratedHostedCandidate<Candidate extends HostedPlacementCandidate> = Readonly<{
  candidate: Candidate;
  occurrence: HostedVersionOccurrenceValue<HostedVersionPointValue>;
  siblingRootId: string | null;
}>;

async function hydrateCandidates<Candidate extends HostedPlacementCandidate>(
  client: AccessClient,
  snapshot: HostedVersionSnapshot,
  candidates: readonly Candidate[],
  missingMessage: string,
): Promise<readonly HydratedHostedCandidate<Candidate>[]> {
  const occurrences = await readHostedVersionOccurrences<HostedVersionPointValue>(
    client,
    snapshot,
    candidates.map((candidate) => candidate.nodeId),
  );
  const selected = candidates.map((candidate) => {
    const occurrence = occurrences.get(candidate.nodeId);
    if (!occurrence) throw new Error(missingMessage);
    return { candidate, occurrence };
  });
  const roots = await readHostedVersionSiblingRoots(
    client,
    snapshot,
    selected.map(({ occurrence }) => occurrence.parentOccurrenceId),
  );
  return selected.map(({ candidate, occurrence }) => ({
    candidate,
    occurrence,
    siblingRootId: roots.get(occurrence.parentOccurrenceId)?.rootNodeId ?? null,
  }));
}

/** Resolve one live tree member at the mapped snapshot; removed subtrees are absent from the indexes. */
export async function readVersionedHostedPlacement(
  client: AccessClient,
  snapshot: HostedVersionSnapshot,
  occurrenceId: string,
): Promise<OrderedHostedPlacement | null> {
  const occurrence = await readHostedVersionOccurrence<HostedVersionPointValue>(client, snapshot, occurrenceId);
  if (!occurrence) return null;
  const access = indexes(client, snapshot);
  const preorderRank = await rankVersionedOutlineSequenceNode(
    access.preorder().access,
    snapshot.preorderRootId,
    occurrenceId,
  );
  if (preorderRank === null) return null;
  const siblingRoot = await readHostedVersionSiblingRoot(client, snapshot, occurrence.parentOccurrenceId);
  const position = await siblingPosition(access.write, siblingRoot?.rootNodeId ?? null, occurrenceId);
  return asPlacement(occurrenceId, occurrence.parentOccurrenceId, position, wireRank(preorderRank), occurrence.value);
}

async function pageChildren(
  client: AccessClient,
  snapshot: HostedVersionSnapshot,
  query: HostedVersionedPageQuery,
): Promise<HostedVersionedPage> {
  const access = pageIndexes(client, snapshot);
  if (query.parentId !== null) {
    const parent = await readHostedVersionOccurrence<HostedVersionPointValue>(client, snapshot, query.parentId);
    if (!parent || parent.value.kind !== 'part') throw new ContentNotFoundError();
    if (
      (await rankVersionedOutlineSequenceNode(access.preorder, snapshot.preorderRootId, query.parentId)) ===
      null
    )
      throw new ContentNotFoundError();
  }
  const siblingRoot = await readHostedVersionSiblingRoot(client, snapshot, query.parentId);
  const siblings = siblingPageIndex(access.sibling, siblingRoot?.rootNodeId ?? null);
  const afterNodeId = query.cursorAfter === null ? undefined : await continuationNode(siblings, query.cursorAfter);
  const page = await readHostedVersionChildrenPage(siblings, {
    limit: query.limit,
    ...(afterNodeId === undefined ? {} : { afterNodeId }),
  });
  const window = page.candidates.slice(0, query.limit);
  return {
    placements: window.map((candidate) =>
      asPlacement(candidate.nodeId, query.parentId, candidate.position, candidate.position, candidate.value),
    ),
    origin: -1,
    lastAfter: window.at(-1)?.position ?? null,
    hasMore: page.hasMore,
  };
}

async function pageOutline(
  client: AccessClient,
  snapshot: HostedVersionSnapshot,
  query: HostedVersionedPageQuery,
): Promise<HostedVersionedPage> {
  const access = pageIndexes(client, snapshot);
  const preorder = siblingPageIndex(access.preorder, snapshot.preorderRootId);
  const afterNodeId = query.cursorAfter === null ? undefined : await continuationNode(preorder, query.cursorAfter);
  const page = await readHostedVersionOutlinePage(preorder, {
    limit: query.limit,
    ...(afterNodeId === undefined ? {} : { afterNodeId }),
  });
  const window = page.candidates.slice(0, query.limit);
  const hydrated = await hydrateCandidates(
    client,
    snapshot,
    window,
    'Hosted version outline member is missing occurrence state',
  );
  const positions = await rankVersionedOutlineSequenceNodes(
    access.sibling,
    hydrated.map(({ candidate, siblingRootId }) => ({ rootId: siblingRootId, nodeId: candidate.nodeId })),
  );
  const placements = hydrated.map(({ candidate, occurrence }, index) => {
    const position = positions[index];
    if (position === null || position === undefined)
      throw new Error('Hosted version occurrence is missing from its sibling index');
    return asPlacement(
      candidate.nodeId,
      occurrence.parentOccurrenceId,
      wireRank(position),
      candidate.ordinal,
      occurrence.value,
    );
  });
  return {
    placements,
    origin: -1,
    lastAfter: window.at(-1)?.ordinal ?? null,
    hasMore: page.hasMore,
  };
}

async function pageChapters(
  client: AccessClient,
  snapshot: HostedVersionSnapshot,
  query: HostedVersionedPageQuery,
): Promise<HostedVersionedPage> {
  if (query.occurrenceId === null) throw new InvalidHostedStructureError();
  const access = pageIndexes(client, snapshot);
  const preorder = siblingPageIndex(access.preorder, snapshot.preorderRootId);
  const chapters = siblingPageIndex(access.chapter, snapshot.chapterRootId);
  const originRank = await chapterRankVersionedOutlineSequenceNode(
    preorder.access,
    preorder.rootId,
    query.occurrenceId,
  );
  if (originRank === null) throw new ContentNotFoundError();
  const originNode = await preorder.access.readNode(query.occurrenceId);
  if (!originNode) throw new ContentNotFoundError();
  const originWeight = originNode.chapterWeight ?? 0n;
  const firstRank = query.mode === 'next' ? originRank + originWeight : originRank - 1n;
  const origin = query.mode === 'next' ? wireRank(firstRank) - 1 : wireRank(originRank);
  const afterNodeId = query.cursorAfter === null ? undefined : await continuationNode(chapters, query.cursorAfter);
  const page = await readHostedVersionChapterPage(preorder, chapters, {
    originNodeId: query.occurrenceId,
    direction: query.mode === 'previous' ? 'previous' : 'next',
    limit: query.limit,
    ...(afterNodeId === undefined ? {} : { afterNodeId }),
  });
  const window = page.candidates.slice(0, query.limit);
  const hydrated = await hydrateCandidates(
    client,
    snapshot,
    window,
    'Hosted version chapter member is missing occurrence state',
  );
  const positions = await rankVersionedOutlineSequenceNodes(
    access.sibling,
    hydrated.map(({ candidate, siblingRootId }) => ({ rootId: siblingRootId, nodeId: candidate.nodeId })),
  );
  const placements = hydrated.map(({ candidate, occurrence }, index) => {
    const position = positions[index];
    if (position === null || position === undefined)
      throw new Error('Hosted version occurrence is missing from its sibling index');
    return asPlacement(
      candidate.nodeId,
      occurrence.parentOccurrenceId,
      wireRank(position),
      wireRank(candidate.rank),
      occurrence.value,
    );
  });
  return {
    placements,
    origin,
    lastAfter: window.at(-1) ? wireRank(window.at(-1)!.rank) : null,
    hasMore: page.hasMore,
  };
}

/** Page children, outline or chapter navigation from the mapped draft snapshot. */
export async function pageVersionedHostedPlacements(
  client: AccessClient,
  snapshot: HostedVersionSnapshot,
  query: HostedVersionedPageQuery,
): Promise<HostedVersionedPage> {
  try {
    if (query.mode === 'children') return await pageChildren(client, snapshot, query);
    if (query.mode === 'outline') return await pageOutline(client, snapshot, query);
    return await pageChapters(client, snapshot, query);
  } catch (error) {
    if (error instanceof HostedVersionReadAnchorError)
      throw query.cursorAfter === null ? new ContentNotFoundError() : new InvalidHostedCursorError();
    throw error;
  }
}
