import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { fromPlainText, type DocumentSnapshot } from '@rezics/document';
import { editionDocumentDigest } from '../src/content-editions/edition-model';
import { StudioController } from '../src/studio/controller';
import { StudioWorkspace } from '../src/studio/workspace';
import type {
  ArticleReviewSnapshot,
  NativeDraftCreate,
  PublicationRecord,
  PublicationReview,
  StudioDocument,
  StudioInput,
  StudioPort,
  StudioResult,
  StudioSelection,
} from '../src/studio/contract';

const projectId = '0192f3a0-6c1e-7b2a-9d4e-000000000001';
const postId = '0192f3a0-6c1e-7b2a-9d4e-000000000002';
const threadId = '0192f3a0-6c1e-7b2a-9d4e-000000000003';
const revisionId = '0192f3a0-6c1e-7b2a-9d4e-000000000004';
const publishedRevisionId = '0192f3a0-6c1e-7b2a-9d4e-000000000005';
const boardId = '0192f3a0-6c1e-7b2a-9d4e-000000000006';
const licence = 'CC-BY-4.0';
const body = fromPlainText('The exact acknowledged article body.', 'blocks') as DocumentSnapshot;
const ok = <T,>(value: T): StudioResult<T> => ({ ok: true, value });
const failure = (kind: 'uncertain' | 'unavailable') => ({
  ok: false as const,
  error: { kind, message: 'The operation did not finish. Retry the same operation.' },
});

async function selection(
  input: Readonly<{
    body?: DocumentSnapshot;
    postId?: string;
    revisionId?: string;
    title?: string;
    visibility?: 'draft' | 'published';
    permissions?: Readonly<{ edit: boolean; publish: boolean }>;
    native?: StudioSelection['native'];
  }> = {},
): Promise<StudioSelection> {
  const document = input.body ?? body;
  return {
    revision: {
      exact: {
        postId: input.postId ?? postId,
        revisionId: input.revisionId ?? revisionId,
        sha256: await editionDocumentDigest(document),
      },
      title: input.title ?? 'A private opening',
      body: document,
      mediaIds: [],
      savedAt: '2026-11-12T01:00:00.000Z',
    },
    visibility: input.visibility ?? 'draft',
    native: input.native ?? { threadId, boardId, licence, subjectIds: [] },
    permissions: input.permissions ?? { edit: true, publish: true },
  };
}

function input(initialSelection?: StudioSelection, rows: readonly StudioDocument[] = []): StudioInput {
  return {
    visitKey: 'account-native-drafts-test',
    projectId,
    title: 'Account drafts',
    profile: { kind: 'articles', seriesTitle: null },
    documents: { items: rows, nextCursor: 'opaque-next' },
    ...(initialSelection ? { initialSelection } : {}),
    publications: { items: [], nextCursor: null },
    canCreateDraft: true,
    nativeDrafts: true,
    canPublish: true,
  };
}

function port(options: { uncertainCreate?: boolean; uncertainPublish?: boolean } = {}) {
  let current: StudioSelection | null = null;
  let createCount = 0;
  let publishCount = 0;
  const createCalls: Array<NativeDraftCreate & { idempotencyKey: string }> = [];
  const publishCalls: Parameters<StudioPort['publish']>[0][] = [];
  const native = { threadId, boardId, licence, subjectIds: [] as readonly string[] };
  const value: StudioPort = {
    isCurrent: () => true,
    documents: async () => ok({ items: [], nextCursor: null }),
    open: async () => (current ? ok(current) : failure('unavailable')),
    createDraft: async () => failure('unavailable'),
    async createNativeDraft(command) {
      createCalls.push(structuredClone(command));
      createCount++;
      if (options.uncertainCreate && createCount === 1) return failure('uncertain');
      current = await selection({
        body: command.body,
        title: command.title,
        native: { ...native, boardId: command.boardId, licence: command.licence, subjectIds: command.subjectIds },
      });
      return ok(current);
    },
    async saveDraft(command) {
      current = await selection({ body: command.body, title: command.title, revisionId: publishedRevisionId });
      return ok(current);
    },
    versions: async () => ok({ items: [], nextCursor: null }),
    revision: async () => (current ? ok(current.revision) : failure('unavailable')),
    async reviewPublication({ target }) {
      if (!current || target.kind !== 'article') return failure('unavailable');
      const snapshot: ArticleReviewSnapshot = {
        boardId: current.native!.boardId,
        licence: current.native!.licence,
        subjectIds: [...current.native!.subjectIds],
        mediaIds: [...current.revision.mediaIds],
        body: structuredClone(current.revision.body),
      };
      const review: PublicationReview = {
        reviewId: '',
        authority: 'local',
        target: structuredClone(target),
        expectedPublicationRevision: null,
        expiresAt: '9999-12-31T23:59:59.999Z',
        bookOutline: null,
        entries: [{ occurrenceId: null, title: current.revision.title, document: current.revision.exact }],
        notices: [],
        articleSnapshot: snapshot,
      };
      return ok(review);
    },
    async publish(command) {
      publishCalls.push(structuredClone(command));
      publishCount++;
      if (options.uncertainPublish && publishCount === 1) return failure('uncertain');
      if (!current || command.review.target.kind !== 'article') return failure('unavailable');
      current = await selection({
        body: command.review.articleSnapshot!.body,
        revisionId: publishedRevisionId,
        title: command.review.entries[0]!.title,
        visibility: 'published',
        permissions: { edit: false, publish: false },
        native: {
          threadId,
          boardId: command.review.articleSnapshot!.boardId,
          licence: command.review.articleSnapshot!.licence,
          subjectIds: command.review.articleSnapshot!.subjectIds,
        },
      });
      const record: PublicationRecord = {
        publicationId: `post:${postId}`,
        revision: publishedRevisionId,
        publishedAt: null,
        state: 'published',
        entries: [{ occurrenceId: null, title: current.revision.title, document: current.revision.exact }],
        readbackSelection: current,
      };
      return ok(record);
    },
    publications: async () => ok({ items: [], nextCursor: null }),
  };
  return { value, createCalls, publishCalls, current: () => current };
}

const createInput: NativeDraftCreate = {
  boardId,
  title: 'A private opening',
  body,
  licence,
  subjectIds: [],
  mediaIds: [],
};

test('native Studio creation retries the same private intent after an uncertain response', async () => {
  const fixture = port({ uncertainCreate: true });
  const controller = new StudioController(input(), fixture.value);
  const disconnect = controller.connect();
  try {
    expect(await controller.createNativeDraft(createInput)).toBe(false);
    expect(controller.snapshot().issue?.kind).toBe('uncertain');
    expect(await controller.retry()).toBe(true);
    expect(fixture.createCalls).toHaveLength(2);
    expect(fixture.createCalls[1]).toEqual(fixture.createCalls[0]);
    expect(fixture.current()?.visibility).toBe('draft');
    expect(fixture.current()?.native).toEqual({ threadId, boardId, licence, subjectIds: [] });
  } finally {
    disconnect();
  }
});

test('native Studio keeps its account inventory bounded when a new row is acknowledged', async () => {
  const fixture = port();
  const rows = Array.from({ length: 20 }, (_, index) => ({
    postId: `older-${index}`,
    title: `Older draft ${index}`,
    revisionId,
    updatedAt: '2026-11-12T01:00:00.000Z',
    state: 'draft' as const,
  }));
  const controller = new StudioController(input(undefined, rows), fixture.value);
  const disconnect = controller.connect();
  try {
    expect(await controller.createNativeDraft(createInput)).toBe(true);
    expect(controller.snapshot().documents.items).toHaveLength(20);
    expect(controller.snapshot().documents.items[0]?.postId).toBe(postId);
    expect(controller.snapshot().documents.nextCursor).toBe('opaque-next');
  } finally {
    disconnect();
  }
});

test('editing a selected account draft retires its local acknowledged-revision review', async () => {
  const fixture = port();
  const controller = new StudioController(input(), fixture.value);
  const disconnect = controller.connect();
  try {
    expect(await controller.createNativeDraft(createInput)).toBe(true);
    await controller.reviewPublication();
    expect(controller.snapshot().review?.authority).toBe('local');
    controller.changeTitle('A later private edit');
    expect(controller.snapshot().review).toBeNull();
    expect(controller.snapshot().selected?.dirty).toBe(true);
  } finally {
    disconnect();
  }
});

test('uncertain article publication retries its frozen exact revision and reads back acknowledgement', async () => {
  const fixture = port({ uncertainPublish: true });
  const controller = new StudioController(input(), fixture.value);
  const disconnect = controller.connect();
  try {
    expect(await controller.createNativeDraft(createInput)).toBe(true);
    await controller.reviewPublication();
    const frozen = structuredClone(controller.snapshot().review!);
    expect(await controller.publish()).toBe(false);
    expect(controller.snapshot().issue?.kind).toBe('uncertain');
    expect(await controller.retry()).toBe(true);
    expect(fixture.publishCalls).toHaveLength(2);
    expect(fixture.publishCalls[1]).toEqual(fixture.publishCalls[0]);
    expect(fixture.publishCalls[1]?.review.target).toEqual(frozen.target);
    expect(fixture.publishCalls[1]?.review.articleSnapshot).toEqual(frozen.articleSnapshot);
    expect(controller.snapshot().published?.state).toBe('published');
    expect(controller.snapshot().selected?.source.visibility).toBe('published');
    expect(controller.snapshot().selected?.source.revision.body).toEqual(frozen.articleSnapshot?.body);
  } finally {
    disconnect();
  }
});

test('Studio leads with the document and starts its draft navigation as a compact disclosure', () => {
  const fixture = port();
  const markup = renderToStaticMarkup(createElement(StudioWorkspace, { input: input(), port: fixture.value }));
  const documentPosition = markup.indexOf('class="studio-document"');
  const navigationPosition = markup.indexOf('class="studio-sidebar"');

  expect(documentPosition).toBeGreaterThanOrEqual(0);
  expect(navigationPosition).toBeGreaterThan(documentPosition);
  expect(markup).toContain('<details class="studio-mobile-navigation">');
});
