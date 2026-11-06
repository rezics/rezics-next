import canonicalize from 'canonicalize';
import { createHash } from 'node:crypto';
import type { FilterRelease } from '@rezics/filter';
import { ProblemError } from '../http/problem.ts';
import { compileText, type TextNode } from './text.ts';
import { boundMatchEvidencePage, compileMatchEvidence } from './match-evidence.ts';
import { CollectionDiscoveryReadinessError } from './collection-discovery.ts';
import {
  collectionDirectoryQuery,
  executeCollectionDirectory,
  hasCollectionDirectoryCapability,
  parseCollectionDirectoryAfter,
  projectCollectionDirectoryPage,
} from './collection-directory.ts';
import type { DiscoveryOwnerMetadataSummary } from './discovery.ts';
import type { PublicFilterSource } from '../semantic/public-filter-source-contract.ts';
import type { SpaceSubjectPopulation } from '../content/feed-subject-scope.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { decodeDiscoveryCursor, decodeSearchCursor, encodeDiscoveryCursor, encodeSearchCursor } from './cursor.ts';
import { currentDiscoveryCandidates, currentDiscoveryPrimaryCandidates } from './discovery-current.ts';
import type { ConceptFilterExecution } from './concept-browse-statements.ts';
import { admitDiscoveryPage } from './discovery-http.ts';
import { compileDiscoveryCapture } from './discovery-filter.ts';
import { discoveryFilterApplicability, discoveryKindDirectory } from './discovery-registry.ts';
import {
  admitDiscoveryRequest,
  discoveryCandidateScanBound,
  ownDiscoveryRequest,
  type MixedDiscoveryRequest,
} from './discovery-request.ts';
import type {
  DiscoveryPage,
  DiscoveryReadContext,
  DiscoveryRegistry,
  DiscoveryOwnerRegistry,
  DiscoveryUnionHit,
  DiscoveryConsumerQuery,
  DiscoveryKey,
} from './discovery.ts';
import type { DiscoverySearch } from './discovery-api.ts';
import type { IndexedSubject } from './source.ts';
import type {
  PublicFilterConsumerJob,
  PublicDiscoveryConsumerOperations,
  PublicFilterQueriedObservation,
  PublicFilterConsumerRefill,
} from './public-filter-consumer-contract.ts';
import { finishDiscoveryDisclosure } from './disclosure/discovery.ts';
import { OwnerCurrentRestartRequired, revalidateOwnerCurrentSummaries } from './disclosure/owner-current.ts';
import { openPublicFilterCoveragePage } from './public-filter-coverage-page.ts';
import { admitTaggedWorkPlan, taggedWorkHitScanBound, taggedWorkRemainingHasConcept } from './tagged-work-plan.ts';
import { proveCurrentKindCounts } from './type-facet.ts';
import { kindWitnessCounts, selectCurrentPredicatePage } from './current-predicate.ts';
import { projectKindDirectoryCounts } from './kind-count-proof.ts';

const ready = () => new ProblemError('index_not_ready', { headers: { 'retry-after': '1' } });
const invalid = (pointer: string) =>
  new ProblemError('invalid_request', { errors: [{ pointer, code: 'invalid_format' }] });

function kindLeaves(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(kindLeaves);
  if (value === null || typeof value !== 'object') return [];
  const node = value as Record<string, unknown>;
  if (Object.hasOwn(node, 'kind')) return [node];
  return Object.values(node).flatMap(kindLeaves);
}

/** Return exact positive kind conjuncts; complex kind logic stays unknown instead of guessing. */
function selectedKindsForApplicability(filter: unknown): readonly string[] | null | undefined {
  if (filter === undefined) return undefined;
  const root =
    filter !== null && typeof filter === 'object' && !Array.isArray(filter)
      ? (filter as Record<string, unknown>)
      : undefined;
  const top = root && Object.keys(root).length === 1 && Array.isArray(root.and) ? root.and : [filter];
  const direct = top.filter(
    (value): value is Record<string, unknown> =>
      value !== null && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, 'kind'),
  );
  if (top.some((value) => kindLeaves(value).length > 0 && !direct.includes(value as Record<string, unknown>)))
    return null;
  if (!direct.length) return undefined;
  let selected: string[] | undefined;
  for (const node of direct) {
    const kind = node.kind;
    if (
      node === null ||
      Object.keys(node).length !== 1 ||
      kind === null ||
      typeof kind !== 'object' ||
      Array.isArray(kind) ||
      !Array.isArray((kind as Record<string, unknown>).in) ||
      !(kind as { in: unknown[] }).in.every((entry) => typeof entry === 'string')
    )
      return null;
    const values = (kind as { in: string[] }).in;
    selected = selected === undefined ? [...values] : selected.filter((entry) => values.includes(entry));
  }
  return selected;
}

type DiscoveryContextWithSpace = DiscoveryReadContext & {
  spacePopulation?: SpaceSubjectPopulation;
  conceptFilter?: ConceptFilterExecution;
};
type Principal = 'anonymous' | `account:${string}`;
export type { DiscoverySearch } from './discovery-api.ts';

export type RetainedDiscoveryRead = Readonly<{
  search(): Promise<DiscoveryPage>;
  currentPrimaryCandidates(keys: readonly DiscoveryKey[]): Promise<readonly boolean[]>;
  finish(): Promise<void>;
  close(): Promise<void>;
}>;

export type RetainedDiscoverySearch = (
  principal: Principal,
  request: MixedDiscoveryRequest,
  context: DiscoveryReadContext,
) => Promise<RetainedDiscoveryRead>;

type DiscoveryConfiguration = {
  consumer: PublicDiscoveryConsumerOperations;
  source: PublicFilterSource;
  keys: KeyRing;
  resolve(request: MixedDiscoveryRequest): Promise<{
    registry: DiscoveryRegistry & Partial<DiscoveryOwnerRegistry>;
    release: FilterRelease;
    digest: string;
  }>;
  now(): number;
  asOf(queried: PublicFilterQueriedObservation): Promise<string | import('./search-context.ts').SearchObservation>;
  prepareConceptFilter?(
    input: Readonly<{
      principal: string;
      request: unknown;
      filter: import('@rezics/filter').DiscoveryFilterDocument;
      limit: number;
      countCandidateLimit: number;
    }>,
  ): Promise<ConceptFilterExecution | undefined>;
  currentTextMatches?: (physicalTarget: string, subject: IndexedSubject, query: TextNode) => Promise<boolean>;
  prepare?(job: PublicFilterConsumerJob): Promise<void>;
};

type RetainedPrimaryReader = (keys: readonly DiscoveryKey[]) => Promise<readonly boolean[]>;

/** The public completed search and retained readers use the same native execution. The
 * rendezvous is after projection and cursor construction and BEFORE its terminal observation.
 * No capture, ledger or original cut is copied into the retaining caller.
 */
export function createRetainedDiscoverySearch(config: DiscoveryConfiguration): RetainedDiscoverySearch {
  return async (principal, request, context) => {
    // Retention extends past the caller's initial await. Keep the admitted actor,
    // request and deadline stable while preserving the actual Access dependency.
    request = ownDiscoveryRequest(request);
    context = Object.freeze({
      ...context,
      actor: Object.freeze(
        context.actor.kind === 'account'
          ? { ...context.actor, scopes: Object.freeze([...context.actor.scopes]) }
          : { kind: 'anonymous' as const },
      ),
    });
    let deliver!: (value: { page: DiscoveryPage; current: RetainedPrimaryReader }) => void;
    let refuse!: (error: unknown) => void;
    const projected = new Promise<{ page: DiscoveryPage; current: RetainedPrimaryReader }>((resolve, reject) => {
      deliver = resolve;
      refuse = reject;
    });
    let finish!: () => void;
    let abandon!: (error: unknown) => void;
    const publication = new Promise<void>((resolve, reject) => {
      finish = resolve;
      abandon = reject;
    });
    // Closing can precede projection. Retain the refusal without an unhandled rejection.
    void publication.catch(() => {});
    let state: 'open' | 'finishing' | 'finished' | 'closing' | 'closed' = 'open';
    let reading: Promise<readonly boolean[]> | undefined;
    let primaryRead = false;
    let searched = false;
    let terminal: Promise<void> | undefined;
    let closing: Promise<void> | undefined;
    let expired = false;
    const expire = () => {
      expired = true;
      // Expiry removes publication authority immediately. The actual in-flight owner
      // operation still owns the original root until it settles, including on refusal.
      // Rejecting the rendezvous first would run disposal underneath that operation.
      if (reading)
        void reading.then(
          () => abandon(ready()),
          () => abandon(ready()),
        );
      else abandon(ready());
    };
    const execution = executeDiscoverySearch(config, async (page, current) => {
      deliver({ page, current });
      await publication;
    })(principal, request, context);
    const expiry = setTimeout(expire, Math.max(0, context.deadline - Date.now()));
    expiry.unref();
    void execution.finally(() => clearTimeout(expiry)).catch(() => {});
    // The native execution owns both finally blocks, including projection and finish failures.
    void execution.catch(refuse);
    let value: Awaited<typeof projected>;
    try {
      value = await projected;
    } catch (error) {
      abandon(error);
      await execution.catch(() => {});
      throw error;
    }
    const requireOpen = () => {
      if (state !== 'open') throw new TypeError('Retained discovery operation is no longer open');
      if (expired || Date.now() >= context.deadline) {
        expire();
        throw ready();
      }
    };
    return Object.freeze({
      async search() {
        requireOpen();
        if (searched) throw new TypeError('Retained discovery permits one search');
        searched = true;
        return structuredClone(value.page);
      },
      currentPrimaryCandidates(keys) {
        requireOpen();
        if (primaryRead) throw new TypeError('Retained discovery permits one positional primary batch');
        if (!Array.isArray(keys) || keys.length > 160) throw new RangeError('Invalid positional primary batch');
        primaryRead = true;
        // Snapshot full keys before an await; caller mutation cannot change the admitted batch.
        const saved = keys.map((key) => Object.freeze({ ...key }));
        reading = Promise.resolve()
          .then(() => value.current(saved))
          .then((result) => {
            if (expired || Date.now() >= context.deadline) throw ready();
            return result;
          });
        void reading.catch(() => {});
        return reading;
      },
      finish() {
        if (terminal) return terminal;
        requireOpen();
        state = 'finishing';
        terminal = (async () => {
          try {
            if (reading) await reading;
            // A finish started before the deadline can be awaiting an owner callback
            // when the deadline passes. It must not publish that callback's late result.
            if (expired || Date.now() >= context.deadline) {
              expire();
              throw ready();
            }
            finish();
            await execution;
            // The native final and its disposal can also outlive the deadline.
            // Their completion does not restore publication authority.
            if (expired || Date.now() >= context.deadline) throw ready();
            state = 'finished';
          } catch (error) {
            abandon(error);
            await execution.catch(() => {});
            state = 'closed';
            throw error;
          }
        })();
        return terminal;
      },
      close() {
        return (closing ??= (async () => {
          if (state === 'finishing') {
            try {
              await terminal;
            } finally {
              state = 'closed';
            }
            return;
          }
          if (state === 'finished' || state === 'closed') {
            state = 'closed';
            return;
          }
          state = 'closing';
          // Do not release the original while a caller's actual owner batch is in flight.
          try {
            if (reading) await reading;
          } finally {
            abandon(new Error('Retained discovery operation was abandoned'));
            await execution.catch(() => {});
            state = 'closed';
          }
        })());
      },
    });
  };
}

/** Actual retained consumer and Source are mandatory here. The mounted route may omit this provider while
 * native owner integration is absent, in which case it returns readiness before enumeration.
 */
export function createDiscoverySearch(config: DiscoveryConfiguration): DiscoverySearch {
  const open = createRetainedDiscoverySearch(config);
  return async (...args) => {
    const read = await open(...args);
    try {
      const page = await read.search();
      await read.finish();
      return page;
    } finally {
      await read.close();
    }
  };
}

function executeDiscoverySearch(
  config: DiscoveryConfiguration,
  retain: (page: DiscoveryPage, current: RetainedPrimaryReader) => Promise<void>,
): DiscoverySearch {
  const execute: DiscoverySearch = async (principal, request, context) => {
    const { registry, release, digest } = await config.resolve(request);
    // Directory capability is advertised on a ready Collection adapter. An omitted producer must not
    // reach filter admission or enumeration: missing Commerce listing operands are readiness.
    if (request.collectionDirectory !== undefined && !hasCollectionDirectoryCapability(registry)) throw ready();
    const admitted = admitDiscoveryRequest(request, registry, release);
    context = { ...context, ...(admitted.text === undefined ? {} : { textQuery: admitted.text }) };
    if (admitted.collectionDirectory && !hasCollectionDirectoryCapability(registry)) throw ready();
    const matchEvidencePlan = admitted.text
      ? compileMatchEvidence(compileText(admitted.text, { field: 'search_text', prefix: 't' }))
      : undefined;
    const spacePopulation = (context as DiscoveryContextWithSpace).spacePopulation;
    if (
      (request.spaceId === undefined) !== (spacePopulation === undefined) ||
      (spacePopulation && spacePopulation.observation.spaceId !== request.spaceId)
    )
      throw new ProblemError('dependency_unavailable');
    let currentContext: DiscoveryContextWithSpace = { ...context };
    const directoryAfter: import('./cursor.ts').SearchSortValue[] = [];
    let directoryNextAfter: import('./cursor.ts').SearchSortValue[] | null = null;
    const kindDirectory = discoveryKindDirectory(registry);
    const taggedWork =
      admitted.kindCountLeaf === undefined ||
      admitted.filter === undefined ||
      !taggedWorkRemainingHasConcept(admitted.filter, admitted.kindCountLeaf)
        ? undefined
        : admitTaggedWorkPlan({
            filter: admitted.filter,
            kindCountLeaf: admitted.kindCountLeaf,
            sort: admitted.sort,
            limit: admitted.limit,
            registeredKinds: new Set(kindDirectory.map((entry) => entry.kind)),
          });
    if (taggedWork?.execution === 'preparing') throw ready();
    const taggedScanBound = taggedWorkHitScanBound(taggedWork, admitted.limit);
    const registryDigest = createHash('sha256')
      .update(
        canonicalize({
          directory: kindDirectory.map(({ kind, metadata }) => ({
            kind,
            domains: registry.domains?.(kind) ??
              registry.entries.find((entry) => entry.kind === kind)?.domains ?? ['text', 'kind'],
            metadata,
          })),
          omitted: registry.omittedKinds ?? [],
        })!,
      )
      .digest('hex');
    const binding = {
      operation: 'subjects.search.discovery-v1',
      principal,
      request: { ...admitted.bindingRequest, spaceObservation: spacePopulation?.observation ?? null },
    };
    const now = config.now();
    const nativeContext = { deadline: context.deadline };
    const coverage = openPublicFilterCoveragePage(config.consumer, nativeContext);
    try {
      let queried!: PublicFilterQueriedObservation;
      let observationOpened = false;
      let refill: PublicFilterConsumerRefill | undefined;
      let repair: PublicFilterConsumerJob | undefined;
      let kindAfter = '';
      let kindPhysical: string | undefined;
      if (request.kindPage?.cursor) {
        const token = await decodeSearchCursor(
          config.keys,
          { ...binding, operation: `${binding.operation}.kinds` },
          request.kindPage.cursor,
          now,
        );
        if (!token.ok)
          throw token.reason === 'expired' ? new ProblemError('search_restart_required') : invalid('/kindPage/cursor');
        if (token.after.length !== 4 || typeof token.after[2] !== 'string' || typeof token.after[3] !== 'string')
          throw invalid('/kindPage/cursor');
        if (token.after[0] !== digest || token.after[1] !== registryDigest)
          throw new ProblemError('search_restart_required');
        kindAfter = token.after[2];
        kindPhysical = token.after[3];
      }
      if (request.cursor) {
        const token = await decodeDiscoveryCursor(config.keys, binding, request.cursor, now);
        if (!token.ok)
          throw token.reason === 'expired' ? new ProblemError('search_restart_required') : invalid('/cursor');
        if (token.state.release !== digest || token.state.registry !== registryDigest)
          throw new ProblemError('search_restart_required');
        if (admitted.collectionDirectory) {
          // Directory pages recapture the identity frontier so newly eligible rows sort globally.
          if (token.state.retained || !parseCollectionDirectoryAfter(token.state.after))
            throw new ProblemError('search_restart_required');
          directoryAfter.push(...token.state.after);
        } else {
          if (!token.state.retained) throw new ProblemError('search_restart_required');
          queried = token.state.queried;
          observationOpened = true;
          repair = token.state.repair;
          refill = { ...token.state.retained, size: Math.min(200, 2 * admitted.limit + 1) };
        }
      }
      const conceptFilter =
        admitted.filter === undefined || !config.prepareConceptFilter
          ? undefined
          : await config.prepareConceptFilter({
              principal,
              request: admitted.bindingRequest,
              filter: admitted.filter,
              limit: admitted.limit,
              countCandidateLimit:
                admitted.kindCountLeaf === undefined ? 0 : Math.min(200, discoveryCandidateScanBound(admitted.limit)),
            });
      currentContext = {
        ...context,
        ...(conceptFilter ? { conceptFilter } : {}),
        ...(admitted.collectionDirectory
          ? { collectionQuery: collectionDirectoryQuery(admitted.collectionDirectory) }
          : {}),
      };
      if (!observationOpened) {
        const plan = compileDiscoveryCapture(
          {
            representation: 'discovery-v1',
            comparator: 'mixed-public-v1',
            filterDocument: admitted.filter,
            text: admitted.text,
            sort: admitted.sort,
            size: Math.min(200, 2 * admitted.limit + 1),
            pageSize: admitted.limit,
            ...(request.text === undefined ? {} : { boost: request.text }),
          },
          registry,
          release,
        );
        const captured = await coverage.capture(plan, 'pit');
        if (captured.status === 'preparing') {
          await config.prepare?.(captured.repair);
          await config.consumer.repairStep(captured.repair, nativeContext);
          throw ready();
        }
        if (captured.status !== 'captured') throw ready();
        queried = captured.queried;
        observationOpened = true;
        repair = captured.repair;
      }
      if (kindPhysical !== undefined && kindPhysical !== canonicalize(queried.consumer))
        throw new ProblemError('search_restart_required');
      if (admitted.text !== undefined && config.currentTextMatches) {
        const physicalTarget = queried.consumer.physicalTarget;
        const currentTextMatches = (subject: IndexedSubject, query: TextNode) =>
          config.currentTextMatches!(physicalTarget, subject, query);
        context = { ...context, currentTextMatches };
        currentContext = { ...currentContext, currentTextMatches };
      }
      const hits: DiscoveryUnionHit[] = [];
      const seen = new Set<string>();
      const witnesses = new Map<string, number>();
      let last: Extract<DiscoveryConsumerQuery, { status: 'queried' }> | undefined;
      let consumed = 0;
      let examined = 0;
      let exhausted = false;
      let retained = false;
      let failed = false;
      try {
        if (kindPhysical !== undefined && kindPhysical !== canonicalize(queried.consumer))
          throw new ProblemError('search_restart_required');
        if (admitted.collectionDirectory) {
          const identities: string[] = [];
          const identitySeen = new Set<string>();
          const scanBound = discoveryCandidateScanBound(admitted.limit);
          let refillDirectory = refill;
          for (;;) {
            const batch = await coverage.queryDiscovery(queried, refillDirectory);
            if (batch.status !== 'queried') {
              retained = batch.status === 'preparing';
              if (retained && repair) await config.prepare?.(repair);
              if (
                batch.status === 'unavailable' &&
                (batch.reason === 'incarnation_changed' || batch.reason === 'observation_lost') &&
                request.cursor
              )
                throw new ProblemError('search_restart_required');
              throw ready();
            }
            last = batch;
            queried = batch.queried;
            const { window, result } = batch;
            if (
              !Number.isSafeInteger(window.examined) ||
              window.examined < 0 ||
              typeof window.exhausted !== 'boolean' ||
              window.positions.length !== result.hits.length
            )
              throw ready();
            examined += window.examined;
            if (examined > scanBound) throw ready();
            for (const candidate of result.hits) {
              if (candidate.key.kind !== 'collection' || identitySeen.has(candidate.key.id)) continue;
              identitySeen.add(candidate.key.id);
              identities.push(candidate.key.id);
            }
            await coverage.consume(batch.execution, window.examined);
            consumed = window.examined;
            exhausted = window.exhausted;
            if (exhausted) break;
            const remaining = scanBound - examined;
            if (remaining < 1) throw ready();
            refillDirectory = {
              execution: batch.execution,
              consumed: window.examined,
              size: Math.min(200, remaining),
            };
          }
          if (!last || !exhausted) throw ready();
          const adapter = registry.getOwnerAdapter?.('collection');
          if (!adapter || adapter.kind !== 'collection' || !registry.getOwnerAdapter) throw ready();
          const paged = await executeCollectionDirectory({
            identities,
            readCurrent: adapter.readCurrent,
            async revalidate(summaries, context) {
              const revalidated = await revalidateOwnerCurrentSummaries(
                registry as DiscoveryRegistry & DiscoveryOwnerRegistry,
                [...summaries].map(([id, value]) => ({ candidate: id, kind: 'collection' as const, id, value })),
                context,
              );
              const current = new Map<string, DiscoveryOwnerMetadataSummary<'collection'>>();
              for (const entry of revalidated) {
                if (entry) current.set(entry.id, entry.value as DiscoveryOwnerMetadataSummary<'collection'>);
              }
              return current;
            },
            selection: admitted.collectionDirectory,
            context: currentContext,
            after: directoryAfter,
            limit: admitted.limit,
          });
          for (const hit of projectCollectionDirectoryPage(paged)) {
            hits.push(hit);
            witnesses.set(hit.key.kind, (witnesses.get(hit.key.kind) ?? 0) + 1);
          }
          directoryNextAfter = paged.nextAfter;
          exhausted = paged.exhausted;
        }
        for (let round = 0; !admitted.collectionDirectory && round < 3; round++) {
          const batch = await coverage.queryDiscovery(queried, refill);
          if (batch.status !== 'queried') {
            retained = batch.status === 'preparing';
            if (retained && repair) await config.prepare?.(repair);
            if (
              batch.status === 'unavailable' &&
              (batch.reason === 'incarnation_changed' || batch.reason === 'observation_lost') &&
              request.cursor
            )
              throw new ProblemError('search_restart_required');
            throw ready();
          }
          last = batch;
          queried = batch.queried;
          const { window, result } = batch;
          if (
            !Number.isSafeInteger(window.examined) ||
            window.examined < 0 ||
            typeof window.exhausted !== 'boolean' ||
            window.positions.length !== result.hits.length ||
            window.positions.some(
              (position, index) =>
                !Number.isSafeInteger(position) ||
                position < 0 ||
                position >= window.examined ||
                (index > 0 && position <= window.positions[index - 1]!),
            )
          )
            throw ready();
          examined += window.examined;
          if (examined > taggedScanBound) throw ready();
          const inSpace = new Set<string>();
          if (spacePopulation) {
            const subjects = result.hits.filter((candidate) => candidate.key.owner === 'semantic');
            for (let offset = 0; offset < subjects.length; offset += 160) {
              const batch = subjects.slice(offset, offset + 160);
              const members = await spacePopulation.contains(batch.map((candidate) => candidate.key.id));
              for (let index = 0; index < batch.length; index++) {
                const candidate = batch[index]!;
                if (members[index]) inSpace.add(`${candidate.key.owner}:${candidate.key.kind}:${candidate.key.id}`);
              }
            }
          }
          const selectedCandidates = spacePopulation
            ? result.hits.filter((candidate) =>
                inSpace.has(`${candidate.key.owner}:${candidate.key.kind}:${candidate.key.id}`),
              )
            : result.hits;
          const current = await currentDiscoveryCandidates(registry, selectedCandidates, admitted.filter, release, {
            ...currentContext,
            ...(matchEvidencePlan ? { matchEvidencePlan } : {}),
          });
          const selected = selectCurrentPredicatePage(selectedCandidates, current, {
            limit: admitted.limit - hits.length,
            exhausted: window.exhausted,
            seen,
          });
          hits.push(...selected.hits);
          for (const [kind, count] of kindWitnessCounts(selected.witnesses))
            witnesses.set(kind, (witnesses.get(kind) ?? 0) + count);
          consumed =
            selected.consumed === 0 || selected.consumed === result.hits.length
              ? window.examined
              : window.positions[selected.consumed - 1]! + 1;
          await coverage.consume(batch.execution, consumed);
          exhausted = consumed === window.examined && window.exhausted;
          if (exhausted || hits.length === admitted.limit) break;
          const remaining = taggedScanBound - examined;
          if (remaining < 1) break;
          refill = {
            execution: batch.execution,
            consumed,
            size: Math.min(200, remaining, 2 * (admitted.limit - hits.length) + 1),
          };
        }
        if (!last || (!exhausted && hits.length < admitted.limit)) {
          // Advance actual finite preparation, never publish an empty cursor chain.
          if (repair) {
            await config.prepare?.(repair);
            await config.consumer.repairStep(repair, nativeContext);
            retained = true;
          }
          throw ready();
        }
        const continuation = request.cursor !== undefined || kindAfter !== '';
        let kindWitnesses = continuation ? new Map<string, number>() : new Map(witnesses);
        let kindExhausted = exhausted && !continuation;
        let aggregateProof = false;
        if (admitted.kindCountLeaf !== undefined && !continuation) {
          // Whole-predicate kind counts need their own executed population. A disclosed
          // hit sample cannot certify that total; failure leaves chips unavailable.
          kindWitnesses = new Map();
          kindExhausted = false;
          const countCoverage = openPublicFilterCoveragePage(config.consumer, nativeContext);
          let countQueried: PublicFilterQueriedObservation | undefined;
          let countFailed = false;
          try {
            const countSize = Math.min(200, taggedScanBound);
            const countSort = admitted.text ? 'relevance' : 'name';
            const countPlan = compileDiscoveryCapture(
              {
                representation: 'discovery-v1',
                comparator: 'mixed-public-v1',
                filterDocument: admitted.countFilter,
                text: admitted.text,
                sort: countSort,
                size: countSize,
                pageSize: admitted.limit,
                ...(request.text === undefined ? {} : { boost: request.text }),
              },
              registry,
              release,
            );
            const captured = await countCoverage.capture(countPlan, 'pit');
            if (captured.status === 'preparing') {
              await config.prepare?.(captured.repair);
              await config.consumer.repairStep(captured.repair, nativeContext);
              throw ready();
            }
            if (captured.status !== 'captured') throw ready();
            countQueried = captured.queried;
            const countBatch = await countCoverage.queryDiscovery(countQueried);
            if (countBatch.status !== 'queried') {
              if (countBatch.status === 'preparing') {
                await config.prepare?.(captured.repair);
                await config.consumer.repairStep(captured.repair, nativeContext);
              }
              throw ready();
            }
            countQueried = countBatch.queried;
            const { window, result } = countBatch;
            if (
              !Number.isSafeInteger(window.examined) ||
              window.examined < 0 ||
              window.examined > countSize ||
              typeof window.exhausted !== 'boolean' ||
              window.positions.length !== result.hits.length ||
              window.positions.some(
                (position, index) =>
                  !Number.isSafeInteger(position) ||
                  position < 0 ||
                  position >= window.examined ||
                  (index > 0 && position <= window.positions[index - 1]!),
              )
            )
              throw ready();

            const inSpace = new Set<string>();
            if (spacePopulation) {
              const subjects = result.hits.filter((candidate) => candidate.key.owner === 'semantic');
              for (let offset = 0; offset < subjects.length; offset += 160) {
                const batch = subjects.slice(offset, offset + 160);
                const members = await spacePopulation.contains(batch.map((candidate) => candidate.key.id));
                for (let index = 0; index < batch.length; index++) {
                  const candidate = batch[index]!;
                  if (members[index]) inSpace.add(`${candidate.key.owner}:${candidate.key.kind}:${candidate.key.id}`);
                }
              }
            }
            const selected = spacePopulation
              ? result.hits.filter((candidate) =>
                  inSpace.has(`${candidate.key.owner}:${candidate.key.kind}:${candidate.key.id}`),
                )
              : result.hits;
            const current = await currentDiscoveryCandidates(registry, selected, admitted.countFilter, release, {
              ...currentContext,
              ...(matchEvidencePlan ? { matchEvidencePlan } : {}),
            });
            const subjects: { id: string; type: string }[] = [];
            for (const candidate of selected) {
              const hit = current.get(candidate);
              if (!hit) continue;
              subjects.push({ id: hit.key.id, type: hit.key.kind });
            }
            const kindCounts = proveCurrentKindCounts({
              subjects,
              directory: kindDirectory.map((entry) => entry.kind),
              complete: false,
            });
            for (const [kind, evidence] of kindCounts) if ('value' in evidence) kindWitnesses.set(kind, evidence.value);
            kindExhausted = window.exhausted;
            await countCoverage.consume(countBatch.execution, window.examined);
            await countCoverage.finish();
            aggregateProof = window.exhausted;
          } catch (error) {
            countFailed = true;
            if (error instanceof OwnerCurrentRestartRequired) throw new ProblemError('search_restart_required');
            if (error instanceof ProblemError && error.code === 'search_restart_required') throw error;
            kindWitnesses = new Map();
            kindExhausted = false;
            aggregateProof = false;
          } finally {
            await countCoverage.dispose();
            if (countQueried) {
              try {
                await config.consumer.closeObservation(countQueried, nativeContext);
              } catch (error) {
                if (!countFailed) throw error;
              }
            }
          }
        }
        const execution = last;
        const page = await finishDiscoveryDisclosure(coverage, async () => {
          await spacePopulation?.finish();
          const entries = kindDirectory;
          if (kindAfter && !entries.some((entry) => entry.kind === kindAfter)) throw invalid('/kindPage/cursor');
          const remaining = entries.filter((entry) => entry.kind > kindAfter);
          const selected = remaining.slice(0, admitted.kindLimit);
          // Kind chips use this execution's current witnesses. Continuations stay
          // unavailable; exact totals need exhausted aggregate proof.
          const values = projectKindDirectoryCounts(registry, selected, {
            continuation,
            exhausted: kindExhausted,
            aggregateProof,
            witnesses: kindWitnesses,
          });
          const observed = await config.asOf(queried);
          const projected: DiscoveryPage = {
            hits: boundMatchEvidencePage(
              hits.map((hit) => ({
                ...hit,
                matchEvidence:
                  hit.matchEvidence ??
                  (hit.summary.kind === 'subject' ? { state: 'absent' as const } : { state: 'unsupported' as const }),
              })),
            ),
            kinds: { values, next: null, omitted: [...(registry.omittedKinds ?? [])] },
            applicability: discoveryFilterApplicability(registry, selectedKindsForApplicability(admitted.filter)),
            next: null,
            ...(typeof observed === 'string'
              ? { as_of: observed, freshness: { state: 'unavailable' as const } }
              : observed),
          };
          // Owner replies and metadata must pass the actual transport contract before any token is signed.
          admitDiscoveryPage(projected);
          projected.next = exhausted
            ? null
            : await encodeDiscoveryCursor(
                config.keys,
                binding,
                admitted.collectionDirectory
                  ? {
                      release: digest,
                      registry: registryDigest,
                      queried,
                      after: directoryNextAfter!,
                    }
                  : {
                      release: digest,
                      registry: registryDigest,
                      queried,
                      after: [],
                      retained: { execution: execution.execution, consumed },
                      ...(repair ? { repair } : {}),
                    },
                now,
              );
          projected.kinds.next =
            remaining.length <= selected.length
              ? null
              : await encodeSearchCursor(
                  config.keys,
                  { ...binding, operation: `${binding.operation}.kinds` },
                  {
                    generation: 1,
                    after: [digest, registryDigest, selected.at(-1)!.kind, canonicalize(queried.consumer)!],
                  },
                  now,
                );
          admitDiscoveryPage(projected);
          await retain(projected, (keys) =>
            currentDiscoveryPrimaryCandidates(registry, keys, admitted.filter, release, currentContext),
          );
          return projected;
        });
        retained = page.next !== null && !admitted.collectionDirectory;
        return page;
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        await coverage.dispose();
        if (!retained && observationOpened) {
          try {
            await config.consumer.closeObservation(queried, nativeContext);
          } catch (error) {
            // Cleanup of a lost physical observation must not replace its restart/readiness error.
            if (!failed) throw error;
          }
        }
      }
    } finally {
      await coverage.dispose();
    }
  };
  return async (...args) => {
    try {
      return await execute(...args);
    } catch (error) {
      if (error instanceof ProblemError) throw error;
      if (error instanceof OwnerCurrentRestartRequired) throw new ProblemError('search_restart_required');
      if (error instanceof CollectionDiscoveryReadinessError) throw error;
      // Owner source/native decoder failures are readiness for the whole response, never absence.
      throw ready();
    }
  };
}
