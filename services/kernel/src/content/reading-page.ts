import { readAccountDiscoverySummaries } from '../access/account-discovery-source.ts';
import { readViewerActions, type ViewerActionBindings } from '../access/viewer-actions.ts';
import { classifyUnavailability } from '../access/unavailable.ts';
import { ProblemError } from '../http/problem.ts';
import type { Access, Actor } from '../request/access.ts';
import { t } from 'elysia';
import { MAX_DOCUMENT_BYTES } from './document.ts';
import { readAuthorErasureAdmission, type AuthorErasureAdmission } from './author-erasure-admission.ts';
import { BoardSlowAdmissionUnavailableError, readBoardSlowMode } from './board-slow.ts';
import { readThreadWatchState } from './watch.ts';
import {
  ContentNotFoundError,
  withThreadReadAdmission,
  listThreadPosts,
  readThread,
  withReactionCounts,
  withViewerReactions,
  readBoard,
} from './reads.ts';
import type { ContentReadDependencies, PostEntry, ThreadView } from './reads.ts';
import type { AnchoredPosition } from './model.ts';
import type { ViewerActionResources } from '../access/viewer-actions.ts';
import { ItemViewSchema, ErasedPlaceholderSchema, ThreadViewSchema } from './schemas.ts';

const closed = { additionalProperties: false } as const;
export const READING_PAGE_REPLY_LIMIT = 20;
const RAW_REPLY_PAGE_LIMIT = READING_PAGE_REPLY_LIMIT + 1;
export const READING_PAGE_REQUEST_BYTES = 8 * 1024;
const READING_PAGE_IDENTITY_LIMIT = READING_PAGE_REPLY_LIMIT + 1;
const READING_PAGE_REFERENCE_LIMIT = READING_PAGE_REPLY_LIMIT + 2;
const MAX_AUTHOR_DISPLAY_BYTES = 32 * 1024;
const MAX_REACTION_BYTES = 16 * 1024;
const MAX_OTHER_ENVELOPE_BYTES = 256 * 1024;
// A JSON string can expand a source byte to six bytes when controls are escaped.
export const READING_PAGE_RESPONSE_BYTES =
  READING_PAGE_IDENTITY_LIMIT * MAX_DOCUMENT_BYTES * 6 +
  READING_PAGE_IDENTITY_LIMIT * MAX_AUTHOR_DISPLAY_BYTES +
  MAX_OTHER_ENVELOPE_BYTES;

const ReactionFreshnessSchema = t.Union([
  t.Object({ epoch: t.Integer({ minimum: 0 }), position: t.String({ pattern: '^(0|[1-9][0-9]*)$' }) }, closed),
  t.Null(),
]);
const AvatarSchema = t.Union([
  t.Object(
    {
      media: t.String({ format: 'uuid' }),
      width: t.Integer({ minimum: 1 }),
      height: t.Integer({ minimum: 1 }),
      placeholder: t.Object(
        { thumbhash: t.String({ maxLength: 44 }), color: t.String({ pattern: '^#[0-9a-f]{6}$' }) },
        closed,
      ),
      variants: t.Array(
        t.Object({ format: t.Union([t.Literal('avif'), t.Literal('webp')]), width: t.Integer({ minimum: 1 }) }, closed),
        { maxItems: 12 },
      ),
      focalPoint: t.Union([
        t.Object({ x: t.Number({ minimum: 0, maximum: 1 }), y: t.Number({ minimum: 0, maximum: 1 }) }, closed),
        t.Null(),
      ]),
      credit: t.Null(),
    },
    closed,
  ),
  t.Null(),
]);
const AuthorSchema = t.Object(
  {
    id: t.String({ format: 'uuid' }),
    displayName: t.Union([t.String({ maxLength: 4096 }), t.Null()]),
    handle: t.Union([t.String({ maxLength: 64 }), t.Null()]),
    avatar: AvatarSchema,
  },
  closed,
);
const SafeWithheldEntrySchema = t.Object(
  {
    id: t.String({ format: 'uuid' }),
    threadId: t.String({ format: 'uuid' }),
    route: t.Integer({ minimum: 0, maximum: 4095 }),
    parentId: t.Union([t.String({ format: 'uuid' }), t.Null()]),
    removed: t.Literal(true),
    availability: t.Literal('withheld'),
    body: t.Null(),
    sha256: t.Null(),
  },
  closed,
);
const ReadingEntrySchema = t.Union([ItemViewSchema, ErasedPlaceholderSchema, SafeWithheldEntrySchema]);
const OperationStateSchema = t.Union([
  t.Literal('available'),
  t.Literal('sign_in_required'),
  t.Literal('denied'),
  t.Literal('withheld'),
  t.Literal('unavailable'),
  t.Literal('not_applicable'),
]);
const OperationSchema = t.Object(
  {
    action: t.String(),
    operationId: t.String(),
    state: OperationStateSchema,
  },
  closed,
);
const ReplyStateSchema = t.Union([
  t.Literal('available'),
  t.Literal('sign_in_required'),
  t.Literal('denied'),
  t.Literal('withheld'),
  t.Literal('unavailable'),
]);
export const ReadingPageQuerySchema = t.Object(
  { cursor: t.Optional(t.String({ minLength: 1, maxLength: 4096 })) },
  closed,
);
export const ReadingPageResponseSchema = t.Object(
  {
    target: t.Object(
      {
        threadId: t.String({ format: 'uuid' }),
        boardId: t.String({ format: 'uuid' }),
        boardSecurityRevision: t.String({ pattern: '^[1-9][0-9]*$' }),
      },
      closed,
    ),
    viewer: t.Union([
      t.Object({ kind: t.Literal('anonymous') }, closed),
      t.Object({ kind: t.Literal('account'), id: t.String({ format: 'uuid' }) }, closed),
    ]),
    query: t.Object({ cursor: t.Union([t.String(), t.Null()]), limit: t.Literal(READING_PAGE_REPLY_LIMIT) }, closed),
    thread: ThreadViewSchema,
    replies: t.Object(
      { items: t.Array(ReadingEntrySchema, { maxItems: READING_PAGE_REPLY_LIMIT }), next: t.Union([t.String(), t.Null()]) },
      closed,
    ),
    authors: t.Object(
      {
        state: t.Union([t.Literal('current'), t.Literal('unavailable')]),
        retryable: t.Boolean(),
        items: t.Array(AuthorSchema, { maxItems: READING_PAGE_IDENTITY_LIMIT }),
      },
      closed,
    ),
    actions: t.Object(
      {
        state: t.Union([t.Literal('current'), t.Literal('unavailable')]),
        retryable: t.Boolean(),
        references: t.Array(
          t.Object(
            {
              type: t.Union([t.Literal('content.thread'), t.Literal('content.post')]),
              id: t.String({ format: 'uuid' }),
              sourceRevisionId: t.Optional(t.String({ format: 'uuid' })),
              state: t.Union([t.Literal('current'), t.Literal('withheld')]),
              operations: t.Array(OperationSchema, { maxItems: 256 }),
            },
            closed,
          ),
          { maxItems: READING_PAGE_REFERENCE_LIMIT },
        ),
        reply: t.Object({ state: ReplyStateSchema }, closed),
      },
      closed,
    ),
    watch: t.Union([
      t.Object({ state: t.Literal('current'), watching: t.Boolean() }, closed),
      t.Object({ state: t.Literal('sign_in_required') }, closed),
      t.Object({ state: t.Literal('unavailable'), retryable: t.Literal(true) }, closed),
    ]),
    slowMode: t.Union([
      t.Object(
        {
          state: t.Literal('current'),
          intervalSeconds: t.Integer({ minimum: 0, maximum: 86400 }),
          retryAt: t.Union([t.String({ format: 'date-time' }), t.Null()]),
          nextEligibleAt: t.Union([t.String({ format: 'date-time' }), t.Null()]),
          canChange: t.Boolean(),
          exempt: t.Boolean(),
          admissionState: t.Union([t.Literal('ready'), t.Literal('interval'), t.Literal('pending')]),
          retryAfterSeconds: t.Integer({ minimum: 0, maximum: 86400 }),
        },
        closed,
      ),
      t.Object({ state: t.Literal('unavailable'), retryable: t.Literal(true) }, closed),
    ]),
    currentness: t.Object(
      {
        source: t.Literal('current'),
        place: t.Literal('current'),
        reactions: t.Literal('current'),
        authors: t.Union([t.Literal('current'), t.Literal('unavailable')]),
        actions: t.Union([t.Literal('current'), t.Literal('unavailable')]),
        watch: t.Union([t.Literal('current'), t.Literal('sign_in_required'), t.Literal('unavailable')]),
        slowMode: t.Union([t.Literal('current'), t.Literal('unavailable')]),
      },
      closed,
    ),
    reactionsAsOf: ReactionFreshnessSchema,
    authorErasure: t.Optional(t.Object({ authorId: t.String({ format: 'uuid' }), mayErase: t.Boolean() }, closed)),
  },
  closed,
);

export type ReadingPageViewerActionRuntime = Readonly<{
  access: Access;
  resources: ViewerActionResources;
  bindings: ViewerActionBindings;
  guestSecurity: ReadonlyMap<string, 'anonymous' | 'authenticated' | 'unknown'>;
  clock: () => Date;
}>;
export type ReadingPageDependencies = ContentReadDependencies &
  Readonly<{
    routeKey: Uint8Array;
    viewerActionRuntime?: () => ReadingPageViewerActionRuntime;
  }>;

type EntryWithReaction = PostEntry & {
  readonly viewerReaction?: string | null;
  readonly reactions?: Readonly<Record<string, number>>;
};
type AccountSummaryMap = Awaited<ReturnType<typeof readAccountDiscoverySummaries>>;
type AccountSummaryValue = AccountSummaryMap extends ReadonlyMap<string, infer Value> ? Value : never;
type AccountSummary = NonNullable<AccountSummaryValue>;
type AuthorView = Pick<AccountSummary, 'id' | 'displayName' | 'handle' | 'avatar'>;
type SafeWithheldEntry = Readonly<{
  id: string;
  threadId: string;
  route: number;
  parentId: string | null;
  removed: true;
  availability: 'withheld';
  body: null;
  sha256: null;
}>;
type ControlState = 'available' | 'sign_in_required' | 'denied' | 'withheld' | 'unavailable' | 'not_applicable';
type ReadingOperation = { action: string; operationId: string; state: ControlState };
type ReadingReference = {
  type: 'content.thread' | 'content.post';
  id: string;
  sourceRevisionId?: string;
  state: 'current' | 'withheld';
  operations: ReadingOperation[];
};

function safeEntry(entry: EntryWithReaction): EntryWithReaction | SafeWithheldEntry {
  if (entry.availability !== 'withheld') return entry;
  return {
    id: entry.id,
    threadId: entry.threadId,
    route: entry.route,
    parentId: entry.parentId,
    removed: true,
    availability: 'withheld',
    body: null,
    sha256: null,
  };
}

function entryWitness(entry: PostEntry) {
  const hasRevision = 'revisionId' in entry;
  return [
    entry.id,
    entry.threadId,
    entry.route,
    entry.parentId,
    entry.availability,
    hasRevision ? entry.revisionId : null,
    'securityRevision' in entry ? entry.securityRevision : null,
    'visibility' in entry ? entry.visibility : null,
  ];
}

function threadWitness(thread: ThreadView) {
  return JSON.stringify([
    thread.id,
    thread.route,
    thread.authorId,
    thread.kind,
    thread.title,
    thread.licence,
    thread.subjectIds,
    thread.boardId,
    thread.visibility,
    thread.securityRevision,
    thread.availability,
    thread.firstPost && entryWitness(thread.firstPost),
  ]);
}

function boardWitness(board: NonNullable<Awaited<ReturnType<typeof readBoard>>['value']>) {
  return JSON.stringify([
    board.id,
    board.route,
    board.realmId,
    board.title,
    board.purpose,
    board.visibility,
    board.securityRevision,
    board.availability,
    board.createdAt,
  ]);
}

function slowModeWitness(value: Awaited<ReturnType<typeof readBoardSlowMode>>) {
  return JSON.stringify([
    value.intervalSeconds,
    value.retryAt,
    value.nextEligibleAt,
    value.canChange,
    value.exempt,
    value.admissionState,
    value.retryAfterSeconds,
  ]);
}

function replyWitness(entries: readonly PostEntry[], hasNext: boolean) {
  return JSON.stringify([entries.map(entryWitness), hasNext]);
}

function requireSelectedLimit(thread: ThreadView, entries: readonly PostEntry[]): void {
  if (!thread.firstPost || entries.length > READING_PAGE_REPLY_LIMIT)
    throw new ProblemError('dependency_unavailable', { detail: 'The current reading page exceeded its native bound' });
}

async function readReplyPage(
  dependencies: ReadingPageDependencies,
  threadId: string,
  actor: Actor,
  deadline: number,
  openingPostId: string,
  cursor?: string,
) {
  const context = { actor, deadline };
  const page = await listThreadPosts(
    dependencies,
    threadId,
    context,
    cursor,
    readingPageRawLimit(cursor),
  );
  return { page, replies: page.entries.filter((entry) => entry.id !== openingPostId) };
}

function authorIds(opening: PostEntry, replies: readonly PostEntry[]): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const entry of [opening, ...replies]) {
    if (entry.availability !== 'available' || !('authorId' in entry) || seen.has(entry.authorId)) continue;
    seen.add(entry.authorId);
    ids.push(entry.authorId);
  }
  if (ids.length > READING_PAGE_IDENTITY_LIMIT) throw new RangeError('Reading page identity bound exceeded');
  return ids;
}

function applicableBindings(bindings: ViewerActionBindings, type: ReadingReference['type'], id: string) {
  return (bindings.get(type) ?? []).filter((binding) => binding.fixedResourceId === undefined || binding.fixedResourceId === id);
}

export function readingPageOperationState(
  actor: Actor,
  operationId: string,
  allowed: ReadonlySet<string>,
  guestSecurity: ReadonlyMap<string, 'anonymous' | 'authenticated' | 'unknown'>,
  watch: { state: 'current'; watching: boolean } | { state: 'sign_in_required' } | { state: 'unavailable'; retryable: true },
): ControlState {
  if (operationId === 'thread.watch_state') return 'not_applicable';
  if (operationId === 'thread.watch' || operationId === 'thread.unwatch') {
    if (watch.state === 'unavailable') return 'unavailable';
    if (actor.kind === 'anonymous') return 'sign_in_required';
    if (watch.state !== 'current') return 'unavailable';
    if ((operationId === 'thread.watch' && watch.watching) || (operationId === 'thread.unwatch' && !watch.watching))
      return 'not_applicable';
  }
  if (actor.kind === 'anonymous') {
    const security = guestSecurity.get(operationId) ?? 'unknown';
    if (security === 'authenticated') return 'sign_in_required';
    if (security === 'unknown') return 'unavailable';
  }
  if (allowed.has(operationId)) return 'available';
  return 'denied';
}

function projectedReferences(
  actor: Actor,
  bindings: ViewerActionBindings,
  guestSecurity: ReadonlyMap<string, 'anonymous' | 'authenticated' | 'unknown'>,
  references: readonly Readonly<{ type: ReadingReference['type']; id: string; sourceRevisionId?: string }>[],
  results: readonly Readonly<{ type: string; id: string; error?: string; viewerActions?: readonly { action: string; operations: readonly string[] }[] }>[],
  watch: { state: 'current'; watching: boolean } | { state: 'sign_in_required' } | { state: 'unavailable'; retryable: true },
): ReadingReference[] {
  const byKey = new Map(results.map((result) => [`${result.type}/${result.id}`, result]));
  return references.map((reference) => {
    const result = byKey.get(`${reference.type}/${reference.id}`);
    if (!result || result.error === 'not_found')
      return { ...reference, state: 'withheld', operations: [] };
    const permitted = new Set((result.viewerActions ?? []).flatMap((entry) => entry.operations));
    const operations = applicableBindings(bindings, reference.type, reference.id).map((binding) => ({
      action: binding.action,
      operationId: binding.operationId,
      state: readingPageOperationState(actor, binding.operationId, permitted, guestSecurity, watch),
    }));
    return { ...reference, state: 'current', operations };
  });
}

function guestCatalogueReady(
  actor: Actor,
  bindings: ViewerActionBindings,
  guestSecurity: ReadonlyMap<string, 'anonymous' | 'authenticated' | 'unknown'>,
  references: readonly Readonly<{ type: ReadingReference['type']; id: string }>[],
) {
  return (
    actor.kind === 'account' ||
    references.every((reference) =>
      applicableBindings(bindings, reference.type, reference.id).every((binding) => {
        const classification = guestSecurity.get(binding.operationId);
        return classification === 'anonymous' || classification === 'authenticated';
      }),
  );
}

function responseBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function identityAuthors(
  ids: readonly string[],
  summaries: ReadonlyMap<string, AccountSummaryValue>,
) {
  return ids.flatMap((id) => {
    const summary = summaries.get(id);
    return summary
      ? [{ id, displayName: summary.displayName, handle: summary.handle, avatar: summary.avatar }]
      : [];
  });
}

function maxReferenceProjection(
  bindings: ViewerActionBindings,
  refs: readonly Readonly<{ type: ReadingReference['type']; id: string; sourceRevisionId?: string }>[],
) {
  return refs.map((reference) => ({
    ...reference,
    state: 'current' as const,
    operations: applicableBindings(bindings, reference.type, reference.id).map((binding) => ({
      action: binding.action,
      operationId: binding.operationId,
      state: 'sign_in_required' as const,
    })),
  }));
}

/** Opening consumes one list slot only on the first page; continuations are already past it. */
export function readingPageRawLimit(cursor?: string): number {
  return cursor === undefined ? RAW_REPLY_PAGE_LIMIT : READING_PAGE_REPLY_LIMIT;
}

/** One disclosed opening plus the next raw native reply interval, with bounded personal state. */
export async function readContentReadingPage(
  dependencies: ReadingPageDependencies,
  threadId: string,
  actor: Actor,
  deadline: number,
  cursor?: string,
) {
  let erasure: AuthorErasureAdmission | undefined;
  const firstThread = await (actor.kind === 'account'
    ? withThreadReadAdmission(
        async () => {
          erasure = await readAuthorErasureAdmission(dependencies, threadId, { actor, deadline });
        },
        () => readThread(dependencies, threadId, { actor, deadline }),
      )
    : readThread(dependencies, threadId, { actor, deadline }));
  if (!firstThread.value) throw new ContentNotFoundError();
  if (firstThread.value.firstPost.availability === 'withheld') throw new ContentNotFoundError();
  const firstBoard = await readBoard(dependencies, firstThread.value.boardId, { actor, deadline });
  if (!firstBoard.value) throw new ContentNotFoundError();
  const selected = await readReplyPage(
    dependencies,
    threadId,
    actor,
    deadline,
    firstThread.value.firstPost.id,
    cursor,
  );
  const thread = firstThread.value;
  const replies = selected.replies;
  requireSelectedLimit(thread, replies);
  const identityIds = authorIds(thread.firstPost, replies);
  const actionRefs = [
    { type: 'content.thread' as const, id: thread.id },
    ...[thread.firstPost, ...replies]
      .filter((entry) => entry.availability !== 'withheld' && 'revisionId' in entry)
      .map((entry) => ({ type: 'content.post' as const, id: entry.id, sourceRevisionId: entry.revisionId })),
  ];
  if (actionRefs.length > READING_PAGE_REFERENCE_LIMIT)
    throw new ProblemError('dependency_unavailable', { detail: 'The reading page reference bound was exceeded' });

  const reactionTargets: (ThreadView | PostEntry)[] = [
    thread,
    ...[thread.firstPost, ...replies].filter((entry) => entry.availability === 'available'),
  ];
  if (reactionTargets.length > READING_PAGE_REFERENCE_LIMIT)
    throw new ProblemError('dependency_unavailable', { detail: 'The reading page reaction bound was exceeded' });
  let actionRuntime: ReadingPageViewerActionRuntime | undefined;
  try {
    actionRuntime = dependencies.viewerActionRuntime?.();
  } catch (error) {
    if (classifyUnavailability(error) === undefined && !(error instanceof ProblemError && error.code === 'dependency_unavailable'))
      throw error;
  }
  let actionState: 'current' | 'unavailable' = 'current';
  let projected: ReadingReference[] = [];
  let replyState: 'available' | 'sign_in_required' | 'denied' | 'withheld' | 'unavailable' = 'unavailable';
  const catalogueReady =
    !!actionRuntime &&
    actionRefs.every((reference) => actionRuntime.resources.has(reference.type)) &&
    guestCatalogueReady(actor, actionRuntime.bindings, actionRuntime.guestSecurity, actionRefs);
  const maxReferences = actionRuntime && catalogueReady ? maxReferenceProjection(actionRuntime.bindings, actionRefs) : [];
  const boundedEnvelope = {
    target: {
      threadId,
      boardId: thread.boardId,
      boardSecurityRevision: firstBoard.value.securityRevision,
    },
    viewer: actor.kind === 'account' ? { kind: 'account' as const, id: actor.accountId } : { kind: 'anonymous' as const },
    query: { cursor: cursor ?? null, limit: READING_PAGE_REPLY_LIMIT as typeof READING_PAGE_REPLY_LIMIT },
    thread,
    replies: { items: replies.map((entry) => safeEntry(entry as EntryWithReaction)), next: selected.page.nextCursor },
    authors: { state: 'current' as const, retryable: false, items: [] as AuthorView[] },
    actions: {
      state: actionRuntime && catalogueReady ? ('current' as const) : ('unavailable' as const),
      retryable: !(actionRuntime && catalogueReady),
      references: maxReferences,
      reply: { state: actionRuntime && catalogueReady ? ('sign_in_required' as const) : ('unavailable' as const) },
    },
    watch: { state: 'unavailable' as const, retryable: true as const },
    slowMode: { state: 'unavailable' as const, retryable: true as const },
    currentness: {
      source: 'current' as const,
      place: 'current' as const,
      reactions: 'current' as const,
      authors: 'current' as const,
      actions: actionRuntime && catalogueReady ? ('current' as const) : ('unavailable' as const),
      watch: 'unavailable' as const,
      slowMode: 'unavailable' as const,
    },
    reactionsAsOf: null,
    ...(erasure ? { authorErasure: { authorId: erasure.authorId, mayErase: erasure.mayErase } } : {}),
  };
  if (
    identityIds.length > READING_PAGE_IDENTITY_LIMIT ||
    responseBytes(boundedEnvelope) + identityIds.length * MAX_AUTHOR_DISPLAY_BYTES + MAX_REACTION_BYTES >
      READING_PAGE_RESPONSE_BYTES
  )
    throw new ProblemError('content_too_large');
  if (!(actionRuntime && catalogueReady)) actionState = 'unavailable';

  const authors: AuthorView[] = [];
  let authorState: 'current' | 'unavailable' = 'current';
  if (identityIds.length) {
    try {
      const summaries = await readAccountDiscoverySummaries(
        { pool: dependencies.pool, routeKey: dependencies.routeKey, access: dependencies.access, actor, deadline },
        identityIds,
      );
      authors.push(...identityAuthors(identityIds, summaries));
      if (authors.some((author) => responseBytes(author) > MAX_AUTHOR_DISPLAY_BYTES))
        throw new ProblemError('dependency_unavailable', { detail: 'An account summary exceeded its bounded projection' });
    } catch (error) {
      if (classifyUnavailability(error) === undefined && !(error instanceof ProblemError && error.code === 'dependency_unavailable'))
        throw error;
      authorState = 'unavailable';
      authors.length = 0;
    }
  }

  let watch: { state: 'current'; watching: boolean } | { state: 'sign_in_required' } | { state: 'unavailable'; retryable: true };
  let watchAnchor: AnchoredPosition | undefined;
  if (actor.kind === 'anonymous') watch = { state: 'sign_in_required' };
  else {
    try {
      const observed = await readThreadWatchState(dependencies, actor, threadId, deadline);
      watch = { state: 'current', watching: observed.watching };
      watchAnchor = observed.anchor;
    } catch (error) {
      if (classifyUnavailability(error) === undefined) throw error;
      watch = { state: 'unavailable', retryable: true };
    }
  }

  let slowMode:
    | ({ state: 'current' } & Awaited<ReturnType<typeof readBoardSlowMode>>)
    | { state: 'unavailable'; retryable: true };
  try {
    slowMode = { state: 'current', ...(await readBoardSlowMode(dependencies, actor, thread.boardId, deadline)) };
  } catch (error) {
    if (classifyUnavailability(error) === undefined && !(error instanceof BoardSlowAdmissionUnavailableError)) throw error;
    slowMode = { state: 'unavailable', retryable: true };
  }

  let actionResults: Awaited<ReturnType<typeof readViewerActions>>['resources'] = [];
  if (actionRuntime && catalogueReady) {
    try {
      const results = await readViewerActions(
        { pool: dependencies.pool, ...actionRuntime },
        actor,
        actionRefs,
        deadline,
      );
      actionResults = results.resources;
    } catch (error) {
      if (!(error instanceof ProblemError) || error.code !== 'dependency_unavailable') throw error;
      actionState = 'unavailable';
    }
  }

  const personalized = await withViewerReactions(dependencies, actor, reactionTargets, deadline);
  const counted = await withReactionCounts(dependencies, personalized, deadline);
  const countedById = new Map(counted.items.map((entry) => [entry.id, entry]));
  const countedThread = countedById.get(thread.id) as (typeof counted.items)[number] & ThreadView;
  if (!countedThread) throw new ProblemError('dependency_unavailable');
  const opening = (countedById.get(thread.firstPost.id) ?? thread.firstPost) as EntryWithReaction;
  const countedReplies = replies.map((entry) => (countedById.get(entry.id) ?? entry) as EntryWithReaction);
  const displayThread = { ...countedThread, firstPost: opening };

  if (actor.kind === 'account' && watch.state === 'current') {
    try {
      const finalWatch = await readThreadWatchState(dependencies, actor, threadId, deadline);
      watchAnchor = finalWatch.anchor;
      if (finalWatch.watching !== watch.watching) watch = { state: 'unavailable', retryable: true };
    } catch (error) {
      if (classifyUnavailability(error) === undefined) throw error;
      watch = { state: 'unavailable', retryable: true };
    }
  }
  if (slowMode.state === 'current') {
    try {
      const finalSlowMode = await readBoardSlowMode(dependencies, actor, thread.boardId, deadline);
      if (slowModeWitness(finalSlowMode) !== slowModeWitness(slowMode))
        slowMode = { state: 'unavailable', retryable: true };
    } catch (error) {
      if (classifyUnavailability(error) === undefined && !(error instanceof BoardSlowAdmissionUnavailableError)) throw error;
      slowMode = { state: 'unavailable', retryable: true };
    }
  }

  const finalThread = await (actor.kind === 'account'
    ? withThreadReadAdmission(
        async () => {
          erasure = await readAuthorErasureAdmission(dependencies, threadId, { actor, deadline });
        },
        () => readThread(dependencies, threadId, { actor, deadline }),
      )
    : readThread(dependencies, threadId, { actor, deadline }));
  if (!finalThread.value) throw new ContentNotFoundError();
  if (finalThread.value.firstPost.availability === 'withheld') throw new ContentNotFoundError();
  const finalSelection = await readReplyPage(
    dependencies,
    threadId,
    actor,
    deadline,
    finalThread.value.firstPost.id,
    cursor,
  );
  const finalBoard = await readBoard(dependencies, finalThread.value.boardId, { actor, deadline });
  if (!finalBoard.value) throw new ContentNotFoundError();
  if (
    threadWitness(thread) !== threadWitness(finalThread.value) ||
    boardWitness(firstBoard.value) !== boardWitness(finalBoard.value) ||
    replyWitness(replies, selected.page.nextCursor !== null) !==
      replyWitness(finalSelection.replies, finalSelection.page.nextCursor !== null)
  )
    throw new ProblemError('dependency_unavailable', { detail: 'The reading page changed during hydration' });

  if (actionRuntime && actionState === 'current') {
    projected = projectedReferences(actor, actionRuntime.bindings, actionRuntime.guestSecurity, actionRefs, actionResults, watch);
    const replyReference = projected.find((reference) => reference.type === 'content.thread' && reference.id === thread.id);
    const mountedReply = replyReference?.operations.find((operation) => operation.operationId === 'post.create');
    replyState =
      replyReference?.state === 'withheld'
        ? 'withheld'
        : (mountedReply?.state as typeof replyState | undefined) ?? 'unavailable';
  } else {
    projected = [];
    replyState = 'unavailable';
  }

  const output = {
    target: { threadId, boardId: thread.boardId, boardSecurityRevision: finalBoard.value.securityRevision },
    viewer: actor.kind === 'account' ? { kind: 'account' as const, id: actor.accountId } : { kind: 'anonymous' as const },
    query: { cursor: cursor ?? null, limit: READING_PAGE_REPLY_LIMIT as typeof READING_PAGE_REPLY_LIMIT },
    thread: displayThread,
    replies: { items: countedReplies.map(safeEntry), next: selected.page.nextCursor },
    authors: { state: authorState, retryable: authorState === 'unavailable', items: authors },
    actions: { state: actionState, retryable: actionState === 'unavailable', references: projected, reply: { state: replyState } },
    watch,
    slowMode,
    currentness: {
      source: 'current' as const,
      place: 'current' as const,
      reactions: 'current' as const,
      authors: authorState,
      actions: actionState,
      watch: watch.state,
      slowMode: slowMode.state,
    },
    reactionsAsOf: counted.reactionsAsOf,
    ...(erasure ? { authorErasure: { authorId: erasure.authorId, mayErase: erasure.mayErase } } : {}),
  };
  if (responseBytes(output) > READING_PAGE_RESPONSE_BYTES) throw new ProblemError('content_too_large');
  return {
    value: output,
    anchors: [finalThread.anchor, finalSelection.page.anchor, finalBoard.anchor, ...(watchAnchor ? [watchAnchor] : [])],
  };
}
