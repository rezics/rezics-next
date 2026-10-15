import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import reader from './reader.stories.tsx';
import { ChapterReader } from './reader.tsx';
import { messages } from './messages.ts';

const meta = {
  ...reader,
  title: 'Work page/Books chapter review',
  component: ChapterReader,
  parameters: { ...reader.parameters,
    viewport: { options: { desktop: { name: 'Desktop (1440 × 900)', styles: { width: '1440px', height: '900px' }, type: 'desktop' } } } },
  globals: { locale: 'en', viewport: { value: 'desktop' } },
} satisfies Meta<typeof ChapterReader>;
export default meta;
type Story = StoryObj<typeof meta>;

export const EnglishDesktop: Story = {
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('article')).toBeVisible();
  },
};
export const EnglishPhone: Story = { ...EnglishDesktop, globals: { locale: 'en', viewport: { value: 'phone' } } };
export const JapaneseDesktop: Story = { ...EnglishDesktop, args: { locale: 'ja', messages: messages.ja },
  globals: { locale: 'ja', viewport: { value: 'desktop' } } };
export const JapanesePhone: Story = { ...JapaneseDesktop, globals: { locale: 'ja', viewport: { value: 'phone' } } };
