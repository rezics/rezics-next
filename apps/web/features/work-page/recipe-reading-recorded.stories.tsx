import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, spyOn, userEvent, waitFor, within } from 'storybook/test';
import type { AnswerPersona, AnswerRecord, AnswerSample } from '../../../../scripts/api/answer-record.ts';
import recipes from '../../../../tests/qa/fixtures/outcomes/recipes/read-a-recipe.json';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { seedTypes, type TypeRegistry } from '../catalogue/types.ts';
import { createReaderStore } from '../catalogue/reader-store.ts';
import { copyOf as recipeEditorCopy } from '../recipe-editor/messages.ts';
import { formatMeasure } from '../recipe-editor/quantity.ts';
import { mainRelationships } from '../relationships/api.ts';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import { copyOf as trackingCopy } from '../tracking/messages.ts';
import { readAnimeReaderState } from './anime-hub-recorded-page.ts';
import { booksEditionReads } from './books-edition-page.read.ts';
import { messages } from './messages.ts';
import { recipeWorkFrame, recipeWorkOverview } from './recipe-reading-recorded-page.tsx';
import { shownLine } from './types/recipe.tsx';
import { RegionSkeleton } from './region.tsx';
import { EVERYONE, workHref } from './route.ts';
import type { RecipeWorkPage, WorkHeader } from './types.ts';

const record = recipes as AnswerRecord;
type Persona = AnswerPersona;
type Locale = 'en' | 'zh-Hans' | 'ja';
type Phase = 'published' | 'loading' | 'scale' | 'continuation';

function sample(persona: Persona, label: string): AnswerSample {
  const found = record.personas[persona].find(item => item.label === label);
  if (!found) throw new Error(`Missing recorded sample ${persona}/${label}`);
  return found;
}

function recordedId(path: string): string {
  const id = new URL(path, 'https://recorded.invalid').pathname.match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
  )?.[0];
  if (!id) throw new Error(`Recorded path has no id: ${path}`);
  return id;
}

function actingSubjectOf(path: string): string | null {
  return new URL(path, 'https://recorded.invalid').searchParams.get('actingSubject');
}

function asRecipe(value: unknown): RecipeWorkPage {
  return value as RecipeWorkPage;
}

function asHeader(value: unknown): WorkHeader {
  return value as WorkHeader;
}

/** One sample answers repeated identical reads. Duplicate keys stay unselected. */
function selectionsFor(persona: Persona, phase: Phase): RecordedSelection[] {
  const selections: RecordedSelection[] = [
    { label: 'type-registry', state: 'populated' },
    { label: 'rating-contexts', state: 'populated' },
    { label: 'work-header', state: 'populated' },
    { label: 'agent-credits', state: 'populated' },
    { label: 'page-projection', state: 'populated' },
    { label: 'recipe-notes-empty', state: 'error' },
    { label: 'author-works', state: 'populated' },
    { label: 'ratings', state: 'populated' },
    { label: 'reader-stats', state: 'populated' },
    { label: 'parts-preview', state: 'error' },
    { label: 'wholes-preview-empty', state: 'populated' },
    { label: 'availability-parts', state: 'error' },
    { label: 'rating-populations', state: 'populated' },
    { label: 'connections-empty', state: 'populated' },
    { label: 'availability-realizations-empty', state: 'populated' },
    { label: 'availability-releases-empty', state: 'populated' },
    { label: 'classifications-empty', state: 'populated' },
    { label: 'also-enjoyed-empty', state: 'populated' },
    { label: 'work-facts', state: 'populated' },
    { label: 'discussion-empty', state: 'populated' },
    { label: 'work-credits', state: 'populated' },
    { label: 'work-adoptions', state: 'populated' },
    { label: 'work-showcase', state: 'populated' },
    { label: 'classification-facets', state: 'populated' },
    { label: 'platform-access', state: 'populated' },
    { label: 'recipe-start', state: phase === 'loading' ? 'loading' : 'populated' },
  ];
  if (persona !== 'visitor') selections.push(
    { label: 'reader-state-empty', state: 'populated' },
    { label: 'progress-equivalent-definition', state: 'error' },
    { label: 'progress-edition-preference', state: 'populated' },
    { label: 'progress-series-summary', state: 'populated' },
    { label: 'recipe-follow-state', state: 'populated' },
    { label: 'progress-medium-parts', state: 'populated' },
  );
  if (phase === 'scale') selections.push(
    { label: 'recipe-scaled-start', state: 'populated' },
    { label: 'recipe-scaled-page-2', state: 'populated' },
  );
  if (phase === 'continuation') selections.push({ label: 'recipe-continuation', state: 'populated' });
  return selections;
}

function RecordedRecipeReading({ persona, locale, phase }: { persona: Persona; locale: Locale; phase: Phase }) {
  const [fault, setFault] = useState<string | null>(null);
  const [node, setNode] = useState<ReactNode>(null);
  const misses = useRef<string[]>([]);
  useEffect(() => {
    let live = true;
    misses.current = [];
    setFault(null);
    setNode(null);
    const headerSample = sample(persona, 'work-header');
    const actingSubject = actingSubjectOf(headerSample.path);
    const replay = recordedFetch(record, persona, selectionsFor(persona, phase), { pathPrefix: BFF_PREFIX });
    const note = (error: unknown) => {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      const message = error instanceof Error ? error.message : 'Recipe read failed';
      misses.current.push(message);
      if (live) setFault(misses.current.join('\n'));
    };
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      try { return await replay.fetcher(input, init); }
      catch (error) {
        note(error);
        throw error;
      }
    }) as typeof fetch;
    const main = browserMainApi(window.location.origin, { anonymous: actingSubject === null, fetcher });
    // Continuations use the client component's own browser reader, just as the server-rendered page does.
    const browserFetch = spyOn(window, 'fetch').mockImplementation(fetcher);
    const host = {
      main,
      anonymous: browserMainApi(window.location.origin, { anonymous: true, fetcher }),
      publicOrigin: window.location.origin,
      publicFetch: fetcher,
      actingSubject,
      signedIn: actingSubject !== null,
    };
    const id = recordedId(headerSample.path);
    const copy = messages[locale];
    void (async () => {
      try {
        const types = await main.v1.types.get();
        if (types.error || !types.data) throw new Error(`Type registry answered ${types.error?.status ?? 'nothing'}`);
        seedTypes(types.data as TypeRegistry);
        const header = await booksEditionReads({ main, ...(actingSubject ? { actingSubject } : {}) }).readWorkHeader(id);
        if (!header.ok) throw new Error(`Work header was ${header.failure}`);
        const seed = actingSubject ? await readAnimeReaderState(main, actingSubject, id) : null;
        const readerActions = actingSubject
          ? createReaderStore({ actingSubject, seed: seed ?? {}, main: () => main }) : undefined;
        const relationships = actingSubject ? mainRelationships(actingSubject, { fetch: fetcher }) : undefined;
        const overview = recipeWorkOverview({
          host, workRef: id, id, work: header.data, scope: EVERYONE, locale, messages: copy,
        });
        if (phase === 'loading') {
          void overview.then(() => undefined, error => note(error));
          const frame = await recipeWorkFrame({
            host, workRef: id, id, work: header.data, locale, messages: copy, readerActions, relationships,
            children: <RegionSkeleton id="work-type-loading" title={header.data.title.value}
              label={copy.loadingRegion} lines={5} />,
          });
          if (!live || misses.current.length) return;
          setNode(frame);
          return;
        }
        const body = await overview;
        if (!live || misses.current.length) return;
        const frame = await recipeWorkFrame({
          host, workRef: id, id, work: header.data, locale, messages: copy, readerActions, relationships,
          children: body,
        });
        if (!live || misses.current.length) return;
        setNode(frame);
      } catch (error) {
        if (live) note(error);
      }
    })();
    const timer = window.setInterval(() => {
      if (live && misses.current.length) setFault(misses.current.join('\n'));
    }, 50);
    return () => {
      live = false;
      window.clearInterval(timer);
      replay.dispose();
      browserFetch.mockRestore();
    };
  }, [persona, locale, phase]);
  if (fault) return <p role="alert" className="whitespace-pre-wrap break-words p-6">{fault}</p>;
  if (!node) return <p role="status" aria-busy="true" className="p-6">{messages[locale].loading}</p>;
  const acting = actingSubjectOf(sample(persona, 'work-header').path);
  return <>
    <p className="px-6 pt-4 text-sm"><span>{persona}</span><span>{`· ${acting ?? 'none'}`}</span></p>
    {node}
  </>;
}

const publishedRef = recordedId(sample('visitor', 'work-header').path);

const meta = {
  title: 'Work page/Recorded recipe reading',
  component: RecordedRecipeReading,
  args: { persona: 'visitor', locale: 'en', phase: 'published' },
  parameters: { controls: { disable: true }, route: { pathname: workHref(publishedRef) } },
  globals: { locale: 'en', viewport: { value: 'desktop' } },
} satisfies Meta<typeof RecordedRecipeReading>;
export default meta;
type Story = StoryObj<typeof meta>;

async function expectNoReplayMiss(canvasElement: HTMLElement) {
  await new Promise(resolve => setTimeout(resolve, 300));
  const alert = within(canvasElement).queryByRole('alert');
  if (alert) throw new Error(alert.textContent ?? 'Recorded request missed');
}

async function expectPublished(canvasElement: HTMLElement, persona: Persona, locale: Locale) {
  const canvas = within(canvasElement);
  const copy = messages[locale];
  const header = asHeader(sample(persona, 'work-header').answer);
  const page = asRecipe(sample(persona, 'recipe-start').answer);
  const yieldMeasure = page.measures.find(item => item.kind === 'yield');
  if (!yieldMeasure) throw new Error('Recorded recipe has no yield');
  const title = await canvas.findByRole('heading', { level: 1, name: header.title.value }, { timeout: 8000 });
  const sauce = await canvas.findByRole('heading', { level: 4, name: 'Sauce' }, { timeout: 8000 });
  await expect(title).toBeVisible();
  await expect(title).toHaveAttribute('lang', header.title.language);
  await expect(sauce).toBeVisible();
  await expect(canvas.getByText(persona)).toBeVisible();
  const acting = actingSubjectOf(sample(persona, 'work-header').path);
  await expect(canvas.getByText(`· ${acting ?? 'none'}`)).toBeVisible();
  await expect(canvas.getAllByRole('link', { name: 'Outcome owner' }).length).toBeGreaterThan(0);
  await expect(canvas.getByRole('heading', { name: copy.recipeMethod })).toBeVisible();
  await expect(canvas.getByText(shownLine(page.ingredients[0]!, 'written', page))).toBeVisible();
  await expect(canvas.getByText(formatMeasure(yieldMeasure.value, yieldMeasure.unitText), { exact: false })).toBeVisible();
  await expect(canvas.queryByRole('radio', { name: copy.unitWritten })).toBeNull();
  await expect(canvas.queryByRole('heading', { name: copy.recipeNotes })).toBeNull();
  await expect(canvas.queryByText('PRIVATE DRAFT')).toBeNull();
  await expect(canvas.getByRole('heading', { name: copy.aboutAuthor })).toBeVisible();
  const edit = recipeEditorCopy(locale).editRecipe;
  if (persona === 'owner') await expect(canvas.getByRole('link', { name: edit })).toBeVisible();
  else await expect(canvas.queryByRole('link', { name: edit })).toBeNull();
  const tracking = trackingCopy(locale);
  if (acting) {
    await expect(canvas.findByRole('button', { name: /^Follow/ }, { timeout: 8000 })).resolves.toBeVisible();
    const progress = await canvas.findByRole('heading', { name: tracking.workProgress }, { timeout: 8000 });
    progress.scrollIntoView();
    await expect(progress).toBeVisible();
    // The heading is drawn while the standing is still loading. Wait for the recorded mark.
    const standing = await canvas.findByText(tracking.notStarted, {}, { timeout: 8000 });
    standing.scrollIntoView();
    await expect(standing).toBeVisible();
  } else {
    await expect(canvas.queryByRole('heading', { name: tracking.workProgress })).toBeNull();
  }
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  await expectNoReplayMiss(canvasElement);
}

function published(persona: Persona, locale: Locale, viewport: 'desktop' | 'phone'): Story {
  return {
    args: { persona, locale, phase: 'published' },
    globals: { locale, viewport: { value: viewport } },
    play: ({ canvasElement }) => expectPublished(canvasElement, persona, locale),
  };
}

async function showMore(canvasElement: HTMLElement, locale: Locale) {
  const canvas = within(canvasElement);
  const copy = messages[locale];
  const button = await canvas.findByRole('button', { name: copy.showMoreRecipe });
  button.scrollIntoView();
  await userEvent.click(button);
  const garnish = await canvas.findByRole('heading', { name: 'Empty garnish' }, { timeout: 8000 });
  garnish.scrollIntoView();
  await expect(garnish).toBeVisible();
  await expect(canvas.getByText('Mix the sauce.')).toBeVisible();
  await expect(canvas.getByText('Cook for five minutes.')).toBeVisible();
  await expect(canvas.queryByText('PRIVATE DRAFT')).toBeNull();
  await expect(canvas.queryByRole('alert')).toBeNull();
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
}

export const Visitor: Story = published('visitor', 'en', 'desktop');
export const Stranger: Story = published('stranger', 'en', 'desktop');
export const Member: Story = published('member', 'en', 'desktop');
export const Owner: Story = published('owner', 'en', 'desktop');
export const Moderator: Story = published('moderator', 'en', 'desktop');
export const Operator: Story = published('operator', 'en', 'desktop');
export const VisitorPhone: Story = published('visitor', 'en', 'phone');
export const OwnerPhone: Story = published('owner', 'en', 'phone');
export const ModeratorPhone: Story = published('moderator', 'en', 'phone');

export const Loading: Story = {
  args: { phase: 'loading' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.findByRole('heading', { level: 1, name: 'Original paged sauce' }, { timeout: 8000 }))
      .resolves.toBeVisible();
    await expect(canvas.getByRole('status', { name: messages.en.loadingRegion })).toBeVisible();
    await expect(canvas.getByText('visitor')).toBeVisible();
    const held = asRecipe(sample('visitor', 'recipe-start').answer);
    await expect(canvas.queryByText(shownLine(held.ingredients[0]!, 'written', held))).toBeNull();
    await expect(canvas.queryByText(held.ingredients[0]!.line)).toBeNull();
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    await expectNoReplayMiss(canvasElement);
  },
};

export const LoadingPhone: Story = {
  ...Loading,
  globals: { locale: 'en', viewport: { value: 'phone' } },
};

export const Continuation: Story = {
  args: { phase: 'continuation' },
  play: async ({ canvasElement }) => {
    await expectPublished(canvasElement, 'visitor', 'en');
    await showMore(canvasElement, 'en');
  },
};

export const Scaled: Story = {
  args: { phase: 'scale' },
  play: async ({ canvasElement }) => {
    await expectPublished(canvasElement, 'visitor', 'en');
    const canvas = within(canvasElement);
    const servings = canvas.getByLabelText(messages.en.servings);
    await userEvent.clear(servings);
    await userEvent.type(servings, '8');
    await waitFor(() => expect(servings).toHaveValue(8));
    await userEvent.click(canvas.getByRole('button', { name: messages.en.scaleRecipe }));
    await waitFor(() => expect(canvas.getByRole('button', { name: messages.en.scaleRecipe })).toBeEnabled());
    await expect(canvas.queryByRole('alert')).toBeNull();
    const scaled = asRecipe(sample('visitor', 'recipe-scaled-start').answer);
    await expect(canvas.getByText(shownLine(scaled.ingredients[0]!, 'written', scaled))).toBeVisible();
    await showMore(canvasElement, 'en');
  },
};

export const ScaledPhone: Story = {
  args: { persona: 'owner', phase: 'scale' },
  globals: { locale: 'en', viewport: { value: 'phone' } },
  play: async ({ canvasElement }) => {
    await expectPublished(canvasElement, 'owner', 'en');
    const canvas = within(canvasElement);
    const servings = canvas.getByLabelText(messages.en.servings);
    await userEvent.clear(servings);
    await userEvent.type(servings, '8');
    await waitFor(() => expect(servings).toHaveValue(8));
    await userEvent.click(canvas.getByRole('button', { name: messages.en.scaleRecipe }));
    await waitFor(() => expect(canvas.getByRole('button', { name: messages.en.scaleRecipe })).toBeEnabled());
    await expect(canvas.queryByRole('alert')).toBeNull();
    await showMore(canvasElement, 'en');
  },
};

export const SimplifiedChinese: Story = published('visitor', 'zh-Hans', 'desktop');
export const SimplifiedChinesePhone: Story = published('visitor', 'zh-Hans', 'phone');

export const EnglishWide: Story = { ...Visitor, globals: { locale: 'en', viewport: { value: 'desktop1440' } } };
export const JapaneseWide: Story = { ...published('visitor', 'ja', 'desktop'), globals: { locale: 'ja', viewport: { value: 'desktop1440' } } };
export const JapanesePhone: Story = published('visitor', 'ja', 'phone');
