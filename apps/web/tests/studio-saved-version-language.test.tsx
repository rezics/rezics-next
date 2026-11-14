import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { act, useSyncExternalStore } from 'react';
import type { ExactDocument, StudioInput, StudioPort, StudioRevision } from '../src/studio/contract';
import { installPostReadingDom } from './post-reading-dom';

const dom = installPostReadingDom();
const { createRoot } = await import('react-dom/client');
const { getByRole, queryByRole } = await import('@testing-library/dom');
const { fromPlainText } = await import('@rezics/document');
const { editionDocumentDigest } = await import('../src/content-editions/edition-model');
const { StudioController } = await import('../src/studio/controller');
const { StudioVersions } = await import('../src/studio/revisions');
const { fullDateTime } = await import('../src/threads/byline-time');
const { m } = await import('../src/paraglide/messages.js');
const { setLocale, locales } = await import('../src/paraglide/runtime.js');
const catalogues = await Promise.all(
  locales.map((locale) => Bun.file(`${import.meta.dir}/../messages/${locale}.json`).json()),
);
afterAll(async () => {
  setLocale('en', { reload: false });
  await dom.restore();
});

async function fixture(kind: StudioInput['profile']['kind']) {
  const revision = async (id: string, title: string, text: string, savedAt: string): Promise<StudioRevision> => {
    const body = fromPlainText(text, 'blocks');
    return {
      exact: { postId: 'private-post', revisionId: id, sha256: await editionDocumentDigest(body) },
      title,
      body,
      mediaIds: [],
      savedAt,
    };
  };
  const current = await revision(
    'current-revision',
    'Current <draft> & 本文',
    'Current saved text.',
    '2026-11-13T12:34:56.123456Z',
  );
  const historical = await revision(
    'selected-revision',
    '原稿 <A & "B">',
    'Exact historical text.',
    '2026-11-12T12:34:56.654321Z',
  );
  const header = { exact: historical.exact, savedAt: historical.savedAt };
  const unused = mock(async (): Promise<never> => {
    throw new Error('Comparing and copying must not save or publish.');
  });
  let page = 0;
  const port: StudioPort = {
    isCurrent: () => true,
    documents: unused,
    open: unused,
    createDraft: unused,
    saveDraft: unused,
    reviewPublication: unused,
    publish: unused,
    publications: unused,
    versions: mock(async () => ({
      ok: true,
      value: [
        { items: [], nextCursor: 'opaque+/=' },
        { items: [header], nextCursor: null },
        { items: [], nextCursor: null },
      ][page++]!,
    })),
    revision: mock(async () => ({ ok: true, value: historical })),
  };
  const structure = {
    catalogueId: 'private-book',
    revision: 'outline',
    placements: [],
    limits: { maxDepth: 4, maxPlacements: 20 },
    canOrganize: false,
  };
  const controller = new StudioController(
    {
      visitKey: 'saved-version-language',
      projectId: 'private-project',
      title: 'Private Studio',
      profile: kind === 'book' ? { kind, structure } : { kind, seriesTitle: null },
      initialSelection: { revision: current, permissions: { edit: true, publish: true } },
      documents: { items: [], nextCursor: null },
      publications: { items: [], nextCursor: null },
      canCreateDraft: false,
      canPublish: true,
    },
    port,
  );
  return { controller, port, current, historical, header, disconnect: controller.connect() };
}

test('saved-version catalogues have identical keys and named arguments in every launch locale', () => {
  const keys = Object.keys(catalogues[0])
    .filter((key) => key.startsWith('studio_revision_'))
    .sort();
  expect(keys.length).toBe(26);
  const argumentsOf = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
  for (const catalogue of catalogues) {
    expect(
      Object.keys(catalogue)
        .filter((key) => key.startsWith('studio_revision_'))
        .sort(),
    ).toEqual(keys);
    for (const key of keys) {
      expect(catalogue[key].trim().length).toBeGreaterThan(0);
      expect(argumentsOf(catalogue[key])).toEqual(argumentsOf(catalogues[0][key]));
    }
  }
});

const cases = locales.flatMap((locale) => (['book', 'articles'] as const).map((kind) => [locale, kind] as const));
test.each(cases)(
  '%s %s: page, compare exact saved drafts and review clean/dirty draft-only copies',
  async (locale, kind) => {
    setLocale(locale, { reload: false });
    const options = { locale };
    const f = await fixture(kind);
    const loads = spyOn(f.controller, 'loadVersions');
    const inspect = spyOn(f.controller, 'inspectVersion');
    const restore = spyOn(f.controller, 'restoreVersion');
    const reader = mock((_exact: ExactDocument) => ({ locale }));
    function View() {
      const state = useSyncExternalStore(f.controller.subscribe, f.controller.snapshot, f.controller.snapshot);
      return <StudioVersions controller={f.controller} state={state} presentation={{ reader }} />;
    }
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const button = (name: string) => getByRole(host, 'button', { name, exact: true }) as HTMLButtonElement;
    const click = async (name: string) =>
      act(async () => {
        button(name).click();
        await loads.mock.results.at(-1)?.value;
        await inspect.mock.results.at(-1)?.value;
      });
    try {
      await act(async () => root.render(<View />));
      expect(getByRole(host, 'region', { name: m.studio_revision_region({}, options) })).toBeTruthy();
      expect(getByRole(host, 'heading', { name: m.studio_revision_heading({}, options) })).toBeTruthy();
      expect(host.textContent).toContain(m.studio_revision_intro({}, options));
      await click(m.studio_revision_load({}, options));
      expect(host.textContent).toContain(m.thread_history_page_empty({}, options));
      expect(host.textContent).not.toContain(m.thread_history_empty({}, options));
      expect(f.port.revision).not.toHaveBeenCalled();
      await click(m.studio_revision_next({}, options));
      expect(f.port.versions).toHaveBeenLastCalledWith(
        { projectId: 'private-project', postId: 'private-post', cursor: 'opaque+/=' },
        expect.any(AbortSignal),
      );
      expect(queryByRole(host, 'button', { name: m.studio_revision_next({}, options) })).toBeNull();
      expect(f.port.revision).not.toHaveBeenCalled();
      const compare = m.studio_revision_compare({ savedAt: fullDateTime(f.historical.savedAt, locale) }, options);
      await click(compare);
      expect(inspect).toHaveBeenCalledTimes(1);
      expect(inspect.mock.calls[0]![0]).toBe(f.header.exact);
      expect(f.port.revision).toHaveBeenCalledWith(
        { projectId: 'private-project', document: f.header.exact },
        expect.any(AbortSignal),
      );
      expect(button(compare).getAttribute('aria-pressed')).toBe('true');
      for (const heading of [m.studio_revision_selected({}, options), m.studio_revision_current({}, options)])
        expect(getByRole(host, 'heading', { name: heading })).toBeTruthy();
      for (const version of [f.historical, f.current]) {
        const region = getByRole(host, 'region', {
          name: m.studio_revision_saved_name({ title: version.title }, options),
        });
        expect(getByRole(region, 'heading', { name: version.title, exact: true }).textContent).toBe(version.title);
        expect(region.querySelector('time')?.getAttribute('datetime')).toBe(version.savedAt);
        expect(region.querySelector('time')?.textContent).toBe(
          m.studio_revision_saved({ savedAt: fullDateTime(version.savedAt, locale) }, options),
        );
        const disclosure = region.querySelector('summary')!;
        expect(disclosure.textContent).toBe(m.studio_revision_exact({}, options));
        await act(async () => disclosure.click());
        expect(region.querySelector('details')?.open).toBe(true);
        expect([...region.querySelectorAll('dt')].map((node) => node.textContent)).toEqual([
          m.studio_revision_post({}, options),
          m.studio_revision_id({}, options),
          m.studio_revision_digest({}, options),
        ]);
        expect([...region.querySelectorAll('dd')].map((node) => node.textContent)).toEqual(
          Object.values(version.exact),
        );
        expect(reader).toHaveBeenCalledWith(version.exact);
      }
      const args = { title: f.historical.title, savedAt: fullDateTime(f.historical.savedAt, locale) };
      await click(m.studio_revision_use({}, options));
      expect(getByRole(host, 'group', { name: m.studio_revision_copy_review({}, options) }).textContent).toContain(
        m.studio_revision_replace_clean(args, options),
      );
      expect(restore).not.toHaveBeenCalled();
      await click(m.action_cancel({}, options));
      expect(f.controller.snapshot().selected?.dirty).toBe(false);
      await act(async () => {
        f.controller.changeTitle('Unsaved title');
        f.controller.snapshotPending();
      });
      expect(button(m.studio_revision_use({}, options)).disabled).toBe(true);
      await act(async () => f.controller.changeBody(fromPlainText('Unsaved working text.', 'blocks')));
      await act(async () => f.controller.uploadState(true));
      expect(button(m.studio_revision_use({}, options)).disabled).toBe(true);
      await act(async () => f.controller.uploadState(false));
      expect(host.textContent).toContain(m.studio_revision_unsaved({}, options));
      expect(host.textContent).not.toContain('Unsaved working text.');
      expect(host.textContent).toContain('Current saved text.');
      await click(m.studio_revision_use({}, options));
      expect(getByRole(host, 'group', { name: m.studio_revision_copy_review({}, options) }).textContent).toContain(
        m.studio_revision_replace_dirty(args, options),
      );
      expect(restore).not.toHaveBeenCalled();
      await click(m.studio_revision_copy({}, options));
      expect(restore).toHaveBeenCalledTimes(1);
      const selected = f.controller.snapshot().selected!;
      expect(selected.title).toBe(f.historical.title);
      expect(selected.body).toEqual(f.historical.body);
      expect(selected.dirty).toBe(true);
      expect(selected.source.revision).toBe(f.current);
      expect(f.port.saveDraft).not.toHaveBeenCalled();
      expect(f.port.reviewPublication).not.toHaveBeenCalled();
      expect(f.port.publish).not.toHaveBeenCalled();
      await click(m.studio_revision_first({}, options));
      expect(f.port.versions).toHaveBeenLastCalledWith(
        { projectId: 'private-project', postId: 'private-post', cursor: null },
        expect.any(AbortSignal),
      );
      expect(host.textContent).toContain(m.thread_history_empty({}, options));
      expect(queryByRole(host, 'button', { name: m.studio_revision_use({}, options) })).toBeNull();
    } finally {
      await act(async () => root.unmount());
      f.disconnect();
      host.remove();
      loads.mockRestore();
      inspect.mockRestore();
      restore.mockRestore();
    }
  },
);
