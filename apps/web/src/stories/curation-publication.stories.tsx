import type { Meta, StoryObj } from '@storybook/react-vite';
import { createKernelClient } from '@rezics/client';
import { PROFILE_FORMAT, profileDigest, type PresentationProfile } from '@rezics/composition';
import { useMemo } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { PresentationViewEditor } from '../features/pages/curate-view-editor';
import { overviewOf, publishProfile, withTemplate } from '../features/pages/curate';
import type { PublicationTransport } from '../features/pages/curation-publish';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime';
import { PatternStory } from './page';

type Scenario = 'unknown-publish' | 'partial-activation' | 'current-head-conflict' | 'revoked-replay';
const initialProfile: PresentationProfile = {
  format: PROFILE_FORMAT,
  generic: { root: { props: {} }, content: [] },
  bases: [],
  types: [],
  routes: [],
};
const editedProfile = withTemplate(
  initialProfile,
  { scope: 'route', key: '/books' },
  overviewOf(initialProfile, { scope: 'generic', key: null })!,
);
const reader = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e10';

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
      read: async () => ({ ok: true, reader, head: 9, digest: profileDigest(initialProfile), profile: initialProfile }),
    };
  }, [scenario]);
  return (
    <div className="mx-auto max-w-6xl p-4 sm:p-8">
      <PresentationViewEditor
        initial={{ ok: true, reader, profile: initialProfile, head: 7, digest: profileDigest(initialProfile) }}
        observedSession={{ state: 'signed-in', subject: reader }}
        locale={getLocale()}
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

async function editDraft(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await expect(canvas.getByRole('button', { name: m.curation_publish() })).toBeDisabled();
  await userEvent.selectOptions(canvas.getByRole('combobox', { name: m.curation_scope() }), 'route');
  await userEvent.type(canvas.getByRole('textbox', { name: m.curation_key() }), '/books');
  await userEvent.click(canvas.getByRole('button', { name: m.curation_add() }));
  await userEvent.click(await canvas.findByRole('button', { name: m.curation_close() }));
  await expect(canvas.getByRole('button', { name: m.curation_publish() })).toBeEnabled();
}
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
    await canvas.findByText(m.presentation_editor_version_reference({ head, digest: profileDigest(editedProfile) })),
  ).toBeVisible();
}

export const UnknownPublish: Story = {
  args: { scenario: 'unknown-publish' },
  play: async ({ canvasElement }) => {
    await editDraft(canvasElement);
    const canvas = await submit(canvasElement);
    await canvas.findByText(m.curation_unknown());
    await retry(canvasElement);
    await expectPublished(canvasElement, 8);
  },
};
export const PartialActivation: Story = {
  args: { scenario: 'partial-activation' },
  play: async ({ canvasElement }) => {
    await editDraft(canvasElement);
    const canvas = await submit(canvasElement);
    await canvas.findByText(m.curation_partial());
    await retry(canvasElement);
    await expectPublished(canvasElement, 8);
  },
};
export const CurrentHeadConflict: Story = {
  args: { scenario: 'current-head-conflict' },
  play: async ({ canvasElement }) => {
    await editDraft(canvasElement);
    const canvas = await submit(canvasElement);
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
    await editDraft(canvasElement);
    const canvas = await submit(canvasElement);
    await canvas.findByText(m.curation_partial());
    await retry(canvasElement);
    await expect(await canvas.findByText(m.curation_forbidden())).toBeVisible();
    await expect(canvas.getByRole('button', { name: m.curation_retry_original() })).toBeEnabled();
    await expect(canvas.queryByText(m.presentation_editor_published())).toBeNull();
  },
};

const reviewOriginal: PresentationProfile = {
  format: PROFILE_FORMAT,
  generic: {
    views: {
      overview: {
        root: {
          props: {
            appearance: { density: 'compact', surface: 'cards', radius: 'lg', cover: 'portrait', headingScale: 'lg' },
          },
        },
        content: [
          {
            type: 'Stack',
            props: {
              id: 'reading',
              gap: 'md',
              children: [
                {
                  type: 'Heading',
                  props: {
                    id: 'heading',
                    level: 2,
                    text: {
                      en: 'Reading together',
                      ja: '一緒に読む',
                      de: 'Gemeinsam lesen und neue Geschichten entdecken',
                    },
                  },
                },
                {
                  type: 'Text',
                  props: {
                    id: 'intro',
                    text: {
                      en: 'Notes, editions and conversations for every reader.',
                      fr: 'Notes, éditions et conversations pour toutes les personnes qui lisent.',
                    },
                  },
                },
              ],
            },
          },
        ],
      },
      details: {
        root: { props: {} },
        content: [{ type: 'Statements', props: { id: 'facts', properties: ['schema:name'] } }],
      },
    },
  },
  bases: [],
  types: [
    { type: 'schema:Book', document: { root: { props: {} }, content: [{ type: 'Cover', props: { id: 'cover' } }] } },
  ],
  routes: [],
};
const reviewSaved: PresentationProfile = {
  ...reviewOriginal,
  generic: {
    root: {
      props: {
        appearance: { density: 'comfortable', surface: 'flat', radius: 'lg', cover: 'portrait', headingScale: 'lg' },
      },
    },
    content: [
      {
        type: 'Stack',
        props: {
          id: 'reading',
          gap: 'md',
          children: [
            {
              type: 'Heading',
              props: {
                id: 'heading',
                level: 2,
                text: { en: 'Your reading room', ja: '読書の部屋', de: 'Dein persönlicher Ort zum Lesen' },
              },
            },
            {
              type: 'Text',
              props: {
                id: 'intro',
                text: {
                  en: 'Notes, editions and conversations for every reader.',
                  fr: 'Notes, éditions et conversations pour toutes les personnes qui lisent.',
                },
              },
            },
          ],
        },
      },
    ],
  },
};

function ReviewScenarioStory({ scenario }: { scenario: 'stale' | 'read-failure' | 'invalid' }) {
  const transport = useMemo((): PublicationTransport => {
    let attempt = 0;
    return {
      publish: async (input) => {
        attempt++;
        if (scenario === 'stale') return { ok: false, reason: 'stale' };
        if (scenario === 'read-failure') return { ok: false, reason: 'unavailable', outcome: 'unknown' };
        if (attempt === 1)
          return {
            ok: false,
            reason: 'invalid',
            errors: [{ pointer: '/generic/views/overview/content/0/props/children/0/props/text/en', code: 'invalid' }],
          };
        return { ok: true, digest: profileDigest(input.profile), head: input.expectedHead + 1 };
      },
      read: async () =>
        scenario === 'read-failure'
          ? { ok: false, reason: 'unavailable' }
          : { ok: true, reader, head: 9, digest: profileDigest(reviewSaved), profile: reviewSaved },
    };
  }, [scenario]);
  return (
    <div className="mx-auto max-w-6xl p-4 sm:p-8">
      <PresentationViewEditor
        initial={{ ok: true, reader, profile: reviewOriginal, head: 7, digest: profileDigest(reviewOriginal) }}
        observedSession={{ state: 'signed-in', subject: reader }}
        locale={getLocale()}
        transport={transport}
      />
    </div>
  );
}

/** Illustrative production composition; authored plays and visual/native verification remain UNRUN. */
export const ReadableComparison: Story = {
  args: { scenario: 'current-head-conflict' },
  render: () => <ReviewScenarioStory scenario="stale" />,
  play: async ({ canvasElement }) => {
    await editDraft(canvasElement);
    const canvas = await submit(canvasElement);
    await expect(await canvas.findByRole('region', { name: m.curation_compare() })).toBeVisible();
    await expect(canvas.getByText('Reading together')).toBeVisible();
    await expect(canvas.getByText('Your reading room')).toBeVisible();
    await expect(canvas.getByText(m.curation_review_discard_help())).toBeVisible();
    await expect(canvas.getByRole('button', { name: m.curation_reconcile() })).toBeEnabled();
    await expect(canvas.getByRole('button', { name: m.curation_discard() })).toBeEnabled();
  },
};
export const InspectionReadFailure: Story = {
  args: { scenario: 'unknown-publish' },
  render: () => <ReviewScenarioStory scenario="read-failure" />,
  play: async ({ canvasElement }) => {
    await editDraft(canvasElement);
    const canvas = await submit(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.curation_reload_head() }));
    await expect(await canvas.findByText(m.curation_review_read_failed())).toBeVisible();
    await expect(canvas.getByText(m.curation_unknown())).toBeVisible();
    await expect(canvas.getByText(m.curation_review_no_active())).toBeVisible();
    await expect(canvas.queryByRole('region', { name: m.curation_compare() })).toBeNull();
    await expect(canvas.queryByRole('button', { name: m.curation_discard() })).toBeNull();
  },
};
export const InvalidReplacement: Story = {
  args: { scenario: 'unknown-publish' },
  render: () => <ReviewScenarioStory scenario="invalid" />,
  play: async ({ canvasElement }) => {
    await editDraft(canvasElement);
    const canvas = await submit(canvasElement);
    await expect(await canvas.findByText(m.curation_invalid())).toBeVisible();
    await expect(canvas.getByText(m.curation_review_replace_help())).toBeVisible();
    await expect(canvas.getByRole('button', { name: m.curation_new_intent() })).toBeDisabled();
    await expect(canvas.queryByRole('button', { name: m.curation_retry_original() })).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: m.curation_correct() }));
  },
};
