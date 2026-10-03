import { spaceHref } from '../address/path.ts';
import { localizedPath } from '../../i18n/locale.ts';
import type { ZoneModuleType, ZonePreset } from '@rezics/zone-sdk';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import fiction from '../../zones/official/fiction/index.tsx';
import type { UiLocale } from '../../i18n/define.ts';
import {
  communityModules,
  failedRanking,
  fictionModules,
  fictionZone,
  works,
  zoneMessagesFor,
} from './fixtures.ts';
import { presetTokens } from './presentation.ts';
import { zoneTheme } from './theme.ts';
import { isType, type PlacedModule, ZoneHome } from './zone-home.tsx';

/** One module alone on a Zone page, under a preset, optionally through the Fiction package's slot. */
function Module({
  type,
  preset,
  locale,
  rail,
  pkg,
  placed,
}: {
  type: ZoneModuleType;
  preset: ZonePreset;
  locale: UiLocale;
  rail?: boolean;
  pkg?: boolean;
  placed?: PlacedModule;
}) {
  const zone = fictionZone(locale, presetTokens[preset]);
  const found = placed ?? fictionModules(locale).find((candidate) => isType(candidate, type))!;
  const module = {
    ...found,
    module: { ...found.module, rail: rail ?? found.module.rail },
  } as PlacedModule;
  const theme = zoneTheme(zone.tokens, { reader: 'light', enabled: true });
  return (
    <div
      data-zone="fiction"
      className={`${theme.className} min-h-dvh bg-(--zone-page)`}
      style={theme.style}
    >
      <ZoneHome
        modules={[module]}
        zone={zone}
        pkg={pkg ? fiction : null}
        locale={locale}
        messages={zoneMessagesFor(locale)}
        empty={null}
      />
    </div>
  );
}

const meta = {
  title: 'Zones/Modules',
  component: Module,
  args: { type: 'shelf', preset: 'serial', locale: 'en' },
  parameters: { route: { pathname: localizedPath(spaceHref('fiction', 'site'), 'en') } },
  render: (args, { globals }) => (
    <Module {...args} locale={(globals.locale as UiLocale | undefined) ?? args.locale} />
  ),
} satisfies Meta<typeof Module>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Art-directed banners from the Zone's editors, the next one peeking in. */
export const HeroBanners: Story = {
  args: { type: 'hero-carousel' },
  async play({ canvasElement }) {
    const hero = within(canvasElement).getByRole('region', { name: 'Featured' });
    await expect(hero).toHaveAttribute('aria-roledescription', 'carousel');
    await expect(within(hero).getAllByRole('listitem')).toHaveLength(3);
    await expect(within(hero).getByRole('listitem', { name: '1 of 3' })).toBeVisible();
  },
};

export const HeroBannersPhone: Story = {
  args: { type: 'hero-carousel' },
  globals: { viewport: { value: 'phone' } },
};

/** Without banners, the hero shows the newest picks: cover, hook, "Start reading" and the Decision stamp. */
export const HeroPicks: Story = {
  args: { type: 'hero-carousel', preset: 'clean' },
  render: (args, { globals }) => {
    const locale = (globals.locale as UiLocale | undefined) ?? 'en';
    return <Module {...args} locale={locale} placed={communityModules(locale)[0]} />;
  },
  async play({ canvasElement }) {
    const hero = within(canvasElement).getByRole('region', { name: 'Featured' });
    await expect(within(hero).getAllByRole('link', { name: /Start reading/ })).toHaveLength(3);
    await expect(within(hero).getAllByRole('link', { name: /^Why .* is here$/ })).toHaveLength(3);
  },
};

/** Each pick's one action in its kind's verb: open a recipe, copy a prompt, install a mod, read a book. */
export const HeroPicksByKind: Story = {
  args: { type: 'hero-carousel', preset: 'clean' },
  render: (args, { globals }) => {
    const [recipe, prompt, mod, book] = works;
    const picks = [
      { ...recipe!, kind: 'recipe' as const },
      {
        ...prompt!,
        kind: 'document' as const,
        hub: {
          kind: 'prompt' as const,
          preview: { value: 'Ask three questions…', lang: 'en', dir: 'ltr' as const },
          copyText: 'Ask three questions about the chapter.',
          testedModels: [],
        },
      },
      { ...mod!, kind: 'package' as const },
      book!,
    ];
    const placed = {
      module: {
        id: 'picks',
        type: 'hero-carousel',
        title: 'Featured',
        rail: false,
        layout: 'covers',
        shuffle: false,
        more: null,
      },
      state: {
        state: 'ready',
        data: {
          banners: picks.map((work) => ({
            id: work.id,
            title: work.title!,
            href: work.href,
            image: null,
            work,
          })),
        },
      },
    } as PlacedModule;
    return (
      <Module {...args} locale={(globals.locale as UiLocale | undefined) ?? 'en'} placed={placed} />
    );
  },
  async play({ canvasElement }) {
    const hero = within(canvasElement).getByRole('region', { name: 'Featured' });
    const slides = within(hero).getAllByRole('listitem');
    await expect(within(slides[0]!).getByRole('link', { name: 'Open recipe' })).toBeVisible();
    await expect(
      within(slides[1]!).getByRole('button', { name: 'Copy prompt' }),
    ).toBeInTheDocument();
    await expect(within(slides[2]!).getByRole('link', { name: 'Install' })).toBeInTheDocument();
    await expect(
      within(slides[3]!).getByRole('link', { name: 'Start reading' }),
    ).toBeInTheDocument();
    await expect(hero).not.toHaveTextContent(/Start reading.*Start reading/);
  },
};

export const HeroPicksPhoneDark: Story = {
  ...HeroPicks,
  play: undefined,
  globals: { viewport: { value: 'phone' }, theme: 'dark' },
};

/** Genre entry points: one row of chips that scrolls on phones. */
export const GenreChips: Story = {
  args: { type: 'chip-nav' },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('navigation', { name: 'Genres' })).toBeVisible();
  },
};

export const Announcement: Story = {
  args: { type: 'announcement' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Dismiss' }));
    await expect(canvas.queryByRole('complementary')).toBeNull();
  },
};

const overlaps = (a: DOMRect, b: DOMRect) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/**
 * The Zone's marks, the chart position and the "Why here?" stamp, sit beside
 * each tile's title and never on its cover, whose own title they would hide.
 */
async function marksBesideTitles(region: HTMLElement) {
  const tiles = [...region.querySelectorAll<HTMLElement>('article')];
  await expect(tiles.length).toBeGreaterThan(0);
  for (const tile of tiles) {
    const cover = tile.querySelector('[data-slot="work-cover"]')!.getBoundingClientRect();
    const title = tile.querySelector('h3')!.getBoundingClientRect();
    const stamp = within(tile).queryByRole('link', { name: /^Why .* is here$/ });
    const rank = within(tile).queryByText(/^No\. \d+$/)?.parentElement;
    for (const mark of [stamp, rank]) {
      if (!mark) continue;
      const box = mark.getBoundingClientRect();
      await expect(overlaps(box, cover)).toBe(false);
      // Beside the title: on its line, not under the author or the hook.
      await expect(box.top).toBeLessThan(title.bottom);
    }
  }
}

/** An editors' shelf with "Shuffle": the next seven picks, like KadoKado's 换一换. */
export const ShelfWithShuffle: Story = {
  args: { type: 'shelf' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const shelf = canvas.getByRole('region', { name: 'Can’t-miss picks (✧∇✧)' });
    await marksBesideTitles(shelf);
    // The stamp carries its words, "Why it’s here", shown on hover and focus (CSS, which a synthetic hover cannot
    // reach) and kept out of its accessible name, which names the Work.
    const stamp = within(shelf).getAllByRole('link', { name: /^Why .* is here$/ })[0]!;
    const label = within(stamp).getByText('Why it’s here');
    await expect(label).toHaveAttribute('aria-hidden', 'true');
    await expect(getComputedStyle(label).opacity).toBe('0');
    await expect(within(shelf).getByRole('heading', { level: 3, name: '星河旅店' })).toBeVisible();
    await userEvent.click(within(shelf).getByRole('button', { name: 'Shuffle' }));
    await expect(
      within(shelf).getByRole('heading', { level: 3, name: '玄门小道士' }),
    ).toBeVisible();
    await expect(within(shelf).queryByRole('heading', { level: 3, name: '星河旅店' })).toBeNull();
  },
};

/** Latest updates in three tabs: new chapters, newly added and completed. */
export const LatestTabs: Story = {
  render: (_, { globals }) => {
    const locale = (globals.locale as UiLocale | undefined) ?? 'en';
    return (
      <Module
        type="shelf"
        preset="serial"
        locale={locale}
        placed={fictionModules(locale).filter((placed) => isType(placed, 'shelf'))[1]}
      />
    );
  },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('tab', { name: 'New chapters' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(canvas.getAllByText('Ongoing').length).toBeGreaterThan(0);
    await userEvent.click(canvas.getByRole('tab', { name: 'Completed' }));
    await expect(canvas.getByRole('heading', { level: 3, name: '剑与茶' })).toBeVisible();
  },
};

/** Rankings by day, week and month; the top three wear the accent. */
export const Rankings: Story = {
  args: { type: 'ranking' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('tab', { name: 'Today' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(canvas.getByText('No. 1')).toBeInTheDocument();
    await marksBesideTitles(canvas.getByRole('tabpanel'));
    await userEvent.click(canvas.getByRole('tab', { name: 'This month' }));
    await expect(canvas.getByRole('tab', { name: 'This month' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  },
};

export const RankingsInTheRail: Story = { args: { type: 'ranking', rail: true } };

/** The Fiction package's chart slot: a podium, then a numbered list; the platform card inside keeps its stamp. */
export const RankingsFictionPackage: Story = {
  args: { type: 'ranking', pkg: true },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('list', { name: 'Top of the chart' }).children).toHaveLength(3);
    await expect(canvas.getAllByRole('link', { name: /^Why .* is here$/ })).toHaveLength(10);
  },
};

export const RankingsFictionPackageDark: Story = {
  args: { type: 'ranking', pkg: true },
  globals: { theme: 'dark' },
};

export const RankingsFictionPackageChinese: Story = {
  args: { type: 'ranking', pkg: true },
  globals: { locale: 'zh-Hans' },
};

/** A module whose read failed keeps its title and offers a retry; the rest of the page is unaffected. */
export const RankingsFailed: Story = {
  args: { type: 'ranking', placed: failedRanking },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('status')).toHaveTextContent('Couldn’t load Charts');
    await expect(canvas.getByRole('button', { name: 'Try again' })).toBeVisible();
  },
};

/** Named editor lists with a blurb, each Work as a row. */
export const EditorsLists: Story = { args: { type: 'editorial-list' } };

/** Reader quotes, each leading to the Work. */
export const ReaderQuotes: Story = {
  args: { type: 'quote-stream' },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getAllByRole('link', { name: /See the work/ })).toHaveLength(
      3,
    );
  },
};

/** New and rising: a plain title list for the rail. */
export const NewAndRising: Story = { args: { type: 'rising', rail: false } };

/** Recent decisions in words; each opens its entry in the Decision log. */
export const RecentDecisions: Story = {
  args: { type: 'decision-log', rail: false },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: 'Added 云端书简' })).toHaveAttribute(
      'href',
      localizedPath(`${spaceHref('fiction', 'community', ['decisions'])}#decision-cloud`, 'en'),
    );
    await expect(canvas.getByRole('link', { name: 'Changed a community rule' })).toBeVisible();
    await expect(
      canvas.getByRole('link', { name: 'Declined a classification of 剑与茶' }),
    ).toBeVisible();
  },
};

export const RecentDecisionsChinese: Story = {
  args: { type: 'decision-log', rail: false },
  globals: { locale: 'zh-Hans' },
};

export const ModulesDark: Story = { args: { type: 'shelf' }, globals: { theme: 'dark' } };
