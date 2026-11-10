import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { m } from '../paraglide/messages.js';
import { SettingsPageView } from '../settings/settings-page';
import { settingsContent } from '../settings/adapters/presentation';
import { AppShell } from '../shell/shell';
import { PageStory, pageReady, PatternStory } from './page';
import { sessionQuery } from '../session/query';
import type { SettingsPage } from '../settings/preferences';
import { readSettingsPage } from '../settings/actions';
import { setFakeVerificationState } from '../kernel/fake/verification';
import { selectSettingsCategory } from './settings-category-navigation';

const meta = {
  title: 'Account/Settings account journey',
  id: 'pages-account-settings-account-journey',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => <PageStory visitor="Signed In" path="/settings" />,
  play: async (context) => {
    await pageReady(context);
    const canvas = within(within(context.canvasElement).getByRole('main'));
    const nav = within(await canvas.findByRole('navigation', { name: m.settings_sections_label() }));
    const link = nav.getByRole('link', { name: m.settings_account_heading() });
    for (const anchor of nav.getAllByRole('link')) {
      await userEvent.click(anchor);
      await expect(anchor).toHaveAttribute('aria-current', 'location');
      await expect(context.canvasElement.querySelector(anchor.getAttribute('href')!)).not.toBeNull();
    }
    await userEvent.click(link);
    const account = within(canvas.getByRole('region', { name: m.settings_account_heading() }));
    await expect(account.getByRole('link', { name: m.account_security_settings() })).toHaveAttribute(
      'href',
      'https://auth.example.test/security',
    );
    await expect(account.getByRole('link', { name: m.settings_account_delete_continue() })).toHaveAttribute(
      'href',
      'https://auth.example.test/account/delete',
    );
    const form = account.getByRole('button', { name: m.account_sign_out() }).closest('form');
    await expect(form).toHaveAttribute('method', 'post');
    await expect(form).toHaveAttribute('action', '/auth/sign-out');
  },
};

export const SignedOut: Story = {
  // Review the fallback view in the ordinary shell; the production /settings route still requires sign-in.
  render: () => (
    <PatternStory visitor="Signed Out" path="/settings">
      <AppShell>
        <SettingsPageView page={{ signedIn: false }} csrfToken={null} content={settingsContent} />
      </AppShell>
    </PatternStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(await within(canvasElement).findByRole('main'));
    await canvas.findByRole('link', { name: m.account_sign_in() });
    await expect(canvas.queryByRole('navigation')).toBeNull();
    await expect(canvas.queryByRole('button', { name: m.account_sign_out() })).toBeNull();
  },
};

function PreferenceTransition() {
  const client = useQueryClient();
  const [page, setPage] = useState<SettingsPage | null>(null);
  const currentPage = useRef(page);
  currentPage.current = page;
  const [transport] = useState(() => ({
    read: async () => currentPage.current ?? readSettingsPage(),
    saveReading: async () => ({ ok: false as const, reason: 'conflict' as const }),
    saveNotifications: async () => ({ ok: false as const, reason: 'conflict' as const }),
  }));
  return (
    <>
      <div role="group" aria-label="Preference transition fixture" className="flex flex-wrap gap-4 p-4">
        <button type="button" onClick={() => void readSettingsPage().then(setPage)}>
          Prepare current viewer
        </button>
        <button
          type="button"
          onClick={() => {
            if (page?.signedIn) setPage({ ...page, accountId: null });
          }}
        >
          Unprepared viewer
        </button>
        <button
          type="button"
          onClick={() => {
            if (page?.signedIn && 'preferences' in page)
              setPage({ ...page, preferences: { ...page.preferences, version: 9 }, csrfToken: 'old-loader-token' });
          }}
        >
          Refresh same viewer
        </button>
        <button
          type="button"
          onClick={() =>
            client.setQueryData(sessionQuery.queryKey, {
              state: 'signed-in',
              subject: 'other-story-viewer',
              csrfToken: 'other-current-token',
            })
          }
        >
          Switch viewer
        </button>
        <button
          type="button"
          onClick={() => {
            if (page?.signedIn && 'preferences' in page)
              setPage({
                ...page,
                accountId: 'other-story-viewer',
                preferences: { spoilerLevel: 0, suitability: 'blur', version: 1 },
                notifications: { reply: false, mention: false },
                renameAccount: null,
              });
          }}
        >
          Prepare next viewer
        </button>
        <button
          type="button"
          onClick={() =>
            client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: null, csrfToken: null })
          }
        >
          Unresolved viewer
        </button>
      </div>
      <AppShell>
        {page ? (
          <SettingsPageView page={page} csrfToken={null} preferenceIO={transport} content={settingsContent} />
        ) : null}
      </AppShell>
    </>
  );
}

const preferenceTransition: Story = {
  render: () => (
    <PatternStory visitor="Signed In" path="/settings">
      <PreferenceTransition />
    </PatternStory>
  ),
  play: async ({ canvasElement }) => {
    const fixture = within(canvasElement);
    await userEvent.click(fixture.getByRole('button', { name: 'Prepare current viewer' }));
    const canvas = within(await fixture.findByRole('main'));
    await canvas.findByRole('region', { name: m.settings_reading_heading() });
    await userEvent.click(fixture.getByRole('button', { name: 'Unprepared viewer' }));
    await waitFor(() => expect(canvas.queryByRole('region', { name: m.settings_reading_heading() })).toBeNull());
    await expect(canvas.queryByRole('region', { name: m.settings_notifications_heading() })).toBeNull();
    await expect(canvasElement.querySelector('[name="csrf_token"]')).toBeNull();
    await expect(canvas.getByText(m.settings_sections_loading())).toBeVisible();
    await expect(canvas.getByRole('region', { name: m.settings_display_heading() })).toBeVisible();
    await userEvent.click(fixture.getByRole('button', { name: 'Prepare current viewer' }));
    const reading = within(await canvas.findByRole('region', { name: m.settings_reading_heading() }));
    await userEvent.click(reading.getByRole('switch', { name: m.settings_suitability_title() }));
    await reading.findByText(m.settings_conflict_title());
    await selectSettingsCategory(canvasElement, m.settings_notifications_heading());
    const notifications = within(canvas.getByRole('region', { name: m.settings_notifications_heading() }));
    await userEvent.click(notifications.getByRole('switch', { name: m.settings_notification_reply() }));
    await notifications.findByText(m.settings_conflict_title());
    const notificationVersionFields = () =>
      canvasElement.querySelectorAll<HTMLInputElement>('#notifications [name="expectedVersion"]');
    await expect(notificationVersionFields().length).toBeGreaterThan(0);
    const notificationBaseline = notificationVersionFields()[0]!.value;
    await userEvent.click(fixture.getByRole('button', { name: 'Refresh same viewer' }));
    await selectSettingsCategory(canvasElement, m.settings_reading_heading());
    await expect(reading.getByRole('switch', { name: m.settings_suitability_title() })).toBeChecked();
    await selectSettingsCategory(canvasElement, m.settings_notifications_heading());
    await expect(notifications.getByRole('switch', { name: m.settings_notification_reply() })).not.toBeChecked();
    await waitFor(() => {
      for (const input of canvasElement.querySelectorAll<HTMLInputElement>('#reading [name="expectedVersion"]'))
        expect(input.value).toBe('9');
    });
    await expect(notificationVersionFields().length).toBeGreaterThan(0);
    for (const input of notificationVersionFields()) await expect(input.value).toBe(notificationBaseline);
    for (const input of canvasElement.querySelectorAll<HTMLInputElement>('[name="csrf_token"]'))
      await expect(input.value).toBe('story-csrf-token');
    // The same-account refresh retains each editor until its explicit recovery action.
    await selectSettingsCategory(canvasElement, m.settings_reading_heading());
    await userEvent.click(reading.getByRole('button', { name: m.settings_reload() }));
    await waitFor(() =>
      expect(reading.getByRole('switch', { name: m.settings_suitability_title() })).not.toBeChecked(),
    );
    await selectSettingsCategory(canvasElement, m.settings_notifications_heading());
    await userEvent.click(notifications.getByRole('button', { name: m.settings_reload() }));
    const useCurrentNotifications = await notifications.findByRole('button', {
      name: m.settings_notifications_use_current(),
    });
    await expect(notificationVersionFields().length).toBeGreaterThan(0);
    for (const input of notificationVersionFields()) await expect(input.value).toBe('9');
    await userEvent.click(useCurrentNotifications);
    await expect(notifications.getByRole('switch', { name: m.settings_notification_reply() })).toBeChecked();
    await selectSettingsCategory(canvasElement, m.settings_reading_heading());
    await userEvent.click(reading.getByRole('switch', { name: m.settings_suitability_title() }));
    await reading.findByText(m.settings_conflict_title());
    await userEvent.click(fixture.getByRole('button', { name: 'Switch viewer' }));
    await waitFor(() => expect(canvas.queryByRole('region', { name: m.settings_reading_heading() })).toBeNull());
    await expect(canvas.queryByRole('region', { name: m.settings_notifications_heading() })).toBeNull();
    await expect(canvasElement.querySelector('[name="expectedVersion"]')).toBeNull();
    await expect(canvasElement.querySelector('[name="csrf_token"]')).toBeNull();
    await userEvent.click(fixture.getByRole('button', { name: 'Prepare next viewer' }));
    const nextReading = within(await canvas.findByRole('region', { name: m.settings_reading_heading() }));
    await expect(nextReading.getByRole('switch', { name: m.settings_suitability_title() })).not.toBeChecked();
    await expect(nextReading.getByRole('radio', { name: m.settings_spoiler_0_title() })).toBeChecked();
    await selectSettingsCategory(canvasElement, m.settings_notifications_heading());
    const nextNotifications = within(canvas.getByRole('region', { name: m.settings_notifications_heading() }));
    await expect(nextNotifications.getByRole('switch', { name: m.settings_notification_mention() })).not.toBeChecked();
    for (const input of canvasElement.querySelectorAll<HTMLInputElement>('[name="expectedVersion"]'))
      await expect(input.value).toBe('1');
    for (const input of canvasElement.querySelectorAll<HTMLInputElement>('[name="csrf_token"]'))
      await expect(input.value).toBe('other-current-token');
    await userEvent.click(fixture.getByRole('button', { name: 'Unresolved viewer' }));
    await waitFor(() => expect(canvas.queryByRole('region', { name: m.settings_reading_heading() })).toBeNull());
    await expect(canvasElement.querySelector('[name="csrf_token"]')).toBeNull();
    await expect(canvas.getByText(m.settings_sections_loading())).toBeVisible();
  },
};

export const PreferenceTransitionJourney: Story = { ...preferenceTransition };

const draftDecision: Story = {
  beforeEach: () => setFakeVerificationState('none'),
  render: () => <PageStory visitor="Signed In" path="/settings?profile=self" />,
  play: async (context) => {
    await pageReady(context);
    const canvas = within(context.canvasElement);
    await selectSettingsCategory(context.canvasElement, m.settings_verification_heading());
    const verification = within(await canvas.findByRole('region', { name: m.settings_verification_heading() }));
    const statement = await verification.findByRole('textbox', { name: m.settings_verification_statement() });
    await userEvent.type(statement, 'Evidence to finish before submitting.');
    await selectSettingsCategory(context.canvasElement, m.settings_privacy_heading());
    const row = (await canvas.findByRole('link', { name: /unusually long Collection title/i })).closest('li')!;
    const visibility = within(row).getByRole('combobox');
    await userEvent.selectOptions(visibility, 'private');
    await within(row).findByText(m.settings_privacy_conflict_title());
    const sections = within(canvas.getByRole('navigation', { name: m.settings_sections_label() }));
    await userEvent.click(sections.getByRole('link', { name: m.settings_account_heading() }));
    await expect(within(document.body).queryByRole('alertdialog')).toBeNull();
    const home = canvas.getByRole('link', { name: 'REZICS' });
    home.focus();
    await userEvent.keyboard('{Enter}');
    const dialog = within(
      await within(document.body).findByRole('alertdialog', { name: m.settings_all_drafts_leave_title() }),
    );
    await expect(within(document.body).getAllByRole('alertdialog')).toHaveLength(1);
    await expect(dialog.getByRole('button', { name: m.settings_profile_stay() })).toHaveFocus();
    await userEvent.click(dialog.getByRole('button', { name: m.settings_profile_stay() }));
    await waitFor(() => expect(home).toHaveFocus());
    await expect(statement).toHaveValue('Evidence to finish before submitting.');
    await expect(visibility).toHaveValue('private');
    // Leave the shared decision visible for the whole-page review.
    await userEvent.keyboard('{Enter}');
    await within(document.body).findByRole('alertdialog', { name: m.settings_all_drafts_leave_title() });
  },
};

export const DraftDecision: Story = { ...draftDecision };

export const LeaveDrafts: Story = {
  ...draftDecision,
  play: async (context) => {
    await draftDecision.play!(context);
    const dialog = within(await within(document.body).findByRole('alertdialog'));
    await userEvent.click(dialog.getByRole('button', { name: m.settings_profile_leave() }));
    await waitFor(() => expect(within(document.body).queryByRole('alertdialog')).toBeNull());
    await waitFor(() =>
      expect(within(context.canvasElement).queryByRole('heading', { level: 1, name: m.settings_heading() })).toBeNull(),
    );
    await expect(
      within(context.canvasElement).queryByRole('textbox', { name: m.settings_verification_statement() }),
    ).toBeNull();
  },
};

export const NoticeDraftDecision: Story = {
  render: preferenceTransition.render!,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Prepare current viewer' }));
    await selectSettingsCategory(canvasElement, m.settings_notifications_heading());
    const notifications = within(await canvas.findByRole('region', { name: m.settings_notifications_heading() }));
    const reply = notifications.getByRole('switch', { name: m.settings_notification_reply() });
    await userEvent.click(reply);
    await notifications.findByText(m.settings_conflict_title());
    const home = canvas.getByRole('link', { name: 'REZICS' });
    home.focus();
    await userEvent.keyboard('{Enter}');
    const dialog = within(
      await within(document.body).findByRole('alertdialog', { name: m.settings_notifications_leave_title() }),
    );
    await userEvent.click(dialog.getByRole('button', { name: m.settings_profile_stay() }));
    await waitFor(() => expect(home).toHaveFocus());
    await expect(reply).not.toBeChecked();
    await userEvent.keyboard('{Enter}');
    await within(document.body).findByRole('alertdialog', { name: m.settings_notifications_leave_title() });
  },
};
