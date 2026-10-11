import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import { messages as feedMessages } from '../feed/messages.ts';
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
  return <div className="mx-auto max-w-3xl p-6">
    <DiscussionList items={items} locale={locale} messages={workMessages.en} feedMessages={feedMessages}
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
