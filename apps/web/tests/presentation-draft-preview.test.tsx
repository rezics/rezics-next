import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import {
  PROFILE_FORMAT,
  UI_LOCALES,
  profileDigest,
  planReads,
  platformRegistry,
  resolveView,
  type CompositionDocument,
  type PresentationProfile,
} from '@rezics/composition';
import {
  captureDraftPreview,
  loadDraftPreview,
  type DraftPreviewInput,
  type DraftPreviewResult,
} from '../src/features/pages/draft-preview';
import recorded from '../src/kernel/recorded/subject.json';

const reader = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e10';
const document = (text: string): CompositionDocument => ({
  root: { props: {} },
  content: [
    { type: 'SubjectHeader', props: { id: 'header' } },
    { type: 'Heading', props: { id: 'heading', level: 2, text: { en: text } } },
  ],
});
const profile: PresentationProfile = {
  format: PROFILE_FORMAT,
  generic: {
    views: {
      overview: document('Draft overview sibling'),
      details: document('Draft companion sibling'),
    },
  },
  bases: [],
  types: [],
  routes: [],
};
const input = (): DraftPreviewInput => ({
  expectedReader: reader,
  profile: structuredClone(profile),
  target: { subject: recorded.subject.id, view: 'details' },
  locale: 'en',
});
function native(value: DraftPreviewInput, failed = false) {
  const document = resolveView(
    value.profile,
    'route' in value.target ? { route: value.target.route } : {},
    'view' in value.target ? (value.target.view ?? 'overview') : 'overview',
  )!.document;
  return {
    profile: profileDigest(value.profile),
    subject: 'route' in value.target ? null : recorded.subject.id,
    template: 'route' in value.target ? { scope: 'route', key: value.target.route } : { scope: 'generic', key: null },
    document,
    reads: Object.fromEntries(
      Object.keys(planReads(platformRegistry, document, { subject: recorded.subject.id }).reads).map((key) => [
        key,
        failed ? { status: 503, body: {} } : { status: 200, body: recorded },
      ]),
    ),
    draft: { digest: profileDigest(value.profile), target: value.target, advice: 'allowed' },
  };
}

test('detached complete input binds the reader, digest and companion while preserving failed native leaves', async () => {
  const original = input();
  const captured = captureDraftPreview(original)!;
  original.profile.generic = document('Later edit');
  expect(captured.profile).toEqual(profile);
  let calls = 0;
  const client = {
    pages: {
      $previewDraft: {
        post: async (body: unknown, options: unknown) => {
          calls++;
          expect(body).toEqual({ profile, target: captured.target, languages: ['en'] });
          expect(options).toEqual({
            headers: { authorization: 'Bearer curator' },
            fetch: { cache: 'no-store', redirect: 'manual' },
          });
          return { status: 200, data: native(captured, true) };
        },
      },
    },
  };
  expect(
    await loadDraftPreview(client, captured, { reader: 'another-reader', authorization: 'Bearer curator' }),
  ).toEqual({ ok: false, reason: 'denied' });
  expect(calls).toBe(0);
  const result = await loadDraftPreview(client, captured, { reader, authorization: 'Bearer curator' });
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.digest).toBe(profileDigest(profile));
    expect(result.page.reads.r0?.status).toBe(503);
    expect(result.page.document).toEqual(document('Draft companion sibling'));
  }
  expect(captureDraftPreview({ ...captured, target: { route: '/', view: 'details' } })).toBeNull();
  expect(captureDraftPreview({ ...captured, profile: { ...profile, format: 'invalid' } })).toBeNull();
  const corrected = { ...native(captured), subject: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e11' };
  const current = await loadDraftPreview(
    { pages: { $previewDraft: { post: async () => ({ status: 200, data: corrected }) } } },
    captured,
    { reader, authorization: 'Bearer curator' },
  );
  expect(current.ok && current.page.subject).toBe(corrected.subject);
  expect(current.ok && current.target).toEqual(captured.target);
  const wrong = native(captured);
  wrong.draft.digest = 'wrong';
  expect(
    await loadDraftPreview(
      { pages: { $previewDraft: { post: async () => ({ status: 200, data: wrong }) } } },
      captured,
      { reader, authorization: 'Bearer curator' },
    ),
  ).toEqual({ ok: false, reason: 'unavailable' });
});

test('mounted editor keeps capture, edits, publication and permanent retirement independent at phone and desktop sizes', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/curate/presentation' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    localStorage: window.localStorage,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLSelectElement: window.HTMLSelectElement,
    HTMLIFrameElement: window.HTMLIFrameElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    DocumentFragment: window.DocumentFragment,
    ShadowRoot: window.ShadowRoot,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    matchMedia: window.matchMedia.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const [
    { createRoot },
    { QueryClient, QueryClientProvider },
    { PresentationViewEditor },
    { CurationReaderAdmission },
    { PresentationPreviewPanel },
    { m },
  ] = await Promise.all([
    import('react-dom/client'),
    import('@tanstack/react-query'),
    import('../src/features/pages/curate-view-editor'),
    import('../src/features/pages/curation-reader-admission'),
    import('../src/features/pages/presentation-preview-view'),
    import('../src/paraglide/messages.js'),
  ]);
  const storybook = dirname(Bun.resolveSync('storybook/test', import.meta.dir));
  const { within } = await import(Bun.resolveSync('@testing-library/dom', storybook));
  const { default: userEvent } = await import(Bun.resolveSync('@testing-library/user-event', storybook));
  const user = userEvent.setup({ document: window.document });
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  try {
    for (const width of [390, 1280]) {
      for (const [localeIndex, startingLocale] of UI_LOCALES.entries()) {
        const reader = `0192f3a0-6c1e-7b2a-9d4e-${String(width * 100 + localeIndex).padStart(12, '0')}`;
        const anotherReader = `0192f3a0-6c1e-7b2a-9d4e-${String(width * 100 + localeIndex + 10000).padStart(12, '0')}`;
        window.happyDOM.setWindowSize({ width, height: 900 });
        const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
        client.setQueryData(['session'], { state: 'signed-in', subject: reader, csrfToken: 'first' });
        const admission = new CurationReaderAdmission(client, reader);
        const detach = admission.attach();
        const initialFor = (expectedReader: string) => ({
          ok: true as const,
          reader: expectedReader,
          profile,
          digest: profileDigest(profile),
          head: 7,
          advice: { viewer: 'account' as const, publish: 'allowed' as const, activate: 'allowed' as const },
        });
        const initial = initialFor(reader);
        const otherInitial = initialFor(anotherReader);
        const calls: { input: DraftPreviewInput; resolve: (result: DraftPreviewResult) => void }[] = [];
        const read = (value: DraftPreviewInput) =>
          new Promise<DraftPreviewResult>((resolve) => calls.push({ input: value, resolve }));
        let publications = 0;
        let transport = {
          previewDraft: read,
          read: async () => initial,
          readOpening: async (expectedReader: string) => (expectedReader === anotherReader ? otherInitial : initial),
          publish: async (input) => {
            publications++;
            return publications === 1
              ? ({ ok: false as const, reason: 'forbidden' as const } as const)
              : ({ ok: true as const, digest: profileDigest(input.profile), head: 8 } as const);
          },
        };
        let locale = startingLocale;
        const render = () =>
          act(async () =>
            root.render(
              <QueryClientProvider client={client}>
                <PresentationViewEditor
                  initial={initial}
                  locale={locale}
                  admission={admission}
                  transport={transport}
                  preview={
                    <PresentationPreviewPanel
                      locale={locale}
                      read={async () => ({ ok: false, reason: 'unavailable' })}
                    />
                  }
                />
              </QueryClientProvider>,
            ),
          );
        const click = (element: HTMLElement) => act(async () => user.click(element));
        const select = (element: HTMLElement, value: string) => act(async () => user.selectOptions(element, value));
        const canvas = within(host);
        const panel = () => canvas.getByRole('region', { name: m.draft_preview_title({}, { locale }) });
        const controls = () => within(panel());
        const capture = () => click(controls().getByRole('button', { name: m.draft_preview_capture({}, { locale }) }));
        const settle = (index: number, value: DraftPreviewResult) =>
          act(async () => {
            calls[index]!.resolve(value);
            await Promise.resolve();
          });
        const waitFor = async (ready: () => boolean) => {
          for (let attempt = 0; attempt < 150 && !ready(); attempt++)
            await act(async () => {
              await Bun.sleep(10);
            });
          expect(ready()).toBe(true);
        };
        const success = (index: number, failed = false): DraftPreviewResult => ({
          ok: true,
          digest: profileDigest(calls[index]!.input.profile),
          target: calls[index]!.input.target,
          locale: calls[index]!.input.locale,
          page: native(calls[index]!.input, failed) as any,
        });
        await render();
        await capture();
        expect(calls).toHaveLength(0);
        expect(controls().getByRole('alert').textContent).toContain(m.draft_preview_address_required({}, { locale }));
        const address = controls().getByRole('textbox', { name: m.draft_preview_subject_id({}, { locale }) });
        await act(async () => user.type(address, recorded.subject.id));
        await select(controls().getByRole('combobox', { name: m.draft_preview_view({}, { locale }) }), 'details');
        expect(calls).toHaveLength(0);
        await capture();
        expect(calls[0]!.input.target).toEqual(input().target);
        // Add an unpublished template while execution is pending; the captured whole profile stays immutable.
        const key = canvas.getByRole('textbox', { name: m.curation_key({}, { locale }) });
        await act(async () => user.type(key, 'schema:Book'));
        await click(canvas.getByRole('button', { name: m.curation_add({}, { locale }) }));
        expect(controls().getByText(m.draft_preview_changed({}, { locale }))).toBeTruthy();
        expect(calls[0]!.input.profile.types).toHaveLength(0);
        const editorRegion = canvas.getByRole('region', { name: m.curation_editor({}, { locale }) });
        await waitFor(() => !!editorRegion.querySelector('[data-puck-layer-tree-id="heading"]'));
        const headingRow = editorRegion.querySelector('[data-puck-layer-tree-id="heading"]')!;
        await click(Array.from(headingRow.querySelectorAll('button')).find((item) => item.textContent === 'Heading')!);
        await waitFor(() => !!editorRegion.querySelector('textarea[name="text.en"]'));
        const headingField = editorRegion.querySelector('textarea[name="text.en"]') as HTMLTextAreaElement | null;
        expect(headingField).not.toBeNull();
        await act(async () => {
          Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(
            headingField,
            'Reader-owned component edit',
          );
          headingField!.dispatchEvent(new window.Event('input', { bubbles: true }));
          headingField!.blur();
        });
        const templates = within(canvas.getByRole('region', { name: m.curation_templates({}, { locale }) }));
        const companion = templates
          .getAllByRole('combobox', { name: m.curation_companion_view({}, { locale }) })
          .find((element: HTMLElement) => element.querySelector('option[value="relations"]'))!;
        await select(companion, 'relations');
        await select(
          templates.getByRole('combobox', { name: m.curation_companion_source({}, { locale }) }),
          'overview',
        );
        await click(templates.getByRole('button', { name: m.curation_companion_add({}, { locale }) }));
        await settle(0, success(0, true));
        expect(controls().queryByText('Draft companion sibling')).toBeNull();
        expect(controls().getByText(m.draft_preview_interrupted({}, { locale }))).toBeTruthy();
        expect(canvas.getByRole('heading', { name: m.presentation_preview_title({}, { locale }) })).toBeTruthy();
        await capture();
        expect(calls[1]!.input.profile.types[0]?.type).toBe('schema:Book');
        expect(calls[1]!.input.profile.types[0]?.views?.relations).toBeTruthy();
        expect(JSON.stringify(calls[1]!.input.profile.types[0])).toContain('Reader-owned component edit');
        await click(canvas.getByRole('button', { name: m.curation_close({}, { locale }) }));
        await click(canvas.getByRole('button', { name: m.curation_publish({}, { locale }) }));
        expect(publications).toBe(1);
        expect(panel().querySelector('form')?.getAttribute('aria-busy')).toBe('true');
        await click(canvas.getByRole('button', { name: m.curation_retry_original({}, { locale }) }));
        expect(publications).toBe(2);
        expect(panel().querySelector('form')?.getAttribute('aria-busy')).toBe('true');
        const keyAfterRecovery = canvas.getByRole('textbox', { name: m.curation_key({}, { locale }) });
        await act(async () => user.type(keyAfterRecovery, 'schema:Novel'));
        await click(canvas.getByRole('button', { name: m.curation_add({}, { locale }) }));
        const focused = controls().getByRole('textbox', { name: m.draft_preview_subject_id({}, { locale }) });
        focused.focus();
        await act(async () =>
          client.setQueryData(['session'], { state: 'signed-in', subject: reader, csrfToken: 'second' }),
        );
        await act(async () =>
          client.setQueryData(['session'], { state: 'signed-in', subject: reader, csrfToken: 'first' }),
        );
        await settle(1, success(1));
        expect(controls().queryByText('Draft companion sibling')).toBeNull();
        expect(window.document.activeElement).toBe(focused);
        await capture();
        expect(calls[2]!.input.profile.types).toHaveLength(2);
        await click(controls().getByRole('button', { name: m.draft_preview_interrupt({}, { locale }) }));
        await settle(2, success(2));
        expect(controls().getByText(m.draft_preview_interrupted({}, { locale }))).toBeTruthy();
        expect(window.document.activeElement).toBe(
          controls().getByRole('button', { name: m.draft_preview_capture({}, { locale }) }),
        );
        await click(controls().getByRole('button', { name: m.draft_preview_retry({}, { locale }) }));
        expect(calls[3]!.input).toEqual(calls[2]!.input);
        await settle(3, { ok: false, reason: 'denied' });
        expect(controls().getByRole('alert').textContent).toContain(m.draft_preview_native_refusal({}, { locale }));
        await capture();
        const replacementLocale = UI_LOCALES.find((candidate) => candidate !== startingLocale)!;
        locale = replacementLocale;
        await render();
        const independentlyFocused = canvas.getByRole('textbox', { name: m.curation_key({}, { locale }) });
        independentlyFocused.focus();
        const replacementRead = (value: DraftPreviewInput) =>
          new Promise<DraftPreviewResult>((resolve) => calls.push({ input: value, resolve }));
        transport = { ...transport, previewDraft: replacementRead };
        await render();
        expect(window.document.activeElement).toBe(independentlyFocused);
        locale = startingLocale;
        await render();
        await settle(4, success(4));
        expect(controls().queryByText('Draft companion sibling')).toBeNull();
        await capture();
        await settle(5, { ok: false, reason: 'redirect', handle: 'current-reader' });
        const correction = controls().getByRole('button', {
          name: m.draft_preview_correct({ handle: 'current-reader' }, { locale }),
        });
        correction.focus();
        await click(correction);
        expect(
          (controls().getByRole('textbox', { name: m.draft_preview_account({}, { locale }) }) as HTMLInputElement)
            .value,
        ).toBe('current-reader');
        expect(window.document.activeElement).toBe(
          controls().getByRole('button', { name: m.draft_preview_capture({}, { locale }) }),
        );
        await capture();
        expect(calls[6]!.input.target).toEqual({ account: 'current-reader', view: 'details' });
        // Another reader sees only their own fresh state, while this reader's draft and focus wait locally.
        controls()
          .getByRole('textbox', { name: m.draft_preview_account({}, { locale }) })
          .focus();
        await act(async () =>
          client.setQueryData(['session'], { state: 'signed-in', subject: anotherReader, csrfToken: 'other' }),
        );
        const otherTemplates = within(canvas.getByRole('region', { name: m.curation_templates({}, { locale }) }));
        const templateOptions = (region: typeof otherTemplates) =>
          Array.from(
            region.getByRole('combobox', { name: m.curation_template({}, { locale }) }).querySelectorAll('option'),
          ).map((option) => option.value);
        expect(templateOptions(otherTemplates)).not.toContain(JSON.stringify({ scope: 'type', key: 'schema:Book' }));
        expect(templateOptions(otherTemplates)).not.toContain(JSON.stringify({ scope: 'type', key: 'schema:Novel' }));
        await act(async () =>
          client.setQueryData(['session'], { state: 'signed-in', subject: reader, csrfToken: 'third' }),
        );
        await settle(6, success(6));
        expect(controls().queryByRole('heading', { name: 'Draft companion sibling' })).toBeNull();
        expect(window.document.activeElement).toBe(
          controls().getByRole('button', { name: m.draft_preview_capture({}, { locale }) }),
        );
        const retainedTemplates = within(canvas.getByRole('region', { name: m.curation_templates({}, { locale }) }));
        expect(templateOptions(retainedTemplates)).toContain(JSON.stringify({ scope: 'type', key: 'schema:Book' }));
        expect(templateOptions(retainedTemplates)).toContain(JSON.stringify({ scope: 'type', key: 'schema:Novel' }));
        const templateSelect = retainedTemplates.getByRole('combobox', { name: m.curation_template({}, { locale }) });
        await select(templateSelect, JSON.stringify({ scope: 'type', key: 'schema:Book' }));
        const viewSelect = retainedTemplates.getAllByRole('combobox', { name: m.curation_view({}, { locale }) })[0]!;
        expect(Array.from((viewSelect as HTMLSelectElement).options).map((option) => option.value)).toContain(
          'relations',
        );
        expect(publications).toBe(2);
        await act(async () => root.render(null));
        detach();
        client.clear();
      }
    }
  } finally {
    await act(async () => root.unmount());
    window.happyDOM.abort();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}, 180_000);
