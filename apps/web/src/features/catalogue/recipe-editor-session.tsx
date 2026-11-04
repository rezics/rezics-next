import { editorRequest } from './editor-request';
import { useCatalogueLifetime } from '../../subject/candidate-lifetime';
import { candidateSession } from '../../subject/candidate-lifetime';
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
import { readCatalogueCreateEligibility, readCreatedCatalogueSubject } from './create-subject-actions';

function RecipeEditorSessionLive({ id, locale }: { id?: string; locale: string }) {
  const editorWork = useCatalogueLifetime('transport');
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
        ...(id ? {} : { eligibility: () => readCatalogueCreateEligibility() }),
        create: (data, replay) =>
          createCatalogueRecipe({
            data: editorRequest(replay ? { ...data, replay: true } : data, editorWork),
            headers: csrfHeaders(),
          }),
        propose: (data, replay) =>
          submitRecipeCorrection({
            data: editorRequest(replay ? { ...data, replay: true } : data, editorWork),
            headers: csrfHeaders(),
          }),
        read: (data) => readCreatedCatalogueSubject({ data }),
      }}
      review={(property, slot, initialSession) => {
        return {
          read: async (_property, cursor, session = initialSession, work) => {
            if (!work?.live()) return { ok: false, reason: 'denied' };
            const result = await loadRecipeReview({
              data: {
                expectedReader: work.reader,
                id: id!,
                property,
                ...(slot ? { slot } : {}),
                ...(cursor ? { cursor } : {}),
                ...(session ? { session } : {}),
              },
              headers: csrfHeaders(),
            });
            return result;
          },
          confirm: async (command, work) => {
            if (!work?.live()) return { ok: false, reason: 'denied' };
            const result = await confirmRecipeReview({
              data: command,
              headers: csrfHeaders(),
            });
            return result;
          },
        };
      }}
    />
  );
}

export const RecipeEditorSession = candidateSession(RecipeEditorSessionLive);
