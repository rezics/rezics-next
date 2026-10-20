import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { messages as feedMessages } from '../feed/messages.ts';
import feedZhHans from '../feed/messages/zh-Hans.ts';
import { safetyText } from '../safety/messages.ts';
import { messages as workMessages } from './messages.ts';
import { discussion } from './fixtures.ts';
import { DiscussionList } from './discussion.tsx';
import type { DiscussionPage } from './types.ts';

const [markedReply, unmarkedReply, secondReply] = discussion.ok ? discussion.data.items : [];
const items: DiscussionPage['items'] = [
  { ...markedReply!, kind: 'post', body: 'The city sinks in the final chapter.', spoiler: true },
  { ...unmarkedReply!, kind: 'reply', body: 'The cartographer is an unreliable narrator.', spoiler: false },
];
const owningItems: DiscussionPage['items'] = [...items,
  { ...secondReply!, kind: 'reply', body: 'A second reply can be reported independently.', spoiler: false },
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

async function checkObjectMenus(canvasElement: HTMLElement, items: DiscussionPage['items'], locale: UiLocale) {
  const canvas = within(canvasElement);
  const page = within(canvasElement.ownerDocument.body);
  const cards = canvas.getAllByRole('listitem');
  const labels = { post: workMessages[locale].postMoreActions, reply: workMessages[locale].replyMoreActions };
  const report = safetyText.report[locale];
  await expect(cards).toHaveLength(items.length);
  await expect(canvas.queryByRole('link', { name: /^Report(?:\s|$)/ })).toBeNull();
  await expect(canvas.queryByRole('button', { name: /^Report(?:\s|$)/ })).toBeNull();
  await expect(canvasElement.querySelectorAll('[data-report-action]')).toHaveLength(0);
  for (const [index, item] of items.entries()) {
    const card = cards[index]!;
    await expect(card).toHaveAttribute('data-discussion-object', item.kind);
    await expect(card).toHaveAttribute('data-resource', item.reply);
    const more = within(card).getByRole('button', { name: labels[item.kind] });
    await expect(within(card).getAllByRole('button', { name: labels[item.kind] })).toHaveLength(1);
    await userEvent.click(more);
    const menu = page.getByRole('menu');
    const action = within(menu).getByRole('menuitem', { name: report });
    await expect(within(menu).getAllByRole('menuitem')).toHaveLength(1);
    await expect(action).toHaveAttribute('data-report-action', item.kind);
    const href = new URL(action.getAttribute('href')!, canvasElement.ownerDocument.location.href);
    await expect(href.pathname).toBe(localizedPath('/report', locale));
    await expect(Object.fromEntries(href.searchParams)).toEqual({ target: item.reply, realm: item.realm,
      component: 'body', revision: `urn:rezics:content:revision:${item.revisionId}` });
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(page.queryByRole('menu')).toBeNull());
    await expect(more).toHaveFocus();
  }
  await userEvent.click(within(cards[2]!).getByRole('button', { name: labels.reply }));
  await expect(page.getByRole('menuitem', { name: report })).toBeVisible();
}

/** Each native object keeps its own report target and returns focus to its own overflow. */
export const OwningObjectMenus: Story = {
  args: { items: owningItems },
  async play({ canvasElement, args }) {
    await checkObjectMenus(canvasElement, args.items, args.locale);
  },
};

/** The same owning menus use local copy and fit beside the dates on a phone. */
export const OwningObjectMenusPhoneChinese: Story = {
  args: { items: owningItems, locale: 'zh-Hans' },
  globals: { locale: 'zh-Hans', viewport: { value: 'phone' } },
  async play({ canvasElement, args }) {
    await checkObjectMenus(canvasElement, args.items, args.locale);
  },
};
