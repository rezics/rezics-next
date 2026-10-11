import type { Meta, StoryObj } from '@storybook/react-vite';
import { localizedPath } from '../../i18n/locale.ts';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { actingSubject, id, structure } from './fixtures.ts';
import { RecipeExportError, type RecipeExport, type RecipeExportApi, type RecipeExportRequest } from './export-api.ts';
import { RecipeImportError, RECIPE_FILE_MAX_BYTES, type RecipeFileImport, type RecipeImportApi,
  type RecipeImportRequest } from './import-api.ts';
import { copyOf, messages } from './messages.ts';
import { recipeEditHref } from './route.ts';
import { RecipeExchange } from './recipe-exchange.tsx';

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
  const [api] = useState<RecipeExportApi>(() => ({
    async exportRevision(input) {
      current.request = input;
      if (outcome === 'too-large') throw new RecipeExportError('too-large', 'Recipe export exceeds 4,096 occurrences');
      if (outcome === 'denied') throw new RecipeExportError('denied');
      return exported;
    },
  }));
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
        throw new RecipeImportError('stale', 'expected composition head is stale');
      }
      if (importOutcome === 'lost-response' && calls === 1) throw new RecipeImportError('unavailable');
      return { ...imported, replayed: importOutcome === 'lost-response' };
    } };
  });
  const [head, setHead] = useState(revision);
  const [freshlyRead, setFreshlyRead] = useState(false);
  const [hasImported, setHasImported] = useState(false);
  const [keyNumber, setKeyNumber] = useState(0);
  const save = (file: RecipeExport) => { current.saved = file; };
  return <div className="mx-auto grid max-w-[72rem] gap-6 px-4 py-6 sm:px-8">
    <header className="sticky top-0 z-20 -mx-4 grid gap-2 border-border/60 border-b bg-background/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-b-2xl sm:px-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <a href={localizedPath(recipeEditHref(structure), locale)} className="text-sm">Back to the recipe</a>
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-x-3 gap-y-2">
          <RecipeExchange structure={structure} revision={head} actingSubject={actingSubject} locale={locale}
            messages={messages[locale]} api={api} importApi={importApi} save={save}
            newId={() => { const next = keyNumber + 1; setKeyNumber(next); return `story-${next}`; }}
            onStaleRefresh={async () => { const fresh = id(908); setHead(fresh); setFreshlyRead(true); return fresh; }}
            onImported={async () => { setHasImported(true); return true; }} />
          <p className="text-muted-foreground text-sm">All changes saved</p>
        </div>
      </div>
      <div className="font-medium">Publish</div>
    </header>
    <section className="rounded-2xl border border-border/60 p-5">
      <h1 className="font-semibold text-xl">Lemon muffins</h1>
      <p className="mt-2 text-muted-foreground">Bright and tender.</p>
    </section>
    {freshlyRead && !hasImported ? <section aria-label="Latest recipe from Main" className="rounded-2xl border border-border/60 p-5">
      <h2 className="font-semibold">Latest recipe</h2>
      <p>1 tsp lemon zest</p>
    </section> : null}
    {hasImported ? <section aria-label="Imported recipe" className="grid gap-4 rounded-2xl border border-border/60 p-5">
      <h2 className="font-semibold text-xl">Imported recipe</h2>
      <div><h3 className="font-medium">For the cake</h3>
        <ul><li>200 g butter</li><li>1 cup flour</li></ul></div>
      <div><h3 className="font-medium">Method</h3>
        <ol><li>Cream the butter with the sugar.</li></ol></div>
    </section> : null}
  </div>;
}

async function capture(name: string) {
  if (import.meta.env.VITE_RECIPE_EXCHANGE_VISUAL !== '1') return;
  const { page } = await import('vitest/browser');
  await document.fonts.ready;
  await page.screenshot({ path: `../../../../.temp/recipe-exchange/${name}.png` });
}

const meta = { title: 'Recipe editor/Exchange', component: Page, args: { outcome: 'success' },
  parameters: { route: { pathname: localizedPath(recipeEditHref(structure), 'en') } } } satisfies Meta<typeof Page>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The downloaded filename and status name the revision Main returned. */
export const SelectedRevision: Story = {
  async play({ canvasElement }) {
    current = { request: null, saved: null };
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: copyOf('en').exportAction }));
    await waitFor(() => expect(canvas.getByRole('status')).toHaveTextContent('Downloaded revision 00000000-0000-4000-8000-000000000900.'));
    await capture('selected-revision');
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
    await userEvent.click(canvas.getByRole('button', { name: copyOf('en').exportAction }));
    await expect(canvas.getByRole('alert')).toHaveTextContent('Recipe export exceeds 4,096 occurrences');
    await capture('over-export-limit');
  },
};

/** When read authority is denied, the control explains that the recipe cannot be exported. */
export const ReadDenied: Story = {
  args: { outcome: 'denied' },
  async play({ canvasElement }) {
    current = { request: null, saved: null };
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: copyOf('en').exportAction }));
    await expect(canvas.getByRole('alert')).toHaveTextContent(copyOf('en').exportDenied);
    await capture('read-denied');
  },
};

/** A successful upload is read back into the editor, including its sections, ingredients and steps. */
export const ImportSuccess: Story = {
  args: { outcome: 'success', importOutcome: 'success' },
  async play({ canvasElement }) {
    current = { request: null, saved: null };
    exchangeCalls = [];
    const canvas = within(canvasElement);
    await userEvent.upload(canvas.getByLabelText(copyOf('en').importAction, { selector: 'input' }), file());
    await waitFor(() => expect(canvas.getByRole('status')).toHaveTextContent('Imported into revision 00000000-0000-4000-8000-000000000905.'));
    await expect(canvas.getByRole('heading', { name: 'For the cake' })).toBeInTheDocument();
    await expect(canvas.getByText('200 g butter')).toBeInTheDocument();
    await expect(canvas.getByText('1 cup flour')).toBeInTheDocument();
    await expect(canvas.getByText('Cream the butter with the sugar.')).toBeInTheDocument();
    await expect(exchangeCalls).toHaveLength(1);
    await expect(exchangeCalls[0]).toMatchObject({ structure, expectedHead: revision, actingSubject,
      idempotencyKey: 'recipe-file-import:story-1' });
    await capture('import-success');
  },
};

/** The client rejects an oversized file before the adapter can send it. */
export const ImportClientTooLarge: Story = {
  args: { outcome: 'success', importOutcome: 'client-too-large' }, globals: { viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    current = { request: null, saved: null };
    exchangeCalls = [];
    const canvas = within(canvasElement);
    await userEvent.upload(canvas.getByLabelText(copyOf('en').importAction, { selector: 'input' }),
      new File([new Uint8Array(RECIPE_FILE_MAX_BYTES + 1)], 'too-large.json', { type: 'application/json' }));
    await expect(canvas.getByRole('alert')).toHaveTextContent(copyOf('en').importTooLarge);
    await expect(exchangeCalls).toHaveLength(0);
    await capture('import-client-too-large');
  },
};

/** The typed 413 explanation from Main remains visible. */
export const ImportServerTooLarge: Story = {
  args: { outcome: 'success', importOutcome: 'server-too-large' },
  async play({ canvasElement }) {
    exchangeCalls = [];
    const canvas = within(canvasElement);
    await userEvent.upload(canvas.getByLabelText(copyOf('en').importAction, { selector: 'input' }), file());
    await expect(canvas.getByRole('alert')).toHaveTextContent('Recipe file exceeds 256 KiB');
    await capture('import-server-too-large');
  },
};

/** The typed 422 explanation from Main is shown instead of being hidden behind a generic error. */
export const ImportInvalidFile: Story = {
  args: { outcome: 'success', importOutcome: 'invalid' },
  async play({ canvasElement }) {
    exchangeCalls = [];
    const canvas = within(canvasElement);
    await userEvent.upload(canvas.getByLabelText(copyOf('en').importAction, { selector: 'input' }), file());
    await expect(canvas.getByRole('alert')).toHaveTextContent('Recipe file must use the fixed Schema.org context');
    await capture('import-invalid-file');
  },
};

/** A non-stale 409 shows Main's reason and does not offer a same-key retry. */
export const ImportConflict: Story = {
  args: { outcome: 'success', importOutcome: 'conflict' },
  async play({ canvasElement }) {
    exchangeCalls = [];
    const canvas = within(canvasElement);
    await userEvent.upload(canvas.getByLabelText(copyOf('en').importAction, { selector: 'input' }), file());
    const alert = canvas.getByRole('alert');
    await expect(alert).toHaveTextContent(copyOf('en').importConflict);
    await expect(alert).toHaveTextContent('Recipe import exceeds the supported occurrence bound');
    await expect(canvas.queryByRole('button', { name: copyOf('en').retry })).not.toBeInTheDocument();
    await capture('import-conflict');
  },
};

/** A stale head is read back; a second click confirms the new head and starts a new command. */
export const ImportStaleHead: Story = {
  args: { outcome: 'success', importOutcome: 'stale' },
  async play({ canvasElement }) {
    exchangeCalls = [];
    const canvas = within(canvasElement);
    await userEvent.upload(canvas.getByLabelText(copyOf('en').importAction, { selector: 'input' }), file());
    await expect(canvas.getByRole('alert')).toHaveTextContent(copyOf('en').importStale);
    await expect(canvas.getByRole('region', { name: 'Latest recipe from Main' })).toHaveTextContent('1 tsp lemon zest');
    await capture('import-stale-head');
    await userEvent.click(canvas.getByRole('button', { name: copyOf('en').importStaleAction }));
    await waitFor(() => expect(canvas.getByRole('status')).toHaveTextContent('Imported into revision 00000000-0000-4000-8000-000000000905.'));
    await expect(exchangeCalls).toHaveLength(2);
    await expect(exchangeCalls[0]?.expectedHead).toBe(revision);
    await expect(exchangeCalls[1]?.expectedHead).toBe(id(908));
    await expect(exchangeCalls[0]?.idempotencyKey).not.toBe(exchangeCalls[1]?.idempotencyKey);
    await capture('import-stale-confirmed');
  },
};

/** An access refusal is clear and does not offer a retry that cannot succeed. */
export const ImportDenied: Story = {
  args: { outcome: 'success', importOutcome: 'denied' },
  async play({ canvasElement }) {
    exchangeCalls = [];
    const canvas = within(canvasElement);
    await userEvent.upload(canvas.getByLabelText(copyOf('en').importAction, { selector: 'input' }), file());
    await expect(canvas.getByRole('alert')).toHaveTextContent(copyOf('en').importDenied);
    await capture('import-denied');
  },
};

/** An uncertain response can be retried with the identical file, head and idempotency key. */
export const ImportLostResponseRetry: Story = {
  args: { outcome: 'success', importOutcome: 'lost-response' },
  async play({ canvasElement }) {
    exchangeCalls = [];
    const canvas = within(canvasElement);
    await userEvent.upload(canvas.getByLabelText(copyOf('en').importAction, { selector: 'input' }), file());
    await expect(canvas.getByRole('alert')).toHaveTextContent(copyOf('en').importUnavailable);
    await userEvent.click(canvas.getByRole('button', { name: copyOf('en').retry }));
    await waitFor(() => expect(canvas.getByRole('status')).toHaveTextContent('Imported into revision 00000000-0000-4000-8000-000000000905.'));
    await expect(exchangeCalls).toHaveLength(2);
    await expect(exchangeCalls[1]).toEqual(exchangeCalls[0]);
    await capture('import-lost-response-retry');
  },
};
