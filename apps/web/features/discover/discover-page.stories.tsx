import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import { Providers } from '../shell/providers.tsx';
import {
  browseConcepts,
  browseResources,
  fixturePage,
  fixtureTopicLoader,
} from './browse-fixtures.ts';
import { emptyBrowse, type BrowseState } from './browse-state.ts';
import { browseMessages } from './browse-messages.ts';
import { DiscoverView } from './discover-view.tsx';

function props(locale: UiLocale, state: BrowseState = emptyBrowse) {
  return {
    locale,
    state,
    topics: browseConcepts.slice(0, 8),
    results: { ok: true as const, data: fixturePage(browseResources) },
    sections: {
      ok: true as const,
      data: [
        {
          id: 'popular' as const,
          reason: { kind: 'popular-in-followed-topics' as const },
          page: fixturePage(browseResources, 0, 6),
        },
        {
          id: 'communities' as const,
          reason: { kind: 'communities-in-reader-languages' as const },
          page: fixturePage(
            browseResources.filter((item) => item.kind === 'realm'),
            0,
            6,
          ),
        },
        {
          id: 'sites' as const,
          reason: { kind: 'new-sites' as const },
          page: fixturePage(
            browseResources.filter((item) => item.kind === 'site'),
            0,
            6,
          ),
        },
      ],
    },
    topicLoad: fixtureTopicLoader(),
  };
}
const meta = {
  title: 'Discover/Page',
  component: DiscoverView,
  args: props('en'),
  decorators: [
    (Story) => (
      <Providers>
        <Story />
      </Providers>
    ),
  ],
  parameters: { route: { pathname: '/en/discover' } },
  globals: { viewport: { value: 'desktop' } },
} satisfies Meta<typeof DiscoverView>;
export default meta;
type Story = StoryObj<typeof meta>;
export const OneBrowse: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const tabs = within(canvas.getByRole('navigation', { name: 'Type' }));
    for (const [tab, label] of Object.entries(browseMessages.en).filter(([key]) =>
      ['works', 'communities', 'sites', 'people', 'lists', 'topics'].includes(key),
    )) {
      await expect(tabs.getByRole('link', { name: label })).toHaveAttribute(
        'href',
        `/en/discover?tab=${tab}`,
      );
    }
    await expect(
      canvas.getByRole('region', { name: 'Popular in your followed topics' }),
    ).toBeVisible();
    await expect(canvas.getAllByRole('link', { name: 'See all' })).toHaveLength(3);
    await expect(canvas.getByText('At least 20 results')).toBeVisible();
  },
};
export const TraditionalChinese: Story = { args: props('zh-Hant') };
export const SimplifiedChinese: Story = { args: props('zh-Hans') };
export const Japanese: Story = { args: props('ja') };
export const Korean: Story = { args: props('ko') };
export const German: Story = { args: props('de') };
export const French: Story = { args: props('fr') };
export const Spanish: Story = { args: props('es') };
export const Phone: Story = {
  args: props('zh-Hans'),
  globals: { viewport: { value: 'phone' } },
  async play() {
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};
export const Communities: Story = {
  args: {
    ...props('en', { ...emptyBrowse, tab: 'communities' }),
    sections: null,
    results: {
      ok: true,
      data: fixturePage(browseResources.filter((item) => item.kind === 'realm')),
    },
  },
};
export const LastPage: Story = {
  args: {
    ...props('en', { ...emptyBrowse, tab: 'topics', cursor: '2380' }),
    sections: null,
    results: { ok: true, data: fixturePage(browseResources, 2380) },
  },
};
export const Failed: Story = {
  args: { results: { ok: false, moved: false }, sections: { ok: false, moved: false } },
};
export const Changed: Story = {
  args: {
    state: { ...emptyBrowse, tab: 'works', cursor: '20' },
    results: { ok: false, moved: true },
    sections: null,
  },
};
export const SlowChoices: Story = { args: { topicLoad: fixtureTopicLoader({ slow: true }) } };
export const FailedChoices: Story = { args: { topicLoad: fixtureTopicLoader({ fail: true }) } };
export const IncludesAndExcludes: Story = {
  args: {
    ...props('en', {
      ...emptyBrowse,
      tab: 'works',
      conditions: {
        include: [browseConcepts[0]!.id.slice(-36), browseConcepts[1]!.id.slice(-36)],
        exclude: [browseConcepts[2]!.id.slice(-36)],
        match: 'any',
      },
    }),
    sections: null,
  },
};
