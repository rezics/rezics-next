import type { Meta, StoryObj } from '@storybook/react-vite';
import { localizedPath } from '../../i18n/locale.ts';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { useEffect, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import EditLayout from '../../app/[locale]/w/[ref]/edit/layout.tsx';
import { loadRecipeAuthoring, type RecipeAuthoringMapped } from './authoring-page.ts';
import { RecipeAuthoringBody, RecipeAuthoringPending } from './authoring-page.tsx';
import { globalWorkHref } from '../work-page/route.ts';
import { parseLine, qualifierOf } from './ingredient-line.ts';
import { actingSubject, id, structure, fakeMain, work, startRecipe } from './fixtures.ts';
import { type RecipeExport, type RecipeExportRequest } from './export-api.ts';
import { RecipeImportError, RECIPE_FILE_MAX_BYTES, type RecipeFileImport, type RecipeImportApi,
  type RecipeImportRequest } from './import-api.ts';
import { copyOf } from './messages.ts';
import { recipeEditHref } from './route.ts';
import type { MainClient } from '../studio/types.ts';
import { recipeProveStates } from './prove-states.ts';

const revision = id(900);
const exported: RecipeExport = { profile: 'recipe-schema-org-export-v1', structure, revision,
  recipe: { '@context': 'https://schema.org', '@type': 'Recipe', recipeIngredient: ['2 apples'], recipeInstructions: [] } };
let current: { request: RecipeExportRequest | null; saved: RecipeExport | null } = { request: null, saved: null };
let exchangeCalls: RecipeImportRequest[] = [];

type ImportOutcome = 'success' | 'client-too-large' | 'server-too-large' | 'invalid' | 'conflict' | 'stale' | 'denied' | 'lost-response';
const imported: RecipeFileImport = { structure, revision: id(905), sourceObservation: id(906),
  residualDigest: 'b'.repeat(64), replayed: false, receipts: [id(907)] };
const file = () => new File([JSON.stringify({ '@context': 'https://schema.org', '@type': 'Recipe', name: 'Lemon muffins',
  recipeIngredient: ['200 g butter', '1 cup flour'], recipeInstructions: [{ '@type': 'HowToSection', name: 'For the cake',
    itemListElement: [{ '@type': 'HowToStep', text: 'Cream the butter with the sugar.' }] }] })],
  'lemon-muffins.json', { type: 'application/ld+json' });

function Page({ outcome, importOutcome = 'success', locale = 'en' }: {
  outcome: 'success' | 'too-large' | 'denied'; importOutcome?: ImportOutcome; locale?: UiLocale;
}) {
  const [fake] = useState(() => {
    const world = fakeMain({ recipe: startRecipe });
    const recipes = world.main().v1.recipes;
    world.main().v1.recipes = Object.assign((target: Parameters<typeof recipes>[0]) => ({ ...recipes(target), exports: {
      'schema-org': { get: async ({ query }: { query: RecipeExportRequest }) => {
        current.request = { structure, revision: query.revision, actingSubject: query.actingSubject };
        if (outcome === 'too-large') return { data: null, error: { status: 413, value: { code: 'recipe_export_too_large',
          detail: 'Recipe export exceeds 4,096 occurrences' } } };
        if (outcome === 'denied') return { data: null, error: { status: 403, value: { code: 'authority_denied' } } };
        return { data: exported, error: null };
      } },
    } }), { works: recipes.works }) as MainClient['v1']['recipes'];
    return world;
  });
  const [importApi] = useState<RecipeImportApi>(() => {
    let calls = 0;
    return { async importFile(input) {
      exchangeCalls.push(input);
      calls++;
      if (importOutcome === 'server-too-large') throw new RecipeImportError('too-large', 'Recipe file exceeds 256 KiB');
      if (importOutcome === 'invalid') throw new RecipeImportError('invalid', 'Recipe file must use the fixed Schema.org context');
      if (importOutcome === 'conflict') throw new RecipeImportError('conflict', 'Recipe import exceeds the supported occurrence bound');
      if (importOutcome === 'denied') throw new RecipeImportError('denied');
      if (importOutcome === 'stale' && calls === 1) {
        fake.replaceRecipe({ ...fake.world().recipe, head: id(908), nodes: [...fake.world().recipe.nodes,
          { occurrence: id(909), parent: structure, role: 'ingredient', qualifier: qualifierOf(parseLine('1 tsp lemon zest'), 'en') }] });
        throw new RecipeImportError('stale', 'expected composition head is stale');
      }
      if (importOutcome === 'lost-response' && calls === 1) throw new RecipeImportError('unavailable');
      fake.replaceRecipe({ ...startRecipe, head: imported.revision, nodes: [
        { occurrence: id(910), parent: structure, role: 'group', label: { value: 'For the cake', language: 'en' } },
        { occurrence: id(911), parent: id(910), role: 'ingredient', qualifier: qualifierOf(parseLine('200 g butter'), 'en') },
        { occurrence: id(912), parent: id(910), role: 'ingredient', qualifier: qualifierOf(parseLine('1 cup flour'), 'en') },
        { occurrence: id(913), parent: id(910), role: 'step', qualifier: { type: 'recipe-step',
          instructionText: { value: 'Cream the butter with the sugar.', language: 'en' }, usesIngredient: [id(911)], media: [], scaling: 'linear' } },
      ] });
      return { ...imported, replayed: importOutcome === 'lost-response' };
    } };
  });
  const [view, setView] = useState<RecipeAuthoringMapped | null>(null);
  useEffect(() => {
    let mounted = true;
    void loadRecipeAuthoring(fake.main(), { id: work.slice(-36), actingSubject, signedIn: true }).then(next => {
      if (mounted) setView(next);
    });
    return () => { mounted = false; };
  }, [fake]);
  const [sequence] = useState(() => ({ value: 0 }));
  return <EditLayout>{view ? <RecipeAuthoringBody view={view} workRef={work.slice(-36)} workHref={globalWorkHref(work)}
    locale={locale} signInHref="/auth/start" main={fake.main} importApi={importApi}
    saveExport={value => { current.saved = value; }} newImportId={() => `story-${++sequence.value}`} />
    : <RecipeAuthoringPending locale={locale} />}</EditLayout>;
}

const meta = { title: 'Recipe editor/Exchange', component: Page, args: { outcome: 'success' },
  parameters: { recipeProveStates, docs: { description: { component: 'Unrecorded contract controls in the production editor. Refreshed and imported content is read back through its typed client; no substitute stale panel is rendered.' } }, route: { pathname: localizedPath(recipeEditHref(structure), 'en') } } } satisfies Meta<typeof Page>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The downloaded filename and status name the revision Main returned. */
export const SelectedRevision: Story = {
  async play({ canvasElement }) {
    current = { request: null, saved: null };
    const canvas = within(canvasElement);
    await canvas.findByRole('textbox', { name: copyOf('en').title });
    await userEvent.click(canvas.getByRole('button', { name: copyOf('en').exportAction }));
    await waitFor(() => expect(canvas.getByRole('status')).toHaveTextContent('Downloaded revision 00000000-0000-4000-8000-000000000900.'));
    await expect(current.request).toEqual({ structure, revision, actingSubject });
    await expect(current.saved).toEqual(exported);
  },
};

/** Main’s typed 413 explanation is shown verbatim. */
export const OverExportLimit: Story = {
  args: { outcome: 'too-large' }, globals: { viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    current = { request: null, saved: null };
    const canvas = within(canvasElement);
    await canvas.findByRole('textbox', { name: copyOf('en').title });
    await userEvent.click(canvas.getByRole('button', { name: copyOf('en').exportAction }));
    await expect(canvas.getByRole('alert')).toHaveTextContent('Recipe export exceeds 4,096 occurrences');
  },
};

/** When read authority is denied, the control explains that the recipe cannot be exported. */
export const ReadDenied: Story = {
  args: { outcome: 'denied' },
  async play({ canvasElement }) {
    current = { request: null, saved: null };
    const canvas = within(canvasElement);
    await canvas.findByRole('textbox', { name: copyOf('en').title });
    await userEvent.click(canvas.getByRole('button', { name: copyOf('en').exportAction }));
    await expect(canvas.getByRole('alert')).toHaveTextContent(copyOf('en').exportDenied);
  },
};

/** A successful upload is read back into the editor, including its sections, ingredients and steps. */
export const ImportSuccess: Story = {
  args: { outcome: 'success', importOutcome: 'success' },
  async play({ canvasElement }) {
    current = { request: null, saved: null };
    exchangeCalls = [];
    const canvas = within(canvasElement);
    await canvas.findByRole('textbox', { name: copyOf('en').title });
    await userEvent.upload(canvas.getByLabelText(copyOf('en').importAction, { selector: 'input' }), file());
    await expect(await canvas.findByText('Imported into revision 00000000-0000-4000-8000-000000000905.')).toBeVisible();
    await expect(canvas.getByRole('textbox', { name: copyOf('en').sectionName })).toHaveValue('For the cake');
    await expect(within(canvas.getByRole('region', { name: copyOf('en').ingredientsHeading })).getByText('200 g butter')).toBeInTheDocument();
    await expect(within(canvas.getByRole('region', { name: copyOf('en').ingredientsHeading })).getByText('1 cup flour')).toBeInTheDocument();
    await expect(canvas.getByRole('textbox', { name: copyOf('en').stepText({ number: '1' }) })).toHaveValue('Cream the butter with the sugar.');
    await expect(exchangeCalls).toHaveLength(1);
    await expect(exchangeCalls[0]).toMatchObject({ structure, expectedHead: revision, actingSubject,
      idempotencyKey: 'recipe-file-import:story-1' });
  },
};

/** The client rejects an oversized file before the adapter can send it. */
export const ImportClientTooLarge: Story = {
  args: { outcome: 'success', importOutcome: 'client-too-large' }, globals: { viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    current = { request: null, saved: null };
    exchangeCalls = [];
    const canvas = within(canvasElement);
    await canvas.findByRole('textbox', { name: copyOf('en').title });
    await userEvent.upload(canvas.getByLabelText(copyOf('en').importAction, { selector: 'input' }),
      new File([new Uint8Array(RECIPE_FILE_MAX_BYTES + 1)], 'too-large.json', { type: 'application/json' }));
    await expect(canvas.getByRole('alert')).toHaveTextContent(copyOf('en').importTooLarge);
    await expect(exchangeCalls).toHaveLength(0);
  },
};

/** The typed 413 explanation from Main remains visible. */
export const ImportServerTooLarge: Story = {
  args: { outcome: 'success', importOutcome: 'server-too-large' },
  async play({ canvasElement }) {
    exchangeCalls = [];
    const canvas = within(canvasElement);
    await canvas.findByRole('textbox', { name: copyOf('en').title });
    await userEvent.upload(canvas.getByLabelText(copyOf('en').importAction, { selector: 'input' }), file());
    await expect(canvas.getByRole('alert')).toHaveTextContent('Recipe file exceeds 256 KiB');
  },
};

/** The typed 422 explanation from Main is shown instead of being hidden behind a generic error. */
export const ImportInvalidFile: Story = {
  args: { outcome: 'success', importOutcome: 'invalid' },
  async play({ canvasElement }) {
    exchangeCalls = [];
    const canvas = within(canvasElement);
    await canvas.findByRole('textbox', { name: copyOf('en').title });
    await userEvent.upload(canvas.getByLabelText(copyOf('en').importAction, { selector: 'input' }), file());
    await expect(canvas.getByRole('alert')).toHaveTextContent('Recipe file must use the fixed Schema.org context');
  },
};

/** A non-stale 409 shows Main's reason and does not offer a same-key retry. */
export const ImportConflict: Story = {
  args: { outcome: 'success', importOutcome: 'conflict' },
  async play({ canvasElement }) {
    exchangeCalls = [];
    const canvas = within(canvasElement);
    await canvas.findByRole('textbox', { name: copyOf('en').title });
    await userEvent.upload(canvas.getByLabelText(copyOf('en').importAction, { selector: 'input' }), file());
    const alert = canvas.getByRole('alert');
    await expect(alert).toHaveTextContent(copyOf('en').importConflict);
    await expect(alert).toHaveTextContent('Recipe import exceeds the supported occurrence bound');
    await expect(canvas.queryByRole('button', { name: copyOf('en').retry })).not.toBeInTheDocument();
  },
};

/** A stale head is read back; a second click confirms the new head and starts a new command. */
export const ImportStaleHead: Story = {
  args: { outcome: 'success', importOutcome: 'stale' },
  async play({ canvasElement }) {
    exchangeCalls = [];
    const canvas = within(canvasElement);
    await canvas.findByRole('textbox', { name: copyOf('en').title });
    await userEvent.upload(canvas.getByLabelText(copyOf('en').importAction, { selector: 'input' }), file());
    await expect(canvas.getByRole('alert')).toHaveTextContent(copyOf('en').importStale);
    await expect(within(canvas.getByRole('region', { name: copyOf('en').ingredientsHeading })).getByText('1 tsp lemon zest')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: copyOf('en').importStaleAction }));
    await expect(await canvas.findByText('Imported into revision 00000000-0000-4000-8000-000000000905.')).toBeVisible();
    await expect(exchangeCalls).toHaveLength(2);
    await expect(exchangeCalls[0]?.expectedHead).toBe(revision);
    await expect(exchangeCalls[1]?.expectedHead).toBe(id(908));
    await expect(exchangeCalls[0]?.idempotencyKey).not.toBe(exchangeCalls[1]?.idempotencyKey);
  },
};

/** An access refusal is clear and does not offer a retry that cannot succeed. */
export const ImportDenied: Story = {
  args: { outcome: 'success', importOutcome: 'denied' },
  async play({ canvasElement, args }) {
    exchangeCalls = [];
    const copy = copyOf(args.locale ?? 'en');
    const canvas = within(canvasElement);
    await canvas.findByRole('textbox', { name: copy.title });
    await userEvent.upload(canvas.getByLabelText(copy.importAction, { selector: 'input' }), file());
    await expect(canvas.getByRole('alert')).toHaveTextContent(copy.importDenied);
  },
};

export const ImportDeniedPhoneChinese: Story = {
  ...ImportDenied,
  args: { ...ImportDenied.args, locale: 'zh-Hans' },
  globals: { locale: 'zh-Hans', viewport: { value: 'phone' } },
  parameters: { recipeProveStates, docs: { description: { component: 'Unrecorded contract controls in the production editor. Refreshed and imported content is read back through its typed client; no substitute stale panel is rendered.' } }, route: { pathname: localizedPath(recipeEditHref(structure), 'zh-Hans') } },
};

/** An uncertain response can be retried with the identical file, head and idempotency key. */
export const ImportLostResponseRetry: Story = {
  args: { outcome: 'success', importOutcome: 'lost-response' },
  async play({ canvasElement }) {
    exchangeCalls = [];
    const canvas = within(canvasElement);
    await canvas.findByRole('textbox', { name: copyOf('en').title });
    await userEvent.upload(canvas.getByLabelText(copyOf('en').importAction, { selector: 'input' }), file());
    await expect(canvas.getByRole('alert')).toHaveTextContent(copyOf('en').importUnavailable);
    await userEvent.click(canvas.getByRole('button', { name: copyOf('en').retry }));
    await expect(await canvas.findByText('Imported into revision 00000000-0000-4000-8000-000000000905.')).toBeVisible();
    await expect(exchangeCalls).toHaveLength(2);
    await expect(exchangeCalls[1]).toEqual(exchangeCalls[0]);
  },
};
