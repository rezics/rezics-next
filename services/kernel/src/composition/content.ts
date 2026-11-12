import { bindContentAccess } from '../content/access-port.ts';
import { createNativeContentAccess } from '../access/content-adapter.ts';
import {
  ensureContentApplication,
  bindReadingPageCapabilities,
  createNativeReadingPageCapabilities,
  tryContentApplication,
  unbindContentApplication,
  createNativeContentRealmApplication,
  nativeRealmEvidenceHost,
  bindContentRealmApplication,
  bindFeedCapabilities,
  tryFeedCapabilities,
  readRealmSubjectIdentityMappings,
  prepareFeedContentContext,
  composeFeedViewerPersonalActions,
  type FeedEnrichmentPorts,
  type FeedProducerCapabilities,
} from '../content/adapters/index.ts';
import {
  createContinuePageAdapter,
  createFollowActivitySource,
  createCollectionReads,
} from '../library/adapters/index.ts';
import { librarySemanticObservations } from '../library/semantic-observation.ts';
import { createPublicSummaryAdapter } from '../semantic/adapters/public-summary.ts';
import { readAccountDiscoverySummaries } from '../access/account-discovery-source.ts';
import { admitGroup, PlatformClosedError } from '../access/gates/admission.ts';
import { classifyUnavailability } from '../access/unavailable.ts';
import { readPublication } from '../community/index.ts';
import { createNativeAccessReadingPorts } from '../access/adapters/reading.ts';
import { createRealmScopeEvidence } from '../community/adapters/index.ts';
import { createSubjectScopeEvidence } from '../semantic/adapters/index.ts';
import { withRealmDisclosureWork } from '../search/adapters/index.ts';
import { readSubjectSummaries, readSubjectSummaryObservation } from '../semantic/summaries.ts';
import { readVisibleRatingQuestion, STANDARD_QUESTION_ID } from '../rating/index.ts';
import type { ContentAmbient, ContentApplication } from '../content/contract/index.ts';
import { createNativeHostedReadingPort } from '../content/adapters/hosted-reading.ts';
import { bindHostedReadingPort } from '../library/hosted-reading-bind.ts';
import type { HostedDependencies } from '../content/index.ts';

/** This process root chooses each foreign supplier. No supplier performs I/O at installation. */
export function composeContentFeed(): FeedProducerCapabilities {
  const installed = tryFeedCapabilities();
  if (installed) return installed;
  const enrichment: FeedEnrichmentPorts = {
    readSubjectSummaries,
    readSubjectSummaryObservation,
    readVisibleRatingQuestion,
    standardQuestionId: STANDARD_QUESTION_ID,
  };
  return bindFeedCapabilities({
    enrichment,
    prepareContentContext(dependencies, references, context, languages, options) {
      return prepareFeedContentContext(dependencies, enrichment, references, context, languages, options);
    },
    composeViewerPersonalActions(dependencies, actor, items, deadline, languages, finalAdmission) {
      return composeFeedViewerPersonalActions(
        dependencies,
        enrichment,
        actor,
        items,
        deadline,
        languages,
        finalAdmission,
      );
    },
    create(deps, activityStore) {
      const continuation = createContinuePageAdapter(deps);
      const publicSummary = createPublicSummaryAdapter(deps);
      let collections: ReturnType<typeof createCollectionReads> | undefined;
      let follows: Promise<ReturnType<typeof createFollowActivitySource>> | undefined;
      const followSource = () =>
        (follows ??= deps.workClient().then((workClient) =>
          createFollowActivitySource({
            ...deps,
            workClient,
            activityStore,
            semanticObservations: librarySemanticObservations(),
          }),
        ));
      return {
        continuation,
        publicSummary,
        present: (row) => row,
        async checkCurrentFollowSupport(actor, query, deadline) {
          return (await followSource()).checkCurrentFollowSupport(actor, query, deadline);
        },
        readCollection: (actor, id, deadline) =>
          (collections ??= createCollectionReads(deps)).readCollection(actor, id, deadline),
        readPublication: (realmId, id, actor, deadline) => readPublication(deps, realmId, id, { actor, deadline }),
        readAccounts: (actor, ids, languages, deadline) =>
          readAccountDiscoverySummaries({ ...deps, actor, deadline }, ids, { languages }),
        async admit(actor, group, clientAction, deadline) {
          await admitGroup({ ...deps, access: () => deps.access, actor, group, clientAction, deadline });
        },
      };
    },
    isDeadline: (error) => classifyUnavailability(error) === 'deadline',
    isAdmissionFailure: (error) => error instanceof PlatformClosedError,
  });
}

/** The ordinary server, worker and native preload install real Access reading operands. */
export function composeContentReading(): void {
  bindContentAccess(createNativeContentAccess());
  bindReadingPageCapabilities(createNativeReadingPageCapabilities(createNativeAccessReadingPorts()));
}

/** Library hosted-reading save/get consume this Content mapper. Kernel supplies live hosted deps. */
export function composeHostedReadingPort(deps: HostedDependencies) {
  return bindHostedReadingPort(createNativeHostedReadingPort(deps));
}

/** Ordinary server and worker composition bind the actual independent owner producers. */
export function composeContentApplication(ambient?: Partial<ContentAmbient>): ContentApplication {
  composeContentReading();
  composeContentFeed();
  const application = ensureContentApplication(ambient ?? {});
  const parent = createRealmScopeEvidence(nativeRealmEvidenceHost);
  const subject = createSubjectScopeEvidence(nativeRealmEvidenceHost);
  bindContentRealmApplication(
    createNativeContentRealmApplication(
      {
        parent: parent.observe,
        subject: subject.observe,
        readIdentityMappings: readRealmSubjectIdentityMappings,
        withWork(reader, work, maximum, run) {
          // Content refuses actorless readers before asking Search for a native ledger.
          return withRealmDisclosureWork(reader, work, maximum, run);
        },
      },
      application.ambient.now,
    ),
  );
  return application;
}

export function composedContentApplication(): ContentApplication {
  return composeContentApplication();
}
export function startContentApplication(ambient?: Partial<ContentAmbient>) {
  const application = composeContentApplication(ambient);
  return {
    application,
    stop() {
      if (tryContentApplication() === application) unbindContentApplication();
    },
  };
}
