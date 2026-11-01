import { editorRequest } from './editor-request';
import { useCatalogueLifetime } from '../../subject/candidate-lifetime';
import { candidateSession, useCandidateWork } from '../../subject/candidate-lifetime';
import { useQuery } from '@tanstack/react-query';
import { useSession } from '../../session/query';
import { csrfHeaders } from '../../threads/composer';
import { EditorFailure } from './statement-editor-view';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import { readCreatedCatalogueSubject } from './create-subject-actions';
import { loadLiteraryProfile, createCatalogueLiteraryWork } from './literary-profile-actions';
import { LiteraryProfile } from './literary-profile-view';
import { readCorrection, readCorrectionReview, confirmCorrection } from './statement-editor-actions';
import { submitFactCorrection } from './subject-facts-actions';
import { RelationEditorSession } from './relation-editor-session';
import { AuthoredField } from './authored-field-view';
import {
  loadAuthoredField,
  submitAuthoredField,
  loadAuthoredReview,
  confirmAuthoredField,
} from './authored-field-actions';
import type { LiteraryCommand } from './literary-profile';

function LiteraryAuthored({ id, locale }: { id: string; locale: string }) {
  const editorWork = useCatalogueLifetime('transport');
  const candidateWork = useCandidateWork(JSON.stringify([id, locale]));
  const read = (property?: string, session?: string) =>
    loadAuthoredField({ data: editorRequest({ id, property, session }, editorWork), headers: csrfHeaders() });
  const query = useQuery({
    queryKey: ['literary-authored', id, locale, candidateWork.generation],
    queryFn: () => (candidateWork.live() ? read() : Promise.resolve({ ok: false, reason: 'denied' } as const)),
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  if (query.isError)
    return (
      <div className="space-y-3">
        <EditorFailure locale={locale} reason="unavailable" />
        <Button variant="outline" onClick={() => candidateWork.live() && void query.refetch()}>
          {m.correction_reload({}, { locale: locale as never })}
        </Button>
      </div>
    );
  if (!query.data) return <p role="status">{m.candidate_loading({}, { locale: locale as never })}</p>;
  return (
    <AuthoredField
      initial={query.data}
      locale={locale}
      transport={{
        read,
        propose: (data) => submitAuthoredField({ data: editorRequest(data, editorWork), headers: csrfHeaders() }),
        review: (property, candidate, cursor, session, work) =>
          !work?.live()
            ? Promise.resolve({ comparison: { ok: false, reason: 'denied' }, body: null })
            : loadAuthoredReview({
                data: { id, property, candidate, cursor, session, expectedReader: work.reader },
                headers: csrfHeaders(),
              }),
      }}
      confirm={(data, work) =>
        !work?.live()
          ? Promise.resolve({ ok: false, reason: 'denied' })
          : confirmAuthoredField({ data, headers: csrfHeaders() })
      }
    />
  );
}
function LiteraryProfileSessionLive({ id, locale }: { id?: string; locale: string }) {
  const editorWork = useCatalogueLifetime('transport');
  const { state } = useSession();
  return (
    <LiteraryProfile
      id={id}
      locale={locale}
      session={state}
      transport={{
        load: () => loadLiteraryProfile({ data: id }),
        submit: (command) =>
          createCatalogueLiteraryWork({
            data: editorRequest(command as LiteraryCommand, editorWork),
            headers: csrfHeaders(),
          }),
        read: (data) => readCreatedCatalogueSubject({ data }),
      }}
      facts={{
        read: () => readCorrection({ data: editorRequest({ id: id ?? '' }, editorWork), headers: csrfHeaders() }),
        propose: (data) => submitFactCorrection({ data: editorRequest(data, editorWork), headers: csrfHeaders() }),
      }}
      review={(property, initialSession) => {
        return {
          read: async (_property, cursor, session = initialSession, work) => {
            if (!work?.live()) return { ok: false, reason: 'denied' };
            const result = await readCorrectionReview({
              data: { expectedReader: work.reader, id: id ?? '', property, cursor, session },
              headers: csrfHeaders(),
            });
            return result;
          },
          confirm: async (command, work) => {
            if (!work?.live()) return { ok: false, reason: 'denied' };
            const result = await confirmCorrection({ data: command, headers: csrfHeaders() });
            return result;
          },
        };
      }}
      relations={id ? <RelationEditorSession id={id} locale={locale} /> : undefined}
      authored={id ? <LiteraryAuthored id={id} locale={locale} /> : undefined}
    />
  );
}

export const LiteraryProfileSession = candidateSession(LiteraryProfileSessionLive);
