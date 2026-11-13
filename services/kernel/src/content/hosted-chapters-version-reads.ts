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
  createHostedVersionWrite,
  hostedVersionSequence,
  readHostedVersionOccurrence,
  readHostedVersionSiblingRoot,
} from './hosted-version-store.ts';
import type { HostedVersionPointValue } from './hosted-version-draft-write.ts';
import type { HostedVersionSnapshot, HostedVersionWrite } from './hosted-version-model.ts';
import {
  chapterRankVersionedOutlineSequenceNode,
  rankVersionedOutlineSequenceNode,
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
  client: AccessClient,
  snapshot: HostedVersionSnapshot,
  parentId: string | null,
  occurrenceId: string,
): Promise<number> {
  const siblingRoot = await readHostedVersionSiblingRoot(client, snapshot, parentId);
  const rank = await rankVersionedOutlineSequenceNode(
    hostedVersionSequence(write, 'sibling'),
    siblingRoot?.rootNodeId ?? null,
    occurrenceId,
  );
  if (rank === null) throw new Error('Hosted version occurrence is missing from its sibling index');
  return wireRank(rank);
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
  const position = await siblingPosition(access.write, client, snapshot, occurrence.parentOccurrenceId, occurrenceId);
  return asPlacement(occurrenceId, occurrence.parentOccurrenceId, position, wireRank(preorderRank), occurrence.value);
}

async function pageChildren(
  client: AccessClient,
  snapshot: HostedVersionSnapshot,
  query: HostedVersionedPageQuery,
): Promise<HostedVersionedPage> {
  const access = indexes(client, snapshot);
  if (query.parentId !== null) {
    const parent = await readHostedVersionOccurrence<HostedVersionPointValue>(client, snapshot, query.parentId);
    if (!parent || parent.value.kind !== 'part') throw new ContentNotFoundError();
    if (
      (await rankVersionedOutlineSequenceNode(access.preorder().access, snapshot.preorderRootId, query.parentId)) ===
      null
    )
      throw new ContentNotFoundError();
  }
  const siblingRoot = await readHostedVersionSiblingRoot(client, snapshot, query.parentId);
  const siblings = access.sibling(siblingRoot?.rootNodeId ?? null);
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
  const access = indexes(client, snapshot);
  const preorder = access.preorder();
  const afterNodeId = query.cursorAfter === null ? undefined : await continuationNode(preorder, query.cursorAfter);
  const page = await readHostedVersionOutlinePage(preorder, {
    limit: query.limit,
    ...(afterNodeId === undefined ? {} : { afterNodeId }),
  });
  const window = page.candidates.slice(0, query.limit);
  const placements: OrderedHostedPlacement[] = [];
  for (const candidate of window) {
    const occurrence = await readHostedVersionOccurrence<HostedVersionPointValue>(client, snapshot, candidate.nodeId);
    if (!occurrence) throw new Error('Hosted version outline member is missing occurrence state');
    const position = await siblingPosition(
      access.write,
      client,
      snapshot,
      occurrence.parentOccurrenceId,
      candidate.nodeId,
    );
    placements.push(
      asPlacement(candidate.nodeId, occurrence.parentOccurrenceId, position, candidate.ordinal, occurrence.value),
    );
  }
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
  const access = indexes(client, snapshot);
  const preorder = access.preorder();
  const chapters = access.chapter();
  if ((await rankVersionedOutlineSequenceNode(preorder.access, preorder.rootId, query.occurrenceId)) === null)
    throw new ContentNotFoundError();
  const originNode = await preorder.access.readNode(query.occurrenceId);
  if (!originNode) throw new ContentNotFoundError();
  const originRank = await chapterRankVersionedOutlineSequenceNode(
    preorder.access,
    preorder.rootId,
    query.occurrenceId,
  );
  if (originRank === null) throw new ContentNotFoundError();
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
  const placements: OrderedHostedPlacement[] = [];
  for (const candidate of window) {
    const occurrence = await readHostedVersionOccurrence<HostedVersionPointValue>(client, snapshot, candidate.nodeId);
    if (!occurrence) throw new Error('Hosted version chapter member is missing occurrence state');
    const position = await siblingPosition(
      access.write,
      client,
      snapshot,
      occurrence.parentOccurrenceId,
      candidate.nodeId,
    );
    placements.push(
      asPlacement(
        candidate.nodeId,
        occurrence.parentOccurrenceId,
        position,
        wireRank(candidate.rank),
        occurrence.value,
      ),
    );
  }
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
