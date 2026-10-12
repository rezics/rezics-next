import type { ZoneTokens } from '@rezics/zone-sdk';
import { direction } from '@rezics/main/language';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useRef, useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import type { ZoneThemeClient } from './api.ts';
import { ZoneThemeEditor } from './theme-editor.tsx';
import { initialThemeState, type ZonePresentationBaseline } from './theme.ts';
import { ZoneEditorFrame } from './frame.tsx';
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
      expect(body.expectedHead).toBe(head);
      expect(body.presentation).toEqual({ ...baseline, tokens: { ...baseline.tokens, density: 'compact', pageSurface: 'cards' } });
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
