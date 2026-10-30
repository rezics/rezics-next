import canonicalize from 'canonicalize';
import { createHash } from 'node:crypto';
import type { FilterRelease } from '@rezics/filter';
import { ProblemError } from '../http/problem.ts';
import type { PublicFilterSource } from '../semantic/public-filter-source-contract.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { decodeDiscoveryCursor, decodeSearchCursor, encodeDiscoveryCursor, encodeSearchCursor } from './cursor.ts';
import { currentDiscoveryCandidates } from './discovery-current.ts';
import { compileDiscoveryCapture } from './discovery-filter.ts';
import { admitDiscoveryRequest, type MixedDiscoveryRequest } from './discovery-request.ts';
import type {
  DiscoveryHit,
  DiscoveryPage,
  DiscoveryReadContext,
  DiscoveryRegistry,
  DiscoveryConsumerQuery,
} from './discovery.ts';
import type {
  PublicFilterConsumerJob,
  PublicDiscoveryConsumerOperations,
  PublicFilterQueriedObservation,
  PublicFilterConsumerRefill,
} from './public-filter-consumer-contract.ts';
import { finishDiscoveryDisclosure } from './disclosure/discovery.ts';

const ready = () => new ProblemError('index_not_ready', { headers: { 'retry-after': '1' } });
const invalid = (pointer: string) =>
  new ProblemError('invalid_request', { errors: [{ pointer, code: 'invalid_format' }] });
type Principal = 'anonymous' | `account:${string}`;
export type DiscoverySearch = (
  principal: Principal,
  request: MixedDiscoveryRequest,
  context: DiscoveryReadContext,
) => Promise<DiscoveryPage>;

/** Actual retained consumer and Source are mandatory here. The mounted route may omit this provider while
 * native owner integration is absent, in which case it returns readiness before enumeration.
 */
export function createDiscoverySearch(config: {
  consumer: PublicDiscoveryConsumerOperations;
  source: PublicFilterSource;
  keys: KeyRing;
  /** Pins the actual release and request-language owner hydration for the entire operation. */
  resolve(request: MixedDiscoveryRequest): Promise<{
    registry: DiscoveryRegistry;
    release: FilterRelease;
    digest: string;
  }>;
  now(): number;
  asOf(queried: PublicFilterQueriedObservation): Promise<string>;
}): DiscoverySearch {
  const execute: DiscoverySearch = async (principal, request, context) => {
    const { registry, release, digest } = await config.resolve(request);
    const admitted = admitDiscoveryRequest(request, registry, release);
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
    const binding = { operation: 'subjects.search.discovery-v1', principal, request: admitted.bindingRequest };
    const now = config.now();
    const nativeContext = { deadline: context.deadline };
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
      const captured = await config.consumer.captureDiscovery({ plan, snapshot: 'pit' }, nativeContext);
      if (captured.status === 'preparing') {
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
    const executions: Extract<DiscoveryConsumerQuery, { status: 'queried' }>[] = [];
    let consumed = 0;
    let examined = 0;
    let exhausted = false;
    let retained = false;
    try {
      for (let round = 0; round < 3; round++) {
        const batch = await config.consumer.queryDiscovery(queried, nativeContext, refill);
        if (batch.status !== 'queried') {
          retained = batch.status === 'preparing';
          throw ready();
        }
        last = batch;
        executions.push(batch);
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
        const current = await currentDiscoveryCandidates(registry, result.hits, admitted.filter, release, context);
        consumed = window.examined;
        for (let index = 0; index < result.hits.length; index++) {
          const candidate = result.hits[index]!;
          const identity = `${candidate.key.owner}:${candidate.key.kind}:${candidate.key.id}`;
          const hit = seen.has(identity) ? undefined : current.get(candidate);
          if (!hit) continue;
          seen.add(identity);
          hits.push(hit);
          witnesses.set(hit.key.kind, (witnesses.get(hit.key.kind) ?? 0) + 1);
          if (hits.length === admitted.limit) {
            consumed = window.positions[index]! + 1;
            break;
          }
        }
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
          await config.consumer.repairStep(repair, nativeContext);
          retained = true;
        }
        throw ready();
      }
      const execution = last;
      const page = await finishDiscoveryDisclosure(
        config.source,
        executions,
        nativeContext,
        async () => {
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
          return { hits, kinds: { values, next: kindsNext }, next, as_of: await config.asOf(queried) };
        },
        config.consumer,
      );
      retained = page.next !== null;
      return page;
    } finally {
      if (!retained) await config.consumer.closeObservation(queried, nativeContext);
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
