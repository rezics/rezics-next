import type { KernelClient } from '@rezics/client';

/** Minimal local consumer seam for the mounted native route while the shared
 * source publisher has not installed its declarations. This is a public DTO;
 * it contains no kernel producer type and never synthesizes advice. */
export type ReviewDestinationPage = Readonly<{
  state: 'choices' | 'sparse' | 'no-destinations' | 'exhausted' | 'denied' | 'expired';
  viewer: Readonly<{ state: 'current' | 'denied' }>;
  context: Readonly<{
    subject: Readonly<{
      id: string;
      label: Readonly<{ value: string; language: string }> | null;
      source: Readonly<{ partition: number; epoch: number; position: string }>;
    }>;
    realm: Readonly<{ id: string; title: string; spaceId: string; headRevisionId: string }>;
  }> | null;
  items: readonly Readonly<{
    id: string;
    title: string | null;
    purpose: 'reviews';
    actions: Readonly<{ createReview: 'allowed' }>;
    native: Readonly<{
      kind: 'review';
      boardId: string;
      subjectIds: readonly [string];
      subjectSource: Readonly<{ partition: number; epoch: number; position: string }>;
      realmHeadRevisionId: string;
      boardSecurityRevision: string;
    }>;
  }>[];
  next: string | null;
}>;

type ReviewDestinationRouteClient = {
  realms(input: { realmId: string }): {
    'review-destinations': {
      get(input: {
        query: { subjectId: string; cursor?: string; boardId?: string };
        headers: { authorization: string };
      }): Promise<unknown>;
    };
  };
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function source(value: unknown): value is { partition: number; epoch: number; position: string } {
  const item = record(value);
  return (
    item !== null &&
    Number.isInteger(item.partition) &&
    (item.partition as number) >= 0 &&
    Number.isInteger(item.epoch) &&
    (item.epoch as number) > 0 &&
    typeof item.position === 'string' &&
    /^\d+$/.test(item.position)
  );
}

function parseReviewDestinationPage(value: unknown): ReviewDestinationPage {
  const page = record(value);
  if (
    !page ||
    !['choices', 'sparse', 'no-destinations', 'exhausted', 'denied', 'expired'].includes(String(page.state)) ||
    typeof page.viewer !== 'object' ||
    page.viewer === null ||
    !['current', 'denied'].includes(String((page.viewer as Record<string, unknown>).state)) ||
    !Array.isArray(page.items) ||
    page.items.length > 20 ||
    (page.next !== null && (typeof page.next !== 'string' || page.next.length > 4096))
  )
    throw new Error('Review destination response is unavailable');
  let context: ReviewDestinationPage['context'] = null;
  if (page.context !== null) {
    const candidate = record(page.context);
    const subject = record(candidate?.subject);
    const realm = record(candidate?.realm);
    const label = subject?.label;
    const normalizedLabel =
      label === null
        ? null
        : record(label) &&
            typeof (label as Record<string, unknown>).value === 'string' &&
            typeof (label as Record<string, unknown>).language === 'string'
          ? {
              value: (label as Record<string, unknown>).value as string,
              language: (label as Record<string, unknown>).language as string,
            }
          : undefined;
    if (
      !subject ||
      typeof subject.id !== 'string' ||
      !source(subject.source) ||
      normalizedLabel === undefined ||
      !realm ||
      typeof realm.id !== 'string' ||
      typeof realm.title !== 'string' ||
      typeof realm.spaceId !== 'string' ||
      typeof realm.headRevisionId !== 'string'
    )
      throw new Error('Review destination response is unavailable');
    context = {
      subject: {
        id: subject.id,
        label: normalizedLabel,
        source: { partition: subject.source.partition, epoch: subject.source.epoch, position: subject.source.position },
      },
      realm: {
        id: realm.id,
        title: realm.title,
        spaceId: realm.spaceId,
        headRevisionId: realm.headRevisionId,
      },
    };
  }
  const items = page.items.map((value): ReviewDestinationPage['items'][number] => {
    const item = record(value);
    const actions = record(item?.actions);
    const native = record(item?.native);
    if (
      !item ||
      typeof item.id !== 'string' ||
      (item.title !== null && typeof item.title !== 'string') ||
      item.purpose !== 'reviews' ||
      actions?.createReview !== 'allowed' ||
      native?.kind !== 'review' ||
      native.boardId !== item.id ||
      !Array.isArray(native.subjectIds) ||
      native.subjectIds.length !== 1 ||
      typeof native.subjectIds[0] !== 'string' ||
      !source(native.subjectSource) ||
      typeof native.realmHeadRevisionId !== 'string' ||
      typeof native.boardSecurityRevision !== 'string' ||
      !/^[1-9][0-9]*$/.test(native.boardSecurityRevision)
    )
      throw new Error('Review destination response is unavailable');
    return {
      id: item.id,
      title: item.title as string | null,
      purpose: 'reviews',
      actions: { createReview: 'allowed' },
      native: {
        kind: 'review',
        boardId: native.boardId,
        subjectIds: [native.subjectIds[0]],
        subjectSource: {
          partition: native.subjectSource.partition,
          epoch: native.subjectSource.epoch,
          position: native.subjectSource.position,
        },
        realmHeadRevisionId: native.realmHeadRevisionId,
        boardSecurityRevision: native.boardSecurityRevision,
      },
    };
  });
  const state = page.state as ReviewDestinationPage['state'];
  const viewerState = (page.viewer as Record<string, unknown>).state as 'current' | 'denied';
  const next = page.next as string | null;
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
  const route = (client as unknown as ReviewDestinationRouteClient).realms({ realmId: input.realmId })[
    'review-destinations'
  ];
  const result = record(
    await route.get({
      query: {
        subjectId: input.subjectId,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        ...(input.boardId === undefined ? {} : { boardId: input.boardId }),
      },
      headers: { authorization },
    }),
  );
  if (!result) throw new Error('Review destination read failed');
  if (result.status === 403 || result.status === 404)
    return { state: 'denied', viewer: { state: 'denied' }, context: null, items: [], next: null };
  if (result.error || !result.data) throw new Error('Review destination read failed');
  return parseReviewDestinationPage(result.data);
}
