import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import type { DisplayObligations } from '../rights-mark/rights-mark.tsx';
import { classics } from './fixtures.ts';
import { WorkGrid } from './work-shelf.tsx';
import type { CatalogueWork } from './work.ts';

function rights(instrument: string, notice: string, shareAlike = false): DisplayObligations {
  return { status: 'assessed', use: 'wiki_display', instrument, obligations: [
    { kind: 'attribution', instrument, appliesTo: 'all', notice },
    ...(shareAlike ? [{ kind: 'share_alike' as const, instrument, appliesTo: 'all' as const, notice: null }] : []),
  ] };
}
const works: CatalogueWork[] = [
  { ...classics[0]!, authors: [], tagline: undefined, rating: null, title: { ...classics[0]!.title!, value: 'ONE PIECE' },
    factObligations: rights('https://creativecommons.org/licenses/by-sa/3.0/',
      'Bangumi contributors, https://bgm.tv/subject/975', true) },
  { ...classics[1]!, authors: [], rating: null, title: { ...classics[1]!.title!, value: 'Fate/stay night' }, kind: 'game',
    factObligations: rights('https://opendatacommons.org/licenses/odbl/1-0/',
      'VNDB contributors, https://vndb.org/v11', true) },
  { ...classics[2]!, title: { ...classics[2]!.title!, value: 'Pride and Prejudice' },
    authors: [{ name: 'Jane Austen', href: null }], rating: null,
    factObligations: rights('https://creativecommons.org/publicdomain/zero/1.0/',
    'Open Library contributors, https://openlibrary.org/works/OL66554W') },
  { ...classics[3]!, title: { ...classics[3]!.title!, value: 'Baked Apples' }, kind: 'recipe',
    authors: [{ name: 'Fannie Merritt Farmer', href: null }],
    factObligations: rights('https://www.gutenberg.org/policy/license.html',
      'Fannie Merritt Farmer; Project Gutenberg, https://www.gutenberg.org/ebooks/65061') },
];
const meta = { title: 'Catalogue/Imported source rights', component: WorkGrid,
  args: { works, locale: 'en' as UiLocale },
  render: args => <div className="mx-auto max-w-4xl p-4"><WorkGrid {...args} /></div>,
} satisfies Meta<typeof WorkGrid>;
export default meta;
type Story = StoryObj<typeof meta>;
export const English: Story = { async play({ canvasElement }) {
  const canvas = within(canvasElement);
  await expect(canvas.getByRole('link', { name: 'CC BY-SA 3.0' })).toBeVisible();
  await expect(canvas.getByRole('link', { name: 'ODbL 1.0' })).toBeVisible();
  await expect(canvas.getByRole('link', { name: 'CC0 1.0' })).toBeVisible();
  await expect(canvas.getByRole('link', { name: 'Public domain in the United States' })).toBeVisible();
  await expect(canvasElement.querySelectorAll('[data-rights-mark]')).toHaveLength(4);
} };
export const JapanesePhone: Story = { args: { locale: 'ja' }, globals: { viewport: { value: 'mobile1' } } };
export const German: Story = { args: { locale: 'de' } };
