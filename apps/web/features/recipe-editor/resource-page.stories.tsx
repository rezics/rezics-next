import { Button } from '@rezics/ui/button';
import { RecipeExperience } from '../work-page/types/recipe.tsx';
import type { RecipeWorkPage } from '../work-page/types.ts';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { useEffect, useState } from 'react';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import exchangeJson from '../../../../tests/qa/fixtures/outcomes/recipes/exchange-recipes.json';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { PageContainer } from '../shell/page.tsx';
import { recordedFetch } from '../stories/recorded-fetch.ts';
import { booksEditionReads } from '../work-page/books-edition-page.read.ts';
import { englishMessages } from '../work-page/messages.ts';
import { RegionSkeleton } from '../work-page/region.tsx';
import { fakeMain, fixtureAnswer, emptyStart, work, mainVersion, actingSubject as contractActor } from './fixtures.ts';
import type { MainClient } from '../studio/types.ts';
import { mainRecipeExportApi } from './export-api.ts';
import { copyOf } from './messages.ts';
import { recipeProveStates } from './prove-states.ts';
import { loadRecipeReading } from './resource-page.ts';
import { RecipeResourceBody } from './resource-page.tsx';

const record = exchangeJson as AnswerRecord;
/** Unchanged public recipe/authority/header/export answers; optional notes use a named unrecorded contract 404. */
function ResourceVisit({ persona, state }: { persona: AnswerPersona; state: 'populated' | 'loading' }) {
  const sample = record.personas[persona].find(item => item.label === 'public-recipe')!;
  const path = new URL(sample.path, 'https://recorded.invalid'), id = path.pathname.split('/').pop()!;
  const actingSubject = path.searchParams.get('actingSubject') ?? undefined;
  const [ready, setReady] = useState<{ content: Awaited<ReturnType<typeof loadRecipeReading>>;
    exportApi: ReturnType<typeof mainRecipeExportApi> } | null>(null);
  useEffect(() => {
    let mounted = true;
    const replay = recordedFetch(record, persona, [
      { label: 'editor-work-header', state: 'populated' }, { label: 'public-recipe', state },
      ...(actingSubject ? [{ label: 'editor-authority', state: 'populated' as const }, { label: 'selected-schema-org-export', state: 'populated' as const }] : []),
    ], { pathPrefix: BFF_PREFIX });
    const header = record.personas[persona].find(item => item.label === 'editor-work-header')!.answer as { mainVersion: string };
    const selection = `${BFF_PREFIX}/v1/main-versions/${header.mainVersion.slice(-36)}/selection`;
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      // This exact production request has no recorded answer. An explicitly identified contract
      // state keeps optional notes absent; it never borrows another person's notes or frame.
      if (request.method === 'GET' && url.pathname === selection && url.search === '') {
        return Response.json({ type: 'about:blank', status: 404, title: 'No selected text', code: 'not_found' }, { status: 404 });
      }
      return replay.fetcher(input, init);
    }) as typeof fetch;
    const main = browserMainApi(window.location.origin, { anonymous: persona === 'visitor', fetcher });
    void booksEditionReads({ main, actingSubject }).readWorkHeader(id).then(async loaded => {
      if (!loaded.ok) throw new Error('Recorded header failed');
      const content = await loadRecipeReading(main, actingSubject, loaded.data, path.pathname);
      if (mounted) setReady({ content, exportApi: mainRecipeExportApi(() => main) });
    });
    return () => { mounted = false; replay.dispose(); };
  }, [actingSubject, id, path.pathname, persona, state]);
  return <PageContainer>{ready ? <RecipeResourceBody {...ready.content} href={path.pathname} actingSubject={actingSubject ?? null}
    work={id} locale="en" messages={englishMessages} exportApi={ready.exportApi} saveExport={() => { /* Local story download is discarded. */ }} />
    : <RegionSkeleton id="recipe-experience" title={englishMessages.recipeMethod} label={englishMessages.loading} />}</PageContainer>;
}
/** An own Work with no Composition, or an unavailable region: unrecorded contract states. */
function ContractResource({ state }: { state: 'empty' | 'error' }) {
  const [fake] = useState(() => {
    const model = fakeMain({ recipe: emptyStart });
    if (state === 'error') {
      const originalWorks = model.main().v1.recipes.works;
      model.main().v1.recipes.works = ((target: Parameters<typeof originalWorks>[0]) => ({ ...originalWorks(target),
        get: async () => fixtureAnswer(503, { type: 'about:blank', status: 503 as const,
          title: 'Recipe unavailable', code: 'read_unavailable' }),
      })) as MainClient['v1']['recipes']['works'];
    }
    // The projection reader follows the supplied href through Eden's indexed route shape.
    Object.assign(model.main().v1.recipes.works, { [work.slice(-36)]: model.main().v1.recipes.works({ id: work.slice(-36) }) });
    return model;
  });
  const [content, setContent] = useState<Awaited<ReturnType<typeof loadRecipeReading>> | null>(null);
  const href = `/v1/recipes/works/${work.slice(-36)}`;
  useEffect(() => {
    let mounted = true;
    void loadRecipeReading(fake.main(), contractActor, { id: work, mainVersion, selectedLanguage: null }, href)
      .then(next => { if (mounted) setContent(next); });
    return () => { mounted = false; };
  }, [fake, href]);
  return <PageContainer>{content ? <RecipeResourceBody {...content} href={href} actingSubject={contractActor}
    work={work} locale="en" messages={englishMessages} />
    : <RegionSkeleton id="recipe-experience" title={englishMessages.recipeMethod} label={englishMessages.loading} />}</PageContainer>;
}
const meta = { title: 'Recipe resource/Production region visit', component: ResourceVisit,
  args: { persona: 'member' as AnswerPersona, state: 'populated' }, globals: { viewport: { value: 'desktop' }, locale: 'en' },
  parameters: { recipeProveStates, docs: { description: { component: 'Production resource-region loader and body. Recipe and authority use unchanged records. The Main Version selection 404 is an unrecorded contract state; the complete locale/Work frame and original Person credit reads remain listed prove seams.' } } },
} satisfies Meta<typeof ResourceVisit>;
export default meta;
type Story = StoryObj<typeof meta>;
const phone = { globals: { viewport: { value: 'phone' as const }, locale: 'en' } };
const readable: Story['play'] = async ({ canvasElement, args }) => {
  const canvas = within(canvasElement), t = copyOf('en');
  await expect(await canvas.findByText('Mix the first portion.')).toBeVisible();
  await expect(canvas.getAllByText('1 ½ cup flour')).toHaveLength(1);
  await expect(canvas.getAllByText('¼ cup flour')).toHaveLength(1);
  await expect(canvas.queryByRole('button', { name: t.importAction })).toBeNull();
  await expect(canvas.queryByText('Private draft note.')).toBeNull();
  if (args.persona === 'owner') await expect(canvas.getByRole('link', { name: t.editRecipe })).toBeVisible();
  else await expect(canvas.queryByRole('link', { name: t.editRecipe })).toBeNull();
  if (args.persona !== 'visitor') {
    const download = canvas.getByRole('button', { name: t.exportAction });
    await waitFor(() => expect(download).toHaveAttribute('data-hydrated', 'true'));
    await userEvent.click(download);
    const exported = record.personas[args.persona].find(item => item.label === 'selected-schema-org-export')!.answer as { revision: string };
    await expect(await canvas.findByText(t.exportedRevision({ revision: exported.revision.slice(-36) }))).toBeVisible();
  } else await expect(canvas.queryByRole('button', { name: t.exportAction })).toBeNull();
};
export const Visitor: Story = { args: { persona: 'visitor' }, play: readable };
export const VisitorPhone: Story = { ...Visitor, ...phone };
export const Stranger: Story = { args: { persona: 'stranger' }, play: readable };
export const StrangerPhone: Story = { ...Stranger, ...phone };
export const Member: Story = { play: readable };
export const MemberPhone: Story = { ...Member, ...phone };
export const Owner: Story = { args: { persona: 'owner' }, play: readable };
export const OwnerPhone: Story = { ...Owner, ...phone };
export const Moderator: Story = { args: { persona: 'moderator' }, play: readable };
export const ModeratorPhone: Story = { ...Moderator, ...phone };
export const Operator: Story = { args: { persona: 'operator' }, play: readable };
export const OperatorPhone: Story = { ...Operator, ...phone };
export const Loading: Story = { args: { state: 'loading' }, play: async ({ canvasElement }) => {
  await expect(await within(canvasElement).findByRole('status')).toHaveAttribute('aria-busy', 'true');
} };
export const LoadingPhone: Story = { ...Loading, ...phone };

export const EmptyOwnWork: Story = { render: () => <ContractResource state="empty" />,
  parameters: { docs: { description: { story: 'Unrecorded contract state: GET /v1/recipes/works/{own Work}?actingSubject={author} returns HTTP 200 JSON null; optional text selection is 404.' } } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(englishMessages.recipeUnstructured)).toBeVisible();
    await expect(canvas.getByRole('link', { name: copyOf('en').editRecipe })).toBeVisible();
    await expect(canvas.queryByRole('button', { name: copyOf('en').exportAction })).toBeNull();
  },
};
export const EmptyOwnWorkPhone: Story = { ...EmptyOwnWork, ...phone };
export const Unavailable: Story = { render: () => <ContractResource state="error" />,
  parameters: { docs: { description: { story: 'Unrecorded contract state: the own Work recipe-region GET returns HTTP 503 read_unavailable; the production region offers retry.' } } },
  play: async ({ canvasElement }) => { await expect(await within(canvasElement).findByRole('alert')).toBeVisible(); },
};
export const UnavailablePhone: Story = { ...Unavailable, ...phone };

function RetargetRecipe() {
  const [empty, setEmpty] = useState(false);
  const page = record.personas.visitor.find(sample => sample.label === 'public-recipe')!.answer as RecipeWorkPage;
  return <PageContainer>
    <Button onClick={() => setEmpty(true)}>Open empty recipe</Button>
    <RecipeExperience resource={work} initial={empty ? null : page} href={`/v1/recipes/works/${work.slice(-36)}`}
      actingSubject={null} text={null} locale="en" messages={englishMessages} />
  </PageContainer>;
}

export const RetargetProvidedRecipe: Story = { render: () => <RetargetRecipe />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.queryByText(englishMessages.recipeUnstructured)).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: 'Open empty recipe' }));
    await expect(await canvas.findByText(englishMessages.recipeUnstructured)).toBeVisible();
    await expect(canvas.queryByRole('button', { name: englishMessages.scaleRecipe })).toBeNull();
  },
};
