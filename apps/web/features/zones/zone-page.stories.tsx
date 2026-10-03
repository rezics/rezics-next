import { spaceHref } from '../address/path.ts';
import { localizedPath } from '../../i18n/locale.ts';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import fiction from '../../zones/official/fiction/index.tsx';
import type { UiLocale } from '../../i18n/define.ts';
import { RealmPageStory } from '../realm/story-page.tsx';
import type { Execution } from './execution.ts';
import {
  communityModules,
  communityZone,
  fictionModules,
  fictionZone,
  titlesFor,
} from './fixtures.ts';

type Mode = 'package' | 'fallback' | 'safe-mode' | 'standard-look' | 'community';

function Page({ mode, locale }: { mode: Mode; locale: UiLocale }) {
  const members = locale === 'zh-Hans' ? '12,408 位成员' : '12,408 members';
  if (mode === 'community') {
    return (
      <RealmPageStory
        zone={communityZone(locale)}
        modules={communityModules(locale)}
        locale={locale}
        members={locale === 'zh-Hans' ? '约 860 位成员' : 'About 860 members'}
      />
    );
  }
  const execution: Execution =
    mode === 'package'
      ? { mode: 'package', slug: 'fiction' }
      : {
          mode: 'fallback',
          reason:
            mode === 'safe-mode'
              ? 'safe-mode'
              : mode === 'standard-look'
                ? 'viewer-opt-out'
                : 'none-approved',
        };
  const t = titlesFor(locale);
  return (
    <RealmPageStory
      zone={fictionZone(locale)}
      modules={fictionModules(locale)}
      locale={locale}
      members={members}
      pkg={mode === 'package' ? fiction : null}
      execution={execution}
      look={mode !== 'standard-look'}
      navigation={[
        {
          label: t.rankings,
          href: localizedPath(`${spaceHref('fiction', 'site')}#zone-module-charts`, 'en'),
        },
        { label: t.completed, href: localizedPath(spaceHref('fiction', 'site', ['browse']), 'en') },
      ]}
    />
  );
}

const meta = {
  title: 'Zones/Fiction Zone',
  component: Page,
  args: { mode: 'package', locale: 'en' },
  parameters: { route: { pathname: localizedPath(spaceHref('fiction', 'site'), 'en') } },
  render: (args, { globals }) => (
    <Page {...args} locale={(globals.locale as UiLocale | undefined) ?? args.locale} />
  ),
} satisfies Meta<typeof Page>;
export default meta;
type Story = StoryObj<typeof meta>;

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

const noOverflow = async ({ canvasElement }: { canvasElement: HTMLElement }) => {
  await expect(overflowing(canvasElement)).toEqual([]);
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
};

/** The official package runs: its masthead, hero band, chart and footer around platform modules. */
export const Package: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const scope = canvasElement.querySelector('[data-zone="fiction"]')!;
    await expect(scope).toHaveAttribute('data-zone-mode', 'package');
    await expect(scope.querySelector('style[data-zone-css="fiction"]')).not.toBeNull();
    await expect(canvas.getByRole('heading', { level: 1, name: 'Fiction 小说' })).toBeVisible();
    await expect(canvas.getByText('Official REZICS Zone')).toBeVisible();
    // Platform controls stay inside the package header.
    await expect(canvas.getByRole('button', { name: 'Page style' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Home' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    // The chart slot: a podium of three, then the numbered list.
    const chart = canvas.getByRole('region', { name: 'Charts' });
    await expect(
      within(chart).getByRole('list', { name: 'Top of the chart' }).children,
    ).toHaveLength(3);
    // Every pick keeps its "Why here?" stamp, which the package cannot remove.
    await expect(
      within(chart).getByRole('link', { name: 'Why 我在异世界开书店 is here' }),
    ).toHaveAttribute(
      'href',
      localizedPath(`${spaceHref('fiction', 'community', ['decisions'])}#decision-shop`, 'en'),
    );
    await expect(canvas.getByRole('contentinfo')).toHaveTextContent(
      'Every pick in this Zone is a public decision.',
    );
    await noOverflow({ canvasElement });
  },
};

export const PackageDark: Story = { globals: { theme: 'dark' } };

export const PackageChinese: Story = {
  globals: { locale: 'zh-Hans' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1, name: '小说 Fiction' })).toBeVisible();
    await expect(canvas.getByText('REZICS 官方专区')).toBeVisible();
    await expect(canvas.getByRole('link', { name: '首页' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(canvas.getByRole('tab', { name: '日榜' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  },
};

export const PackageChineseDark: Story = { globals: { locale: 'zh-Hans', theme: 'dark' } };

export const PackagePhone: Story = { globals: { viewport: { value: 'phone' } }, play: noOverflow };

export const PackagePhoneChineseDark: Story = {
  globals: { viewport: { value: 'phone' }, locale: 'zh-Hans', theme: 'dark' },
  play: noOverflow,
};

/**
 * No approved package (Main reports none): the Zone's own tokens and layout.
 * Every module is still here; only the package's masthead, chart and footer are not.
 */
export const Fallback: Story = {
  args: { mode: 'fallback' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const scope = canvasElement.querySelector('[data-zone="fiction"]')!;
    await expect(scope).toHaveAttribute('data-zone-mode', 'fallback');
    await expect(scope.querySelector('style[data-zone-css]')).toBeNull();
    await expect(canvas.queryByText('Official REZICS Zone')).toBeNull();
    await expect(canvas.getByRole('heading', { level: 1, name: 'Fiction 小说' })).toBeVisible();
    await expect(canvas.getByRole('region', { name: 'Charts' })).toBeVisible();
    await expect(canvas.getByRole('tab', { name: 'Today' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await noOverflow({ canvasElement });
  },
};

export const FallbackDark: Story = { args: { mode: 'fallback' }, globals: { theme: 'dark' } };
export const FallbackChinese: Story = {
  args: { mode: 'fallback' },
  globals: { locale: 'zh-Hans' },
};
export const FallbackPhone: Story = {
  args: { mode: 'fallback' },
  globals: { viewport: { value: 'phone' } },
  play: noOverflow,
};

/** `?safe`: the fallback, with a note on why and a way back to the full design. */
export const SafeMode: Story = {
  args: { mode: 'safe-mode' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Showing this community’s standard layout')).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Show the full design' })).toHaveAttribute(
      'href',
      localizedPath(spaceHref('fiction', 'site'), 'en'),
    );
  },
};

/** The reader turned Zone designs off: platform colors and type, the same modules. */
export const StandardLook: Story = {
  args: { mode: 'standard-look' },
  async play({ canvasElement }) {
    const scope = canvasElement.querySelector<HTMLElement>('[data-zone="fiction"]')!;
    await expect(scope.style.getPropertyValue('--primary')).toBe('');
    await expect(within(canvasElement).getByRole('region', { name: 'Charts' })).toBeVisible();
  },
};

/**
 * A community Realm with the default layout and the Clean preset: only the
 * modules Main serves today. Rankings have no read yet, so they are absent.
 */
export const CommunityRealm: Story = {
  args: { mode: 'community' },
  parameters: { route: { pathname: localizedPath(spaceHref('classics', 'site'), 'en') } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole('heading', { level: 1, name: 'Classic Literature · 经典文学' }),
    ).toBeVisible();
    await expect(canvas.queryByRole('region', { name: 'Charts' })).toBeNull();
    await expect(canvas.getByRole('region', { name: 'Recent decisions' })).toBeVisible();
    await noOverflow({ canvasElement });
  },
};

export const CommunityRealmDark: Story = {
  args: { mode: 'community' },
  globals: { theme: 'dark' },
  parameters: { route: { pathname: localizedPath(spaceHref('classics', 'site'), 'en') } },
};

export const CommunityRealmChinesePhone: Story = {
  args: { mode: 'community' },
  globals: { locale: 'zh-Hans', viewport: { value: 'phone' } },
  parameters: { route: { pathname: localizedPath(spaceHref('classics', 'site'), 'zh-Hans') } },
  play: noOverflow,
};
