import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { readSettingsPage } from '../settings/actions';
import type { SettingsPage } from '../settings/preferences';
import { SettingsPageView } from '../settings/settings-page';
import type { WatchManagementIO } from '../settings/watch-native';
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

/** Illustrative owner responses while the native management binding is unavailable. */
function Preview({ view }: { view: View }) {
  const [page, setPage] = useState<SettingsPage | null>(null);
  const [io] = useState<WatchManagementIO>(() => ({
    read: async () => {
      if (view === 'failed') throw new Error('Illustrative read failure');
      return {
        kind: 'page',
        page: {
          next: null,
          watches:
            view === 'inaccessible'
              ? [{ subscriptionId: 'private-unavailable', kind: 'board', target: null }]
              : [
                  {
                    subscriptionId: 'private-thread',
                    kind: 'thread',
                    target: {
                      title: 'Reading together: autumn discoveries',
                      href: '/threads/preview/reading-together',
                    },
                  },
                  {
                    subscriptionId: 'private-board',
                    kind: 'board',
                    target: { title: 'Books and reading', href: '/boards/preview/books' },
                  },
                ],
        },
      };
    },
    stop: async () => ({ kind: view === 'uncertain' ? 'uncertain' : 'removed' }),
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

function story(view: View, viewport: 'phone390' | 'desktop1280'): Story {
  return {
    globals: { viewport: { value: viewport, isRotated: false } },
    render: () => (
      <PatternStory visitor="Signed In" path="/settings#watches">
        <AppShell>
          <Preview view={view} />
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
        await expect(canvas.getByRole('button', { name: m.settings_watches_retry_original() })).toBeEnabled();
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
export const UncertainUnwatchPhone = story('uncertain', 'phone390');
export const UncertainUnwatchDesktop = story('uncertain', 'desktop1280');
