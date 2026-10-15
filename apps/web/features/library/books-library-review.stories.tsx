import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import recorded from './books-library-recorded.stories.tsx';
import { BooksLibraryRecorded } from './books-library-recorded-page.tsx';
import { messages } from './messages.ts';
import ja from './messages/ja.ts';

const meta = {
  ...recorded,
  title: 'Library/Recorded books Japanese',
  component: BooksLibraryRecorded,
  parameters: { ...recorded.parameters,
    viewport: { options: { desktop: { name: 'Desktop (1440 × 900)', styles: { width: '1440px', height: '900px' }, type: 'desktop' } } } },
  args: { ...recorded.args, locale: 'ja', messages: { ...messages, ...ja } },
  globals: { locale: 'ja', viewport: { value: 'desktop' } },
} satisfies Meta<typeof BooksLibraryRecorded>;
export default meta;
type Story = StoryObj<typeof meta>;

export const OwnerDesktop: Story = {
  async play({ canvasElement }) {
    await expect(within(canvasElement).findByRole('heading', { level: 1, name: ja.title })).resolves.toBeVisible();
  },
};
export const OwnerPhone: Story = { ...OwnerDesktop, globals: { locale: 'ja', viewport: { value: 'phone' } } };
export const OwnerEnglishDesktop: Story = { args: { locale: 'en', messages },
  globals: { locale: 'en', viewport: { value: 'desktop' } },
  async play({ canvasElement }) {
    await expect(within(canvasElement).findByRole('heading', { level: 1, name: messages.title })).resolves.toBeVisible();
  } };

export const ShelvesJapaneseDesktop: Story = {
  async play({ canvasElement }) {
    const shelves = await within(canvasElement).findByRole('navigation', { name: ja.shelves });
    shelves.scrollIntoView({ block: 'start' });
    await expect(within(canvasElement).getByRole('region', { name: ja.reading })).toBeVisible();
  },
};
export const ShelvesJapanesePhone: Story = { ...ShelvesJapaneseDesktop,
  globals: { locale: 'ja', viewport: { value: 'phone' } } };
export const ShelvesEnglishDesktop: Story = { args: { locale: 'en', messages },
  globals: { locale: 'en', viewport: { value: 'desktop' } },
  async play({ canvasElement }) {
    const shelves = await within(canvasElement).findByRole('navigation', { name: messages.shelves });
    shelves.scrollIntoView({ block: 'start' });
    await expect(within(canvasElement).getByRole('region', { name: messages.reading })).toBeVisible();
  } };
export const ShelvesEnglishPhone: Story = { ...ShelvesEnglishDesktop,
  globals: { locale: 'en', viewport: { value: 'phone' } } };
