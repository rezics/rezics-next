import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, userEvent, within } from 'storybook/test';
import {
  PROFILE_FORMAT,
  planReads,
  platformRegistry,
  profileDigest,
  resolveView,
  type CompositionDocument,
  type PresentationProfile,
} from '@rezics/composition';
import { CurationView } from '../features/pages/curate-view';
import { PresentationPreviewContext } from '../features/pages/presentation-preview-view';
import type { DraftPreviewInput, DraftPreviewResult } from '../features/pages/draft-preview';
import type { CurationEditorTransport } from '../features/pages/curate-view-editor';
import recorded from '../kernel/recorded/subject.json';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { PatternStory } from './page';

// Contract-shaped native aggregates reuse a recorded anonymous subject; these examples do not attest native execution.
const reader = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e10';
const document = (text: string): CompositionDocument => ({
  root: { props: {} },
  content: [
    { type: 'SubjectHeader', props: { id: 'header' } },
    { type: 'Summary', props: { id: 'facts' } },
    { type: 'Heading', props: { id: 'heading', level: 2, text: { en: text } } },
  ],
});
const profile: PresentationProfile = {
  format: PROFILE_FORMAT,
  generic: {
    views: {
      overview: document('Captured overview'),
      details: document('Captured companion'),
    },
  },
  bases: [],
  types: [],
  routes: [],
};
type State = 'success' | 'pending' | 'denied' | 'unavailable' | 'source-failure' | 'redirect';
function answer(input: DraftPreviewInput, state: State): DraftPreviewResult {
  if (state === 'denied' || state === 'unavailable') return { ok: false, reason: state };
  if (state === 'redirect') return { ok: false, reason: 'redirect', handle: 'current-account' };
  const selected = resolveView(
    input.profile,
    'route' in input.target ? { route: input.target.route } : {},
    'view' in input.target ? (input.target.view ?? 'overview') : 'overview',
  )!;
  return {
    ok: true,
    target: input.target,
    locale: input.locale,
    digest: profileDigest(input.profile),
    page: {
      subject: recorded.subject.id,
      profile: profileDigest(input.profile),
      template: { scope: selected.scope, key: selected.key },
      document: selected.document,
      reads: Object.fromEntries(
        Object.keys(planReads(platformRegistry, selected.document, { subject: recorded.subject.id }).reads).map(
          (key) => [key, state === 'source-failure' ? { status: 503, body: {} } : { status: 200, body: recorded }],
        ),
      ),
    },
  };
}
function Connected({
  state = 'success',
  admissionReplacement = false,
}: {
  state?: State;
  admissionReplacement?: boolean;
}) {
  const locale = getLocale();
  const [signedOut, setSignedOut] = useState(false);
  const client = useMemo(() => {
    const client = new QueryClient();
    client.setQueryData(['session'], { state: 'signed-in', subject: reader, csrfToken: 'story-curator' });
    return client;
  }, []);
  const initial = {
    ok: true as const,
    reader,
    profile,
    digest: profileDigest(profile),
    head: 7,
    advice: { viewer: 'account' as const, publish: 'allowed' as const, activate: 'allowed' as const },
  };
  const transport = useMemo<CurationEditorTransport>(
    () => ({
      read: async () => initial,
      readOpening: async () => initial,
      publish: async () => ({ ok: false, reason: 'forbidden' }),
      previewDraft: (input) => (state === 'pending' ? new Promise(() => {}) : Promise.resolve(answer(input, state))),
    }),
    [state],
  );
  return (
    <PatternStory visitor="Signed In" path="/curate/presentation">
      <QueryClientProvider client={client}>
        <PresentationPreviewContext.Provider value={{ read: async () => ({ ok: false, reason: 'unavailable' }) }}>
          <div className="mx-auto max-w-6xl p-4 sm:p-8">
            {admissionReplacement && (
              <button
                type="button"
                className="mb-4 min-h-11 rounded-md border border-border px-3"
                onClick={() => {
                  const next = !signedOut;
                  client.setQueryData(
                    ['session'],
                    next
                      ? { state: 'signed-out', csrfToken: null }
                      : { state: 'signed-in', subject: reader, csrfToken: 'story-curator' },
                  );
                  setSignedOut(next);
                }}
              >
                {signedOut ? 'Return to curator' : 'Retire curator admission'}
              </button>
            )}
            <CurationView initial={initial} transport={transport} />
          </div>
        </PresentationPreviewContext.Provider>
      </QueryClientProvider>
    </PatternStory>
  );
}
const meta = {
  title: 'Catalogue/Presentation Draft Preview',
  id: 'patterns-curation-presentation-draft-preview',
  globals: { locale: 'en' },
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'The mounted curator editor captures a whole candidate independently of ACTIVE inspection and publication. Use shared phone390/desktop1280, locale and theme globals.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
async function capture(canvasElement: HTMLElement) {
  const panel = within(canvasElement).getByRole('region', { name: m.draft_preview_title() });
  const controls = within(panel);
  await userEvent.type(controls.getByRole('textbox', { name: m.draft_preview_address() }), recorded.subject.id);
  await userEvent.selectOptions(controls.getByRole('combobox', { name: m.draft_preview_view() }), 'details');
  await userEvent.click(controls.getByRole('button', { name: m.draft_preview_capture() }));
  return controls;
}
export const CapturedCompanion: Story = {
  render: () => <Connected />,
  play: async ({ canvasElement }) => {
    const controls = await capture(canvasElement);
    await expect(controls.getByText('Captured companion')).toBeVisible();
    await expect(within(canvasElement).getByRole('heading', { name: m.presentation_preview_title() })).toBeVisible();
  },
};
export const SourceFailureWithSibling: Story = {
  ...CapturedCompanion,
  render: () => <Connected state="source-failure" />,
};
export const PendingEdits: Story = {
  render: () => <Connected state="pending" />,
  play: async ({ canvasElement }) => {
    const controls = await capture(canvasElement);
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole('textbox', { name: m.curation_key() }), 'schema:Book');
    await userEvent.click(canvas.getByRole('button', { name: m.curation_add() }));
    await expect(controls.getByText(m.draft_preview_changed())).toBeVisible();
    await userEvent.click(controls.getByRole('button', { name: m.draft_preview_interrupt() }));
    await expect(controls.getByText(m.draft_preview_interrupted())).toBeVisible();
  },
};
export const AdmissionReplacementPreservesDraft: Story = {
  render: () => <Connected state="pending" admissionReplacement />,
  play: async ({ canvasElement }) => {
    const controls = await capture(canvasElement);
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole('textbox', { name: m.curation_key() }), 'schema:Book');
    await userEvent.click(canvas.getByRole('button', { name: m.curation_add() }));
    await userEvent.click(canvas.getByRole('button', { name: 'Retire curator admission' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Return to curator' }));
    await expect(canvas.getByRole('region', { name: m.curation_templates() })).toHaveTextContent('schema:Book');
    await expect(controls.queryByText(m.draft_preview_success())).not.toBeInTheDocument();
  },
};
export const Denied: Story = {
  render: () => <Connected state="denied" />,
  play: async ({ canvasElement }) => {
    const controls = await capture(canvasElement);
    await expect(controls.getByRole('alert')).toHaveTextContent(m.presentation_preview_denied());
  },
};
export const Unavailable: Story = {
  render: () => <Connected state="unavailable" />,
  play: async ({ canvasElement }) => {
    const controls = await capture(canvasElement);
    await expect(controls.getByRole('alert')).toHaveTextContent(m.presentation_preview_unavailable());
    await expect(controls.getByRole('button', { name: m.draft_preview_retry() })).toBeEnabled();
  },
};
export const IdentityCorrection: Story = {
  render: () => <Connected state="redirect" />,
  play: async ({ canvasElement }) => {
    const controls = await capture(canvasElement);
    await userEvent.click(
      controls.getByRole('button', { name: m.draft_preview_correct({ handle: 'current-account' }) }),
    );
    await expect(controls.getByRole('textbox', { name: m.draft_preview_address() })).toHaveValue('current-account');
  },
};
