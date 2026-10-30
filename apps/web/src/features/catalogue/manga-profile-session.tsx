import { useCallback, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@rezics/ui/shadcn/button';
import { useSession } from '../../session/query';
import { csrfHeaders } from '../../threads/composer';
import { m } from '../../paraglide/messages.js';
import { MangaProfileEditor } from './manga-profile-view';
import { loadMangaProfile, createCatalogueManga } from './manga-profile-actions';
import { readCreatedCatalogueSubject } from './create-subject-actions';
import { relationTargetSearch } from './relation-editor-search';
import { RelationEditorSession } from './relation-editor-session';
import { submitFactCorrection } from './subject-facts-actions';
import { readSubjectCandidates, confirmSubjectCandidate } from '../pages/curate-actions';
import { AuthoredField } from './authored-field-view';
import {
  loadAuthoredField,
  submitAuthoredField,
  loadAuthoredReview,
  confirmAuthoredField,
} from './authored-field-actions';
import { EditorFailure } from './statement-editor-view';

export function MangaProfileSession({ id, locale }: { id?: string; locale: string }) {
  const { state } = useSession();
  const search = useCallback(
    (text: string, signal: AbortSignal) => relationTargetSearch(text, signal, locale),
    [locale],
  );
  const load = useCallback(() => loadMangaProfile({ data: id }), [id]);
  return (
    <MangaProfileEditor
      id={id}
      locale={locale}
      session={state}
      search={search}
      transport={{
        load,
        create: (data) => createCatalogueManga({ data, headers: csrfHeaders() }),
        read: (data) => readCreatedCatalogueSubject({ data }),
      }}
      correction={
        id
          ? {
              facts: {
                read: async () => {
                  const read = await load();
                  return read.ok && read.public
                    ? { ...read, public: read.public, source: null }
                    : { ok: false, reason: 'unavailable' };
                },
                propose: (data) => submitFactCorrection({ data, headers: csrfHeaders() }),
              },
              review: (_property, initialSession) => {
                let session = initialSession;
                return {
                  read: async (property, cursor) => {
                    const result = await readSubjectCandidates({
                      data: { id, property, cursor, session },
                      headers: csrfHeaders(),
                    });
                    if (result.ok) session = result.session ?? session;
                    return result;
                  },
                  confirm: async (data) => {
                    const result = await confirmSubjectCandidate({
                      data: { ...data, session },
                      headers: csrfHeaders(),
                    });
                    if (result.ok) session = result.session ?? session;
                    return result;
                  },
                };
              },
              relations: <RelationEditorSession id={id} locale={locale} />,
              authored: <MangaAuthoredSession id={id} locale={locale} />,
            }
          : undefined
      }
    />
  );
}

function MangaAuthoredSession({ id, locale }: { id: string; locale: string }) {
  const [open, setOpen] = useState(false);
  const o = { locale: locale as never };
  const read = (property = 'schema:abstract', session?: string) =>
    loadAuthoredField({ data: { id, property, session }, headers: csrfHeaders() });
  const query = useQuery({
    queryKey: ['manga-authored', id, locale],
    queryFn: () => read(),
    enabled: open,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    staleTime: Infinity,
  });
  return (
    <div className="space-y-4">
      <Button variant="outline" onClick={() => setOpen(true)}>
        {m.authored_title({}, o)}
      </Button>
      {open && query.isPending && <p role="status">{m.candidate_loading({}, o)}</p>}
      {open && query.isError && (
        <>
          <EditorFailure locale={locale} reason="unavailable" />
          <Button onClick={() => void query.refetch()}>{m.correction_reload({}, o)}</Button>
        </>
      )}
      {open && query.data && (
        <AuthoredField
          locale={locale}
          initial={query.data}
          transport={{
            read,
            propose: (data) => submitAuthoredField({ data, headers: csrfHeaders() }),
            review: (property, candidate, cursor, session) =>
              loadAuthoredReview({ data: { id, property, candidate, cursor, session }, headers: csrfHeaders() }),
          }}
          confirm={(data) => confirmAuthoredField({ data, headers: csrfHeaders() })}
        />
      )}
    </div>
  );
}
