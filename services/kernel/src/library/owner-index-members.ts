import type { FilterDocument } from '@rezics/filter';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import { openOwnerQuery, ownerQueryWork, type OwnerQueryDependencies } from './builtin-runtime-query.ts';
import { systemClock } from '../clock.ts';
import { mintReadTime, releaseOperationalTime } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem-error.ts';
import type { AccountActor, Actor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import { decodeListCursor } from '../tokens/list-cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { CollectionSourceObservation } from './collection-source.ts';
import type { DynamicMemberView } from './builtin-runtime.ts';
import { readEverythingFilterTuple } from './logical-everything-filter.ts';
import { mapPresentationBounded } from './application/presentation-bounds.ts';
import type { CollectionMemberAdmission } from './owner-filter.ts';
import { readNativeCollectionMemberAdmission } from './owner-filter-admission.ts';
import { builtinCollectionId } from './builtin-identity.ts';
import { nativeCollectionFootprint } from './collection-source-native.ts';
import { instrumentNativeCollectionWork } from './collection-native-work.ts';
import { withCollectionReadConnection } from './collection-read-connection.ts';
import { observeEverythingPairs, readPublishedEverythingWindow } from './logical-everything-window.ts';
import { listMemberPage } from './member-viewer-currentness.ts';
import { attachCollectionListFacts } from './collection-list-facts.ts';
import { ordinaryCollectionPagePlan, ordinaryPageWorkDimensions } from './ordinary-read-bounds.ts';

/** Structural/source compatibility is not disclosure. Each positive is checked by the native Source again. */
function sameSource(left: CollectionSourceObservation, right: CollectionSourceObservation) {
  return (
    left.collectionId === right.collectionId &&
    left.route === right.route &&
    left.incarnation === right.incarnation &&
    left.revision === right.revision &&
    left.stamp.epoch === right.stamp.epoch &&
    JSON.stringify(left.authority) === JSON.stringify(right.authority) &&
    JSON.stringify(left.basis) === JSON.stringify(right.basis)
  );
}

export function builtinMemberCursorBinding(
  actor: Actor,
  collectionId: string,
  limit: number,
  query?: { filter: FilterDocument; releaseDigest: string },
) {
  return {
    route: 'GET /v1/collections/:collectionId/members',
    viewer: actor.kind === 'account' ? actor.accountId : null,
    query: {
      collectionId,
      limit,
      order: 'id',
      source: 'private_builtin',
      ...(query
        ? {
            filter: createHash('sha256').update(canonicalize(query.filter)!).digest('hex'),
            release: query.releaseDigest,
          }
        : {}),
    },
  };
}

/**
 * Common canonical member caller. The delivered Source owns candidate order, alias completion,
 * original+terminal disclosure and source-scoped identity currentness. No raw-ID page is normalized here.
 */
export async function readCollectionSourceMembers(
  deps: OwnerQueryDependencies & { tokens: KeyRing },
  input: {
    actor: Actor;
    collectionId: string;
    limit: number;
    cursor?: string | null;
    deadline: number;
    query?: { filter: FilterDocument; releaseDigest: string; admission?: CollectionMemberAdmission };
    view?: 'BASIC' | 'FULL';
    ledger?: ReturnType<typeof ownerQueryWork>;
    languages?: readonly string[];
    /** Actual owner-home reread after releasing all foreign source homes. */
    revalidateOwner: () => Promise<void>;
    /** Actual native source version, independent of identity and permission. */
    readSourceVersion: () => Promise<string>;
  },
): Promise<{ members: DynamicMemberView[]; next: string | null }> {
  const clock = deps.clock ?? systemClock;
  const binding = builtinMemberCursorBinding(input.actor, input.collectionId, input.limit, input.query);
  const position = input.cursor == null ? null : await decodeListCursor(deps.tokens, binding, input.cursor, clock());
  if (
    position &&
    (!position.ok ||
      position.after.length !== 4 ||
      position.after.some((value) => typeof value !== 'string') ||
      routeOf(String(position.after[3])) === null)
  )
    throw new ProblemError('invalid_cursor');
  const pagePlan = ordinaryCollectionPagePlan(input.limit, input.view ?? 'BASIC');
  const ledger = input.ledger ?? ownerQueryWork(input.limit, input.view ?? 'BASIC', input.deadline);
  const pageDimensions = ordinaryPageWorkDimensions(pagePlan.sourceBound);
  const readTime = () =>
    ledger.physical.withinAllowance(ledger.sourceAllowance(), () =>
      instrumentNativeCollectionWork(deps.pool, ledger.physical, nativeCollectionFootprint, () =>
        withCollectionReadConnection(deps.pool, input.deadline, (client) => mintReadTime(client, clock)),
      ),
    );
  const logicalFilter =
    input.query !== undefined &&
    input.actor.kind === 'account' &&
    input.collectionId === builtinCollectionId(input.actor.accountId, { kind: 'everything' });
  const previousVersion = logicalFilter ? null : await input.readSourceVersion();
  const at = logicalFilter
    ? await readTime()
    : await withConnection(deps.pool, (client) => mintReadTime(client, clock));
  try {
    const context = { actor: input.actor, at, deadline: input.deadline };
    const runtime = await openOwnerQuery(deps, {
      actor: input.actor,
      collectionId: input.collectionId,
      deadline: input.deadline,
      work: ledger,
      logical: true,
      publishedEverythingPage: logicalFilter,
      at,
    });
    const prepared = runtime.source;
    const source = runtime.native;
    const filtered = input.query ? await runtime.filter(input.query.filter, input.query.releaseDigest) : null;
    const observed = prepared.observation;
    const version =
      previousVersion ?? (prepared.queryCapture ? observed.sourceIdentity.generation : await input.readSourceVersion());
    if (
      observed.authority.kind !== 'private_builtin' ||
      (observed.authority.kind === 'private_builtin' &&
        (input.actor.kind !== 'account' || observed.authority.curatorAccountId !== input.actor.accountId))
    )
      throw new ProblemError('not_found');
    let after: string | null = null;
    if (position?.ok) {
      if (
        position.epoch !== observed.stamp.epoch ||
        position.after[0] !== observed.incarnation ||
        position.after[1] !== observed.basis.digest ||
        position.after[2] !== version
      )
        throw new ProblemError('stale_cursor');
      after = String(position.after[3]);
    }
    const admission = input.query?.admission;
    const nativeAdmission = admission && readNativeCollectionMemberAdmission(admission);
    const leaf = admission?.plan?.leaves.length === 1 ? admission.plan.leaves[0] : null;
    if (
      filtered &&
      input.query &&
      prepared.queryCapture &&
      input.actor.kind === 'account' &&
      admission &&
      nativeAdmission?.actor === input.actor &&
      nativeAdmission.pool === deps.pool &&
      nativeAdmission.deadline >= input.deadline &&
      !nativeAdmission.retainedMeaning &&
      nativeAdmission.source.kind === 'owner' &&
      admission.filter === input.query.filter &&
      admission.releaseDigest === input.query.releaseDigest &&
      'statement' in input.query.filter &&
      leaf?.kind === 'catalogue' &&
      leaf.clause.facet === 'statement' &&
      'range' in leaf.clause
    ) {
      const query = input.query;
      const actor = input.actor;
      const depsAtOwner = { ...deps, actor, deadline: input.deadline, work: ledger.physical };
      const rawLimit = Math.min(pagePlan.candidateLimit, 2 * input.limit);
      const window = (source: typeof prepared) =>
        ledger.physical.withinAllowance(ledger.sourceAllowance(), () =>
          readPublishedEverythingWindow(depsAtOwner, source, after, rawLimit),
        );
      const initial = await window(prepared);
      const subjects = await ledger.physical.withinAllowance(ledger.sourceAllowance(), () =>
        observeEverythingPairs(depsAtOwner, initial.rows, at),
      );
      const ids = [...new Set(initial.rows.map((row) => row.terminal))];
      const visible = new Set(
        subjects.decisions.filter((decision) => decision.state === 'disclosed').map((decision) => decision.terminal),
      );
      const evaluate = (time: typeof at) =>
        ledger.physical.withinAllowance(ledger.sourceAllowance(), () =>
          instrumentNativeCollectionWork(deps.pool, ledger.physical, nativeCollectionFootprint, () =>
            mapPresentationBounded(ids, async (id) =>
              visible.has(id)
                ? readEverythingFilterTuple(
                    { ...depsAtOwner, routeKey: requiredRouteKey(deps.routeKey) },
                    time,
                    id,
                    leaf,
                  )
                : { id, visible: false, matches: false },
            ),
          ),
        );
      const matches = await evaluate(at);
      const supported = new Set(
        initial.rows.flatMap((row, i) =>
          row.present && subjects.decisions[i]!.state === 'disclosed' ? [row.terminal] : [],
        ),
      );
      const members = ids
        .filter((id, i) => id !== initial.incompleteTerminal && matches[i]!.matches && supported.has(id))
        .map((subjectId) => ({ kind: 'dynamic' as const, subjectId }));
      if (!initial.exhausted && members.length <= input.limit) throw new ProblemError('semantic_not_ready');
      const shown = members.slice(0, input.limit);
      const revalidate = async () => {
        const finalAt = await readTime();
        try {
          const final = await openOwnerQuery(deps, {
            actor,
            collectionId: input.collectionId,
            deadline: input.deadline,
            work: ledger,
            logical: true,
            publishedEverythingPage: true,
            at: finalAt,
          });
          if (
            !sameSource(observed, final.source.observation) ||
            !isDeepStrictEqual(initial, await window(final.source))
          )
            throw new ProblemError('semantic_not_ready');
          const finalFilter = await final.filter(query.filter, query.releaseDigest);
          if (
            !isDeepStrictEqual(filtered.prepared.basis, finalFilter.prepared.basis) ||
            !isDeepStrictEqual(matches, await evaluate(finalAt))
          )
            throw new ProblemError('semantic_not_ready');
          // The fresh logical Source admits the same owner. The window joins its exact current fact head.
          if (final.source.observation.sourceIdentity.generation !== version)
            throw new ProblemError('semantic_not_ready');
          const fresh = await readTime();
          try {
            await ledger.physical.withinAllowance(ledger.sourceAllowance(), () => subjects.revalidate(fresh));
          } finally {
            releaseOperationalTime(fresh);
          }
        } finally {
          releaseOperationalTime(finalAt);
        }
      };
      const disclosed =
        input.view === 'FULL'
          ? await attachCollectionListFacts({ ...depsAtOwner, routeKey: requiredRouteKey(deps.routeKey) }, shown, {
              revalidate,
              ...(input.languages === undefined ? {} : { languages: input.languages }),
            })
          : shown;
      if (input.view !== 'FULL') await revalidate();
      if (disclosed.length !== shown.length) throw new ProblemError('semantic_not_ready');
      return listMemberPage(
        disclosed,
        deps.tokens,
        binding,
        members.length > shown.length
          ? {
              epoch: observed.stamp.epoch,
              after: [observed.incarnation, observed.basis.digest, version, shown.at(-1)!.subjectId],
            }
          : null,
        clock,
      );
    }
    const members: DynamicMemberView[] = [];
    let exhausted = false;
    for (let round = 0; round < 3 && members.length <= input.limit && !exhausted; round++) {
      const quota = Math.min(pagePlan.prefixGroupLimit, 2 * (input.limit - members.length) + 1);
      const prefix = filtered
        ? await filtered.scope.sourcePrefix(filtered.prepared, {
            afterSubjectId: after,
            candidateLimit: quota,
            allowance: ledger.sourceAllowance(),
          })
        : await source.prefix({
            ...context,
            source: prepared,
            allowance: ledger.sourceAllowance(),
            afterSubjectId: after,
            candidateLimit: quota,
          });
      ledger.native(prefix.work);
      if (prefix.candidates.length > quota) throw new ProblemError('dependency_unavailable');
      if (!sameSource(observed, prefix.observation)) throw new ProblemError('semantic_not_ready');
      for (const candidate of prefix.candidates) {
        if (routeOf(candidate.subjectId) === null || (after !== null && candidate.subjectId <= after))
          throw new ProblemError('dependency_unavailable');
        const membership = await source.containsSubject({
          ...context,
          source: prepared,
          allowance: ledger.sourceAllowance(),
          subjectId: candidate.subjectId,
          positiveEvidence: candidate.evidence,
        });
        ledger.native(membership.work);
        if (!sameSource(observed, membership.observation)) throw new ProblemError('semantic_not_ready');
        if (membership.result === 'not_proven') throw new ProblemError('dependency_unavailable');
        after = candidate.subjectId;
        if (membership.result) {
          if (filtered) {
            const result = await filtered.scope.evaluate(filtered.prepared, [candidate.subjectId], {
              rawKeys: Math.min(256, pagePlan.candidateLimit),
              native: {
                points: pageDimensions.nativePoints,
                witnesses: pageDimensions.witnessKeys,
                rows: pageDimensions.nativeRows,
                bytes: pageDimensions.bytes,
                emptySeeks: pageDimensions.emptySeeks,
              },
              allowance: ledger.sourceAllowance(),
            });
            ledger.native(filtered.scope.work(result));
            if (result.values.length !== 1 || typeof result.values[0] !== 'boolean')
              throw new ProblemError('dependency_unavailable');
            if (!result.values[0]) continue;
          }
          members.push({ kind: 'dynamic', subjectId: candidate.subjectId });
        }
        if (members.length > input.limit) break;
      }
      if (members.length > input.limit) break;
      exhausted = prefix.exhausted;
      if (!exhausted && prefix.coveredThrough === null) throw new ProblemError('dependency_unavailable');
      after = prefix.coveredThrough ?? after;
    }
    // A consumed raw window never establishes a short or empty nonfinal page.
    if (members.length <= input.limit && !exhausted) throw new ProblemError('dependency_unavailable');
    const shown = members.slice(0, input.limit);
    // A wait or foreign-home read cannot reuse the old T for final disclosure.
    const revalidate = async () => {
      const finalAt = await withConnection(deps.pool, (client) => mintReadTime(client, clock));
      try {
        const finalRuntime = await openOwnerQuery(deps, {
          actor: input.actor,
          collectionId: input.collectionId,
          deadline: input.deadline,
          work: ledger,
          logical: true,
          at: finalAt,
        });
        const current = finalRuntime.source;
        const finalFilter = input.query
          ? await finalRuntime.filter(input.query.filter, input.query.releaseDigest)
          : null;
        if (filtered && finalFilter && !isDeepStrictEqual(filtered.prepared.basis, finalFilter.prepared.basis))
          throw new ProblemError('semantic_not_ready');
        if (!sameSource(observed, current.observation)) throw new ProblemError('semantic_not_ready');
        for (const member of shown) {
          const checked = await finalRuntime.native.containsSubject({
            ...context,
            at: finalAt,
            source: current,
            allowance: ledger.sourceAllowance(),
            subjectId: member.subjectId,
          });
          ledger.native(checked.work);
          if (!sameSource(observed, checked.observation) || checked.result !== true)
            throw new ProblemError('semantic_not_ready');
        }
        if (finalFilter) {
          const checked = await finalFilter.scope.evaluate(
            finalFilter.prepared,
            shown.map((member) => member.subjectId),
            {
              rawKeys: Math.min(256, pagePlan.candidateLimit),
              native: {
                points: pageDimensions.nativePoints,
                witnesses: pageDimensions.witnessKeys,
                rows: pageDimensions.nativeRows,
                bytes: pageDimensions.bytes,
                emptySeeks: pageDimensions.emptySeeks,
              },
              allowance: ledger.sourceAllowance(),
            },
          );
          ledger.native(finalFilter.scope.work(checked));
          if (checked.values.length !== shown.length || checked.values.some((value) => value !== true))
            throw new ProblemError('semantic_not_ready');
        }
        await input.revalidateOwner();
        if ((await input.readSourceVersion()) !== version) throw new ProblemError('semantic_not_ready');
      } finally {
        releaseOperationalTime(finalAt);
      }
    };
    await revalidate();
    const disclosed =
      input.view === 'FULL'
        ? await attachCollectionListFacts(
            { ...deps, routeKey: requiredRouteKey(deps.routeKey), actor: input.actor, deadline: input.deadline },
            shown,
            { revalidate, ...(input.languages === undefined ? {} : { languages: input.languages }) },
          )
        : shown;
    if (disclosed.length !== shown.length) throw new ProblemError('dependency_unavailable');
    return await listMemberPage(
      disclosed,
      deps.tokens,
      binding,
      members.length > input.limit
        ? {
            epoch: observed.stamp.epoch,
            after: [observed.incarnation, observed.basis.digest, version, shown.at(-1)!.subjectId],
          }
        : null,
      clock,
    );
  } finally {
    releaseOperationalTime(at);
  }
}

function requiredRouteKey(key: Uint8Array | undefined): Uint8Array {
  if (!key) throw new ProblemError('dependency_unavailable');
  return key;
}

/** Existing private built-in caller, with unchanged native owner and query authority. */
export function readOwnerMembers(
  deps: OwnerQueryDependencies & { tokens: KeyRing },
  input: Omit<Parameters<typeof readCollectionSourceMembers>[1], 'actor'> & { actor: AccountActor },
) {
  return readCollectionSourceMembers(deps, input);
}
