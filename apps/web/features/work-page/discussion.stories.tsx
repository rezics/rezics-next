import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import { messages as feedMessages } from '../feed/messages.ts';
import feedZhHans from '../feed/messages/zh-Hans.ts';
import { messages as workMessages } from './messages.ts';
import { discussion } from './fixtures.ts';
import { DiscussionList } from './discussion.tsx';
import type { DiscussionPage } from './types.ts';

const [markedReply, unmarkedReply] = discussion.ok ? discussion.data.items : [];
const items: DiscussionPage['items'] = [
  { ...markedReply!, body: 'The city sinks in the final chapter.', spoiler: true },
  { ...unmarkedReply!, body: 'The cartographer is an unreliable narrator.', spoiler: false },
];

interface Args { items: DiscussionPage['items']; locale: UiLocale }

function WorkDiscussionStory({ items, locale }: Args) {
  const localizedFeedMessages = locale === 'zh-Hans' ? { ...feedMessages, ...feedZhHans } : feedMessages;
  return <div className="mx-auto max-w-3xl p-6">
    <DiscussionList items={items} locale={locale} messages={workMessages[locale]} feedMessages={localizedFeedMessages}
      realmLabel={() => 'Tidewater Readers'} />
  </div>;
}

const meta = {
  title: 'Work page/Discussion',
  component: WorkDiscussionStory,
  args: { items, locale: 'en' },
  globals: { viewport: { value: 'desktop' } },
} satisfies Meta<typeof WorkDiscussionStory>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The author-marked reply stays hidden until asked; the unmarked reply remains readable. */
export const Spoilers: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const cards = canvas.getAllByRole('listitem');
    await expect(within(cards[0]!).queryByText('The city sinks in the final chapter.')).toBeNull();
    await expect(within(cards[1]!).getByText('The cartographer is an unreliable narrator.')).toBeVisible();
    await userEvent.click(within(cards[0]!).getByRole('button', { name: 'Show spoiler' }));
    await expect(within(cards[0]!).getByText('The city sinks in the final chapter.')).toBeVisible();
  },
};

/** The hidden reply and its translated reveal control remain readable on a phone. */
export const SpoilerVeilPhoneChinese: Story = {
  args: { locale: 'zh-Hans' },
  globals: { locale: 'zh-Hans', viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    const card = within(within(canvasElement).getAllByRole('listitem')[0]!);
    await expect(card.queryByText('The city sinks in the final chapter.')).toBeNull();
    await expect(card.getByText(feedZhHans.spoilerAnnounced)).toBeVisible();
    await expect(card.getByRole('button', { name: feedZhHans.showSpoiler })).toBeVisible();
  },
};
