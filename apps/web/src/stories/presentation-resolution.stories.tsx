import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import {
  PROFILE_FORMAT,
  planReads,
  platformRegistry,
  profileDigest,
  type CompositionDocument,
  type PresentationProfile,
} from '@rezics/composition';
import { PresentationViewEditor } from '../features/pages/curate-view-editor';
import type { PresentationPreview } from '../features/pages/presentation-preview';
import { PresentationPreviewPanel } from '../features/pages/presentation-preview-view';
import type { PublicationTransport } from '../features/pages/curation-publish';
import { withTemplate } from '../features/pages/curate';
import recorded from '../kernel/recorded/subject.json';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { PatternStory } from './page';

// Contract-shaped aggregate fixtures around the recorded public subject body. They are UI examples, not native receipts.
const document: CompositionDocument = {
  root: { props: {} },
  content: [
    { type: 'SubjectHeader', props: { id: 'header' } },
    { type: 'Summary', props: { id: 'summary' } },
  ],
};
const routeDocument: CompositionDocument = {
  root: { props: {} },
  content: [{ type: 'Heading', props: { id: 'home', text: { en: 'Published catalogue' }, level: 1 } }],
};
const published: PresentationProfile = {
  format: PROFILE_FORMAT,
  generic: document,
  bases: [{ base: 'schema:CreativeWork', document }],
  types: [],
  routes: [{ route: '/', document: routeDocument }],
};
const digest = profileDigest(published);
const head = 17;
const subject = recorded.subject.id;
const plan = planReads(platformRegistry, document, { subject });
function current(locale: string): Extract<PresentationPreview, { ok: true }> {
  return {
    ok: true,
    target: { subject },
    locale,
    head,
    page: {
      subject,
      profile: digest,
      template: { scope: 'base', key: 'schema:CreativeWork' },
      document,
      reads: Object.fromEntries(Object.keys(plan.reads).map((key) => [key, { status: 200, body: recorded }])),
    },
  };
}
function ConnectedCuration({
  state = 'current',
}: {
  state?: 'current' | 'route' | 'denied' | 'unavailable' | 'draft';
}) {
  const locale = getLocale();
  const result: PresentationPreview =
    state === 'denied' || state === 'unavailable'
      ? { ok: false, reason: state }
      : state === 'route'
        ? {
            ok: true,
            target: { route: '/' },
            locale,
            head,
            page: {
              subject: null,
              profile: digest,
              template: { scope: 'route', key: '/' },
              document: routeDocument,
              reads: {},
            },
          }
        : current(locale);
  const draft =
    state === 'draft'
      ? withTemplate(
          published,
          { scope: 'generic', key: null },
          {
            root: { props: {} },
            content: [{ type: 'Heading', props: { id: 'draft', level: 1, text: { en: 'Unpublished draft heading' } } }],
          },
        )
      : published;
  const initial = { ok: true as const, reader: subject, profile: draft, digest, head };
  const transport: PublicationTransport = {
    read: async () => initial,
    publish: async () => ({ ok: false, reason: 'forbidden' }),
  };
  return (
    <PatternStory visitor="Signed In" path="/curate/presentation">
      <div className="mx-auto max-w-6xl p-4 sm:p-8">
        <PresentationViewEditor
          initial={initial}
          observedSession={{ state: 'signed-in', subject }}
          locale={locale}
          transport={transport}
          preview={<PresentationPreviewPanel locale={locale} read={async () => result} initial={result} />}
        />
      </div>
    </PatternStory>
  );
}

const meta = {
  title: 'Patterns/Curation/Presentation Resolution',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'The whole existing curation region, its editor and active public inspection. Use shared phone390/desktop1280, locale and theme globals. Contract-shaped page responses reuse a recorded public subject; these stories do not claim native, browser or visual acceptance.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const CurrentResolution: Story = {
  render: () => <ConnectedCuration />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(digest)).toBeVisible();
    await expect(canvas.getByRole('heading', { name: m.presentation_preview_active() })).toBeVisible();
    await userEvent.click(canvas.getByText(m.presentation_preview_document()));
    await expect(canvas.getByText(/"SubjectHeader"/)).toBeVisible();
  },
};
export const RouteResolution: Story = { render: () => <ConnectedCuration state="route" /> };
export const Denied: Story = { render: () => <ConnectedCuration state="denied" /> };
export const Unavailable: Story = { render: () => <ConnectedCuration state="unavailable" /> };
export const DraftDistinction: Story = {
  render: () => <ConnectedCuration state="draft" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: `generic: ${m.curation_generic()}` }));
    const editor = await canvas.findByRole('region', { name: m.curation_editor() });
    const preview = canvas.getByRole('region', { name: m.presentation_preview_title() });
    await userEvent.click(within(preview).getByRole('button', { name: m.presentation_preview_inspect() }));
    await within(preview).findByRole('heading', { name: m.presentation_preview_active() });
    await expect(canvas.getByRole('region', { name: m.curation_editor() })).toBe(editor);
    await expect(within(preview).queryByText('Unpublished draft heading')).toBeNull();
    await userEvent.click(within(preview).getByRole('button', { name: m.presentation_preview_close() }));
    await expect(canvas.getByRole('region', { name: m.curation_editor() })).toBe(editor);
  },
};
