import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import { decisions, fictionZone, works, zoneMessagesFor } from '../zones/fixtures.ts';
import { presetTokens } from '../zones/presentation.ts';
import { RealmNotFound, RealmUnavailable } from './states.tsx';
import { RealmPageStory, realmMessagesFor } from './story-page.tsx';
import { ListFailure, RealmAbout, RealmDecisions, RealmDiscussions, RealmWorks } from './views.tsx';

type Tab = 'works' | 'decisions' | 'discussions' | 'about' | 'works-moved';

/** A Realm tab inside the Zone frame, under the Serial preset. */
function TabPage({ tab, locale }: { tab: Tab; locale: UiLocale }) {
  const messages = realmMessagesFor(locale);
  const zoneMessages = zoneMessagesFor(locale);
  const zone = { ...fictionZone(locale, presetTokens.serial), slug: 'fiction' };
  const content = {
    works: <RealmWorks realmName={zone.name.value} works={works} next="/en/r/fiction/works?cursor=2" first={null}
      locale={locale} messages={messages} zoneMessages={zoneMessages} />,
    'works-moved': <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-10"><ListFailure failure="moved"
      firstPage="/en/r/fiction/works" messages={messages} /></div>,
    decisions: <RealmDecisions decisions={decisions} next={null} first="/en/r/fiction/decisions" locale={locale}
      messages={messages} zoneMessages={zoneMessages} />,
    discussions: <RealmDiscussions works={works.slice(0, 8)} locale={locale} messages={messages}
      zoneMessages={zoneMessages} />,
    about: <RealmAbout realmName={zone.name.value} description={zone.description} locale={locale} messages={messages}
      members={locale === 'zh-Hans' ? '12,408 位成员' : '12,408 members'} moderators={4}
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
  args: { tab: 'works', locale: 'en' },
  parameters: { route: { pathname: '/en/r/fiction/works' } },
  render: (args, { globals }) => <TabPage {...args} locale={(globals.locale as UiLocale | undefined) ?? args.locale} />,
} satisfies Meta<typeof TabPage>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Works: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: 'Works' })).toHaveAttribute('aria-current', 'page');
    await expect(canvas.getByRole('heading', { level: 2, name: 'Works in Fiction 小说' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: /Next page/ })).toHaveAttribute('href', '/en/r/fiction/works?cursor=2');
    await expect(canvas.getAllByRole('link', { name: /^Why .* is here$/ })).toHaveLength(works.length);
  },
};

export const WorksChineseDark: Story = { globals: { locale: 'zh-Hans', theme: 'dark' } };
export const WorksPhone: Story = { globals: { viewport: { value: 'phone' } } };

/** The list moved under its cursor: say so and start over, never splice pages. */
export const WorksMoved: Story = {
  args: { tab: 'works-moved' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('status')).toHaveTextContent('This list changed while you were browsing');
    await expect(canvas.getByRole('link', { name: 'Start over' })).toHaveAttribute('href', '/en/r/fiction/works');
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

export const Discussions: Story = {
  args: { tab: 'discussions' },
  parameters: { route: { pathname: '/en/r/fiction/discussions' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: 'Open discussion: 雨夜书店' }))
      .toHaveAttribute('href', expect.stringMatching(/^\/en\/w\/[0-9a-f-]+\/discussion\?scope=realm&realm=/));
  },
};

export const About: Story = {
  args: { tab: 'about' },
  parameters: { route: { pathname: '/en/r/fiction/about' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 3, name: 'Rule 1: Every pick gets a one-line hook' })).toBeVisible();
    await expect(canvas.getByText('4 moderators')).toBeVisible();
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
