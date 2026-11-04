import { createHash } from 'node:crypto';
import { deadlineClient, within } from '../access/authenticate.ts';
import { readPublicViews } from '../access/public-views.ts';
import { CommandUnavailableError } from '../command/command.ts';
import { withConnection, discardConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import { readPartition } from '../partition/partition.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { actorOf, AuthenticationError, type Actor } from '../request/access.ts';
import { decodeCursor, encodeCursor } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { AuthorContextReference } from './author-item-context.ts';
import type {
  AuthorContributionActionsInput,
  AuthorContributionSelection,
} from './author-contribution-actions-schema.ts';
import { readThread, readPost } from './reads.ts';
import type { AnchoredPosition } from './model.ts';
import {
  createContentReadingCardBatch,
  normalizeSelectedReadingCardReferences,
  type ReadingPageDependencies,
  type SelectedReadingCardReference,
} from './reading-page.ts';

type View = AuthorContributionActionsInput['view'];
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const changed = () =>
  new ProblemError('dependency_unavailable', { detail: 'The selected author contribution changed' });
async function observeSource<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof CommandUnavailableError && error.reason === 'moved') throw changed();
    throw error;
  }
}
const publicItem = (item: { availability: string; visibility?: string }) =>
  item.availability === 'available' && (item.visibility === 'published' || item.visibility === 'protected');
const sourceRevision = (item: { availability: string; revisionId?: string }) => {
  if (item.availability !== 'available') return null;
  if (!item.revisionId) throw changed();
  return item.revisionId;
};

function referencesOf(selected: readonly AuthorContextReference[]): AuthorContributionSelection['references'] {
  return selected.map(({ thread, post }) =>
    post
      ? {
          type: 'content.post',
          id: post.id,
          threadId: thread.id,
          placeId: thread.boardId,
          threadRevisionId: sourceRevision(thread.firstPost),
          sourceRevisionId: sourceRevision(post),
        }
      : {
          type: 'content.thread',
          id: thread.id,
          placeId: thread.boardId,
          sourceRevisionId: sourceRevision(thread.firstPost),
        },
  );
}

// Only native observations enter the digest. No authored body is retained in a token.
const observation = (selected: readonly AuthorContextReference[]) =>
  hash(selected.map(({ thread, post }) => ({ thread, post: post ?? null })));
const canonical = (references: readonly SelectedReadingCardReference[]) =>
  references.map((reference) =>
    reference.type === 'content.thread'
      ? {
          type: reference.type,
          id: reference.id,
          placeId: reference.placeId,
          sourceRevisionId: reference.sourceRevisionId,
        }
      : {
          type: reference.type,
          id: reference.id,
          threadId: reference.threadId,
          placeId: reference.placeId,
          threadRevisionId: reference.threadRevisionId,
          sourceRevisionId: reference.sourceRevisionId,
        },
  );
const scope = (references: readonly SelectedReadingCardReference[]) => ({
  operation: 'author.contribution.selection',
  parameters: { references: hash(canonical(references)) },
});

/** Called only by the anonymous author reader after its final native disclosure/publication checks. */
export function issueAuthorContributionSelection(
  tokens: KeyRing,
  accountId: string,
  view: View,
  cursor: string | undefined,
  selected: readonly AuthorContextReference[],
  anchor: AnchoredPosition,
  now: number,
): AuthorContributionSelection {
  if (selected.length === 0 || selected.length > 20) throw new RangeError('Select 1 to 20 author contributions');
  const references = referencesOf(selected);
  normalizeSelectedReadingCardReferences(references);
  return {
    references,
    proof: encodeCursor(
      tokens,
      scope(references),
      {
        epoch: anchor.epoch,
        after: [accountId, view, cursor ?? '', observation(selected)],
      },
      now,
    ),
  };
}

/** A public token is admission to a selected read, never authority for a command. */
function admission(tokens: KeyRing, accountId: string, input: AuthorContributionActionsInput, now: number) {
  const references = canonical(normalizeSelectedReadingCardReferences(input.references));
  if (references.length === 0 || references.length !== input.references.length)
    throw new ProblemError('invalid_request');
  const decoded = decodeCursor(tokens, scope(references), input.proof, now);
  if (!decoded.ok || decoded.after.length !== 4) throw new ProblemError('invalid_request');
  const [author, view, cursor, witness] = decoded.after;
  if (author !== accountId) throw new ProblemError('not_found');
  if (
    view !== input.view ||
    cursor !== (input.cursor ?? '') ||
    typeof witness !== 'string' ||
    !/^[a-f0-9]{64}$/.test(witness)
  )
    throw new ProblemError('invalid_request');
  return { references, epoch: decoded.epoch, witness };
}

async function publication(
  dependencies: ReadingPageDependencies,
  accountId: string,
  view: View,
  epoch: number,
  deadline: number,
): Promise<AnchoredPosition> {
  const route = routeOf(accountId);
  if (route === null) throw new ProblemError('not_found');
  return within(deadline, () =>
    withConnection(dependencies.pool, async (connection) => {
      const client = deadlineClient(connection, deadline);
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        await client.query("SET LOCAL statement_timeout = '3000ms'");
        const partition = await readPartition(client, partitionOf(route));
        if (!partition || partition.writeState === 'moved' || partition.epoch !== epoch) throw changed();
        const views = (await readPublicViews(client, [accountId])).get(accountId);
        if (!(view === 'reviews' ? views?.reviews : views?.posts)) throw new ProblemError('not_found');
        await client.query('COMMIT');
        return { partition, epoch: partition.epoch, position: partition.position };
      } catch (error) {
        try {
          await connection.query('ROLLBACK');
        } catch (rollback) {
          discardConnection(connection, rollback as Error);
        }
        throw error;
      }
    }),
  );
}

/** Reuse exact native source/ancestry/place disclosure as anonymous, even for an author or editor. */
async function sources(
  dependencies: ReadingPageDependencies,
  accountId: string,
  view: View,
  references: readonly SelectedReadingCardReference[],
  deadline: number,
) {
  const context = { actor: { kind: 'anonymous' as const }, deadline };
  const threads = new Map<string, Awaited<ReturnType<typeof readThread>>>();
  const parents = new Map<string, string>();
  const selected: AuthorContextReference[] = [];
  const anchors: AnchoredPosition[] = [];
  for (const reference of references) {
    const threadId = reference.type === 'content.post' ? reference.threadId : reference.id;
    let read = threads.get(threadId);
    if (!read) {
      read = await observeSource(() => readThread(dependencies, threadId, context));
      threads.set(threadId, read);
      anchors.push(read.anchor);
    }
    const thread = read.value;
    if (!thread || !publicItem(thread) || thread.boardId !== reference.placeId) throw changed();
    if (reference.type === 'content.thread') {
      if (
        view === 'posts' ||
        thread.kind !== (view === 'reviews' ? 'review' : 'discussion') ||
        thread.authorId !== accountId ||
        !publicItem(thread.firstPost)
      )
        throw changed();
      selected.push({ thread });
    } else {
      if (
        view !== 'posts' ||
        reference.id === thread.firstPost.id ||
        (thread.firstPost.availability !== 'erased' && !publicItem(thread.firstPost))
      )
        throw changed();
      const post = await observeSource(() => readPost(dependencies, threadId, reference.id, context));
      anchors.push(post.anchor);
      if (
        !post.value ||
        post.value.availability !== 'available' ||
        !publicItem(post.value) ||
        post.value.authorId !== accountId
      )
        throw changed();
      selected.push({ thread, post: post.value });
      // Disclosure of the child proves access to its ancestry, but does not
      // retain a parent's revision. Observe each immediate parent once so a
      // replacement during private assembly cannot silently pass that fence.
      const parentId = post.value.parentId;
      if (parentId && !parents.has(parentId)) {
        const parent = await observeSource(() => readPost(dependencies, threadId, parentId, context));
        anchors.push(parent.anchor);
        if (!parent.value) throw changed();
        parents.set(parentId, hash(parent.value));
      }
    }
  }
  if (JSON.stringify(referencesOf(selected)) !== JSON.stringify(references)) throw changed();
  return {
    witness: observation(selected),
    parents: hash([...parents]),
    anchors,
  };
}

function confirmSources(initial: Awaited<ReturnType<typeof sources>>, final: Awaited<ReturnType<typeof sources>>) {
  if (initial.witness !== final.witness || initial.parents !== final.parents) throw changed();
  if (initial.anchors.length !== final.anchors.length) throw changed();
  for (let index = 0; index < initial.anchors.length; index++) {
    const before = initial.anchors[index]!;
    const after = final.anchors[index]!;
    if (
      before.partition.partitionNo !== after.partition.partitionNo ||
      before.partition.node !== after.partition.node ||
      before.epoch !== after.epoch ||
      before.partition.writeState === 'moved' ||
      after.partition.writeState === 'moved' ||
      after.position < before.position
    )
      throw changed();
  }
}

function confirmPublication(before: AnchoredPosition, after: AnchoredPosition) {
  if (
    before.partition.partitionNo !== after.partition.partitionNo ||
    before.partition.node !== after.partition.node ||
    before.epoch !== after.epoch ||
    before.partition.writeState === 'moved' ||
    after.partition.writeState === 'moved' ||
    after.position < before.position
  )
    throw changed();
}

/** One admitted page, one retained native batch, and complete public disclosure on both sides of assembly. */
export async function readAuthorContributionActions(
  dependencies: ReadingPageDependencies,
  accountId: string,
  input: AuthorContributionActionsInput,
  actor: Actor,
  request: Request,
  deadline: number,
) {
  const selected = admission(dependencies.tokens, accountId, input, (dependencies.clock?.() ?? new Date()).getTime());
  const firstPublication = await publication(dependencies, accountId, input.view, selected.epoch, deadline);
  const initial = await sources(dependencies, accountId, input.view, selected.references, deadline);
  if (initial.witness !== selected.witness) throw changed();
  const batch = await createContentReadingCardBatch(dependencies, selected.references, actor, deadline);
  const result = await batch.finish();
  const final = await sources(dependencies, accountId, input.view, selected.references, deadline);
  if (final.witness !== selected.witness) throw changed();
  confirmSources(initial, final);
  let lastPublication: AnchoredPosition;
  try {
    lastPublication = await publication(dependencies, accountId, input.view, selected.epoch, deadline);
  } catch (error) {
    if (error instanceof ProblemError && error.code === 'not_found') throw changed();
    throw error;
  }
  confirmPublication(firstPublication, lastPublication);
  const currentActor = await actorOf(dependencies.access, request, { pool: dependencies.pool, deadline });
  if (JSON.stringify(currentActor) !== JSON.stringify(actor)) throw new AuthenticationError(401, 'Bearer');
  return {
    value: {
      viewer: result.viewer,
      selected: result.selected.map(({ reference, state, reply }) => ({ reference, state, reply })),
      reactions: { ...result.reactions, items: [...result.reactions.items] },
      actions: {
        ...result.actions,
        references: result.actions.references.map((reference) => ({
          ...reference,
          operations: [...reference.operations],
        })),
      },
      watch: { ...result.watch, items: [...result.watch.items] },
      currentness: result.currentness,
    },
    anchors: [firstPublication, ...initial.anchors, ...result.anchors, ...final.anchors, lastPublication],
  };
}
