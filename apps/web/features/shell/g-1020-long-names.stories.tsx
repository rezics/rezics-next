import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { spaceHref } from '../address/path.ts';
import { AppShell } from './app-shell.tsx';
import type { Community, CommunityNavigation } from './communities.ts';
import { CommunityNav } from './community-nav.tsx';
import { messages } from './messages.ts';

const names: Community[] = [
  {
    // ast-grep-ignore: no-assumed-direction-tsx -- Explicit content metadata for the Latin fixture.
    id: 'latin', kind: 'realm', language: 'en', direction: 'ltr',
    name: 'Riverside Historical Society Translation Collective and International Reading Community',
    href: spaceHref('latin', 'community'), icon: null, activity: 'new',
  },
  {
    // ast-grep-ignore: no-assumed-direction-tsx -- Explicit content metadata for the CJK fixture.
    id: 'cjk', kind: 'realm', language: 'zh-Hans', direction: 'ltr',
    name: '世界文学与中文网络小说翻译交流及历史文化研究读者社区',
    href: spaceHref('cjk', 'community'), icon: null, activity: 'none',
  },
  {
    id: 'arabic', kind: 'realm', language: 'ar', direction: 'rtl',
    name: 'مجتمع القراء والمترجمين لدراسة الأدب العالمي والتاريخ والثقافة العربية',
    href: spaceHref('arabic', 'community'), icon: null, activity: 'none',
  },
];
const page = { items: names, complete: true, nextCursor: null };
const data: CommunityNavigation = {
  signedIn: true, avatarQuery: '', followed: null, official: [], moderated: [],
  relationships: { actingSubject: null, hasFollows: true, pinned: page, spaces: page },
};

const meta = {
  title: 'Shell/Community navigation/Long names', component: AppShell,
  args: {
    locale: 'en', messages, theme: 'light', navCollapsed: false, signedIn: true,
    account: null, communities: <CommunityNav data={data} />,
    children: <h1 className="p-6 text-xl">Reading communities</h1>,
  },
  globals: { viewport: { value: 'desktop' } },
  parameters: { route: { pathname: '/en' } },
} satisfies Meta<typeof AppShell>;
export default meta;
type Story = StoryObj<typeof meta>;

async function checkNames(navigation: HTMLElement, collapsed = false) {
  await document.fonts.ready;
  for (const title of ['Pinned', 'Communities and sites']) {
    const section = within(navigation).getByRole('region', { name: title });
    for (const item of names) {
      const accessibleName = item.activity === 'new'
        ? new RegExp(`^${item.name}\\s*, new posts$`)
        : item.name;
      const link = await within(section).findByRole('link', { name: accessibleName });
      await expect(link).toHaveAttribute('title', item.name);
      const label = within(link).getByText(item.name);
      await expect(label).toHaveAttribute('lang', item.language);
      await expect(label).toHaveAttribute('dir', item.direction);
      if (collapsed) continue;
      // Check the rendered boundary, not just the presence of Tailwind classes:
      // the complete text must overflow its own box, inside the row's padding.
      await waitFor(async () => {
        const text = label.getBoundingClientRect();
        const row = link.getBoundingClientRect();
        const nav = navigation.getBoundingClientRect();
        const style = getComputedStyle(link);
        const labelStyle = getComputedStyle(label);
        await expect(row.left).toBeGreaterThanOrEqual(nav.left);
        await expect(row.right).toBeLessThanOrEqual(nav.right);
        await expect(text.left).toBeGreaterThanOrEqual(row.left + parseFloat(style.paddingLeft) - 1);
        await expect(text.right).toBeLessThanOrEqual(row.right - parseFloat(style.paddingRight) + 1);
        await expect(label.clientWidth).toBeGreaterThan(0);
        await expect(label.scrollWidth).toBeGreaterThan(label.clientWidth);
        await expect(labelStyle.textOverflow).toBe('ellipsis');
        await expect(labelStyle.overflowX).toBe('hidden');
        await expect(labelStyle.whiteSpace).toBe('nowrap');
        await expect(labelStyle.direction).toBe(item.direction);
        await expect(link.querySelector('span')!.getBoundingClientRect().width).toBe(24);
      });
    }
  }
  await expect(navigation.scrollWidth).toBeLessThanOrEqual(navigation.clientWidth);
}

export const Desktop: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await checkNames(canvas.getByRole('navigation', { name: 'Main navigation' }));
  },
};

export const Phone: Story = {
  globals: { viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Open navigation' }));
    const dialog = await within(document.body).findByRole('dialog', { name: 'Menu' });
    await waitFor(async () => {
      await expect(dialog).toBeVisible();
      await expect(dialog.getAnimations({ subtree: true }).some(animation => animation.playState === 'running')).toBe(false);
      await expect(within(document.body).getAllByRole('navigation', { name: 'Main navigation' })).toHaveLength(1);
    });
    await checkNames(within(dialog).getByRole('navigation', { name: 'Main navigation' }));
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};

export const Collapsed: Story = {
  args: { navCollapsed: true },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await checkNames(canvas.getByRole('navigation', { name: 'Main navigation' }), true);
    await userEvent.click(canvas.getByRole('button', { name: 'Expand navigation' }));
    await checkNames(canvas.getByRole('navigation', { name: 'Main navigation' }));
  },
};
