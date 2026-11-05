import { createFileRoute } from '@tanstack/react-router';
import { RecipeEditorSession } from '../../features/catalogue/recipe-editor-session';
import { getLocale } from '../../paraglide/runtime';
import { m } from '../../paraglide/messages.js';

export const Route = createFileRoute('/catalogue/recipe')({
  staticData: { publicCache: false },
  head: () => ({ meta: [{ title: m.recipe_title() }, { name: 'robots', content: 'noindex, nofollow' }] }),
  component: () => <RecipeEditorSession locale={getLocale()} />,
});
