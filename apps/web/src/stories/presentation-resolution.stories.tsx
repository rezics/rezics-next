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
import type { PresentationPreview, PresentationPreviewInput } from '../features/pages/presentation-preview';
import { PresentationPreviewPanel } from '../features/pages/presentation-preview-view';
import type { PublicationTransport } from '../features/pages/curation-publish';
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
const longRoute = `/${'published-catalogue/'.repeat(12)}catalogue`;
const comparisonProfile: PresentationProfile = {
  ...published,
  routes: [...published.routes, { route: longRoute, document: routeDocument }],
};
const comparisonDigest = profileDigest(comparisonProfile);
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
  independent = false,
  recover = false,
}: {
  state?: 'current' | 'route' | 'denied' | 'unavailable' | 'invalid' | 'missing' | 'changed' | 'redirect';
  independent?: boolean;
  recover?: boolean;
}) {
  const locale = getLocale();
  const result: PresentationPreview =
    state === 'denied' || state === 'unavailable' || state === 'invalid' || state === 'missing' || state === 'changed'
      ? { ok: false, reason: state }
      : state === 'redirect'
        ? { ok: false, reason: 'redirect', handle: 'published-reader-with-long-name' }
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
  const realm = '00000000-0000-4000-8000-000000000007';
  const context = {
    id: recorded.subject.context,
    population: { kind: 'realm' as const, id: realm, title: 'Published Realm with a long readable title '.repeat(6) },
  };
  const realmResult: Extract<PresentationPreview, { ok: true }> = {
    ...current(locale),
    target: { subject, realm },
    page: {
      ...current(locale).page,
      profile: comparisonDigest,
      context,
      reads: Object.fromEntries(
        Object.keys(planReads(platformRegistry, document, { subject, context }).reads).map((key) => [
          key,
          { status: 200, body: recorded },
        ]),
      ),
    },
  };
  const routeResult: Extract<PresentationPreview, { ok: true }> = {
    ok: true,
    target: { route: longRoute },
    locale,
    head,
    page: {
      subject: null,
      profile: comparisonDigest,
      template: { scope: 'route', key: longRoute },
      document: routeDocument,
      reads: {},
    },
  };
  const inspect = async (input: PresentationPreviewInput): Promise<PresentationPreview> =>
    independent || recover
      ? 'route' in input.target
        ? {
            ...routeResult,
            target: input.target,
            page: { ...routeResult.page, template: { scope: 'route', key: input.target.route } },
          }
        : input.target.realm
          ? { ...realmResult, target: input.target }
          : { ...current(locale), target: input.target }
      : result;
  const initial = {
    ok: true as const,
    reader: subject,
    profile: independent ? comparisonProfile : published,
    digest: independent ? comparisonDigest : digest,
    head,
  };
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
          preview={
            <div className="min-w-0 space-y-6">
              <PresentationPreviewPanel locale={locale} read={inspect} initial={independent ? realmResult : result} />
              {independent && <PresentationPreviewPanel locale={locale} read={inspect} initial={routeResult} />}
            </div>
          }
        />
      </div>
    </PatternStory>
  );
}

const meta = {
  title: 'Patterns/Curation/Presentation Resolution',
  globals: { locale: 'en', theme: 'light', viewport: { value: 'desktop1280', isRotated: false } },
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
    const preview = within(canvas.getByRole('region', { name: m.presentation_preview_title() }));
    await expect(preview.getByRole('heading', { name: m.presentation_editor_preview_current() })).toBeVisible();
    await userEvent.click(preview.getByText(m.presentation_editor_preview_details()));
    await expect(preview.getByText(digest)).toBeVisible();
    await userEvent.click(canvas.getByText(m.presentation_preview_document()));
    await expect(canvas.getByText(/"SubjectHeader"/)).toBeVisible();
  },
};
export const RouteResolution: Story = { render: () => <ConnectedCuration state="route" /> };
export const Denied: Story = { render: () => <ConnectedCuration state="denied" /> };
export const Unavailable: Story = { render: () => <ConnectedCuration state="unavailable" /> };
export const DraftDistinction: Story = {
  render: () => <ConnectedCuration />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.selectOptions(canvas.getByRole('combobox', { name: m.curation_scope() }), 'route');
    await userEvent.type(canvas.getByRole('textbox', { name: m.curation_key() }), '/unpublished-draft');
    await userEvent.click(canvas.getByRole('button', { name: m.curation_add() }));
    await expect(canvas.getByText(m.curation_unsaved())).toBeVisible();
    const editor = await canvas.findByRole('region', { name: m.curation_editor() });
    const preview = canvas.getByRole('region', { name: m.presentation_preview_title() });
    await userEvent.click(within(preview).getByRole('button', { name: m.presentation_preview_inspect() }));
    await within(preview).findByRole('heading', { name: m.presentation_editor_preview_current() });
    await expect(canvas.getByRole('region', { name: m.curation_editor() })).toBe(editor);
    await expect(within(preview).queryByText('/unpublished-draft')).toBeNull();
    await expect(canvas.getByText(m.curation_unsaved())).toBeVisible();
    await userEvent.click(within(preview).getByRole('button', { name: m.presentation_preview_close() }));
    await expect(canvas.getByRole('region', { name: m.curation_editor() })).toBe(editor);
  },
};

export const Invalid: Story = { render: () => <ConnectedCuration state="invalid" /> };
export const Missing: Story = { render: () => <ConnectedCuration state="missing" /> };
export const Changed: Story = { render: () => <ConnectedCuration state="changed" /> };
export const Redirect: Story = { render: () => <ConnectedCuration state="redirect" /> };
export const DeliberateRecovery: Story = {
  render: () => <ConnectedCuration state="unavailable" recover />,
  play: async ({ canvasElement }) => {
    const preview = within(within(canvasElement).getByRole('region', { name: m.presentation_preview_title() }));
    await expect(preview.getByRole('alert')).toHaveTextContent(m.presentation_preview_unavailable());
    await userEvent.type(preview.getByLabelText(m.presentation_preview_address()), subject);
    await userEvent.click(preview.getByRole('button', { name: m.presentation_preview_inspect() }));
    await expect(await preview.findByRole('heading', { name: m.presentation_editor_preview_current() })).toBeVisible();
    await expect(preview.queryByRole('alert')).toBeNull();
  },
};
export const IndependentForms: Story = {
  render: () => <ConnectedCuration independent />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const [subjectPanel, routePanel] = canvas.getAllByRole('region', { name: m.presentation_preview_title() });
    const first = within(subjectPanel!);
    const second = within(routePanel!);
    await expect(first.getByLabelText(m.presentation_preview_realm())).not.toHaveValue('');
    await expect(second.queryByLabelText(m.presentation_preview_realm())).toBeNull();
    const secondAddress = second.getByLabelText(m.presentation_preview_address());
    const retainedAddress = (secondAddress as HTMLInputElement).value;
    const realmDetails = first.getByText(m.presentation_editor_preview_details());
    realmDetails.focus();
    await userEvent.keyboard('{Enter}');
    for (const panel of [subjectPanel!, routePanel!]) {
      for (const summary of panel.querySelectorAll('summary')) {
        await expect(summary.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
      }
      for (const help of panel.querySelectorAll('p[id]')) {
        await expect(help.scrollWidth).toBeLessThanOrEqual(help.clientWidth + 1);
      }
      await expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth + 1);
    }
    const context = first.getByText(/Published Realm with a long readable title/);
    await expect(context.scrollWidth).toBeLessThanOrEqual(context.clientWidth + 1);
    await userEvent.selectOptions(first.getByLabelText(m.presentation_preview_target()), 'route');
    await userEvent.type(first.getByLabelText(m.presentation_preview_address()), '/');
    await userEvent.click(first.getByRole('button', { name: m.presentation_preview_inspect() }));
    await first.findByRole('heading', { name: m.presentation_editor_preview_current() });
    await userEvent.click(first.getByRole('button', { name: m.presentation_preview_close() }));
    await expect(first.queryByRole('heading', { name: m.presentation_editor_preview_current() })).toBeNull();
    await expect(second.getByRole('heading', { name: m.presentation_editor_preview_current() })).toBeVisible();
    await expect(secondAddress).toHaveValue(retainedAddress);
    const details = second.getByText(m.presentation_editor_preview_details());
    details.focus();
    await userEvent.keyboard('{Enter}');
    await expect(second.getByText(comparisonDigest)).toBeVisible();
  },
};
export const IndependentFormsPhone: Story = {
  ...IndependentForms,
  globals: { locale: 'zh-Hant', theme: 'dark', viewport: { value: 'phone390', isRotated: false } },
};
export const RedirectPhone: Story = {
  render: () => <ConnectedCuration state="redirect" />,
  globals: { locale: 'fr', theme: 'dark', viewport: { value: 'phone390', isRotated: false } },
  play: async ({ canvasElement }) => {
    const preview = within(within(canvasElement).getByRole('region', { name: m.presentation_preview_title() }));
    const destination = preview.getByRole('link', { name: '@published-reader-with-long-name' });
    destination.focus();
    await expect(destination).toHaveFocus();
    await expect(destination.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    await expect(destination.scrollWidth).toBeLessThanOrEqual(destination.clientWidth + 1);
  },
};
