import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import settingsPreferencesRecording from '../kernel/recorded/settings-preferences.json';
import { m } from '../paraglide/messages.js';
import { PageHeading } from '../shell/page-heading';
import { SignInPrompt } from '../threads/composer';
import { PageStory, pageReady } from './page';

const meta = {
  title: 'Pages/Settings',
  parameters: {
    layout: 'fullscreen',
    viewport: {
      viewports: {
        settingsPhone: { name: 'Settings · 390', styles: { width: '390px', height: '844px' }, type: 'mobile' },
        settingsDesktop: { name: 'Settings · 1280', styles: { width: '1280px', height: '900px' }, type: 'desktop' },
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const levelTitles = [m.settings_spoiler_0_title, m.settings_spoiler_1_title, m.settings_spoiler_2_title] as const;

function SignedOutSettingsPreview() {
  return (
    <main id="main-content" tabIndex={-1} className="min-w-0 p-6 outline-none">
      <div className="mx-auto w-full max-w-5xl">
        <article className="max-w-2xl space-y-8 text-foreground">
          <header>
            <PageHeading>{m.settings_heading()}</PageHeading>
          </header>
          <div className="space-y-3">
            <p className="text-muted-foreground">{m.settings_signed_out()}</p>
            <SignInPrompt returnTo="/settings" />
          </div>
        </article>
      </div>
    </main>
  );
}

function notificationName(kind: string): string {
  if (kind === 'reply') return m.settings_notification_reply();
  if (kind === 'mention') return m.settings_notification_mention();
  return kind
    .split(/[_-]+/)
    .filter(Boolean)
    .map((word) => word[0]!.toLocaleUpperCase() + word.slice(1))
    .join(' ');
}

/** The page shows the recorded level as chosen and the other controls ready to change. */
async function settingsReady(context: { canvasElement: HTMLElement }) {
  await pageReady(context);
  const view = within(within(context.canvasElement).getByRole('main'));
  await view.findByRole('heading', { level: 1, name: m.settings_heading() });
  const chosen = levelTitles[settingsPreferencesRecording.spoilerLevel]!();
  await expect(await view.findByRole('radio', { name: chosen })).toBeChecked();
  await expect(await view.findByRole('switch', { name: m.settings_suitability_title() })).toHaveAttribute(
    'aria-checked',
    settingsPreferencesRecording.suitability === 'show' ? 'true' : 'false',
  );
  const notificationGroup = await view.findByRole('group', { name: m.settings_notifications_heading() });
  const notificationView = within(notificationGroup);
  const notificationSwitches = await notificationView.findAllByRole('switch');
  const notifications = Object.entries(settingsPreferencesRecording.notifications);
  await expect(notificationSwitches).toHaveLength(notifications.length);
  for (const [index, [kind, checked]] of notifications.entries()) {
    const control = await notificationView.findByRole('switch', { name: notificationName(kind) });
    await expect((control as HTMLInputElement).checked).toBe(checked);
    await expect(notificationSwitches[index]).toHaveAccessibleName(notificationName(kind));
  }
  await notificationView.findByText(m.settings_notifications_mandatory());
  await view.findByRole('button', { name: m.account_sign_out() });
  await view.findByRole('heading', { level: 2, name: m.settings_privacy_heading() });
  await view.findByRole('link', { name: 'Books to revisit' });
  await view.findByRole('link', { name: /unusually long Collection title/i });
  await view.findByRole('combobox', { name: m.settings_privacy_visibility_label() });
  await view.findByRole('heading', { level: 2, name: m.settings_profile_heading() });
  await view.findByRole('textbox', { name: m.settings_profile_display_name() });
  await view.findByRole('textbox', { name: m.settings_profile_biography() });
  await view.findByRole('heading', { level: 2, name: m.settings_public_activity_heading() });
  for (const label of [
    m.settings_public_posts(),
    m.settings_public_reviews(),
    m.settings_public_collections(),
    m.settings_public_realms(),
  ])
    await view.findByRole('switch', { name: label });
  await expect(view.queryByRole('switch', { name: m.settings_public_speakers() })).toBeNull();
}

export const SignedIn: Story = {
  name: 'Signed In · 1280',
  parameters: { viewport: { defaultViewport: 'settingsDesktop' } },
  play: settingsReady,
  render: () => <PageStory visitor="Signed In" path="/settings" />,
};

export const Phone: Story = {
  name: 'Phone · 390',
  parameters: { viewport: { defaultViewport: 'settingsPhone' } },
  play: settingsReady,
  render: () => <PageStory visitor="Signed In" path="/settings" />,
};

export const StaleVisibility: Story = {
  name: 'Stale visibility · 390',
  parameters: { viewport: { defaultViewport: 'settingsPhone' } },
  play: async (context) => {
    await settingsReady(context);
    const view = within(within(context.canvasElement).getByRole('main'));
    const link = view.getByRole('link', { name: /unusually long Collection title/i });
    const row = link.closest('li');
    if (!row) throw new Error('Collection row missing');
    const select = within(row).getByRole('combobox');
    await userEvent.selectOptions(select, 'private');
    await view.findByText(m.settings_privacy_conflict_text());
    await view.findByRole('button', { name: m.settings_privacy_reload_row() });
    await expect(select).toHaveValue('public');
  },
  render: () => <PageStory visitor="Signed In" path="/settings" />,
};

export const StaleVisibilityDesktop: Story = {
  name: 'Stale visibility · 1280',
  parameters: { viewport: { defaultViewport: 'settingsDesktop' } },
  play: async (context) => {
    await settingsReady(context);
    const view = within(within(context.canvasElement).getByRole('main'));
    const link = view.getByRole('link', { name: /unusually long Collection title/i });
    const row = link.closest('li');
    if (!row) throw new Error('Collection row missing');
    const select = within(row).getByRole('combobox');
    await userEvent.selectOptions(select, 'private');
    await view.findByText(m.settings_privacy_conflict_text());
    await view.findByRole('button', { name: m.settings_privacy_reload_row() });
    await expect(select).toHaveValue('public');
  },
  render: () => <PageStory visitor="Signed In" path="/settings" />,
};

export const SavedVisibility: Story = {
  name: 'Saved visibility',
  parameters: { viewport: { defaultViewport: 'settingsDesktop' } },
  play: async (context) => {
    await settingsReady(context);
    const view = within(within(context.canvasElement).getByRole('main'));
    const firstRow = view.getByRole('link', { name: 'Books to revisit' }).closest('li');
    if (!firstRow) throw new Error('Collection row missing');
    const select = within(firstRow).getByRole('combobox');
    await userEvent.selectOptions(select, 'unlisted');
    await expect(select).toHaveValue('unlisted');
    await view.findByText(m.settings_privacy_unlisted_text());
  },
  render: () => <PageStory visitor="Signed In" path="/settings" />,
};

export const CollectionsClosed: Story = {
  name: 'Collections closed',
  parameters: { admitted: ['personal_library', 'reading_progress'] },
  play: async (context) => {
    await pageReady(context);
    const view = within(within(context.canvasElement).getByRole('main'));
    await view.findByRole('heading', { level: 1, name: m.settings_heading() });
    await expect(view.queryByRole('heading', { level: 2, name: m.settings_privacy_heading() })).toBeNull();
    await expect(view.queryByRole('link', { name: m.settings_privacy_heading() })).toBeNull();
  },
  render: () => <PageStory visitor="Signed In" path="/settings" />,
};

export const SignedOut: Story = {
  name: 'Signed Out',
  play: async (context) => {
    await pageReady(context);
    const view = within(within(context.canvasElement).getByRole('main'));
    await view.findByRole('heading', { level: 1, name: m.settings_heading() });
    await view.findByRole('link', { name: m.account_sign_in() });
    await expect(view.queryByRole('radio')).toBeNull();
  },
  render: () => <SignedOutSettingsPreview />,
};

export const PersonProfileWithAvatarAndFiveLinks: Story = {
  name: 'Person / Long Biography / Avatar / Five Links',
  play: settingsReady,
  render: () => <PageStory visitor="Signed In" path="/settings?profile=extended" />,
};

export const OrganizationProfile: Story = {
  name: 'Organization / Speakers Listed',
  play: async (context) => {
    await pageReady(context);
    const view = within(within(context.canvasElement).getByRole('main'));
    await view.findByRole('heading', { level: 2, name: m.settings_profile_heading() });
    await view.findByRole('switch', { name: m.settings_public_speakers() });
  },
  render: () => <PageStory visitor="Signed In" path="/settings?profile=organization" />,
};

export const OrganizationWithAvatarAndFiveLinks: Story = {
  name: 'Organization / Long Biography / Avatar / Five Links',
  play: async (context) => {
    await pageReady(context);
    const view = within(within(context.canvasElement).getByRole('main'));
    await view.findByRole('heading', { level: 2, name: m.settings_profile_heading() });
    await view.findByRole('switch', { name: m.settings_public_speakers() });
    await expect((await view.findAllByRole('textbox')).length).toBeGreaterThanOrEqual(12);
  },
  render: () => <PageStory visitor="Signed In" path="/settings?profile=organization-extended" />,
};
