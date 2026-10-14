import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { useEffect, useState } from 'react';
import type { AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import exchangeJson from '../../../../tests/qa/fixtures/outcomes/recipes/exchange-recipes.json';
import EditLayout from '../../app/[locale]/w/[ref]/edit/layout.tsx';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import type { MainClient } from '../studio/types.ts';
import { globalWorkHref } from '../work-page/route.ts';
import { loadRecipeAuthoring, type RecipeAuthoringMapped } from './authoring-page.ts';
import { RecipeAuthoringBody, RecipeAuthoringPending } from './authoring-page.tsx';
import { actingSubject, emptyStart, fakeMain, fixtureAnswer, id, startRecipe, work } from './fixtures.ts';
import { mainRecipeImportApi } from './import-api.ts';
import { copyOf } from './messages.ts';
import { stateOf, type RecipeState } from './model.ts';
import { recipeProveStates } from './prove-states.ts';
import { recipeEditHref } from './route.ts';

const exchange = exchangeJson as AnswerRecord;
const exportSample = exchange.personas.owner.find(item => item.label === 'schema-org-export')!;
const recipeFile = () => new File([JSON.stringify((exportSample.answer as { recipe: unknown }).recipe)], 'recipe.json', { type: 'application/ld+json' });
const importedSample = exchange.personas.owner.find(item => item.label === 'imported-recipe')!;
const retainedImport = stateOf(importedSample.answer as Parameters<typeof stateOf>[0]);
function importedFor(structure: string, head: string): RecipeState {
  const occurrences = new Map(retainedImport.nodes.map((node, index) => [node.occurrence, id(2000 + index)]));
  return { ...retainedImport, structure, head, nodes: retainedImport.nodes.map(node => {
    const base = { occurrence: occurrences.get(node.occurrence)!, parent: node.parent === retainedImport.structure
      ? structure : occurrences.get(node.parent)! };
    if (node.role === 'step') return { ...node, ...base, qualifier: { ...node.qualifier,
      usesIngredient: node.qualifier.usesIngredient.map(value => occurrences.get(value)!) } };
    return { ...node, ...base };
  }) };
}
type Scenario = 'populated' | 'empty' | 'save-refusal' | 'publication-denied' | 'publication-pending' | 'import' | 'import-pending' | 'import-stale';
let current: { fake: ReturnType<typeof fakeMain>; imports: { key: string; body: unknown; expectedHead: string | null }[] };

/** Contract models for unrecorded controls. The production loader, editor and HTTP file adapter run unchanged. */
function ContractVisit({ scenario, locale }: { scenario: Scenario; locale: UiLocale }) {
  const [boundary] = useState(() => {
    const importedState = importedFor(startRecipe.structure!, id(1100));
    const fake = fakeMain({ recipe: scenario === 'publication-denied' ? importedState
      : scenario === 'empty' || scenario.startsWith('import') ? emptyStart : startRecipe });
    const imports: typeof current.imports = [];
    current = { fake, imports };
    if (scenario === 'save-refusal') fake.interference.writeStatus = 403;
    if (scenario === 'publication-denied') {
      fake.main().v1['work-publications'].post = Object.assign(async () => fixtureAnswer(403, {
        type: 'about:blank', title: 'Imported file rights are unknown', code: 'authority_denied', status: 403 as const,
        detail: 'This imported Structure is not an original contribution.',
      }), { '~path': '/v1/work-publications' }) as MainClient['v1']['work-publications']['post'];
    }
    if (scenario === 'publication-pending') {
      const post = fake.main().v1['work-publications'].post;
      let calls = 0;
      fake.main().v1['work-publications'].post = (async (...args: Parameters<typeof post>) => {
        if (++calls === 1) return fixtureAnswer(202, { operationId: 'queued', status: 'reconciling' as const, phase: 'dispatch',
          result: null, retry: { allowed: true as const, afterMs: 100 } });
        return post(...args);
      }) as typeof post;
    }
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url), key = request.headers.get('idempotency-key')!;
      const body: unknown = await request.json();
      imports.push({ key, body, expectedHead: url.searchParams.get('expectedHead') });
      if (scenario === 'import-pending' && imports.length === 1) return Response.json({ operationId: 'file-command', status: 'reconciling',
        phase: 'dispatch', result: null, retry: { allowed: true, afterMs: 100 } }, { status: 202 });
      if (scenario === 'import-stale' && imports.length === 1) {
        fake.elsewhere(state => state);
        return Response.json({ type: 'about:blank', title: 'Recipe changed', status: 409, code: 'stale_composition_head' }, { status: 409 });
      }
      const root = fake.world().recipe.structure!;
      const revision = id(1100);
      fake.replaceRecipe(importedFor(root, revision));
      const replayed = scenario === 'import-pending' && imports.length > 1;
      return Response.json({ structure: root, revision, sourceObservation: id(1101), residualDigest: 'a'.repeat(64),
        receipts: [id(1102)], replayed }, { status: replayed ? 200 : 201 });
    }) as typeof fetch;
    return { fake, importApi: mainRecipeImportApi({ fetch: fetcher, origin: 'https://contract.invalid' }) };
  });
  const [view, setView] = useState<RecipeAuthoringMapped | null>(null);
  useEffect(() => {
    let mounted = true;
    void loadRecipeAuthoring(boundary.fake.main(), { id: work.slice(-36), actingSubject, signedIn: true }).then(next => {
      if (mounted) setView(next);
    });
    return () => { mounted = false; };
  }, [boundary]);
  return <EditLayout>{view ? <RecipeAuthoringBody view={view} locale={locale} workRef={work.slice(-36)}
    workHref={globalWorkHref(work)} signInHref="/auth/start" main={boundary.fake.main} importApi={boundary.importApi}
    saveExport={() => { /* Contract stories keep no download. */ }} /> : <RecipeAuthoringPending locale={locale} />}</EditLayout>;
}

const meta = { title: 'Recipe editor/Contract production visit', component: ContractVisit,
  args: { scenario: 'populated' as Scenario, locale: 'en' as UiLocale },
  globals: { viewport: { value: 'desktop' }, locale: 'en' },
  render: (args, { globals }) => <ContractVisit {...args} locale={(globals.locale as UiLocale | undefined) ?? args.locale} />,
  parameters: { recipeProveStates, route: { pathname: localizedPath(recipeEditHref(work), 'en') },
    docs: { description: { component: 'Unrecorded contract states. These are production loader/editor/control visits over typed contract models; recipeProveStates lists exact missing reads/commands for recording in prove.' } } },
} satisfies Meta<typeof ContractVisit>;
export default meta;
type Story = StoryObj<typeof meta>;
const t = copyOf('en');
const phone = { globals: { viewport: { value: 'phone' as const }, locale: 'en' } };
async function opened(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await expect(await canvas.findByRole('textbox', { name: t.title })).toHaveValue('Lemon muffins');
  return canvas;
}
export const Populated: Story = { play: async ({ canvasElement }) => { await opened(canvasElement); } };
export const PopulatedPhone: Story = { ...Populated, ...phone };
export const Empty: Story = { args: { scenario: 'empty' }, play: async ({ canvasElement }) => {
  const canvas = await opened(canvasElement);
  await expect(canvas.getByText(t.emptyIngredients)).toBeVisible();
  await expect(canvas.getByText(t.emptySteps)).toBeVisible();
  await expect(canvas.getByRole('button', { name: t.publish })).toBeDisabled();
  await expect(canvas.getByRole('button', { name: t.importAction })).toBeEnabled();
} };
export const EmptyPhone: Story = { ...Empty, ...phone };
export const SavesAndPreviews: Story = { play: async ({ canvasElement }) => {
  const canvas = await opened(canvasElement);
  const title = canvas.getByRole('textbox', { name: t.title });
  await userEvent.clear(title); await userEvent.type(title, 'Lemon poppy muffins'); await userEvent.tab();
  await waitFor(() => expect(current.fake.calls.find(call => call.name === 'details')).toBeDefined());
  if (window.innerWidth < 1024) await userEvent.click(canvas.getByRole('button', { name: t.viewPreview }));
  await expect(canvas.getByRole('heading', { name: 'Lemon poppy muffins' })).toBeVisible();
} };
export const SavesAndPreviewsPhone: Story = { ...SavesAndPreviews, ...phone };
export const SaveRefusal: Story = { args: { scenario: 'save-refusal' }, play: async ({ canvasElement }) => {
  const canvas = await opened(canvasElement);
  const title = canvas.getByRole('textbox', { name: t.title });
  await userEvent.clear(title); await userEvent.type(title, 'My retained change'); await userEvent.tab();
  await expect(await canvas.findByRole('alert')).toHaveTextContent(t.failDenied);
  await expect(title).toHaveValue('My retained change');
  await expect(canvas.queryByRole('button', { name: t.publish })).toBeNull();
} };
export const SaveRefusalPhone: Story = { ...SaveRefusal, ...phone };
export const PublishesWithoutNotes: Story = { play: async ({ canvasElement }) => {
  const canvas = await opened(canvasElement);
  await userEvent.click(canvas.getByRole('button', { name: t.publish }));
  await expect(await canvas.findByText(t.publishedNotice)).toBeVisible();
  await expect(current.fake.calls.filter(call => call.name === 'recipe-publish')).toHaveLength(1);
  await expect(current.fake.calls.some(call => call.name === 'notes-create')).toBe(false);
  await expect(canvas.getByRole('link', { name: t.viewRecipe })).toBeVisible();
} };
export const PublishesWithoutNotesPhone: Story = { ...PublishesWithoutNotes, ...phone };
export const ImportedPublicationRefusal: Story = { args: { scenario: 'publication-denied' }, play: async ({ canvasElement }) => {
  const canvas = await opened(canvasElement);
  await userEvent.click(canvas.getByRole('button', { name: t.publish }));
  await expect(await canvas.findByRole('alert')).toHaveTextContent('This imported Structure is not an original contribution.');
  await expect(canvas.queryByText(t.publishedNotice)).toBeNull();
  await expect(canvas.getByRole('textbox', { name: t.title })).toHaveValue('Lemon muffins');
} };
export const ImportedPublicationRefusalPhone: Story = { ...ImportedPublicationRefusal, ...phone };
export const PublicationPending: Story = { args: { scenario: 'publication-pending' }, play: async ({ canvasElement }) => {
  const canvas = await opened(canvasElement);
  await userEvent.click(canvas.getByRole('button', { name: t.publish }));
  await expect(await canvas.findByRole('alert')).toHaveTextContent(t.failPending);
  await expect(canvas.queryByText(t.publishedNotice)).toBeNull();
  await userEvent.click(canvas.getByRole('button', { name: t.retry }));
  await expect(await canvas.findByText(t.publishedNotice)).toBeVisible();
} };
export const PublicationPendingPhone: Story = { ...PublicationPending, ...phone };
async function importFile(canvasElement: HTMLElement) {
  const canvas = await opened(canvasElement);
  const button = canvas.getByRole('button', { name: t.importAction });
  await waitFor(() => expect(button).toHaveAttribute('data-hydrated', 'true'));
  await userEvent.upload(canvas.getByLabelText(t.importAction, { selector: 'input' }), recipeFile());
  return canvas;
}
async function imported(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await expect(await canvas.findByText(t.importedRevision({ revision: id(1100).slice(-36) }))).toBeVisible();
  await waitFor(() => expect(canvasElement.querySelectorAll('[data-line]')).toHaveLength(2));
  await expect([...canvasElement.querySelectorAll('[data-line] span[lang]')].map(node => node.getAttribute('lang'))).toEqual(['fr', 'fr']);
  await expect(current.fake.world().recipe.nodes.filter(node => node.role === 'ingredient').map(node => node.qualifier.amount))
    .toEqual([{ numerator: 3, denominator: 2 }, { numerator: 1, denominator: 4 }]);
}
export const ImportIntoEmptyDraft: Story = { args: { scenario: 'import' }, play: async ({ canvasElement }) => {
  await importFile(canvasElement); await imported(canvasElement);
  await expect(current.fake.calls.filter(call => call.name === 'create')).toHaveLength(1);
} };
export const ImportIntoEmptyDraftPhone: Story = { ...ImportIntoEmptyDraft, ...phone };
export const ImportPendingRetry: Story = { args: { scenario: 'import-pending' }, play: async ({ canvasElement }) => {
  const canvas = await importFile(canvasElement);
  await expect(await canvas.findByRole('alert')).toHaveTextContent(t.failPending);
  await userEvent.click(canvas.getByRole('button', { name: t.retry })); await imported(canvasElement);
  await expect(current.imports[1]).toEqual(current.imports[0]);
} };
export const ImportPendingRetryPhone: Story = { ...ImportPendingRetry, ...phone };
export const StaleImportConfirmation: Story = { args: { scenario: 'import-stale' }, play: async ({ canvasElement }) => {
  const canvas = await importFile(canvasElement);
  await expect(await canvas.findByRole('alert')).toHaveTextContent(t.importStale);
  await expect(current.imports).toHaveLength(1);
  await userEvent.click(await canvas.findByRole('button', { name: t.importStaleAction })); await imported(canvasElement);
  await expect(current.imports[1]?.key).not.toBe(current.imports[0]?.key);
  await expect(current.imports[1]?.expectedHead).not.toBe(current.imports[0]?.expectedHead);
} };
export const StaleImportConfirmationPhone: Story = { ...StaleImportConfirmation, ...phone };
