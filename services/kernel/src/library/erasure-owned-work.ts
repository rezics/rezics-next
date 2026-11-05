import { OWNED_PHASES, type OwnedGraphInput, type OwnedGraphPage } from './erasure-owned-graph.ts';

export type GraphCheckpoint = {
  phase: number;
  parent: string | null;
  after: string | null;
  child: number;
  retain: boolean;
  blockedCollection: string | null;
};
export const initialGraphCheckpoint = (): GraphCheckpoint => ({
  phase: 0,
  parent: null,
  after: null,
  child: 0,
  retain: false,
  blockedCollection: null,
});

/** Finite workflow segment. Native page receipts and DBOS step checkpoints make
 * repeating a committed page safe; the continuation contains only fixed keys.
 */
export async function runOwnedGraphSegment(
  accountId: string,
  segment: number,
  start: GraphCheckpoint,
  page: (input: OwnedGraphInput) => Promise<OwnedGraphPage>,
) {
  const cursor = { ...start };
  const stats = { pages: 0, removed: 0 };
  while (cursor.phase < OWNED_PHASES.length && stats.pages < 100) {
    const phase = OWNED_PHASES[cursor.phase]!;
    if (
      cursor.blockedCollection !== null &&
      (phase === 'builtin_state_reference_source' ||
        phase === 'builtin_collection_reference' ||
        phase === 'owner_write_counter' ||
        phase === 'fact_source_head')
    ) {
      cursor.phase++;
      continue;
    }
    const children =
      phase === 'sessions' ? (['units', 'changes', 'sessionDelete'] as const) : (['collectionLocal'] as const);
    const parentPhase = phase === 'sessions' || phase === 'collections';
    const kind = parentPhase && cursor.parent !== null ? children[cursor.child]! : phase;
    const result = await page({
      accountId,
      kind,
      parent: cursor.parent,
      after: cursor.after,
      ordinal: stats.pages,
      segment,
    });
    stats.pages++;
    stats.removed += result.removed;
    if (kind === 'native_source_capture') {
      if (result.blocked) cursor.blockedCollection ??= result.pendingCollection ?? null;
      if (result.parent === null) {
        cursor.phase++;
        cursor.after = null;
      } else if (result.nativeDone) cursor.after = result.parent;
      continue;
    }
    if (kind === 'collectionLocal') {
      if (result.blocked) cursor.blockedCollection ??= cursor.parent;
      if (result.blocked || result.collectionDone) {
        cursor.after = cursor.parent;
        cursor.parent = null;
        cursor.child = 0;
        cursor.retain = false;
      }
      continue;
    }
    if (!parentPhase) {
      if (result.removed < 100 && !result.hasMore) cursor.phase++;
      continue;
    }
    if (cursor.parent === null) {
      if (result.parent === null) {
        cursor.phase++;
        cursor.after = null;
      } else if (result.blocked) {
        // Preserve the source authority until exact remote withdrawal is available.
        cursor.blockedCollection ??= result.parent;
        cursor.after = result.parent;
      } else {
        cursor.parent = result.parent;
        cursor.retain = result.retain;
        cursor.child = 0;
      }
      continue;
    }
    const parentDelete = kind === 'sessionDelete';
    if (parentDelete && result.removed !== 1) throw new Error('Graph parent still has undisposed children');
    if (result.removed < 100) cursor.child++;
    if (cursor.child === children.length) {
      cursor.after = cursor.parent;
      cursor.parent = null;
      cursor.child = 0;
      cursor.retain = false;
    }
  }
  return { stats, cursor, exhausted: cursor.phase === OWNED_PHASES.length };
}
