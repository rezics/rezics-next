import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { env } from '../../.storybook/cloudflare-workers';
import { setStoryRequestContext } from '../../.storybook/react-start';
import { m } from '../paraglide/messages.js';
import { localizeUrl } from '../paraglide/runtime.js';
import { sessionQuery } from '../session/query';
import { retrySettingsSession, SettingsPageView } from '../settings/settings-page';
import { settingsContent } from '../settings/adapters/presentation';
import type { SettingsPage } from '../settings/preferences';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';
import { selectSettingsCategory } from './settings-category-navigation';

const storyPath = '/settings?managedAccount=invalid&source=email';
const localizedStoryUrl = () => localizeUrl(new URL(storyPath, 'https://rezics.local')).href;

const meta = {
  title: 'Pages/Account/Settings recovery',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'The actual SettingsPageView in AppShell. Its Storybook session read moves from unavailable through a held retry to the signed-in page. The local recovery fixture records preference reads and writes; this illustrative journey does not establish native session or browser acceptance.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

type SettingsRecoveryJourney = {
  ready: boolean;
  sessionReads: number;
  enterUnavailable(): void;
  releaseRetry(): void;
  showReadingRetryAvailable(): void;
  showNotificationsUnavailable(): void;
  joinPendingRetry(): void;
  preferenceReads(): number;
  writes(): number;
};

let activeJourney: SettingsRecoveryJourney | undefined;

function unavailableReadingPage(retryAfter?: string): SettingsPage {
  return {
    signedIn: true,
    accountId: 'story-viewer',
    state: 'unavailable',
    failure: {
      status: 503,
      code: 'dependency_unavailable',
      ...(retryAfter ? { retryAfter } : {}),
    },
    securityHref: null,
  };
}

function notificationsUnavailablePage(): SettingsPage {
  return {
    signedIn: true,
    accountId: 'story-viewer',
    preferences: { spoilerLevel: 0, suitability: 'show', version: 1 },
    securityHref: null,
  };
}

function SettingsRecoveryComposition() {
  const client = useQueryClient();
  const [page, setPage] = useState<SettingsPage>(() => unavailableReadingPage('60'));
  const pageRef = useRef(page);
  pageRef.current = page;
  const counts = useRef({ reads: 0, writes: 0 });
  const [preferenceIO] = useState(() => ({
    read: async () => {
      counts.current.reads++;
      return pageRef.current;
    },
    saveReading: async () => {
      counts.current.writes++;
      return { ok: false as const, reason: 'forbidden' as const };
    },
    saveNotifications: async () => {
      counts.current.writes++;
      return { ok: false as const, reason: 'forbidden' as const };
    },
  }));

  useEffect(() => {
    const journey = activeJourney;
    if (!journey) return;
    journey.ready = true;
    journey.enterUnavailable = () =>
      client.setQueryData(sessionQuery.queryKey, { state: 'unavailable', csrfToken: null, subject: null });
    journey.showReadingRetryAvailable = () => setPage(unavailableReadingPage());
    journey.showNotificationsUnavailable = () => setPage(notificationsUnavailablePage());
    journey.joinPendingRetry = () => {
      void retrySettingsSession(client, async () => {});
    };
    journey.preferenceReads = () => counts.current.reads;
    journey.writes = () => counts.current.writes;
    return () => {
      journey.enterUnavailable = () => {};
      journey.ready = false;
      journey.showReadingRetryAvailable = () => {};
      journey.showNotificationsUnavailable = () => {};
      journey.joinPendingRetry = () => {};
      journey.preferenceReads = () => 0;
      journey.writes = () => 0;
    };
  }, [client]);

  return (
    <AppShell>
      <SettingsPageView page={page} csrfToken={null} preferenceIO={preferenceIO} content={settingsContent} />
    </AppShell>
  );
}

/** Holds this story's existing session stub; production session and settings transports stay intact. */
function SessionTransportExample() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const sessions = env.SESSIONS as unknown as {
      get(id: unknown): { signedIn(): Promise<unknown> };
    };
    const original = sessions.get;
    let releaseHeldRead = () => {};
    const journey: SettingsRecoveryJourney = {
      ready: false,
      sessionReads: 0,
      enterUnavailable: () => {},
      releaseRetry: () => {},
      showReadingRetryAvailable: () => {},
      showNotificationsUnavailable: () => {},
      joinPendingRetry: () => {},
      preferenceReads: () => 0,
      writes: () => 0,
    };
    activeJourney = journey;
    sessions.get = (id) => {
      const existing = original.call(sessions, id);
      return {
        ...existing,
        signedIn: async () => {
          journey.sessionReads++;
          await new Promise<void>((resolve) => {
            releaseHeldRead = resolve;
            journey.releaseRetry = resolve;
          });
          return { signedIn: true, subject: 'story-viewer', csrfToken: 'story-csrf-token' };
        },
      };
    };
    setReady(true);
    return () => {
      sessions.get = original;
      releaseHeldRead();
      if (activeJourney === journey) activeJourney = undefined;
    };
  }, []);

  return ready ? <SettingsRecoveryComposition /> : null;
}

function SettingsRecoveryStory() {
  return (
    <PatternStory visitor="Signed Out" path={storyPath}>
      <SessionTransportExample />
    </PatternStory>
  );
}

function expectPhoneTarget(target: HTMLElement, boundary: HTMLElement) {
  const rect = target.getBoundingClientRect();
  const bounds = boundary.getBoundingClientRect();
  const style = getComputedStyle(target);
  expect(rect.height).toBeGreaterThanOrEqual(44);
  expect(rect.width).toBeGreaterThanOrEqual(44);
  expect(rect.left).toBeGreaterThanOrEqual(bounds.left - 1);
  expect(rect.right).toBeLessThanOrEqual(bounds.right + 1);
  expect(rect.right).toBeLessThanOrEqual(390 + 1);
  expect(style.maxWidth).not.toBe('none');
  expect(style.whiteSpace).toBe('normal');
  expect(target.scrollWidth).toBeLessThanOrEqual(target.clientWidth + 1);
  expect(target).toHaveClass('min-h-11', 'max-w-full', 'whitespace-normal');
  return rect;
}

export const UnavailableToSignedInRecovery: Story = {
  name: 'Unavailable to signed-in recovery',
  tags: ['!dev'],
  globals: { viewport: { value: 'phone390', isRotated: false } },
  render: () => <SettingsRecoveryStory />,
  play: async ({ canvasElement }) => {
    const main = within(await within(canvasElement).findByRole('main'));
    await main.findByRole('link', { name: m.account_sign_in() });
    const journey = activeJourney;
    if (!journey) throw new Error('Settings recovery session transport was not installed');
    await waitFor(() => expect(journey.ready).toBe(true));

    journey.enterUnavailable();
    const status = await main.findByRole('status');
    await within(status).findByText(m.settings_session_unavailable());
    const sessionRetry = main.getByRole('button', { name: m.settings_retry() });
    const sessionBounds = expectPhoneTarget(sessionRetry, main.getByRole('article'));
    expect(sessionBounds.top - status.getBoundingClientRect().bottom).toBeGreaterThanOrEqual(12);
    const back = main.getByRole('link', { name: m.managed_back() });
    const backBounds = expectPhoneTarget(back, main.getByRole('article'));
    expect(backBounds.top).toBeGreaterThanOrEqual(0);
    const expectedBack = localizeUrl(new URL('/settings?source=email#account', 'https://rezics.local'));
    await expect(back).toHaveAttribute('href', `${expectedBack.pathname}${expectedBack.search}${expectedBack.hash}`);
    back.focus();
    await expect(back).toHaveFocus();
    await main.findByRole('heading', { name: m.settings_display_heading() });
    await expect(journey.sessionReads).toBe(0);
    await expect(journey.preferenceReads()).toBe(0);
    await expect(journey.writes()).toBe(0);

    setStoryRequestContext({ visitor: 'Signed In', url: localizedStoryUrl() });
    sessionRetry.focus();
    await expect(sessionRetry).toHaveFocus();
    await userEvent.click(sessionRetry);
    await waitFor(() => expect(journey.sessionReads).toBe(1));
    await waitFor(() => expect(sessionRetry).toBeDisabled());
    await expect(status).toHaveAttribute('aria-busy', 'true');
    expectPhoneTarget(sessionRetry, main.getByRole('article'));
    journey.joinPendingRetry();
    await expect(journey.sessionReads).toBe(1);
    await expect(journey.preferenceReads()).toBe(0);
    await expect(journey.writes()).toBe(0);
    journey.releaseRetry();

    await main.findByRole('navigation', { name: m.settings_sections_label() });
    await waitFor(() => expect(main.queryByText(m.settings_session_unavailable())).toBeNull());
    await expect(journey.sessionReads).toBe(1);
    await expect(journey.preferenceReads()).toBe(0);
    await expect(journey.writes()).toBe(0);

    await selectSettingsCategory(canvasElement, m.settings_reading_heading());
    const reading = within(await main.findByRole('region', { name: m.settings_reading_heading() }));
    const readingRetry = reading.getByRole('button', { name: m.settings_retry() });
    const readingBounds = expectPhoneTarget(readingRetry, main.getByRole('article'));
    await expect(readingRetry).toBeDisabled();
    const readingMessage = reading.getByText(m.settings_unavailable_text());
    expect(readingBounds.top - readingMessage.getBoundingClientRect().bottom).toBeGreaterThanOrEqual(12);

    journey.showReadingRetryAvailable();
    await waitFor(() => expect(readingRetry).toBeEnabled());
    expectPhoneTarget(readingRetry, main.getByRole('article'));
    await userEvent.click(readingRetry);
    await expect(journey.writes()).toBe(0);
    await expect(journey.preferenceReads()).toBe(0);

    journey.showNotificationsUnavailable();
    await selectSettingsCategory(canvasElement, m.settings_notifications_heading());
    const notifications = within(await main.findByRole('region', { name: m.settings_notifications_heading() }));
    const notificationsRetry = notifications.getByRole('button', { name: m.settings_retry() });
    const notificationsBounds = expectPhoneTarget(notificationsRetry, main.getByRole('article'));
    const notificationMessage = notifications.getByText(m.settings_unavailable_text());
    expect(notificationsBounds.top - notificationMessage.getBoundingClientRect().bottom).toBeGreaterThanOrEqual(12);
    await expect(notificationsRetry).toBeEnabled();
    await userEvent.click(notificationsRetry);
    await expect(journey.writes()).toBe(0);
  },
};
