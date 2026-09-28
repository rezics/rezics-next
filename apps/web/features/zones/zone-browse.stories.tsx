import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import mods from '../../zones/official/mods/index.tsx';
import { RealmPageStory } from '../realm/story-page.tsx';
import { ZoneBrowse } from './browse.tsx';
import { browseHref, toggled, toggledExcludedConcept } from './browse-state.ts';
import { zoneMessagesFor } from './fixtures.ts';
import { type ModRelease, ModSections } from './mod-sections.tsx';
import { officialBrowseModel, officialZone } from './official-fixtures.ts';
import { cardRenderer } from './zone-home.tsx';

/** The Mods browse page as `RealmBrowseRoute` renders it, through the Mods package's rows. */
function Browse({ params, locale }: { params: Record<string, string | string[]>; locale: UiLocale }) {
  const zone = officialZone('mods', locale);
  const messages = zoneMessagesFor(locale);
  return <RealmPageStory zone={zone} pkg={mods} execution={{ mode: 'package', slug: 'mods' }} locale={locale}>
    <ZoneBrowse model={officialBrowseModel('mods', locale, params)} messages={messages}
      card={cardRenderer(zone, mods, locale, messages)} />
  </RealmPageStory>;
}

const meta = {
  title: 'Zones/Browse',
  component: Browse,
  args: { params: { loader: 'fabric', version: '1.21.1' }, locale: 'en' },
  parameters: { route: { pathname: '/en/r/mods/browse' } },
  render: (args, { globals }) => <Browse {...args} locale={(globals.locale as UiLocale | undefined) ?? args.locale} />,
} satisfies Meta<typeof Browse>;
export default meta;
type Story = StoryObj<typeof meta>;

const phone = { viewport: { value: 'phone' } };
const fits = async () => expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);

/** Fabric mods for 1.21.1: the chosen values are removable chips, and every Facet counts with the others applied. */
export const FabricOn1211: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('status')).toHaveTextContent('2 results');
    const results = canvas.getAllByRole('article');
    await expect(results.map(result => within(result).getByRole('heading', { level: 3 }).textContent))
      .toEqual(['Lumen Lanterns', 'Tidy Inventory']);
    await expect(canvas.getByRole('link', { name: 'Remove filter: Fabric' })).toHaveAttribute('href',
      '/en/r/mods/browse?version=1.21.1');
    await expect(canvas.getByRole('link', { name: 'Clear all filters' })).toHaveAttribute('href', '/en/r/mods/browse');
    const loaders = canvas.getByRole('region', { name: 'Loader' });
    await expect(within(loaders).getByRole('link', { name: /Fabric \(selected\)/ })).toHaveAttribute('aria-current', 'true');
    await expect(within(loaders).getByRole('link', { name: /Forge/ })).toHaveAttribute('href',
      '/en/r/mods/browse?version=1.21.1&loader=forge');
    await expect(canvas.getByRole('navigation', { name: 'Sort by' })).toBeVisible();
    await expect(canvas.getByText('REZICS doesn’t count downloads.')).toBeVisible();
    await fits();
  },
};

export const Grid: Story = { args: { params: { view: 'grid' } },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('link', { name: 'Grid' })).toHaveAttribute('aria-current', 'true');
    await fits();
  } };

export const Searching: Story = { args: { params: { q: 'lan' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('searchbox', { name: 'Search Mods' })).toHaveValue('lan');
    await expect(canvas.getByRole('link', { name: 'Relevance' })).toHaveAttribute('aria-current', 'true');
  } };

export const NothingMatches: Story = { args: { params: { loader: 'neoforge', env: 'server' } },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('heading', { name: 'Nothing matches these filters' })).toBeVisible();
  } };

export const Dark: Story = { globals: { theme: 'dark' }, play: fits };

export const PhoneChinese: Story = { globals: { ...phone, locale: 'zh-Hans' },
  parameters: { route: { pathname: '/zh-Hans/r/mods/browse' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('region', { name: '先选择模组的运行环境' })).toBeVisible();
    await expect(canvas.getByRole('status')).toHaveTextContent('2 个结果');
    await fits();
  } };

/** One Work with two loaders: the selected file and its outward dependencies change together. */
function ExactBrowse({ locale, forge }: { locale: UiLocale; forge: boolean }) {
  const zone = officialZone('mods', locale), messages = zoneMessagesFor(locale);
  const params = forge ? { version: '1.20.1', loader: 'forge', env: 'client' }
    : { version: '1.21.1', loader: 'fabric', env: 'client' };
  const model = officialBrowseModel('mods', locale, params);
  const work = officialBrowseModel('mods', locale).items.find(item => item.title?.value === 'Lumen Lanterns')!;
  const selected = { version: forge ? '1.4.0' : '2.0.0-beta.1',
    gameVersions: [forge ? '1.20.1' : '1.21.1'], loaders: [forge ? 'Forge' : 'Fabric'],
    environment: 'client' as const, side: 'client' as const,
    publishedAt: new Date(Date.now() - (forge ? 30 : 1) * 86_400_000).toISOString(),
    channel: forge ? 'release' as const : 'beta' as const,
    dependencies: [{ id: forge ? 'forge-config-api' : 'fabric-api', requirement: 'required' as const,
      range: null, side: null }], state: forge ? 'stale' as const : 'compatible' as const };
  const exact = { ...work, tagline: { value: 'Warm lantern light for your Minecraft world.', lang: 'en',
    dir: 'ltr' as const }, mod: { ...work.mod!, gameVersions: ['1.21.1', '1.20.1'],
    loaders: ['Fabric', 'Forge'], selected } };
  const shown = { ...model, items: [exact], results: '1 result',
    groups: [...model.groups.map(group => ({ ...group, values: group.values.map(value => ({ ...value,
      count: value.chosen ? 1 : 0 })) })),
    { facet: 'modRequiredDependency' as const, label: messages.facetRequiredDependency,
      values: [{ value: selected.dependencies[0]!.id,
        label: { value: selected.dependencies[0]!.id, lang: '', dir: 'ltr' as const }, count: 1, chosen: false,
        href: browseHref(model.action, toggled(model.state, 'modRequiredDependency', selected.dependencies[0]!.id)) }] },
    { facet: 'concept' as const, label: messages.facetConcept,
      values: [{ value: 'https://rezics.com/id/0192f3a4-5b6c-7d8e-9f01-23456789abcd',
        label: { value: 'Minecraft', lang: 'en', dir: 'ltr' as const }, count: 1, chosen: false, excluded: false,
        href: browseHref(model.action, toggled(model.state, 'concept',
          'https://rezics.com/id/0192f3a4-5b6c-7d8e-9f01-23456789abcd')),
        excludeHref: browseHref(model.action, toggledExcludedConcept(model.state,
          'https://rezics.com/id/0192f3a4-5b6c-7d8e-9f01-23456789abcd')) }] }] };
  return <RealmPageStory zone={zone} pkg={mods} execution={{ mode: 'package', slug: 'mods' }} locale={locale}>
    <ZoneBrowse model={shown} messages={messages} card={cardRenderer(zone, mods, locale, messages)} />
  </RealmPageStory>;
}

export const ForgeOn1201Exact: Story = { render: (_, { globals }) => <ExactBrowse
  locale={(globals.locale as UiLocale | undefined) ?? 'en'} forge />,
async play({ canvasElement }) {
  const card = within(canvasElement).getByRole('article');
  await expect(card.querySelector('[data-release-state]')).toHaveAttribute('data-release-state', 'stale');
  await expect(card).toHaveTextContent('1.4.0');
  await expect(card).toHaveTextContent('forge-config-api');
  await expect(card).not.toHaveTextContent('fabric-api');
  await expect(canvasElement.querySelector('#facet-modRequiredDependency')).toBeInTheDocument();
  await expect(canvasElement.querySelector('a[aria-label="Exclude: Minecraft"]')).toHaveAttribute('href',
    '/en/r/mods/browse?version=1.20.1&loader=forge&env=client&exclude=0192f3a4-5b6c-7d8e-9f01-23456789abcd');
} };

export const FabricBetaOn1211Exact: Story = { render: (_, { globals }) => <ExactBrowse
  locale={(globals.locale as UiLocale | undefined) ?? 'en'} forge={false} />,
async play({ canvasElement }) {
  const card = within(canvasElement).getByRole('article');
  await expect(card.querySelector('[data-release-state]')).toHaveAttribute('data-release-state', 'compatible');
  await expect(card).toHaveTextContent('2.0.0-beta.1');
  await expect(card).toHaveTextContent('fabric-api');
  await expect(card).not.toHaveTextContent('forge-config-api');
} };

const day = 86_400_000;
const releases: ModRelease[] = [
  { profile: 'mod-release-v1', mod: { id: 'lumenlanterns', ecosystem: 'fabric' }, version: '1.3.0',
    channel: 'release',
    game: 'Minecraft', gameVersions: ['1.21.1'], loaders: ['Fabric'], environment: 'client',
    dependencies: [{ id: 'fabric-api', requirement: 'required', range: '>=0.100.0', side: 'client' },
      { id: 'modmenu', requirement: 'optional', range: null, side: null },
      { id: 'optifabric', requirement: 'incompatible', range: null, side: null }],
    changelog: 'Lanterns glow warmer at night.\nFixes flicker next to water.',
    capturedAt: new Date(Date.now() - 2 * day).toISOString(), publishedAt: new Date(Date.now() - day).toISOString() },
  { profile: 'mod-release-v1', mod: { id: 'lumenlanterns', ecosystem: 'fabric' }, version: '1.2.0',
    channel: 'release',
    game: 'Minecraft', gameVersions: ['1.20.1'], loaders: ['Fabric'], environment: 'client', dependencies: [],
    changelog: null, capturedAt: new Date(Date.now() - 60 * day).toISOString(),
    publishedAt: new Date(Date.now() - 60 * day).toISOString() },
  // Listed before REZICS showed dependencies and environments: those stay unknown, never empty.
  { profile: 'mod-release-v1', mod: null, version: '1.1.0', game: 'Minecraft', gameVersions: ['1.19.4'],
    channel: 'release',
    loaders: ['Fabric'], environment: null, dependencies: null, changelog: null,
    capturedAt: new Date(Date.now() - 400 * day).toISOString(), publishedAt: new Date(Date.now() - 400 * day).toISOString() },
];

/** A mod's detail sections on its Work page: compatibility, what the newest release needs, versions and notes. */
export const ModDetail: StoryObj<typeof ModSections> = {
  render: (_, { globals }) => {
    const locale = (globals.locale as UiLocale | undefined) ?? 'en';
    return <div className="mx-auto max-w-3xl p-6"><ModSections releases={releases} locale={locale}
      messages={zoneMessagesFor(locale)} selection={{ gameVersion: '1.21.1', loader: 'Fabric', side: 'client' }}
      exact={{ profile: 'mod-exact-compatibility-v1', state: 'compatible',
        release: { version: '1.3.0', channel: 'release', publishedAt: releases[0]!.publishedAt,
          dependencies: releases[0]!.dependencies } }} /></div>;
  },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const compatibility = canvas.getByRole('region', { name: 'Compatibility' });
    for (const value of ['1.21.1', '1.20.1', '1.19.4', 'Fabric', 'Client']) {
      await expect(within(compatibility).getByText(value)).toBeVisible();
    }
    const dependencies = canvas.getByRole('region', { name: 'Dependencies' });
    await expect(within(dependencies).getByText('fabric-api')).toBeVisible();
    await expect(within(dependencies).getByText('Version >=0.100.0 · Client only')).toBeVisible();
    await expect(within(dependencies).getByText('Incompatible')).toBeVisible();
    await expect(within(dependencies).getByText('For 1.3.0 on Minecraft 1.21.1 Fabric')).toBeVisible();
    await expect(within(canvas.getByRole('region', { name: 'Versions' })).getAllByRole('row')).toHaveLength(4);
    await expect(within(canvas.getByRole('region', { name: 'Changelog' })).getByText(/Fixes flicker/)).toBeVisible();
  },
};

export const ModDetailLegacyChinesePhone: StoryObj<typeof ModSections> = {
  globals: { ...phone, locale: 'zh-Hans' },
  render: (_, { globals }) => <div className="p-4"><ModSections releases={releases.slice(2)}
    locale={(globals.locale as UiLocale | undefined) ?? 'zh-Hans'}
    messages={zoneMessagesFor((globals.locale as UiLocale | undefined) ?? 'zh-Hans')}
    selection={{ gameVersion: '1.19.4', loader: 'Fabric', side: 'client' }}
    exact={{ profile: 'mod-exact-compatibility-v1', state: 'compatible',
      release: { version: '1.1.0', channel: 'release', publishedAt: releases[2]!.publishedAt,
        dependencies: null } }} /></div>,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('这个版本在 REZICS 显示依赖之前发布。')).toBeVisible();
    await expect(canvas.getByText('这个版本没有更新说明。')).toBeVisible();
    await fits();
  },
};
