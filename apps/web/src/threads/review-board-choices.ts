import type { KernelClient } from '@rezics/client';

type ReviewDestinationsRoute = ReturnType<KernelClient['realms']>['review-destinations'];
type ReviewDestinationsCall = Awaited<ReturnType<ReviewDestinationsRoute['get']>>;

/** The installed public response is the consumer contract for destination pages. */
export type ReviewDestinationPage = NonNullable<ReviewDestinationsCall['data']>;
export type ReviewDestinationItem = ReviewDestinationPage['items'][number];

type ReviewDestinationContext = NonNullable<ReviewDestinationPage['context']>;
type ReviewDestinationSource = ReviewDestinationContext['subject']['source'];

const destinationStates = new Set<unknown>([
  'choices',
  'sparse',
  'no-destinations',
  'exhausted',
  'denied',
  'expired',
]);
const viewerStates = new Set<unknown>(['current', 'denied']);

function isDestinationState(value: unknown): value is ReviewDestinationPage['state'] {
  return destinationStates.has(value);
}

function isViewerState(value: unknown): value is ReviewDestinationPage['viewer']['state'] {
  return viewerStates.has(value);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseSource(value: unknown): ReviewDestinationSource | null {
  if (
    !record(value) ||
    typeof value.partition !== 'number' ||
    !Number.isInteger(value.partition) ||
    value.partition < 0 ||
    typeof value.epoch !== 'number' ||
    !Number.isInteger(value.epoch) ||
    value.epoch <= 0 ||
    typeof value.position !== 'string' ||
    !/^\d+$/.test(value.position)
  )
    return null;
  return { partition: value.partition, epoch: value.epoch, position: value.position };
}

function parseContext(value: unknown): ReviewDestinationContext | null {
  if (!record(value) || !record(value.subject) || !record(value.realm)) return null;
  const subject = value.subject;
  const realm = value.realm;
  const source = parseSource(subject.source);
  const label = subject.label;
  if (
    typeof subject.id !== 'string' ||
    source === null ||
    (label !== null &&
      (!record(label) || typeof label.value !== 'string' || typeof label.language !== 'string')) ||
    typeof realm.id !== 'string' ||
    typeof realm.title !== 'string' ||
    typeof realm.spaceId !== 'string' ||
    typeof realm.headRevisionId !== 'string'
  )
    return null;
  return {
    subject: {
      id: subject.id,
      label: label === null ? null : { value: label.value, language: label.language },
      source,
    },
    realm: {
      id: realm.id,
      title: realm.title,
      spaceId: realm.spaceId,
      headRevisionId: realm.headRevisionId,
    },
  };
}

function parseItem(value: unknown): ReviewDestinationItem {
  if (!record(value) || !record(value.actions) || !record(value.native))
    throw new Error('Review destination response is unavailable');
  const { actions, native } = value;
  const subjectIds = native.subjectIds;
  const [subjectId] = Array.isArray(subjectIds) ? subjectIds : [];
  const subjectSource = parseSource(native.subjectSource);
  if (
    typeof value.id !== 'string' ||
    (value.title !== null && typeof value.title !== 'string') ||
    value.purpose !== 'reviews' ||
    actions.createReview !== 'allowed' ||
    native.kind !== 'review' ||
    native.boardId !== value.id ||
    !Array.isArray(subjectIds) ||
    subjectIds.length !== 1 ||
    typeof subjectId !== 'string' ||
    subjectSource === null ||
    typeof native.realmHeadRevisionId !== 'string' ||
    typeof native.boardSecurityRevision !== 'string' ||
    !/^[1-9][0-9]*$/.test(native.boardSecurityRevision)
  )
    throw new Error('Review destination response is unavailable');
  return {
    id: value.id,
    title: value.title,
    purpose: 'reviews',
    actions: { createReview: 'allowed' },
    native: {
      kind: 'review',
      boardId: native.boardId,
      subjectIds: [subjectId],
      subjectSource,
      realmHeadRevisionId: native.realmHeadRevisionId,
      boardSecurityRevision: native.boardSecurityRevision,
    },
  };
}

function parseReviewDestinationPage(value: unknown): ReviewDestinationPage {
  if (
    !record(value) ||
    !isDestinationState(value.state) ||
    !record(value.viewer) ||
    !isViewerState(value.viewer.state) ||
    !Array.isArray(value.items) ||
    value.items.length > 20 ||
    (value.next !== null && (typeof value.next !== 'string' || value.next.length > 4096))
  )
    throw new Error('Review destination response is unavailable');

  const state = value.state;
  const viewerState = value.viewer.state;
  const next = value.next;
  const context = value.context === null ? null : parseContext(value.context);
  const items = value.items.map(parseItem);
  if (value.context !== null && context === null) throw new Error('Review destination response is unavailable');

  if (
    (state === 'choices' && (!context || items.length === 0 || viewerState !== 'current')) ||
    (state === 'sparse' && (!context || items.length !== 0 || next === null || viewerState !== 'current')) ||
    (state === 'no-destinations' && (!context || items.length !== 0 || next !== null || viewerState !== 'current')) ||
    (state === 'exhausted' && (!context || items.length !== 0 || next !== null || viewerState !== 'current')) ||
    (state === 'expired' && (!context || items.length !== 0 || next !== null || viewerState !== 'current')) ||
    (state === 'denied' && (items.length !== 0 || next !== null)) ||
    (viewerState === 'denied' && state !== 'denied') ||
    (context !== null &&
      items.some(
        (item) =>
          item.native.subjectIds[0] !== context.subject.id ||
          item.native.subjectSource.partition !== context.subject.source.partition ||
          item.native.subjectSource.epoch !== context.subject.source.epoch ||
          item.native.subjectSource.position !== context.subject.source.position ||
          item.native.realmHeadRevisionId !== context.realm.headRevisionId,
      ))
  )
    throw new Error('Review destination response is unavailable');

  return {
    state,
    viewer: { state: viewerState },
    context,
    items,
    next,
  };
}

export async function loadReviewDestinationPage(
  client: KernelClient,
  input: { realmId: string; subjectId: string; cursor?: string; boardId?: string },
  authorization: string,
): Promise<ReviewDestinationPage> {
  const result = await client.realms({ realmId: input.realmId })['review-destinations'].get({
    query: {
      subjectId: input.subjectId,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      ...(input.boardId === undefined ? {} : { boardId: input.boardId }),
    },
    headers: { authorization },
  });
  if (result.status === 403 || result.status === 404)
    return { state: 'denied', viewer: { state: 'denied' }, context: null, items: [], next: null };
  if (result.error || !result.data) throw new Error('Review destination read failed');
  return parseReviewDestinationPage(result.data);
}
