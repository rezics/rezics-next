import { LiteraryCurrentVisitAdmission } from './literary-current-visit-view';
import type { LiteraryVisitInput } from './literary-current-visit';
import { subjectHref } from '../../subject/subject-href';
import { useEffect, useRef } from 'react';
import { useCurrentReadingActive, useCurrentReadingVisible } from './editor-lifetime';
import { editorRequest } from './editor-request';
import { useCatalogueLifetime } from '../../subject/candidate-lifetime';
import { candidateSession, useCandidateWork } from '../../subject/candidate-lifetime';
import { useQuery } from '@tanstack/react-query';
import { useSession } from '../../session/query';
import { csrfHeaders } from '../../threads/composer';
import { EditorFailure } from './statement-editor-view';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import { readCatalogueCreateEligibility, readCreatedCatalogueSubject } from './create-subject-actions';
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
  const active = useCurrentReadingActive();
  const visible = useCurrentReadingVisible();
  const read = async (property?: string, session?: string) => {
    if (!active()) throw new Error('Retired catalogue editor');
    const result = await loadAuthoredField({
      data: editorRequest({ id, property, session }, editorWork),
      headers: csrfHeaders(),
    });
    if (!active()) throw new Error('Retired catalogue editor');
    return editorWork.live() ? result : ({ ok: false, reason: 'denied' } as const);
  };
  const query = useQuery({
    queryKey: ['literary-authored', id, locale, candidateWork.generation],
    queryFn: () => (candidateWork.live() ? read() : Promise.resolve({ ok: false, reason: 'denied' } as const)),
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const wasVisible = useRef(visible);
  useEffect(() => {
    const resumed = visible && !wasVisible.current;
    wasVisible.current = visible;
    if (resumed && !query.data && active()) void query.refetch();
  }, [visible]);
  if (query.isError && !query.data)
    return !visible ? null : (
      <div className="space-y-3">
        <EditorFailure locale={locale} reason="unavailable" />
        <Button variant="outline" onClick={() => active() && candidateWork.live() && void query.refetch()}>
          {m.correction_reload({}, { locale: locale as never })}
        </Button>
      </div>
    );
  if (!query.data) return visible ? <p role="status">{m.candidate_loading({}, { locale: locale as never })}</p> : null;
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
function LiteraryProfileSessionLive({
  id,
  locale,
  address,
  expectedType,
}: {
  id?: string;
  locale: string;
  address?: string | undefined;
  expectedType?: string | undefined;
}) {
  const editorWork = useCatalogueLifetime('transport');
  const { state } = useSession();
  return (
    <LiteraryProfile
      id={id}
      locale={locale}
      address={address}
      session={state}
      transport={{
        load: () => loadLiteraryProfile({ data: expectedType && id ? { id, type: expectedType } : id }),
        eligibility: () => readCatalogueCreateEligibility(),
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

function LiteraryProfileVisit({
  id,
  locale,
  visit = { kind: 'direct' },
  address,
}: {
  id?: string;
  locale: string;
  visit?: LiteraryVisitInput;
  address?: string;
}) {
  const globalHref = id ? `${subjectHref({ id, label: '' }, locale).href}/literary` : `/${locale}/catalogue/literary`;
  return (
    <LiteraryCurrentVisitAdmission input={visit} locale={locale} globalHref={globalHref}>
      <LiteraryProfileSessionLive
        id={id}
        locale={locale}
        address={address}
        expectedType={visit.kind === 'visit' ? visit.visit.type : undefined}
      />
    </LiteraryCurrentVisitAdmission>
  );
}
export const LiteraryProfileSession = candidateSession(LiteraryProfileVisit);
