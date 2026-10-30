import { useCallback } from 'react';
import { useSession } from '../../session/query';
import { csrfHeaders } from '../../threads/composer';
import { RecipeEditor } from './recipe-editor-view';
import { relationTargetSearch } from './relation-editor-search';
import {
  loadRecipeEditor,
  createCatalogueRecipe,
  submitRecipeCorrection,
  loadRecipeReview,
  confirmRecipeReview,
} from './recipe-editor-actions';
import { readCreatedCatalogueSubject } from './create-subject-actions';

export function RecipeEditorSession({ id, locale }: { id?: string; locale: string }) {
  const { state } = useSession();
  const search = useCallback(
    (text: string, signal: AbortSignal) => relationTargetSearch(text, signal, locale),
    [locale],
  );
  return (
    <RecipeEditor
      {...(id ? { id } : {})}
      locale={locale}
      session={state}
      search={search}
      transport={{
        load: () => loadRecipeEditor({ data: id }),
        create: (data) => createCatalogueRecipe({ data, headers: csrfHeaders() }),
        propose: (data) => submitRecipeCorrection({ data, headers: csrfHeaders() }),
        read: (data) => readCreatedCatalogueSubject({ data }),
      }}
      review={(property, slot, initialSession) => {
        let session = initialSession;
        return {
          read: async (_property, cursor) => {
            const result = await loadRecipeReview({
              data: {
                id: id!,
                property,
                ...(slot ? { slot } : {}),
                ...(cursor ? { cursor } : {}),
                ...(session ? { session } : {}),
              },
              headers: csrfHeaders(),
            });
            if (result.ok) session = result.session ?? session;
            return result;
          },
          confirm: async (command) => {
            const result = await confirmRecipeReview({
              data: { ...command, ...(slot ? { slot } : {}), ...(session ? { session } : {}) },
              headers: csrfHeaders(),
            });
            if (result.ok) session = result.session ?? session;
            return result;
          },
        };
      }}
    />
  );
}
