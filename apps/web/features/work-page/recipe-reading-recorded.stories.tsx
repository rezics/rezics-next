import { readingLine, type IngredientQualifier } from '../recipe-editor/ingredient-line.ts';
import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import recorded from '../../../../tests/qa/fixtures/outcomes/recipes/read-a-recipe.json';
import type { UiLocale } from '../../i18n/define.ts';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import { WorkCredits } from './credits.tsx';
import { messages } from './messages.ts';
import { loadRecipeIdentity, recipePageReader, recipeReadingReads, type RecipeIdentity } from './recipe-reading-recorded-page.ts';
import { RecipeRegionView } from './recipe-reading-recorded-page.tsx';
import { RegionSkeleton } from './region.tsx';
import type { Loaded, RecipeWorkPage } from './types.ts';
import { WorkHeader } from './work-header.tsx';

const record = recorded as AnswerRecord;
type Phase = 'published' | 'loading' | 'private';
function sample(persona: AnswerPersona, label: string) {
  const entry = record.personas[persona].find(item => item.label === label);
  if (!entry) throw new Error(`Missing recipe answer ${persona}/${label}`);
  return entry;
}

/** Header, projection, selected text and recipe body use the production supplied-client boundary. */
function RecordedRecipeReading({ persona, locale, phase }: { persona: AnswerPersona; locale: UiLocale; phase: Phase }) {
  const [view, setView] = useState<{ identity: Extract<RecipeIdentity, { kind: 'ready' }>;
    recipe: Loaded<RecipeWorkPage | null> | null; readPage: ReturnType<typeof recipePageReader> } | null>(null);
  const [fault, setFault] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setView(null); setFault(null);
    const header = sample(persona, 'work-header');
    const url = new URL(header.path, 'https://recorded.invalid');
    const id = url.pathname.split('/').at(-1)!;
    const actingSubject = url.searchParams.get('actingSubject') ?? undefined;
    const selections: RecordedSelection[] = [
      { label: 'work-header', state: 'populated' }, { label: 'page-projection', state: 'populated' },
      { label: 'agent-credits', state: 'populated' }, { label: 'work-credits', state: 'populated' },
      { label: 'recipe-notes-empty', state: 'error' }, { label: 'author-works', state: 'populated' },
      { label: 'recipe-start', state: phase === 'loading' ? 'loading' : 'populated' },
      { label: 'recipe-continuation', state: 'populated' }, { label: 'recipe-scaled-start', state: 'populated' },
      { label: 'recipe-scaled-page-2', state: 'populated' }, { label: 'private-work-refused', state: 'error' },
    ];
    const replay = recordedFetch(record, persona, selections, { pathPrefix: BFF_PREFIX });
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      try { return await replay.fetcher(input, init); }
      catch (error) { if (live && !(error instanceof DOMException && error.name === 'AbortError')) setFault(String(error)); throw error; }
    }) as typeof fetch;
    const main = browserMainApi(window.location.origin, { anonymous: !actingSubject, fetcher });
    const reads = recipeReadingReads({ main, actingSubject });
    void (async () => {
      const identity = await loadRecipeIdentity(reads, id);
      if (identity.kind !== 'ready') throw new Error(`Recipe identity ${identity.kind}`);
      const href = phase === 'private' ? new URL(sample(persona, 'private-work-refused').path,
        'https://recorded.invalid').pathname : identity.href;
      const readPage = recipePageReader({ main, actingSubject }, href);
      if (phase === 'loading') {
        if (live) setView({ identity, recipe: null, readPage });
        void reads.readRecipe(href);
        return;
      }
      const recipe = await reads.readRecipe(href);
      if (live) setView({ identity, recipe, readPage });
    })().catch(error => { if (live) setFault(String(error)); });
    return () => { live = false; replay.dispose(); };
  }, [persona, locale, phase]);
  const t = messages[locale];
  if (fault) return <pre role="alert" className="whitespace-pre-wrap break-words p-6">{fault}</pre>;
  if (!view) return <RegionSkeleton id="recipe-loading" title={t.recipeMethod} label={t.loadingRegion} />;
  const { identity, recipe, readPage } = view;
  return <main className="mx-auto grid min-w-0 max-w-4xl gap-6 p-4 sm:p-8" lang={locale}>
    <p className="break-all text-muted-foreground text-sm">{persona} · {identity.actingSubject ?? 'none'}</p>
    {phase !== 'private' ? <WorkHeader work={identity.header} locale={locale} messages={t}
      credits={<WorkCredits agentCredits={identity.agentCredits} credits={identity.credits} locale={locale} messages={t} />} /> : null}
    {recipe ? <RecipeRegionView recipe={recipe} href={identity.href} actingSubject={identity.actingSubject}
      text={identity.notes} locale={locale} messages={t} readPage={readPage} />
      : <RegionSkeleton id="recipe-method-loading" title={t.recipeMethod} label={t.loadingRegion} lines={8} />}
  </main>;
}

const meta = { title: 'Work page/Recipe reading recorded', component: RecordedRecipeReading,
  args: { persona: 'visitor', locale: 'en', phase: 'published' }, globals: { viewport: { value: 'desktop' } },
  parameters: { controls: { disable: true } },
} satisfies Meta<typeof RecordedRecipeReading>;
export default meta;
type Story = StoryObj<typeof meta>;

const published: NonNullable<Story['play']> = async ({ canvasElement, args }) => {
  const canvas = within(canvasElement);
  const page = sample(args.persona, 'recipe-start').answer as RecipeWorkPage;
  await canvas.findByRole('heading', { name: (sample(args.persona, 'work-header').answer as { title: { value: string } }).title.value });
  await expect(canvas.getByText(readingLine({ ...(page.occurrences.find(node => node.occurrence === page.ingredients[0]!.occurrence)!.qualifier as IngredientQualifier), amount: page.ingredients[0]!.amount }))).toBeVisible();
  await expect(canvas.queryByText(/PRIVATE DRAFT/)).not.toBeInTheDocument();
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
};
export const Visitor: Story = { play: published };
export const VisitorPhone: Story = { ...Visitor, globals: { viewport: { value: 'phone' } } };
export const Stranger: Story = { args: { persona: 'stranger' }, play: published };
export const Member: Story = { args: { persona: 'member' }, play: published };
export const Owner: Story = { args: { persona: 'owner' }, play: published };
export const Moderator: Story = { args: { persona: 'moderator' }, play: published };
export const Operator: Story = { args: { persona: 'operator' }, play: published };
export const ChinesePhone: Story = { args: { locale: 'zh-Hans' }, globals: { locale: 'zh-Hans', viewport: { value: 'phone' } }, play: published };
export const Loading: Story = { args: { phase: 'loading' }, async play({ canvasElement }) {
  await expect(within(canvasElement).findByRole('status', { name: messages.en.loadingRegion })).resolves.toBeVisible();
} };
export const LoadingPhone: Story = { ...Loading, globals: { viewport: { value: 'phone' } } };
export const PrivateDenied: Story = { args: { phase: 'private' }, async play({ canvasElement }) {
  await expect(within(canvasElement).findByRole('alert')).resolves.toBeVisible();
  await expect(within(canvasElement).queryByRole('spinbutton')).not.toBeInTheDocument();
} };
export const PrivateDeniedPhone: Story = { ...PrivateDenied, globals: { viewport: { value: 'phone' } } };
export const ScalingAndContinuation: Story = { async play(context) {
  await published(context);
  const canvas = within(context.canvasElement);
  const servings = canvas.getByRole('spinbutton', { name: messages.en.servings });
  await userEvent.tripleClick(servings); await userEvent.keyboard('8');
  await userEvent.click(canvas.getByRole('button', { name: messages.en.scaleRecipe }));
  const scaled = sample(context.args.persona, 'recipe-scaled-start').answer as RecipeWorkPage;
  await expect(canvas.findByText(readingLine({ ...(scaled.occurrences.find(node => node.occurrence === scaled.ingredients[0]!.occurrence)!.qualifier as IngredientQualifier), amount: scaled.ingredients[0]!.amount }))).resolves.toBeVisible();
  await userEvent.click(canvas.getByRole('button', { name: messages.en.showMoreRecipe }));
  await expect(canvas.findByText('Mix the sauce.')).resolves.toBeVisible();
  await expect(canvas.findByText('Cook for five minutes.')).resolves.toBeVisible();
} };
export const ScalingAndContinuationPhone: Story = { ...ScalingAndContinuation, globals: { viewport: { value: 'phone' } } };
