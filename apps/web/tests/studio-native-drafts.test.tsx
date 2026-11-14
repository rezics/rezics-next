import { afterAll, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { fromPlainText, type DocumentSnapshot } from '@rezics/document';
import { editionDocumentDigest } from '../src/content-editions/edition-model';
import { StudioController } from '../src/studio/controller';
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

import { installPostReadingDom } from './post-reading-dom';

const dom = installPostReadingDom();
const { createRoot } = await import('react-dom/client');
const { getByRole, getByText, queryByRole, waitFor } = await import('@testing-library/dom');
const { StudioWorkspace } = await import('../src/studio/workspace');
const { m } = await import('../src/paraglide/messages.js');
const { setLocale } = await import('../src/paraglide/runtime.js');
setLocale('en', { reload: false });
afterAll(async () => {
  setLocale('en', { reload: false });
  await dom.restore();
});

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

const structuredHtml =
  '<h2>First structured heading</h2><p>A <strong>formatted</strong> opening.</p><ul><li><p>First point</p></li><li><p>Second point</p></li></ul><table><tbody><tr><th><p>Column</p></th></tr><tr><td><p>Preserved cell</p></td></tr></tbody></table>';

async function mountComposer(fixture = port()) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const risks: boolean[] = [];
  let activeInput = input();
  let activePort = fixture.value;
  const render = async () => {
    await act(async () =>
      root.render(
        createElement(StudioWorkspace, {
          input: activeInput,
          port: activePort,
          onDepartureRiskChange: (risk) => risks.push(risk),
        }),
      ),
    );
    const navigation = host.querySelector<HTMLDetailsElement>('.studio-mobile-navigation');
    if (navigation && !navigation.open)
      await act(async () => {
        navigation.open = true;
      });
  };
  await render();
  const form = () => getByRole(host, 'form', { name: m.studio_account_create() });
  const field = (name: string) => getByRole(form(), 'textbox', { name, exact: true });
  const button = (name: string) => getByRole(form(), 'button', { name, exact: true }) as HTMLButtonElement;
  const change = async (name: string, value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(field(name), value);
      field(name).dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
  };
  const paste = async (html: string) => {
    await act(async () => {
      const editor = field(m.studio_account_body());
      editor.focus();
      const clipboardData = new dom.window.DataTransfer();
      clipboardData.setData('text/html', html);
      editor.dispatchEvent(new dom.window.ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
    });
  };
  return {
    host,
    form,
    field,
    button,
    change,
    paste,
    risks,
    click: async (name: string) => {
      await act(async () => button(name).click());
    },
    fill: async () => {
      await change(m.studio_account_board(), boardId);
      await change(m.studio_account_title(), 'Structured before save');
      await paste(structuredHtml);
      await waitFor(() => expect(button(m.studio_account_create()).disabled).toBe(false));
    },
    replace: async (nextInput: StudioInput, nextPort = fixture.value) => {
      activeInput = nextInput;
      activePort = nextPort;
      await render();
    },
    close: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test('real initial composer previews and creates one structured snapshot with all native operands, then continues the exact Post', async () => {
  const f = port();
  const v = await mountComposer(f);
  try {
    await v.fill();
    expect(v.risks.at(-1)).toBe(true);
    const editor = v.field(m.studio_account_body());
    await v.click(m.studio_workspace_preview());
    const preview = getByRole(v.form(), 'region', { name: m.studio_workspace_preview_region() });
    expect(preview.querySelector('h2')?.textContent).toBe('First structured heading');
    expect(preview.querySelector('strong')?.textContent).toBe('formatted');
    expect(preview.querySelectorAll('li')).toHaveLength(2);
    expect(preview.querySelector('td')?.textContent).toBe('Preserved cell');
    await v.click(m.studio_workspace_write());
    expect(v.field(m.studio_account_body())).toBe(editor);
    await act(async () => getByText(v.form(), m.studio_native_metadata()).click());
    await v.change(m.own_drafts_licence(), licence);
    await v.change(m.own_drafts_subjects(), 'subject-a, subject-b');
    await v.change(m.own_drafts_media(), 'media-a, media-b');
    await v.click(m.studio_account_create());
    await waitFor(() => expect(f.createCalls).toHaveLength(1));
    await waitFor(() => expect((v.field(m.studio_account_title()) as HTMLInputElement).value).toBe(''));
    const command = f.createCalls[0]!;
    expect(command).toMatchObject({
      boardId,
      licence,
      subjectIds: ['subject-a', 'subject-b'],
      mediaIds: ['media-a', 'media-b'],
    });
    expect(command.body.doc.content?.map((node) => node.type)).toContain('heading');
    expect(command.body.doc.content?.map((node) => node.type)).toContain('bulletList');
    expect(command.body.doc.content?.map((node) => node.type)).toContain('table');
    const acknowledged = getByRole(v.host, 'textbox', { name: m.studio_workspace_article_document() });
    expect(acknowledged.querySelector('h2')?.textContent).toBe('First structured heading');
    expect(acknowledged.querySelector('td')?.textContent).toBe('Preserved cell');
    expect(f.current()?.revision.exact.postId).toBe(postId);
    expect(f.current()?.revision.body).toEqual(command.body);
    expect(v.risks.at(-1)).toBe(false);
  } finally {
    await v.close();
  }
});

test('pending and invalid editor snapshots cannot preview or submit a stale body', async () => {
  const f = port();
  const v = await mountComposer(f);
  try {
    await v.fill();
    await v.paste(`<p>${'x'.repeat(2 * 1024 * 1024)}</p>`);
    expect(v.button(m.studio_account_create()).disabled).toBe(true);
    expect(v.button(m.studio_workspace_preview()).disabled).toBe(true);
    await act(async () => v.form().dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })));
    expect(f.createCalls).toHaveLength(0);
    await waitFor(() => expect(v.form().textContent).toContain(m.studio_workspace_snapshot_error()));
    expect(v.button(m.studio_account_create()).disabled).toBe(true);
    expect(v.field(m.studio_account_body()).textContent).toContain('xxxx');
  } finally {
    await v.close();
  }
});

test('unknown creation replays its original structured intent and preserves later local edits after acknowledgement', async () => {
  const f = port({ uncertainCreate: true });
  const v = await mountComposer(f);
  try {
    await v.fill();
    await v.click(m.studio_account_create());
    await waitFor(() => expect(v.button(m.studio_native_retry()).disabled).toBe(false));
    const frozen = structuredClone(f.createCalls[0]!);
    await v.change(m.studio_account_board(), 'a-later-destination');
    await v.change(m.studio_account_title(), 'Later unsent title');
    await v.paste('<h3>Later unsent heading</h3>');
    await waitFor(() => expect(v.form().textContent).not.toContain(m.studio_workspace_snapshot_pending()));
    expect(v.button(m.studio_account_create()).disabled).toBe(true);
    expect(v.form().textContent).toContain(m.studio_native_later_edits());
    await v.click(m.studio_native_retry());
    await waitFor(() => expect(v.form().textContent).toContain(m.studio_native_retained()));
    expect(f.createCalls[1]).toEqual(frozen);
    expect((v.field(m.studio_account_title()) as HTMLInputElement).value).toBe('Later unsent title');
    expect((v.field(m.studio_account_board()) as HTMLInputElement).value).toBe('a-later-destination');
    expect(v.field(m.studio_account_body()).textContent).toContain('Later unsent heading');
    expect(f.current()?.revision.body).toEqual(frozen.body);
    expect(v.risks.at(-1)).toBe(true);
  } finally {
    await v.close();
  }
});

test('definite failure retains the document and cancellation uses explicit discard with workspace departure protection', async () => {
  const f = port();
  f.value.createNativeDraft = async () => ({
    ok: false,
    error: { kind: 'denied', message: 'This destination is not admitted.' },
  });
  const v = await mountComposer(f);
  try {
    await v.fill();
    await v.click(m.studio_account_create());
    await waitFor(() => expect(v.form().textContent).toContain(m.studio_native_failed()));
    expect(v.field(m.studio_account_body()).querySelector('table')).not.toBeNull();
    const departure = new dom.window.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(departure);
    expect(departure.defaultPrevented).toBe(true);
    await v.click(m.studio_workspace_discard_review());
    await v.click(m.studio_workspace_keep_changes());
    expect(v.field(m.studio_account_body()).querySelector('h2')).not.toBeNull();
    await v.click(m.studio_workspace_discard_review());
    await v.click(m.studio_workspace_discard());
    expect((v.field(m.studio_account_title()) as HTMLInputElement).value).toBe('');
    expect(v.field(m.studio_account_body()).textContent).toBe('');
    expect(v.risks.at(-1)).toBe(false);
  } finally {
    await v.close();
  }
});

test('visit and locale replacement retire the unsent editor, old creation result and late focus', async () => {
  for (const replacement of ['account-session-workspace', 'locale'] as const) {
    const f = port();
    const create = f.value.createNativeDraft!;
    let release!: () => void;
    let signal: AbortSignal | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.value.createNativeDraft = async (command, request) => {
      signal = request;
      const result = await create(command, request);
      await gate;
      return result;
    };
    const v = await mountComposer(f);
    try {
      await v.fill();
      await v.click(m.studio_account_create());
      if (replacement === 'locale') setLocale('ja', { reload: false });
      await v.replace({ ...input(), visitKey: replacement === 'locale' ? input().visitKey : 'replacement-visit' });
      expect(signal?.aborted).toBe(true);
      const destination = v.field(m.studio_account_board());
      destination.focus();
      await act(async () => release());
      await waitFor(() =>
        expect(queryByRole(v.host, 'textbox', { name: m.studio_workspace_article_document() })).toBeNull(),
      );
      expect((v.field(m.studio_account_title()) as HTMLInputElement).value).toBe('');
      expect(document.activeElement).toBe(destination);
      expect(v.risks.at(-1)).toBe(false);
    } finally {
      release();
      await v.close();
      setLocale('en', { reload: false });
    }
  }
});

test('a definite rejection of an unknown replay releases the form without discarding its structured body', async () => {
  const f = port({ uncertainCreate: true });
  const create = f.value.createNativeDraft!;
  let count = 0;
  f.value.createNativeDraft = async (...args) => {
    if (++count === 2)
      return { ok: false, error: { kind: 'denied', message: 'The original destination denied the request.' } };
    return create(...args);
  };
  const v = await mountComposer(f);
  try {
    await v.fill();
    await v.click(m.studio_account_create());
    await waitFor(() => expect(v.button(m.studio_native_retry()).disabled).toBe(false));
    await v.click(m.studio_native_retry());
    await waitFor(() => expect(v.form().textContent).toContain(m.studio_native_failed()));
    expect(v.button(m.studio_account_create()).disabled).toBe(false);
    expect(v.button(m.studio_workspace_discard_review()).disabled).toBe(false);
    expect(v.field(m.studio_account_body()).querySelector('table')).not.toBeNull();
  } finally {
    await v.close();
  }
});

test('a delayed first acknowledgement keeps edits made while creation is sending', async () => {
  const f = port();
  const create = f.value.createNativeDraft!;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.value.createNativeDraft = async (...args) => {
    const result = await create(...args);
    await gate;
    return result;
  };
  const v = await mountComposer(f);
  try {
    await v.fill();
    await v.click(m.studio_account_create());
    await v.change(m.studio_account_title(), 'Written while sending');
    await v.paste('<p>Later working body</p>');
    await act(async () => release());
    await waitFor(() => expect(v.form().textContent).toContain(m.studio_native_retained()));
    expect((v.field(m.studio_account_title()) as HTMLInputElement).value).toBe('Written while sending');
    expect(v.field(m.studio_account_body()).textContent).toContain('Later working body');
    expect(f.current()?.revision.title).toBe('Structured before save');
    expect(JSON.stringify(f.current()?.revision.body)).not.toContain('Later working body');
  } finally {
    release();
    await v.close();
  }
});
