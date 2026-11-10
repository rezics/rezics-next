import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import { storyViewerId } from '../kernel/fake/identities';
import { PageStory, pageReady } from './page';

type PreviewTraffic = {
  patches: { path: string; body: unknown; key: string | null }[];
  editableReads: number;
  publicReads: number;
};

const traffic: PreviewTraffic = { patches: [], editableReads: 0, publicReads: 0 };

function captureProfilePreviewTraffic() {
  traffic.patches = [];
  traffic.editableReads = 0;
  traffic.publicReads = 0;
  const original = globalThis.fetch;
  let denyEditableRead = false;

  globalThis.fetch = (async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    if (url.origin !== 'http://kernel.local') return original(input, init);

    const request = new Request(input, init);
    const editableProfile = /^\/v1\/accounts\/[^/]+\/profile$/.test(url.pathname);
    if (request.method === 'GET' && editableProfile) {
      traffic.editableReads++;
      if (denyEditableRead) {
        return Response.json(
          {
            type: 'https://rezics.com/problems/forbidden',
            title: 'Forbidden',
            status: 403,
            code: 'forbidden',
            detail: '',
            request_id: 'profile-preview-authority-loss',
            retryable: false,
          },
          { status: 403 },
        );
      }
    } else if (request.method === 'GET' && url.pathname.startsWith('/v1/accounts') && !editableProfile) {
      traffic.publicReads++;
    }

    if (request.method === 'PATCH' && /^\/v1\/accounts\/[^/]+$/.test(url.pathname)) {
      traffic.patches.push({
        path: url.pathname,
        body: await request.clone().json(),
        key: request.headers.get('idempotency-key'),
      });
      const response = await original(request);
      if (response.ok) denyEditableRead = true;
      return response;
    }
    return original(request);
  }) as typeof fetch;

  return () => {
    globalThis.fetch = original;
  };
}

const meta = {
  title: 'Account/Profile Page',
  id: 'pages-settings-profile',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const draftName = '世界各地の読者と翻訳者が記録を共有する読書コミュニティ'.repeat(7);
const draftBiography =
  'Readers and translators share notes across languages.\n世界各地の読書記録と翻訳を共有します。\nLong-form notes stay readable on a phone.';
const draftLabel = '閱讀紀錄與翻譯社群';
const draftUrl = `https://example.test/reading-notes/${'record'.repeat(70)}`;
const savedName = 'Avery Reader';
const savedBiography = 'I collect thoughtful stories and share notes about what I read.';

/** Actual settings route and providers, recording kernel API traffic around the inline preview journey. */
export const DraftPreview: Story = {
  name: 'Draft preview',
  tags: ['!dev'],
  globals: {},
  beforeEach: captureProfilePreviewTraffic,
  render: () => <PageStory visitor="Signed In" path="/settings?profile=self#profile" />,
  play: async (context) => {
    await context.step(
      'Preview current local profile fields, save through the existing command, then retire the preview after read authority is lost',
      async () => {
        await pageReady(context);
        const canvas = within(context.canvasElement);
        const profile = within(await canvas.findByRole('region', { name: m.settings_profile_heading() }));
        const name = await profile.findByRole('textbox', { name: m.settings_profile_display_name() });
        const biography = profile.getByRole('textbox', { name: m.settings_profile_biography() });
        const initialPublicReads = traffic.publicReads;
        const initialEditableReads = traffic.editableReads;

        await userEvent.clear(name);
        await userEvent.type(name, draftName);
        await userEvent.clear(biography);
        await userEvent.type(biography, draftBiography);
        const linkLabel = profile.getByRole('textbox', { name: m.settings_profile_link_label() });
        await userEvent.clear(linkLabel);
        await userEvent.type(linkLabel, draftLabel);
        const linkUrl = profile.getByRole('textbox', { name: m.settings_profile_link_url() });
        await userEvent.clear(linkUrl);
        await userEvent.type(linkUrl, draftUrl);

        await expect(profile.getByText(m.settings_profile_unsaved())).toBeVisible();
        await expect(traffic.patches).toHaveLength(0);
        await expect(traffic.publicReads).toBe(initialPublicReads);
        await expect(traffic.editableReads).toBe(initialEditableReads);

        const toggle = profile.getByRole('button', { name: m.settings_profile_preview_open() });
        toggle.focus();
        await userEvent.keyboard('{Enter}');
        await expect(toggle).toHaveAttribute('aria-expanded', 'true');
        await expect(toggle).toHaveFocus();

        const previewRegion = await profile.findByRole('region', { name: m.settings_profile_preview_heading() });
        const preview = within(previewRegion);
        await expect(preview.getByRole('heading', { level: 4, name: draftName })).toBeVisible();
        await expect(preview.getByText(draftBiography, { exact: true })).toBeVisible();
        await expect(preview.getByRole('link', { name: draftLabel })).toHaveAttribute('href', draftUrl);
        await expect(preview.getByText(draftUrl, { exact: true })).toBeVisible();
        await expect(preview.getByText(m.settings_profile_preview_draft())).toBeVisible();
        await expect(preview.queryByText(savedName)).toBeNull();
        await expect(preview.queryByText(savedBiography)).toBeNull();
        await expect(traffic.patches).toHaveLength(0);
        await expect(traffic.publicReads).toBe(initialPublicReads);
        await expect(traffic.editableReads).toBe(initialEditableReads);

        await expect(previewRegion.scrollWidth).toBeLessThanOrEqual(previewRegion.clientWidth);
        const urlLine = preview.getByText(draftUrl, { exact: true });
        await expect(urlLine.scrollWidth).toBeLessThanOrEqual(urlLine.clientWidth);

        await userEvent.keyboard(' ');
        await expect(toggle).toHaveAttribute('aria-expanded', 'false');
        await expect(profile.queryByRole('region', { name: m.settings_profile_preview_heading() })).toBeNull();
        await userEvent.keyboard('{Enter}');
        await expect(toggle).toHaveAttribute('aria-expanded', 'true');
        const reopened = within(await profile.findByRole('region', { name: m.settings_profile_preview_heading() }));
        await expect(reopened.getByRole('heading', { level: 4, name: draftName })).toBeVisible();
        await expect(reopened.getByText(draftBiography, { exact: true })).toBeVisible();
        await expect(reopened.getByRole('link', { name: draftLabel })).toBeVisible();
        await expect(traffic.patches).toHaveLength(0);
        await expect(traffic.publicReads).toBe(initialPublicReads);
        await expect(traffic.editableReads).toBe(initialEditableReads);

        await userEvent.click(profile.getByRole('button', { name: m.settings_profile_save() }));
        await profile.findByText(m.settings_profile_read_denied());
        await waitFor(() =>
          expect(profile.queryByRole('region', { name: m.settings_profile_preview_heading() })).toBeNull(),
        );
        await expect(profile.queryByText(draftName)).toBeNull();
        await expect(profile.queryByText(draftBiography)).toBeNull();
        await expect(traffic.patches).toHaveLength(1);
        await expect(traffic.patches[0]).toEqual({
          path: `/v1/accounts/${storyViewerId}`,
          body: { displayName: draftName, biography: draftBiography, links: [{ label: draftLabel, url: draftUrl }] },
          key: expect.any(String),
        });
        const idempotencyKey = JSON.parse(traffic.patches[0]!.key!);
        await expect(idempotencyKey).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        );
        await expect(traffic.editableReads).toBe(initialEditableReads + 1);
        await expect(traffic.publicReads).toBe(initialPublicReads);
      },
    );
  },
};
