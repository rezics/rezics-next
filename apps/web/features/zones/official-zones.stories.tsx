import type { ZonePackage } from '@rezics/zone-sdk';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import aiWorkshop from '../../zones/official/ai-workshop/index.tsx';
import books from '../../zones/official/books/index.tsx';
import mods from '../../zones/official/mods/index.tsx';
import type { UiLocale } from '../../i18n/define.ts';
import { RealmPageStory } from '../realm/story-page.tsx';
import { type Catalogue, officialModules, officialWorks, officialZone, type OfficialSlug } from './official-fixtures.ts';

const packages: Record<OfficialSlug, ZonePackage> = { books, mods, 'ai-workshop': aiWorkshop };

/** An official Zone's home as `RealmFrame` composes it: through its package, or on its token-and-layout fallback. */
function Page({ slug, look, catalogue, locale }: {
  slug: OfficialSlug; look: 'package' | 'fallback'; catalogue: Catalogue; locale: UiLocale;
}) {
  const pkg = look === 'package' ? packages[slug] : null;
  return <RealmPageStory zone={officialZone(slug, locale)} modules={officialModules(slug, locale, catalogue)}
    locale={locale} members={locale === 'zh-Hans' ? '3,204 位成员' : '3,204 members'} pkg={pkg}
    execution={pkg ? { mode: 'package', slug } : { mode: 'fallback', reason: 'none-approved' }} />;
}

const meta = {
  title: 'Zones/Official packages',
  component: Page,
  args: { slug: 'books', look: 'package', catalogue: 'rich', locale: 'en' },
  parameters: { route: { pathname: '/en/r/books' } },
  render: (args, { globals }) => <Page {...args} locale={(globals.locale as UiLocale | undefined) ?? args.locale} />,
} satisfies Meta<typeof Page>;
export default meta;
type Story = StoryObj<typeof meta>;
type Context = Parameters<NonNullable<Story['play']>>[0];

/** Elements that stick out of the page, not counting content inside a scrolling row. */
function overflowing(root: Element): string[] {
  const clipped = (element: Element | null): boolean => !!element && element !== root
    && (getComputedStyle(element).overflowX !== 'visible' || clipped(element.parentElement));
  return [...root.querySelectorAll('*')].filter(element => element.getBoundingClientRect().right > innerWidth + 1
    && !clipped(element.parentElement)).slice(0, 3)
    .map(element => `${element.tagName.toLowerCase()}.${[...element.classList].slice(0, 6).join('.')}`);
}

/**
 * Every Work the page links keeps its "Why here?" stamp beside it: within a
 * few ancestors of each Work link there is a link to that Work's Decision.
 */
function unstamped(root: Element, slug: OfficialSlug, locale: UiLocale): string[] {
  const hashes = new Map(officialWorks(slug, locale, 'rich').map(work =>
    [work.id.slice(-36), `#${work.decision!.split('#')[1]}`]));
  const links = [...root.querySelectorAll<HTMLAnchorElement>('a[href*="/w/"]')]
    .filter(link => !link.closest('[aria-hidden="true"]'));
  return links.flatMap(link => {
    const id = /\/w\/([0-9a-f-]{36})/.exec(link.getAttribute('href') ?? '')?.[1];
    const hash = id && hashes.get(id);
    if (!hash) return [];
    let scope: Element | null = link;
    for (let depth = 0; scope && depth < 7; depth += 1, scope = scope.parentElement) {
      if ([...scope.querySelectorAll('a')].some(anchor => anchor.getAttribute('href')?.endsWith(hash))) return [];
    }
    return [link.textContent ?? id];
  });
}

const holds = (slug: OfficialSlug) => async ({ canvasElement, globals }: Context) => {
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
  await expect(within(canvasElement).getByRole('region', { name: 'Featured' }))
    .toHaveAttribute('aria-roledescription', 'carousel');
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
    await expect(within(cover).getByRole('link', { name: 'Why Jane Eyre is here' }))
      .toHaveAttribute('href', '/en/r/books/decisions#decision-jane-eyre');
    const contents = canvas.getByRole('region', { name: 'In this issue' });
    await expect(within(contents).getAllByRole('listitem')).toHaveLength(3);
    const shelf = canvas.getByRole('region', { name: 'Latest' });
    await expect(within(shelf).getByRole('list', { name: 'Newly added' }).children).toHaveLength(10);
    await userEvent.click(within(shelf).getByRole('tab', { name: 'Completed' }));
    await expect(within(shelf).getByRole('list', { name: 'Completed' })).toBeVisible();
    const columns = canvas.getByRole('region', { name: 'Editors’ picks' });
    await expect(within(columns).getByRole('heading', { level: 3, name: 'Classics to start with · 从这里开始读经典' }))
      .toBeVisible();
    await expect(within(canvas.getByRole('region', { name: 'Authors to follow' })).getByText('Charlotte Brontë'))
      .toBeVisible();
    await expect(canvas.getByRole('contentinfo')).toHaveTextContent('Every book in this Zone is here by a public decision.');
    await holds('books')(context);
  },
};

export const BooksDark: Story = { globals: { theme: 'dark' }, play: holds('books') };

export const BooksChinese: Story = {
  globals: { locale: 'zh-Hans' },
  parameters: { route: { pathname: '/zh-Hans/r/books' } },
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
  parameters: { route: { pathname: '/zh-Hans/r/books' } }, play: holds('books'),
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
    await expect(within(context.canvasElement).getByRole('heading', { level: 1, name: 'Books' })).toBeVisible();
    await holds('books')(context);
  },
};

export const BooksFallbackPhoneDark: Story = {
  args: { look: 'fallback' }, globals: { ...phone, theme: 'dark' }, play: holds('books'),
};

// Mods

const modsRoute = { route: { pathname: '/en/r/mods' } };

/** The mod hub: games and loaders up front, a trending board and download-first cards. */
export const Mods: Story = {
  args: { slug: 'mods' },
  parameters: modsRoute,
  async play(context) {
    const { canvasElement } = context;
    const canvas = within(canvasElement);
    await packageRuns(canvasElement, 'mods');
    await expect(canvas.getByRole('heading', { level: 1, name: 'Mods' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Page style' })).toBeVisible();
    const featured = canvas.getByRole('region', { name: 'Featured' });
    await expect(within(featured).getByRole('link', { name: 'Get Minecraft shaders: a gentle first setup' }))
      .toBeVisible();
    await expect(within(canvas.getByRole('navigation', { name: 'Games and loaders' })).getAllByRole('link'))
      .toHaveLength(7);
    const trending = canvas.getByRole('region', { name: 'Trending' });
    await expect(within(trending).getByRole('tab', { name: 'Today' })).toHaveAttribute('aria-selected', 'true');
    await userEvent.click(within(trending).getByRole('tab', { name: 'This month' }));
    await expect(within(trending).getByRole('tab', { name: 'This month' })).toHaveAttribute('aria-selected', 'true');
    await expect(within(canvas.getByRole('region', { name: 'Latest' })).getByText(/^\d+ updated this week$/))
      .toBeVisible();
    const collection = canvas.getByRole('region', { name: 'Editors’ picks' });
    await expect(within(collection).getByText('Collection · 4 picks')).toBeVisible();
    await holds('mods')(context);
  },
};

export const ModsDark: Story = { args: { slug: 'mods' }, parameters: modsRoute, globals: { theme: 'dark' },
  play: holds('mods') };

export const ModsChinese: Story = {
  args: { slug: 'mods' },
  globals: { locale: 'zh-Hans' },
  parameters: { route: { pathname: '/zh-Hans/r/mods' } },
  async play(context) {
    const canvas = within(context.canvasElement);
    await expect(canvas.getByRole('heading', { level: 1, name: '模组' })).toBeVisible();
    await expect(within(canvas.getByRole('region', { name: '精选' }))
      .getByRole('link', { name: '获取 Minecraft shaders: a gentle first setup' })).toBeVisible();
    await expect(canvas.getByRole('tab', { name: '今日' })).toHaveAttribute('aria-selected', 'true');
    await holds('mods')(context);
  },
};

export const ModsPhone: Story = { args: { slug: 'mods' }, parameters: modsRoute, globals: phone, play: holds('mods') };

export const ModsPhoneChineseDark: Story = {
  args: { slug: 'mods' }, globals: { ...phone, locale: 'zh-Hans', theme: 'dark' },
  parameters: { route: { pathname: '/zh-Hans/r/mods' } }, play: holds('mods'),
};

/** The demo's three picks, without authors, states or update times: cards keep Get and the stamp. */
export const ModsAsSeeded: Story = {
  args: { slug: 'mods', catalogue: 'seeded' },
  parameters: modsRoute,
  async play(context) {
    await expect(within(context.canvasElement).queryByText(/updated this week$/)).toBeNull();
    await holds('mods')(context);
  },
};

export const ModsFallback: Story = {
  args: { slug: 'mods', look: 'fallback' },
  parameters: modsRoute,
  async play(context) {
    await fallbackRuns(context.canvasElement, 'mods');
    await expect(within(context.canvasElement).queryByRole('link', { name: /^Get / })).toBeNull();
    await holds('mods')(context);
  },
};

export const ModsFallbackPhoneDark: Story = {
  args: { slug: 'mods', look: 'fallback' }, parameters: modsRoute, globals: { ...phone, theme: 'dark' },
  play: holds('mods'),
};

// AI Workshop

const workshopRoute = { route: { pathname: '/en/r/ai-workshop' } };

/** The gallery: copy-first cards with Try it, the shelf as a grid and collections by task. */
export const AiWorkshop: Story = {
  args: { slug: 'ai-workshop' },
  parameters: workshopRoute,
  async play(context) {
    const { canvasElement } = context;
    const canvas = within(canvasElement);
    await packageRuns(canvasElement, 'ai-workshop');
    await expect(canvas.getByRole('heading', { level: 1, name: 'AI Workshop' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Browse every prompt and skill' }))
      .toHaveAttribute('href', '/en/r/ai-workshop/works');
    const featured = canvas.getByRole('region', { name: 'Featured' });
    let copied = '';
    Object.defineProperty(navigator, 'clipboard', { configurable: true,
      value: { writeText: (value: string) => { copied = value; return Promise.resolve(); } } });
    const copy = within(featured).getByRole('button', { name: 'Copy link Book club notes assistant' });
    await userEvent.click(copy);
    await waitFor(() => expect(copy.nextElementSibling).toHaveTextContent('Link copied'));
    await expect(copied).toMatch(/\/w\/00000000-0000-7000-8003-000000000000\?scope=realm/);
    await expect(within(featured).getByRole('link', { name: 'Try it Book club notes assistant' })).toBeVisible();
    const collections = canvas.getByRole('region', { name: 'Editors’ picks' });
    await expect(within(collections).getByRole('heading', { level: 3, name: 'For writers · 写作者的工具箱' }))
      .toBeVisible();
    await holds('ai-workshop')(context);
  },
};

export const AiWorkshopDark: Story = { args: { slug: 'ai-workshop' }, parameters: workshopRoute,
  globals: { theme: 'dark' }, play: holds('ai-workshop') };

export const AiWorkshopChinese: Story = {
  args: { slug: 'ai-workshop' },
  globals: { locale: 'zh-Hans' },
  parameters: { route: { pathname: '/zh-Hans/r/ai-workshop' } },
  async play(context) {
    const canvas = within(context.canvasElement);
    await expect(canvas.getByRole('heading', { level: 1, name: 'AI 工作坊' })).toBeVisible();
    const featured = within(canvas.getByRole('region', { name: '精选' }));
    await expect(featured.getByRole('button', { name: '复制链接 Book club notes assistant' })).toBeVisible();
    await expect(featured.getByRole('link', { name: '试一试 Book club notes assistant' })).toBeVisible();
    await holds('ai-workshop')(context);
  },
};

export const AiWorkshopPhone: Story = { args: { slug: 'ai-workshop' }, parameters: workshopRoute, globals: phone,
  play: holds('ai-workshop') };

export const AiWorkshopPhoneChineseDark: Story = {
  args: { slug: 'ai-workshop' }, globals: { ...phone, locale: 'zh-Hans', theme: 'dark' },
  parameters: { route: { pathname: '/zh-Hans/r/ai-workshop' } }, play: holds('ai-workshop'),
};

/** The demo's four picks, two without a hook: every card still copies, tries and shows its stamp. */
export const AiWorkshopAsSeeded: Story = {
  args: { slug: 'ai-workshop', catalogue: 'seeded' }, parameters: workshopRoute, play: holds('ai-workshop'),
};

export const AiWorkshopFallback: Story = {
  args: { slug: 'ai-workshop', look: 'fallback' },
  parameters: workshopRoute,
  async play(context) {
    await fallbackRuns(context.canvasElement, 'ai-workshop');
    await expect(within(context.canvasElement).queryByRole('button', { name: /^Copy link/ })).toBeNull();
    await holds('ai-workshop')(context);
  },
};

export const AiWorkshopFallbackPhoneDark: Story = {
  args: { slug: 'ai-workshop', look: 'fallback' }, parameters: workshopRoute, globals: { ...phone, theme: 'dark' },
  play: holds('ai-workshop'),
};
