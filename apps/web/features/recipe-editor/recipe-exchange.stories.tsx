import type { Meta, StoryObj } from '@storybook/react-vite';
import { localizedPath } from '../../i18n/locale.ts';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { actingSubject, id, structure } from './fixtures.ts';
import { RecipeExportError, type RecipeExport, type RecipeExportApi, type RecipeExportRequest } from './export-api.ts';
import { copyOf, messages } from './messages.ts';
import { recipeEditHref } from './route.ts';
import { RecipeExchange } from './recipe-exchange.tsx';

const revision = id(900);
const exported: RecipeExport = { profile: 'recipe-schema-org-export-v1', structure, revision,
  recipe: { '@context': 'https://schema.org', '@type': 'Recipe', recipeIngredient: ['2 apples'], recipeInstructions: [] } };
let current: { request: RecipeExportRequest | null; saved: RecipeExport | null } = { request: null, saved: null };

function Page({ outcome, locale = 'en' }: { outcome: 'success' | 'too-large' | 'denied'; locale?: UiLocale }) {
  const [api] = useState<RecipeExportApi>(() => ({
    async exportRevision(input) {
      current.request = input;
      if (outcome === 'too-large') throw new RecipeExportError('too-large', 'Recipe export exceeds 4,096 occurrences');
      if (outcome === 'denied') throw new RecipeExportError('denied');
      return exported;
    },
  }));
  const save = (file: RecipeExport) => { current.saved = file; };
  return <div className="mx-auto grid max-w-[72rem] gap-6 px-4 py-6 sm:px-8">
    <header className="sticky top-0 z-20 -mx-4 grid gap-2 border-border/60 border-b bg-background/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-b-2xl sm:px-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <a href={localizedPath(recipeEditHref(structure), locale)} className="text-sm">Back to the recipe</a>
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-x-3 gap-y-2">
          <RecipeExchange structure={structure} revision={revision} actingSubject={actingSubject} locale={locale}
            messages={messages[locale]} api={api} save={save} />
          <p className="text-muted-foreground text-sm">All changes saved</p>
        </div>
      </div>
      <div className="font-medium">Publish</div>
    </header>
    <section className="rounded-2xl border border-border/60 p-5">
      <h1 className="font-semibold text-xl">Lemon muffins</h1>
      <p className="mt-2 text-muted-foreground">Bright and tender.</p>
    </section>
  </div>;
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
  },
};
