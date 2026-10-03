import { spaceHref } from '../address/path.ts';
import { localizedPath } from '../../i18n/locale.ts';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import mods from '../../zones/official/mods/index.tsx';
import { RealmPageStory } from '../realm/story-page.tsx';
import { browseModel } from './browse-view.ts';
import { parseBrowseState } from './browse-state.ts';
import { ZoneBrowse } from './browse.tsx';
import { zoneMessagesFor } from './fixtures.ts';
import { type ModRelease, ModSections } from './mod-sections.tsx';
import { officialBrowseModel, officialZone } from './official-fixtures.ts';
import { cardRenderer } from './zone-home.tsx';

/** The Mods browse page as `RealmBrowseRoute` renders it, through the Mods package's rows. */
function Browse({
  params,
  locale,
}: {
  params: Record<string, string | string[]>;
  locale: UiLocale;
}) {
  const zone = officialZone('mods', locale);
  const messages = zoneMessagesFor(locale);
  return (
    <RealmPageStory
      zone={zone}
      pkg={mods}
      execution={{ mode: 'package', slug: 'mods' }}
      locale={locale}
    >
      <ZoneBrowse
        model={officialBrowseModel('mods', locale, params)}
        messages={messages}
        card={cardRenderer(zone, mods, locale, messages)}
      />
    </RealmPageStory>
  );
}

const meta = {
  title: 'Zones/Browse',
  component: Browse,
  args: { params: { status: 'ongoing' }, locale: 'en' },
  parameters: { route: { pathname: localizedPath(spaceHref('mods', 'site', ['browse']), 'en') } },
  render: (args, { globals }) => (
    <Browse {...args} locale={(globals.locale as UiLocale | undefined) ?? args.locale} />
  ),
} satisfies Meta<typeof Browse>;
export default meta;
type Story = StoryObj<typeof meta>;

const phone = { viewport: { value: 'phone' } };
const fits = async () =>
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);

/** Ongoing Works: the chosen status is a removable chip, and the other Facets stay beside the results. */
export const Ongoing: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('status')).toHaveTextContent('6 results');
    await expect(canvas.getByRole('link', { name: 'Remove filter: Ongoing' })).toHaveAttribute(
      'href',
      localizedPath(spaceHref('mods', 'site', ['browse']), 'en'),
    );
    await expect(canvas.getByRole('link', { name: 'Clear all filters' })).toHaveAttribute(
      'href',
      localizedPath(spaceHref('mods', 'site', ['browse']), 'en'),
    );
    const status = canvas.getByRole('region', { name: 'Status' });
    await expect(
      within(status).getByRole('link', { name: /Ongoing \(selected\)/ }),
    ).toHaveAttribute('aria-current', 'true');
    await expect(within(status).getByRole('link', { name: /On hiatus/ })).toHaveAttribute(
      'href',
      localizedPath(`${spaceHref('mods', 'site', ['browse'])}?status=ongoing&status=hiatus`, 'en'),
    );
    await expect(canvas.queryByRole('region', { name: 'Loader' })).toBeNull();
    await expect(canvas.queryByText('Minecraft')).toBeNull();
    await expect(canvas.getByRole('navigation', { name: 'Sort by' })).toBeVisible();
    await fits();
  },
};

export const Grid: Story = {
  args: { params: { view: 'grid' } },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('link', { name: 'Grid' })).toHaveAttribute(
      'aria-current',
      'true',
    );
    await fits();
  },
};

export const Searching: Story = {
  args: { params: { q: 'lan' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('searchbox', { name: 'Search Mods' })).toHaveValue('lan');
    await expect(canvas.getByRole('link', { name: 'Relevance' })).toHaveAttribute(
      'aria-current',
      'true',
    );
  },
};

export const NothingMatches: Story = {
  args: { params: { length: '0-99999' } },
  async play({ canvasElement }) {
    await expect(
      within(canvasElement).getByRole('heading', { name: 'Nothing matches these filters' }),
    ).toBeVisible();
  },
};

/** A lower-bound count can finish this page while the adoption projection catches up. */
export const ProjectionCatchingUp: Story = {
  render: (_, { globals }) => {
    const locale = (globals.locale as UiLocale | undefined) ?? 'en';
    const zone = officialZone('mods', locale),
      messages = zoneMessagesFor(locale);
    const model = browseModel({
      base: localizedPath(spaceHref('mods', 'site', ['browse']), locale),
      zoneName: zone.name.value,
      state: parseBrowseState({}),
      admitted: new Map(),
      locale,
      messages,
      page: {
        items: officialBrowseModel('mods', locale).items,
        facets: { type: [], concept: [], status: [], length: [] },
        matches: { value: 10, kind: 'lower-bound' },
        window: { scanned: 64, complete: false },
        tags: 'current',
        nextCursor: null,
        sort: 'newest',
      },
    });
    return (
      <RealmPageStory
        zone={zone}
        pkg={mods}
        execution={{ mode: 'package', slug: 'mods' }}
        locale={locale}
      >
        <ZoneBrowse
          model={model}
          messages={messages}
          card={cardRenderer(zone, mods, locale, messages)}
        />
      </RealmPageStory>
    );
  },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('status')).toHaveTextContent('10+ results');
    await expect(canvas.queryByText(/newest picks/)).toBeNull();
    await fits();
  },
};

export const Dark: Story = { globals: { theme: 'dark' }, play: fits };

export const PhoneChinese: Story = {
  globals: { ...phone, locale: 'zh-Hans' },
  parameters: {
    route: { pathname: localizedPath(spaceHref('mods', 'site', ['browse']), 'zh-Hans') },
  },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('筛选（1）')).toBeVisible();
    await expect(canvas.getByRole('status')).toHaveTextContent('6 个结果');
    await fits();
  },
};

const day = 86_400_000;
const releases: ModRelease[] = [
  {
    profile: 'mod-release-v1',
    mod: { id: 'lumenlanterns', ecosystem: 'fabric' },
    version: '1.3.0',
    channel: 'release',
    game: 'Minecraft',
    gameVersions: ['1.21.1'],
    loaders: ['Fabric'],
    environment: 'client',
    dependencies: [
      { id: 'fabric-api', requirement: 'required', range: '>=0.100.0', side: 'client' },
      { id: 'modmenu', requirement: 'optional', range: null, side: null },
      { id: 'optifabric', requirement: 'incompatible', range: null, side: null },
    ],
    changelog: 'Lanterns glow warmer at night.\nFixes flicker next to water.',
    capturedAt: new Date(Date.now() - 2 * day).toISOString(),
    publishedAt: new Date(Date.now() - day).toISOString(),
  },
  {
    profile: 'mod-release-v1',
    mod: { id: 'lumenlanterns', ecosystem: 'fabric' },
    version: '1.2.0',
    channel: 'release',
    game: 'Minecraft',
    gameVersions: ['1.20.1'],
    loaders: ['Fabric'],
    environment: 'client',
    dependencies: [],
    changelog: null,
    capturedAt: new Date(Date.now() - 60 * day).toISOString(),
    publishedAt: new Date(Date.now() - 60 * day).toISOString(),
  },
  // Listed before REZICS showed dependencies and environments: those stay unknown, never empty.
  {
    profile: 'mod-release-v1',
    mod: null,
    version: '1.1.0',
    game: 'Minecraft',
    gameVersions: ['1.19.4'],
    channel: 'release',
    loaders: ['Fabric'],
    environment: null,
    dependencies: null,
    changelog: null,
    capturedAt: new Date(Date.now() - 400 * day).toISOString(),
    publishedAt: new Date(Date.now() - 400 * day).toISOString(),
  },
];

/** A mod's release list on its Work page: versions and the notes their authors wrote. */
export const ModDetail: StoryObj<typeof ModSections> = {
  render: (_, { globals }) => {
    const locale = (globals.locale as UiLocale | undefined) ?? 'en';
    return (
      <div className="mx-auto max-w-3xl p-6">
        <ModSections releases={releases} locale={locale} messages={zoneMessagesFor(locale)} />
      </div>
    );
  },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const versions = canvas.getByRole('region', { name: 'Versions' });
    await expect(within(versions).getAllByRole('row')).toHaveLength(4);
    await expect(within(versions).getByText('1.3.0')).toBeVisible();
    await expect(within(versions).getAllByText('Fabric').length).toBeGreaterThan(0);
    await expect(canvas.queryByRole('region', { name: 'Compatibility' })).toBeNull();
    await expect(canvas.getByRole('region', { name: 'Changelog' })).toHaveTextContent(
      /Fixes flicker/,
    );
  },
};

export const ModDetailLegacyChinesePhone: StoryObj<typeof ModSections> = {
  globals: { ...phone, locale: 'zh-Hans' },
  render: (_, { globals }) => (
    <div className="p-4">
      <ModSections
        releases={releases.slice(2)}
        locale={(globals.locale as UiLocale | undefined) ?? 'zh-Hans'}
        messages={zoneMessagesFor((globals.locale as UiLocale | undefined) ?? 'zh-Hans')}
      />
    </div>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('region', { name: '版本' })).toHaveTextContent('1.1.0');
    await expect(canvas.getByText('这个版本没有更新说明。')).toBeVisible();
    await fits();
  },
};
