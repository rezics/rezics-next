import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { readSettingsPage } from '../settings/actions';
import type { SettingsPage } from '../settings/preferences';
import { SettingsPageView } from '../settings/settings-page';
import type { StopWatch, WatchKind, WatchManagementIO } from '../settings/watch-native';
import { m } from '../paraglide/messages.js';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';

type View = 'populated' | 'inaccessible' | 'failed' | 'uncertain';
const meta = {
  title: 'Pages/Account/Settings watches',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/** Connected fixtures illustrate Settings watch states without claiming native or rendered acceptance. */
function Preview({ view, attempts }: { view: View; attempts: StopWatch[] }) {
  const [page, setPage] = useState<SettingsPage | null>(null);
  const [io] = useState<WatchManagementIO>(() => ({
    read: async ({ kind }: { kind: WatchKind }) => {
      if (view === 'failed') throw new Error('Illustrative read failure');
      return {
        kind: 'page',
        page: {
          next: null,
          watches:
            view === 'inaccessible' || view === 'uncertain'
              ? kind === 'thread'
                ? [
                    {
                      subscriptionId: 'private-unavailable',
                      kind,
                      revision: 7,
                      createdAt: '2026-11-03T10:00:00.000Z',
                      target: null,
                    },
                  ]
                : []
              : kind === 'thread'
                ? [
                    {
                      subscriptionId: 'private-thread',
                      kind,
                      revision: 4,
                      createdAt: '2026-11-03T10:00:00.000Z',
                      target: { title: 'Reading together: autumn discoveries', href: '/en/threads/preview' },
                    },
                  ]
                : [
                    {
                      subscriptionId: 'private-board',
                      kind,
                      revision: 5,
                      createdAt: '2026-11-03T10:00:00.000Z',
                      target: { title: 'Books and reading', href: '/en/boards/preview' },
                    },
                  ],
        },
      };
    },
    stop: async (attempt) => {
      attempts.push(attempt);
      return { kind: view === 'uncertain' ? 'uncertain' : 'removed' };
    },
  }));
  useEffect(() => {
    void readSettingsPage().then(setPage);
  }, []);
  return page ? (
    <SettingsPageView page={page} csrfToken={null} watchesIO={io} />
  ) : (
    <p role="status">{m.settings_watches_loading()}</p>
  );
}

function story(view: View, viewport: 'phone390' | 'desktop1280', theme: 'light' | 'dark' = 'light'): Story {
  const attempts: StopWatch[] = [];
  return {
    globals: { viewport: { value: viewport, isRotated: false }, theme },
    render: () => (
      <PatternStory visitor="Signed In" path="/settings#watches">
        <AppShell>
          <Preview view={view} attempts={attempts} />
        </AppShell>
      </PatternStory>
    ),
    play: async ({ canvasElement }) => {
      const canvas = within(canvasElement);
      await canvas.findByRole('heading', { name: m.settings_watches_heading() });
      if (view === 'failed') {
        await canvas.findByText(m.settings_watches_failed_text());
      } else if (view === 'inaccessible') {
        await canvas.findByText(m.settings_watches_access_lost());
        await expect(canvas.getByRole('button', { name: m.settings_watches_stop() })).toBeEnabled();
      } else if (view === 'uncertain') {
        await userEvent.click((await canvas.findAllByRole('button', { name: m.settings_watches_stop() }))[0]!);
        await canvas.findByText(m.settings_watches_uncertain_text());
        const retry = canvas.getByRole('button', { name: m.settings_watches_retry_original() });
        await expect(retry).toBeEnabled();
        await userEvent.click(retry);
        await canvas.findByText(m.settings_watches_uncertain_text());
        await expect(attempts).toHaveLength(2);
        await expect(attempts[1]).toBe(attempts[0]);
      } else {
        await canvas.findByRole('link', { name: 'Reading together: autumn discoveries' });
      }
    },
  };
}

export const PopulatedPhone = story('populated', 'phone390');
export const PopulatedDesktop = story('populated', 'desktop1280');
export const InaccessibleTargetPhone = story('inaccessible', 'phone390');
export const InaccessibleTargetDesktop = story('inaccessible', 'desktop1280');
export const FailedPhone = story('failed', 'phone390');
export const FailedDesktop = story('failed', 'desktop1280');
export const UncertainUnwatchPhoneLight = story('uncertain', 'phone390', 'light');
export const UncertainUnwatchPhoneDark = story('uncertain', 'phone390', 'dark');
export const UncertainUnwatchDesktopLight = story('uncertain', 'desktop1280', 'light');
export const UncertainUnwatchDesktopDark = story('uncertain', 'desktop1280', 'dark');
