import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo, useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import recording from '../../kernel/recorded/agent-page.json';
import { profileStoryValues } from '../../kernel/fake/settings-profile';
import { m } from '../../paraglide/messages.js';
import { ProfileCard } from '../../settings/profile';
import type { AvatarResume, AvatarUpload } from '../../settings/ports/content';
import { settingsContent } from '../../settings/adapters/presentation';
import { UploadRefusal } from '../../threads/upload-vocabulary';
import { createBrowserSettingsAmbient } from '../../settings/adapters/ambient';
import { ProfileEditor } from '../../settings/profile-write';
import { rebaseProfile } from '../../settings/profile-write';
import { PageHeading } from '../../shell/page-heading';
import { AppShell } from '../../shell/shell';
import { PatternStory } from '../page';

type Scenario = 'complete' | 'pending' | 'late' | 'failed' | 'save' | 'rejected' | 'rate-limited';
// Reuse the committed native avatar summary and its existing Storybook media assets.
const recorded = recording.reads.r1.body.accounts[0]!.avatar;
const avatar = {
  ...recorded,
  variants: recorded.variants.filter(
    (variant): variant is { format: 'webp'; width: number } => variant.format === 'webp',
  ),
};
const readbacks = new WeakMap<Element, () => void>();
const uploadCounts = new WeakMap<Element, () => { uploads: number; resumes: number }>();

function Example({ scenario = 'complete' }: { scenario?: Scenario }) {
  const [fixture] = useState(() => {
    let current = { ...profileStoryValues(), avatar: scenario === 'late' || scenario === 'pending' ? avatar : null };
    let completeRead = () => {};
    let uploads = 0;
    let resumes = 0;
    const editor = new ProfileEditor(
      {
        ambient: createBrowserSettingsAmbient(),
        read: () =>
          scenario === 'save'
            ? new Promise((resolve) => {
                completeRead = () => resolve(structuredClone(current));
              })
            : Promise.resolve(structuredClone(current)),
        save: async (attempt) => {
          const next = rebaseProfile(attempt.before, attempt.after, current);
          current = { ...next, avatar: next.avatar ? avatar : null };
          return { ok: true, profile: attempt.after };
        },
      },
      current,
    );
    const upload: AvatarUpload = async (_accountId, _file, signal) => {
      uploads++;
      if (scenario === 'pending') return new Promise(() => {});
      if (scenario === 'late')
        return new Promise((resolve) => {
          // An already completed provider response may arrive after local cancellation.
          signal.addEventListener('abort', () => resolve({ src: avatar.media }), { once: true });
        });
      if (scenario === 'failed' || scenario === 'rate-limited' || scenario === 'rejected') {
        const failure = new UploadRefusal(
          scenario === 'failed' ? 'unavailable' : scenario,
          scenario === 'rate-limited' ? 2 : undefined,
        );
        failure.mediaId = avatar.media;
        throw failure;
      }
      return { src: avatar.media };
    };
    const resume: AvatarResume = async (mediaId) => {
      resumes++;
      if (mediaId !== avatar.media) throw new UploadRefusal('unavailable');
      return { src: mediaId };
    };
    return {
      accountId: current.accountId,
      editor,
      upload,
      resume,
      counts: () => ({ uploads, resumes }),
      finishRead: () => completeRead(),
    };
  });
  const content = useMemo(
    () => ({
      ...settingsContent,
      avatar: {
        ...settingsContent.avatar,
        upload: fixture.upload,
        resume: fixture.resume,
        readAdvice: async (_signal: AbortSignal) => ({
          ok: true,
          body: {
            viewerState: 'signed_in',
            viewer: { accountId: fixture.accountId },
            target: { containerId: fixture.accountId, purpose: 'avatar' },
            constraints: {
              mediaTypes: ['image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/webp'],
              maxByteCount: 20_971_520,
            },
            allowedActions: ['upload'],
          },
          responseTime: Date.now(),
        }),
      },
    }),
    [fixture],
  );
  return (
    <PatternStory visitor="Signed In" path="/settings#profile">
      <AppShell>
        <div className="min-w-0 p-6">
          <article className="mx-auto max-w-2xl space-y-8">
            <PageHeading>{m.settings_heading()}</PageHeading>
            <section
              aria-label={m.settings_profile_heading()}
              ref={(element) => {
                if (element) {
                  readbacks.set(element, fixture.finishRead);
                  uploadCounts.set(element, fixture.counts);
                }
              }}
            >
              <ProfileCard editor={fixture.editor} content={content} />
            </section>
          </article>
        </div>
      </AppShell>
    </PatternStory>
  );
}

const meta = {
  title: 'Account/Avatar',
  id: 'patterns-account-avatar',
  component: Example,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'The Settings profile card with owned local previews, upload cancellation and explicit profile Save/readback. Upload and save IO are interface fakes; the confirmed summary comes from the native recording. Web story review and Root screenshot review remain required.',
      },
    },
  },
} satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;

function profile(canvasElement: HTMLElement) {
  const region = within(canvasElement).getByRole('region', { name: m.settings_profile_heading() });
  return { region, view: within(region) };
}
async function choose(canvasElement: HTMLElement) {
  const { view } = profile(canvasElement);
  const group = within(view.getByRole('group', { name: m.settings_profile_avatar() }));
  const button = group.getByRole('button', { name: m.settings_profile_choose_avatar() });
  button.focus();
  await expect(button).toHaveFocus();
  const image = await fetch(`/media/${avatar.media}/webp-160`).then((response) => response.blob());
  await userEvent.upload(
    group.getByLabelText(m.settings_profile_choose_avatar()),
    new File([image], 'image.webp', { type: 'image/webp' }),
  );
  await view.findByText(m.settings_profile_avatar_preview(), { selector: 'p' });
  return view;
}

export const ChooseImage: Story = {
  play: async ({ canvasElement }) => {
    const view = await choose(canvasElement);
    await view.findByText(m.settings_profile_avatar_ready());
    const preview = await view.findByRole('img', { name: m.settings_profile_avatar_preview() });
    await expect(preview.getAttribute('src')).toMatch(/^blob:/);
    await expect(view.getByRole('button', { name: m.settings_profile_save() })).toBeEnabled();
    await expect(view.queryByText(m.settings_saved())).toBeNull();
  },
};
export const UploadPending: Story = {
  args: { scenario: 'pending' },
  play: async ({ canvasElement }) => {
    const view = await choose(canvasElement);
    await view.findByText(m.settings_profile_uploading());
    await expect(view.getByRole('button', { name: m.settings_profile_save() })).toBeDisabled();
    await expect(view.getByRole('button', { name: m.settings_profile_choose_avatar() })).toBeEnabled();
    await expect(view.getByRole('button', { name: m.settings_profile_avatar_cancel() })).toBeEnabled();
    await expect(view.getByRole('textbox', { name: m.settings_profile_biography() })).toBeEnabled();
  },
};
export const CancelLateResponse: Story = {
  args: { scenario: 'late' },
  play: async ({ canvasElement }) => {
    const view = await choose(canvasElement);
    const biography = view.getByRole('textbox', { name: m.settings_profile_biography() });
    await userEvent.clear(biography);
    await userEvent.type(biography, 'Unrelated draft');
    const cancel = view.getByRole('button', { name: m.settings_profile_avatar_cancel() });
    cancel.focus();
    await userEvent.keyboard('{Enter}');
    await view.findByText(m.settings_profile_avatar_cancelled());
    await view.findByText(m.settings_profile_avatar_saved());
    await waitFor(() => expect(view.queryByRole('img', { name: m.settings_profile_avatar_preview() })).toBeNull());
    await expect(biography).toHaveValue('Unrelated draft');
  },
};
export const FailedUploadRetry: Story = {
  args: { scenario: 'failed' },
  play: async ({ canvasElement }) => {
    const view = await choose(canvasElement);
    await view.findByText(m.settings_profile_avatar_error());
    await expect(view.getByRole('button', { name: m.settings_profile_save() })).toBeDisabled();
    const selectedPreview = await view.findByRole('img', { name: m.settings_profile_avatar_preview() });
    const selectedUrl = selectedPreview.getAttribute('src');
    await expect(selectedUrl).toMatch(/^blob:/);
    await userEvent.click(view.getByRole('button', { name: m.settings_profile_avatar_retry() }));
    await view.findByText(m.settings_profile_avatar_ready());
    await expect(view.queryByText(m.settings_profile_avatar_error())).toBeNull();
    const preview = await view.findByRole('img', { name: m.settings_profile_avatar_preview() });
    await expect(preview).toHaveAttribute('src', selectedUrl);
    await expect(preview).toBeVisible();
    await waitFor(() => {
      expect((preview as HTMLImageElement).complete).toBe(true);
      expect((preview as HTMLImageElement).naturalWidth).toBeGreaterThan(0);
    });
    await expect(view.getByRole('button', { name: m.settings_profile_save() })).toBeEnabled();
    await expect(view.queryByText(m.settings_saved())).toBeNull();
    await expect(view.queryByText(m.settings_profile_avatar_saved())).toBeNull();
  },
};
export const ExplicitSaveReadback: Story = {
  args: { scenario: 'save' },
  play: async ({ canvasElement }) => {
    const view = await choose(canvasElement);
    await view.findByText(m.settings_profile_avatar_ready());
    await userEvent.click(view.getByRole('button', { name: m.settings_profile_save() }));
    await view.findByRole('button', { name: m.settings_saving() });
    await expect(view.queryByText(m.settings_profile_avatar_saved())).toBeNull();
    await expect(view.getByRole('button', { name: m.settings_profile_avatar_cancel() })).toBeDisabled();
    readbacks.get(profile(canvasElement).region)!();
    await view.findByText(m.settings_saved());
    await view.findByText(m.settings_profile_avatar_saved());
    await expect(view.queryByRole('img', { name: m.settings_profile_avatar_preview() })).toBeNull();
    await expect(profile(canvasElement).region.querySelector('picture img')).toHaveAttribute(
      'src',
      `/media/${avatar.media}/webp-160`,
    );
    await userEvent.click(view.getByRole('button', { name: m.settings_profile_remove_avatar() }));
    await view.findByText(m.settings_profile_avatar_removal());
    await userEvent.click(view.getByRole('button', { name: m.settings_profile_save() }));
    await view.findByRole('button', { name: m.settings_saving() });
    readbacks.get(profile(canvasElement).region)!();
    await view.findByText(m.settings_profile_avatar_empty());
    await view.findByText(m.settings_saved());
  },
};

export const RejectedImage: Story = {
  args: { scenario: 'rejected' },
  globals: {},
  play: async ({ canvasElement }) => {
    const view = await choose(canvasElement);
    await view.findByText(m.settings_profile_avatar_rejected());
    await expect(view.queryByRole('button', { name: m.settings_profile_avatar_retry() })).toBeNull();
    await expect(view.getByRole('button', { name: m.settings_profile_save() })).toBeDisabled();
    await expect(view.getByRole('button', { name: m.settings_profile_choose_avatar() })).toBeEnabled();
    await expect(uploadCounts.get(profile(canvasElement).region)!()).toEqual({ uploads: 1, resumes: 0 });
    await userEvent.click(view.getByRole('button', { name: m.settings_profile_avatar_cancel() }));
    await view.findByText(m.settings_profile_avatar_cancelled());
    await expect(view.queryByRole('img', { name: m.settings_profile_avatar_preview() })).toBeNull();
  },
};

export const RateLimitedReservation: Story = {
  args: { scenario: 'rate-limited' },
  globals: {},
  play: async ({ canvasElement }) => {
    const view = await choose(canvasElement);
    await view.findByText(m.settings_profile_avatar_rate_limited());
    await view.findByText(m.settings_profile_avatar_retry_after({ seconds: 2 }));
    const retry = view.getByRole('button', { name: m.settings_profile_avatar_retry() });
    await expect(retry).toBeDisabled();
    const preview = await view.findByRole('img', { name: m.settings_profile_avatar_preview() });
    const selectedUrl = preview.getAttribute('src');
    await expect(view.getByRole('button', { name: m.settings_profile_save() })).toBeDisabled();
    await waitFor(() => expect(retry).toBeEnabled());
    await expect(uploadCounts.get(profile(canvasElement).region)!()).toEqual({ uploads: 1, resumes: 0 });
    await expect(view.getByRole('button', { name: m.settings_profile_save() })).toBeDisabled();
    await userEvent.click(retry);
    await view.findByText(m.settings_profile_avatar_ready());
    await expect(uploadCounts.get(profile(canvasElement).region)!()).toEqual({ uploads: 1, resumes: 1 });
    await expect(preview).toHaveAttribute('src', selectedUrl);
    await expect(view.getByRole('button', { name: m.settings_profile_save() })).toBeEnabled();
  },
};
