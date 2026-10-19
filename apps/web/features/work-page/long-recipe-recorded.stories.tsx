import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import type { AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import fixture from '../../../../tests/qa/fixtures/outcomes/recipes/long-recipe.json';
import { browserMainApi, BFF_PREFIX } from '../api/browser.ts';
import { recordedFetch } from '../stories/recorded-fetch.ts';
import { recipePageReader } from './recipe-reading-recorded-page.ts';
import { messages } from './messages.ts';
import { iriOf } from './route.ts';
import { RecipeExperience } from './types/recipe.tsx';
import type { RecipeWorkPage } from './types.ts';

const record = fixture as AnswerRecord;
const first = record.personas.owner[0]!;
const href = new URL(first.path, 'https://recorded.invalid').pathname;
const actingSubject = new URL(first.path, 'https://recorded.invalid').searchParams.get('actingSubject');

/** Public API answers captured by recipe-long.e2e.ts after publishing 80 ingredients and 40 steps. */
function LongRecipe({ locale }: { locale: 'en' | 'ja' }) {
  const [replay] = useState(() => recordedFetch(record, 'owner',
    record.personas.owner.map(sample => ({ label: sample.label, state: 'populated' })), { pathPrefix: BFF_PREFIX }));
  useEffect(() => () => replay.dispose(), [replay]);
  const main = browserMainApi(window.location.origin, { fetcher: replay.fetcher });
  return <main className="mx-auto min-w-0 max-w-6xl p-4 sm:p-8">
    <RecipeExperience resource={iriOf(href.split('/').at(-1)!)} initial={first.answer as RecipeWorkPage} href={href} actingSubject={actingSubject}
      text={null} locale={locale} messages={messages[locale]}
      readPage={recipePageReader({ main, actingSubject }, href)} />
  </main>;
}

const meta = { title: 'Work page/Recorded long recipe', component: LongRecipe,
  args: { locale: 'en' }, globals: { locale: 'en', viewport: { value: 'desktop1440' } },
} satisfies Meta<typeof LongRecipe>;
export default meta;
type Story = StoryObj<typeof meta>;

const continued: Story['play'] = async ({ canvasElement, args }) => {
  const canvas = within(canvasElement);
  const copy = messages[args.locale];
  await expect(canvas.findByText('1 cup dough-01')).resolves.toBeVisible();
  for (let index = 1; index < record.personas.owner.length; index++) {
    await userEvent.click(canvas.getByRole('button', { name: copy.showMoreRecipe }));
    await waitFor(() => expect(canvas.queryByRole('button', { name: copy.loadingMoreRecipe })).toBeNull());
  }
  await expect(canvas.findByText('Step 40', { exact: true })).resolves.toBeVisible();
  await expect(canvas.getByText('1 cup sauce-40')).toBeVisible();
  await expect(canvas.queryByRole('button', { name: copy.showMoreRecipe })).toBeNull();
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  canvas.getByText('Step 40', { exact: true }).scrollIntoView();
};

export const EnglishWide: Story = {};
export const EnglishPhone: Story = { globals: { viewport: { value: 'phone' } } };
export const JapaneseWide: Story = { args: { locale: 'ja' }, globals: { locale: 'ja' } };
export const JapanesePhone: Story = { ...JapaneseWide, globals: { locale: 'ja', viewport: { value: 'phone' } } };
export const ContinuedEnglishWide: Story = { play: continued };
export const ContinuedEnglishPhone: Story = { ...EnglishPhone, play: continued };
export const ContinuedJapaneseWide: Story = { ...JapaneseWide, play: continued };
export const ContinuedJapanesePhone: Story = { ...JapanesePhone, play: continued };
