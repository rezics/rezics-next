import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import { Providers } from '../shell/providers.tsx';
import { browseCategories } from '../catalogue/registry.ts';
import {
  browseConcepts,
  browseResources,
  fixturePage,
  fixtureTopicLoader,
} from './browse-fixtures.ts';
import { emptyBrowse, type BrowseState } from './browse-state.ts';
import { DiscoverView } from './discover-view.tsx';
import { spaceHref } from '../address/path.ts';
import { localizedPath } from '../../i18n/locale.ts';

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
    await expect(tabs.getAllByRole('link')).toHaveLength(7);
    for (const { id: tab, labels } of browseCategories()) {
      await expect(tabs.getByRole('link', { name: labels.en })).toHaveAttribute(
        'href',
        `/en/discover?tab=${tab}`,
      );
    }
    await expect(
      canvas.getByRole('region', { name: 'Popular in your followed topics' }),
    ).toBeVisible();
    await expect(canvas.getAllByRole('link', { name: 'See all' })).toHaveLength(3);
    await expect(canvas.getByText('At least 20 results')).toBeVisible();
    await expect(canvas.getByRole('heading', { name: 'All results', level: 2 })).toBeVisible();
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
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const communities = within(canvas.getByRole('region', { name: /^Communities$/ }));
    const page = fixturePage(browseResources.filter((item) => item.kind === 'realm'));
    const links = within(communities.getByRole('list')).getAllByRole('link');
    await expect(links).toHaveLength(page.items.length);
    for (const [index, item] of page.items.entries())
      await expect(links[index]).toHaveAttribute('href', localizedPath(spaceHref(item.id, 'community'), 'en'));
    // Topic suggestions also use a list, but are outside the results region.
    await userEvent.click(canvas.getByText('Filter by topics'));
    await expect(canvas.getByRole('region', { name: 'Conditions' }).querySelector('ul')).not.toBeNull();
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
  args: {
    results: { ok: false, moved: false, failure: 'unavailable', status: 422, problem: { code: 'work_read_budget_exceeded' } },
    sections: { ok: false, moved: false, failure: 'unavailable', status: 422, problem: { code: 'work_read_budget_exceeded' } },
  },
  globals: { viewport: { value: 'desktop1440' } },
  async play({ canvasElement }) { await expectUnavailableRegions(canvasElement, 'en'); },
};
export const FailedSimplifiedChinesePhone: Story = {
  args: { ...props('zh-Hans'), ...Failed.args },
  globals: { locale: 'zh-Hans', theme: 'dark', viewport: { value: 'phone' } },
  async play({ canvasElement }) { await expectUnavailableRegions(canvasElement, 'zh-Hans'); },
};

const regionLabels = {
  en: { recommendations: 'Recommendations', results: 'All results', unavailable: 'Couldn’t load this list.', retry: 'Try again', sites: 'New sites' },
  'zh-Hans': { recommendations: '推荐内容', results: '全部结果', unavailable: '无法加载此列表。', retry: '重试', sites: '新网站' },
};
async function expectUnavailableRegions(canvasElement: HTMLElement, locale: keyof typeof regionLabels) {
  const canvas = within(canvasElement), labels = regionLabels[locale];
  for (const name of [labels.recommendations, labels.results]) {
    const region = within(canvas.getByRole('region', { name }));
    await expect(region.getByRole('heading', { name, level: 2 })).toBeVisible();
    await expect(region.getByRole('alert')).toHaveTextContent(labels.unavailable);
    await expect(region.getByRole('button', { name: labels.retry })).toBeVisible();
  }
  // A failed group response identifies no individual section or successful rows.
  await expect(canvas.queryByRole('heading', { name: labels.sites })).toBeNull();
  await expect(canvas.queryByRole('list')).toBeNull();
}
async function expectPreparingRegions(canvasElement: HTMLElement, locale: keyof typeof regionLabels) {
  const canvas = within(canvasElement), labels = regionLabels[locale];
  for (const name of [labels.recommendations, labels.results]) {
    const region = within(canvas.getByRole('region', { name }));
    await expect(region.getByRole('heading', { name, level: 2 })).toBeVisible();
    await expect(region.getByRole('status')).toHaveAttribute('aria-busy', 'true');
    await expect(region.queryByRole('alert')).toBeNull();
  }
  await expect(canvas.queryByRole('heading', { name: labels.sites })).toBeNull();
}
export const PreparingRecommendations: Story = {
  args: {
    results: { ok: false, moved: false, pending: true, status: 202 },
    sections: { ok: false, moved: false, pending: true, status: 202 },
  },
  globals: { viewport: { value: 'phone' } },
  async play({ canvasElement }) { await expectPreparingRegions(canvasElement, 'en'); },
};
export const PreparingRecommendationsSimplifiedChinese: Story = {
  args: { ...props('zh-Hans'), ...PreparingRecommendations.args },
  globals: { locale: 'zh-Hans', viewport: { value: 'desktop1440' } },
  async play({ canvasElement }) { await expectPreparingRegions(canvasElement, 'zh-Hans'); },
};
export const FailedSelectedSection: Story = {
  args: { state: { ...emptyBrowse, section: 'sites' }, results: null, sections: Failed.args!.sections },
  globals: { viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement), section = within(canvas.getByRole('region', { name: 'New sites' }));
    await expect(section.getByRole('heading', { name: 'New sites', level: 2 })).toBeVisible();
    await expect(section.getByRole('alert')).toHaveTextContent('Couldn’t load this list.');
    await expect(canvas.queryByRole('region', { name: 'Recommendations' })).toBeNull();
    await expect(canvas.queryByRole('region', { name: 'All results' })).toBeNull();
  },
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
