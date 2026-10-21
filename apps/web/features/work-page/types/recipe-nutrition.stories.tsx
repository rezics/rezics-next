import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import type { UiLocale } from '../../../i18n/define.ts';
import { SubjectSources } from '../../entity-page/sources.tsx';
import { messages } from '../messages.ts';
import { RecipeExperience, RecipeNutritionSources, type RecipePresentation } from './recipe.tsx';
import { CookThisButton } from './actions.tsx';
import { nutrientNames, nutritionEvidence, nutritionPage, nutritionWork } from './recipe-nutrition.fixtures.ts';
import { recipeNutritionMessages } from './recipe-nutrition-messages.ts';

const initialRecipe = nutritionPage();
let answerDelayedPresentation: ((value: RecipePresentation) => void) | undefined;

function NativeNutrition({ locale, named = true, metadata = 'direct', cook = false }: {
  locale: UiLocale; named?: boolean; metadata?: 'direct' | 'pending' | 'rejected' | 'delayed'; cook?: boolean;
}) {
  const [page, setPage] = useState(initialRecipe);
  const [presentation] = useState(() => {
    if (metadata === 'direct') return undefined;
    if (metadata === 'delayed') return new Promise<RecipePresentation>(resolve => { answerDelayedPresentation = resolve; });
    const promise = metadata === 'pending' ? new Promise<RecipePresentation>(() => {})
      : Promise.reject<RecipePresentation>(new Error('Name and author owner unavailable'));
    void promise.catch(() => {});
    return promise;
  });
  const names = named ? nutrientNames : new Map();
  return <div className="mx-auto grid w-full max-w-4xl gap-8 p-4 sm:p-6"><main>
    {cook ? <CookThisButton label={messages[locale].cookThis} workRef={nutritionWork.slice(-36)}
      recipeHref="/v1/recipes/works/00000000-0000-4000-8000-000000000001" /> : null}
    <RecipeExperience resource={nutritionWork} initial={initialRecipe} href="/v1/recipes/works/00000000-0000-4000-8000-000000000001"
      actingSubject={null} text={null} locale={locale} messages={messages[locale]} names={names}
      authors={named ? ['Actual recipe author'] : []} presentation={presentation} readPage={async query => {
        const next = nutritionPage(query.servings ?? 2);
        setPage(next);
        return { data: next, error: null };
      }} /></main>
    <SubjectSources locale={locale}><RecipeNutritionSources page={page} names={names} locale={locale} messages={messages[locale]} /></SubjectSources>
  </div>;
}

const meta = {
  title: 'Work page/Recipe/Native nutrition and substitutions',
  component: NativeNutrition,
  args: { locale: 'en', named: true },
  parameters: { layout: 'fullscreen', docs: { description: { component:
    'Contract-shaped native Recipe component states. The response supplies exact rationals, qualifications, evidence identities and ordered substitution targets; these stories do not claim original C30 corpus acceptance.' } } },
} satisfies Meta<typeof NativeNutrition>;
export default meta;
type Story = StoryObj<typeof meta>;

const retainedFacts: NonNullable<Story['play']> = async ({ canvasElement, args }) => {
  const canvas = within(canvasElement);
  const nutrition = within(canvas.getByRole('region', { name: messages[args.locale].recipeNutrition }));
  const energy = nutrition.getByRole('row', { name: /Energy/ });
  const protein = nutrition.getByRole('row', { name: /Protein/ });
  await expect(energy).toHaveTextContent('210 ½ kcal');
  await expect(energy).toHaveTextContent(recipeNutritionMessages[args.locale].perServing);
  await expect(energy).toHaveTextContent('complete');
  await expect(energy).toHaveTextContent('source-stated');
  await expect(protein).toHaveTextContent('15 g');
  await expect(protein).toHaveTextContent(recipeNutritionMessages[args.locale].wholeRecipe);
  await expect(protein).toHaveTextContent('partial');
  await expect(protein).toHaveTextContent('declared');
  await expect(nutrition.getByRole('row', { name: /Fibre/ })).toHaveTextContent('unknown');
  await expect(energy).toHaveAttribute('data-source-key', nutritionEvidence);
  await expect(protein).toHaveAttribute('data-source-key', nutritionEvidence);
  await expect(nutrition.queryByRole('link')).not.toBeInTheDocument();
  const source = within(canvas.getByRole('contentinfo')).getByRole('link', { name: messages[args.locale].evidence });
  await expect(source).toHaveAttribute('href', nutritionEvidence);
  const substitutions = within(canvas.getByRole('region', { name: recipeNutritionMessages[args.locale].substitutions }));
  await expect(substitutions.getByRole('listitem')).toHaveTextContent('1 turnip');
  await expect(substitutions.getByRole('listitem')).toHaveTextContent('Actual recipe author');
  await expect(substitutions.getAllByRole('link').map(link => link.getAttribute('data-occurrence')))
    .toEqual([nutritionPage().ingredients[1]!.occurrence, nutritionPage().ingredients[0]!.occurrence]);
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
};

export const Declared: Story = { play: retainedFacts };
export const Phone: Story = { ...Declared, globals: { viewport: { value: 'phone' } } };
export const ChinesePhone: Story = { ...Phone, args: { locale: 'zh-Hans' }, globals: {
  locale: 'zh-Hans', viewport: { value: 'phone' } } };
export const PhoneEvidence: Story = {
  ...Phone,
  async play(context) {
    await retainedFacts(context);
    const canvas = within(context.canvasElement);
    for (let index = 0; index < 5; index++) await userEvent.tab();
    const evidence = within(canvas.getByRole('contentinfo')).getByRole('link', { name: messages.en.evidence });
    await expect(evidence).toHaveFocus();
    await expect(evidence).toBeVisible();
  },
};
export const ScaleKeepsQualificationAndEvidence: Story = {
  async play(context) {
    await retainedFacts(context);
    const canvas = within(context.canvasElement);
    const input = canvas.getByRole('spinbutton', { name: messages.en.servings });
    await userEvent.clear(input);
    await userEvent.type(input, '4');
    await userEvent.keyboard('{Enter}');
    const nutrition = within(canvas.getByRole('region', { name: messages.en.recipeNutrition }));
    await expect(nutrition.getByRole('row', { name: /Protein/ })).toHaveTextContent('30 g');
    await expect(nutrition.getByRole('row', { name: /Energy/ })).toHaveTextContent('210 ½ kcal');
    await expect(nutrition.getByRole('row', { name: /Protein/ })).toHaveTextContent('Whole recipe');
    await expect(nutrition.getByRole('row', { name: /Protein/ })).toHaveTextContent('partial');
    await expect(nutrition.getByRole('row', { name: /Protein/ })).toHaveAttribute('data-source-key', nutritionEvidence);
    await expect(within(canvas.getByRole('contentinfo')).getAllByRole('link')).toHaveLength(1);
  },
};
export const UnavailableNamesDoNotInventAttribution: Story = {
  args: { named: false },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const nutrition = within(canvas.getByRole('region', { name: messages.en.recipeNutrition }));
    await expect(nutrition.getAllByText(recipeNutritionMessages.en.unnamedNutrient)).toHaveLength(3);
    await expect(nutrition.queryByText('Energy')).not.toBeInTheDocument();
    await expect(canvas.getByText(messages.en.unknownAuthor)).toBeVisible();
    await expect(canvas.queryByText('Actual recipe author')).not.toBeInTheDocument();
    await expect(canvas.queryByText(messages.en.recipeNutritionNotProvided)).not.toBeInTheDocument();
  },
};

export const PendingMetadataKeepsMethodAndScaling: Story = {
  args: { named: false, metadata: 'pending' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Slice the vegetables, then simmer until tender.')).toBeVisible();
    await expect(canvas.getByText('2 carrots', { selector: '[data-ingredient]' })).toBeVisible();
    await expect(canvas.getByText(messages.en.unknownAuthor)).toBeVisible();
    await expect(canvas.queryByText('Actual recipe author')).not.toBeInTheDocument();
    const input = canvas.getByRole('spinbutton', { name: messages.en.servings });
    await userEvent.clear(input);
    await userEvent.type(input, '4');
    await userEvent.keyboard('{Enter}');
    await expect(canvas.getByText('4 carrots', { selector: '[data-ingredient]' })).toBeVisible();
    const nutrition = within(canvas.getByRole('region', { name: messages.en.recipeNutrition }));
    await expect(nutrition.getByRole('cell', { name: '30 g' })).toBeVisible();
    await expect(canvas.queryByText(messages.en.recipeUnavailable)).not.toBeInTheDocument();
  },
};
export const RejectedMetadataKeepsMethodAndScaling: Story = {
  ...PendingMetadataKeepsMethodAndScaling, args: { named: false, metadata: 'rejected' },
};
export const MetadataArrivesAfterMethod: Story = {
  args: { named: false, metadata: 'delayed' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Slice the vegetables, then simmer until tender.')).toBeVisible();
    const nutrition = within(canvas.getByRole('region', { name: messages.en.recipeNutrition }));
    await expect(nutrition.getAllByText(recipeNutritionMessages.en.unnamedNutrient)).toHaveLength(3);
    await expect(canvas.getByText(messages.en.unknownAuthor)).toBeVisible();
    expect(typeof answerDelayedPresentation).toBe('function');
    answerDelayedPresentation!({ names: nutrientNames, authors: ['Actual recipe author'] });
    await expect(await nutrition.findByRole('row', { name: /Energy/ })).toBeVisible();
    await expect(canvas.getByText('Actual recipe author')).toBeVisible();
    await expect(canvas.queryByText(messages.en.unknownAuthor)).not.toBeInTheDocument();
    await expect(canvas.getByText('Slice the vegetables, then simmer until tender.')).toBeVisible();
  },
};

export const CookingRetainsDeclaredNutritionAndAlternatives: Story = {
  args: { cook: true },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: messages.en.cookThis }));
    const dialog = within(await canvas.findByRole('dialog', { name: messages.en.cookMode }));
    const nutrition = within(dialog.getByRole('region', { name: messages.en.recipeNutrition }));
    await expect(nutrition.getByRole('row', { name: /Energy/ })).toHaveTextContent('210 ½ kcal');
    await expect(nutrition.getByRole('row', { name: /Protein/ })).toHaveTextContent('Whole recipe');
    await expect(nutrition.getByRole('row', { name: /Fibre/ })).toHaveTextContent('unknown');
    const alternative = dialog.getByText('1 turnip', { selector: '[data-ingredient]' }).closest('li')!;
    await expect(alternative).toHaveTextContent(recipeNutritionMessages.en.substitutions);
    const substitutions = within(dialog.getByRole('region', { name: recipeNutritionMessages.en.substitutions }));
    await expect(substitutions.getByText('Actual recipe author')).toBeVisible();
    const links = substitutions.getAllByRole('link');
    await expect(links.map(link => link.getAttribute('data-occurrence')))
      .toEqual([nutritionPage().ingredients[1]!.occurrence, nutritionPage().ingredients[0]!.occurrence]);
    for (const link of links) {
      const target = document.getElementById(decodeURIComponent(link.getAttribute('href')!.slice(1)));
      await expect(target).toBeVisible();
      await expect(canvas.getByRole('dialog')).toContainElement(target);
    }
    await expect(nutrition.queryByRole('link')).not.toBeInTheDocument();
    await expect(dialog.getByRole('link', { name: messages.en.evidence })).toHaveAttribute('href', nutritionEvidence);
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};
export const CookingNutritionPhone: Story = {
  ...CookingRetainsDeclaredNutritionAndAlternatives, globals: { viewport: { value: 'phone' } },
  async play(context) {
    await CookingRetainsDeclaredNutritionAndAlternatives.play!(context);
    const dialog = within(within(context.canvasElement).getByRole('dialog'));
    dialog.getByRole('region', { name: recipeNutritionMessages.en.substitutions }).scrollIntoView();
    await expect(dialog.getByRole('link', { name: messages.en.evidence })).toBeVisible();
  },
};
