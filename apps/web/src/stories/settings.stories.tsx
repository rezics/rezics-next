import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { requestForStory } from '../../.storybook/react-start';
import settingsPreferencesRecording from '../kernel/recorded/settings-preferences.json';
import { setFakeVerificationState } from '../kernel/fake/verification';
import { m } from '../paraglide/messages.js';
import { SettingsShellProvider } from '../settings';
import { SignedOutSettings } from '../settings/settings-page';
import { boundSettingsShellPort } from '../shell/app-shell';
import { PageHeading } from '../shell/page-heading';
import { PageStory, pageReady } from './page';
import { selectSettingsCategory } from './settings-category-navigation';

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
    <SettingsShellProvider port={boundSettingsShellPort}>
      <main id="main-content" tabIndex={-1} className="min-w-0 p-6 outline-none">
        <div className="mx-auto w-full max-w-5xl">
          <article className="max-w-2xl space-y-8 text-foreground">
            <header>
              <PageHeading>{m.settings_heading()}</PageHeading>
            </header>
            <SignedOutSettings returnTo="/settings" />
          </article>
        </div>
      </main>
    </SettingsShellProvider>
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
  await selectSettingsCategory(context.canvasElement, m.settings_notifications_heading());
  const notificationGroup = await view.findByRole('group', { name: m.settings_notifications_heading() });
  const notificationView = within(notificationGroup);
  const notificationSwitches = await notificationView.findAllByRole('switch');
  const notifications = Object.entries(settingsPreferencesRecording.notifications);
  await expect(notificationSwitches).toHaveLength(notifications.length);
  for (const [index, [kind, checked]] of notifications.entries()) {
    const control = await notificationView.findByRole('switch', { name: notificationName(kind) });
    if (checked) await expect(control).toBeChecked();
    else await expect(control).not.toBeChecked();
    await expect(notificationSwitches[index]).toHaveAccessibleName(notificationName(kind));
  }
  await notificationView.findByText(m.settings_notifications_mandatory());
  await selectSettingsCategory(context.canvasElement, m.settings_account_heading());
  await view.findByRole('button', { name: m.account_sign_out() });
  await selectSettingsCategory(context.canvasElement, m.settings_privacy_heading());
  await view.findByRole('heading', { level: 2, name: m.settings_privacy_heading() });
  const collectionRow = (await view.findByRole('link', { name: 'Books to revisit' })).closest('li');
  if (!collectionRow) throw new Error('Collection row missing');
  await view.findByRole('link', { name: /unusually long Collection title/i });
  await within(collectionRow).findByRole('combobox', { name: m.settings_privacy_visibility_label() });
  await selectSettingsCategory(context.canvasElement, m.settings_profile_heading());
  await view.findByRole('heading', { level: 2, name: m.settings_profile_heading() });
  await view.findByRole('textbox', { name: m.settings_profile_display_name() });
  await view.findByRole('textbox', { name: m.settings_profile_biography() });
  await selectSettingsCategory(context.canvasElement, m.settings_public_activity_heading());
  await view.findByRole('heading', { level: 2, name: m.settings_public_activity_heading() });
  for (const label of [
    m.settings_public_posts(),
    m.settings_public_reviews(),
    m.settings_public_collections(),
    m.settings_public_realms(),
  ])
    await view.findByRole('switch', { name: label });
  await expect(view.queryByRole('switch', { name: m.settings_public_speakers() })).toBeNull();
  if (expectVerification) {
    await selectSettingsCategory(context.canvasElement, m.settings_verification_heading());
    await view.findByRole('heading', { level: 2, name: m.settings_verification_heading() });
  }
  await selectSettingsCategory(context.canvasElement, m.settings_reading_heading());
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

const categoryRequests: { method: string; path: string; key: string | null; body: string }[] = [];

/** One regression runs the generated route and its default Settings composition, including an unresolved save. */
export const FocusedCategories: Story = {
  name: 'Retained category drafts',
  tags: ['!dev'],
  beforeEach: () => {
    categoryRequests.length = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
      if (url.hostname === 'kernel.local') {
        const request = new Request(input instanceof Request ? input : url, init);
        categoryRequests.push({
          method: request.method,
          path: url.pathname,
          key: request.headers.get('idempotency-key'),
          body: request.method === 'GET' ? '' : await request.clone().text(),
        });
      }
      return original(input, init);
    }) as typeof fetch;
    return () => {
      globalThis.fetch = original;
    };
  },
  render: () => <PageStory visitor="Signed In" path="/settings?profile=self&reading-state=lost&from=account#unknown" />,
  play: async (context) => {
    await context.step(
      "Settings shows one selected category and retains the same viewer's drafts and unresolved commands across category navigation",
      async () => {
        await pageReady(context);
        const canvas = within(within(context.canvasElement).getByRole('main'));
        const navigation = within(canvas.getByRole('navigation', { name: m.settings_sections_label() }));
        const selected = async (id: string, label: string) => {
          await waitFor(() => {
            expect(context.canvasElement.querySelectorAll('[data-settings-panel]:not([hidden])')).toHaveLength(1);
            expect(context.canvasElement.querySelector('[data-settings-panel]:not([hidden])')).toHaveAttribute(
              'data-settings-panel',
              id,
            );
            expect(navigation.getAllByRole('link').filter((link) => link.hasAttribute('aria-current'))).toHaveLength(1);
            expect(navigation.getByRole('link', { name: label })).toHaveAttribute('aria-current', 'location');
          });
          const url = new URL(requestForStory().url);
          await expect(url.searchParams.get('from')).toBe('account');
          await expect(url.searchParams.get('profile')).toBe('self');
          await expect(url.searchParams.get('reading-state')).toBe('lost');
        };
        const writes = () => categoryRequests.filter((request) => request.method !== 'GET');
        await selected('reading', m.settings_reading_heading());
        await expect(context.canvasElement.querySelector('[data-settings-panel="profile"]')).toBeNull();
        await expect(categoryRequests.some(({ path }) => /\/profile$|\/collections|verification/.test(path))).toBe(
          false,
        );

        // Keyboard selection focuses the selected heading without a discard decision.
        navigation.getByRole('link', { name: m.settings_profile_heading() }).focus();
        await userEvent.keyboard('{Enter}');
        await selected('profile', m.settings_profile_heading());
        const name = await canvas.findByRole('textbox', { name: m.settings_profile_display_name() });
        await expect(canvas.getByRole('heading', { level: 2, name: m.settings_profile_heading() })).toHaveFocus();
        await userEvent.clear(name);
        await userEvent.type(name, 'Unfinished profile name');
        await expect(writes()).toHaveLength(0);
        const profileReads = categoryRequests.filter(({ path }) => path.endsWith('/profile')).length;

        await selectSettingsCategory(context.canvasElement, m.settings_reading_heading());
        await selected('reading', m.settings_reading_heading());
        await expect(name).not.toBeVisible();
        await userEvent.click(canvas.getByRole('radio', { name: m.settings_spoiler_1_title() }));
        await canvas.findByText(m.settings_reading_uncertain_title());
        await expect(writes()).toHaveLength(1);
        const original = { ...writes()[0]! };
        await expect(original.key).toBeTruthy();

        window.history.back();
        await selected('profile', m.settings_profile_heading());
        await expect(canvas.getByRole('textbox', { name: m.settings_profile_display_name() })).toBe(name);
        await expect(name).toHaveValue('Unfinished profile name');
        await expect(writes()).toEqual([original]);
        await expect(categoryRequests.filter(({ path }) => path.endsWith('/profile'))).toHaveLength(profileReads);
        await expect(within(document.body).queryByRole('alertdialog')).toBeNull();

        window.history.forward();
        await selected('reading', m.settings_reading_heading());
        await canvas.findByText(m.settings_reading_uncertain_title());
        await expect(writes()).toEqual([original]);
        // Only this explicit action replays the exact immutable original; navigation sent nothing.
        await userEvent.click(canvas.getByRole('button', { name: m.settings_reading_retry_original() }));
        await waitFor(() => expect(writes()).toEqual([original, original]));
        await selectSettingsCategory(context.canvasElement, m.settings_profile_heading());
        await expect(name).toHaveValue('Unfinished profile name');
        await expect(writes().filter(({ path }) => !path.endsWith('/preferences'))).toHaveLength(0);
      },
    );
  },
};

export const VerificationPending: Story = {
  name: 'Owner, verification pending',
  render: () => verificationStory('pending'),
  play: async (context) => {
    await settingsReady(context);
    await selectSettingsCategory(context.canvasElement, m.settings_verification_heading());
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
    await selectSettingsCategory(context.canvasElement, m.settings_verification_heading());
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
    await selectSettingsCategory(context.canvasElement, m.settings_verification_heading());
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
    await selectSettingsCategory(context.canvasElement, m.settings_verification_heading());
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
    await selectSettingsCategory(context.canvasElement, m.settings_privacy_heading());
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
    await selectSettingsCategory(context.canvasElement, m.settings_privacy_heading());
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
    await selectSettingsCategory(context.canvasElement, m.settings_display_heading());
    const display = await view.findByRole('region', { name: m.shell_appearance() });
    await expect(display).toBeVisible();
    await expect(
      within(display).getByRole('button', { name: (name) => name.startsWith(m.shell_language()) }),
    ).toBeEnabled();
    await expect(within(display).getByRole('button', { name: m.shell_theme() })).toBeEnabled();
    await expect(view.getByRole('heading', { level: 2, name: m.settings_display_heading() })).toHaveAttribute(
      'id',
      'settings-display-heading',
    );
    await expect(view.getByRole('link', { name: m.settings_display_heading() })).toHaveAttribute('href', '#display');
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

export const NotificationSettingsDependencyUnavailable: Story = {
  name: 'Notification settings dependency unavailable',
  play: (context) => settingsFailureReady(context, '503', m.settings_unavailable_text),
  render: () => <PageStory visitor="Signed In" path="/settings?notification-state=dependency" />,
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
    await expect(await view.findByRole('link', { name: m.account_sign_in() })).toHaveAttribute(
      'href',
      '/auth/sign-in?return_to=%2Fsettings',
    );
    await expect(view.queryByRole('radio')).toBeNull();
    await view.findByRole('heading', { level: 2, name: m.settings_display_heading() });
    const display = await view.findByRole('region', { name: m.shell_appearance() });
    await expect(view.getAllByRole('region', { name: m.shell_appearance() })).toHaveLength(1);
    await expect(
      within(display).getByRole('button', { name: (name) => name.startsWith(m.shell_language()) }),
    ).toBeEnabled();
    await expect(within(display).getByRole('button', { name: m.shell_theme() })).toBeEnabled();
    await expect(view.queryByRole('switch')).toBeNull();
    await expect(view.queryByRole('button', { name: m.account_sign_out() })).toBeNull();
    await expect(context.canvasElement.querySelector('[name="csrf_token"]')).toBeNull();
  },
  render: () => <SignedOutSettingsPreview />,
};

export const PersonProfileWithAvatarAndFiveLinks: Story = {
  name: 'Person, avatar and five links',
  tags: ['!dev'],
  play: async (context) => {
    await settingsReady(context);
    await selectSettingsCategory(context.canvasElement, m.settings_profile_heading());
  },
  render: () => <PageStory visitor="Signed In" path="/settings?profile=extended" />,
};

export const OrganizationProfile: Story = {
  name: 'Organization owner',
  play: async (context) => {
    await pageReady(context);
    const view = within(within(context.canvasElement).getByRole('main'));
    await selectSettingsCategory(context.canvasElement, m.settings_profile_heading());
    await view.findByRole('heading', { level: 2, name: m.settings_profile_heading() });
    await selectSettingsCategory(context.canvasElement, m.settings_public_activity_heading());
    await view.findByRole('switch', { name: m.settings_public_speakers() });
    await selectSettingsCategory(context.canvasElement, m.settings_profile_heading());
  },
  render: () => <PageStory visitor="Signed In" path="/settings?profile=organization" />,
};

export const OrganizationWithAvatarAndFiveLinks: Story = {
  name: 'Organization owner, avatar and five links',
  tags: ['!dev'],
  play: async (context) => {
    await pageReady(context);
    const view = within(within(context.canvasElement).getByRole('main'));
    await selectSettingsCategory(context.canvasElement, m.settings_profile_heading());
    await view.findByRole('heading', { level: 2, name: m.settings_profile_heading() });
    await selectSettingsCategory(context.canvasElement, m.settings_public_activity_heading());
    await view.findByRole('switch', { name: m.settings_public_speakers() });
    await selectSettingsCategory(context.canvasElement, m.settings_profile_heading());
    await expect((await view.findAllByRole('textbox')).length).toBeGreaterThanOrEqual(12);
  },
  render: () => <PageStory visitor="Signed In" path="/settings?profile=organization-extended" />,
};
