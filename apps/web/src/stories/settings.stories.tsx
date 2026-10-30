import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import settingsPreferencesRecording from '../kernel/recorded/settings-preferences.json';
import { setFakeVerificationState } from '../kernel/fake/verification';
import { m } from '../paraglide/messages.js';
import { PageHeading } from '../shell/page-heading';
import { SignInPrompt } from '../threads/composer';
import { PageStory, pageReady } from './page';

const meta = {
  title: 'Pages/Account/Settings',
  parameters: {
    layout: 'fullscreen',
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
async function settingsReady(context: { canvasElement: HTMLElement }, expectVerification = true) {
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
  if (expectVerification) await view.findByRole('heading', { level: 2, name: m.settings_verification_heading() });
}

function verificationStory(state: 'none' | 'pending' | 'approved' | 'rejected') {
  setFakeVerificationState(state);
  return <PageStory visitor="Signed In" path="/settings" />;
}

export const SignedIn: Story = {
  name: 'Owner',
  play: settingsReady,
  render: () => verificationStory('none'),
};

export const VerificationPending: Story = {
  name: 'Owner, verification pending',
  render: () => verificationStory('pending'),
  play: async (context) => {
    await settingsReady(context);
    await within(within(context.canvasElement).getByRole('main')).findByText(
      m.settings_verification_pending({ subject: 'Haruka Aizawa' }),
    );
  },
};

export const VerificationApproved: Story = {
  name: 'Owner, verification approved',
  render: () => verificationStory('approved'),
  play: async (context) => {
    await settingsReady(context);
    await within(within(context.canvasElement).getByRole('main')).findByRole('link', {
      name: m.settings_verification_view_agent(),
    });
  },
};

export const VerificationRejected: Story = {
  name: 'Owner, verification rejected',
  render: () => verificationStory('rejected'),
  play: async (context) => {
    await settingsReady(context);
    await within(within(context.canvasElement).getByRole('main')).findByText(
      m.settings_verification_rejected({ reason: 'The evidence did not establish account ownership.' }),
    );
  },
};

export const VerificationRequestFiveLinks: Story = {
  name: 'Owner, verification request with five links',
  tags: ['!dev'],
  render: () => verificationStory('none'),
  play: async (context) => {
    await settingsReady(context);
    const view = within(within(context.canvasElement).getByRole('main'));
    for (let index = 0; index < 4; index += 1)
      await view.findByRole('button', { name: m.settings_verification_add_link() }).then((button) => button.click());
    await expect(view.getAllByLabelText(m.settings_verification_link_label())).toHaveLength(5);
  },
};

export const VerificationGateClosed: Story = {
  name: 'Owner, verification unavailable',
  tags: ['!dev'],
  parameters: { admitted: ['collections'] },
  render: () => verificationStory('none'),
  play: async (context) => {
    await settingsReady(context, false);
    await expect(
      within(within(context.canvasElement).getByRole('main')).queryByRole('heading', {
        level: 2,
        name: m.settings_verification_heading(),
      }),
    ).toBeNull();
  },
};

export const StaleVisibility: Story = {
  name: 'Owner, visibility conflict',
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
  name: 'Owner, visibility saved',
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
  name: 'Owner, Collections closed',
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

async function settingsFailureReady(context: { canvasElement: HTMLElement }, status: string, message: () => string) {
  await pageReady(context);
  const view = within(within(context.canvasElement).getByRole('main'));
  const alert = await view.findByRole('alert');
  await expect(alert).toHaveAttribute('data-response-status', status);
  await view.findByText(message());
  await view.findByRole('button', { name: m.settings_retry() });
}

export const NotificationSettingsPreparing: Story = {
  name: 'Notification settings preparing',
  play: (context) => settingsFailureReady(context, '503', m.settings_preparing_text),
  render: () => <PageStory visitor="Signed In" path="/settings?notification-state=preparing" />,
};

export const NotificationSettingsClosed: Story = {
  name: 'Notification settings closed',
  play: async (context) => {
    await settingsFailureReady(context, '403', m.settings_closed_text);
    const alert = within(within(context.canvasElement).getByRole('main')).getByRole('alert');
    await expect(alert).toHaveAttribute('data-response-code', 'platform_closed');
  },
  render: () => <PageStory visitor="Signed In" path="/settings?notification-state=closed" />,
};

export const NotificationSettingsUnavailable: Story = {
  name: 'Notification settings unavailable',
  play: (context) => settingsFailureReady(context, '500', m.settings_unavailable_text),
  render: () => <PageStory visitor="Signed In" path="/settings?notification-state=unavailable" />,
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
  name: 'Person, avatar and five links',
  tags: ['!dev'],
  play: settingsReady,
  render: () => <PageStory visitor="Signed In" path="/settings?profile=extended" />,
};

export const OrganizationProfile: Story = {
  name: 'Organization owner',
  play: async (context) => {
    await pageReady(context);
    const view = within(within(context.canvasElement).getByRole('main'));
    await view.findByRole('heading', { level: 2, name: m.settings_profile_heading() });
    await view.findByRole('switch', { name: m.settings_public_speakers() });
  },
  render: () => <PageStory visitor="Signed In" path="/settings?profile=organization" />,
};

export const OrganizationWithAvatarAndFiveLinks: Story = {
  name: 'Organization owner, avatar and five links',
  tags: ['!dev'],
  play: async (context) => {
    await pageReady(context);
    const view = within(within(context.canvasElement).getByRole('main'));
    await view.findByRole('heading', { level: 2, name: m.settings_profile_heading() });
    await view.findByRole('switch', { name: m.settings_public_speakers() });
    await expect((await view.findAllByRole('textbox')).length).toBeGreaterThanOrEqual(12);
  },
  render: () => <PageStory visitor="Signed In" path="/settings?profile=organization-extended" />,
};
