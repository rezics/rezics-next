import type { Meta, StoryObj } from '@storybook/react-vite';
import { useLayoutEffect, useRef, useState, type ComponentProps } from 'react';
import { useEditorPreferences } from '../editor/preferences';
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
/** Contract-shaped synthetic device override above those account defaults. */
const deviceEditor = { textSize: 20 } as const;
/** Contract-shaped synthetic session override above the device layer. */
const sessionEditor = { lineSpacing: 1.8 } as const;
/** Contract-shaped concurrent account editor used to present a version conflict. */
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

function seedOverrideStorage() {
  const restore = isolateEditorStorage();
  window.localStorage.setItem(deviceKey, JSON.stringify({ version: 1, preferences: deviceEditor }));
  window.sessionStorage.setItem(sessionKey, JSON.stringify({ version: 1, preferences: sessionEditor }));
  return restore;
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

function SettingsReviewPage({ bound }: { bound: ReturnType<typeof reviewFixture> }) {
  const [page] = useState(() => ({
    signedIn: true as const,
    accountId: viewer,
    preferences: bound.preferences.initial,
    notifications: bound.preferences.current().notifications,
    securityHref: null,
  }));
  return <SettingsPageView page={page} csrfToken={null} preferenceIO={bound.io} content={settingsContent} />;
}

function selectSessionScope(root: HTMLElement) {
  const select = root.querySelector<HTMLSelectElement>(
    '[data-slot="editor-preferences"] [data-slot="native-select"]',
  );
  if (!select) return false;
  if (select.value === 'session') return true;
  select.value = 'session';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  return select.value === 'session';
}

function ImmediateEditorReview({ seedOverrides = false }: { seedOverrides?: boolean }) {
  const [bound] = useState(() => reviewFixture());
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!seedOverrides) return;
    const node = root.current;
    if (!node) return;
    if (selectSessionScope(node)) return;
    const observer = new MutationObserver(() => {
      if (selectSessionScope(node)) observer.disconnect();
    });
    observer.observe(node, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [seedOverrides]);
  return (
    <div ref={root}>
      <SettingsReviewPage bound={bound} />
    </div>
  );
}

function SettledSaveReview({ kind }: { kind: 'error' | 'conflict' }) {
  const [bound] = useState(() => {
    const fixture = reviewFixture(kind === 'error' ? 'lost' : 'default');
    if (kind === 'conflict') fixture.preferences.concurrent({ editor: { ...concurrentEditor } });
    return fixture;
  });
  const binding = useEditorPreferences({
    initial: bound.preferences.initial,
    io: bound.preferences.io,
  });
  const started = useRef(false);
  const target = kind === 'error' ? 'error' : 'conflict';
  const status = binding.preferencesStatus.state;
  const canSaveAccount = binding.preferencesScopes.includes('account');
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    if (status === target) {
      setReady(true);
      return;
    }
    if (started.current || !canSaveAccount) return;
    started.current = true;
    binding.onPreferencesChange({ ...binding.preferencesPanelValue, textSize: 20 });
    binding.onPreferencesRetry();
  }, [binding, canSaveAccount, status, target]);
  return ready ? <SettingsReviewPage bound={bound} /> : null;
}

function review(kind: 'account' | 'overrides' | 'error' | 'conflict') {
  return (
    <PatternStory visitor="Signed In" path="/settings#display">
      <AppShell>
        {kind === 'error' || kind === 'conflict' ? (
          <SettledSaveReview kind={kind} />
        ) : (
          <ImmediateEditorReview seedOverrides={kind === 'overrides'} />
        )}
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
          'Ordinary review of the Account Settings editor-preferences region through SettingsPageView and AppShell. Preference payloads are contract-shaped synthetic fixtures, not recorded responses or native acceptance. Each entry opens in its named state. Width and theme stay on the Storybook toolbar.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const AccountDefaults: Story = {
  name: 'Account defaults',
  beforeEach: isolateEditorStorage,
  render: () => review('account'),
};

export const DeviceSessionOverrides: Story = {
  name: 'Device and session overrides',
  beforeEach: seedOverrideStorage,
  render: () => review('overrides'),
};

export const SaveFailure: Story = {
  name: 'Save failure',
  beforeEach: isolateEditorStorage,
  render: () => review('error'),
};

export const VersionConflict: Story = {
  name: 'Version conflict',
  beforeEach: isolateEditorStorage,
  render: () => review('conflict'),
};
