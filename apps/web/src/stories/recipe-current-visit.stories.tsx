import type { Meta, StoryObj } from '@storybook/react-vite';
import { getLocale } from '../paraglide/runtime';
import { RecipeCurrentVisitReturn } from '../features/catalogue/recipe-current-visit-view';
import type { RecipeCurrentReturnState } from '../features/catalogue/recipe-current-visit';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';

function RecipeReturnStory({ state }: { state: RecipeCurrentReturnState }) {
  const locale = getLocale();
  return (
    <PatternStory path={`/en/subjects/0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e10/lentil-soup?recipeReturn=story`}>
      <AppShell>
        <main className="mx-auto max-w-3xl space-y-6 px-4 py-8">
          <h1 className="text-2xl font-semibold">Lentil soup</h1>
          <RecipeCurrentVisitReturn
            locale={locale}
            address="/en/subjects/0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e10/lentil-soup?recipeReturn=story"
            state={state}
            restartHref="/en/subjects/0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e10/lentil-soup/recipe?context=0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e10"
          />
        </main>
      </AppShell>
    </PatternStory>
  );
}

const meta = {
  title: 'Pages/Catalogue/Recipe current visit',
  component: RecipeReturnStory,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof RecipeReturnStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ContextChanged: Story = { args: { state: 'changed' } };
export const OccurrenceRemovedOrWithheld: Story = { args: { state: 'removed' } };
export const PublicDestinationUnsupported: Story = { args: { state: 'unsupported' } };
