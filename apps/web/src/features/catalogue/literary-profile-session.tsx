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
  const read = (property?: string, session?: string) =>
    loadAuthoredField({ data: { id, property, session }, headers: csrfHeaders() });
  const query = useQuery({
    queryKey: ['literary-authored', id, locale],
    queryFn: () => read(),
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  if (query.isError)
    return (
      <div className="space-y-3">
        <EditorFailure locale={locale} reason="unavailable" />
        <Button variant="outline" onClick={() => void query.refetch()}>
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
        propose: (data) => submitAuthoredField({ data, headers: csrfHeaders() }),
        review: (property, candidate, cursor, session) =>
          loadAuthoredReview({ data: { id, property, candidate, cursor, session }, headers: csrfHeaders() }),
      }}
      confirm={(data) => confirmAuthoredField({ data, headers: csrfHeaders() })}
    />
  );
}
export function LiteraryProfileSession({ id, locale }: { id?: string; locale: string }) {
  const { state } = useSession();
  return (
    <LiteraryProfile
      id={id}
      locale={locale}
      session={state}
      transport={{
        load: () => loadLiteraryProfile({ data: id }),
        submit: (command) => createCatalogueLiteraryWork({ data: command as LiteraryCommand, headers: csrfHeaders() }),
        read: (data) => readCreatedCatalogueSubject({ data }),
      }}
      facts={{
        read: () => readCorrection({ data: { id: id ?? '' }, headers: csrfHeaders() }),
        propose: (data) => submitFactCorrection({ data, headers: csrfHeaders() }),
      }}
      review={(property, initialSession) => {
        let session = initialSession;
        return {
          read: async (_property, cursor) => {
            const result = await readCorrectionReview({
              data: { id: id ?? '', property, cursor, session },
              headers: csrfHeaders(),
            });
            if (result.ok) session = result.session ?? session;
            return result;
          },
          confirm: async (command) => {
            const result = await confirmCorrection({ data: { ...command, session }, headers: csrfHeaders() });
            if (result.ok) session = result.session ?? session;
            return result;
          },
        };
      }}
      relations={id ? <RelationEditorSession id={id} locale={locale} /> : undefined}
      authored={id ? <LiteraryAuthored id={id} locale={locale} /> : undefined}
    />
  );
}
