import { editorRequest } from './editor-request';
import { useCatalogueLifetime } from '../../subject/candidate-lifetime';
import { candidateSession } from '../../subject/candidate-lifetime';
import { PAGE_GLOBAL_CONTEXT, pickText } from '@rezics/composition';
import { releaseDigest } from '@rezics/definitions';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useId } from 'react';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import { useSession } from '../../session/query';
import { csrfHeaders } from '../../threads/composer';
import { readSubjectCandidates, confirmSubjectCandidate } from '../pages/curate-actions';
import { readCorrection } from './statement-editor-actions';
import { submitFactCorrection } from './subject-facts-actions';
import { readSubjectRelationEditor, proposeSubjectRelation, confirmSubjectRelation } from './relation-editor-actions';
import { readCatalogueCreateEligibility, readCreatedCatalogueSubject } from './create-subject-actions';
import { relationTargetSearch } from './relation-editor-search';
import { createCatalogueScreen, loadScreenProfile } from './screen-profile-actions';
import { ScreenProfile } from './screen-profile-view';
import { ScreenProfileReader } from './screen-profile-reader';
import {
  screenCurrentGlobalHref,
  screenCurrentIdentity,
  screenCurrentReturnHref,
  screenCurrentVisitAvailable,
  type ScreenCurrentOccurrence,
  type ScreenCurrentVisit,
} from './screen-current-visit';
import { catalogueEntries } from './catalogue-entry';

function ScreenProfileSessionLive({
  id,
  locale,
  series,
  context = PAGE_GLOBAL_CONTEXT,
  realm,
  visit,
  entryHref,
  classificationHandoffToken,
}: {
  id?: string;
  locale: string;
  series?: string | undefined;
  context?: string;
  realm?: string;
  visit?: ScreenCurrentVisit;
  entryHref?: string;
  classificationHandoffToken?: string;
}) {
  const editorWork = useCatalogueLifetime('transport');
  const { state } = useSession();
  const search = useCallback(
    (text: string, signal: AbortSignal) => relationTargetSearch(text, signal, locale),
    [locale],
  );
  return (
    <ScreenProfile
      id={id}
      series={series}
      context={context}
      {...(realm ? { realm } : {})}
      locale={locale}
      session={state}
      search={search}
      onNavigate={(href) => window.location.assign(href)}
      {...(classificationHandoffToken ? { classificationHandoffToken } : {})}
      {...(visit ? { visit } : {})}
      handoffReader={editorWork.reader}
      handoffReaderLive={editorWork.live}
      transport={{
        load: () =>
          loadScreenProfile({
            data: {
              ...(id ? { id } : {}),
              ...(series ? { series } : {}),
              ...(id ? { context } : {}),
            },
          }),
        ...(id ? {} : { eligibility: () => readCatalogueCreateEligibility() }),
        create: (data) => createCatalogueScreen({ data: editorRequest(data, editorWork), headers: csrfHeaders() }),
        read: (data) => readCreatedCatalogueSubject({ data }),
        createdRelations: (createdId) => ({
          read: (slot, cursor, session) =>
            readSubjectRelationEditor({
              data: editorRequest({ id: createdId, slot, cursor, session }, editorWork),
              headers: csrfHeaders(),
            }),
          propose: (data) => proposeSubjectRelation({ data: editorRequest(data, editorWork), headers: csrfHeaders() }),
          confirm: (data) => confirmSubjectRelation({ data: editorRequest(data, editorWork), headers: csrfHeaders() }),
        }),
        ...(id
          ? {
              facts: {
                read: () => readCorrection({ data: editorRequest({ id }, editorWork), headers: csrfHeaders() }),
                propose: (data) =>
                  submitFactCorrection({ data: editorRequest(data, editorWork), headers: csrfHeaders() }),
              },
              review: (_property, initialSession) => {
                return {
                  read: async (property, cursor, session = initialSession, work) => {
                    if (!work?.live()) return { ok: false, reason: 'denied' };
                    const result = await readSubjectCandidates({
                      data: { expectedReader: work.reader, id, property, cursor, session },
                      headers: csrfHeaders(),
                    });
                    return result;
                  },
                  confirm: async (command, work) => {
                    if (!work?.live()) return { ok: false, reason: 'denied' };
                    const result = await confirmSubjectCandidate({
                      data: command,
                      headers: csrfHeaders(),
                    });
                    return result;
                  },
                };
              },
              relations: {
                read: (slot, cursor, session) =>
                  readSubjectRelationEditor({
                    data: editorRequest({ id, slot, cursor, session }, editorWork),
                    headers: csrfHeaders(),
                  }),
                propose: (data) =>
                  proposeSubjectRelation({ data: editorRequest(data, editorWork), headers: csrfHeaders() }),
                confirm: (data) =>
                  confirmSubjectRelation({ data: editorRequest(data, editorWork), headers: csrfHeaders() }),
              },
            }
          : {}),
      }}
    />
  );
}

const GlobalScreenProfileSession = candidateSession(ScreenProfileSessionLive);

export function ScreenCurrentVisitRecovery({
  locale,
  globalHref,
  message = 'invalid',
  retry,
}: {
  locale: string;
  globalHref?: string;
  message?: 'invalid' | 'unavailable' | 'concealed';
  retry?: () => void;
}) {
  const o = { locale: locale as never };
  return (
    <main className="mx-auto w-full max-w-4xl min-w-0 space-y-4 px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold">{m.screen_edit({}, o)}</h1>
      <p role="alert">
        {message === 'invalid'
          ? m.screen_visit_invalid({}, o)
          : message === 'concealed'
            ? m.screen_reader_denied({}, o)
            : m.screen_reader_unavailable({}, o)}
      </p>
      {retry ? (
        <button type="button" className={buttonVariants({ variant: 'outline' })} onClick={retry}>
          {m.correction_retry({}, o)}
        </button>
      ) : null}
      {globalHref ? (
        <a className={buttonVariants({ variant: 'outline' })} href={globalHref}>
          {m.screen_visit_global({}, o)}
        </a>
      ) : null}
    </main>
  );
}

function ScreenReadOnlyVisit({
  id,
  locale,
  visit,
  entryHref,
  handoffToken,
}: {
  id: string;
  locale: string;
  visit: ScreenCurrentVisit;
  entryHref: string;
  handoffToken?: string;
}) {
  const incarnation = useId();
  const identity = screenCurrentIdentity(visit, incarnation);
  const query = useQuery({
    queryKey: ['screen-current-read-only', identity],
    queryFn: () => loadScreenProfile({ data: { id, context: visit.context } }),
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  if (query.isPending) {
    return (
      <p role="status" className="mx-auto w-full max-w-4xl px-4 py-8">
        {m.candidate_loading({}, { locale: locale as never })}
      </p>
    );
  }
  const read = query.data;
  const current =
    read?.ok &&
    read.public &&
    read.public.subject.id === id &&
    read.public.subject.context === visit.context &&
    read.public.subject.type === visit.type &&
    releaseDigest(read.release) === read.public.subject.release
      ? read
      : undefined;
  if (!current?.public) {
    const message = !read
      ? 'unavailable'
      : !read.ok
        ? read.reason === 'concealed'
          ? 'concealed'
          : read.reason === 'invalid'
            ? 'invalid'
            : 'unavailable'
        : 'invalid';
    return (
      <ScreenCurrentVisitRecovery
        locale={locale}
        message={message}
        globalHref={screenCurrentGlobalHref(entryHref, handoffToken)}
        retry={() => void query.refetch()}
      />
    );
  }
  const definitionChanged = visit.definition !== current.public.subject.release;
  const occurrence: ScreenCurrentOccurrence | undefined =
    !definitionChanged &&
    visit.occurrence?.holder === id &&
    current.public.subject.statements[visit.occurrence.property]?.some(
      (statement) =>
        statement.id === visit.occurrence!.statement && statement.property.id === visit.occurrence!.property,
    )
      ? visit.occurrence
      : undefined;
  const currentVisit: ScreenCurrentVisit = {
    ...visit,
    definition: current.public.subject.release,
    ...(definitionChanged ? { occurrence: undefined } : {}),
  };
  const label = pickText(current.public.subject.labels, locale).text;
  const readerEntry = catalogueEntries.screen({ id, label, locale }).href;
  const admittedVisit = screenCurrentVisitAvailable(readerEntry, currentVisit) ? currentVisit : undefined;
  return (
    <>
      {definitionChanged ? (
        <p role="status" className="mx-auto w-full max-w-4xl px-4 pt-6">
          {m.screen_visit_reading_changed({}, { locale: locale as never })}
        </p>
      ) : null}
      <ScreenProfileReader
        locale={locale}
        public={current.public}
        release={current.release}
        unsupportedCorrection
        globalHref={screenCurrentGlobalHref(entryHref, handoffToken)}
        returnHref={screenCurrentReturnHref(visit)}
        {...(admittedVisit ? { currentVisit: admittedVisit } : {})}
        {...(occurrence ? { inspection: occurrence } : {})}
        visitIdentity={identity}
        returnNotice={!!visit.occurrence && !occurrence}
      />
    </>
  );
}

export function ScreenProfileSession(props: {
  id?: string;
  locale: string;
  series?: string | undefined;
  context?: string;
  realm?: string;
  visit?: ScreenCurrentVisit;
  entryHref?: string;
  classificationHandoffToken?: string;
}) {
  const { id, locale, visit, entryHref, classificationHandoffToken } = props;
  if (id && visit && visit.context !== PAGE_GLOBAL_CONTEXT) {
    return entryHref ? (
      <ScreenReadOnlyVisit
        id={id}
        locale={locale}
        visit={visit}
        entryHref={entryHref}
        {...(classificationHandoffToken ? { handoffToken: classificationHandoffToken } : {})}
      />
    ) : (
      <ScreenCurrentVisitRecovery locale={locale} />
    );
  }
  return <GlobalScreenProfileSession {...props} context={visit?.context ?? props.context ?? PAGE_GLOBAL_CONTEXT} />;
}
