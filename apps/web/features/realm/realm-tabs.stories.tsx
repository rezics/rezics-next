import { materializeData } from 'native-i18n';
import { localizedPath } from '../../i18n/locale.ts';
import { spaceHref } from '../address/path.ts';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import { ZoneBrowse } from '../zones/browse.tsx';
import { parseBrowseState } from '../zones/browse-state.ts';
import { browseModel } from '../zones/browse-view.ts';
import { decisions, fictionZone, works, zoneMessagesFor } from '../zones/fixtures.ts';
import { browseCounts } from '../zones/official-fixtures.ts';
import { presetTokens } from '../zones/presentation.ts';
import { cardRenderer } from '../zones/zone-home.tsx';
import { profileHref } from '../profile/route.ts';
import { realmHref, siteHref } from './route.ts';
import { RealmNotFound, RealmUnavailable } from './states.tsx';
import { rosterPeople } from './roster.ts';
import { RealmPageStory, realmMessagesFor } from './story-page.tsx';
import { type AboutPerson, ListFailure, RealmAbout, RealmDecisions } from './views.tsx';

type Tab = 'browse' | 'decisions' | 'about' | 'browse-moved' | 'browse-failed' | 'browse-offline' | 'rules' | 'members';

const person = (
  id: string,
  name: string,
  handle: string | null,
  featured = false,
): AboutPerson => ({
  id: `https://rezics.com/id/00000000-0000-7000-8000-${id.padStart(12, '0')}`,
  name,
  href: handle ? profileHref(handle) : null,
  kind: 'person',
  avatarUrl: null,
  featured,
});
const moderators = [
  person('a1', 'Daniel Chen 陈丹尼', 'daniel_chen'),
  person('a2', 'Lin Mei 林梅', 'lin_mei'),
  person('a3', 'An Wu 吴安', 'an_wu'),
];
const listed = [
  person('b1', '北岛听风', null, true),
  person('b2', 'Sophie Li 李素菲', null),
  person('b3', '橘子汽水', null),
  person('b4', 'Maren Osei', null),
];

/** A Realm tab inside the Zone frame, under the Serial preset. */
function TabPage({ tab, locale, roster = 'listed' }: {
  tab: Tab;
  locale: UiLocale;
  /** One page of the roster: names shown, names all private with a next page, an empty page with a next page, or no members. */
  roster?: 'listed' | 'private-names' | 'empty-page' | 'none';
}) {
  const messages = realmMessagesFor(locale);
  const rosterPage = {
    listed: { people: listed, more: true },
    'private-names': {
      people: rosterPeople(
        [
          { agent: 'a-private-1', displayName: null, featured: false },
          { agent: 'a-private-2', displayName: null, featured: false },
        ],
        messages.memberUnnamed,
        () => null,
      ),
      more: true,
    },
    'empty-page': { people: [], more: true },
    none: { people: [], more: false },
  }[roster];
  const zoneMessages = zoneMessagesFor(locale);
  const zone = { ...fictionZone(locale, presetTokens.serial), slug: 'fiction' };
  const state = parseBrowseState({ view: 'grid' });
  const content = {
    browse: (
      <ZoneBrowse
        card={cardRenderer(zone, null, locale, zoneMessages)}
        messages={zoneMessages}
        model={browseModel({
          base: siteHref(locale, 'fiction', ['browse']),
          zoneName: zone.name.value,
          state,
          locale,
          messages: zoneMessages,
          admitted: new Map(),
          page: {
            items: works,
            facets: browseCounts(works),
            matches: { value: works.length, kind: 'exact' },
            window: { scanned: works.length, complete: true },
            tags: 'current',
            nextCursor: 'page-2',
            sort: 'newest',
          },
        })}
      />
    ),
    'browse-moved': (
      <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-10">
        <ListFailure
          failure="moved"
          firstPage={siteHref(locale, 'fiction', ['browse'])}
          messages={messages}
        />
      </div>
    ),
    'browse-failed': (
      <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-10">
        <ListFailure failure="unavailable" reference="ab12cd34" firstPage={siteHref(locale, 'fiction', ['browse'])}
          messages={messages} />
      </div>
    ),
    'browse-offline': (
      <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-10">
        <ListFailure failure="offline" firstPage={siteHref(locale, 'fiction', ['browse'])} messages={messages} />
      </div>
    ),
    decisions: (
      <RealmDecisions
        decisions={decisions}
        next={null}
        first={realmHref(locale, 'fiction', 'decisions')}
        locale={locale}
        messages={messages}
        zoneMessages={zoneMessages}
      />
    ),
    about: (
      <RealmAbout
        realmName={zone.name.value}
        description={zone.description}
        locale={locale}
        messages={messages}
        only={tab === 'rules' || tab === 'members' ? tab : undefined}
        members={materializeData(realmMessagesFor(locale), { locale }).members(12408)}
        moderators={moderators}
        listed={rosterPage}
        others={[
          {
            href: realmHref(locale, 'classics'),
            name: { value: 'Classic Literature · 经典文学', lang: 'en' },
            members: '860 members',
          },
          {
            href: realmHref(locale, 'cooking'),
            name: { value: '家常菜 · Home Cooking', lang: 'zh-Hans' },
            members: null,
          },
        ]}
        rules={[
          {
            id: 'tagline',
            title: 'Every pick gets a one-line hook',
            lang: 'en',
            governed: false,
            body: 'Editors write the line shown under the cover. It sells the story without spoiling it.',
          },
          {
            id: 'translations',
            title: 'Translations are credited',
            lang: 'en',
            governed: true,
            body: 'A translated serial names its translator and links the original when it is on REZICS.',
          },
        ]}
      />
    ),
  }[tab === 'rules' || tab === 'members' ? 'about' : tab];
  return (
    <RealmPageStory
      zone={zone}
      locale={locale}
      site={tab === 'browse' || tab === 'browse-moved' || tab === 'browse-failed' || tab === 'browse-offline'}
      members={materializeData(realmMessagesFor(locale), { locale }).members(12408)}
    >
      {content}
    </RealmPageStory>
  );
}

const meta = {
  title: 'Realm/Tabs',
  component: TabPage,
  args: { tab: 'browse', locale: 'en' },
  parameters: { route: { pathname: localizedPath(spaceHref('fiction', 'site', ['browse']), 'en') } },
  render: (args, { globals }) => (
    <TabPage {...args} locale={(globals.locale as UiLocale | undefined) ?? args.locale} />
  ),
} satisfies Meta<typeof TabPage>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Browse, where the Works tab was: every adopted Work, here in the grid the former Works tab showed. */
export const Browse: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: 'Browse' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(canvas.getByRole('link', { name: 'Grid' })).toHaveAttribute(
      'aria-current',
      'true',
    );
    await expect(canvas.getByRole('link', { name: /Next/ })).toHaveAttribute(
      'href',
      localizedPath(spaceHref('fiction', 'site', ['browse']), 'en') + '?view=grid&cursor=page-2',
    );
    await expect(canvas.getAllByRole('link', { name: /^Why .* is here$/ })).toHaveLength(
      works.length,
    );
  },
};

export const BrowseChineseDark: Story = { globals: { locale: 'zh-Hans', theme: 'dark' } };
export const BrowsePhone: Story = { globals: { viewport: { value: 'phone' } } };

/** The list moved under its cursor: say so and start over, never splice pages. */
export const BrowseMoved: Story = {
  args: { tab: 'browse-moved' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('status')).toHaveTextContent(
      'This list changed while you were browsing',
    );
    await expect(canvas.getByRole('link', { name: 'Start over' })).toHaveAttribute(
      'href',
      localizedPath(spaceHref('fiction', 'site', ['browse']), 'en'),
    );
  },
};

async function captureSection(name: string) {
  if (import.meta.env.VITE_G943_VISUAL === '1') {
    const { page } = await import('vitest/browser');
    await document.fonts.ready;
    await page.screenshot({ path: `../../../../.temp/g-943-${name}.png` });
  }
}

export const Rules: Story = {
  args: { tab: 'rules' },
  parameters: { route: { pathname: localizedPath(spaceHref('fiction', 'community', ['rules']), 'en') } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: 'Community rules' })).toBeVisible();
    await expect(canvas.queryByRole('heading', { name: 'Moderators' })).toBeNull();
    await expect(canvas.queryByRole('heading', { name: 'Members' })).toBeNull();
    await captureSection('rules');
  },
};
export const Members: Story = {
  args: { tab: 'members' },
  parameters: { route: { pathname: localizedPath(spaceHref('fiction', 'community', ['members']), 'en') } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: 'Members' })).toBeVisible();
    await expect(canvas.queryByRole('heading', { name: 'Community rules' })).toBeNull();
    await expect(canvas.queryByRole('heading', { name: 'Moderators' })).toBeNull();
    // The header's membership is labelled as the community's, never as the roster's length.
    await expect(canvas.getByText('Showing 4 listed members · Community membership: 12,408 members (counted separately from this list)')).toBeVisible();
    await captureSection('members');
  },
};

/** A page whose members all keep their names private is still a page of members, under a fallback name. */
export const MembersPrivateNames: Story = {
  args: { tab: 'members', roster: 'private-names' },
  parameters: { route: { pathname: localizedPath(spaceHref('fiction', 'community', ['members']), 'en') } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const members = canvas.getByRole('region', { name: 'Members' });
    await expect(within(members).getAllByRole('listitem')).toHaveLength(2);
    await expect(within(members).getAllByText('Member')).toHaveLength(2);
    await expect(canvas.queryByText('No members have chosen to be listed yet.')).toBeNull();
  },
};

/** An empty page with a next cursor is not an empty community; only no members and no next page says so. */
export const MembersEmptyPageWithCursor: Story = {
  args: { tab: 'members', roster: 'empty-page' },
  parameters: { route: { pathname: localizedPath(spaceHref('fiction', 'community', ['members']), 'en') } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: 'Members' })).toBeVisible();
    await expect(canvas.queryByText('No members have chosen to be listed yet.')).toBeNull();
  },
};

export const MembersNone: Story = {
  args: { tab: 'members', roster: 'none' },
  parameters: { route: { pathname: localizedPath(spaceHref('fiction', 'community', ['members']), 'en') } },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByText('No members have chosen to be listed yet.')).toBeVisible();
  },
};

export const Decisions: Story = {
  args: { tab: 'decisions' },
  parameters: { route: { pathname: localizedPath(spaceHref('fiction', 'community', ['decisions']), 'en') } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: 'Decisions' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    const log = canvas.getByRole('region', { name: 'Decision log' });
    await expect(within(log).getAllByRole('listitem')).toHaveLength(decisions.length);
    await expect(canvasElement.querySelector('#decision-d1')).toHaveTextContent('Added 云端书简');
    await expect(canvas.getByRole('link', { name: /Back to the first page/ })).toBeVisible();
  },
};

export const DecisionsChinese: Story = {
  args: { tab: 'decisions' },
  globals: { locale: 'zh-Hans' },
  parameters: { route: { pathname: localizedPath(spaceHref('fiction', 'community', ['decisions']), 'zh-Hans') } },
};

export const About: Story = {
  args: { tab: 'about' },
  parameters: { route: { pathname: localizedPath(spaceHref('fiction', 'community', ['about']), 'en') } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole('heading', { level: 3, name: 'Rule 1: Every pick gets a one-line hook' }),
    ).toBeVisible();
    const team = canvas.getByRole('region', { name: 'Moderators' });
    await expect(within(team).getByRole('link', { name: /Lin Mei 林梅/ })).toHaveAttribute(
      'href',
      localizedPath(profileHref('lin_mei'), 'en'),
    );
    const members = canvas.getByRole('region', { name: 'Members' });
    await expect(within(members).getAllByRole('listitem')[0]).toHaveTextContent('北岛听风Featured');
    // The roster says what it shows; the Realm's membership stays in the About section above.
    await expect(within(members).getByText('Showing 4 listed members')).toBeVisible();
    await expect(within(members).queryByText(/12,408/)).toBeNull();
    await expect(canvas.getByText('Community membership: 12,408 members (counted separately from this list)')).toBeVisible();
    await expect(canvas.getByRole('link', { name: /Classic Literature/ })).toHaveAttribute(
      'href',
      localizedPath(spaceHref('classics', 'community'), 'en'),
    );
  },
};

export const AboutDark: Story = {
  args: { tab: 'about' },
  globals: { theme: 'dark' },
  parameters: { route: { pathname: localizedPath(spaceHref('fiction', 'community', ['about']), 'en') } },
};

export const NotFound: Story = {
  render: (_, { globals }) => (
    <RealmNotFound messages={realmMessagesFor((globals.locale as UiLocale | undefined) ?? 'en')} />
  ),
  async play({ canvasElement }) {
    await expect(
      within(canvasElement).getByRole('heading', { level: 1, name: 'This community isn’t here' }),
    ).toBeVisible();
  },
};

export const Unavailable: Story = {
  render: (_, { globals }) => (
    <RealmUnavailable
      messages={realmMessagesFor((globals.locale as UiLocale | undefined) ?? 'en')}
      failure="unavailable"
      reference="ab12cd34"
    />
  ),
  async play({ canvasElement }) {
    const alert = within(canvasElement).getByRole('alert');
    await expect(alert).toHaveTextContent('Couldn’t load this community');
    await expect(alert).toHaveTextContent('Something went wrong on our side.');
    await expect(alert).toHaveTextContent('Reference: ab12cd34');
    await expect(alert).not.toHaveTextContent('connection');
  },
};

/** The request never reached REZICS: the connection sentence, and no server reference. */
export const Offline: Story = {
  render: (_, { globals }) => (
    <RealmUnavailable messages={realmMessagesFor((globals.locale as UiLocale | undefined) ?? 'en')} failure="offline" />
  ),
  async play({ canvasElement }) {
    const alert = within(canvasElement).getByRole('alert');
    await expect(alert).toHaveTextContent('Check your connection, then try again.');
    await expect(alert).not.toHaveTextContent('Reference');
  },
};

/** A server failure of a list names our side and quotes the response’s reference. */
export const BrowseFailed: Story = {
  args: { tab: 'browse-failed' },
  async play({ canvasElement }) {
    const alert = within(canvasElement).getByRole('alert');
    await expect(alert).toHaveTextContent('Something went wrong on our side.');
    await expect(alert).toHaveTextContent('Reference: ab12cd34');
    await expect(alert).not.toHaveTextContent('connection');
  },
};

export const BrowseOffline: Story = {
  args: { tab: 'browse-offline' },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('alert')).toHaveTextContent('Check your connection, then try again.');
  },
};
