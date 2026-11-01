import type { Meta, StoryObj } from '@storybook/react-vite';
import { createKernelClient } from '@rezics/client';
import { PROFILE_FORMAT, profileDigest, type PresentationProfile } from '@rezics/composition';
import { useMemo } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { CurationView } from '../features/pages/curate-view';
import { publishProfile } from '../features/pages/curate';
import type { PublicationTransport } from '../features/pages/curation-publish';
import { m } from '../paraglide/messages.js';
import { PatternStory } from './page';

type Scenario = 'unknown-publish' | 'partial-activation' | 'current-head-conflict' | 'revoked-replay';
const initialProfile: PresentationProfile = {
  format: PROFILE_FORMAT,
  generic: { root: { props: {} }, content: [] },
  bases: [],
  types: [],
  routes: [],
};

function PublicationStory({ scenario }: { scenario: Scenario }) {
  const transport = useMemo((): PublicationTransport => {
    let request = 0;
    let digest = profileDigest(initialProfile);
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const wire = input instanceof Request ? input : new Request(String(input), init);
      const body = (await wire.json()) as { profile?: PresentationProfile; expected_head?: number };
      const call = ++request;
      const publish = body.profile !== undefined;
      if (publish) digest = profileDigest(body.profile!);
      if (
        (scenario === 'unknown-publish' && call === 1) ||
        ((scenario === 'partial-activation' || scenario === 'revoked-replay') && call === 2)
      )
        throw new TypeError('Lost publication response');
      const status =
        scenario === 'revoked-replay' && call > 2
          ? 403
          : scenario === 'current-head-conflict' && call === 2
            ? 409
            : publish
              ? 201
              : 200;
      const result =
        status === 403
          ? { code: 'forbidden' }
          : status === 409
            ? { code: 'stale_editorial_head' }
            : publish
              ? { digest }
              : { digest, head: body.expected_head! + 1 };
      return new Response(JSON.stringify(result), { status, headers: { 'content-type': 'application/json' } });
    }) as typeof globalThis.fetch;
    const client = createKernelClient('https://kernel.invalid', { fetch });
    return {
      publish: (input) => publishProfile(client, { ...input, authorization: 'Bearer story-session' }),
      read: async () => ({ ok: true, head: 9, digest: profileDigest(initialProfile), profile: initialProfile }),
    };
  }, [scenario]);
  return (
    <div className="mx-auto max-w-6xl p-4 sm:p-8">
      <CurationView
        initial={{ ok: true, profile: initialProfile, head: 7, digest: profileDigest(initialProfile) }}
        transport={transport}
      />
    </div>
  );
}

const meta = {
  title: 'Patterns/Presentation/Curation publication',
  component: PublicationStory,
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
          'Connected curation recovery using the real publication helper and generated SDK with typed wire fixtures. Native and visual proof remain pending. Uses shared locale, theme and width globals.',
      },
    },
  },
} satisfies Meta<typeof PublicationStory>;
export default meta;
type Story = StoryObj<typeof meta>;

async function submit(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByRole('button', { name: m.curation_publish() }));
  return canvas;
}
async function retry(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByRole('button', { name: m.curation_retry_original() }));
  return canvas;
}
async function expectPublished(canvasElement: HTMLElement, head: number) {
  const canvas = within(canvasElement);
  await expect(await canvas.findByText(m.presentation_editor_published())).toBeVisible();
  await userEvent.click(await canvas.findByText(m.presentation_editor_publication_details()));
  await expect(
    await canvas.findByText(
      m.presentation_editor_version_reference({ head, digest: profileDigest(initialProfile) }),
    ),
  ).toBeVisible();
}

export const UnknownPublish: Story = {
  args: { scenario: 'unknown-publish' },
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement);
    await canvas.findByText(m.curation_unknown());
    await retry(canvasElement);
    await expectPublished(canvasElement, 8);
  },
};
export const PartialActivation: Story = {
  args: { scenario: 'partial-activation' },
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement);
    await canvas.findByText(m.curation_partial());
    await retry(canvasElement);
    await expectPublished(canvasElement, 8);
  },
};
export const CurrentHeadConflict: Story = {
  args: { scenario: 'current-head-conflict' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.selectOptions(canvas.getByRole('combobox', { name: m.curation_scope() }), 'route');
    await userEvent.type(canvas.getByRole('textbox', { name: m.curation_key() }), '/books');
    await userEvent.click(canvas.getByRole('button', { name: m.curation_add() }));
    await userEvent.click(canvas.getByRole('button', { name: m.curation_close() }));
    await submit(canvasElement);
    await userEvent.click(await canvas.findByText(m.presentation_editor_active_version_details()));
    await canvas.findByText(m.curation_actual_head({ head: 9, digest: profileDigest(initialProfile) }));
    await expect(canvas.getByRole('button', { name: 'route: /books' })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: m.curation_reconcile() }));
    await canvas.findByText(m.curation_reconciled());
    await submit(canvasElement);
    await expect(await canvas.findByText(m.presentation_editor_published())).toBeVisible();
  },
};
export const RevokedReplay: Story = {
  args: { scenario: 'revoked-replay' },
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement);
    await canvas.findByText(m.curation_partial());
    await retry(canvasElement);
    await expect(await canvas.findByText(m.curation_forbidden())).toBeVisible();
    await expect(canvas.getByRole('button', { name: m.curation_retry_original() })).toBeEnabled();
    await expect(canvas.queryByText(m.presentation_editor_published())).toBeNull();
  },
};
