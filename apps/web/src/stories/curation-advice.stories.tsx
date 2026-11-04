import type { Meta, StoryObj } from '@storybook/react-vite';
import { PROFILE_FORMAT, profileDigest, type PresentationProfile } from '@rezics/composition';
import { expect, userEvent, within } from 'storybook/test';
import { PresentationViewEditor, type CurationEditorTransport } from '../features/pages/curate-view-editor';
import type { CurationAdvice } from '../features/pages/curation-advice';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime';
import { PatternStory } from './page';

type Scenario = 'read-only' | 'publish-only' | 'activate-only' | 'unavailable';
const reader = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e10';
const profile: PresentationProfile = {
  format: PROFILE_FORMAT,
  generic: { root: { props: {} }, content: [] },
  bases: [],
  types: [],
  routes: [],
};

function advice(scenario: Scenario): CurationAdvice {
  return {
    viewer: 'account',
    publish: scenario === 'publish-only' ? 'allowed' : scenario === 'activate-only' ? 'denied' : scenario === 'unavailable' ? 'unavailable' : 'denied',
    activate: scenario === 'publish-only' ? 'denied' : scenario === 'activate-only' ? 'allowed' : scenario === 'unavailable' ? 'unavailable' : 'denied',
  };
}

function CurationAdviceStory({ scenario }: { scenario: Scenario }) {
  const currentAdvice = advice(scenario);
  const initial = {
    ok: true as const,
    reader,
    profile,
    digest: profileDigest(profile),
    head: 7,
    advice: currentAdvice,
  };
  const transport: CurationEditorTransport = {
    read: async () => ({
      ok: true,
      reader,
      profile,
      digest: profileDigest(profile),
      head: 7,
    }),
    readOpening: async () => initial,
    publish: async () => ({ ok: false, reason: 'unavailable', outcome: 'unknown' }),
    publishOnly: async (input) => ({ ok: true, digest: profileDigest(input.profile) }),
    activate: async (input) => ({ ok: true, digest: input.digest, head: input.expectedHead + 1 }),
  };
  return (
    <div className="mx-auto max-w-6xl p-4 sm:p-8">
      <PresentationViewEditor
        initial={initial}
        observedSession={{ state: 'signed-in', subject: reader }}
        locale={getLocale()}
        transport={transport}
      />
    </div>
  );
}

const meta = {
  title: 'Patterns/Presentation/Curation advice',
  component: CurationAdviceStory,
  decorators: [
    (Story) => (
      <PatternStory visitor="Signed In" path="/curate/presentation">
        <Story />
      </PatternStory>
    ),
  ],
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Native opening advice is a current view of independent commands. These states demonstrate disabled controls and retained local work; every command still reauthorizes when submitted.',
      },
    },
  },
} satisfies Meta<typeof CurationAdviceStory>;
export default meta;
type Story = StoryObj<typeof meta>;

async function draftRoute(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.selectOptions(canvas.getByRole('combobox', { name: m.curation_scope() }), 'route');
  await userEvent.type(canvas.getByRole('textbox', { name: m.curation_key() }), '/books');
  await userEvent.click(canvas.getByRole('button', { name: m.curation_add() }));
  await userEvent.click(await canvas.findByRole('button', { name: m.curation_close() }));
  return canvas;
}

export const ReadOnly: Story = {
  args: { scenario: 'read-only' },
  play: async ({ canvasElement }) => {
    const canvas = await draftRoute(canvasElement);
    await expect(canvas.getAllByText(m.curation_advice_denied())).toHaveLength(2);
    await expect(canvas.getByRole('button', { name: m.curation_publish() })).toBeDisabled();
    await expect(canvas.getByRole('button', { name: m.curation_view_discard() })).toBeEnabled();
  },
};

export const PublishOnly: Story = {
  args: { scenario: 'publish-only' },
  play: async ({ canvasElement }) => {
    const canvas = await draftRoute(canvasElement);
    await expect(canvas.getByText(m.curation_advice_publish_only())).toBeVisible();
    await expect(canvas.getByRole('button', { name: m.curation_publish() })).toBeEnabled();
    await userEvent.click(canvas.getByRole('button', { name: m.curation_publish() }));
    await expect(await canvas.findByText(m.curation_retry_activation_help())).toBeVisible();
  },
};

export const ActivateOnly: Story = {
  args: { scenario: 'activate-only' },
  play: async ({ canvasElement }) => {
    const canvas = await draftRoute(canvasElement);
    await expect(canvas.getByText(m.curation_advice_activate_only())).toBeVisible();
    await expect(canvas.getByRole('button', { name: m.curation_publish() })).toBeDisabled();
  },
};

export const AdviceUnavailable: Story = {
  args: { scenario: 'unavailable' },
  play: async ({ canvasElement }) => {
    const canvas = await draftRoute(canvasElement);
    await expect(canvas.getAllByText(m.curation_advice_unavailable())).toHaveLength(2);
    await expect(canvas.getByRole('button', { name: m.curation_publish() })).toBeDisabled();
    await expect(canvas.getByText(m.curation_unsaved())).toBeVisible();
  },
};
