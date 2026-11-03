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
  readSubjectThread,
  readPost,
  withReactionCountsAndCoverage,
  withViewerReactions,
  readBoard,
} from './reads.ts';
import type { ContentReadDependencies, PostEntry, ThreadView } from './reads.ts';
import type { AnchoredPosition } from './model.ts';
import type { ViewerActionResources } from '../access/viewer-actions.ts';
import { ItemViewSchema, ErasedPlaceholderSchema, ThreadViewSchema } from './schemas.ts';
import { routeOf } from '../route/route.ts';

const closed = { additionalProperties: false } as const;
export const READING_PAGE_REPLY_LIMIT = 20;
const RAW_REPLY_PAGE_LIMIT = READING_PAGE_REPLY_LIMIT + 1;
export const READING_PAGE_REQUEST_BYTES = 8 * 1024;
const READING_PAGE_IDENTITY_LIMIT = READING_PAGE_REPLY_LIMIT + 1;
const READING_PAGE_REFERENCE_LIMIT = READING_PAGE_REPLY_LIMIT + 2;
const MAX_AUTHOR_DISPLAY_BYTES = 32 * 1024;
const MAX_REACTION_BYTES = 16 * 1024;
const MAX_OTHER_ENVELOPE_BYTES = 256 * 1024;
export const READING_CARD_REFERENCE_LIMIT = READING_PAGE_REPLY_LIMIT;
const READING_CARD_IDENTITY_LIMIT = READING_CARD_REFERENCE_LIMIT * 3;
const READING_CARD_ACTION_REFERENCE_LIMIT = READING_CARD_REFERENCE_LIMIT * 3;
const READING_CARD_ENVELOPE_BYTES = 8 * 1024 * 1024;
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
      {
        items: t.Array(ReadingEntrySchema, { maxItems: READING_PAGE_REPLY_LIMIT }),
        next: t.Union([t.String(), t.Null()]),
      },
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
        reactions: t.Union([t.Literal('current'), t.Literal('unavailable')]),
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

/** A consumer-selected, exact native reference. Subject selections retain their Subject key and place. */
export type SelectedReadingCardReference =
  | Readonly<{
      type: 'content.thread';
      id: string;
      placeId: string;
      sourceRevisionId: string | null;
      subjectId?: string;
    }>
  | Readonly<{
      type: 'content.post';
      id: string;
      threadId: string;
      placeId: string;
      threadRevisionId: string | null;
      sourceRevisionId: string | null;
    }>;

export type SelectedReadingCardBatchResult = Readonly<{
  viewer: { kind: 'anonymous' } | { kind: 'account'; id: string };
  selected: readonly Readonly<{
    reference: SelectedReadingCardReference;
    state: 'current' | 'erased' | 'withheld';
    reply: Readonly<{ state: 'available' | 'sign_in_required' | 'denied' | 'withheld' | 'unavailable' }>;
    source?: Readonly<{
      threadId: string;
      placeId: string;
      sourceRevisionId: string | null;
      threadSecurityRevision: string;
      sourceSecurityRevision: string | null;
      placeSecurityRevision: string;
    }>;
  }>[];
  authors: Readonly<{ state: 'current' | 'unavailable'; retryable: boolean; items: readonly AuthorView[] }>;
  reactions: Readonly<{
    state: 'current' | 'unavailable';
    retryable: boolean;
    items: readonly SelectedReadingCardReaction[];
    reactionsAsOf: Readonly<{ epoch: number; position: string }> | null;
  }>;
  actions: Readonly<{ state: 'current' | 'unavailable'; retryable: boolean; references: readonly ReadingReference[] }>;
  watch: Readonly<{
    state: 'current' | 'sign_in_required' | 'unavailable';
    retryable: boolean;
    items: readonly Readonly<{
      threadId: string;
      state: 'current' | 'sign_in_required' | 'unavailable';
      watching?: boolean;
    }>[];
  }>;
  currentness: Readonly<{
    source: 'current';
    place: 'current';
    reactions: 'current' | 'unavailable';
    authors: 'current' | 'unavailable';
    actions: 'current' | 'unavailable';
    watch: 'current' | 'sign_in_required' | 'unavailable';
  }>;
  anchors: readonly AnchoredPosition[];
}>;

export type SelectedReadingCardReaction = Readonly<{
  type: 'content.thread' | 'content.post';
  id: string;
  state: 'current' | 'unavailable' | 'not_applicable';
  counts?: Readonly<Partial<Record<string, number>>>;
  viewerSelection?: string | null;
}>;

export type ContentReadingCardBatch = Readonly<{
  selected: readonly SelectedReadingCardReference[];
  finish(): Promise<SelectedReadingCardBatchResult>;
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
type ReplyState = 'available' | 'sign_in_required' | 'denied' | 'withheld' | 'unavailable';
type ReadingWatchState =
  | { state: 'current'; watching: boolean }
  | { state: 'sign_in_required' }
  | { state: 'unavailable'; retryable: true };
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
  const page = await listThreadPosts(dependencies, threadId, context, cursor, readingPageRawLimit(cursor));
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
  return (bindings.get(type) ?? []).filter(
    (binding) => binding.fixedResourceId === undefined || binding.fixedResourceId === id,
  );
}

export function readingPageOperationState(
  actor: Actor,
  operationId: string,
  allowed: ReadonlySet<string>,
  guestSecurity: ReadonlyMap<string, 'anonymous' | 'authenticated' | 'unknown'>,
  watch:
    | { state: 'current'; watching: boolean }
    | { state: 'sign_in_required' }
    | { state: 'unavailable'; retryable: true },
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
  results: readonly Readonly<{
    type: string;
    id: string;
    error?: string;
    viewerActions?: readonly { action: string; operations: readonly string[] }[];
  }>[],
  watch: ReadingWatchState | ReadonlyMap<string, ReadingWatchState>,
): ReadingReference[] {
  const byKey = new Map(results.map((result) => [`${result.type}/${result.id}`, result]));
  return references.map((reference) => {
    const result = byKey.get(`${reference.type}/${reference.id}`);
    if (!result || result.error === 'not_found') return { ...reference, state: 'withheld', operations: [] };
    const permitted = new Set((result.viewerActions ?? []).flatMap((entry) => entry.operations));
    const referenceWatch =
      'state' in watch ? watch : (watch.get(reference.id) ?? { state: 'unavailable' as const, retryable: true as const });
    const operations = applicableBindings(bindings, reference.type, reference.id).map((binding) => ({
      action: binding.action,
      operationId: binding.operationId,
      state: readingPageOperationState(actor, binding.operationId, permitted, guestSecurity, referenceWatch),
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
    )
  );
}

function responseBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function identityAuthors(ids: readonly string[], summaries: ReadonlyMap<string, AccountSummaryValue>) {
  return ids.flatMap((id) => {
    const summary = summaries.get(id);
    return summary ? [{ id, displayName: summary.displayName, handle: summary.handle, avatar: summary.avatar }] : [];
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

type SelectedThreadSource = {
  threadId: string;
  placeId: string;
  expectedOpeningRevisionId: string | null;
  subjectId?: string;
  state: 'current' | 'withheld';
  witness?: string;
  placeWitness?: string;
  threadSecurityRevision?: string;
  placeSecurityRevision?: string;
  openingPostId?: string;
  openingRevisionId?: string | null;
  openingSecurityRevision?: string | null;
  threadState?: 'available' | 'erased';
  openingState?: 'available' | 'erased';
  openingAuthorId?: string;
  authorId?: string;
};

type SelectedPostSource = {
  reference: Extract<SelectedReadingCardReference, { type: 'content.post' }>;
  state: 'current' | 'erased' | 'withheld';
  witness?: string;
  revisionId?: string | null;
  securityRevision?: string | null;
  authorId?: string;
};

type SelectedPlaceSource = {
  state: 'current' | 'withheld';
  witness?: string;
  securityRevision?: string;
};

type ReadingCardReactionTarget = Readonly<{ type: 'content.thread' | 'content.post'; id: string }>;

type ReadingCardActionSource = Readonly<{ threadId: string; postId?: string }>;

function selectedReferenceThreadId(reference: SelectedReadingCardReference): string {
  return reference.type === 'content.thread' ? reference.id : reference.threadId;
}

function sameSelectedReference(left: SelectedReadingCardReference, right: SelectedReadingCardReference): boolean {
  if (left.type !== right.type || left.id !== right.id || left.placeId !== right.placeId) return false;
  if (left.type === 'content.thread' && right.type === 'content.thread')
    return left.sourceRevisionId === right.sourceRevisionId && left.subjectId === right.subjectId;
  return (
    left.type === 'content.post' &&
    right.type === 'content.post' &&
    left.threadId === right.threadId &&
    left.threadRevisionId === right.threadRevisionId &&
    left.sourceRevisionId === right.sourceRevisionId
  );
}

/** Validate the raw selection before any native reads; exact duplicates collapse in first-seen order. */
export function normalizeSelectedReadingCardReferences(
  selected: readonly SelectedReadingCardReference[],
): readonly SelectedReadingCardReference[] {
  const invalid = () => new ProblemError('invalid_request');
  if (!Array.isArray(selected) || selected.length > READING_CARD_REFERENCE_LIMIT) throw invalid();
  const normalized: SelectedReadingCardReference[] = [];
  const byKey = new Map<string, SelectedReadingCardReference>();
  for (const reference of selected) {
    const threadId = selectedReferenceThreadId(reference);
    const threadRoute = routeOf(threadId);
    const placeRoute = routeOf(reference.placeId);
    const revisionRoutes = [reference.sourceRevisionId, ...(reference.type === 'content.post' ? [reference.threadRevisionId] : [])]
      .filter((revision): revision is string => revision !== null)
      .map((revision) => routeOf(revision));
    if (
      threadRoute === null ||
      placeRoute !== threadRoute ||
      revisionRoutes.some((revisionRoute) => revisionRoute !== threadRoute) ||
      (reference.type === 'content.post' && routeOf(reference.id) !== threadRoute) ||
      (reference.type === 'content.thread' &&
        reference.subjectId !== undefined &&
        routeOf(reference.subjectId) === null)
    )
      throw invalid();
    const key = `${reference.type}/${reference.id}`;
    const existing = byKey.get(key);
    if (existing) {
      if (!sameSelectedReference(existing, reference)) throw invalid();
      continue;
    }
    byKey.set(key, reference);
    normalized.push(reference);
  }
  return normalized;
}

/** A missing native total row is unknown coverage, not an exact zero. */
export function readingPageReactionCoverageState(
  targetIds: readonly string[],
  coveredTargetIds: ReadonlySet<string>,
): 'current' | 'unavailable' {
  return targetIds.every((id) => coveredTargetIds.has(id)) ? 'current' : 'unavailable';
}

function selectedCardUnavailable(error: unknown): boolean {
  return classifyUnavailability(error) !== undefined || (error instanceof ProblemError && error.code === 'dependency_unavailable');
}

function sourceChanged(): ProblemError {
  return new ProblemError('dependency_unavailable', { detail: 'A selected reading source changed during hydration' });
}

function readSelectedThread(
  dependencies: ReadingPageDependencies,
  threadId: string,
  subjectId: string | undefined,
  placeId: string,
  actor: Actor,
  deadline: number,
) {
  return subjectId === undefined
    ? readThread(dependencies, threadId, { actor, deadline })
    : readSubjectThread(dependencies, threadId, subjectId, placeId, { actor, deadline });
}

function selectedAuthors(
  groups: ReadonlyMap<string, SelectedThreadSource>,
  posts: readonly SelectedPostSource[],
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const add = (id: string | undefined) => {
    if (id && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  };
  for (const group of groups.values()) {
    if (group.state !== 'current') continue;
    add(group.authorId);
    add(group.openingAuthorId);
  }
  for (const post of posts) if (post.state === 'current') add(post.authorId);
  if (ids.length > READING_CARD_IDENTITY_LIMIT) throw new RangeError('Selected reading identity bound exceeded');
  return ids;
}

function selectedCardPreflight(
  references: readonly SelectedReadingCardReference[],
  actionRefs: readonly Readonly<{ type: ReadingReference['type']; id: string; sourceRevisionId?: string }>[],
  bindings: ViewerActionBindings | undefined,
  actor: Actor,
): void {
  const projections = bindings ? maxReferenceProjection(bindings, actionRefs) : [];
  const maxAuthors = Math.min(READING_CARD_IDENTITY_LIMIT, references.length * 3);
  const maxReactionTargets = Math.min(READING_CARD_ACTION_REFERENCE_LIMIT, references.length * 3);
  const envelope = {
    viewer: actor.kind === 'account' ? { kind: 'account', id: actor.accountId } : { kind: 'anonymous' },
    selected: references,
    authors: [],
    reactions: [],
    actions: projections,
    watch: [],
  };
  if (
    responseBytes(envelope) +
      maxAuthors * MAX_AUTHOR_DISPLAY_BYTES +
      maxReactionTargets * MAX_REACTION_BYTES >
    READING_CARD_ENVELOPE_BYTES
  )
    throw new ProblemError('content_too_large');
}

function selectedCardMaximumPreflight(
  references: readonly SelectedReadingCardReference[],
  bindings: ViewerActionBindings | undefined,
  actor: Actor,
): void {
  const threadCount = references.length;
  const postCount = references.length * 2;
  const possible = [
    ...Array.from({ length: threadCount }, (_, index) => ({ type: 'content.thread' as const, id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}` })),
    ...Array.from({ length: postCount }, (_, index) => ({ type: 'content.post' as const, id: `00000000-0000-4000-8000-${String(index + 101).padStart(12, '0')}`, sourceRevisionId: `00000000-0000-4000-8000-${String(index + 201).padStart(12, '0')}` })),
  ];
  const operations = bindings
    ? possible.map((reference) => ({
        ...reference,
        state: 'current' as const,
        operations: (bindings.get(reference.type) ?? []).map((binding) => ({
          action: binding.action,
          operationId: binding.operationId,
          state: 'sign_in_required' as const,
        })),
      }))
    : [];
  const maxAuthors = Math.min(READING_CARD_IDENTITY_LIMIT, references.length * 3);
  const maxReactionTargets = Math.min(READING_CARD_ACTION_REFERENCE_LIMIT, references.length * 3);
  const envelope = {
    viewer: actor.kind === 'account' ? { kind: 'account', id: actor.accountId } : { kind: 'anonymous' },
    selected: references,
    authors: [],
    reactions: [],
    actions: operations,
    watch: [],
  };
  if (
    responseBytes(envelope) +
      maxAuthors * MAX_AUTHOR_DISPLAY_BYTES +
      maxReactionTargets * MAX_REACTION_BYTES >
    READING_CARD_ENVELOPE_BYTES
  )
    throw new ProblemError('content_too_large');
}

/**
 * Select up to twenty exact thread/post cards, hydrate their shared personal state once, then let
 * the owner append its parent/Subject context before calling the returned final currentness seam.
 */
export async function createContentReadingCardBatch(
  dependencies: ReadingPageDependencies,
  selected: readonly SelectedReadingCardReference[],
  actor: Actor,
  deadline: number,
): Promise<ContentReadingCardBatch> {
  const references = normalizeSelectedReadingCardReferences(selected);
  let actionRuntime: ReadingPageViewerActionRuntime | undefined;
  try {
    actionRuntime = dependencies.viewerActionRuntime?.();
  } catch (error) {
    if (!selectedCardUnavailable(error)) throw error;
  }
  selectedCardMaximumPreflight(references, actionRuntime?.bindings, actor);
  const groups = new Map<string, SelectedThreadSource>();
  for (const reference of references) {
    const threadId = selectedReferenceThreadId(reference);
    const subjectId = reference.type === 'content.thread' ? reference.subjectId : undefined;
    const expectedOpeningRevisionId = reference.type === 'content.thread' ? reference.sourceRevisionId : reference.threadRevisionId;
    const existing = groups.get(threadId);
    if (
      existing &&
      (existing.placeId !== reference.placeId ||
        existing.expectedOpeningRevisionId !== expectedOpeningRevisionId ||
        (existing.subjectId && subjectId && existing.subjectId !== subjectId))
    )
      throw new ProblemError('invalid_request');
    if (!existing)
      groups.set(threadId, {
        threadId,
        placeId: reference.placeId,
        expectedOpeningRevisionId,
        ...(subjectId ? { subjectId } : {}),
        state: 'withheld',
      });
    else if (subjectId && !existing.subjectId) existing.subjectId = subjectId;
  }

  const places = new Map<string, SelectedPlaceSource>();
  const context = { actor, deadline };
  for (const group of groups.values()) {
    const thread = await readSelectedThread(
      dependencies,
      group.threadId,
      group.subjectId,
      group.placeId,
      actor,
      deadline,
    );
    if (!thread.value || thread.value.firstPost.availability === 'withheld' || thread.value.boardId !== group.placeId)
      continue;
    let placeSource = places.get(group.placeId);
    if (!placeSource) {
      const observedPlace = await readBoard(dependencies, group.placeId, context);
      placeSource = observedPlace.value
        ? {
            state: 'current',
            witness: boardWitness(observedPlace.value),
            securityRevision: observedPlace.value.securityRevision,
          }
        : { state: 'withheld' };
      places.set(group.placeId, placeSource);
    }
    if (placeSource.state !== 'current' || !placeSource.witness) continue;
    const opening = thread.value.firstPost;
    const openingRevisionId = 'revisionId' in opening ? opening.revisionId : null;
    if (group.expectedOpeningRevisionId !== openingRevisionId) throw sourceChanged();
    Object.assign(group, {
      state: 'current' as const,
      witness: threadWitness(thread.value),
      placeWitness: placeSource.witness,
      threadSecurityRevision: thread.value.securityRevision,
      placeSecurityRevision: placeSource.securityRevision,
      openingPostId: opening.id,
      openingRevisionId,
      openingSecurityRevision: 'securityRevision' in opening ? opening.securityRevision : null,
      threadState: thread.value.availability,
      openingState: opening.availability === 'erased' ? ('erased' as const) : ('available' as const),
      ...(thread.value.availability === 'available' ? { authorId: thread.value.authorId } : {}),
      ...(opening.availability === 'available' && 'authorId' in opening ? { openingAuthorId: opening.authorId } : {}),
    });
  }

  const postSources: SelectedPostSource[] = [];
  for (const reference of references) {
    if (reference.type !== 'content.post') continue;
    const group = groups.get(reference.threadId);
    if (!group || group.state !== 'current') {
      postSources.push({ reference, state: 'withheld' });
      continue;
    }
    const post = await readPost(dependencies, reference.threadId, reference.id, context);
    const entry = post.value;
    if (!entry || entry.availability === 'withheld' || entry.threadId !== reference.threadId) {
      postSources.push({ reference, state: 'withheld' });
      continue;
    }
    const revisionId = 'revisionId' in entry ? entry.revisionId : null;
    if (revisionId !== reference.sourceRevisionId) throw sourceChanged();
    if ('boardId' in entry && entry.boardId !== reference.placeId) {
      postSources.push({ reference, state: 'withheld' });
      continue;
    }
    const state = entry.availability === 'erased' ? 'erased' : 'current';
    postSources.push({
      reference,
      state,
      witness: entryWitness(entry),
      revisionId,
      securityRevision: 'securityRevision' in entry ? entry.securityRevision : null,
      ...(state === 'current' && 'authorId' in entry ? { authorId: entry.authorId } : {}),
    });
  }

  const actionRefs: Array<{ type: ReadingReference['type']; id: string; sourceRevisionId?: string }> = [];
  const actionSources = new Map<string, ReadingCardActionSource>();
  const addAction = (type: ReadingReference['type'], id: string, source: ReadingCardActionSource, revisionId?: string | null) => {
    const key = `${type}/${id}`;
    if (actionSources.has(key)) return;
    const reference = { type, id, ...(revisionId ? { sourceRevisionId: revisionId } : {}) };
    actionRefs.push(reference);
    actionSources.set(key, source);
  };
  const reactionTargets: ReadingCardReactionTarget[] = [];
  const reactionTargetByKey = new Map<string, ReadingCardReactionTarget>();
  const addReaction = (type: ReadingCardReactionTarget['type'], id: string) => {
    const key = `${type}/${id}`;
    if (!reactionTargetByKey.has(key)) {
      const target = { type, id };
      reactionTargetByKey.set(key, target);
      reactionTargets.push(target);
    }
  };
  for (const group of groups.values()) {
    if (group.state !== 'current') continue;
    addAction('content.thread', group.threadId, { threadId: group.threadId });
    addReaction('content.thread', group.threadId);
    if (group.openingPostId && group.openingState === 'available' && group.openingRevisionId) {
      addAction('content.post', group.openingPostId, { threadId: group.threadId, postId: group.openingPostId }, group.openingRevisionId);
      addReaction('content.post', group.openingPostId);
    }
  }
  for (const post of postSources) {
    if (post.state !== 'current' || !post.revisionId) continue;
    addAction('content.post', post.reference.id, { threadId: post.reference.threadId, postId: post.reference.id }, post.revisionId);
    addReaction('content.post', post.reference.id);
  }
  if (actionRefs.length > READING_CARD_ACTION_REFERENCE_LIMIT) throw new ProblemError('dependency_unavailable');

  const catalogueReady =
    !!actionRuntime &&
    actionRefs.every((reference) => actionRuntime!.resources.has(reference.type)) &&
    guestCatalogueReady(actor, actionRuntime.bindings, actionRuntime.guestSecurity, actionRefs);
  selectedCardPreflight(references, actionRefs, actionRuntime?.bindings, actor);

  const identityIds = selectedAuthors(groups, postSources);
  let authorState: 'current' | 'unavailable' = 'current';
  let authorValues: AuthorView[] = [];
  if (identityIds.length) {
    try {
      const summaries = await readAccountDiscoverySummaries(
        { pool: dependencies.pool, routeKey: dependencies.routeKey, access: dependencies.access, actor, deadline },
        identityIds,
      );
      authorValues = identityAuthors(identityIds, summaries);
      if (authorValues.some((author) => responseBytes(author) > MAX_AUTHOR_DISPLAY_BYTES)) throw new ProblemError('dependency_unavailable');
    } catch (error) {
      if (!selectedCardUnavailable(error)) throw error;
      authorState = 'unavailable';
      authorValues = [];
    }
  }

  let reactionState: 'current' | 'unavailable' = 'current';
  let reactionValues: SelectedReadingCardReaction[] = [];
  let reactionsAsOf: Readonly<{ epoch: number; position: string }> | null = null;
  if (reactionTargets.length) {
    try {
      const targetIds = reactionTargets.map((target) => ({ id: target.id }));
      const personalized = await withViewerReactions(dependencies, actor, targetIds, deadline);
      const counted = await withReactionCountsAndCoverage(dependencies, personalized, deadline);
      const covered = new Set(counted.targetsWithRows);
      if (readingPageReactionCoverageState(targetIds.map((target) => target.id), covered) !== 'current') {
        reactionState = 'unavailable';
      } else {
        reactionsAsOf = counted.reactionsAsOf;
        const countedById = new Map(counted.items.map((target) => [target.id, target]));
        reactionValues = reactionTargets.map((target) => {
          const value = countedById.get(target.id)!;
          const counts = 'reactions' in value ? value.reactions : undefined;
          const viewerSelection = 'viewerReaction' in value ? value.viewerReaction : undefined;
          return {
            ...target,
            state: 'current' as const,
            ...(counts ? { counts } : {}),
            ...(viewerSelection === undefined ? {} : { viewerSelection }),
          };
        });
      }
    } catch (error) {
      if (!selectedCardUnavailable(error)) throw error;
      reactionState = 'unavailable';
      reactionValues = [];
      reactionsAsOf = null;
    }
  }
  if (reactionState === 'unavailable') {
    reactionValues = reactionTargets.map((target) => ({ ...target, state: 'unavailable' as const }));
    reactionsAsOf = null;
  }

  const initialWatch = new Map<string, ReadingWatchState>();
  if (actor.kind === 'anonymous') {
    for (const group of groups.values()) if (group.state === 'current') initialWatch.set(group.threadId, { state: 'sign_in_required' });
  } else {
    for (const group of groups.values()) {
      if (group.state !== 'current') continue;
      try {
        const observed = await readThreadWatchState(dependencies, actor, group.threadId, deadline);
        initialWatch.set(group.threadId, { state: 'current', watching: observed.watching });
      } catch (error) {
        if (!(error instanceof ContentNotFoundError) && !selectedCardUnavailable(error)) throw error;
        initialWatch.set(group.threadId, { state: 'unavailable', retryable: true });
      }
    }
  }

  let actionState: 'current' | 'unavailable' = catalogueReady ? 'current' : 'unavailable';
  let actionResults: Awaited<ReturnType<typeof readViewerActions>>['resources'] = [];
  if (catalogueReady && actionRefs.length) {
    try {
      const result = await readViewerActions({ pool: dependencies.pool, ...actionRuntime! }, actor, actionRefs, deadline);
      actionResults = result.resources;
    } catch (error) {
      if (!(error instanceof ProblemError) || error.code !== 'dependency_unavailable') throw error;
      actionState = 'unavailable';
    }
  }

  let finishPromise: Promise<SelectedReadingCardBatchResult> | undefined;
  return {
    selected: references,
    finish() {
      return (finishPromise ??= (async () => {
        const finalPlaces = new Map<string, SelectedPlaceSource>();
        const finalAnchors: AnchoredPosition[] = [];
        for (const group of groups.values()) {
          if (group.state !== 'current') continue;
          const thread = await readSelectedThread(
            dependencies,
            group.threadId,
            group.subjectId,
            group.placeId,
            actor,
            deadline,
          );
          if (!thread.value || thread.value.firstPost.availability === 'withheld' || thread.value.boardId !== group.placeId) {
            group.state = 'withheld';
            continue;
          }
          if (threadWitness(thread.value) !== group.witness) throw sourceChanged();
          finalAnchors.push(thread.anchor);
        }
        for (const group of groups.values()) {
          if (group.state !== 'current' || finalPlaces.has(group.placeId)) continue;
          const place = await readBoard(dependencies, group.placeId, context);
          const observed: SelectedPlaceSource = place.value
            ? {
                state: 'current',
                witness: boardWitness(place.value),
                securityRevision: place.value.securityRevision,
              }
            : { state: 'withheld' };
          finalPlaces.set(group.placeId, observed);
          if (place.value) finalAnchors.push(place.anchor);
          if (observed.state === 'current' && observed.witness !== group.placeWitness) throw sourceChanged();
          if (observed.state === 'withheld')
            for (const related of groups.values()) if (related.placeId === group.placeId) related.state = 'withheld';
        }

        for (const post of postSources) {
          if (post.state === 'withheld') continue;
          const group = groups.get(post.reference.threadId);
          if (!group || group.state !== 'current') {
            post.state = 'withheld';
            continue;
          }
          const current = await readPost(dependencies, post.reference.threadId, post.reference.id, context);
          if (!current.value || current.value.availability === 'withheld') {
            post.state = 'withheld';
            continue;
          }
          if (entryWitness(current.value) !== post.witness) throw sourceChanged();
          finalAnchors.push(current.anchor);
        }

        const finalWatch = new Map<string, ReadingWatchState>();
        for (const group of groups.values()) {
          if (group.state !== 'current') continue;
          const before = initialWatch.get(group.threadId);
          if (!before) continue;
          if (actor.kind === 'anonymous') {
            finalWatch.set(group.threadId, before);
            continue;
          }
          if (before.state !== 'current') {
            finalWatch.set(group.threadId, before);
            continue;
          }
          try {
            const current = await readThreadWatchState(dependencies, actor, group.threadId, deadline);
            finalAnchors.push(current.anchor);
            finalWatch.set(
              group.threadId,
              current.watching === before.watching ? { state: 'current', watching: current.watching } : { state: 'unavailable', retryable: true },
            );
          } catch (error) {
            if (!(error instanceof ContentNotFoundError) && !selectedCardUnavailable(error)) throw error;
            finalWatch.set(group.threadId, { state: 'unavailable', retryable: true });
          }
        }

        const resourceCurrent = (source: ReadingCardActionSource) => {
          const group = groups.get(source.threadId);
          if (!group || group.state !== 'current') return false;
          if (!source.postId) return true;
          const post = postSources.find((item) => item.reference.id === source.postId);
          if (post) return post.state === 'current';
          return group.openingPostId === source.postId && group.openingState === 'available';
        };
        const visibleActionRefs: typeof actionRefs = [];
        const withheldActionRefs: ReadingReference[] = [];
        for (const reference of actionRefs) {
          const source = actionSources.get(`${reference.type}/${reference.id}`)!;
          if (resourceCurrent(source)) visibleActionRefs.push(reference);
          else withheldActionRefs.push({ ...reference, state: 'withheld', operations: [] });
        }
        let projectedActions: ReadingReference[] = [];
        if (actionState === 'current' && actionRuntime && catalogueReady) {
          const visible = projectedReferences(
            actor,
            actionRuntime.bindings,
            actionRuntime.guestSecurity,
            visibleActionRefs,
            actionResults,
            finalWatch,
          );
          projectedActions = [...visible, ...withheldActionRefs];
        }

        const currentAuthors = new Set<string>();
        const currentReactionKeys = new Set<string>();
        for (const group of groups.values()) {
          if (group.state !== 'current') continue;
          if (group.authorId) currentAuthors.add(group.authorId);
          if (group.openingAuthorId) currentAuthors.add(group.openingAuthorId);
          currentReactionKeys.add(`content.thread/${group.threadId}`);
          if (group.openingPostId && group.openingState === 'available')
            currentReactionKeys.add(`content.post/${group.openingPostId}`);
        }
        for (const post of postSources) {
          if (post.state !== 'current') continue;
          if (post.authorId) currentAuthors.add(post.authorId);
          currentReactionKeys.add(`content.post/${post.reference.id}`);
        }
        const visibleAuthors = authorValues.filter((author) => currentAuthors.has(author.id));
        const visibleReactions = reactionValues.filter((item) => currentReactionKeys.has(`${item.type}/${item.id}`));
        const replyFor = (threadId: string, sourceCurrent: boolean): ReplyState => {
          if (!sourceCurrent) return 'withheld';
          if (actionState !== 'current') return 'unavailable';
          const reference = projectedActions.find((item) => item.type === 'content.thread' && item.id === threadId);
          if (!reference) return 'unavailable';
          if (reference.state === 'withheld') return 'withheld';
          return (
            (reference.operations.find((operation) => operation.operationId === 'post.create')?.state as ReplyState | undefined) ??
            'unavailable'
          );
        };
        const selectedResults = references.map((reference) => {
          const threadId = selectedReferenceThreadId(reference);
          const group = groups.get(threadId);
          if (!group || group.state !== 'current')
            return { reference, state: 'withheld' as const, reply: { state: 'withheld' as const } };
          const post = reference.type === 'content.post' ? postSources.find((item) => item.reference.id === reference.id) : undefined;
          if (post?.state === 'withheld')
            return { reference, state: 'withheld' as const, reply: { state: 'withheld' as const } };
          const sourceRevisionId = reference.type === 'content.thread' ? group.openingRevisionId ?? null : (post?.revisionId ?? null);
          const state =
            reference.type === 'content.post'
              ? (post?.state ?? 'withheld')
              : group.threadState === 'erased' || group.openingState === 'erased'
                ? 'erased'
                : 'current';
          return {
            reference,
            state,
            reply: { state: replyFor(threadId, state !== 'erased') },
            source: {
              threadId,
              placeId: reference.placeId,
              sourceRevisionId,
              threadSecurityRevision: group.threadSecurityRevision!,
              sourceSecurityRevision:
                reference.type === 'content.post' ? (post?.securityRevision ?? null) : (group.openingSecurityRevision ?? null),
              placeSecurityRevision: finalPlaces.get(group.placeId)?.securityRevision ?? group.placeSecurityRevision!,
            },
          };
        });
        const watchItems = [...groups.values()]
          .filter((group) => group.state === 'current')
          .map((group) => {
            const value = finalWatch.get(group.threadId) ?? { state: 'unavailable' as const, retryable: true as const };
            return {
              threadId: group.threadId,
              state: value.state,
              ...('watching' in value ? { watching: value.watching } : {}),
            };
          });
        const watchState =
          watchItems.some((item) => item.state === 'unavailable')
            ? 'unavailable'
            : actor.kind === 'anonymous' && watchItems.length > 0
              ? 'sign_in_required'
              : 'current';
        const result: SelectedReadingCardBatchResult = {
          viewer: actor.kind === 'account' ? { kind: 'account', id: actor.accountId } : { kind: 'anonymous' },
          selected: selectedResults,
          authors: { state: authorState, retryable: authorState === 'unavailable', items: visibleAuthors },
          reactions: {
            state: reactionState,
            retryable: reactionState === 'unavailable',
            items: visibleReactions,
            reactionsAsOf,
          },
          actions: {
            state: actionState,
            retryable: actionState === 'unavailable',
            references: actionState === 'current' ? projectedActions : [],
          },
          watch: { state: watchState, retryable: watchState === 'unavailable', items: watchItems },
          currentness: {
            source: 'current',
            place: 'current',
            reactions: reactionState,
            authors: authorState,
            actions: actionState,
            watch: watchState,
          },
          anchors: finalAnchors,
        };
        if (
          responseBytes({
            ...result,
            anchors: finalAnchors.map((anchor) => ({
              ...anchor,
              position: anchor.position.toString(),
            })),
          }) > READING_CARD_ENVELOPE_BYTES
        )
          throw new ProblemError('content_too_large');
        return result;
      })());
    },
  };
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
  const selected = await readReplyPage(dependencies, threadId, actor, deadline, firstThread.value.firstPost.id, cursor);
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
    if (
      classifyUnavailability(error) === undefined &&
      !(error instanceof ProblemError && error.code === 'dependency_unavailable')
    )
      throw error;
  }
  let actionState: 'current' | 'unavailable' = 'current';
  let projected: ReadingReference[] = [];
  let replyState: 'available' | 'sign_in_required' | 'denied' | 'withheld' | 'unavailable' = 'unavailable';
  const catalogueReady =
    !!actionRuntime &&
    actionRefs.every((reference) => actionRuntime.resources.has(reference.type)) &&
    guestCatalogueReady(actor, actionRuntime.bindings, actionRuntime.guestSecurity, actionRefs);
  const maxReferences =
    actionRuntime && catalogueReady ? maxReferenceProjection(actionRuntime.bindings, actionRefs) : [];
  const boundedEnvelope = {
    target: {
      threadId,
      boardId: thread.boardId,
      boardSecurityRevision: firstBoard.value.securityRevision,
    },
    viewer:
      actor.kind === 'account' ? { kind: 'account' as const, id: actor.accountId } : { kind: 'anonymous' as const },
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
        throw new ProblemError('dependency_unavailable', {
          detail: 'An account summary exceeded its bounded projection',
        });
    } catch (error) {
      if (
        classifyUnavailability(error) === undefined &&
        !(error instanceof ProblemError && error.code === 'dependency_unavailable')
      )
        throw error;
      authorState = 'unavailable';
      authors.length = 0;
    }
  }

  let watch:
    | { state: 'current'; watching: boolean }
    | { state: 'sign_in_required' }
    | { state: 'unavailable'; retryable: true };
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
    if (classifyUnavailability(error) === undefined && !(error instanceof BoardSlowAdmissionUnavailableError))
      throw error;
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

  let reactionState: 'current' | 'unavailable' = 'current';
  let reactionsAsOf: Readonly<{ epoch: number; position: string }> | null = null;
  let countedById = new Map<string, unknown>();
  try {
    const personalized = await withViewerReactions(dependencies, actor, reactionTargets, deadline);
    const counted = await withReactionCountsAndCoverage(dependencies, personalized, deadline);
    if (
      readingPageReactionCoverageState(
        reactionTargets.map((target) => target.id),
        new Set(counted.targetsWithRows),
      ) === 'current'
    ) {
      countedById = new Map(counted.items.map((entry) => [entry.id, entry]));
      reactionsAsOf = counted.reactionsAsOf;
    } else {
      reactionState = 'unavailable';
    }
  } catch (error) {
    if (!selectedCardUnavailable(error)) throw error;
    reactionState = 'unavailable';
  }
  const countedThread = (countedById.get(thread.id) as (ThreadView & EntryWithReaction) | undefined) ?? thread;
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
      if (classifyUnavailability(error) === undefined && !(error instanceof BoardSlowAdmissionUnavailableError))
        throw error;
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
    projected = projectedReferences(
      actor,
      actionRuntime.bindings,
      actionRuntime.guestSecurity,
      actionRefs,
      actionResults,
      watch,
    );
    const replyReference = projected.find(
      (reference) => reference.type === 'content.thread' && reference.id === thread.id,
    );
    const mountedReply = replyReference?.operations.find((operation) => operation.operationId === 'post.create');
    replyState =
      replyReference?.state === 'withheld'
        ? 'withheld'
        : ((mountedReply?.state as typeof replyState | undefined) ?? 'unavailable');
  } else {
    projected = [];
    replyState = 'unavailable';
  }

  const output = {
    target: { threadId, boardId: thread.boardId, boardSecurityRevision: finalBoard.value.securityRevision },
    viewer:
      actor.kind === 'account' ? { kind: 'account' as const, id: actor.accountId } : { kind: 'anonymous' as const },
    query: { cursor: cursor ?? null, limit: READING_PAGE_REPLY_LIMIT as typeof READING_PAGE_REPLY_LIMIT },
    thread: displayThread,
    replies: { items: countedReplies.map(safeEntry), next: selected.page.nextCursor },
    authors: { state: authorState, retryable: authorState === 'unavailable', items: authors },
    actions: {
      state: actionState,
      retryable: actionState === 'unavailable',
      references: projected,
      reply: { state: replyState },
    },
    watch,
    slowMode,
    currentness: {
      source: 'current' as const,
      place: 'current' as const,
      reactions: reactionState,
      authors: authorState,
      actions: actionState,
      watch: watch.state,
      slowMode: slowMode.state,
    },
    reactionsAsOf,
    ...(erasure ? { authorErasure: { authorId: erasure.authorId, mayErase: erasure.mayErase } } : {}),
  };
  if (responseBytes(output) > READING_PAGE_RESPONSE_BYTES) throw new ProblemError('content_too_large');
  return {
    value: output,
    anchors: [finalThread.anchor, finalSelection.page.anchor, finalBoard.anchor, ...(watchAnchor ? [watchAnchor] : [])],
  };
}
