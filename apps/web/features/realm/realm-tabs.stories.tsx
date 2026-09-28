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
import { RealmNotFound, RealmUnavailable } from './states.tsx';
import { RealmPageStory, realmMessagesFor } from './story-page.tsx';
import { type AboutPerson, ListFailure, RealmAbout, RealmDecisions } from './views.tsx';

type Tab = 'browse' | 'decisions' | 'about' | 'browse-moved';

const person = (id: string, name: string, handle: string | null, featured = false): AboutPerson => ({
  id: `https://rezics.com/id/00000000-0000-7000-8000-${id.padStart(12, '0')}`, name,
  href: handle ? `/@${handle}` : null, kind: 'person', avatarUrl: null, featured });
const moderators = [person('a1', 'Daniel Chen 陈丹尼', 'daniel_chen'), person('a2', 'Lin Mei 林梅', 'lin_mei'),
  person('a3', 'An Wu 吴安', 'an_wu')];
const listed = [person('b1', '北岛听风', null, true), person('b2', 'Sophie Li 李素菲', null), person('b3', '橘子汽水', null),
  person('b4', 'Maren Osei', null)];

/** A Realm tab inside the Zone frame, under the Serial preset. */
function TabPage({ tab, locale }: { tab: Tab; locale: UiLocale }) {
  const messages = realmMessagesFor(locale);
  const zoneMessages = zoneMessagesFor(locale);
  const zone = { ...fictionZone(locale, presetTokens.serial), slug: 'fiction' };
  const state = parseBrowseState({ view: 'grid' });
  const content = {
    browse: <ZoneBrowse card={cardRenderer(zone, null, locale, zoneMessages)} messages={zoneMessages}
      model={browseModel({ base: `/${locale}/r/fiction/browse`, zoneName: zone.name.value, state, locale,
        messages: zoneMessages, admitted: new Map(), page: { items: works, facets: browseCounts(works),
          matches: { value: works.length, kind: 'exact' }, window: { scanned: works.length, complete: true },
          tags: 'current', nextCursor: 'page-2', sort: 'newest' } })} />,
    'browse-moved': <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-10"><ListFailure failure="moved"
      firstPage="/en/r/fiction/browse" messages={messages} /></div>,
    decisions: <RealmDecisions decisions={decisions} next={null} first="/en/r/fiction/decisions" locale={locale}
      messages={messages} zoneMessages={zoneMessages} />,
    about: <RealmAbout realmName={zone.name.value} description={zone.description} locale={locale} messages={messages}
      members={locale === 'zh-Hans' ? '12,408 位成员' : '12,408 members'} moderators={moderators}
      listed={{ more: true, people: listed }}
      others={[{ href: '/en/r/classics', name: { value: 'Classic Literature · 经典文学', lang: 'en' }, members: '860 members' },
        { href: '/en/r/cooking', name: { value: '家常菜 · Home Cooking', lang: 'zh-Hans' }, members: null }]}
      rules={[{ id: 'tagline', title: 'Every pick gets a one-line hook', lang: 'en', governed: false,
        body: 'Editors write the line shown under the cover. It sells the story without spoiling it.' },
      { id: 'translations', title: 'Translations are credited', lang: 'en', governed: true,
        body: 'A translated serial names its translator and links the original when it is on REZICS.' }]} />,
  }[tab];
  return <RealmPageStory zone={zone} locale={locale}
    members={locale === 'zh-Hans' ? '12,408 位成员' : '12,408 members'}>{content}</RealmPageStory>;
}

const meta = {
  title: 'Realm/Tabs',
  component: TabPage,
  args: { tab: 'browse', locale: 'en' },
  parameters: { route: { pathname: '/en/r/fiction/browse' } },
  render: (args, { globals }) => <TabPage {...args} locale={(globals.locale as UiLocale | undefined) ?? args.locale} />,
} satisfies Meta<typeof TabPage>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Browse, where the Works tab was: every adopted Work, here in the grid the former Works tab showed. */
export const Browse: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: 'Browse' })).toHaveAttribute('aria-current', 'page');
    await expect(canvas.getByRole('link', { name: 'Grid' })).toHaveAttribute('aria-current', 'true');
    await expect(canvas.getByRole('link', { name: /Next/ })).toHaveAttribute('href',
      '/en/r/fiction/browse?view=grid&cursor=page-2');
    await expect(canvas.getAllByRole('link', { name: /^Why .* is here$/ })).toHaveLength(works.length);
  },
};

export const BrowseChineseDark: Story = { globals: { locale: 'zh-Hans', theme: 'dark' } };
export const BrowsePhone: Story = { globals: { viewport: { value: 'phone' } } };

/** The list moved under its cursor: say so and start over, never splice pages. */
export const BrowseMoved: Story = {
  args: { tab: 'browse-moved' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('status')).toHaveTextContent('This list changed while you were browsing');
    await expect(canvas.getByRole('link', { name: 'Start over' })).toHaveAttribute('href', '/en/r/fiction/browse');
  },
};

export const Decisions: Story = {
  args: { tab: 'decisions' },
  parameters: { route: { pathname: '/en/r/fiction/decisions' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: 'Decisions' })).toHaveAttribute('aria-current', 'page');
    const log = canvas.getByRole('region', { name: 'Decision log' });
    await expect(within(log).getAllByRole('listitem')).toHaveLength(decisions.length);
    await expect(canvasElement.querySelector('#decision-d1')).toHaveTextContent('Added 云端书简');
    await expect(canvas.getByRole('link', { name: /Back to the first page/ })).toBeVisible();
  },
};

export const DecisionsChinese: Story = { args: { tab: 'decisions' }, globals: { locale: 'zh-Hans' },
  parameters: { route: { pathname: '/zh-Hans/r/fiction/decisions' } } };

export const About: Story = {
  args: { tab: 'about' },
  parameters: { route: { pathname: '/en/r/fiction/about' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 3, name: 'Rule 1: Every pick gets a one-line hook' })).toBeVisible();
    const team = canvas.getByRole('region', { name: 'Moderators' });
    await expect(within(team).getByRole('link', { name: /Lin Mei 林梅/ })).toHaveAttribute('href', '/en/@lin_mei');
    const members = canvas.getByRole('region', { name: 'Members' });
    await expect(within(members).getAllByRole('listitem')[0]).toHaveTextContent('北岛听风Featured');
    await expect(within(members).getByText('12,408 members')).toBeVisible();
    await expect(canvas.getByRole('link', { name: /Classic Literature/ })).toHaveAttribute('href', '/en/r/classics');
  },
};

export const AboutDark: Story = { args: { tab: 'about' }, globals: { theme: 'dark' },
  parameters: { route: { pathname: '/en/r/fiction/about' } } };

export const NotFound: Story = {
  render: (_, { globals }) => <RealmNotFound messages={realmMessagesFor((globals.locale as UiLocale | undefined) ?? 'en')} />,
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('heading', { level: 1, name: 'This community isn’t here' })).toBeVisible();
  },
};

export const Unavailable: Story = {
  render: (_, { globals }) => <RealmUnavailable messages={realmMessagesFor((globals.locale as UiLocale | undefined) ?? 'en')} />,
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('alert')).toHaveTextContent('Couldn’t load this community');
  },
};
