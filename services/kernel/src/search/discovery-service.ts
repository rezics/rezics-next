import canonicalize from 'canonicalize';
import { createHash } from 'node:crypto';
import type { FilterRelease } from '@rezics/filter';
import { ProblemError } from '../http/problem.ts';
import type { PublicFilterSource } from '../semantic/public-filter-source-contract.ts';
import type { SpaceSubjectPopulation } from '../content/feed-subject-scope.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { decodeDiscoveryCursor, decodeSearchCursor, encodeDiscoveryCursor, encodeSearchCursor } from './cursor.ts';
import { currentDiscoveryCandidates, currentDiscoveryPrimaryCandidates } from './discovery-current.ts';
import { compileDiscoveryCapture } from './discovery-filter.ts';
import { admitDiscoveryRequest, ownDiscoveryRequest, type MixedDiscoveryRequest } from './discovery-request.ts';
import type {
  DiscoveryHit,
  DiscoveryPage,
  DiscoveryReadContext,
  DiscoveryRegistry,
  DiscoveryConsumerQuery,
  DiscoveryKey,
} from './discovery.ts';
import type {
  PublicFilterConsumerJob,
  PublicDiscoveryConsumerOperations,
  PublicFilterQueriedObservation,
  PublicFilterConsumerRefill,
} from './public-filter-consumer-contract.ts';
import { finishDiscoveryDisclosure } from './disclosure/discovery.ts';
import { openPublicFilterCoveragePage } from './public-filter-coverage-page.ts';

const ready = () => new ProblemError('index_not_ready', { headers: { 'retry-after': '1' } });
const invalid = (pointer: string) =>
  new ProblemError('invalid_request', { errors: [{ pointer, code: 'invalid_format' }] });
type DiscoveryContextWithSpace = DiscoveryReadContext & { spacePopulation?: SpaceSubjectPopulation };
type Principal = 'anonymous' | `account:${string}`;
export type DiscoverySearch = (
  principal: Principal,
  request: MixedDiscoveryRequest,
  context: DiscoveryReadContext,
) => Promise<DiscoveryPage>;

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
    registry: DiscoveryRegistry;
    release: FilterRelease;
    digest: string;
  }>;
  now(): number;
  asOf(queried: PublicFilterQueriedObservation): Promise<string>;
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
    const admitted = admitDiscoveryRequest(request, registry, release);
    const spacePopulation = (context as DiscoveryContextWithSpace).spacePopulation;
    if (
      (request.spaceId === undefined) !== (spacePopulation === undefined) ||
      (spacePopulation && spacePopulation.observation.spaceId !== request.spaceId)
    )
      throw new ProblemError('dependency_unavailable');
    const registryDigest = createHash('sha256')
      .update(
        canonicalize(
          registry.entries.map((entry) => ({
            owner: entry.owner,
            kind: entry.kind,
            domains: entry.domains,
            metadata: entry.metadata,
          })),
        )!,
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
      let queried: PublicFilterQueriedObservation;
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
        if (!token.state.retained) throw new ProblemError('search_restart_required');
        queried = token.state.queried;
        repair = token.state.repair;
        refill = { ...token.state.retained, size: Math.min(200, 2 * admitted.limit + 1) };
      } else {
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
        repair = captured.repair;
      }
      if (kindPhysical !== undefined && kindPhysical !== canonicalize(queried.consumer))
        throw new ProblemError('search_restart_required');
      const hits: DiscoveryHit[] = [];
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
        for (let round = 0; round < 3; round++) {
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
          if (examined > Math.min(600, 6 * admitted.limit + 3)) throw ready();
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
          const current = await currentDiscoveryCandidates(
            registry,
            selectedCandidates,
            admitted.filter,
            release,
            context,
          );
          consumed = window.examined;
          for (let index = 0; index < result.hits.length; index++) {
            const candidate = result.hits[index]!;
            const identity = `${candidate.key.owner}:${candidate.key.kind}:${candidate.key.id}`;
            const hit =
              seen.has(identity) || (spacePopulation && !inSpace.has(identity)) ? undefined : current.get(candidate);
            if (!hit) continue;
            seen.add(identity);
            hits.push(hit);
            witnesses.set(hit.key.kind, (witnesses.get(hit.key.kind) ?? 0) + 1);
            if (hits.length === admitted.limit) {
              consumed = window.positions[index]! + 1;
              break;
            }
          }
          await coverage.consume(batch.execution, consumed);
          exhausted = consumed === window.examined && window.exhausted;
          if (exhausted || hits.length === admitted.limit) break;
          const remaining = Math.min(600, 6 * admitted.limit + 3) - examined;
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
        const execution = last;
        const page = await finishDiscoveryDisclosure(coverage, async () => {
          await spacePopulation?.finish();
          const entries = [...registry.entries].sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
          if (kindAfter && !entries.some((entry) => entry.kind === kindAfter)) throw invalid('/kindPage/cursor');
          const remaining = entries.filter((entry) => entry.kind > kindAfter);
          const selected = remaining.slice(0, admitted.kindLimit);
          // Only positive bounded current witnesses on the initial hit/metadata page. Census is never queried.
          const values = selected.map((entry) => ({
            ...entry.metadata,
            ...(request.cursor ||
            request.kindPage?.cursor ||
            admitted.countFilter !== admitted.filter ||
            !witnesses.get(entry.kind)
              ? { count: { kind: entry.kind, unavailable: true as const } }
              : { count: { kind: entry.kind, value: witnesses.get(entry.kind)!, exact: false as const } }),
          }));
          const next = exhausted
            ? null
            : await encodeDiscoveryCursor(
                config.keys,
                binding,
                {
                  release: digest,
                  registry: registryDigest,
                  queried,
                  after: [],
                  retained: { execution: execution.execution, consumed },
                  ...(repair ? { repair } : {}),
                },
                now,
              );
          const kindsNext =
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
          const projected = { hits, kinds: { values, next: kindsNext }, next, as_of: await config.asOf(queried) };
          await retain(projected, (keys) =>
            currentDiscoveryPrimaryCandidates(registry, keys, admitted.filter, release, context),
          );
          return projected;
        });
        retained = page.next !== null;
        return page;
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        await coverage.dispose();
        if (!retained) {
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
      // Owner source/native decoder failures are readiness for the whole response, never absence.
      throw ready();
    }
  };
}
