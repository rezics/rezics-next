import { SubjectConnections } from '../../features/pages/subject-connections-view';
import { contextHref } from '../../features/pages/context-navigation';
import { PendingPage } from '../../shell/pending';
import { subjectReaderPartition, useSubjectReaderRefresh } from '../../features/pages/context-reader';
import { useLocation, useRouter } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { SubjectPage } from '../../features/pages/subject';
import { pageRelationProperties, subjectPageTitle, subjectPageType } from '../../features/pages/subject-page-summary';
import { SubjectLink, subjectPageMessages, viewTabLabels } from '../../features/pages/route-support';
import { SubjectHeaderActions } from '../../features/pages/subject-reactions-view';
import { SubjectCandidateCuration } from '../../features/pages/curate-view';
import {
  RatingControlContext,
  RatingsContext,
  RatingsRecoveryContext,
  RatingPopulationsContext,
} from '../../features/pages/subject-ratings-view';
import type { RatingSources, RatingSource } from '../../features/pages/subject-ratings';
import { SubjectRatingPopulations } from '../../features/pages/subject-rating-populations-view';
import { useSubjectPersonalReader } from '../../features/pages/subject-personal-reader';
import { useSubjectReactionReader } from '../../features/pages/subject-reaction-reader';
import {
  subjectFrameQuery,
  subjectLibraryQuery,
  subjectRatingQuery,
  subjectRelationsQuery,
  subjectReactionsQuery,
} from '../../features/pages/subject-queries';
import { SubjectLibrarySlot } from '../../library/subject-slot-view';
import { ClassificationAssessmentProviders } from '../../features/pages/subject-classification-assessment-view';
import { useClassificationAssessmentVisit } from '../../features/pages/subject-classification-assessment-live';
import { useSession } from '../../session/query';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import type { Route } from './$id_.$slug';

/** The ordinary route's browser consumer, with its loader result kept at the existing BFF boundary. */
export function SubjectOverview({
  data,
  search,
}: {
  data: ReturnType<typeof Route.useLoaderData>;
  search: ReturnType<typeof Route.useSearch>;
}) {
  const { tabs, verification, reader: initialReader, page } = data;
  const {
    realm,
    slot,
    ratingFailure,
    ratingResult,
    labelResult,
    undoLabelId,
    undoAssignmentId,
    undoRevision,
    undoKey,
    node,
    streamProperty,
    streamDirection,
  } = search;
  const browserSession = useSession();
  const { state: session } = browserSession;
  const readerKey = subjectReaderPartition(realm ?? page.requestedBoard, initialReader, browserSession);
  const queryClient = useQueryClient();
  const locale = getLocale();
  const currentReader = useSubjectReaderRefresh(initialReader, readerKey);
  const id = page.subject!;
  const labelUndo =
    typeof undoLabelId === 'string' &&
    typeof undoAssignmentId === 'string' &&
    typeof undoRevision === 'number' &&
    Number.isSafeInteger(undoRevision) &&
    undoRevision > 0
      ? { labelId: undoLabelId, assignmentId: undoAssignmentId, revision: undoRevision }
      : undefined;
  const type = subjectPageType(page);
  const frameQuery = useQuery({
    ...subjectFrameQuery(type ?? '', locale),
    enabled: type !== undefined,
  });
  const frame = frameQuery.data ?? {};
  const relationsQuery = useQuery(subjectRelationsQuery(pageRelationProperties(page), locale));
  const relations = relationsQuery.data ?? {};
  const reactionsQuery = useQuery(subjectReactionsQuery(id, locale));
  const publicReactions = reactionsQuery.data;
  const [questionQuery, figureQuery, globalQuery, statisticsQuery] = [
    useQuery(subjectRatingQuery(id, locale, 'question')),
    useQuery(subjectRatingQuery(id, locale, 'figure')),
    useQuery(subjectRatingQuery(id, locale, 'global')),
    useQuery(subjectRatingQuery(id, locale, 'statistics')),
  ];
  const publicRatings: RatingSources = {
    question: questionQuery.data?.question ?? (questionQuery.isError ? { kind: 'failed' } : { kind: 'idle' }),
    figure: figureQuery.data?.figure ?? (figureQuery.isError ? { kind: 'failed' } : { kind: 'idle' }),
    global: globalQuery.data?.global ?? (globalQuery.isError ? { kind: 'failed' } : { kind: 'idle' }),
    statistics: statisticsQuery.data?.statistics ?? (statisticsQuery.isError ? { kind: 'failed' } : { kind: 'idle' }),
  };
  const retryRatingSource = (source: RatingSource) => {
    const request = {
      question: questionQuery,
      figure: figureQuery,
      global: globalQuery,
      statistics: statisticsQuery,
    }[source];
    void request.refetch().catch(() => {});
  };
  const { data: library } = useQuery({
    ...subjectLibraryQuery(id, locale, slot === 'collections', labelResult, labelUndo, subjectPageType(page)),
    enabled: session === 'signed-in',
  });
  const personal = useSubjectPersonalReader({
    subjectId: id,
    locale,
    view: 'overview',
    session: browserSession,
    enabled: currentReader,
    includeOwnRating: true,
  });
  const subjectReaction = useSubjectReactionReader({
    subjectId: id,
    locale,
    view: 'overview',
    session: browserSession,
    enabled: currentReader,
  });
  const reader = personal.reader;
  const ownRating = personal.ownRating;
  const reactions = publicReactions ? { ...publicReactions, value: subjectReaction.ownReaction?.value ?? null } : null;
  const ratings = publicRatings;
  const currentHref = useLocation().publicHref;
  const returnTo = contextHref(currentHref.split(/[?#]/, 1)[0]!, realm);
  const router = useRouter();
  const nonce = router.options.ssr?.nonce;
  const assessment = useClassificationAssessmentVisit({
    identity: null,
    locale,
    session,
    reader: personal.readerId,
    csrfToken: browserSession.csrfToken,
  });
  if (!currentReader) return <PendingPage />;
  return (
    <ClassificationAssessmentProviders
      snapshot={assessment.snapshot}
      handlers={{
        onSelect: assessment.select,
        onCommand: (command) => {
          void assessment.send(command);
        },
        onRetry: () => {
          void assessment.retry();
        },
      }}
      chrome={{
        csrfToken: browserSession.csrfToken,
        returnTo,
        title: subjectPageTitle(page, locale),
      }}
    >
      <RatingControlContext.Provider
        value={{
          subjectId: id,
          locale,
          returnTo,
          session,
          own: ownRating,
          ...(personal.binding ? { binding: personal.binding } : {}),
          ...(ratingResult ? { result: ratingResult } : ratingFailure ? { result: 'rejected' as const } : {}),
        }}
      >
        <RatingsRecoveryContext.Provider value={retryRatingSource}>
          <RatingPopulationsContext.Provider
            value={
              ratings.question.kind === 'ready' ? (
                <SubjectRatingPopulations
                  subjectId={id}
                  question={ratings.question.value}
                  locale={locale}
                  session={browserSession}
                  enabled={currentReader}
                />
              ) : null
            }
          >
            <RatingsContext.Provider value={ratings}>
              <SubjectPage
                communityQueryKey={data.communityQueryKey}
                page={page}
                selectedNode={node}
                selectedStreamProperty={streamProperty}
                selectedStreamDirection={streamDirection}
                currentHref={currentHref}
                readingAdmission={JSON.stringify([
                  browserSession.state,
                  browserSession.subject,
                  browserSession.csrfToken,
                ])}
                refreshCommunityAdvice={() => router.invalidate()}
                recoverCatalogueFileReader={() => router.invalidate()}
                recoverMusicReleaseReader={() => router.invalidate()}
                returnTo={search.via}
                fileSource={search.fileSource}
                verification={verification}
                connections={
                  currentReader ? (
                    <SubjectConnections page={page} viewer={browserSession} returnTo={search.via} />
                  ) : undefined
                }
                curation={realm ? undefined : <SubjectCandidateCuration id={id} locale={locale} />}
                locale={getLocale()}
                messages={subjectPageMessages()}
                reader={reader}
                {...(frame.label ? { typeLabel: frame.label } : {})}
                {...(frame.ratio ? { ratio: frame.ratio } : {})}
                relations={relations}
                link={SubjectLink}
                tabs={tabs}
                tabLabels={viewTabLabels()}
                invitation={m.subject_empty()}
                {...(nonce !== undefined ? { nonce } : {})}
                renderJsonLd={false}
                actions={(subject) => (
                  <SubjectHeaderActions
                    id={subject.id}
                    reactions={reactions}
                    locale={locale}
                    publicRecovery={{
                      pending: reactionsQuery.isFetching,
                      retry: () => {
                        void reactionsQuery.refetch();
                      },
                    }}
                    signedIn={session === 'signed-in'}
                    personalReady={session !== 'signed-in' || subjectReaction.ready}
                    reactionOrigin={subjectReaction.origin}
                    reactionRecovery={{
                      failed: subjectReaction.recoveryFailed,
                      pending: subjectReaction.recoveryPending,
                      retry: subjectReaction.retryOwnReaction,
                    }}
                    onPersonalChange={async (kind) => {
                      if (!subjectReaction.origin.isCurrent()) return;
                      subjectReaction.applyMutation(kind);
                      if (!subjectReaction.origin.isCurrent()) return;
                      await queryClient.invalidateQueries({ queryKey: ['subject-reactions', id, locale] });
                    }}
                    returnTo={returnTo}
                    verification={verification}
                  >
                    <SubjectLibrarySlot
                      subject={{ id: subject.id, type: subject.type, label: subjectPageTitle(page, subject.locale) }}
                      locale={subject.locale}
                      data={
                        library ?? {
                          session: 'signed-out',
                          csrfToken: null,
                          entryAvailable: false,
                          entry: null,
                          publicCollections: null,
                          publicCollectionsNext: null,
                          collectionsLoaded: false,
                          collections: null,
                          labels: null,
                        }
                      }
                      {...(library && undoKey ? { data: { ...library, labelUndoKey: undoKey } } : {})}
                    />
                  </SubjectHeaderActions>
                )}
              />
            </RatingsContext.Provider>
          </RatingPopulationsContext.Provider>
        </RatingsRecoveryContext.Provider>
      </RatingControlContext.Provider>
    </ClassificationAssessmentProviders>
  );
}
