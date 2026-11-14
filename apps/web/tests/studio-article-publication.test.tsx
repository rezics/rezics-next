import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { act, useSyncExternalStore } from 'react';
import type { DocumentNode, DocumentSnapshot } from '@rezics/document';
import type { PublicationReview, StudioPort, StudioResult, StudioSelection } from '../src/studio/contract';
import { installPostReadingDom } from './post-reading-dom';

const dom = installPostReadingDom();
const { createRoot } = await import('react-dom/client');
const { getByRole, getByText, queryByRole, waitFor } = await import('@testing-library/dom');
const { fromMarkdown, fromPlainText, normalizeDocument, withDocumentIds } = await import('@rezics/document');
const { editionDocumentDigest } = await import('../src/content-editions/edition-model');
const { StudioController } = await import('../src/studio/controller');
const { StudioPublication } = await import('../src/studio/publication');
const { m } = await import('../src/paraglide/messages.js');
const { setLocale } = await import('../src/paraglide/runtime.js');
setLocale('en', { reload: false });
afterAll(async () => {
  await dom.restore();
});

const ok = <T,>(value: T): StudioResult<T> => ({ ok: true, value });
const mediaId = '00000000-0000-8000-8000-000000000005';
function structuredBody() {
  const prose = fromMarkdown(
    '## Frozen heading\n\n- First point\n- Second point\n\n> Quoted evidence\n\nA [source](https://example.org/source).\n\n### Notes\n\n1. >!Concealed note!<\n\n```ts\nconst frozen = "exact";\n```',
    'blocks',
  );
  const cell = (type: string, text: string): DocumentNode => ({
    type,
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  });
  return normalizeDocument({
    ...prose,
    doc: withDocumentIds({
      type: 'doc',
      content: [
        ...prose.doc.content!,
        {
          type: 'table',
          content: [
            { type: 'tableRow', content: [cell('tableHeader', 'Frozen column'), cell('tableHeader', 'Value')] },
            { type: 'tableRow', content: [cell('tableCell', 'Frozen cell'), cell('tableCell', 'Exact value')] },
          ],
        },
        { type: 'image', attrs: { src: mediaId, alt: 'Supplied alt' } },
      ],
    }),
  });
}

async function fixture(unknown = false) {
  const body = structuredBody();
  let current: StudioSelection = {
    revision: {
      exact: { postId: 'post', revisionId: 'saved', sha256: await editionDocumentDigest(body) },
      title: 'Frozen article',
      body,
      mediaIds: [mediaId],
      savedAt: '2026-11-14T06:00:00Z',
    },
    native: { threadId: 'thread', boardId: 'exact-board', licence: 'CC-BY-4.0', subjectIds: ['exact-subject'] },
    visibility: 'draft',
    permissions: { edit: true, publish: true },
  };
  const unused = mock(async (): Promise<never> => {
    throw new Error('Unexpected read or write while reviewing.');
  });
  const commands: Parameters<StudioPort['publish']>[0][] = [];
  let gate: Promise<void> | null = null;
  const port: StudioPort = {
    isCurrent: () => true,
    documents: unused,
    createDraft: unused,
    saveDraft: unused,
    versions: unused,
    revision: unused,
    publications: unused,
    open: async () => ok(current),
    async reviewPublication({ target }) {
      const review: PublicationReview = {
        reviewId: '',
        authority: 'local',
        target: structuredClone(target),
        bookOutline: null,
        expectedPublicationRevision: null,
        expiresAt: '9999-12-31T23:59:59.999Z',
        notices: [],
        entries: [{ occurrenceId: null, title: current.revision.title, document: current.revision.exact }],
        articleSnapshot: {
          boardId: 'exact-board',
          licence: 'CC-BY-4.0',
          subjectIds: ['exact-subject'],
          mediaIds: [mediaId],
          body: structuredClone(current.revision.body),
        },
      };
      return ok(review);
    },
    async publish(command) {
      commands.push(structuredClone(command));
      if (gate) await gate;
      if (unknown && commands.length === 1) return { ok: false, error: { kind: 'uncertain', message: 'Lost reply' } };
      current = {
        ...current,
        visibility: 'published',
        revision: { ...current.revision, exact: { ...current.revision.exact, revisionId: 'published' } },
      };
      return ok({
        publicationId: 'publication',
        revision: 'published',
        state: 'published',
        publishedAt: null,
        entries: [{ occurrenceId: null, title: current.revision.title, document: current.revision.exact }],
        readbackSelection: current,
      });
    },
  };
  const controller = new StudioController(
    {
      visitKey: 'frozen-article-test',
      projectId: 'account',
      title: 'Column',
      profile: { kind: 'articles', seriesTitle: null },
      initialSelection: current,
      documents: { items: [], nextCursor: null },
      publications: { items: [], nextCursor: null },
      canCreateDraft: false,
      canPublish: true,
    },
    port,
  );
  const disconnect = controller.connect();
  await controller.reviewPublication();
  return {
    controller,
    disconnect,
    commands,
    unused,
    hold: (value: Promise<void> | null) => {
      gate = value;
    },
    observeLater: async () => {
      const later = fromPlainText('Later private saved text', 'blocks');
      current = {
        ...current,
        visibility: 'draft',
        revision: {
          ...current.revision,
          body: later,
          exact: { ...current.revision.exact, revisionId: 'later', sha256: await editionDocumentDigest(later) },
        },
      };
      await controller.open('post');
    },
  };
}

async function mount(f: Awaited<ReturnType<typeof fixture>>, labels = false, workingBody?: DocumentSnapshot) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  function View() {
    const state = useSyncExternalStore(f.controller.subscribe, f.controller.snapshot, f.controller.snapshot);
    return (
      <StudioPublication
        controller={f.controller}
        state={workingBody && state.selected ? { ...state, selected: { ...state.selected, body: workingBody } } : state}
        {...(labels
          ? {
              articlePresentation: () => ({
                destinationLabel: 'Human destination',
                licenceLabel: 'Human licence',
                subjectLabels: { 'exact-subject': 'Human subject' },
              }),
            }
          : {})}
      />
    );
  }
  await act(async () => root.render(<View />));
  return {
    host,
    close: async () => {
      await act(async () => root.unmount());
      host.remove();
      f.disconnect();
    },
  };
}
const button = (host: HTMLElement, name: string) =>
  getByRole(host, 'button', { name, exact: true }) as HTMLButtonElement;

test('frozen review preserves structured reading and inspectable operands without using working text or resolving media', async () => {
  const f = await fixture();
  const view = await mount(f, false, fromPlainText('Live working text must not enter review', 'blocks'));
  try {
    expect(getByRole(view.host, 'heading', { name: 'Frozen heading' })).toBeTruthy();
    expect(view.host.querySelector('blockquote')?.textContent).toBe('Quoted evidence');
    expect(view.host.querySelector('[data-slot="document-body"] ul li')?.textContent).toBe('First point');
    expect(view.host.querySelector('th[scope="col"]')?.textContent).toBe('Frozen column');
    expect(view.host.querySelector('td')?.textContent).toBe('Frozen cell');
    expect(view.host.querySelector('pre code')?.textContent).toContain('const frozen = "exact";');
    expect(getByRole(view.host, 'link', { name: 'source' }).getAttribute('href')).toBe('https://example.org/source');
    expect(view.host.textContent).not.toContain('Live working text');
    expect(view.host.textContent).toContain(m.studio_article_unnamed_destination());
    expect(view.host.textContent).toContain('exact-board');
    expect(view.host.textContent).toContain('exact-subject');
    expect(view.host.textContent).toContain(mediaId);
    expect(view.host.querySelector('img, video, audio, iframe')).toBeNull();
    expect(button(view.host, m.studio_release_publish_article()).disabled).toBe(true);
    expect(f.commands).toHaveLength(0);
    expect(f.unused).not.toHaveBeenCalled();
    await act(async () => button(view.host, m.thread_reveal_spoiler()).click());
    expect(view.host.querySelector('.document-spoiler-revealed')?.textContent).toBe('Concealed note');
  } finally {
    await view.close();
  }
});

test('equal-byte review replacement retires consent, operand details, wide inspection and late clipboard focus; editing retires the replacement', async () => {
  const f = await fixture();
  const view = await mount(f, true);
  let finishCopy!: () => void;
  const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: () =>
        new Promise<void>((resolve) => {
          finishCopy = resolve;
        }),
    },
  });
  const outside = document.createElement('button');
  outside.textContent = 'Outside review';
  document.body.append(outside);
  try {
    expect(view.host.textContent).toContain('Human destination');
    expect(view.host.textContent).toContain('Human licence');
    expect(view.host.textContent).toContain('Human subject');
    await act(async () => {
      (getByRole(view.host, 'checkbox') as HTMLInputElement).click();
      button(view.host, m.thread_reveal_spoiler()).click();
      getByText(view.host, m.studio_article_references()).click();
    });
    expect(button(view.host, m.studio_release_publish_article()).disabled).toBe(false);
    await act(async () => button(view.host, m.wide_document_code_inspect()).click());
    const dialog = getByRole(document.body, 'dialog');
    await act(async () => button(dialog, m.wide_document_code_copy()).click());
    const first = f.controller.snapshot().review;
    await act(async () => {
      await f.controller.reviewPublication();
    });
    expect(f.controller.snapshot().review).not.toBe(first);
    expect(f.controller.snapshot().review?.articleSnapshot).toEqual(first?.articleSnapshot);
    await waitFor(() => expect(queryByRole(document.body, 'dialog')).toBeNull());
    expect((getByRole(view.host, 'checkbox') as HTMLInputElement).checked).toBe(false);
    expect(button(view.host, m.studio_release_publish_article()).disabled).toBe(true);
    expect(view.host.querySelector('.document-spoiler-revealed')).toBeNull();
    expect(getByText(view.host, m.studio_article_references()).closest('details')?.open).toBe(false);
    outside.focus();
    await act(async () => finishCopy());
    expect(document.activeElement).toBe(outside);
    expect(view.host.textContent).not.toContain(m.wide_document_code_copied());
    await act(async () => button(view.host, m.wide_document_table_inspect()).click());
    await act(async () => f.controller.changeTitle('A later private edit'));
    await waitFor(() => expect(queryByRole(document.body, 'dialog')).toBeNull());
    expect(view.host.querySelector('[data-slot="post-reading-body"]')).toBeNull();
    expect(f.commands).toHaveLength(0);
  } finally {
    if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard);
    else Reflect.deleteProperty(navigator, 'clipboard');
    outside.remove();
    await view.close();
  }
});

test('sending and uncertain publication replay the same frozen intent without renewed consent, then keep acknowledgement distinct from later current reads', async () => {
  const f = await fixture(true);
  const view = await mount(f);
  const publishes = spyOn(f.controller, 'publish');
  let finish!: () => void;
  f.hold(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  try {
    await act(async () => (getByRole(view.host, 'checkbox') as HTMLInputElement).click());
    expect(view.host.textContent).toContain(m.studio_article_consented());
    await act(async () => button(view.host, m.studio_release_publish_article()).click());
    expect(view.host.textContent).toContain(m.studio_article_sending());
    expect(button(view.host, m.library_collection_move_cancel_review()).disabled).toBe(true);
    await act(async () => {
      finish();
      await publishes.mock.results[0]?.value;
    });
    f.hold(null);
    expect(view.host.textContent).toContain(m.studio_article_uncertain());
    expect(queryByRole(view.host, 'checkbox')).toBeNull();
    expect(button(view.host, m.studio_article_retry()).disabled).toBe(false);
    expect(button(view.host, m.studio_release_refresh()).disabled).toBe(true);
    const frozen = f.controller.snapshot().review;
    await act(async () => {
      button(view.host, m.studio_article_retry()).click();
      await publishes.mock.results[1]?.value;
    });
    expect(f.commands).toHaveLength(2);
    expect(f.commands[1]).toEqual(f.commands[0]);
    expect(f.commands[1]?.review).toEqual(frozen);
    expect(getByRole(view.host, 'region', { name: m.studio_article_acknowledged() })).toBeTruthy();
    expect(view.host.querySelector('[data-slot="post-reading-body"]')).toBeNull();
    expect(queryByRole(view.host, 'region', { name: m.studio_article_current() })).toBeNull();
    await act(async () => {
      await f.observeLater();
    });
    expect(getByRole(view.host, 'region', { name: m.studio_article_current() }).textContent).toContain('later');
    expect(view.host.textContent).toContain(m.studio_release_receipt({ revision: 'published' }));
    expect(f.controller.snapshot().published?.readbackSelection?.revision.exact.revisionId).toBe('published');
    expect(f.controller.snapshot().selected?.source.revision.exact.revisionId).toBe('later');
    expect(f.unused).not.toHaveBeenCalled();
  } finally {
    publishes.mockRestore();
    await view.close();
  }
});
