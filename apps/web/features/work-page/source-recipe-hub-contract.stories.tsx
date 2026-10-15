import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import type { AnswerPersona } from '../../../../scripts/api/answer-record.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { readSelectedWorkCredits } from './anime-hub-recorded-page.ts';
import { booksEditionReads } from './books-edition-page.read.ts';
import { WorkCredits, type BylinePage } from './credits.tsx';
import { work } from './fixtures.ts';
import { messages } from './messages.ts';
import { publicationSource } from './publication-source.tsx';
import { RegionSkeleton } from './region.tsx';
import type { WorkHeader as Header } from './types.ts';
import { RecipeContent, type ReadableRecipe } from './types/recipe.tsx';
import { Region } from './region.tsx';
import { WorkHeader } from './work-header.tsx';

const id = work.id.slice(-36);
const importer = 'https://rezics.com/id/00000000-0000-4000-8000-000000000009';
const subjects: Record<AnswerPersona, string | undefined> = { visitor: undefined,
  stranger: 'https://rezics.com/id/00000000-0000-4000-8000-000000000010',
  member: 'https://rezics.com/id/00000000-0000-4000-8000-000000000011',
  owner: 'https://rezics.com/id/00000000-0000-4000-8000-000000000012',
  moderator: 'https://rezics.com/id/00000000-0000-4000-8000-000000000013', operator: importer };
const source = { record: 'https://rezics.com/id/00000000-0000-4000-8000-000000000006',
  observation: 'https://rezics.com/id/00000000-0000-4000-8000-000000000007', provider: 'gutenberg',
  externalId: '65061/quick-puff-paste', url: 'https://www.gutenberg.org/ebooks/65061',
  license: 'https://www.gutenberg.org/policy/license.html' };
const header = { ...work, types: ['https://schema.org/Recipe'],
  title: { ...work.title, value: 'Quick Puff Paste' }, originalTitle: null, tagline: null, description: null,
  chapterCount: null, wordCount: null, completionStatus: null, lastUpdatedAt: null,
  rights: { basis: 'public-domain', source } };
const credits = { nextCursor: null, sourcePosition: work.sourcePosition,
  count: { value: 2, kind: 'exact-page' as const, total: null }, items: [
  { id: 'https://rezics.com/id/00000000-0000-4000-8000-000000000004', role: 'author', agent: null,
    displayName: 'Fannie Merritt Farmer', provider: 'gutenberg', key: '65061/author', ordinal: 0 },
  { id: 'https://rezics.com/id/00000000-0000-4000-8000-000000000005', role: 'transcriber', agent: importer,
    displayName: 'Recipe transcriber', handle: null, provider: null, key: null, ordinal: 1 },
] };

const recipe: ReadableRecipe = {
  measures: [], ingredients: ['1 cup bread flour', '1 tablespoon lard', 'Cold water', '⅞ cup butter'].map((text, index) => ({
    occurrence: `ingredient-${index}`, originalText: text, line: text, language: 'en',
  })), occurrences: [{ occurrence: 'method', role: 'step', parent: work.id, labels: [], qualifier: {
    type: 'recipe-step', instructionText: { language: 'en', value: 'Work lard into flour, first using knife then tips of fingers. Moisten to\n'
      + 'a dough with cold water, pat, and roll out same as Puff Paste. Dot paste\n'
      + 'with small pieces of butter, using one-third the quantity. Dredge with\n'
      + 'flour, fold from ends toward centre, then double, making four layers.\n'
      + 'Pat, and roll out. Repeat until butter is used. Roll, shape, chill, and\n'
      + 'bake in a hot oven.' },
  } }],
};

/** No recording exists for recipes/work-hub-and-reading. These are the proposed delivery/credit states in that row. */
export const missingSourceRecipeStates = ['visitor', 'stranger', 'member', 'owner', 'moderator', 'operator'].flatMap(persona => {
  const subject = subjects[persona as AnswerPersona];
  const query = subject ? `?actingSubject=${encodeURIComponent(subject)}` : '';
  return [
    { persona, request: `GET /v1/works/${id}${query}`, status: 200, state: header },
    { persona, request: `GET /v1/works/${id}/credits${query}`, status: 200, state: credits },
  ];
});

/** The supplied-client Work header and selected-publication credit readers, with explicitly unrecorded contract answers. */
function SourceRecipeHubContract({ persona, locale }: { persona: AnswerPersona; locale: UiLocale }) {
  const [view, setView] = useState<{ work: Header; credits: BylinePage } | null>(null);
  const [fault, setFault] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setView(null); setFault(null);
    const actingSubject = subjects[persona];
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const path = url.pathname.replace(BFF_PREFIX, '');
      if (url.searchParams.get('actingSubject') !== (actingSubject ?? null)) throw new Error('Wrong contract persona identity');
      if (path === `/v1/works/${id}`) return Response.json(header);
      if (path === `/v1/works/${id}/credits`) return Response.json(credits);
      throw new Error(`Unlisted contract request ${path}`);
    }) as typeof fetch;
    const main = browserMainApi(window.location.origin, { anonymous: !actingSubject, fetcher });
    void (async () => {
      const read = await booksEditionReads({ main, actingSubject }).readWorkHeader(id);
      if (!read.ok) throw new Error(`Contract Work read ${read.failure}`);
      const people = await readSelectedWorkCredits(main, actingSubject, id, Boolean(publicationSource(read.data)));
      if (!people.ok) throw new Error(`Contract credit read ${people.failure}`);
      if (live) setView({ work: read.data, credits: people.data });
    })().catch(error => { if (live) setFault(String(error)); });
    return () => { live = false; };
  }, [persona]);
  if (fault) return <p role="alert">{fault}</p>;
  if (!view) return <RegionSkeleton id="source-recipe-loading" title={header.title.value} label={messages[locale].loadingRegion} />;
  return <main className="mx-auto grid min-w-0 max-w-4xl gap-6 p-4 sm:p-8" lang={locale}>
    <p className="text-muted-foreground text-sm">Contract state · {persona}</p>
    <WorkHeader work={view.work} locale={locale} messages={messages[locale]} credits={<WorkCredits
      agentCredits={{ ok: true, data: { items: [], nextCursor: null } }} credits={{ ok: true, data: view.credits }}
      source={publicationSource(view.work)} locale={locale} messages={messages[locale]} />} />
    <Region id="source-recipe-method" title={messages[locale].recipeMethod}><RecipeContent page={recipe} units="written" messages={messages[locale]} /></Region>
  </main>;
}
const meta = { title: 'Work page/Source recipe hub contract (unrecorded)', component: SourceRecipeHubContract,
  args: { persona: 'visitor', locale: 'en' }, globals: { viewport: { value: 'desktop' } },
  excludeStories: ['missingSourceRecipeStates'], parameters: { controls: { disable: true }, missingRecordedStates: missingSourceRecipeStates,
    docs: { description: { component: 'Unrecorded contract state for recipes/work-hub-and-reading. Publication source and transcriber roles still require API proof; no source text or clearance is inferred from intake evidence.' } } },
} satisfies Meta<typeof SourceRecipeHubContract>;
export default meta;
type Story = StoryObj<typeof meta>;
const credited: NonNullable<Story['play']> = async ({ canvasElement, args }) => {
  const canvas = within(canvasElement);
  await expect(canvas.findByText('Fannie Merritt Farmer')).resolves.toBeVisible();
  await expect(canvas.getByText(messages[args.locale].transcribedBy, { exact: false })).toBeVisible();
  await expect(canvas.getByRole('link', { name: /gutenberg · 65061\/quick-puff-paste/ })).toHaveAttribute('href', source.url);
  await expect(canvas.getByRole('link', { name: source.license })).toHaveAttribute('href', source.license);
  await expect(canvas.getByText('1 cup bread flour')).toBeVisible();
  await expect(canvas.getByText(/Work lard into flour/)).toBeVisible();
  const authors = canvasElement.querySelector('.font-work-title.text-foreground\\/85');
  await expect(authors).not.toHaveTextContent('Recipe transcriber');
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
};
export const Visitor: Story = { play: credited };
export const VisitorPhone: Story = { ...Visitor, globals: { viewport: { value: 'phone' } } };
export const Stranger: Story = { args: { persona: 'stranger' }, play: credited };
export const Member: Story = { args: { persona: 'member' }, play: credited };
export const Owner: Story = { args: { persona: 'owner' }, play: credited };
export const Moderator: Story = { args: { persona: 'moderator' }, play: credited };
export const Operator: Story = { args: { persona: 'operator' }, play: credited };
export const ChinesePhone: Story = { args: { locale: 'zh-Hans' }, globals: { locale: 'zh-Hans', viewport: { value: 'phone' } }, play: credited };
export const EnglishWide: Story = { ...Visitor, globals: { locale: 'en', viewport: { value: 'desktop1440' } } };
export const JapanesePhone: Story = { args: { locale: 'ja' }, globals: { locale: 'ja', viewport: { value: 'phone' } }, play: credited };
export const JapaneseWide: Story = { ...JapanesePhone, globals: { locale: 'ja', viewport: { value: 'desktop1440' } } };
