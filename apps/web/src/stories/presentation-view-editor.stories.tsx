import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { PROFILE_FORMAT, type CompositionDocument, type PresentationProfile } from '@rezics/composition';
import { PresentationViewEditor, type CurationEditorTransport } from '../features/pages/curate-view-editor';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';

// Explicit inert profile data exercises the real editor. These are behavior states, not native publication receipts.
const pageDocument = (id: string, level = 2): CompositionDocument => ({
  root: { props: { appearance: { density: 'comfortable' } } },
  content: [
    {
      type: 'Heading',
      props: {
        id,
        level,
        text: {
          en: 'Reading notes',
          'zh-Hans': '阅读笔记',
          'zh-Hant': '閱讀筆記',
          ja: '読書ノート',
          ko: '독서 노트',
          de: 'Lesenotizen',
          es: 'Notas de lectura',
          fr: 'Notes de lecture',
        },
      },
    },
  ],
});
const profile: PresentationProfile = {
  format: PROFILE_FORMAT,
  generic: {
    views: {
      overview: pageDocument('generic'),
      relations: pageDocument('generic-relations'),
      details: pageDocument('generic-details'),
    },
  },
  bases: [
    { base: 'schema:CreativeWork', views: { overview: pageDocument('work', 1), credits: pageDocument('credits', 3) } },
  ],
  types: [
    {
      type: 'schema:Book',
      views: {
        overview: pageDocument('book'),
        editions: pageDocument('editions', 4),
        details: pageDocument('details'),
      },
    },
  ],
  routes: [{ route: '/', document: pageDocument('home', 1) }],
};
const initial = { ok: true as const, profile, digest: `sha256:${'a'.repeat(64)}`, head: 7 };
const transport: CurationEditorTransport = {
  read: async () => initial,
  publish: async () => ({ ok: false, reason: 'unavailable' }),
};
const meta = {
  title: 'Pages/Curate/Presentation View Editor',
  component: PresentationViewEditor,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Per-view Puck authoring in the existing shell. Use the shared phone390/desktop1280, locale and theme globals. Failure responses are constructed; these stories do not establish native access or publication proof.',
      },
    },
  },
} satisfies Meta<typeof PresentationViewEditor>;
export default meta;
type Story = StoryObj<typeof meta>;
const render: NonNullable<Story['render']> = (args) => (
  <PatternStory visitor="Signed In" path="/curate/presentation">
    <AppShell>
      <PresentationViewEditor {...args} locale={getLocale()} />
    </AppShell>
  </PatternStory>
);
export const Authoring: Story = {
  args: { initial, locale: 'en', transport },
  render,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: `generic: ${m.curation_generic()}` }));
    await expect(await canvas.findByRole('region', { name: m.curation_editor() })).toBeVisible();
  },
};

// Real Puck field interaction, including an uncommitted edit before switching away and back.
async function editDetails(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.selectOptions(
    await canvas.findByLabelText(m.curation_template()),
    JSON.stringify({ scope: 'type', key: 'schema:Book' }),
  );
  await userEvent.selectOptions(canvas.getByLabelText(m.curation_view()), 'details');
  // Select a block from Puck's own outline; the same shared field editor owns its language object.
  const headings = await canvas.findAllByText('Heading', { exact: true });
  await userEvent.click(headings[headings.length - 1]!);
  const language = new Intl.DisplayNames(['en'], { type: 'language' }).of('en') ?? 'en';
  const field = await canvas.findByLabelText(language);
  await userEvent.clear(field);
  await userEvent.type(field, 'Retained draft');
  return canvas;
}

export const RetainedViewDraft: Story = {
  ...Authoring,
  play: async ({ canvasElement }) => {
    const canvas = await editDetails(canvasElement);
    await userEvent.selectOptions(canvas.getByLabelText(m.curation_view()), 'overview');
    await userEvent.selectOptions(
      canvas.getByLabelText(m.curation_template()),
      JSON.stringify({ scope: 'generic', key: null }),
    );
    await userEvent.selectOptions(
      canvas.getByLabelText(m.curation_template()),
      JSON.stringify({ scope: 'type', key: 'schema:Book' }),
    );
    await userEvent.selectOptions(canvas.getByLabelText(m.curation_view()), 'details');
    await expect(canvas.getByText(m.curation_unsaved())).toBeVisible();
    // Restoring a view restores the document even though Puck's selected block may be reset.
    const heading = await canvas.findAllByText('Heading', { exact: true });
    await userEvent.click(heading[heading.length - 1]!);
    const language = new Intl.DisplayNames(['en'], { type: 'language' }).of('en') ?? 'en';
    await expect(await canvas.findByLabelText(language)).toHaveValue('Retained draft');
  },
};

export const StaleProfile: Story = {
  ...Authoring,
  args: { ...Authoring.args, transport: { ...transport, publish: async () => ({ ok: false, reason: 'stale' }) } },
  play: async ({ canvasElement }) => {
    const canvas = await editDetails(canvasElement);
    await userEvent.click(canvas.getAllByRole('button', { name: m.curation_publish() })[0]!);
    await expect(await canvas.findByText(m.curation_stale())).toBeVisible();
    await expect(canvas.getByText(m.curation_unsaved())).toBeVisible();
    for (const button of canvas.getAllByRole('button', { name: m.curation_publish() })) {
      await expect(button).toBeDisabled();
    }
    await userEvent.click(canvas.getByRole('button', { name: m.curation_view_discard() }));
    const dialog = await within(document.body).findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: m.curation_view_discard() }));
    await expect(canvas.getByText(m.curation_saved())).toBeVisible();
    await expect(canvas.getByText(m.curation_stale())).toBeVisible();
    for (const button of canvas.getAllByRole('button', { name: m.curation_publish() })) {
      await expect(button).toBeDisabled();
    }
  },
};

export const NativeValidation: Story = {
  ...Authoring,
  args: {
    ...Authoring.args,
    transport: {
      ...transport,
      publish: async () => ({
        ok: false,
        reason: 'invalid',
        errors: [{ pointer: '/types/0/views/details/content/0/props/text/en', code: 'invalid' }],
      }),
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click((await canvas.findAllByRole('button', { name: m.curation_publish() }))[0]!);
    await expect(await canvas.findByText('/types/0/views/details/content/0/props/text/en — invalid')).toBeVisible();
  },
};

export const DiscardConfirmation: Story = {
  ...Authoring,
  play: async ({ canvasElement }) => {
    const canvas = await editDetails(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.curation_view_discard() }));
    const dialog = await within(document.body).findByRole('alertdialog');
    await expect(within(dialog).getByText(m.curation_discard_warning())).toBeVisible();
  },
};

export const ReloadUnavailable: Story = {
  ...Authoring,
  args: { ...Authoring.args, transport: { ...transport, read: async () => ({ ok: false, reason: 'unavailable' }) } },
  play: async ({ canvasElement }) => {
    const canvas = await editDetails(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.curation_reload() }));
    const dialog = await within(document.body).findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: m.curation_discard_reload() }));
    await expect(await canvas.findByText(m.curation_unavailable())).toBeVisible();
    await expect(canvas.getByText(m.curation_unsaved())).toBeVisible();
  },
};
