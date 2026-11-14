import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import { PageStory, pageReady } from './page';
import { selectSettingsCategory } from './settings-category-navigation';

const avatarMediaId = '0192f3a0-6c1e-7b2a-9d4e-000000000071';
let uploadStarted: Promise<void> = Promise.resolve();
let announceUpload = () => {};
let releaseUpload = () => {};
let uploadGate: Promise<void> = Promise.resolve();
let uploadedBytes: Blob | undefined;

const meta = {
  title: 'Account/Avatar keyboard',
  id: 'pages-settings-avatar-keyboard',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'The actual Settings route and providers with an explicit delayed /media transport fixture. This story illustrates keyboard focus continuity; it does not establish native upload authority or acceptance.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj;

async function imageFixture() {
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 200;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not create the avatar fixture');
  context.fillStyle = '#326c91';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#f4cf49';
  context.fillRect(200, 120, 70, 60);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (result) => (result ? resolve(result) : reject(new Error('Could not encode the avatar fixture'))),
      'image/png',
    ),
  );
  return new File([blob], 'avatar-fixture.png', { type: 'image/png' });
}

export const KeyboardJourney: Story = {
  render: () => <PageStory visitor="Signed In" path="/settings#reading" />,
  beforeEach: () => {
    let announceStarted!: () => void;
    uploadStarted = new Promise((resolve) => (announceStarted = resolve));
    announceUpload = announceStarted;
    let release!: () => void;
    uploadGate = new Promise((resolve) => (release = resolve));
    releaseUpload = release;
    uploadedBytes = undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.origin === window.location.origin && url.pathname === '/media' && request.method === 'POST') {
        const body = (await request.clone().json()) as Record<string, unknown>;
        return Response.json({
          media: {
            id: avatarMediaId,
            state: 'reserved',
            mediaType: body.mediaType,
            byteCount: body.byteCount,
          },
        });
      }
      if (url.origin === window.location.origin && url.pathname === `/media/${avatarMediaId}`) {
        if (request.method === 'PUT') {
          uploadedBytes = await request.clone().blob();
          announceUpload();
          await uploadGate;
          return new Response(null, { status: 204 });
        }
        if (request.method === 'GET')
          return Response.json({
            media: {
              id: avatarMediaId,
              state: 'available',
              mediaType: uploadedBytes?.type ?? 'image/png',
              byteCount: uploadedBytes?.size ?? 0,
            },
          });
      }
      return originalFetch(request);
    }) as typeof fetch;
    return () => {
      releaseUpload();
      globalThis.fetch = originalFetch;
    };
  },
  play: async (story) => {
    await pageReady(story);
    await selectSettingsCategory(story.canvasElement, m.settings_profile_heading());
    const profile = within(
      await within(story.canvasElement).findByRole('region', { name: m.settings_profile_heading() }),
    );
    const avatar = within(profile.getByRole('group', { name: m.settings_profile_avatar() }));
    const biography = profile.getByRole('textbox', { name: m.settings_profile_biography() });
    await userEvent.upload(avatar.getByLabelText(m.settings_profile_choose_avatar()), await imageFixture());
    const crop = within(await avatar.findByRole('region', { name: m.settings_profile_crop_heading() }));
    const useOriginal = crop.getByRole('button', { name: m.settings_profile_crop_use_original() });
    useOriginal.focus();
    await userEvent.keyboard('{Enter}');
    await uploadStarted;
    const cancel = avatar.getByRole('button', { name: m.settings_profile_avatar_cancel() });
    await expect(cancel).toHaveFocus();

    await userEvent.tab({ shift: true });
    await userEvent.tab({ shift: true });
    await expect(biography).toHaveFocus();
    await userEvent.keyboard('{End} keyboard continuation');
    releaseUpload();
    await profile.findByText(m.settings_profile_avatar_ready());
    await expect(biography).toHaveFocus();
    await expect((biography as HTMLTextAreaElement).value).toContain('keyboard continuation');
  },
};
