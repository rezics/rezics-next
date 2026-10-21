import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import { copyOf } from '../recipe-editor/messages.ts';
import { stateOf } from '../recipe-editor/model.ts';
import { Preview } from '../recipe-editor/preview.tsx';
import { recipeEditHref } from '../recipe-editor/route.ts';
import { messages } from './messages.ts';
import type { RecipeWorkPage } from './types.ts';
import { RecipeExperience, RecipeReadFailure } from './types/recipe.tsx';

type State = 'empty' | 'non-nutrient' | 'nutrient' | 'unstructured' | 'unavailable' | 'draft';
const work = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const revision = 'https://rezics.com/id/00000000-0000-4000-8000-000000000002';
const ingredient = 'https://rezics.com/id/00000000-0000-4000-8000-000000000003';
const step = 'https://rezics.com/id/00000000-0000-4000-8000-000000000004';
const href = `/v1/recipes/works/${work.slice(-36)}`;

/** Isolated component states, not captured corpus responses or original C30 product proof. */
const recipe: RecipeWorkPage = {
  profile: 'recipe-work-page-v1', structure: work, revision, instructions: [], measures: [],
  occurrences: [
    { occurrence: ingredient, parent: work, role: 'ingredient', state: 'active', labels: [], introducedBy: revision,
      qualifier: { type: 'ingredient-line', originalText: { value: '2 carrots', language: 'en' },
        amount: { numerator: 2, denominator: 1 }, optional: false, scaling: 'linear', substituteFor: [], parseStatus: 'parsed' } },
    { occurrence: step, parent: work, role: 'step', state: 'active', labels: [], introducedBy: revision,
      qualifier: { type: 'recipe-step', instructionText: { value: 'Slice the carrots, then simmer until tender.', language: 'en' },
        usesIngredient: [ingredient], media: [], scaling: 'linear' } },
  ],
  ingredients: [{ occurrence: ingredient, originalText: '2 carrots', line: '2 carrots',
    amount: { numerator: 2, denominator: 1 }, scaled: false }],
  cost: { pages: 1, pagesRead: 1, occurrences: 2 },
};
const declaredNutrient: RecipeWorkPage['measures'][number] = {
  kind: 'nutrient', value: { numerator: 42, denominator: 1 }, unitText: 'kcal',
  basis: 'per-serving', coverage: 'partial', provenance: 'declared',
};
const nonNutrient: RecipeWorkPage['measures'][number] = {
  kind: 'yield', value: { numerator: 1, denominator: 1 }, unitText: 'pot',
  basis: 'whole-recipe', coverage: 'complete', provenance: 'declared',
};

function NutritionState({ state, locale }: { state: State; locale: UiLocale }) {
  const t = messages[locale];
  const page = state === 'nutrient' ? { ...recipe, measures: [declaredNutrient] }
    : state === 'non-nutrient' ? { ...recipe, measures: [nonNutrient] } : recipe;
  return <main className="mx-auto grid max-w-4xl gap-6 p-4 sm:p-8">
    <h1 className="font-work-title text-2xl font-semibold">Carrot soup</h1>
    {state === 'unavailable' ? <RecipeReadFailure failure="unavailable" messages={t} />
      : state === 'draft' ? <Preview state={stateOf(null)} title="Carrot soup" description="" notes="" language="en"
        t={copyOf(locale)} messages={t} />
        : <RecipeExperience resource={work} initial={state === 'unstructured' ? null : page} href={href}
          actingSubject={null} text={null} locale={locale} messages={t}
          edit={state === 'unstructured' ? { href: recipeEditHref(work), label: 'Edit recipe' } : null}
          readPage={async () => { throw new Error('This isolated component story does not read a backend'); }} />}
  </main>;
}

const meta = {
  title: 'Work page/Recipe nutrition absence (isolated)', component: NutritionState,
  args: { state: 'empty', locale: 'en' }, globals: { viewport: { value: 'desktop' } },
  parameters: { controls: { disable: true }, docs: { description: { component:
    'Isolated regression states for successful empty nutrient manifests and their unknown/failure boundaries. These synthetic inputs do not prove the original catalogue C30 or positive nutrition and substitution rendering.' } } },
} satisfies Meta<typeof NutritionState>;
export default meta;
type Story = StoryObj<typeof meta>;

const knownEmpty: NonNullable<Story['play']> = async ({ canvasElement, args }) => {
  const canvas = within(canvasElement);
  const nutrition = canvas.getByRole('region', { name: messages[args.locale].recipeNutrition });
  await expect(nutrition).toBeVisible();
  await expect(nutrition).toHaveTextContent(messages[args.locale].recipeNutritionNotProvided);
  await expect(canvas.getByText('2 carrots', { exact: true, selector: '[data-ingredient]' })).toBeVisible();
  await expect(canvas.getByText('Slice the carrots, then simmer until tender.', { exact: true })).toBeVisible();
  await expect(canvas.getByRole('main')).not.toHaveTextContent(/healthy|healthier|low[- ]fat|zero calories|\bkcal\b/i);
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
};
const noFalseAbsence: NonNullable<Story['play']> = async ({ canvasElement, args }) => {
  const canvas = within(canvasElement);
  await expect(canvas.queryByRole('region', { name: messages[args.locale].recipeNutrition })).not.toBeInTheDocument();
  await expect(canvas.queryByText(messages[args.locale].recipeNutritionNotProvided, { exact: true })).not.toBeInTheDocument();
};

export const KnownEmpty: Story = { play: knownEmpty };
export const KnownEmptyPhone: Story = { ...KnownEmpty, globals: { viewport: { value: 'phone' } } };
export const KnownEmptyChinesePhone: Story = { ...KnownEmptyPhone, args: { locale: 'zh-Hans' }, globals: {
  locale: 'zh-Hans', viewport: { value: 'phone' } } };
export const OtherMeasuresStillHaveNoNutrients: Story = { args: { state: 'non-nutrient' }, play: knownEmpty };
export const NutrientPresentIsNotAbsent: Story = {
  args: { state: 'nutrient' },
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('region', { name: messages[args.locale].recipeNutrition })).toBeVisible();
    await expect(canvas.queryByText(messages[args.locale].recipeNutritionNotProvided, { exact: true })).not.toBeInTheDocument();
    await expect(canvas.getByRole('cell', { name: '42 kcal' })).toBeVisible();
    await expect(canvas.getByText('2 carrots', { exact: true, selector: '[data-ingredient]' })).toBeVisible();
  },
};
export const UnstructuredIsUnknown: Story = {
  args: { state: 'unstructured' },
  async play(context) {
    await noFalseAbsence(context);
    const canvas = within(context.canvasElement);
    await expect(canvas.getByText(messages.en.recipeUnavailable)).toBeVisible();
    await expect(canvas.getByText(messages.en.recipeUnstructured)).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Edit recipe' })).toBeVisible();
  },
};
export const UnavailableIsUnknown: Story = {
  args: { state: 'unavailable' },
  async play(context) {
    await noFalseAbsence(context);
    const canvas = within(context.canvasElement);
    await expect(canvas.getByRole('alert')).toHaveTextContent(messages.en.regionUnavailable);
    await expect(canvas.getByRole('button', { name: messages.en.retry })).toBeVisible();
  },
};
export const UnstructuredEditorPreviewIsUnknown: Story = {
  args: { state: 'draft' },
  async play(context) {
    await noFalseAbsence(context);
    await expect(within(context.canvasElement).getByRole('article', { name: copyOf('en').previewHeading })).toBeVisible();
  },
};
