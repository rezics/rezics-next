import type { KeyRing } from '../tokens/seal.ts';
import { decodeCursor, encodeCursor, type CursorBinding } from '../tokens/cursor.ts';
import type { Anchored, AnchoredPosition, Page, ReadContext } from './model.ts';
import type { ItemView, PostEntry, RevisionView } from './reads.ts';

type RevisionKey = Readonly<{ at: string; id: string }>;

/** A native disclosure retains its original observations and prepared Access
 * checks. Revalidation must not adopt newly changed source rows as a baseline.
 */
export type HistoryPostObservation = Readonly<{
  initial: Anchored<PostEntry | null>;
  current(): Promise<Anchored<PostEntry | null>>;
}>;

export type NativePostRevisionPage = Page<RevisionView> &
  Readonly<{
    /** Exact native posts, in the same order as entries; no second hydration. */
    posts: readonly ItemView[];
    anchors: readonly AnchoredPosition[];
  }>;

type Dependencies = Readonly<{
  tokens: KeyRing;
  now(): number;
  observe(revisionId?: string): Promise<HistoryPostObservation>;
  select(after: RevisionKey | null, limit: number): Promise<
    Anchored<Readonly<{ candidates: readonly RevisionKey[]; nextKey: RevisionKey | null }>>
  >;
  unavailable(): never;
}>;

/** One raw native page. Candidate keys never grant disclosure, and a sparse
 * page never causes a refill or moves the cursor beyond the admitted frontier.
 * All callbacks are bound by reads.ts to the ordinary native source authority.
 */
export async function readNativePostRevisionPage(
  dependencies: Dependencies,
  input: Readonly<{ threadId: string; postId: string; context: ReadContext; cursor?: string; limit: number }>,
): Promise<NativePostRevisionPage> {
  const { limit, threadId, postId, context, cursor } = input;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('Page limit must be 1 to 100');
  const source = await dependencies.observe();
  const initial = source.initial;
  if (!initial.value) return dependencies.unavailable();
  const binding: CursorBinding = {
    operation: 'content.revisions',
    parameters: { threadId, postId, viewer: context.actor.kind === 'account' ? context.actor.accountId : null },
  };
  let after: RevisionKey | null = null;
  if (cursor !== undefined) {
    const decoded = decodeCursor(dependencies.tokens, binding, cursor, dependencies.now());
    if (
      !decoded.ok ||
      decoded.epoch !== initial.anchor.epoch ||
      decoded.after.length !== 2 ||
      typeof decoded.after[0] !== 'string' ||
      typeof decoded.after[1] !== 'string'
    )
      throw new TypeError('Invalid content cursor');
    after = { at: decoded.after[0], id: decoded.after[1] };
  }

  const anchors = [initial.anchor];
  const selected =
    initial.value.availability === 'available'
      ? await dependencies.select(after, limit)
      : { value: { candidates: [], nextKey: null }, anchor: initial.anchor };
  if (selected.anchor.epoch !== initial.anchor.epoch) return dependencies.unavailable();
  anchors.push(selected.anchor);
  const observed: { key: RevisionKey; observation: HistoryPostObservation }[] = [];
  for (const key of selected.value.candidates) {
    const observation = await dependencies.observe(key.id);
    anchors.push(observation.initial.anchor);
    if (observation.initial.anchor.epoch !== initial.anchor.epoch) return dependencies.unavailable();
    if (observation.initial.value) observed.push({ key, observation });
  }

  const posts: ItemView[] = [];
  const entries: RevisionView[] = [];
  // Reuse each exact disclosure's original prepared checks, rather than running
  // a fresh exact read which could silently accept a changed source identity.
  for (const { key, observation } of observed) {
    const final = await observation.current();
    anchors.push(final.anchor);
    const value = final.value;
    if (
      !value ||
      final.anchor.epoch !== initial.anchor.epoch ||
      !('revisionId' in value) ||
      value.availability === 'withheld' ||
      value.id !== postId ||
      value.threadId !== threadId ||
      value.revisionId !== key.id
    )
      return dependencies.unavailable();
    posts.push(value);
    const {
      revisionId,
      id,
      parentId: _parentId,
      visibility: _visibility,
      securityRevision: _securityRevision,
      ...revision
    } = value;
    entries.push({ ...revision, id: revisionId, itemId: id, createdAt: key.at });
  }
  // Empty, removed and sparse pages have the same final source check. A changed
  // head, container, epoch or current authorization withholds the entire page.
  const finalSource = await source.current();
  if (!finalSource.value || finalSource.anchor.epoch !== initial.anchor.epoch) return dependencies.unavailable();
  anchors.push(finalSource.anchor);
  const frontier = selected.value.candidates.at(-1);
  return {
    entries,
    posts,
    anchors,
    anchor: finalSource.anchor,
    nextCursor:
      selected.value.nextKey && frontier
        ? encodeCursor(
            dependencies.tokens,
            binding,
            { epoch: finalSource.anchor.epoch, after: [frontier.at, frontier.id] },
            dependencies.now(),
          )
        : null,
  };
}
