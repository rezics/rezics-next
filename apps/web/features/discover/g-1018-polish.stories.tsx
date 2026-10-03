import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { StoryRouteContext } from '../../.storybook/next-navigation.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { AppShell } from '../shell/app-shell.tsx';
import { messages as shellMessages } from '../shell/messages.ts';
import zhHans from '../shell/messages/zh-Hans.ts';
import { Providers } from '../shell/providers.tsx';
import {
  browseConcepts,
  browseResources,
  fixturePage,
  fixtureTopicLoader,
} from './browse-fixtures.ts';
import { browseMessages } from './browse-messages.ts';
import { browseHref, emptyBrowse } from './browse-state.ts';
import { DiscoverView } from './discover-view.tsx';
import { DiscoverResourceCard } from './resource-card.tsx';

function SearchPage({ locale }: { locale: UiLocale }) {
  const [state, setState] = useState({
    ...emptyBrowse,
    tab: 'works',
    q: locale === 'en' ? 'rain' : '雨',
  });
  const [destination, setDestination] = useState('');
  const url = new URL(browseHref(state), 'http://story.local');
  return (
    <StoryRouteContext value={{ pathname: localizedPath('/discover', locale), search: url.search }}>
      <div
        onSubmitCapture={(event) => {
          event.preventDefault();
          const form = event.target as HTMLFormElement;
          const next = new URL(form.action);
          next.search = new URLSearchParams(
            Array.from(new FormData(form), ([key, value]) => [key, String(value)]),
          ).toString();
          setDestination(next.pathname + next.search);
          setState({ ...emptyBrowse, q: next.searchParams.get('q') ?? '' });
        }}
      >
        <AppShell
          locale={locale}
          messages={locale === 'zh-Hans' ? { ...shellMessages, ...zhHans } : shellMessages}
          theme="light"
          navCollapsed={false}
          account={null}
        >
          <Providers>
            <DiscoverView
              locale={locale}
              state={state}
              avatarQuery=""
              topics={browseConcepts.slice(0, 3)}
              topicLoad={fixtureTopicLoader()}
              sections={null}
              results={{
                ok: true,
                data: fixturePage(
                  browseResources.filter((item) => item.kind === 'work'),
                  0,
                  5,
                ),
              }}
            />
            <output aria-label="Destination" className="block break-all">
              {destination}
            </output>
          </Providers>
        </AppShell>
      </div>
    </StoryRouteContext>
  );
}

const meta = {
  title: 'Discover/Result polish',
  component: SearchPage,
  args: { locale: 'en' },
  globals: { viewport: { value: 'desktop' } },
} satisfies Meta<typeof SearchPage>;
export default meta;
type Story = StoryObj<typeof meta>;

const search: Story['play'] = async ({ canvasElement, args }) => {
  const canvas = within(canvasElement),
    cjk = args.locale === 'zh-Hans';
  const input = canvas.getByRole('searchbox', { name: cjk ? '搜索所有内容' : 'Search everything' });
  await expect(canvas.getAllByRole('searchbox')).toHaveLength(1);
  await expect(input).toHaveValue(cjk ? '雨' : 'rain');
  await expect(within(canvas.getByRole('main')).queryByRole('searchbox')).toBeNull();
  await expect(
    canvas.getByRole('combobox', { name: browseMessages[args.locale].topics }),
  ).toBeVisible();
  const tabs = within(canvas.getByRole('navigation', { name: browseMessages[args.locale].type }));
  await expect(tabs.getAllByRole('link')).toHaveLength(7);
  await userEvent.clear(input);
  await userEvent.type(input, cjk ? '星星 & 故事' : 'stars & stories');
  await userEvent.click(canvas.getByRole('button', { name: cjk ? '搜索' : 'Search' }));
  await expect(canvas.getByLabelText('Destination')).toHaveTextContent(
    `/${args.locale}/discover?q=${cjk ? '%E6%98%9F%E6%98%9F+%26+%E6%95%85%E4%BA%8B' : 'stars+%26+stories'}`,
  );
  await expect(canvas.getByRole('searchbox')).toHaveValue(cjk ? '星星 & 故事' : 'stars & stories');
  await expect(tabs.getByRole('link', { name: browseMessages[args.locale].all })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
};
export const OneSearchLatin: Story = { play: search };
export const OneSearchCjk: Story = {
  args: { locale: 'zh-Hans' },
  globals: { locale: 'zh-Hans' },
  play: search,
};
export const OneSearchLatinPhone: Story = {
  globals: { viewport: { value: 'phone' } },
  play: search,
};
export const OneSearchCjkPhone: Story = {
  ...OneSearchCjk,
  globals: { locale: 'zh-Hans', viewport: { value: 'phone' } },
};

function Credits({ locale }: { locale: UiLocale }) {
  const base = browseResources[0]!;
  const credit = {
    id: browseResources[1]!.id,
    role: 'author',
    participantKind: 'external-reference',
    provider: 'open-library',
    key: 'OL21594A',
    ordinal: 1,
    agent: null,
    handle: null,
    displayName: 'Jane Austen',
  } as const;
  return (
    <div className="grid grid-cols-2 gap-6 p-4 lg:grid-cols-4">
      {[
        { value: 1, kind: 'exact', names: [credit.displayName] },
        { value: 2, kind: 'exact', names: [credit.displayName, null] },
        { value: 3, kind: 'at-least', names: [credit.displayName, null, null] },
        { value: 3, kind: 'at-least', names: ['Austen', 'Lin Mei', 'Mori'] },
      ].map((preview, index) => (
        <DiscoverResourceCard
          key={index}
          locale={locale}
          item={{
            ...base,
            types: ['https://schema.org/Book'],
            name: {
              ...base.name,
              value: locale === 'en' ? `Book ${index + 1}` : `作品 ${index + 1}`,
            },
            work: {
              ...base.work!,
              creditCount: { value: preview.value, kind: preview.kind as 'exact' | 'at-least' },
              primaryCredits: preview.names.map((displayName) => ({ ...credit, displayName })),
            },
          }}
        />
      ))}
    </div>
  );
}
const credits: Story['play'] = async ({ canvasElement, args }) => {
  const canvas = within(canvasElement),
    cards = canvas.getAllByRole('article');
  await expect(canvas.getByText(args.locale === 'en' ? '+1 more' : '另有 1 条署名')).toBeVisible();
  await expect(
    canvas.getByText(args.locale === 'en' ? 'At least 2 more' : '至少另有 2 条署名'),
  ).toBeVisible();
  for (const index of [0, 3]) {
    await expect(within(cards[index]!).queryByText(/more|署名|author credit/)).toBeNull();
  }
};
export const CreditsLatin: Story = {
  render: ({ locale }) => <Credits locale={locale} />,
  play: credits,
};
export const CreditsCjk: Story = {
  ...CreditsLatin,
  args: { locale: 'zh-Hans' },
  globals: { locale: 'zh-Hans' },
};
