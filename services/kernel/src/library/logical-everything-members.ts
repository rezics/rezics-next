import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import canonicalize from 'canonicalize';
import { systemClock } from '../clock.ts';
import { mintReadTime, releaseOperationalTime, type AuthoritativeTime } from '../command/command.ts';
import type { ReadMemberViewerFacts } from './contract/builtin-presentation.ts';
import { ProblemError } from '../http/problem-error.ts';
import type { AccountActor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { decideExposure } from '@rezics/access';
import { readEverythingFilterTuple } from './logical-everything-filter.ts';
import { observeEverythingPairs } from './logical-everything-window.ts';
import type { ownerQueryWork } from './builtin-runtime-query.ts';
import { decodeListCursor } from '../tokens/list-cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { PlatformClosedError } from '../access/contract/errors.ts';
import { accessRoot, admitGroup } from './access-port.ts';
import { mapPresentationBounded } from './application/presentation-bounds.ts';
import { builtinCollectionId } from './builtin-identity.ts';
import { attachCollectionListFacts } from './collection-list-facts.ts';
import type { PresentationDependencies } from './collection-presentation.ts';
import { withCollectionReadConnection } from './collection-read-connection.ts';
import { requireLibraryPresentation } from './domain-binding.ts';
import { builtinMemberCursorBinding } from './owner-index-members.ts';
import { WORK_AXES, zeroWorkDimensions } from './core/index.ts';
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
type ObservationPhase = 'initial' | 'revalidation';
type ReadinessStage =
  | 'admission'
  | 'entry-coverage'
  | 'identity-coverage'
  | 'identity-mapping'
  | `${ObservationPhase}-point`
  | `${ObservationPhase}-subject-currentness`
  | 'list-facts'
  | 'presented-members';

/**
 * Direct id-order plan for a revision-zero Everything whose entire native population is explicit entries.
 * The writer's current shelf count admits two bounded entry windows before any enumeration. Other fact
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
  const rangeLeaf = leaf;
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

  const owner = requireLibraryPresentation();
  const onPage = <T>(operation: () => Promise<T>) =>
    ledger.physical.withinAllowance(ledger.sourceAllowance(), () =>
      instrumentNativeCollectionWork(deps.pool, ledger.physical, nativeCollectionFootprint, operation),
    );
  async function population() {
    const values = [route, actor.accountId, collectionId, partitionOf(route), 2 * limit];
    type EntryRow = {
      version: string;
      epoch: number;
      position: string;
      n: number;
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
            ...collectionsOpeningValues(clock().toISOString()),
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
    const ids: string[] = [];
    for (const row of rows) {
      if (!row.id || !row.explicit || routeOf(row.id) === null || (ids.length && row.id <= ids.at(-1)!))
        throw unready('entry-coverage');
      ids.push(row.id);
    }
    if (ids.length !== head.n) throw unready('entry-coverage');
    return {
      epoch: head.epoch,
      position: head.position,
      version: head.version,
      head: head.releaseHead,
      ids,
    };
  }

  const first = await onPage(population);
  if (!first) {
    if (cursor?.ok && cursor.after[0] === collectionId) throw changed();
    return null;
  }
  const disclosure = { ...deps, actor, routeKey, deadline };
  const { ids, version, epoch } = first;
  // Count both mapping passes before allocating the first. A prepared Source may still be able
  // to serve its own cursor from the remaining page work, without an entry mapping walk.
  const available = ledger.sourceAllowance().remaining;
  const mappingCost = { ...zeroWorkDimensions() };
  for (let offset = 0; offset < ids.length; offset += 100) {
    const cost = owner.semanticObservations.canonical.mappingWork(ids.slice(offset, offset + 100));
    for (const axis of WORK_AXES) mappingCost[axis] += 2 * cost[axis];
  }
  if (WORK_AXES.some((axis) => mappingCost[axis] > available[axis])) {
    if (cursor?.ok) throw unready('identity-coverage', 'work-budget');
    return null;
  }
  async function mappingEpochs() {
    const mappings = [];
    for (let offset = 0; offset < ids.length; offset += 100) {
      const originals = ids.slice(offset, offset + 100);
      const reserved = ledger.physical.reserve(owner.semanticObservations.canonical.mappingWork(originals));
      reserved.dispatch();
      const current = await owner.readMappings(deps.pool, originals).finally(() => reserved.settle());
      if (current.length !== originals.length) throw unready('identity-coverage');
      for (const [i, mapping] of current.entries()) {
        // The entry index proves canonical order only for this complete self-mapped population.
        if (mapping.state !== 'mapped' || mapping.original !== originals[i] || mapping.terminal !== originals[i])
          throw unready('identity-mapping');
        mappings.push(mapping.epoch.toString());
      }
    }
    return mappings;
  }
  const mappings = await ledger.physical.withinAllowance(ledger.sourceAllowance(), mappingEpochs);
  const head = first.head;
  const batchDeps = { ...disclosure, work: ledger.physical };
  const pairs = ids.map((original) => ({ original, terminal: original }));
  const readTime = () =>
    onPage(() => withCollectionReadConnection(deps.pool, deadline, (client) => mintReadTime(client, clock)));
  async function atReadTime<T>(operation: (at: AuthoritativeTime) => Promise<T>) {
    const at = await readTime();
    try {
      return await operation(at);
    } finally {
      releaseOperationalTime(at);
    }
  }
  type Subjects = Awaited<ReturnType<typeof observeEverythingPairs>>;
  async function observe(subjects: Subjects, phase: ObservationPhase, at: AuthoritativeTime) {
    const rows = await mapPresentationBounded(subjects.decisions, async (decision) => {
      const id = decision.original;
      if (decision.state === 'withheld') return { id, visible: false, matches: false };
      return readEverythingFilterTuple(disclosure, at, id, rangeLeaf, (reason) =>
        reportUnready(`${phase}-point`, reason),
      );
    });
    return {
      ids: rows.filter((row) => row.matches).map((row) => row.id),
      basis: digest([version, epoch, head, mappings, rows]),
    };
  }
  const { subjects, observed } = await atReadTime(async (at) => {
    let subjects: Subjects;
    try {
      subjects = await ledger.physical.withinAllowance(ledger.sourceAllowance(), () =>
        observeEverythingPairs(batchDeps, pairs, at),
      );
    } catch (error) {
      reportUnready('initial-subject-currentness', error instanceof ProblemError ? error.code : undefined);
      throw error;
    }
    return { subjects, observed: await onPage(() => observe(subjects, 'initial', at)) };
  });
  if (
    cursor?.ok &&
    (cursor.epoch !== first.epoch ||
      cursor.after[0] !== collectionId ||
      cursor.after[1] !== observed.basis ||
      cursor.after[2] !== first.version ||
      !observed.ids.includes(String(cursor.after[3])))
  )
    throw changed();
  const after = cursor?.ok ? String(cursor.after[3]) : null;
  const remaining = observed.ids.filter((id) => after === null || id > after);
  const shown = remaining.slice(0, limit).map((subjectId) => ({ kind: 'dynamic' as const, subjectId }));
  const revalidateViewer = options.view === 'FULL' ? await options.readViewerFacts?.(shown) : undefined;
  const revalidate = async () => {
    if (
      (await atReadTime((at) => onPage(() => observe(subjects, 'revalidation', at)))).basis !== observed.basis ||
      !isDeepStrictEqual(await ledger.physical.withinAllowance(ledger.sourceAllowance(), mappingEpochs), mappings) ||
      !isDeepStrictEqual(await onPage(population), first)
    )
      throw changed();
    await revalidateViewer?.();
    const fresh = await readTime();
    try {
      await ledger.physical.withinAllowance(ledger.sourceAllowance(), () => subjects.revalidate(fresh));
    } catch (error) {
      reportUnready('revalidation-subject-currentness', error instanceof ProblemError ? error.code : undefined);
      throw error;
    } finally {
      releaseOperationalTime(fresh);
    }
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
      ? { epoch: first.epoch, after: [collectionId, observed.basis, first.version, shown.at(-1)!.subjectId] }
      : null,
    clock,
  );
}
