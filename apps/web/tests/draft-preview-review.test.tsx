import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, useRef, useState } from 'react';
import {
  planReads,
  platformRegistry,
  PROFILE_FORMAT,
  profileDigest,
  resolveView,
  type CompositionDocument,
  type PresentationProfile,
} from '@rezics/composition';
import type { CurationAdmissionLease } from '../src/features/pages/curation-reader-admission';
import type { DraftPreviewInput, DraftPreviewRead, DraftPreviewResult } from '../src/features/pages/draft-preview';
import recorded from '../src/kernel/recorded/subject.json';

const subjectId = recorded.subject.id;
const reader = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e10';
const documentFor = (text: string): CompositionDocument => ({
  root: { props: {} },
  content: [
    { type: 'SubjectHeader', props: { id: 'header' } },
    { type: 'Heading', props: { id: 'heading', level: 2, text: { en: text } } },
  ],
});
const makeProfile = (text: string): PresentationProfile => ({
  format: PROFILE_FORMAT,
  generic: { views: { overview: documentFor(text), details: documentFor(`${text} details`) } },
  bases: [],
  types: [],
  routes: [],
});
const initialProfile = makeProfile('Captured profile');
const updatedProfile = makeProfile('Unsent profile update');
const lease = {
  reader,
  isCurrent: () => true,
  onRetire: () => () => {},
} as unknown as CurationAdmissionLease;

function pageFor(input: DraftPreviewInput) {
  const digest = profileDigest(input.profile);
  const selectedView = 'view' in input.target ? (input.target.view ?? 'overview') : 'overview';
  const witness = 'route' in input.target ? { route: input.target.route } : {};
  const document = resolveView(input.profile, witness, selectedView)?.document ?? documentFor('Captured profile');
  const reads = Object.fromEntries(
    Object.keys(planReads(platformRegistry, document, { subject: subjectId }).reads).map((key) => [
      key,
      { status: 200, body: recorded },
    ]),
  );
  return {
    profile: digest,
    subject: 'route' in input.target ? null : subjectId,
    ...( 'account' in input.target ? { account: { handle: input.target.account } } : {}),
    template: 'route' in input.target
      ? { scope: 'route', key: input.target.route }
      : { scope: 'generic', key: null },
    document,
    reads,
    draft: { digest, target: input.target, advice: 'allowed' },
  };
}

function successful(input: DraftPreviewInput): DraftPreviewResult {
  return {
    ok: true,
    digest: profileDigest(input.profile),
    target: input.target,
    locale: input.locale,
    page: pageFor(input) as never,
  };
}

test('review keeps captured output frozen, diagnoses local targets, retries the original input and returns to the editor', async () => {
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
    { DraftPreviewPanel },
    { m },
  ] = await Promise.all([
    import('react-dom/client'),
    import('@tanstack/react-query'),
    import('../src/features/pages/draft-preview-view'),
    import('../src/paraglide/messages.js'),
  ]);
  const storybook = dirname(Bun.resolveSync('storybook/test', import.meta.dir));
  const { within, waitFor } = await import(Bun.resolveSync('@testing-library/dom', storybook));
  const { default: userEvent } = await import(Bun.resolveSync('@testing-library/user-event', storybook));
  const user = userEvent.setup({ document: window.document });
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const calls: { input: DraftPreviewInput; resolve: (value: DraftPreviewResult) => void }[] = [];
  const read: DraftPreviewRead = (input) =>
    new Promise((resolve) => calls.push({ input, resolve }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  let returned = 0;

  function Experience() {
    const heading = useRef<HTMLHeadingElement>(null);
    const [draftValue, setDraftValue] = useState('unsaved editor text');
    const [profile, setProfile] = useState(initialProfile);
    return (
      <div className="p-4">
        <h1 ref={heading} tabIndex={-1}>Current curation editor</h1>
        <label>
          Unsaved editor value
          <input value={draftValue} onChange={(event) => setDraftValue(event.target.value)} />
        </label>
        <button type="button" onClick={() => setProfile(updatedProfile)}>
          Edit current profile
        </button>
        <DraftPreviewPanel
          profile={profile}
          locale="en"
          lease={lease}
          read={read}
          onReturn={() => {
            returned++;
            heading.current?.focus();
          }}
        />
      </div>
    );
  }
  function ExperienceShell() {
    return (
      <QueryClientProvider client={client}>
        <Experience />
      </QueryClientProvider>
    );
  }
  const canvas = within(host);
  const panel = () => canvas.getByRole('region', { name: m.draft_preview_title({}, { locale: 'en' }) });
  const controls = () => within(panel());
  const selectKind = (value: string) => act(async () => user.selectOptions(
    controls().getByRole('combobox', { name: m.presentation_preview_target({}, { locale: 'en' }) }), value,
  ));
  const field = (name: string) => controls().getByRole('textbox', { name });
  const submit = (name: string) => act(async () => user.click(controls().getByRole('button', { name })));
  const settle = async (index: number, value: DraftPreviewResult) => act(async () => {
    calls[index]!.resolve(value);
    await Promise.resolve();
  });
  const waitForCalls = async (count: number) => waitFor(() => expect(calls).toHaveLength(count));

  try {
    for (const [width, theme] of [[390, 'light'], [1440, 'dark']] as const) {
      returned = 0;
      window.happyDOM.setWindowSize({ width, height: 900 });
      host.className = theme === 'dark' ? 'dark' : '';
      await act(async () => root.render(<ExperienceShell key={width} />));
      const captureLabel = m.draft_preview_capture({}, { locale: 'en' });

      const firstCapture = controls().getByRole('button', { name: captureLabel });
      expect(firstCapture.className).toContain('focus-visible');
      expect(firstCapture.className).toContain('min-h-11');
      firstCapture.focus();
      await act(async () => user.keyboard('{Enter}'));
      expect(calls).toHaveLength(0);
      expect(field(m.draft_preview_subject_id({}, { locale: 'en' })).getAttribute('aria-invalid')).toBe('true');
      const subjectField = field(m.draft_preview_subject_id({}, { locale: 'en' }));
      expect(controls().getByText(m.draft_preview_address_required({}, { locale: 'en' }))).toBeTruthy();
      await act(async () => user.type(subjectField, 'not-a-uuid'));
      await submit(captureLabel);
      expect(calls).toHaveLength(0);
      expect(controls().getByText(m.draft_preview_subject_invalid({}, { locale: 'en' }))).toBeTruthy();
      await act(async () => user.clear(subjectField));
      await act(async () => user.type(subjectField, subjectId));
      const realmField = field(m.presentation_preview_realm({}, { locale: 'en' }));
      await act(async () => user.type(realmField, 'bad-realm'));
      await submit(captureLabel);
      expect(calls).toHaveLength(0);
      expect(controls().getByText(m.draft_preview_realm_invalid({}, { locale: 'en' }))).toBeTruthy();
      await act(async () => user.clear(realmField));
      await act(async () => user.type(realmField, '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e11'));
      await act(async () => user.selectOptions(
        controls().getByRole('combobox', { name: m.draft_preview_view({}, { locale: 'en' }) }),
        'details',
      ));
      await submit(captureLabel);
      await waitForCalls(1);
      expect(calls[0]!.input.target).toEqual({
        subject: subjectId,
        realm: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e11',
        view: 'details',
      });
      await settle(0, successful(calls[0]!.input));
      await waitFor(() => expect(controls().getByRole('heading', { name: 'Captured profile details' })).toBeTruthy());
      expect(controls().getByText(m.draft_preview_not_publication({}, { locale: 'en' }))).toBeTruthy();
      expect((controls().getByRole('button', { name: m.draft_preview_recapture({}, { locale: 'en' }) }) as HTMLElement).className)
        .toContain('min-h-11');

      // A profile edit changes the unsent candidate while the captured page stays bound to its original profile.
      await act(async () => user.click(canvas.getByRole('button', { name: 'Edit current profile' })));
      await waitFor(() => expect(controls().getByText(m.draft_preview_profile_changed({}, { locale: 'en' }))).toBeTruthy());
      expect(controls().getByRole('heading', { name: 'Captured profile details' })).toBeTruthy();
      expect(calls).toHaveLength(1);

      await selectKind('account');
      const accountField = field(m.draft_preview_account({}, { locale: 'en' }));
      await act(async () => user.type(accountField, 'bad handle'));
      await submit(m.draft_preview_recapture({}, { locale: 'en' }));
      expect(calls).toHaveLength(1);
      expect(controls().getByText(m.draft_preview_account_invalid({}, { locale: 'en' }))).toBeTruthy();
      expect(controls().getByRole('heading', { name: 'Captured profile details' })).toBeTruthy();
      await act(async () => user.clear(accountField));
      const longHandle = 'r'.repeat(64);
      await act(async () => user.type(accountField, longHandle));
      await submit(m.draft_preview_recapture({}, { locale: 'en' }));
      await waitForCalls(2);
      expect(calls[1]!.input.target).toEqual({ account: longHandle, view: 'details' });
      expect(controls().getAllByText(longHandle).some((element: HTMLElement) => element.className.includes('break-all')))
        .toBe(true);

      await act(async () => user.click(controls().getByRole('button', { name: m.draft_preview_interrupt({}, { locale: 'en' }) })));
      expect(controls().getByText(m.draft_preview_stop_request({}, { locale: 'en' }))).toBeTruthy();
      await settle(1, successful(calls[1]!.input));
      expect(controls().queryByRole('heading', { name: 'Unsent profile update details' })).toBeNull();
      expect(controls().getByText(m.draft_preview_interrupted({}, { locale: 'en' }))).toBeTruthy();

      await submit(m.draft_preview_retry({}, { locale: 'en' }));
      await waitForCalls(3);
      expect(calls[2]!.input).toEqual(calls[1]!.input);
      await settle(2, { ok: false, reason: 'unavailable' });
      await waitFor(() => expect(controls().getByText(m.draft_preview_dependency_failure({}, { locale: 'en' }))).toBeTruthy());

      await selectKind('route');
      const routeField = field(m.presentation_preview_route({}, { locale: 'en' }));
      await act(async () => user.type(routeField, 'https://foreign.example/page'));
      await submit(m.draft_preview_recapture({}, { locale: 'en' }));
      expect(calls).toHaveLength(3);
      expect(controls().getByText(m.draft_preview_route_invalid({}, { locale: 'en' }))).toBeTruthy();

      await act(async () => user.clear(routeField));
      await act(async () => user.type(routeField, '/'));
      await submit(m.draft_preview_retry({}, { locale: 'en' }));
      await waitForCalls(4);
      expect(calls[3]!.input.target).toEqual(calls[1]!.input.target);
      await settle(3, { ok: false, reason: 'unavailable' });
      await waitFor(() => expect(controls().getByText(m.draft_preview_dependency_failure({}, { locale: 'en' }))).toBeTruthy());

      await submit(m.draft_preview_recapture({}, { locale: 'en' }));
      await waitForCalls(5);
      expect(calls[4]!.input.target).toEqual({ route: '/' });
      expect(calls[4]!.input.profile).toEqual(updatedProfile);
      await settle(4, successful(calls[4]!.input));
      await waitFor(() => expect(controls().getByRole('heading', { name: 'Unsent profile update' })).toBeTruthy());

      await act(async () => user.click(controls().getByRole('button', { name: m.draft_preview_return_editor({}, { locale: 'en' }) })));
      expect(returned).toBe(1);
      expect(window.document.activeElement?.textContent).toBe('Current curation editor');
      expect((canvas.getByRole('textbox', { name: 'Unsaved editor value' }) as HTMLInputElement).value)
        .toBe('unsaved editor text');
      await act(async () => user.click(controls().getByRole('button', { name: m.draft_preview_reopen({}, { locale: 'en' }) })));
      await waitFor(() => expect(controls().getByRole('heading', { name: 'Unsent profile update' })).toBeTruthy());

      await act(async () => root.render(<></>));
      calls.length = 0;
    }
  } finally {
    await act(async () => root.unmount());
    client.clear();
    window.happyDOM.abort();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}, 180_000);
