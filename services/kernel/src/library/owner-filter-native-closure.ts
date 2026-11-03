/** Complete raw Source groups, ordinary disclosure and native private fact locators. */
import { isDeepStrictEqual } from 'node:util';
import type { Release } from '@rezics/definitions';
import { deadlineClient } from '../access/authenticate.ts';
import { withConnection } from '../database/pool.ts';
import { routeOf } from '../route/route.ts';
import { zeroScopeWork } from '../search/scope-execution.ts';
import { currentOwnerClauseKey } from '../search/current-filter-plan.ts';
import { readRelease } from '../semantic/definitions.ts';
import { readScopeLeafEvidence, type LeafEvidence, type LeafWork } from '../semantic/scope-leaf-evidence.ts';
import { readCanonicalSourceGroup, readCanonicalSourceState, type CanonicalRawKey } from './canonical-source-store.ts';
import type { PreparedCollectionSource } from './collection-source.ts';
import type { NativeCollectionWork } from './collection-source-work.ts';
import type { OwnerFilterCandidateClosure, OwnerFilterReadBinding } from './owner-filter-plan.ts';
import type { OwnerFilterFactLocator } from './owner-filter.ts';
import { resolveSubject } from './subject-anchor.ts';
import {
  nativeOwnerFilterBinding,
  ownerFilterAccessContext,
  ownerFilterBounded,
  ownerFilterCanonical,
  ownerFilterQuery,
  ownerFilterUnavailable,
  revalidateNativeOwnerFilter,
  retainOwnerFilterOriginal,
  sameOwnerFilterSource,
} from './owner-filter-native-binding.ts';
import factsQuery from './owner-filter-native-closure-facts.sql';
import releaseSize from './owner-filter-native-closure-release-size.sql';
import populationQuery from './owner-filter-native-closure-population.sql';

type NativeFactKey = { driver: number; factId: string; labelId: string | null };

/** A prepared answer must reauthorize its complete structural population, including exclusions/order.
 * LIMIT bounds raw references before hydration. A full window is unavailable, never fabricated coverage.
 */
export async function retainNativeOwnerFilterPopulation(binding: OwnerFilterReadBinding, work: NativeCollectionWork) {
  const saved = nativeOwnerFilterBinding(binding);
  if (!saved) throw ownerFilterUnavailable();
  const limit = Math.min(100, work.available('candidateKeys'));
  if (limit < 1) throw ownerFilterUnavailable();
  const rows = await withConnection(saved.dependencies.pool, (client) => ownerFilterQuery<{
    original: string; terminal: string;
  }>(deadlineClient(client, binding.input.deadline), work, populationQuery, {
    route: saved.metadata.route, collection_id: saved.metadata.collectionId, limit,
  }, { nativeRows: 8 * limit + 8, candidateKeys: limit, bytes: 128 * limit }));
  if (rows.length === limit) throw ownerFilterUnavailable();
  for (const row of rows) {
    if (routeOf(row.original) === null || routeOf(row.terminal) === null) throw ownerFilterUnavailable();
    retainOwnerFilterOriginal(binding, row.original, row.terminal);
    retainOwnerFilterOriginal(binding, row.terminal, row.terminal);
  }
  // A ready source generation, rather than an empty/missing join, proves structural exhaustion.
  const state = await ownerFilterCanonical(work, (allowance) => readCanonicalSourceState(saved.dependencies.pool, {
    route: saved.metadata.route, collectionId: saved.metadata.collectionId, deadline: binding.input.deadline, allowance,
  }));
  if (state.state !== 'ready' || state.basis.digest !== saved.observation.basis.digest) throw ownerFilterUnavailable();
}

function locator(subjectId: string, row: NativeFactKey): OwnerFilterFactLocator {
  if (routeOf(row.factId) === null) throw ownerFilterUnavailable();
  switch (row.driver) {
    case 1:
      return { kind: 'entry', subjectId };
    case 2:
      if (row.labelId === null || routeOf(row.labelId) === null) throw ownerFilterUnavailable();
      return { kind: 'label', subjectId, labelId: row.labelId };
    case 3:
      return { kind: 'session', subjectId, sessionId: row.factId };
    case 4:
      return { kind: 'holding', subjectId, copyId: row.factId };
    default:
      throw ownerFilterUnavailable();
  }
}

function leafBudget(work: NativeCollectionWork): LeafWork | null {
  const budget = {
    keys: Math.min(101, work.available('candidateKeys')),
    points: Math.min(work.available('nativePoints'), Math.floor(work.available('statements') / 3)),
    witnesses: Math.min(100, work.available('witnessKeys')),
    rows: work.available('nativeRows'),
    bytes: work.available('bytes'),
    emptySeeks: work.available('emptySeeks'),
  };
  return Object.values(budget).every((value) => value > 0) ? budget : null;
}

async function catalogueEvidence(
  binding: OwnerFilterReadBinding,
  subject: string,
  work: NativeCollectionWork,
): Promise<ReadonlyMap<string, LeafEvidence> | null> {
  const saved = nativeOwnerFilterBinding(binding)!;
  const { dependencies, admission } = saved;
  const result = new Map<string, LeafEvidence>();
  for (const leaf of admission.plan?.leaves ?? []) {
    if (leaf.kind !== 'catalogue') continue;
    if (!dependencies.routeKey) return null;
    // The Semantic reader owns property selection, immutable meaning, current disclosure and byte admission.
    // Transfer all dimensions before dispatch; its native ledger reserves each point before executing it.
    const read = async () => {
      const budget = leafBudget(work);
      if (!budget) return null;
      const completed = await work.compose(async (allowance) => {
        const evidence = await readScopeLeafEvidence(
          dependencies.pool,
          {
            subject,
            leaf: leaf.clause,
            after: null,
            revalidate: null,
            budget,
          },
          {
            access: dependencies.access,
            actor: binding.input.actor,
            nativeT: binding.input.at,
            routeKey: dependencies.routeKey!,
            deadline: binding.input.deadline,
          },
        );
        const usage = evidence.usage;
        return {
          evidence,
          work: {
            reservationId: allowance.reservationId,
            used: {
              ...zeroScopeWork(),
              candidateKeys: usage.keys,
              nativePoints: usage.points,
              nativeRows: usage.rows,
              witnessKeys: usage.witnesses,
              bytes: usage.bytes,
              emptySeeks: usage.emptySeeks,
              // Each native point can open/close a snapshot and execute a statement.
              statements: 3 * usage.points,
            },
          },
        };
      });
      return completed.evidence;
    };
    const first = await read();
    if (!first || first.state !== 'current' || first.progress !== null || first.coverage?.basis !== first.basis)
      return null;
    const final = await read();
    if (!final || !isDeepStrictEqual({ ...first, usage: null }, { ...final, usage: null })) return null;
    result.set(currentOwnerClauseKey(leaf), final);
  }
  return result;
}

/** The accepted immutable release is read only after its size point, in the same snapshot.
 * Composed/missing releases stay unproved; the current catalogue cannot relabel a historic private fact.
 */
async function acceptedRelease(binding: OwnerFilterReadBinding, digest: string, work: NativeCollectionWork) {
  const { dependencies } = nativeOwnerFilterBinding(binding)!;
  return ownerFilterBounded(work, { nativePoints: 1, statements: 3, bytes: 256 }, () =>
    withConnection(dependencies.pool, async (connection) => {
      const client = deadlineClient(connection, binding.input.deadline);
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        const [size] = await ownerFilterQuery<{ bytes: string; compressed: boolean }>(
          client,
          work,
          releaseSize,
          { digest },
          { nativeRows: 4, bytes: 256 },
        );
        if (!size) {
          await client.query('COMMIT');
          return null;
        }
        const storedBytes = Number(size.bytes);
        if (!Number.isSafeInteger(storedBytes) || storedBytes < 0) throw ownerFilterUnavailable();
        const bytes = 6 * (size.compressed ? 1024 * 1024 * 1024 : storedBytes) + 1024;
        const release = await ownerFilterBounded(
          work,
          {
            nativeRows: 8,
            nativePoints: 2,
            statements: 2,
            bytes,
          },
          () => readRelease(client, digest, { composed: false }),
        );
        await client.query('COMMIT');
        return release;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }),
  );
}

export async function readNativeOwnerFilterClosure(
  binding: OwnerFilterReadBinding,
  source: PreparedCollectionSource,
  subjectId: string,
  work: NativeCollectionWork,
  deferDisclosure = false,
) {
  const saved = nativeOwnerFilterBinding(binding);
  if (
    !saved ||
    routeOf(subjectId) === null ||
    work.receipt().reservationId !== binding.input.allowance.reservationId ||
    !sameOwnerFilterSource(source.observation, saved.observation)
  )
    return { status: 'unavailable' } as const;
  const { dependencies, metadata, admission, attempt } = saved;
  const { actor, at, deadline } = binding.input;
  const input = { route: metadata.route, collectionId: metadata.collectionId, deadline };
  const state = await ownerFilterCanonical(work, (allowance) =>
    readCanonicalSourceState(dependencies.pool, { ...input, allowance }),
  );
  if (state.state !== 'ready' || state.basis.digest !== source.observation.basis.digest)
    return { status: 'unavailable' } as const;
  if (
    metadata.authority === 'private_builtin' &&
    metadata.builtinKind === 'state' &&
    state.basis.originalCoverage !== 'owner-facts-v1'
  )
    return { status: 'unavailable' } as const;
  const keys: CanonicalRawKey[] = [];
  let after: CanonicalRawKey | null = null;
  for (;;) {
    const page = await ownerFilterCanonical(work, (allowance) =>
      readCanonicalSourceGroup(dependencies.pool, {
        ...input,
        allowance,
        basis: state.basis,
        progress: { pendingSubjectId: subjectId, after, generation: state.generation, basis: state.basis },
      }),
    );
    if (page.state !== 'ready') return { status: 'unavailable' } as const;
    keys.push(...page.rows.map((row) => row.key));
    if (keys.length > 100) return { status: 'unavailable' } as const;
    if (page.exhausted) break;
    if (page.rows.length === 0 || isDeepStrictEqual(after, page.examinedThrough))
      return { status: 'unavailable' } as const;
    after = page.examinedThrough;
  }
  // A missing group cannot be a successful empty closure, nor can a terminal point prove alias coverage.
  if (!keys.length) return { status: 'unavailable' } as const;
  const originalIds = [...new Set([...keys.map((key) => key.storedSubjectId), subjectId])];
  if (originalIds.length + keys.length > 100) return { status: 'unavailable' } as const;
  const originals: { subjectId: string; facts: OwnerFilterFactLocator[] }[] = [];
  const releases = new Map<string, Release>();
  const releaseDigests = new Set<string>();
  const context = ownerFilterAccessContext(dependencies, deadline, attempt);
  async function disclose(original: string) {
    const resolved = await ownerFilterBounded(
      work,
      {
        candidateKeys: 1,
        nativeRows: 8192,
        nativePoints: 128,
        statements: 128,
        bytes: 1024 * 1024,
      },
      () => resolveSubject(dependencies, actor, original, at, context),
    );
    if (!resolved || resolved.subjectId !== subjectId) throw ownerFilterUnavailable();
    retainOwnerFilterOriginal(binding, original, subjectId);
  }
  for (const original of originalIds) {
    await disclose(original);
    const facts: OwnerFilterFactLocator[] = [];
    if (admission.owner) {
      if (
        actor.kind !== 'account' ||
        (metadata.authority === 'private_builtin' && actor.accountId !== metadata.curatorAccountId)
      )
        throw ownerFilterUnavailable();
      // All original keys, including originals excluded by the Source's built-in state, have independent facts.
      // No matching leaf or positive witness chooses the population. LIMIT precedes all fact hydration.
      const remaining = Math.min(
        100 - originalIds.length - originals.reduce((sum, row) => sum + row.facts.length, 0),
        work.available('candidateKeys'),
      );
      if (remaining < 1) return { status: 'unavailable' } as const;
      const rows = await ownerFilterBounded(work, { nativePoints: 1, statements: 3, bytes: 256 }, () =>
        withConnection(dependencies.pool, async (connection) => {
          const client = deadlineClient(connection, deadline);
          await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
          try {
            const rows = await ownerFilterQuery<NativeFactKey>(
              client,
              work,
              factsQuery,
              {
                route: routeOf(actor.accountId),
                account_id: actor.accountId,
                subject_id: original,
                limit: remaining,
              },
              {
                nativeRows: 32 * remaining + 32,
                nativePoints: 5,
                candidateKeys: remaining,
                witnessKeys: remaining,
                bytes: 256 * remaining,
              },
            );
            // A full window is unknown, even when every observed supporter matched.
            if (rows.length === remaining) {
              await client.query('COMMIT');
              return null;
            }
            for (const row of rows) {
              const factLocator = locator(original, row);
              facts.push(factLocator);
              const needed = admission.plan?.leaves.some(
                (leaf) =>
                  leaf.kind === 'owner' &&
                  (('state' in leaf.leaf.owner && factLocator.kind === 'entry') ||
                    ('session' in leaf.leaf.owner && factLocator.kind === 'session') ||
                    ('holding' in leaf.leaf.owner && factLocator.kind === 'holding')),
              );
              if (!needed) continue;
              const fact = await admission.owner!.read(client, factLocator, work);
              if (fact && 'pin' in fact && fact.pin) releaseDigests.add(fact.pin.releaseDigest);
            }
            await client.query('COMMIT');
            return rows;
          } catch (error) {
            await client.query('ROLLBACK');
            throw error;
          }
        }),
      );
      if (rows === null) return { status: 'unavailable' } as const;
    }
    originals.push({ subjectId: original, facts });
  }
  // Foreign release and catalogue evidence starts only after the source/private snapshot has been released.
  for (const digest of releaseDigests) {
    const release = await acceptedRelease(binding, digest, work);
    if (!release) return { status: 'unavailable' } as const;
    releases.set(digest, release);
  }
  const catalogue = await catalogueEvidence(binding, subjectId, work);
  if (catalogue === null) return { status: 'unavailable' } as const;
  // Ordinary enclosing readers repeat ALL retained originals at disclosure, including rejections.
  // Existing point/command consumers retain their immediate closure checks.
  if (!deferDisclosure) {
    for (const original of originalIds) await disclose(original);
    await revalidateNativeOwnerFilter(binding, work);
  }
  const closure: OwnerFilterCandidateClosure = { subjectId, originals, releases, catalogue };
  return { status: 'complete', closure } as const;
}
