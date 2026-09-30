import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { LocalizedText } from './localized-text.tsx';

const meta = {
  title: 'Rezics UI/LocalizedText',
  component: LocalizedText,
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="grid max-w-md gap-3 p-6 text-base">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof LocalizedText>;
export default meta;
type Story = StoryObj<typeof meta>;

/** A Japanese title in a Korean interface keeps `lang="ja"`, so the browser picks Japanese glyphs. */
export const JapaneseTitleInKoreanInterface: Story = {
  args: { text: { value: '吾輩は猫である', language: 'ja', direction: 'ltr' }, as: 'span' },
  render: (args) => (
    <p lang="ko" dir="ltr">
      <span>작품: </span>
      <LocalizedText {...args} />
    </p>
  ),
  play: async ({ canvasElement }) => {
    const title = within(canvasElement).getByText('吾輩は猫である');
    await expect(title).toHaveAttribute('lang', 'ja');
    await expect(title).toHaveAttribute('dir', 'ltr');
  },
};

/** An Arabic Realm name in an English sentence stays in its own order and does not reorder the punctuation around it. */
export const ArabicNameInEnglishSentence: Story = {
  args: { text: { value: 'مكتبة الأدب (الأولى)', language: 'ar', direction: 'rtl' } },
  render: (args) => (
    <p lang="en" dir="ltr">
      Adopted by <LocalizedText {...args} />, 3 Works this week.
    </p>
  ),
  play: async ({ canvasElement }) => {
    const name = within(canvasElement).getByText('مكتبة الأدب (الأولى)');
    await expect(name.tagName).toBe('BDI');
    await expect(name).toHaveAttribute('lang', 'ar');
    await expect(name).toHaveAttribute('dir', 'rtl');
  },
};

/** A Hebrew author in a credit line, between two names in other directions. */
export const HebrewAuthorInCredits: Story = {
  args: { text: { value: 'עמוס עוז', language: 'he', direction: 'rtl' } },
  render: (args) => (
    <p lang="en" dir="ltr">
      Translated by <LocalizedText text={{ value: 'Nicholas de Lange', language: '', direction: 'ltr' }} />,{' '}
      <LocalizedText {...args} />, <LocalizedText text={{ value: '村上春樹', language: 'ja', direction: 'ltr' }} />
    </p>
  ),
  play: async ({ canvasElement }) => {
    const author = within(canvasElement).getByText('עמוס עוז');
    await expect(author).toHaveAttribute('lang', 'he');
    await expect(author).toHaveAttribute('dir', 'rtl');
  },
};

/** When nothing recorded the language, the element says so (`lang=""`) instead of inheriting the interface's. */
export const UnknownLanguageTitle: Story = {
  args: { text: { value: 'Untitled draft', language: '', direction: 'ltr' }, as: 'span' },
  play: async ({ canvasElement }) => {
    const title = within(canvasElement).getByText('Untitled draft');
    await expect(title).toHaveAttribute('lang', '');
    await expect(title).toHaveAttribute('dir', 'ltr');
  },
};
