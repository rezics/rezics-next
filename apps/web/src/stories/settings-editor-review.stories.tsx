import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState, type ComponentProps } from 'react';
import { readingFixture, type ReadingScenario } from '../kernel/fake/settings-preferences-reading';
import { SettingsPageView } from '../settings/settings-page';
import { settingsContent } from '../settings/adapters/presentation';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';

const viewer = 'story-viewer';
const deviceKey = `rezics.editor.device.v1:${viewer}`;
const sessionKey = `rezics.editor.session.v1:${viewer}`;

/** Contract-shaped synthetic account defaults; not a native preference receipt. */
const accountEditor = { writingWidth: 64 } as const;
/** Contract-shaped concurrent account editor used by the next-save conflict fixture. */
const concurrentEditor = { textSize: 24, writingWidth: 68 } as const;

type PreferenceIO = NonNullable<ComponentProps<typeof SettingsPageView>['preferenceIO']>;

function isolateEditorStorage() {
  const stores = [
    { storage: window.localStorage, key: deviceKey },
    { storage: window.sessionStorage, key: sessionKey },
  ].map((entry) => ({ ...entry, previous: entry.storage.getItem(entry.key) }));
  stores.forEach(({ storage, key }) => storage.removeItem(key));
  return () => {
    stores.forEach(({ storage, key, previous }) => {
      if (previous === null) storage.removeItem(key);
      else storage.setItem(key, previous);
    });
  };
}

function reviewFixture(scenario: ReadingScenario = 'default') {
  const preferences = readingFixture(scenario, {
    editor: { ...accountEditor },
    shelf: { gridSize: 'large' },
  });
  const io: PreferenceIO = {
    read: async () => ({ ...(await preferences.io.read()), accountId: viewer }),
    saveReading: (input) => preferences.io.save(input),
    saveNotifications: async () => {
      throw new Error('Editor preferences must not issue a notification command');
    },
  };
  return { preferences, io };
}

function EditorSettingsReview({
  scenario = 'default',
  concurrent = false,
  instruction,
}: {
  scenario?: ReadingScenario;
  concurrent?: boolean;
  instruction?: string;
}) {
  const [bound] = useState(() => {
    const fixture = reviewFixture(scenario);
    if (concurrent) fixture.preferences.concurrent({ editor: { ...concurrentEditor } });
    return fixture;
  });
  const page = {
    signedIn: true as const,
    accountId: viewer,
    preferences: bound.preferences.initial,
    notifications: bound.preferences.current().notifications,
    securityHref: null,
  };
  return (
    <PatternStory visitor="Signed In" path="/settings#display">
      <AppShell>
        {instruction ? <aside role="note">{instruction}</aside> : null}
        <SettingsPageView page={page} csrfToken={null} preferenceIO={bound.io} content={settingsContent} />
      </AppShell>
    </PatternStory>
  );
}

const meta = {
  title: 'Editor/Account settings',
  id: 'pages-editor-account-settings-review',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Ordinary review of the Account Settings editor-preferences region through SettingsPageView and AppShell. Preference payloads are contract-shaped synthetic fixtures, not recorded responses or native acceptance. Account defaults open as loaded. Device/session, save failure and version conflict are manual next-save scenarios. Width and theme stay on the Storybook toolbar.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const AccountDefaults: Story = {
  name: 'Account defaults',
  beforeEach: isolateEditorStorage,
  render: () => <EditorSettingsReview />,
};

export const DeviceAndSessionPreferences: Story = {
  name: 'Device and session preferences',
  beforeEach: isolateEditorStorage,
  render: () => (
    <EditorSettingsReview instruction="Choose This device or This session in Save preferences to, then make a change." />
  ),
};

export const SaveFailureOnNextSave: Story = {
  name: 'Save failure on next save',
  beforeEach: isolateEditorStorage,
  render: () => (
    <EditorSettingsReview
      scenario="lost"
      instruction="Choose Account, change an editor preference and save."
    />
  ),
};

export const VersionConflictOnNextSave: Story = {
  name: 'Version conflict on next save',
  beforeEach: isolateEditorStorage,
  render: () => (
    <EditorSettingsReview
      concurrent
      instruction="Choose Account, change an editor preference and save."
    />
  ),
};
