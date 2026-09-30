import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { editionMessages, EditionsSection } from './editions.tsx';
import { messages } from './messages.ts';
import type { ShownRelease } from './release.tsx';

const hant: ShownRelease = { id: 'https://rezics.com/id/01944100-0000-7000-8000-0000000000a1',
  revision: 'https://rezics.com/id/01944100-0000-7000-8000-0000000000c1', kind: 'formal', status: 'official',
  contentLanguages: ['zh-Hant'], isTranslation: false, originalLanguages: [], titleLanguage: 'zh-Hant',
  tracklistLanguage: null, title: { value: '紅樓夢 程甲本', language: 'zh-Hant' }, publisher: '萃文書屋',
  publicationYear: 1791, originalUrl: null, fixedRelease: null, coverage: [], snapshots: [] };
const english: ShownRelease = { ...hant, id: 'https://rezics.com/id/01944100-0000-7000-8000-0000000000a3',
  contentLanguages: ['en'], isTranslation: true, originalLanguages: ['zh'], titleLanguage: 'en',
  title: { value: 'The Story of the Stone', language: 'en' }, publisher: 'Penguin', publicationYear: 1973 };
const web: ShownRelease = { ...hant, id: 'https://rezics.com/id/01944100-0000-7000-8000-0000000000b1',
  kind: 'web', contentLanguages: ['zh'], titleLanguage: 'zh', title: { value: '星港夜話', language: 'zh' },
  publisher: null, publicationYear: null, originalUrl: 'https://example.com/star-harbor',
  snapshots: [{ id: 'https://rezics.com/id/01944100-0000-7000-8000-0000000000b2',
    fetchedAt: '2024-03-01T00:00:00.000Z', byteDigest: 'a'.repeat(64), byteLength: 12,
    coverage: { scope: 'chapters 1-10', complete: false }, acquisition: 'fixture' }] };

function Section({ locale }: { locale: 'en' | 'zh-Hans' | 'ja' }) {
  return <div className="mx-auto grid max-w-[46rem] px-4 py-8 sm:px-8">
    <EditionsSection items={[hant, english, web]} failure={null} locale={locale} messages={messages[locale]} />
  </div>;
}

const meta = { title: 'Work page/Editions and releases', component: Section, args: { locale: 'en' } } satisfies Meta<typeof Section>;
export default meta;
type Story = StoryObj<typeof meta>;

export const English: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('region', { name: editionMessages.en.editions })).toBeVisible();
    await expect(canvas.getByRole('heading', { name: '紅樓夢 程甲本' })).toBeVisible();
    await expect(canvas.getByText('Translated from Chinese')).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'https://example.com/star-harbor' })).toBeVisible();
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};

export const SimplifiedChinese: Story = { args: { locale: 'zh-Hans' },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('region', { name: '版本与发行' })).toBeVisible();
  } };

export const Japanese: Story = { args: { locale: 'ja' },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('region', { name: '版とリリース' })).toBeVisible();
  } };
