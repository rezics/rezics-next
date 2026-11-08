import type { Pool } from 'pg';
import type { Actor, Access } from '../../request/access.ts';
import type { KernelClock } from '../../clock.ts';
import type { KeyRing } from '../../tokens/seal.ts';
import type { WorkClient } from '../../work/client.ts';
import type { AccountDiscoverySummary, DiscoverySearch } from '../../search/index.ts';
import type { SearchService } from '../../search/service-scope.ts';
import type { CollectionResourceView, ViewerPersonalActionsReader } from '../../library/adapters/index.ts';
import type { ViewerPersonalActionsPage } from '../../library/index.ts';
import type { ReadingPageViewerActionRuntime } from '../reading-page.ts';
import type { FeedActivityStore, FeedActivityTarget } from '../feed-activity.ts';
import type {
  FeedContentContextComposition,
  FeedContentContextDependencies,
  FeedContentContextOptions,
  FeedContentContextReference,
} from '../feed-context.ts';
import type { FeedEnrichmentPorts } from '../feed-enrichment-ports.ts';
import type { ReadContext } from '../model.ts';
import type {
  FeedContinuationPage,
  FeedContinuationQuery,
  FeedContinuationSubject,
  FeedItem,
  FeedPublicSummary,
} from '../contract/index.ts';

export type FeedDependencies = {
  pool: Pool;
  routeKey: Uint8Array;
  tokens: KeyRing;
  clock: KernelClock;
  deadlineNow: () => number;
  access: Access;
  contentAccess: Access;
  workClient: () => Promise<WorkClient>;
  discovery?: DiscoverySearch;
  search?: SearchService;
  viewerPersonalActions: ViewerPersonalActionsReader;
  viewerActionRuntime?: () => ReadingPageViewerActionRuntime;
};

/** Native operands keep the live platform actor, including its credential epoch.
 * The inward application consumes the smaller actor and never selects producers. */
export type FeedNativeSuppliers = Readonly<{
  continuation: {
    list(
      actor: Actor,
      query: FeedContinuationQuery,
      deadline: number,
      languages: readonly string[],
    ): Promise<FeedContinuationPage>;
  };
  publicSummary: {
    read(
      actor: Actor,
      query: { ids: readonly string[]; languages: readonly string[]; deadline: number },
    ): Promise<ReadonlyMap<string, FeedPublicSummary>>;
  };
  present(row: FeedContinuationSubject): FeedContinuationSubject;
  checkCurrentFollowSupport(
    actor: Actor,
    query: { targets: readonly FeedActivityTarget[] },
    deadline: number,
  ): Promise<readonly { target: FeedActivityTarget; status: 'following' | 'not_following' | 'unavailable' }[]>;
  readCollection(actor: Actor, id: string, deadline: number): Promise<CollectionResourceView>;
  readPublication(
    realmId: string,
    id: string,
    actor: Actor,
    deadline: number,
  ): Promise<{ publicationId: string } | null>;
  readAccounts(
    actor: Actor,
    ids: readonly string[],
    languages: readonly string[],
    deadline: number,
  ): Promise<ReadonlyMap<string, AccountDiscoverySummary | null>>;
  admit(
    actor: Actor,
    group: 'personal_library' | 'reading_progress' | 'search',
    clientAction: 'follow:list' | 'library_entry:list' | 'progress_session:list' | 'subject:search',
    deadline: number,
  ): Promise<void>;
}>;

export type FeedContentContextComposer = (
  dependencies: FeedContentContextDependencies,
  references: readonly FeedContentContextReference[],
  context: ReadContext,
  languages: readonly string[],
  options?: FeedContentContextOptions,
) => Promise<FeedContentContextComposition>;

export type FeedViewerPersonalActionsComposer = (
  dependencies: Pick<FeedDependencies, 'pool' | 'routeKey' | 'access' | 'viewerPersonalActions'>,
  actor: Actor,
  items: readonly FeedItem[],
  deadline: number,
  languages: readonly string[],
  finalAdmission: () => Promise<readonly FeedItem[]>,
) => Promise<ViewerPersonalActionsPage>;

/** Composition supplies one factory; a native reader retains its own producer instances. */
export type FeedProducerCapabilities = Readonly<{
  enrichment: FeedEnrichmentPorts;
  prepareContentContext: FeedContentContextComposer;
  composeViewerPersonalActions: FeedViewerPersonalActionsComposer;
  create(deps: FeedDependencies, activityStore: FeedActivityStore): FeedNativeSuppliers;
  isDeadline(error: unknown): boolean;
  isAdmissionFailure(error: unknown): boolean;
}>;
