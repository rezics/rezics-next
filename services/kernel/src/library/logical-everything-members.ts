import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import canonicalize from 'canonicalize';
import { systemClock } from '../clock.ts';
import { mintReadTime, releaseOperationalTime } from '../command/command.ts';
import { ProblemError } from '../http/problem-error.ts';
import type { AccountActor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { activeRelease } from '../semantic/definitions.ts';
import { readCataloguePointEvidence } from '../semantic/scope-leaf-evidence.ts';
import { readSubjectSummaryObservation } from '../semantic/summaries.ts';
import { decodeListCursor } from '../tokens/list-cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { PlatformClosedError } from '../access/contract/errors.ts';
import { accessRoot, admitGroup } from './access-port.ts';
import { mapPresentationBounded } from './application/presentation-bounds.ts';
import { builtinCollectionId } from './builtin-identity.ts';
import { attachCollectionListFacts } from './collection-list-facts.ts';
import type { PresentationDependencies } from './collection-presentation.ts';
import { withCollectionReadConnection, withCollectionReadSnapshot } from './collection-read-connection.ts';
import { requireLibraryPresentation } from './domain-binding.ts';
import { builtinMemberCursorBinding } from './owner-index-members.ts';
import { readOwnerFactPresence } from './owner-index.ts';
import { listMemberPage } from './member-viewer-currentness.ts';
import { readNativeCollectionMemberAdmission } from './owner-filter-admission.ts';
import {
  matchOwnerFilterCatalogue,
  type CollectionMemberAdmission,
  type CollectionMemberQuery,
} from './owner-filter.ts';

const digest = (value: unknown) => createHash('sha256').update(canonicalize(value)!).digest('hex');
// Each of at most two entry windows admits one scalar selection and its real Subject authority per original.
// The Access-key ceiling also covers the native account membership-inverse lookup, independently of statement keys.
const rangeWork = Object.freeze({
  keys: 32,
  witnesses: 16,
  points: 256,
  rows: 2048,
  emptySeeks: 128,
  bytes: 64 * 1024,
});
const authorityWork = Object.freeze({
  keys: 4096,
  witnesses: 100,
  points: 4096,
  rows: 65536,
  emptySeeks: 256,
  bytes: 1024 * 1024,
});
const changed = () => new ProblemError('stale_cursor');
const unready = () => new ProblemError('semantic_not_ready');

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
  options: CollectionMemberQuery,
  deadline: number,
) {
  const routeKey = deps.routeKey;
  if (!routeKey || collectionId !== builtinCollectionId(actor.accountId, { kind: 'everything' })) return null;
  if (admission) {
    const admitted = readNativeCollectionMemberAdmission(admission);
    if (!admitted || admitted.pool !== deps.pool || admitted.actor !== actor || admitted.deadline < deadline)
      throw unready();
  }
  const leaf = admission?.plan?.leaves[0];
  if (
    admission?.plan &&
    (!admission.filter ||
      !('statement' in admission.filter) ||
      leaf?.kind !== 'catalogue' ||
      leaf.clause.facet !== 'statement' ||
      !('range' in leaf.clause))
  )
    return null;

  const route = routeOf(actor.accountId)!;
  const limit = options.limit ?? 20;
  const clock = deps.clock ?? systemClock;
  const binding = builtinMemberCursorBinding(
    actor,
    collectionId,
    limit,
    admission?.filter && admission.releaseDigest
      ? { filter: admission.filter, releaseDigest: admission.releaseDigest }
      : undefined,
  );
  const cursor = options.cursor == null ? null : await decodeListCursor(deps.tokens, binding, options.cursor, clock());
  if (
    cursor &&
    (!cursor.ok ||
      cursor.after.length !== 4 ||
      cursor.after.some((key) => typeof key !== 'string') ||
      routeOf(String(cursor.after[3])) === null)
  )
    throw new ProblemError('invalid_cursor');

  const owner = requireLibraryPresentation();
  async function population() {
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
    return withCollectionReadSnapshot(deps.pool, deadline, async (client) => {
      if (!(await owner.admitOwner(client, actor))) throw new ProblemError('not_found');
      const presence = await readOwnerFactPresence(client, actor.accountId);
      if (!presence.entry || presence.personal || presence.copy || presence.session || presence.label) return null;
      const {
        rows: [head],
      } = await client.query<{ epoch: number; position: string; version: string; n: string }>(
        `SELECT partition.epoch, partition.position::text, facts.generation::text AS version, counts.n::text AS n
         FROM library.fact_source_head facts
         JOIN core.partition partition ON partition.partition_no=$4 AND partition.write_state<>'moved'
         JOIN library.owner_index_control idx USING (route,account_id)
         JOIN library.shelf_maintenance shelf USING (route,account_id)
         JOIN library.shelf_count counts ON (counts.route,counts.account_id,counts.generation_id)=
           (shelf.route,shelf.account_id,shelf.active_generation)
         WHERE facts.route=$1 AND facts.account_id=$2 AND idx.phase='ready' AND shelf.initialized AND shelf.ready AND shelf.mode='open'
           AND counts.bucket='all' AND counts.type_id='00000000-0000-0000-0000-000000000000'
           AND counts.n BETWEEN 1 AND $5
           AND NOT EXISTS (SELECT 1 FROM library.collection WHERE route=$1 AND collection_id=$3)
           AND NOT EXISTS (SELECT 1 FROM library.owner_index_pin WHERE route=$1 AND account_id=$2 AND NOT meaning_ready)
           AND NOT EXISTS (SELECT 1 FROM library.entry_clear WHERE route=$1 AND account_id=$2)`,
        [route, actor.accountId, collectionId, partitionOf(route), 2 * limit],
      );
      if (!head) return null;
      const ids: string[] = [];
      const count = Number(head.n);
      // An exact multiple also needs its native EOF point; the count alone never proves coverage.
      while (ids.length <= count) {
        const take = Math.min(100, count + 1 - ids.length);
        const after = ids.at(-1);
        const rows = (
          await client.query<{ id: string }>(
            after === undefined
              ? 'SELECT subject_id AS id FROM library.entry WHERE route=$1 AND account_id=$2 ORDER BY subject_id LIMIT $3'
              : 'SELECT subject_id AS id FROM library.entry WHERE route=$1 AND account_id=$2 AND subject_id>$4 ORDER BY subject_id LIMIT $3',
            after === undefined ? [route, actor.accountId, take] : [route, actor.accountId, take, after],
          )
        ).rows;
        ids.push(...rows.map((row) => row.id));
        if (rows.length < take) break;
      }
      if (ids.length !== count) throw unready();
      return { epoch: head.epoch, position: head.position, version: head.version, ids };
    });
  }

  const first = await population();
  if (!first) {
    if (cursor?.ok && cursor.after[0] === collectionId) throw changed();
    return null;
  }
  const disclosure = { ...deps, actor, routeKey, deadline };
  const { ids, version, epoch } = first;
  async function mappingEpochs() {
    const mappings = [];
    for (let offset = 0; offset < ids.length; offset += 100) {
      const originals = ids.slice(offset, offset + 100);
      const current = await owner.readMappings(deps.pool, originals);
      if (current.length !== originals.length) throw unready();
      for (const [i, mapping] of current.entries()) {
        // The entry index proves canonical order only for this complete self-mapped population.
        if (mapping.state !== 'mapped' || mapping.original !== originals[i] || mapping.terminal !== originals[i])
          throw unready();
        mappings.push(mapping.epoch.toString());
      }
    }
    return mappings;
  }
  async function meaningHead() {
    if (!admission?.filter) return null;
    const release = await activeRelease(deps.pool, 'native');
    if (!release || release.digest !== admission.releaseDigest) throw changed();
    return release.head;
  }
  const mappings = await mappingEpochs();
  const head = await meaningHead();
  async function observe() {
    const subjects = await readSubjectSummaryObservation(disclosure, ids);
    const at = await withCollectionReadConnection(deps.pool, deadline, (client) => mintReadTime(client, clock));
    try {
      const rows = await mapPresentationBounded(ids, async (id) => {
        if (subjects.summaries.get(id)?.id !== id) return { id, visible: false, matches: false };
        if (!leaf || leaf.kind !== 'catalogue') return { id, visible: true, matches: true };
        const { evidence } = await readCataloguePointEvidence(
          deps.pool,
          {
            subject: id,
            leaf: leaf.clause,
            after: null,
            revalidate: null,
            budget: rangeWork,
          },
          { ...disclosure, nativeT: at },
          authorityWork,
        );
        if (evidence.state !== 'current' || evidence.progress || evidence.coverage?.basis !== evidence.basis)
          throw unready();
        const matches = matchOwnerFilterCatalogue(leaf, evidence);
        if (typeof matches !== 'boolean') throw unready();
        return { id, visible: true, matches, evidence: digest([evidence.basis, evidence.facts]) };
      });
      if (!(await subjects.current())) throw unready();
      return {
        ids: rows.filter((row) => row.matches).map((row) => row.id),
        basis: digest([version, epoch, head, mappings, rows]),
      };
    } finally {
      releaseOperationalTime(at);
    }
  }
  const observed = await observe();
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
  const revalidate = async () => {
    if (
      (await observe()).basis !== observed.basis ||
      !isDeepStrictEqual(await mappingEpochs(), mappings) ||
      (await meaningHead()) !== head ||
      !isDeepStrictEqual(await population(), first)
    )
      throw changed();
  };
  let members = shown;
  if (options.view === 'FULL') {
    members = await attachCollectionListFacts(disclosure, shown, {
      ...(options.languages ? { languages: options.languages } : {}),
      revalidate,
    });
  } else await revalidate();
  if (members.length !== shown.length) throw unready();
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
