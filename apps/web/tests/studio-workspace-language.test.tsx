import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { act } from 'react';
import type {
  DraftSave,
  StudioFailure,
  StudioInput,
  StudioPort,
  StudioResult,
  StudioSelection,
} from '../src/studio/contract';
import type { HostedBookStartBinding } from '../src/studio/hosted-book-start';
import { installPostReadingDom } from './post-reading-dom';

const dom = installPostReadingDom();
const { createRoot } = await import('react-dom/client');
const { getByRole, queryByRole, waitFor } = await import('@testing-library/dom');
const { fromPlainText } = await import('@rezics/document');
const { editionDocumentDigest } = await import('../src/content-editions/edition-model');
const { StudioWorkspace } = await import('../src/studio/workspace');
const { workbenchCopy } = await import('../src/studio/workbench-copy');
const language = await import('../src/studio/workspace-language');
const { m } = await import('../src/paraglide/messages.js');
const { setLocale, locales } = await import('../src/paraglide/runtime.js');
afterAll(async () => {
  setLocale('en', { reload: false });
  await dom.restore();
});
const ok = <T,>(value: T): StudioResult<T> => ({ ok: true, value });
const detail = 'Supplied <detail> & 原因';
const failed = (kind: StudioFailure['kind']): StudioResult<never> => ({ ok: false, error: { kind, message: detail } });

async function fixture(kind: StudioInput['profile']['kind'] = 'articles', editable = true) {
  const body = fromPlainText('Private <body> & 本文', 'blocks');
  const first: StudioSelection = {
    revision: {
      exact: { postId: 'post-一', revisionId: 'saved-一', sha256: await editionDocumentDigest(body) },
      title: 'Title <一> & "two"',
      body,
      mediaIds: [],
      savedAt: '2026-11-13T12:34:56.123456Z',
    },
    native: { threadId: 'thread', boardId: 'board', licence: 'CC-BY-4.0', subjectIds: ['subject'] },
    visibility: 'draft',
    permissions: { edit: editable, publish: editable },
  };
  const second: StudioSelection = {
    ...first,
    revision: { ...first.revision, title: '', exact: { ...first.revision.exact, postId: 'post-二' } },
  };
  const unused = mock(async (): Promise<never> => {
    throw new Error('Unexpected Studio request');
  });
  let saveFailure: StudioFailure['kind'] | null = null;
  let openFailure: StudioFailure['kind'] | 'transport' | null = null;
  let saveGate: Promise<void> | null = null;
  let publishGate: Promise<void> | null = null;
  let live = first;
  const saves: DraftSave[] = [];
  const port: StudioPort = {
    isCurrent: () => true,
    documents: mock(async () => failed('unavailable')),
    open: mock(async ({ postId }) => {
      if (openFailure === 'transport') throw new Error('Untrusted transport exception');
      return openFailure ? failed(openFailure) : ok(postId === 'post-二' ? second : live);
    }),
    createDraft: mock(async ({ title }) => ok({ ...first, revision: { ...first.revision, title } })),
    createNativeDraft: mock(async (command) =>
      ok({
        ...first,
        revision: {
          ...first.revision,
          title: command.title,
          body: command.body,
          exact: { ...first.revision.exact, sha256: await editionDocumentDigest(command.body) },
        },
      }),
    ),
    saveDraft: mock(async (command) => {
      saves.push(command);
      if (saveGate) await saveGate;
      if (saveFailure) return failed(saveFailure);
      live = {
        ...first,
        revision: {
          ...first.revision,
          title: command.title,
          body: command.body,
          exact: {
            ...first.revision.exact,
            revisionId: 'saved-next',
            sha256: await editionDocumentDigest(command.body),
          },
        },
      };
      return ok(live);
    }),
    versions: unused,
    revision: unused,
    publications: unused,
    reviewPublication: mock(async ({ target }) =>
      ok({
        reviewId: '',
        authority: 'local',
        target,
        expectedPublicationRevision: null,
        expiresAt: '2099-01-01T00:00:00Z',
        bookOutline: null,
        entries: [{ occurrenceId: null, title: live.revision.title, document: live.revision.exact }],
        notices: [],
        articleSnapshot: { boardId: 'board', licence: 'CC-BY-4.0', subjectIds: ['subject'], mediaIds: [], body },
      }),
    ),
    publish: mock(async ({ review }) => {
      if (publishGate) await publishGate;
      return ok({
        publicationId: 'release',
        revision: 'released',
        publishedAt: null,
        state: 'published',
        entries: review.entries,
        readbackSelection: { ...live, visibility: 'published' },
      });
    }),
  };
  const structure = {
    catalogueId: 'book',
    revision: 'outline',
    placements: [],
    limits: { maxDepth: 4, maxPlacements: 20 },
    canOrganize: false,
  };
  const input: StudioInput = {
    visitKey: 'workspace-language',
    projectId: 'project',
    title: 'Workspace <原稿>',
    profile: kind === 'book' ? { kind, structure } : { kind, seriesTitle: 'Series <系列>' },
    initialSelection: first,
    documents: {
      items: [first, second].map(({ revision }) => ({
        postId: revision.exact.postId,
        revisionId: revision.exact.revisionId,
        title: revision.title,
        updatedAt: revision.savedAt,
        state: 'draft',
      })),
      nextCursor: 'opaque+/=',
    },
    publications: { items: [], nextCursor: null },
    canCreateDraft: false,
    canPublish: editable,
  };
  return {
    input,
    port,
    first,
    second,
    unused,
    saves,
    saveFailure: (kind: typeof saveFailure) => {
      saveFailure = kind;
    },
    openFailure: (kind: typeof openFailure) => {
      openFailure = kind;
    },
    holdSave: () => {
      let release!: () => void;
      saveGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    holdPublish: () => {
      let release!: () => void;
      publishGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
  };
}

async function mount(f: Awaited<ReturnType<typeof fixture>>, input = f.input, bookStart?: HostedBookStartBinding) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<StudioWorkspace input={input} port={f.port} bookStart={bookStart} />));
  const button = (name: string) => getByRole(host, 'button', { name, exact: true }) as HTMLButtonElement;
  return {
    host,
    button,
    click: async (name: string) => {
      await act(async () => button(name).click());
    },
    open: async (name: string) => {
      await act(async () => button(name).click());
    },
    title: () => getByRole(host, 'textbox', { name: m.studio_workspace_title(), exact: true }) as HTMLInputElement,
    change: async (node: HTMLElement, value: string) => {
      await act(async () => {
        const prototype =
          node instanceof window.HTMLTextAreaElement
            ? window.HTMLTextAreaElement.prototype
            : window.HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(node, value);
        node.dispatchEvent(new window.Event('input', { bubbles: true }));
      });
    },
    close: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test('uncertain Book-start retry remains reachable while document controls are locked', async () => {
  setLocale('en', { reload: false });
  const f = await fixture();
  const attempts: Array<Parameters<HostedBookStartBinding['native']['create']>> = [];
  const observation = {
    sourceId: 'studio-session',
    generation: 1,
    dataUpdateCount: 1,
    dataUpdatedAt: 1,
    state: 'signed-in',
    subject: 'author',
    credentialMode: 'session',
    healthy: true,
    csrfReady: true,
  } as const;
  const bookStart: HostedBookStartBinding = {
    native: {
      create: mock(async (...args: Parameters<HostedBookStartBinding['native']['create']>) => {
        attempts.push(args);
        return failed('uncertain');
      }),
      readOwn: f.unused,
    },
    source: {
      id: observation.sourceId,
      read: () => observation,
      revision: () => observation.generation,
      subscribe: () => () => {},
    },
    viewer: { accountId: observation.subject, authnEpoch: 1 },
    isCurrent: () => true,
    navigate: () => {},
  };
  const v = await mount(f, f.input, bookStart);
  try {
    await v.click(m.studio_book_start_label());
    expect(v.host.querySelector('fieldset')!.disabled).toBe(true);
    const retry = v.button(m.studio_book_start_retry());
    expect(retry.closest('fieldset:disabled')).toBeNull();
    expect(retry.disabled).toBe(false);
    expect(getByRole(v.host, 'alert').textContent).toContain(m.studio_book_start_uncertain());
    await v.click(m.studio_book_start_retry());
    expect(attempts).toHaveLength(2);
    expect(attempts[1]!.slice(0, 2)).toEqual(attempts[0]!.slice(0, 2));
    expect(f.unused).not.toHaveBeenCalled();
  } finally {
    await v.close();
  }
});

test('workspace keys and named arguments match in all eight launch catalogues', async () => {
  const catalogues = await Promise.all(
    locales.map((locale) => Bun.file(`${import.meta.dir}/../messages/${locale}.json`).json()),
  );
  const keys = Object.keys(catalogues[0])
    .filter((key) => key.startsWith('studio_workspace_'))
    .sort();
  const args = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
  expect(locales).toHaveLength(8);
  expect(keys.length).toBeGreaterThan(70);
  for (const catalogue of catalogues) {
    expect(Object.keys(catalogue).sort()).toEqual(Object.keys(catalogues[0]).sort());
    for (const key of keys) {
      expect(catalogue[key].trim().length).toBeGreaterThan(0);
      expect(args(catalogue[key])).toEqual(args(catalogues[0][key]));
    }
  }
});

const cases = locales.flatMap((locale) => (['book', 'articles'] as const).map((kind) => [locale, kind] as const));
test.each(cases)(
  '%s %s: private preview, newer edits, exact uncertain replay and deliberate dirty navigation',
  async (locale, kind) => {
    setLocale(locale, { reload: false });
    const f = await fixture(kind);
    const v = await mount(f);
    try {
      expect(getByRole(v.host, 'region', { name: m.studio_workspace_region({ title: f.input.title }) })).toBeTruthy();
      expect(v.host.textContent).toContain(m.studio_workspace_private_help());
      expect(
        getByRole(v.host, 'textbox', {
          name: kind === 'book' ? m.studio_workspace_chapter_document() : m.studio_workspace_article_document(),
        }).getAttribute('lang'),
      ).toBe(locale);
      const editor = getByRole(v.host, 'textbox', {
        name: kind === 'book' ? m.studio_workspace_chapter_document() : m.studio_workspace_article_document(),
      });
      await v.click(m.studio_workspace_preview());
      const preview = getByRole(v.host, 'region', { name: m.studio_workspace_preview_region() });
      expect(preview.textContent).toContain('Private <body> & 本文');
      expect(preview.textContent).toContain(m.studio_workspace_preview_saved());
      expect(preview.querySelector('[data-slot="post-reading-body"]')).not.toBeNull();
      expect(preview.querySelector('[data-slot="post-reading-controls"]')?.getAttribute('lang')).toBe(locale);
      expect(queryByRole(preview, 'button', { name: m.post_references_title(), exact: true })).toBeNull();
      expect(getByRole(preview, 'group', { name: m.studio_revision_current() }).textContent).toContain(
        f.first.revision.exact.revisionId,
      );
      await v.click(m.studio_workspace_write());
      expect(getByRole(v.host, 'textbox', { name: editor.getAttribute('aria-label')! })).toBe(editor);
      await v.change(v.title(), 'Captured <draft>');
      const release = f.holdSave();
      await v.click(m.studio_workspace_save());
      expect(v.host.textContent).toContain(m.studio_workspace_saving());
      expect(v.title().disabled).toBe(false);
      await v.change(v.title(), 'Newer <working>');
      await act(async () => {
        release();
      });
      await waitFor(() => expect(v.host.textContent).toContain(m.studio_workspace_saved_newer()));
      expect(v.title().value).toBe('Newer <working>');
      await v.click(m.studio_workspace_preview());
      expect(getByRole(v.host, 'region', { name: m.studio_workspace_preview_region() }).textContent).toContain(
        m.studio_workspace_preview_unsaved(),
      );
      expect(getByRole(v.host, 'heading', { name: 'Newer <working>', exact: true })).toBeTruthy();
      await v.click(m.studio_workspace_write());
      f.saveFailure('uncertain');
      await v.click(m.studio_workspace_save());
      await waitFor(() =>
        expect(getByRole(v.host, 'alert').textContent).toContain(m.studio_workspace_failure_uncertain()),
      );
      expect(getByRole(v.host, 'alert').textContent).toContain(detail);
      const frozen = f.saves.at(-1)!;
      const operands = structuredClone(frozen);
      await v.change(v.title(), 'After uncertainty');
      f.saveFailure(null);
      await v.click(m.studio_workspace_retry());
      await waitFor(() => expect(v.host.textContent).toContain(m.studio_workspace_saved_newer()));
      expect(f.saves.at(-1)).toBe(frozen);
      expect(f.saves.at(-1)).toEqual(operands);
      expect(operands).toMatchObject({
        title: 'Newer <working>',
        expectedRevisionId: 'saved-next',
        native: { visibility: 'draft', boardId: 'board', licence: 'CC-BY-4.0', subjectIds: ['subject'] },
      });
      expect(v.title().value).toBe('After uncertainty');
      await v.click(m.studio_workspace_save());
      await waitFor(() => expect(v.host.textContent).toContain(m.studio_workspace_saved()));
      await v.change(v.title(), 'Switch me');
      f.saveFailure('stale');
      await v.click(m.studio_workspace_save());
      await waitFor(() => expect(getByRole(v.host, 'alert').textContent).toContain(m.studio_workspace_failure_stale()));
      expect(v.title().value).toBe('Switch me');
      expect(queryByRole(v.host, 'button', { name: m.studio_workspace_retry(), exact: true })).toBeNull();
      f.saveFailure(null);
      await v.open(m.own_drafts_no_title());
      expect(getByRole(v.host, 'region', { name: m.studio_workspace_switch_region() })).toBeTruthy();
      expect(f.port.open).not.toHaveBeenCalled();
      await v.click(m.studio_workspace_keep_editing());
      expect(v.title().value).toBe('Switch me');
      await v.open(m.own_drafts_no_title());
      await v.click(m.studio_workspace_save_switch());
      await waitFor(() => expect(v.title().value).toBe(''));
      expect(getByRole(v.host, 'heading', { name: m.own_drafts_no_title(), exact: true })).toBeTruthy();
      expect(queryByRole(v.host, 'heading', { name: 'post-二', exact: true })).toBeNull();
      expect(document.activeElement?.textContent).toBe(m.own_drafts_no_title());
      await v.click(workbenchCopy[locale].draftActions);
      const identity = v.host.querySelector<HTMLDetailsElement>('.studio-document .studio-technical')!;
      expect(identity.textContent).toContain('post-二');
      expect(identity.textContent).toContain(f.second.revision.exact.revisionId);
      expect(identity.textContent).toContain(f.second.revision.exact.sha256);
      await v.change(v.title(), 'Local only');
      await v.click(m.studio_workspace_discard_review());
      expect(v.host.textContent).toContain(m.studio_workspace_discard_prompt());
      await v.click(m.studio_workspace_keep_changes());
      expect(v.title().value).toBe('Local only');
      await v.click(m.studio_workspace_discard_review());
      await v.click(m.studio_workspace_discard());
      expect(v.title().value).toBe('');
      expect(v.host.textContent).toContain(m.studio_workspace_discarded());
      await v.change(v.title(), 'Discard on switch');
      await v.open('Switch me');
      await v.click(m.studio_workspace_discard_switch());
      await waitFor(() => expect(v.title().value).toBe('Switch me'));
      expect(f.unused).not.toHaveBeenCalled();
      expect(f.port.publish).not.toHaveBeenCalled();
    } finally {
      await v.close();
    }
  },
);

test.each(locales)(
  '%s: empty creation, read-only state and native failure guidance retain supplied facts',
  async (locale) => {
    setLocale(locale, { reload: false });
    const f = await fixture('articles', false);
    const v = await mount(f);
    try {
      expect(v.title().disabled).toBe(true);
      expect(v.host.textContent).toContain(m.studio_workspace_readonly());
      await v.click(m.studio_workspace_preview());
      expect(v.host.textContent).toContain(m.studio_workspace_preview_saved());
      for (const kind of ['denied', 'withdrawn', 'invalid', 'stale', 'unavailable', 'transport'] as const) {
        f.openFailure(kind);
        await v.open(m.own_drafts_no_title());
        await waitFor(() =>
          expect(getByRole(v.host, 'alert').textContent).toContain(
            language.workspaceFailureMessage(kind === 'transport' ? 'unavailable' : kind),
          ),
        );
        if (kind === 'transport')
          expect(getByRole(v.host, 'alert').textContent).not.toContain('Untrusted transport exception');
        else expect(getByRole(v.host, 'alert').textContent).toContain(detail);
        expect(v.host.textContent).toContain(m.studio_workspace_empty_open());
        expect(queryByRole(v.host, 'textbox', { name: m.studio_workspace_title() })).toBeNull();
      }
    } finally {
      await v.close();
    }
    const empty = await mount(f, {
      ...f.input,
      initialSelection: undefined,
      documents: { items: [], nextCursor: null },
      canCreateDraft: true,
    });
    try {
      expect(empty.host.textContent).toContain(m.studio_workspace_empty_create());
      expect(empty.host.textContent).toContain(m.studio_workspace_empty_page());
      const title = getByRole(empty.host, 'textbox', { name: m.studio_workspace_new_title() });
      await empty.change(title, 'New <原稿>');
      await empty.click(m.studio_workspace_create());
      await waitFor(() => expect(empty.title().value).toBe('New <原稿>'));
      expect(empty.host.textContent).toContain(m.studio_account_created());
    } finally {
      await empty.close();
    }
  },
);

test('German publication progress locks the default editor independently of its displayed wording', async () => {
  setLocale('de', { reload: false });
  const f = await fixture();
  const release = f.holdPublish();
  const v = await mount(f);
  try {
    await v.click(workbenchCopy.de.publication);
    await v.click(m.studio_release_review());
    await waitFor(() => expect(getByRole(v.host, 'checkbox', { name: m.studio_account_confirm() })).toBeTruthy());
    await act(async () => getByRole(v.host, 'checkbox', { name: m.studio_account_confirm() }).click());
    await v.click(m.studio_release_publish_article());
    expect(v.host.textContent).toContain(m.studio_workspace_publishing());
    expect(v.title().disabled).toBe(true);
    expect(
      getByRole(v.host, 'textbox', { name: m.studio_workspace_article_document() }).getAttribute('aria-disabled'),
    ).toBe('true');
    await act(async () => {
      release();
    });
    await waitFor(() => expect(v.title().disabled).toBe(false));
    expect(v.host.textContent).toContain(m.studio_account_published());
  } finally {
    release();
    await v.close();
  }
});

test('native composer completion clears operands even when completion wording differs', async () => {
  setLocale('ja', { reload: false });
  const f = await fixture();
  const feedback = spyOn(language, 'workspaceFeedbackMessage').mockReturnValue('Different safe receipt text');
  const v = await mount(f, { ...f.input, initialSelection: undefined, nativeDrafts: true, canCreateDraft: true });
  try {
    const field = (name: string) => getByRole(v.host, 'textbox', { name, exact: true }) as HTMLInputElement;
    await v.change(field(m.studio_account_board()), 'board');
    await v.change(field(m.studio_account_title()), 'Created <原稿>');
    await act(async () => {
      const editor = getByRole(v.host, 'textbox', { name: m.studio_account_body() });
      editor.focus();
      const clipboardData = new dom.window.DataTransfer();
      clipboardData.setData('text/html', '<h2>New private body</h2>');
      editor.dispatchEvent(new dom.window.ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
      (v.host.querySelector('.studio-native-create details summary') as HTMLElement).click();
    });
    await waitFor(() => expect(v.button(m.studio_account_create()).disabled).toBe(false));
    await v.change(field(m.own_drafts_subjects()), 'subject');
    await v.change(field(m.own_drafts_media()), 'media');
    await v.click(m.studio_account_create());
    await waitFor(() => expect(v.title().value).toBe('Created <原稿>'));
    expect(v.host.textContent).toContain('Different safe receipt text');
    for (const name of [
      m.studio_account_board(),
      m.studio_account_title(),
      m.own_drafts_subjects(),
      m.own_drafts_media(),
    ])
      expect(field(name).value).toBe('');
    expect(getByRole(v.host, 'textbox', { name: m.studio_account_body() }).textContent).toBe('');
    expect(f.port.createNativeDraft).toHaveBeenCalledTimes(1);
  } finally {
    feedback.mockRestore();
    await v.close();
  }
});
