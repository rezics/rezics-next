import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { PostWorkLinks } from './post-work-link.tsx';
import { workHref } from './route.ts';
import { localizedPath } from '../../i18n/locale.ts';

const meta = { title: 'Features/Reader/Also a Work', component: PostWorkLinks,
  args: { locale: 'en', items: [{ work: 'https://rezics.com/id/00000000-0000-4000-8000-000000000001',
    title: { value: 'The last lantern', language: 'en' } }] },
  decorators: [Story => <div className="mx-auto max-w-prose p-4"><p className="mb-6">The chapter ends with one lantern still lit.</p><Story /></div>],
} satisfies Meta<typeof PostWorkLinks>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Identified: Story = { async play({ canvasElement }) {
  const canvas = within(canvasElement);
  await expect(canvas.getByRole('navigation', { name: 'Also a Work' })).toBeVisible();
  await expect(canvas.getByRole('link', { name: 'The last lantern' }))
    .toHaveAttribute('href', localizedPath(workHref('00000000-0000-4000-8000-000000000001'), 'en'));
} };
export const SeveralWorks: Story = { args: { items: [
  { work: 'https://rezics.com/id/00000000-0000-4000-8000-000000000001', title: { value: '夜里的最后一盏灯', language: 'zh-Hans' } },
  { work: 'https://rezics.com/id/00000000-0000-4000-8000-000000000002', title: { value: 'الفانوس الأخير', language: 'ar' } },
], moreHref: '/posts/00000000-0000-4000-8000-000000000003/works' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByRole('link')).toHaveLength(3);
    await expect(canvas.getByText('الفانوس الأخير')).toHaveAttribute('dir', 'rtl');
    await expect(canvas.getByText('夜里的最后一盏灯')).toHaveAttribute('lang', 'zh-Hans');
  } };
export const PhoneChinese: Story = { args: { locale: 'zh-Hans', items: [
  { work: 'https://rezics.com/id/00000000-0000-4000-8000-000000000001',
    title: { value: '在漫长的雨夜里独自等待天明的人和最后一盏不会熄灭的灯', language: 'zh-Hans' } },
] }, globals: { locale: 'zh-Hans', viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('navigation', { name: '也作为独立作品' })).toBeVisible();
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  } };
export const NoIdentification: Story = { args: { items: [] }, async play({ canvasElement }) {
  await expect(within(canvasElement).queryByRole('navigation')).toBeNull();
} };
