import type { ZoneTokens } from '@rezics/zone-sdk';
import { direction } from '@rezics/main/language';
import { Button } from '@rezics/ui/button';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useRef, useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import type { ZoneThemeClient } from './api.ts';
import { ZoneThemeEditor } from './theme-editor.tsx';
import { initialThemeState, type ZonePresentationBaseline } from './theme.ts';
import { ZoneEditorFrame } from './frame.tsx';
import { ZoneEditorDraftProvider, useZoneEditorExit } from './draft-provider.tsx';
import { messages } from './messages.ts';
import { messages as manageMessages } from '../manage/messages.ts';
import { fictionModules, fictionZone } from '../zones/fixtures.ts';
import { presetTokens } from '../zones/presentation.ts';
import { RealmPageStory } from '../realm/story-page.tsx';

const zoneId = '00000000-0000-4000-8000-000000000411';
const actor = 'https://rezics.com/id/00000000-0000-4000-8000-000000000412';
const head = 'https://rezics.com/id/00000000-0000-4000-8000-000000000413';
const nextHead = 'https://rezics.com/id/00000000-0000-4000-8000-000000000414';
const agent = { iri: actor, label: 'Harbor editor', handle: null, kind: 'person' as const, path: 'direct-principal' as const };

const baseline: ZonePresentationBaseline = {
  profile: 'zone-presentation-v2',
  preset: 'clean',
  tokens: { ...presetTokens.clean },
  navigation: [{ label: 'Stories', href: '/stories' }],
  slides: [],
  modules: [{ id: 'latest', type: 'shelf', title: 'Latest chapters', source: { kind: 'query-block', block: 'latest-chapters' } }],
};
const opening = {
  format: 'rezics-zone-config-v1',
  zone: `https://rezics.com/id/${zoneId}`,
  navigation: head,
  state: 'active',
  disclosure: 'public',
  presentation: baseline,
  advanced: 'sha256:retained-opaque-configuration',
};

function ThemeWithRenderedExample() {
  const [configuration, setConfiguration] = useState<Record<string, unknown>>(opening);
  const [revision, setRevision] = useState(head);
  const configurationRef = useRef(configuration);
  const revisionRef = useRef(revision);
  configurationRef.current = configuration;
  revisionRef.current = revision;
  const [api] = useState<ZoneThemeClient>(() => ({
    async readConfiguration() {
      return { ok: true, data: { configuration: configurationRef.current, revision: revisionRef.current } };
    },
    async saveConfiguration(_zone, body) {
      const updated = { ...configurationRef.current, presentation: body.presentation };
      configurationRef.current = updated;
      revisionRef.current = nextHead;
      setConfiguration(updated);
      setRevision(nextHead);
      return { ok: true, data: { revision: nextHead, replayed: false } };
    },
  }));
  const [initial] = useState(() => initialThemeState(opening, head));
  const presentation = configuration.presentation as ZonePresentationBaseline;
  const zone = { ...fictionZone('en', presentation.tokens as ZoneTokens), slug: null, realm: null,
    name: { value: 'Harbor notes', lang: 'en', dir: direction('en', 'Harbor notes') } };

  return <ZoneEditorFrame name="Harbor notes" editorPath="/manage/z/harbor" agent={agent} locale="en"
    manageMessages={manageMessages} sectionsLabel={messages.en.sectionsLabel} sectionHome={messages.en.sectionHome}
    sectionNavigation={messages.en.sectionNavigation} sectionRealm={messages.en.sectionRealm} sectionTheme={messages.en.sectionTheme}>
    <div className="grid min-w-0 gap-8">
      <ZoneThemeEditor zoneId={zoneId} actingSubject={actor} copy={messages.en} initial={initial}
        signInHref="/auth/start" api={api} />
      <section aria-label="Rendered example" className="min-w-0 overflow-hidden rounded-xl border border-border/70">
        <RealmPageStory zone={zone} modules={fictionModules('en').slice(0, 8)} locale="en" members="12,408 members" />
      </section>
    </div>
  </ZoneEditorFrame>;
}

function MissingBaseline() {
  return <ZoneEditorFrame name="Harbor notes" editorPath="/manage/z/harbor" agent={agent} locale="en"
    manageMessages={manageMessages} sectionsLabel={messages.en.sectionsLabel} sectionHome={messages.en.sectionHome}
    sectionNavigation={messages.en.sectionNavigation} sectionRealm={messages.en.sectionRealm} sectionTheme={messages.en.sectionTheme}>
    <ZoneThemeEditor zoneId={zoneId} actingSubject={actor} copy={messages.en} initial={{ kind: 'absent' }}
      signInHref="/auth/start" />
  </ZoneEditorFrame>;
}

function NewZoneDefaults() {
  const configuration = { ...opening, presentation: undefined };
  const [api] = useState<ZoneThemeClient>(() => ({
    async readConfiguration() {
      return { ok: true, data: { revision: head, configuration,
        effectivePresentation: { revision: head, presentation: baseline } } };
    },
    async saveConfiguration(_zone, body) {
      await expect(body.expectedHead).toBe(head);
      await expect(body.presentation).toEqual({ ...baseline, tokens: { ...baseline.tokens, density: 'compact', pageSurface: 'cards' } });
      return { ok: true, data: { revision: nextHead, replayed: false } };
    },
  }));
  return <ZoneEditorFrame name="Harbor notes" editorPath="/manage/z/harbor" agent={agent} locale="en"
    manageMessages={manageMessages} sectionsLabel={messages.en.sectionsLabel} sectionHome={messages.en.sectionHome}
    sectionNavigation={messages.en.sectionNavigation} sectionRealm={messages.en.sectionRealm} sectionTheme={messages.en.sectionTheme}>
    <ZoneThemeEditor zoneId={zoneId} actingSubject={actor} copy={messages.en}
      initial={initialThemeState(configuration, head, { revision: head, presentation: baseline })}
      signInHref="/auth/start" api={api} />
  </ZoneEditorFrame>;
}

type ThemeCommandMode = 'delayed' | 'lost-response';
const themeCommandCalls: { key: string; body: Parameters<ZoneThemeClient['saveConfiguration']>[1] }[] = [];
let finishDelayedSave: (() => void) | null = null;

function resetThemeCommands() {
  themeCommandCalls.length = 0;
  finishDelayedSave = null;
  return () => { finishDelayedSave?.(); finishDelayedSave = null; };
}

function ThemeExitControls({ mode, fixtureZoneId }: { mode: ThemeCommandMode; fixtureZoneId: string }) {
  const [previewed, setPreviewed] = useState(false);
  const requestExit = useZoneEditorExit();
  const [initial] = useState(() => initialThemeState({ ...opening, zone: `https://rezics.com/id/${fixtureZoneId}` }, head));
  const [api] = useState<ZoneThemeClient>(() => {
    let attempts = 0;
    return {
      async readConfiguration() { return { ok: true, data: { revision: head, configuration: opening } }; },
      async saveConfiguration(_zone, body, key) {
        attempts += 1;
        themeCommandCalls.push({ key, body });
        if (mode === 'delayed' && attempts === 1) {
          await new Promise<void>(resolve => { finishDelayedSave = resolve; });
        }
        if (mode === 'lost-response' && attempts <= 2) return { ok: false, failure: 'unavailable' };
        return { ok: true, data: { revision: nextHead, replayed: mode === 'lost-response' && attempts === 3 } };
      },
    };
  });
  return <div className="grid min-w-0 gap-5">
    <ZoneThemeEditor zoneId={fixtureZoneId} actingSubject={actor} copy={messages.en} initial={initial}
      signInHref="/auth/start" api={api} />
    <Button variant="outline" size="sm" className="justify-self-start"
      onClick={() => requestExit(() => setPreviewed(true))}>{messages.en.preview}</Button>
    {previewed ? <p role="status" className="text-sm">Saved preview opened</p> : null}
  </div>;
}

function ThemeExitStory({ mode }: { mode: ThemeCommandMode }) {
  const fixtureZoneId = mode === 'delayed'
    ? '00000000-0000-4000-8000-000000000417'
    : '00000000-0000-4000-8000-000000000418';
  return <ZoneEditorDraftProvider zoneId={fixtureZoneId} actingSubject={actor}>
    <ZoneEditorFrame name="Harbor notes" editorPath="/manage/z/harbor" agent={agent} locale="en"
      manageMessages={manageMessages} sectionsLabel={messages.en.sectionsLabel} sectionHome={messages.en.sectionHome}
      sectionNavigation={messages.en.sectionNavigation} sectionRealm={messages.en.sectionRealm} sectionTheme={messages.en.sectionTheme}>
      <ThemeExitControls mode={mode} fixtureZoneId={fixtureZoneId} />
    </ZoneEditorFrame>
  </ZoneEditorDraftProvider>;
}

const meta = {
  title: 'Zone editor/Theme',
  render: () => <ThemeWithRenderedExample />,
  parameters: { route: { pathname: '/en/manage/z/harbor/theme' }, viewport: { defaultViewport: 'responsive' } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/** Saving the controls changes spacing and module panels on supported Zone content. */
export const TokensAffectSupportedModules: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: 'Theme' })).toHaveAttribute('aria-current', 'page');
    await userEvent.click(canvas.getByRole('radio', { name: 'Compact · more items per row' }));
    await userEvent.click(canvas.getByRole('radio', { name: 'In cards' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Save layout' }));
    await expect(canvas.getByText('Layout saved.', { exact: true })).toBeVisible();
    const scope = canvasElement.querySelector<HTMLElement>('.zone-scope');
    await waitFor(() => expect(scope?.style.getPropertyValue('--zone-tiles')).toBe('6'));
    await expect(scope?.style.getPropertyValue('--zone-panel')).toBe('var(--card)');
    const module = scope?.querySelector<HTMLElement>('.zone-module');
    await expect(module).toBeTruthy();
    await expect(Number.parseFloat(getComputedStyle(module!).paddingTop)).toBeGreaterThan(0);
  },
};

export const NoSavedPresentation: Story = {
  render: () => <MissingBaseline />,
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByText('This Zone has no saved presentation', { exact: true })).toBeVisible();
    await expect(within(canvasElement).queryByRole('radio')).toBeNull();
  },
};

export const CreateLayoutFromDefaults: Story = {
  render: () => <NewZoneDefaults />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole('radio')).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: 'Create layout from defaults' }));
    await expect(canvas.getByRole('button', { name: 'Save layout' })).toBeEnabled();
    await userEvent.click(canvas.getByRole('radio', { name: 'Compact · more items per row' }));
    await userEvent.click(canvas.getByRole('radio', { name: 'In cards' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Save layout' }));
    await expect(canvas.getByText('Layout saved.', { exact: true })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Save layout' })).toBeDisabled();
  },
};

/** An exit save waits for the current write to settle instead of dispatching a second command. */
export const DelayedSaveRefusesDuplicateExitCommand: Story = {
  beforeEach: resetThemeCommands,
  render: () => <ThemeExitStory mode="delayed" />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('radio', { name: messages.en.themeCompact }));
    await userEvent.click(canvas.getByRole('button', { name: messages.en.themeSave }));
    await waitFor(() => expect(themeCommandCalls).toHaveLength(1));
    await expect(canvas.getByRole('button', { name: messages.en.themeSaving })).toBeDisabled();
    await userEvent.click(canvas.getByRole('button', { name: messages.en.preview }));
    const dialog = within(await within(document.body).findByRole('dialog'));
    await userEvent.click(dialog.getByRole('button', { name: messages.en.exitSave }));
    await waitFor(() => expect(dialog.getByText(messages.en.exitFailed)).toBeVisible());
    await expect(themeCommandCalls).toHaveLength(1);
    finishDelayedSave!();
    await expect(await canvas.findByText(messages.en.themeSaved, { exact: true })).toBeVisible();
    await userEvent.click(dialog.getByRole('button', { name: messages.en.exitSave }));
    await expect(await canvas.findByText('Saved preview opened', { exact: true })).toBeVisible();
    await expect(themeCommandCalls).toHaveLength(1);
  },
};

/** Reverting visible choices does not discard a lost response's original body or command key. */
export const RevertedChoicesRetainUnresolvedExitCommand: Story = {
  beforeEach: resetThemeCommands,
  render: () => <ThemeExitStory mode="lost-response" />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('radio', { name: messages.en.themeCompact }));
    await userEvent.click(canvas.getByRole('button', { name: messages.en.themeSave }));
    await expect(await canvas.findByText(messages.en.themeUnavailableBody, { exact: true })).toBeVisible();
    await userEvent.click(canvas.getByRole('radio', { name: messages.en.themeComfortable }));
    await expect(canvas.getByRole('button', { name: messages.en.themeSave })).toBeEnabled();
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    await expect(unload.defaultPrevented).toBe(true);
    await userEvent.click(canvas.getByRole('button', { name: messages.en.preview }));
    const dialog = within(await within(document.body).findByRole('dialog'));
    await userEvent.click(dialog.getByRole('button', { name: messages.en.exitSave }));
    await expect(await dialog.findByText(messages.en.exitFailed)).toBeVisible();
    await expect(themeCommandCalls).toHaveLength(3);
    await expect(themeCommandCalls[1]).toEqual(themeCommandCalls[0]);
    await expect(themeCommandCalls[2]).toEqual(themeCommandCalls[0]);
    await userEvent.click(dialog.getByRole('button', { name: messages.en.exitSave }));
    await expect(await canvas.findByText('Saved preview opened', { exact: true })).toBeVisible();
    await expect(themeCommandCalls).toHaveLength(4);
    await expect(themeCommandCalls[3].key).not.toBe(themeCommandCalls[0].key);
    await expect(themeCommandCalls[3].body.expectedHead).toBe(nextHead);
    await expect(themeCommandCalls[3].body.presentation.tokens.density).toBe('comfortable');
    await expect(canvas.getByRole('radio', { name: messages.en.themeComfortable })).toBeChecked();
  },
};
