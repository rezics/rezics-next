import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import canonicalize from 'canonicalize';
import { systemClock } from '../clock.ts';
import {
  authoritativeTimeValue,
  mintReadTime,
  releaseOperationalTime,
  withCompiledCommandControls,
  type AuthoritativeTime,
} from '../command/command.ts';
import type { ReadMemberViewerFacts } from './contract/builtin-presentation.ts';
import { ProblemError } from '../http/problem-error.ts';
import type { AccountActor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { decideExposure } from '@rezics/access';
import { observePreparedScalarRange } from '../semantic/private-catalogue-range.ts';
import { libraryScopeSourceKey } from '../semantic/identity-scoped-observations.ts';
import { LIBRARY_SUBJECT_PAGE_LIMIT } from './contract/presentation.ts';
import type { ownerQueryWork } from './builtin-runtime-query.ts';
import { decodeListCursor } from '../tokens/list-cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { PlatformClosedError } from '../access/contract/errors.ts';
import { accessRoot, admitGroup } from './access-port.ts';
import { builtinCollectionId } from './builtin-identity.ts';
import { attachCollectionListFacts } from './collection-list-facts.ts';
import type { PresentationDependencies } from './collection-presentation.ts';
import { withCollectionReadConnection } from './collection-read-connection.ts';
import { builtinMemberCursorBinding } from './owner-index-members.ts';
import { grantCapable, type GrantedAccount } from './account-grant.ts';
import { instrumentNativeCollectionWork } from './collection-native-work.ts';
import {
  collectionsOpeningValues,
  everythingEntryWindowSQL,
  openEverythingEntryWindowSQL,
  nativeCollectionFootprint,
} from './collection-source-native.ts';
import { listMemberPage } from './member-viewer-currentness.ts';
import { readNativeCollectionMemberAdmission } from './owner-filter-admission.ts';
import { type CollectionMemberAdmission, type CollectionMemberQuery } from './owner-filter.ts';

const digest = (value: unknown) => createHash('sha256').update(canonicalize(value)!).digest('hex');
const changed = () => new ProblemError('stale_cursor');
type ReadinessStage = 'admission' | 'scalar-selection' | 'list-facts' | 'presented-members';

/**
 * Direct id-order plan for a revision-zero Everything whose entire native population is explicit entries.
 * The canonical worker proves identity and order over the whole generation. Other fact
 * families, stored Collections and larger populations keep their ordinary Source plan.
 */
export async function readLogicalEverythingMembers(
  deps: PresentationDependencies & { tokens: KeyRing },
  actor: AccountActor,
  collectionId: string,
  admission: CollectionMemberAdmission | undefined,
  options: CollectionMemberQuery & { readViewerFacts?: ReadMemberViewerFacts },
  deadline: number,
  ledger: ReturnType<typeof ownerQueryWork>,
) {
  const routeKey = deps.routeKey;
  if (!routeKey || collectionId !== builtinCollectionId(actor.accountId, { kind: 'everything' })) return null;
  let reported = false;
  function reportUnready(stage: ReadinessStage, reason?: string) {
    // Concurrent Subject reads can encounter the same refusal. Log the first stage once per direct read.
    if (reported) return;
    reported = true;
    console.warn(JSON.stringify({ event: 'library.logical-everything-unready', stage, reason }));
  }
  function unready(stage: ReadinessStage, reason?: string) {
    reportUnready(stage, reason);
    return new ProblemError('semantic_not_ready');
  }
  if (!admission) return null;
  const admitted = readNativeCollectionMemberAdmission(admission);
  if (!admitted || admitted.pool !== deps.pool || admitted.actor !== actor || admitted.deadline < deadline)
    throw unready('admission');
  const leaf = admission.plan?.leaves.length === 1 ? admission.plan.leaves[0] : undefined;
  if (
    admitted.retainedMeaning ||
    admitted.source.kind !== 'owner' ||
    !admission.releaseDigest ||
    !admission.release ||
    !admission.filter ||
    !('statement' in admission.filter) ||
    leaf?.kind !== 'catalogue' ||
    leaf.clause.facet !== 'statement' ||
    !('range' in leaf.clause)
  )
    return null;

  const releaseDigest = admission.releaseDigest;
  const meaning = { release: admission.release, releaseDigest, leaf: leaf.clause };
  const route = routeOf(actor.accountId)!;
  const limit = options.limit ?? 20;
  const clock = deps.clock ?? systemClock;
  const standardBinding = builtinMemberCursorBinding(actor, collectionId, limit, {
    filter: admission.filter,
    releaseDigest,
  });
  const binding = { ...standardBinding, query: { ...standardBinding.query, source: 'private_builtin_direct' } };
  const cursor = options.cursor == null ? null : await decodeListCursor(deps.tokens, binding, options.cursor, clock());
  // A cursor from the existing prepared Source belongs to that reader.
  if (cursor && !cursor.ok) return null;
  if (
    cursor &&
    (!cursor.ok ||
      cursor.after.length !== 4 ||
      cursor.after.some((key) => typeof key !== 'string') ||
      routeOf(String(cursor.after[3])) === null)
  )
    throw new ProblemError('invalid_cursor');

  const sourceKey = libraryScopeSourceKey(
    { route, collectionId, incarnation: collectionId + ':everything', scope: 'private_builtin' },
    { accountId: actor.accountId },
  );
  const onPage = <T>(operation: () => Promise<T>) =>
    ledger.physical.withinAllowance(ledger.sourceAllowance(), () =>
      instrumentNativeCollectionWork(deps.pool, ledger.physical, nativeCollectionFootprint, operation),
    );
  async function population(at: AuthoritativeTime, take: number) {
    const values = [route, actor.accountId, collectionId, partitionOf(route), take, sourceKey];
    type EntryRow = {
      version: string;
      epoch: number;
      accountTuple: string;
      accountVersion: string;
      generation: string;
      capture: string;
      revision: string;
      id: string | null;
      explicit: boolean;
      kind: GrantedAccount['kind'];
      state: GrantedAccount['state'];
      fenced: boolean;
      floor: string;

      releaseDigest: string | null;
      releaseHead: number | null;
    };
    const gated = await withCollectionReadConnection(
      deps.pool,
      deadline,
      async (client) =>
        (
          await client.query<EntryRow & { groupOpen: boolean; gateHome: boolean }>(openEverythingEntryWindowSQL(), [
            ...values,
            ...collectionsOpeningValues(authoritativeTimeValue(at)),
          ])
        ).rows,
    );
    const gate = gated[0];
    if (!gate || !gate.gateHome) throw new ProblemError('partition_unavailable');
    let rows: EntryRow[] = gated;
    if (
      !decideExposure({
        exposure: { kind: 'gate', group: 'collections' },
        open: gate.groupOpen,
        actor: actor.kind,
        clientScope: actor.scopes.includes('collection:read'),
        gateAuthority: false,
      }).allowed
    ) {
      try {
        await admitGroup({
          pool: deps.pool,
          access: () => accessRoot(deps.access),
          actor,
          group: 'collections',
          clientAction: 'collection:read',
          clock,
          deadline,
        });
      } catch (error) {
        if (error instanceof PlatformClosedError) throw new ProblemError('not_found');
        throw error;
      }
      rows = await withCollectionReadConnection(
        deps.pool,
        deadline,
        async (client) => (await client.query<EntryRow>(everythingEntryWindowSQL(), values)).rows,
      );
    }
    const head = rows[0];
    if (!head || head.version === null) return null;
    if (head.releaseHead === null || head.releaseDigest !== releaseDigest) throw changed();
    if (
      !grantCapable(
        {
          route,
          accountId: actor.accountId,
          kind: head.kind,
          state: head.state,
          fenced: head.fenced,
          minimumAuthnEpoch: BigInt(head.floor),
        },
        actor,
      )
    )
      throw new ProblemError('not_found');
    const stamp = {
      epoch: head.epoch,
      version: head.version,
      accountTuple: head.accountTuple,
      accountVersion: head.accountVersion,
      generation: head.generation,
      capture: head.capture,
      revision: head.revision,
      releaseHead: head.releaseHead,
    };
    const ids: string[] = [];
    if (!take) return { stamp, ids };
    // A full window still has an unexamined suffix. Other fact shapes use the general reader.
    if (rows.length >= take || !head.id) return null;
    for (const row of rows) {
      if (!row.id || !row.explicit || routeOf(row.id) === null || (ids.length && row.id <= ids.at(-1)!)) return null;
      ids.push(row.id);
    }
    return { stamp, ids };
  }

  async function atReadTime<T>(operation: (at: AuthoritativeTime) => Promise<T>) {
    const at = await onPage(() =>
      withCompiledCommandControls(deps.pool, () =>
        withCollectionReadConnection(deps.pool, deadline, (client) => mintReadTime(client, clock, deps.pool)),
      ),
    );
    try {
      return await operation(at);
    } finally {
      releaseOperationalTime(at);
    }
  }
  const disclosure = { ...deps, actor, routeKey, deadline };
  const scalarDeps = { ...disclosure, work: ledger.physical, ownerId: actor.accountId };
  const observation = await atReadTime(async (at) => {
    const first = await onPage(() => population(at, 2 * limit + 1));
    if (!first) return null;
    const ids: string[] = [];
    const batches = [];
    for (let offset = 0; offset < first.ids.length; offset += LIBRARY_SUBJECT_PAGE_LIMIT) {
      const originals = first.ids.slice(offset, offset + LIBRARY_SUBJECT_PAGE_LIMIT);
      const batch = await ledger.physical.withinAllowance(ledger.sourceAllowance(), () =>
        observePreparedScalarRange(scalarDeps, originals, meaning, at),
      );
      if (batch.status !== 'complete') {
        if (cursor?.ok) throw unready('scalar-selection');
        return null;
      }
      batches.push(batch);
      for (const [i, decision] of batch.decisions.entries()) if (decision.matches) ids.push(originals[i]!);
    }
    return { first: first.stamp, ids, batches, basis: digest([first.stamp, batches.map((batch) => batch.basis)]) };
  });
  if (!observation) {
    if (cursor?.ok) throw changed();
    return null;
  }
  const { first, ids, batches, basis } = observation;
  if (
    cursor?.ok &&
    (cursor.epoch !== first.epoch ||
      cursor.after[0] !== collectionId ||
      cursor.after[1] !== basis ||
      cursor.after[2] !== first.version ||
      !ids.includes(String(cursor.after[3])))
  )
    throw changed();
  const after = cursor?.ok ? String(cursor.after[3]) : null;
  const remaining = ids.filter((id) => after === null || id > after);
  const shown = remaining.slice(0, limit).map((subjectId) => ({ kind: 'dynamic' as const, subjectId }));
  const revalidateViewer = options.view === 'FULL' ? await options.readViewerFacts?.(shown) : undefined;
  const revalidate = async () => {
    await revalidateViewer?.();
    await atReadTime(async (fresh) => {
      for (const batch of batches) {
        if (!(await ledger.physical.withinAllowance(ledger.sourceAllowance(), () => batch.revalidate(fresh))))
          throw changed();
      }
      if (!isDeepStrictEqual((await onPage(() => population(fresh, 0)))?.stamp, first)) throw changed();
    });
  };
  let members = shown;
  if (options.view === 'FULL') {
    try {
      members = await attachCollectionListFacts(disclosure, shown, {
        ...(options.languages ? { languages: options.languages } : {}),
        revalidate,
      });
    } catch (error) {
      if (error instanceof ProblemError && error.code === 'semantic_not_ready') reportUnready('list-facts');
      throw error;
    }
  } else await revalidate();
  if (members.length !== shown.length) throw unready('presented-members');
  return listMemberPage(
    members,
    deps.tokens,
    binding,
    remaining.length > limit
      ? { epoch: first.epoch, after: [collectionId, basis, first.version, shown.at(-1)!.subjectId] }
      : null,
    clock,
  );
}
