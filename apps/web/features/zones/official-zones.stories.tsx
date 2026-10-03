import type { ZonePackage } from '@rezics/zone-sdk';
import { spaceHref, zoneMemberHref } from '../address/path.ts';
import { localizedPath } from '../../i18n/locale.ts';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import aiWorkshop from '../../zones/official/ai-workshop/index.tsx';
import books from '../../zones/official/books/index.tsx';
import mods from '../../zones/official/mods/index.tsx';
import type { UiLocale } from '../../i18n/define.ts';
import { RealmPageStory } from '../realm/story-page.tsx';
import {
  type Catalogue,
  officialBrowse,
  officialModules,
  officialWorks,
  officialZone,
  type OfficialSlug,
} from './official-fixtures.ts';

const packages: Record<OfficialSlug, ZonePackage> = { books, mods, 'ai-workshop': aiWorkshop };

/** An official Zone's home as `RealmFrame` composes it: through its package, or on its token-and-layout fallback. */
function Page({
  slug,
  look,
  catalogue,
  locale,
}: {
  slug: OfficialSlug;
  look: 'package' | 'fallback';
  catalogue: Catalogue;
  locale: UiLocale;
}) {
  const pkg = look === 'package' ? packages[slug] : null;
  return (
    <RealmPageStory
      site
      zone={officialZone(slug, locale)}
      modules={officialModules(slug, locale, catalogue)}
      locale={locale}
      members={locale === 'zh-Hans' ? '3,204 位成员' : '3,204 members'}
      pkg={pkg}
      browse={officialBrowse(slug, locale, catalogue)}
      execution={pkg ? { mode: 'package', slug } : { mode: 'fallback', reason: 'none-approved' }}
    />
  );
}

const meta = {
  title: 'Zones/Official packages',
  component: Page,
  args: { slug: 'books', look: 'package', catalogue: 'rich', locale: 'en' },
  parameters: { route: { pathname: '/en/z/books' } },
  render: (args, { globals }) => (
    <Page {...args} locale={(globals.locale as UiLocale | undefined) ?? args.locale} />
  ),
} satisfies Meta<typeof Page>;
export default meta;
type Story = StoryObj<typeof meta>;
type Context = Parameters<NonNullable<Story['play']>>[0];

/** Elements that stick out of the page, not counting content inside a scrolling row. */
function overflowing(root: Element): string[] {
  const clipped = (element: Element | null): boolean =>
    !!element &&
    element !== root &&
    (getComputedStyle(element).overflowX !== 'visible' || clipped(element.parentElement));
  return [...root.querySelectorAll('*')]
    .filter(
      (element) =>
        element.getBoundingClientRect().right > innerWidth + 1 && !clipped(element.parentElement),
    )
    .slice(0, 3)
    .map(
      (element) =>
        `${element.tagName.toLowerCase()}.${[...element.classList].slice(0, 6).join('.')}`,
    );
}

/**
 * Every Work the page links keeps its "Why here?" stamp beside it: within a
 * few ancestors of each Work link there is a link to that Work's Decision.
 */
function unstamped(root: Element, slug: OfficialSlug, locale: UiLocale): string[] {
  const hashes = new Map(
    officialWorks(slug, locale, 'rich').map((work) => [
      new URL(work.href, 'https://rezics.invalid').pathname.split('/').at(-1)!,
      `#${work.decision!.split('#')[1]}`,
    ]),
  );
  const links = [...root.querySelectorAll<HTMLAnchorElement>('a[href*="/w/"]')].filter(
    (link) => !link.closest('[aria-hidden="true"]'),
  );
  return links.flatMap((link) => {
    const id = /\/w\/([^/?#]+)/.exec(link.getAttribute('href') ?? '')?.[1];
    const hash = id && hashes.get(id);
    if (!hash) return [link.textContent ?? link.href];
    let scope: Element | null = link;
    for (let depth = 0; scope && depth < 7; depth += 1, scope = scope.parentElement) {
      if (
        [...scope.querySelectorAll('a')].some((anchor) =>
          anchor.getAttribute('href')?.endsWith(hash),
        )
      )
        return [];
    }
    return [link.textContent ?? id];
  });
}

const holds =
  (slug: OfficialSlug) =>
  async ({ canvasElement, globals }: Context) => {
    const locale = (globals.locale as UiLocale | undefined) ?? 'en';
    await expect(unstamped(canvasElement, slug, locale)).toEqual([]);
    await expect(overflowing(canvasElement)).toEqual([]);
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  };

const packageRuns = async (canvasElement: HTMLElement, slug: OfficialSlug) => {
  const scope = canvasElement.querySelector(`[data-zone="${slug}"]`)!;
  await expect(scope).toHaveAttribute('data-zone-mode', 'package');
  await expect(scope.querySelector(`style[data-zone-css="${slug}"]`)).not.toBeNull();
};

const fallbackRuns = async (canvasElement: HTMLElement, slug: OfficialSlug) => {
  const scope = canvasElement.querySelector(`[data-zone="${slug}"]`)!;
  await expect(scope).toHaveAttribute('data-zone-mode', 'fallback');
  await expect(scope.querySelector('style[data-zone-css]')).toBeNull();
  await expect(within(canvasElement).queryByText('Official REZICS Zone')).toBeNull();
  // The platform's hero, shelves and lists carry the same picks.
  await expect(within(canvasElement).getByRole('region', { name: 'Featured' })).toHaveAttribute(
    'aria-roledescription',
    'carousel',
  );
};

const phone = { viewport: { value: 'phone' } };

// Books

/** The literary magazine: nameplate, cover story and contents, paging shelves, columns and a spotlight. */
export const Books: Story = {
  async play(context) {
    const { canvasElement } = context;
    const canvas = within(canvasElement);
    await packageRuns(canvasElement, 'books');
    await expect(canvas.getByRole('heading', { level: 1, name: 'Books' })).toBeVisible();
    await expect(canvas.getByText('Official REZICS Zone')).toBeVisible();
    // Platform controls stay in the package's nameplate.
    await expect(canvas.getByRole('button', { name: 'Page style' })).toBeVisible();
    const cover = canvas.getByRole('region', { name: 'Cover story' });
    await expect(within(cover).getByRole('heading', { level: 3, name: 'Jane Eyre' })).toBeVisible();
    await expect(within(cover).getByText('by Charlotte Brontë')).toBeVisible();
    await expect(
      within(cover).getByRole('link', { name: 'Why Jane Eyre is here' }),
    ).toHaveAttribute('href', `${localizedPath(spaceHref('books', 'community', ['decisions']), 'en')}#decision-jane-eyre`);
    const contents = canvas.getByRole('region', { name: 'In this issue' });
    await expect(within(contents).getAllByRole('listitem')).toHaveLength(3);
    const shelf = canvas.getByRole('region', { name: 'Latest' });
    await expect(within(shelf).getByRole('list', { name: 'Newly added' }).children).toHaveLength(
      10,
    );
    await userEvent.click(within(shelf).getByRole('tab', { name: 'Completed' }));
    await expect(within(shelf).getByRole('list', { name: 'Completed' })).toBeVisible();
    const columns = canvas.getByRole('region', { name: 'Editors’ picks' });
    await expect(
      within(columns).getByRole('heading', {
        level: 3,
        name: 'Classics to start with · 从这里开始读经典',
      }),
    ).toBeVisible();
    await expect(
      within(canvas.getByRole('region', { name: 'Authors to follow' })).getByText(
        'Charlotte Brontë',
      ),
    ).toBeVisible();
    await expect(canvas.getByRole('contentinfo')).toHaveTextContent(
      'Every book in this Zone is here by a public decision.',
    );
    await holds('books')(context);
  },
};

export const BooksDark: Story = { globals: { theme: 'dark' }, play: holds('books') };

export const BooksChinese: Story = {
  globals: { locale: 'zh-Hans' },
  parameters: { route: { pathname: '/zh-Hans/z/books' } },
  async play(context) {
    const canvas = within(context.canvasElement);
    await expect(canvas.getByRole('heading', { level: 1, name: '图书' })).toBeVisible();
    await expect(canvas.getByRole('region', { name: '封面故事' })).toBeVisible();
    await expect(canvas.getByText('Charlotte Brontë 著')).toBeVisible();
    await expect(canvas.getByRole('region', { name: '本期目录' })).toBeVisible();
    await holds('books')(context);
  },
};

export const BooksPhone: Story = { globals: phone, play: holds('books') };

export const BooksPhoneChineseDark: Story = {
  globals: { ...phone, locale: 'zh-Hans', theme: 'dark' },
  parameters: { route: { pathname: '/zh-Hans/z/books' } },
  play: holds('books'),
};

/** What the demo serves today: no credited authors and one pick without a hook. The magazine still holds. */
export const BooksAsSeeded: Story = {
  args: { catalogue: 'seeded' },
  async play(context) {
    const cover = within(context.canvasElement).getByRole('region', { name: 'Cover story' });
    await expect(within(cover).queryByText(/^by /)).toBeNull();
    await holds('books')(context);
  },
};

export const BooksFallback: Story = {
  args: { look: 'fallback' },
  async play(context) {
    await fallbackRuns(context.canvasElement, 'books');
    await expect(
      within(context.canvasElement).getByRole('heading', { level: 1, name: 'Books' }),
    ).toBeVisible();
    await holds('books')(context);
  },
};

export const BooksFallbackPhoneDark: Story = {
  args: { look: 'fallback' },
  globals: { ...phone, theme: 'dark' },
  play: holds('books'),
};

// Mods

const modsRoute = { route: { pathname: '/en/z/mods' } };

/** Mods as result rows: search and status first, then each pick's title, hook and last change. */
export const Mods: Story = {
  args: { slug: 'mods' },
  parameters: modsRoute,
  async play(context) {
    const { canvasElement } = context;
    const canvas = within(canvasElement);
    await packageRuns(canvasElement, 'mods');
    await expect(canvas.getByRole('heading', { level: 1, name: 'Mods' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Page style' })).toBeVisible();
    // The home leads with search and one-filter links into Browse, each with its count.
    const search = canvas.getByRole('search', { name: 'Search Mods' });
    await expect(search).toHaveAttribute('action', '/en/z/mods/browse');
    await expect(canvas.getByRole('link', { name: 'Ongoing 6' })).toHaveAttribute(
      'href',
      '/en/z/mods/browse?status=ongoing',
    );
    await expect(canvas.queryByRole('link', { name: /Fabric \d/ })).toBeNull();
    const featured = canvas.getByRole('region', { name: 'Featured' });
    const lumen = within(featured)
      .getByRole('heading', { level: 3, name: /Lumen Lanterns/ })
      .closest('article')!;
    await expect(within(lumen).getByText('Updated yesterday')).toBeVisible();
    await expect(within(lumen).getByText(/Warm lantern light/)).toBeVisible();
    await expect(lumen.querySelector('[data-release-state]')).toBeNull();
    await expect(within(lumen).queryByText('Fabric')).toBeNull();
    await expect(canvas.queryByRole('link', { name: /^Get / })).toBeNull();
    await expect(
      within(canvas.getByRole('navigation', { name: 'Games and loaders' })).getAllByRole('link'),
    ).toHaveLength(7);
    const trending = canvas.getByRole('region', { name: 'Trending' });
    await expect(within(trending).getByRole('tab', { name: 'Today' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(
      within(trending).getByRole('heading', { level: 3, name: 'Lumen Lanterns' }),
    ).toBeVisible();
    await userEvent.click(within(trending).getByRole('tab', { name: 'This month' }));
    await expect(within(trending).getByRole('tab', { name: 'This month' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    const collection = canvas.getByRole('region', { name: 'Editors’ picks' });
    await expect(within(collection).getByText('· 4 picks')).toBeVisible();
    await holds('mods')(context);
  },
};

export const ModsDark: Story = {
  args: { slug: 'mods' },
  parameters: modsRoute,
  globals: { theme: 'dark' },
  play: holds('mods'),
};

export const ModsChinese: Story = {
  args: { slug: 'mods' },
  globals: { locale: 'zh-Hans' },
  parameters: { route: { pathname: '/zh-Hans/z/mods' } },
  async play(context) {
    const canvas = within(context.canvasElement);
    await expect(canvas.getByRole('heading', { level: 1, name: '模组' })).toBeVisible();
    await expect(canvas.getByRole('search', { name: '搜索模组' })).toBeVisible();
    const featured = canvas.getByRole('region', { name: '精选' });
    await expect(
      within(featured).queryByText('选择游戏版本、加载器和运行端，查看兼容版本'),
    ).toBeNull();
    await expect(featured.querySelector('[data-release-state]')).toBeNull();
    await expect(within(featured).getByText('昨天更新')).toBeVisible();
    await expect(canvas.getByRole('tab', { name: '今日' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await holds('mods')(context);
  },
};

export const ModsPhone: Story = {
  args: { slug: 'mods' },
  parameters: modsRoute,
  globals: phone,
  play: holds('mods'),
};

export const ModsPhoneChineseDark: Story = {
  args: { slug: 'mods' },
  globals: { ...phone, locale: 'zh-Hans', theme: 'dark' },
  parameters: { route: { pathname: '/zh-Hans/z/mods' } },
  play: holds('mods'),
};

/** The demo: package rows beside guides, with titles and hooks and no compatibility chips. */
export const ModsAsSeeded: Story = {
  args: { slug: 'mods', catalogue: 'seeded' },
  parameters: modsRoute,
  async play(context) {
    const latest = within(within(context.canvasElement).getByRole('region', { name: 'Latest' }));
    await expect(
      latest.queryByText('Choose a game version, loader and side to check a release'),
    ).toBeNull();
    await expect(latest.queryByText('Forge')).toBeNull();
    await expect(latest.queryByText('Fabric')).toBeNull();
    await expect(latest.getByRole('link', { name: 'Lumen Lanterns' })).toBeVisible();
    await expect(
      latest.getByRole('link', { name: 'Minecraft shaders: a gentle first setup' }),
    ).toBeVisible();
    await holds('mods')(context);
  },
};

export const ModsFallback: Story = {
  args: { slug: 'mods', look: 'fallback' },
  parameters: modsRoute,
  async play(context) {
    await fallbackRuns(context.canvasElement, 'mods');
    const lumens = within(context.canvasElement)
      .getAllByRole('heading', { level: 3, name: 'Lumen Lanterns' })
      .map((heading) => heading.closest('article')!);
    const withStatus = lumens.filter((article) => within(article).queryByText('Ongoing'));
    await expect(withStatus.length).toBeGreaterThan(0);
    for (const article of lumens) await expect(within(article).queryByText('Fabric')).toBeNull();
    await holds('mods')(context);
  },
};

export const ModsFallbackPhoneDark: Story = {
  args: { slug: 'mods', look: 'fallback' },
  parameters: modsRoute,
  globals: { ...phone, theme: 'dark' },
  play: holds('mods'),
};

// AI Workshop

const workshopRoute = { route: { pathname: '/en/z/ai-workshop' } };

/** Records what the page copies, in place of the system clipboard. */
function clipboard() {
  const copied: string[] = [];
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: (value: string) => {
        copied.push(value);
        return Promise.resolve();
      },
    },
  });
  return copied;
}

const workshopPick = (key: string, catalogue: Catalogue = 'rich') =>
  officialWorks('ai-workshop', 'en', catalogue).find((work) =>
    work.decision?.endsWith(`#decision-${key}`),
  )!;

/**
 * The gallery: copy-first cards with Try it, the shelf as a grid and
 * collections by task. Copy takes the published prompt itself, not a link.
 */
export const AiWorkshop: Story = {
  args: { slug: 'ai-workshop' },
  parameters: workshopRoute,
  async play(context) {
    const { canvasElement } = context;
    const canvas = within(canvasElement);
    await packageRuns(canvasElement, 'ai-workshop');
    await expect(canvas.getByRole('heading', { level: 1, name: 'AI Workshop' })).toBeVisible();
    await expect(
      canvas.getByRole('link', { name: 'Browse every prompt and skill' }),
    ).toHaveAttribute('href', '/en/z/ai-workshop/browse');
    const featured = canvas.getByRole('region', { name: 'Featured' });
    const spotlight = within(featured.querySelector<HTMLElement>('.aw-spotlight')!);
    await expect(spotlight.getByText('Prompt')).toBeVisible();
    await expect(spotlight.getByText(/^Read the following book club notes\./)).toBeVisible();
    await expect(spotlight.getByRole('list', { name: 'Tested with' })).toHaveTextContent(
      'claude-sonnet-5gpt-6-luna',
    );
    const copied = clipboard();
    const copy = spotlight.getByRole('button', { name: 'Copy prompt Book club discussion prompt' });
    await userEvent.click(copy);
    await waitFor(() => expect(copy.nextElementSibling).toHaveTextContent('Prompt copied'));
    await expect(copied).toEqual([workshopPick('club-prompt-v1').hub!.copyText]);
    await expect(
      spotlight.getByRole('link', { name: 'Try it Book club discussion prompt' }),
    ).toHaveAttribute('href', localizedPath(zoneMemberHref('ai-workshop', 'w',
      '00000000-0000-7000-8003-000000000000'), 'en'));
    const collections = canvas.getByRole('region', { name: 'Editors’ picks' });
    await expect(
      within(collections).getByRole('heading', {
        level: 3,
        name: 'Writing and translation · 写作与翻译',
      }),
    ).toBeVisible();
    // A pick that is not a published prompt or Skill still copies its address.
    const link = within(collections).getByRole('button', {
      name: 'Copy link Book club notes assistant',
    });
    await userEvent.click(link);
    await waitFor(() => expect(link.nextElementSibling).toHaveTextContent('Link copied'));
    await expect(copied.at(-1)).toBe(new URL(localizedPath(zoneMemberHref('ai-workshop', 'w',
      '00000000-0000-7000-8003-000000000007'), 'en'), window.location.href).href);
    await holds('ai-workshop')(context);
  },
};

export const AiWorkshopDark: Story = {
  args: { slug: 'ai-workshop' },
  parameters: workshopRoute,
  globals: { theme: 'dark' },
  play: holds('ai-workshop'),
};

export const AiWorkshopChinese: Story = {
  args: { slug: 'ai-workshop' },
  globals: { locale: 'zh-Hans' },
  parameters: { route: { pathname: '/zh-Hans/z/ai-workshop' } },
  async play(context) {
    const canvas = within(context.canvasElement);
    await expect(canvas.getByRole('heading', { level: 1, name: 'AI 工作坊' })).toBeVisible();
    const featured = within(canvas.getByRole('region', { name: '精选' }));
    await expect(
      featured.getByRole('button', { name: '复制提示词 Book club discussion prompt' }),
    ).toBeVisible();
    await expect(
      featured.getByRole('link', { name: '试一试 Book club discussion prompt' }),
    ).toBeVisible();
    await expect(featured.getAllByText('提示词').length).toBeGreaterThan(0);
    await holds('ai-workshop')(context);
  },
};

export const AiWorkshopPhone: Story = {
  args: { slug: 'ai-workshop' },
  parameters: workshopRoute,
  globals: phone,
  play: holds('ai-workshop'),
};

export const AiWorkshopPhoneChineseDark: Story = {
  args: { slug: 'ai-workshop' },
  globals: { ...phone, locale: 'zh-Hans', theme: 'dark' },
  parameters: { route: { pathname: '/zh-Hans/z/ai-workshop' } },
  play: holds('ai-workshop'),
};

/**
 * The demo's two prompts and two Skills, with no tested models recorded: a
 * Skill copies its whole SKILL.md, and every card still tries and shows its stamp.
 */
export const AiWorkshopAsSeeded: Story = {
  args: { slug: 'ai-workshop', catalogue: 'seeded' },
  parameters: workshopRoute,
  async play(context) {
    const canvas = within(context.canvasElement);
    await expect(canvas.queryByRole('list', { name: 'Tested with' })).toBeNull();
    const copied = clipboard();
    const copy = canvas.getAllByRole('button', { name: 'Copy Skill Recipe scaling skill' })[0]!;
    await userEvent.click(copy);
    await waitFor(() =>
      expect(copy.nextElementSibling).toHaveTextContent('Skill instructions copied'),
    );
    await expect(copied).toEqual([workshopPick('recipe-skill-v1', 'seeded').hub!.copyText]);
    await expect(copied[0]).toMatch(/^---\nname: recipe-scaling\n/);
    await holds('ai-workshop')(context);
  },
};

export const AiWorkshopFallback: Story = {
  args: { slug: 'ai-workshop', look: 'fallback' },
  parameters: workshopRoute,
  async play(context) {
    await fallbackRuns(context.canvasElement, 'ai-workshop');
    // The package's copy-first cards are gone; the platform hero still offers a prompt its own verb, "Copy prompt".
    await expect(context.canvasElement.querySelector('.aw-copy')).toBeNull();
    await holds('ai-workshop')(context);
  },
};

export const AiWorkshopFallbackPhoneDark: Story = {
  args: { slug: 'ai-workshop', look: 'fallback' },
  parameters: workshopRoute,
  globals: { ...phone, theme: 'dark' },
  play: holds('ai-workshop'),
};
