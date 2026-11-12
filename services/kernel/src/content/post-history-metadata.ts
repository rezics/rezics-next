import type { CursorBinding } from '../tokens/cursor.ts';
import { decodeCursor, encodeCursor } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { Anchored, AnchoredPosition, ReadContext } from './model.ts';
import {
  ContentNotFoundError,
  readPostMetadata,
  snapshot,
  type ContentReadDependencies,
  type NativePostMetadata,
  type RetainContentRead,
} from './reads.ts';
import { pageRevisionCandidates } from './revision-pages.ts';

/** Recorded revision display data only. Current account names, current titles,
 * document bytes and placeholder bodies are deliberately outside this projection.
 */
export type PostRevisionHeader = Readonly<{
  postId: string;
  threadId: string;
  revisionId: string;
  sha256: string;
  recordedAt: string;
  authorId: string;
  licence: string;
  kind: 'discussion' | 'review';
  documentKind: 'opening' | 'reply';
  subjectIds: string[];
}>;

export type PostRevisionHeadersPage = Readonly<{
  revisions: PostRevisionHeader[];
  next: string | null;
  /** Internal observations, consumed only after the complete page passes. */
  anchors: readonly AnchoredPosition[];
}>;

type RevisionKey = Readonly<{ at: string; id: string }>;
type Observation = Readonly<{
  initial: Anchored<NativePostMetadata | null>;
  current: Parameters<RetainContentRead<NativePostMetadata>>[0];
}>;

type Dependencies = Readonly<{
  tokens: KeyRing;
  now(): number;
  observe(revisionId?: string): Promise<Observation>;
  select(
    after: RevisionKey | null,
    limit: number,
  ): Promise<Anchored<Readonly<{ candidates: readonly RevisionKey[]; nextKey: RevisionKey | null }>>>;
}>;

type Input = Readonly<{
  threadId: string;
  postId: string;
  context: ReadContext;
  cursor?: string;
  limit: number;
}>;

function header(value: NativePostMetadata, recordedAt: string): PostRevisionHeader {
  return {
    postId: value.id,
    threadId: value.threadId,
    revisionId: value.revisionId,
    sha256: value.sha256,
    recordedAt,
    authorId: value.authorId,
    licence: value.licence,
    kind: value.kind,
    documentKind: value.documentKind,
    subjectIds: [...value.subjectIds],
  };
}

/** One raw key page, with the same native exact authority as a body read. A
 * hidden/erased key consumes its slot; selection never refills to find visible rows.
 * Retained callbacks re-evaluate the original observations and prepared checks.
 */
export async function readNativePostRevisionHeaders(
  dependencies: Dependencies,
  input: Input,
): Promise<PostRevisionHeadersPage> {
  const { threadId, postId, context, cursor, limit } = input;
  const source = await dependencies.observe();
  if (!source.initial.value) throw new ContentNotFoundError();
  const epoch = source.initial.anchor.epoch;
  const binding: CursorBinding = {
    operation: 'content.revision-headers',
    parameters: { threadId, postId, viewer: context.actor.kind === 'account' ? context.actor.accountId : null },
  };
  let after: RevisionKey | null = null;
  if (cursor !== undefined) {
    const decoded = decodeCursor(dependencies.tokens, binding, cursor, dependencies.now());
    if (
      !decoded.ok ||
      decoded.epoch !== epoch ||
      decoded.after.length !== 2 ||
      typeof decoded.after[0] !== 'string' ||
      typeof decoded.after[1] !== 'string'
    )
      throw new TypeError('Invalid content cursor');
    after = { at: decoded.after[0], id: decoded.after[1] };
  }

  const selected = await dependencies.select(after, limit);
  if (selected.anchor.epoch !== epoch) throw new ContentNotFoundError();
  const anchors = [source.initial.anchor, selected.anchor];
  const admitted: { key: RevisionKey; observation: Observation }[] = [];
  for (const key of selected.value.candidates) {
    const observation = await dependencies.observe(key.id);
    anchors.push(observation.initial.anchor);
    if (observation.initial.anchor.epoch !== epoch) throw new ContentNotFoundError();
    // A storage key has no authority. Null native disclosure emits no metadata.
    if (observation.initial.value) admitted.push({ key, observation });
  }

  const revisions: PostRevisionHeader[] = [];
  for (const { key, observation } of admitted) {
    const initial = observation.initial.value!;
    const final = await observation.current();
    anchors.push(final.anchor);
    if (
      !final.value ||
      final.anchor.epoch !== epoch ||
      final.value.id !== postId ||
      final.value.threadId !== threadId ||
      final.value.revisionId !== key.id ||
      JSON.stringify(final.value) !== JSON.stringify(initial)
    )
      throw new ContentNotFoundError();
    // The keyset timestamp preserves PostgreSQL microseconds; it is the selected
    // revision's recorded_at, never the current head's revisedAt or wall time.
    revisions.push(header(final.value, key.at));
  }
  // Even an empty/sparse page retains the original source. Do this last so a
  // changed head/container/authority cannot be adopted as a fresh baseline.
  const finalSource = await source.current();
  anchors.push(finalSource.anchor);
  if (
    !finalSource.value ||
    finalSource.anchor.epoch !== epoch ||
    JSON.stringify(finalSource.value) !== JSON.stringify(source.initial.value)
  )
    throw new ContentNotFoundError();

  const frontier = selected.value.candidates.at(-1);
  return {
    revisions,
    anchors,
    next:
      selected.value.nextKey && frontier
        ? encodeCursor(dependencies.tokens, binding, { epoch, after: [frontier.at, frontier.id] }, dependencies.now())
        : null,
  };
}

/** Bind the selector to native source reads without a body reader, document
 * parser, account directory or foreign enrichment in its dependency graph.
 */
export function listPostRevisionHeaders(
  dependencies: ContentReadDependencies,
  threadId: string,
  postId: string,
  context: ReadContext,
  cursor?: string,
  limit = 20,
): Promise<PostRevisionHeadersPage> {
  return readNativePostRevisionHeaders(
    {
      tokens: dependencies.tokens,
      now: () => dependencies.clock().getTime(),
      async observe(revisionId) {
        let current: Observation['current'] | undefined;
        const initial = await readPostMetadata(dependencies, threadId, postId, context, revisionId, (read) => {
          current = read;
        });
        return { initial, current: current ?? (async () => ({ ...initial, value: null })) };
      },
      select: (after, selectedLimit) =>
        snapshot(dependencies, threadId, context, (client) =>
          pageRevisionCandidates(client, { postId, after, limit: selectedLimit }),
        ),
    },
    { threadId, postId, context, ...(cursor !== undefined ? { cursor } : {}), limit },
  );
}
