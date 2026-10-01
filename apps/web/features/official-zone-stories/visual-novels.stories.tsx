import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import visualNovels from '../../zones/official/visual-novels/index.tsx';
import { RealmPageStory } from '../realm/story-page.tsx';
import { ReleaseBrowse, ReleaseBrowseHeader } from '../release-filter/browse.tsx';
import { parseReleaseFilter } from '../release-filter/state.ts';
import { zoneMessagesFor } from '../zones/fixtures.ts';
import { cardRenderer } from '../zones/zone-home.tsx';
import { type Answer, resolvedFilter, results, zoneFor } from './release-fixtures.ts';
import { hubPlan } from '../work-page/hub.ts';
import { messages as workMessages } from '../work-page/messages.ts';
import { OverviewLayout } from '../work-page/work-frame.tsx';

// The Visual Novels Zone as `RealmBrowseRoute` and the Work page compose it. Cards come from records through
// `releaseWork` (see release-fixtures.ts): each story's filter and its results agree because a Main answer for that
// filter produced them.

function Browse({ locale, params, answer, next = null }: {
  locale: UiLocale; params: Record<string, string>; answer: Answer | null; next?: string | null;
}) {
  const zone = zoneFor('visual-novels', locale);
  const messages = zoneMessagesFor(locale);
  const spec = visualNovels.releaseFilter!(locale);
  const filter = resolvedFilter(spec, locale);
  const state = parseReleaseFilter(params, filter);
  const base = zone.links.browse;
  return <RealmPageStory zone={zone} pkg={visualNovels} execution={{ mode: 'package', slug: 'visual-novels' }} locale={locale}>
    <ReleaseBrowse header={<ReleaseBrowseHeader zone={zone} pkg={visualNovels} spec={spec} filter={filter} state={state}
      base={base} />} spec={spec} filter={filter} state={state} base={base}
    items={answer ? results(answer, locale, state) : []} next={next} locale={locale} messages={messages}
    firstPage="Back to the first page" card={cardRenderer(zone, visualNovels, locale, messages)} />
  </RealmPageStory>;
}

const meta = {
  title: 'Zones/Visual Novels',
  component: Browse,
  args: { locale: 'en', params: { releaseLanguage: 'en', releasePlatform: 'Windows', releaseCompleteness: 'complete' },
    answer: 'windows' },
  parameters: { route: { pathname: '/en/r/visual-novels/browse' } },
  render: (args, { globals }) => <Browse {...args} locale={(globals.locale as UiLocale | undefined) ?? args.locale} />,
} satisfies Meta<typeof Browse>;
export default meta;
type Story = StoryObj<typeof meta>;

const fits = async () => expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);

/** "English + Windows + complete": each result names the release that matched, in the filter's own terms. */
export const Filtered: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('form', { name: 'Find a playable release' })).toBeVisible();
    await expect(canvas.getByRole('combobox', { name: 'Language' })).toHaveTextContent('English');
    await expect(canvas.getByRole('combobox', { name: 'Platform' })).toHaveTextContent('Windows');
    await expect(canvas.getByRole('combobox', { name: 'Completeness' })).toHaveTextContent('Complete');
    await expect(canvas.getByText(/English · Windows · complete · fan translation by/)).toBeVisible();
    await expect(canvas.getByText('Moonlight Translators')).toBeVisible();
    await expect(canvas.getByText('Aoi')).toBeVisible();
    // The Garden's two Windows releases and Crossing's one: three official lines, none for a Switch release.
    const list = within(canvasElement.querySelector<HTMLElement>('[data-release-results]')!);
    await expect(list.getAllByText('English · Windows · complete · official release')).toHaveLength(3);
    await expect(list.queryByText(/Switch/)).toBeNull();
    await expect(canvas.getByRole('link', { name: 'Remove filter: Windows' })).toHaveAttribute('href',
      '/en/r/visual-novels/browse?releaseLanguage=en&releaseCompleteness=complete');
    await fits();
  },
};

/** More releases meet the filter than a card lists: it says so. */
export const MoreMatches: Story = {
  args: { params: { releaseLanguage: 'en', releasePlatform: 'Windows' }, answer: 'many' },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByText('More releases match too.')).toBeVisible();
  },
};

/** A different platform, a different answer: Crossing, through its Switch release. */
export const Switch: Story = {
  args: { params: { releaseLanguage: 'en', releasePlatform: 'Switch' }, answer: 'switch' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('English · Switch · complete · official release')).toBeVisible();
    await expect(within(canvasElement.querySelector<HTMLElement>('[data-release-results]')!).queryByText(/Windows/)).toBeNull();
  },
};

/** Only the language and fan translation are chosen: platform and completeness come from the release, and may be unknown. */
export const ThinRecords: Story = {
  args: { params: { releaseLanguage: 'ja', releaseStatus: 'unofficial' }, answer: 'japaneseFan' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Japanese · completeness unknown · fan translation')).toBeVisible();
    await expect(canvas.queryByText(/ by /)).toBeNull();
  },
};

/** Nothing meets every condition; a translated title alone is not an answer. */
export const NoMatch: Story = {
  args: { params: { releaseLanguage: 'th', releasePlatform: 'Windows' }, answer: null },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: 'No release meets every filter' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Clear all filters' })).toHaveAttribute('href', '/en/r/visual-novels/browse');
  },
};

export const KeepLooking: Story = {
  args: { answer: null, next: 'cursor-2' },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByText(/Nothing in this stretch of the library matched/)).toBeVisible();
  },
};

export const Phone: Story = {
  globals: { viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByText(/English · Windows · complete · fan translation by/)).toBeVisible();
    await fits();
  },
};

export const TraditionalChinese: Story = {
  args: { locale: 'zh-Hant' },
  globals: { locale: 'zh-Hant' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('form', { name: '尋找可玩的發行版' })).toBeVisible();
    await expect(canvas.getByText(/英文 · Windows · 完整 · .*粉絲翻譯/)).toBeVisible();
    await expect(canvas.getByText('Moonlight Translators')).toBeVisible();
  },
};

/** A novel's page leads with where it can be played: the hub's own sections, reordered by the Zone. */
function Hub() {
  const plan = hubPlan({ target: { base: 'work' }, sections: [{ id: 'statements' }, { id: 'releases' }, { id: 'ratings' }] });
  return <OverviewLayout messages={workMessages.en} plan={plan} lead={visualNovels.hubOrder} about={<p>About the novel</p>}
    availability={<p>Where it can be played</p>} scopeBar={null} ratings={<p>Ratings</p>} record={null} />;
}

export const AvailabilityFirst: StoryObj<typeof Hub> = {
  render: () => <Hub />,
  async play({ canvasElement }) {
    const sections = [...canvasElement.querySelectorAll('[data-hub-section]')].map(node => node.getAttribute('data-hub-section'));
    await expect(sections).toEqual(['availability', 'about', 'ratings', 'lists']);
  },
};
