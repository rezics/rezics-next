import type { ThreadPost } from './thread-page';

/** Page relationships are a bounded reading aid, never a replacement thread order. */
export const conversationDepth = 8;
export type ConversationPost = Pick<ThreadPost, 'id' | 'threadId' | 'parentId' | 'availability'>;
export type RelationshipStop = 'root' | 'missing' | 'unavailable' | 'duplicate' | 'cycle' | 'unrelated' | 'bound';
export type ConversationRow = {
  /** Supplied position, including rows whose relationships cannot be admitted. */
  index: number;
  id: string;
  key: string;
  anchorId: string;
  parentId: string | null;
  ancestors: readonly number[];
  stop: RelationshipStop;
  continuation: string | null;
  /** Only descendants connected by at most eight admitted page edges. */
  relatedCount: number;
  related: number[];
};
export type ConversationPageModel = {
  rows: readonly ConversationRow[];
  /** Only unambiguous current-thread addresses can be relationship destinations. */
  byId: ReadonlyMap<string, ConversationRow>;
  metrics: Readonly<{ indexVisits: number; edgeVisits: number; cycleVisits: number; ancestorVisits: number }>;
};

/**
 * Three linear index passes and at most eight parent steps per supplied row. Functional-graph
 * coloring rejects whole cycles, including cycles longer than the visual limit, in linear time.
 * No content reader, sorting, recursion, thread total or off-page traversal belongs here.
 */
export function conversationPageModel(threadId: string, posts: readonly ConversationPost[]): ConversationPageModel {
  const positions = new Map<string, number>();
  const duplicates = new Set<string>();
  const metrics = { indexVisits: 0, edgeVisits: 0, cycleVisits: 0, ancestorVisits: 0 };
  for (let index = 0; index < posts.length; index++) {
    metrics.indexVisits++;
    const post = posts[index]!;
    if (positions.has(post.id)) duplicates.add(post.id);
    else positions.set(post.id, index);
  }
  const edges = new Map<number, number>();
  const stops: RelationshipStop[] = [];
  for (let index = 0; index < posts.length; index++) {
    metrics.edgeVisits++;
    const post = posts[index]!;
    if (post.threadId !== threadId) stops[index] = 'unrelated';
    else if (duplicates.has(post.id)) stops[index] = 'duplicate';
    else if (post.availability !== 'available') stops[index] = 'unavailable';
    else if (post.parentId === null) stops[index] = 'root';
    else if (duplicates.has(post.parentId)) stops[index] = 'duplicate';
    else {
      const parent = positions.get(post.parentId);
      if (parent === undefined) stops[index] = 'missing';
      else if (posts[parent]!.threadId !== threadId) stops[index] = 'unrelated';
      else edges.set(index, parent);
    }
  }
  const visited = new Set<number>();
  const cyclic = new Set<number>();
  for (let index = 0; index < posts.length; index++) {
    if (visited.has(index)) continue;
    const path = new Map<number, number>();
    let cursor: number | undefined = index;
    while (cursor !== undefined && !visited.has(cursor)) {
      metrics.cycleVisits++;
      visited.add(cursor);
      path.set(cursor, path.size);
      cursor = edges.get(cursor);
    }
    if (cursor !== undefined && path.has(cursor)) {
      const start = path.get(cursor)!;
      for (const [member, position] of path) if (position >= start) cyclic.add(member);
    }
  }
  for (const index of cyclic) {
    edges.delete(index);
    stops[index] = 'cycle';
  }
  const rows: ConversationRow[] = posts.map((post, index) => {
    const ancestors: number[] = [];
    let cursor = index;
    while (ancestors.length < conversationDepth) {
      const parent = edges.get(cursor);
      if (parent === undefined) break;
      metrics.ancestorVisits++;
      ancestors.push(parent);
      cursor = parent;
    }
    const next = edges.get(cursor);
    const bound = ancestors.length === conversationDepth && next !== undefined;
    const first = positions.get(post.id) === index;
    return {
      index,
      id: post.id,
      key: first ? post.id : `${post.id}:duplicate:${index}`,
      anchorId: first ? `post-${post.id}` : `duplicate-post-${index}`,
      parentId: post.parentId,
      ancestors,
      stop: bound ? 'bound' : (stops[cursor] ?? 'root'),
      continuation: bound ? posts[next]!.id : null,
      relatedCount: 0,
      related: [],
    };
  });
  const byId = new Map<string, ConversationRow>();
  for (const row of rows) {
    if (!duplicates.has(row.id) && posts[row.index]!.threadId === threadId) byId.set(row.id, row);
    for (const ancestor of row.ancestors) {
      rows[ancestor]!.relatedCount++;
      rows[ancestor]!.related.push(row.index);
    }
  }
  return { rows, byId, metrics };
}

/** Only admitted ancestry hides a row; a malformed relation never swallows its neighbors. */
export function conversationRowHidden(row: ConversationRow, collapsed: ReadonlySet<number>): boolean {
  return row.ancestors.some((ancestor) => collapsed.has(ancestor));
}
