import { editorRequest } from './editor-request';
import { useCatalogueLifetime } from '../../subject/candidate-lifetime';
import { candidateSession, useCandidateWork } from '../../subject/candidate-lifetime';
import { useCallback, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@rezics/ui/shadcn/button';
import { sessionQuery, useSession } from '../../session/query';
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

function MangaProfileSessionLive({ id, locale }: { id?: string; locale: string }) {
  const editorWork = useCatalogueLifetime('transport');
  const { state } = useSession();
  const session = useQuery({ ...sessionQuery, enabled: false });
  const search = useCallback(
    (text: string, signal: AbortSignal) => relationTargetSearch(text, signal, locale),
    [locale],
  );
  const load = useCallback(() => loadMangaProfile({ data: id }), [id]);
  return (
    <MangaProfileEditor
      id={id}
      locale={locale}
      session={state === 'unknown' && session.isError ? 'unavailable' : state}
      retrySession={() => session.refetch()}
      search={search}
      transport={{
        load,
        create: (data) =>
          createCatalogueManga({
            data: editorRequest(data, editorWork),
            headers: csrfHeaders(),
          }),
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
                propose: (data) =>
                  submitFactCorrection({
                    data: editorRequest(data, editorWork),
                    headers: csrfHeaders(),
                  }),
              },
              review: (_property, initialSession) => {
                return {
                  read: async (property, cursor, session = initialSession, work) => {
                    if (!work?.live()) return { ok: false, reason: 'denied' };
                    const result = await readSubjectCandidates({
                      data: {
                        expectedReader: work.reader,
                        id,
                        property,
                        cursor,
                        session,
                      },
                      headers: csrfHeaders(),
                    });
                    return result;
                  },
                  confirm: async (data, work) => {
                    if (!work?.live()) return { ok: false, reason: 'denied' };
                    const result = await confirmSubjectCandidate({
                      data,
                      headers: csrfHeaders(),
                    });
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
  const editorWork = useCatalogueLifetime('transport');
  const candidateWork = useCandidateWork(JSON.stringify([id, locale]));
  const [open, setOpen] = useState(false);
  const o = { locale: locale as never };
  const read = async (property = 'schema:abstract', session?: string) => {
    const result = await loadAuthoredField({
      data: editorRequest({ id, property, session }, editorWork),
      headers: csrfHeaders(),
    });
    return editorWork.live() ? result : ({ ok: false, reason: 'denied' } as const);
  };
  const query = useQuery({
    queryKey: ['manga-authored', id, locale, candidateWork.generation],
    queryFn: () => (candidateWork.live() ? read() : Promise.resolve({ ok: false, reason: 'denied' } as const)),
    enabled: open,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    staleTime: Infinity,
    gcTime: 0,
  });
  return (
    <div className="space-y-4">
      <Button variant="outline" onClick={() => candidateWork.live() && setOpen(true)}>
        {m.authored_title({}, o)}
      </Button>
      {open && query.isPending && <p role="status">{m.candidate_loading({}, o)}</p>}
      {open && query.isError && (
        <>
          <EditorFailure locale={locale} reason="unavailable" />
          <Button onClick={() => candidateWork.live() && void query.refetch()}>{m.correction_reload({}, o)}</Button>
        </>
      )}
      {open && query.data && (
        <AuthoredField
          locale={locale}
          initial={query.data}
          transport={{
            read,
            propose: (data) =>
              submitAuthoredField({
                data: editorRequest(data, editorWork),
                headers: csrfHeaders(),
              }),
            review: (property, candidate, cursor, session, work) =>
              !work?.live()
                ? Promise.resolve({
                    comparison: { ok: false, reason: 'denied' },
                    body: null,
                  })
                : loadAuthoredReview({
                    data: {
                      id,
                      property,
                      candidate,
                      cursor,
                      session,
                      expectedReader: work.reader,
                    },
                    headers: csrfHeaders(),
                  }),
          }}
          confirm={(data, work) =>
            !work?.live()
              ? Promise.resolve({ ok: false, reason: 'denied' })
              : confirmAuthoredField({ data, headers: csrfHeaders() })
          }
        />
      )}
    </div>
  );
}

export const MangaProfileSession = candidateSession(MangaProfileSessionLive);
