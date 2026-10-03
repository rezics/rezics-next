import type { Meta, StoryObj } from '@storybook/react-vite';
import { direction } from '@rezics/main/language';
import { expect, screen, spyOn, userEvent, waitFor, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import { Providers } from '../shell/providers.tsx';
import { messages as workMessages } from '../work-page/messages.ts';
import { ScopeBar } from '../work-page/scope-bar.tsx';
import { browseId, fixtureTopicLoader } from './browse-fixtures.ts';
import { browseMessages } from './browse-messages.ts';
import { emptyBrowse } from './browse-state.ts';
import { BrowseContinuation } from './resource-list.tsx';
import { TopicPicker } from './topic-picker.tsx';

function CountedChoices({ locale }: { locale: UiLocale }) {
  return <Providers><div className="grid max-w-xl gap-8 p-4">
    <ScopeBar workRef={browseId(999).slice(-36)} scope={{ kind: 'global' }} realms={[]}
      target={browseId(999)} locale={locale} messages={workMessages[locale]} />
    <TopicPicker locale={locale} value={[]} onChange={() => undefined} load={fixtureTopicLoader()} />
    <BrowseContinuation page={{ items: [], complete: true, nextCursor: null, count: { value: 1, kind: 'exact' } }}
      state={emptyBrowse} locale={locale} />
  </div></Providers>;
}
const meta = {
  title: 'Discover/Counted choices', component: CountedChoices, args: { locale: 'en' },
  beforeEach() {
    const fetch = window.fetch.bind(window);
    const mock = spyOn(window, 'fetch').mockImplementation((input, init) => {
      if (!String(input instanceof Request ? input.url : input).includes('/v1/rating-populations')) return fetch(input, init);
      return Promise.resolve(Response.json({ profile: 'rating-populations-v1', target: browseId(999),
        sourcePosition: { dataEpoch: 'story', sequence: '1' }, stale: false,
        items: [1, 20].map((count, index) => {
          const value = `Community ${index + 1}`, language = 'en';
          return { id: browseId(index + 1), global: false, readerCommunity: false,
            name: { value, language, direction: direction(language, value), basis: 'requested' }, ratingCount: count };
        }),
        count: { value: 2, kind: 'exact' }, complete: true, nextCursor: null }));
    });
    return () => mock.mockRestore();
  },
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement), words = browseMessages[args.locale];
    await expect(canvas.getByRole('status')).toHaveTextContent(args.locale === 'en' ? '1 result' : '1 项结果');
    const open = canvas.getByRole('button', { name: words.otherCommunities });
    await waitFor(() => expect(open).toBeEnabled());
    await userEvent.click(open);
    const picker = await screen.findByRole('combobox', { name: words.chooseCommunity });
    await waitFor(() => expect(picker).toBeEnabled());
    await userEvent.click(picker);
    const options = await screen.findByRole('listbox', { name: words.chooseCommunity });
    await waitFor(() => expect(within(options).getByText(args.locale === 'en' ? '1 rating' : '1 个评分')).toBeVisible());
    await expect(within(options).getByText(args.locale === 'en' ? '20 ratings' : '20 个评分')).toBeVisible();
  },
} satisfies Meta<typeof CountedChoices>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Latin: Story = {};
export const Cjk: Story = { args: { locale: 'zh-Hans' }, globals: { locale: 'zh-Hans' } };
