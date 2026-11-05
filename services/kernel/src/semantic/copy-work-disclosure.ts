import type { Release } from '@rezics/definitions';
import { deadlineClient, within } from '../access/authenticate.ts';
import { AccessUnavailableError, classifyUnavailability, requireAccessDeadline } from '../access/unavailable.ts';
import { readFences, type SourceFenceTuple } from '../content/source-fences.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { partitionReadClients } from '../database/read-snapshot.ts';
import { readPartition, readPartitions } from '../partition/partition.ts';
import { accessCheck, type AccessCheck, type AccessClient } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { validateHitOptions } from '../search/hits.ts';
import {
  COPY_WORK_DISCLOSURE_LOOKAHEAD,
  COPY_WORK_DISCLOSURE_MAX_RAW,
  COPY_WORK_DISCLOSURE_MAX_WORKS,
  COPY_WORK_PROPERTY,
  type CopyWorkDisclosureDependencies,
  type CopyWorkDisclosureObservation,
  type CopyWorkDisclosureRequest,
  type CopyWorkDisclosureState,
  type CopyWorkReference,
} from './copy-work-disclosure-contract.ts';
import readCopyWorkLocators from './copy-work-disclosure.sql';
import { currentRelationFacts, currentRelationKey, type CurrentRelationCandidate } from './current-relations.ts';
import { activeRelease } from './definitions.ts';
import { relatedReadEligibility, subjectReadEligibility } from './eligibility.ts';
import { candidateSources, fenceKey, sourceTuple } from './fences.ts';
import { readIdentityMappings } from './identity-adapters/identity-epoch-read.ts';
import { isRelationProperty } from './item.ts';
import subjectsSQL from './list-presentation-subjects.sql';
import { withReadTransaction } from './read.ts';
import { readSubjectSummaryObservation, type SubjectSummary, type SubjectSummaryObservation } from './summaries.ts';

export type {
  CopyWorkDisclosureDependencies,
  CopyWorkDisclosureObservation,
  CopyWorkDisclosureRequest,
  CopyWorkDisclosureState,
  CopyWorkReference,
} from './copy-work-disclosure-contract.ts';
export {
  COPY_WORK_DISCLOSURE_LOOKAHEAD,
  COPY_WORK_DISCLOSURE_MAX_RAW,
  COPY_WORK_DISCLOSURE_MAX_WORKS,
  COPY_WORK_PROPERTY,
} from './copy-work-disclosure-contract.ts';

type Header = {
  id: string;
  type: string;
  visibility: string;
  security: string;
  release: string | null;
  revision: number | null;
  source_epoch: number | null;
  source_position: string | null;
  redirect: string | null;
};
type Locator = {
  id: string;
  property: string;
  slot: string;
  candidate: string;
  order_key: string;
  source_revision: number;
  source_security_revision: string;
};
type Membership = { kind: 'works'; ids: string[] } | { kind: 'concealed' } | { kind: 'overflow' };
type SourceObservation = { header: Header; allowed: boolean; membership: Membership | null };
type PartitionCut = { partition: number; epoch: number; position: bigint };
type SourcePlan = { original: string; terminal: string; home: number };

const withheld: CopyWorkDisclosureState = { state: 'withheld' };
const missing: CopyWorkDisclosureState = { state: 'missing' };
const unavailable: CopyWorkDisclosureState = { state: 'unavailable' };
const denied: CopyWorkDisclosureState = { state: 'denied' };
const scoped: CopyWorkDisclosureState = { state: 'scope' };
const unsupported: CopyWorkDisclosureState = { state: 'unsupported' };
const emptyAvailable: CopyWorkDisclosureState = { state: 'available', works: [] };
const json = (value: unknown) =>
  JSON.stringify(value, (_key, entry) => (typeof entry === 'bigint' ? entry.toString() : entry));

function isType(release: Pick<Release, 'types'>, type: string, target: string, seen = new Set<string>()): boolean {
  if (type === target) return true;
  if (seen.has(type)) return false;
  seen.add(type);
  return (release.types[type]?.bases ?? []).some((base) => isType(release, base, target, seen));
}

function groups(ids: readonly string[]) {
  const result = new Map<number, string[]>();
  for (const id of ids) {
    const route = routeOf(id);
    if (route === null) continue;
    const home = partitionOf(route);
    const list = result.get(home) ?? [];
    list.push(id);
    result.set(home, list);
  }
  return result;
}

function sameCut(left: PartitionCut, right: PartitionCut) {
  return left.epoch === right.epoch && left.position === right.position;
}

/** Distinct homes only. Two positions for one home is a mixed old/new assembly. */
function collectCuts(cuts: readonly PartitionCut[]): PartitionCut[] | null {
  const byHome = new Map<number, PartitionCut>();
  for (const cut of cuts) {
    const previous = byHome.get(cut.partition);
    if (previous && !sameCut(previous, cut)) return null;
    byHome.set(cut.partition, cut);
  }
  return [...byHome.values()];
}

function mappingKey(mapping: Awaited<ReturnType<typeof readIdentityMappings>>[number] | undefined) {
  return json(mapping ?? null);
}

function admittedCopyWork(release: Release, type: string): 'admitted' | 'scope' | 'unsupported' {
  const definition = release.types[type];
  if (!definition) return 'scope';
  if (!definition.properties.includes(COPY_WORK_PROPERTY)) return 'scope';
  const property = release.properties[COPY_WORK_PROPERTY];
  if (
    !property ||
    property.datatype !== 'wikibase-item' ||
    !isRelationProperty(release, COPY_WORK_PROPERTY) ||
    property.relation?.group !== 'derivation' ||
    !(property.targets ?? []).some(
      (target) => isType(release, 'schema:CreativeWork', target) || isType(release, target, 'schema:CreativeWork'),
    )
  )
    return 'unsupported';
  return 'admitted';
}

function selectedLabels(summary: SubjectSummary): Record<string, string> {
  return summary.label ? { [summary.label.language]: summary.label.value } : {};
}

function factContent(body: unknown): string | null {
  const value = (body as { value?: { type?: unknown; content?: unknown } } | undefined)?.value;
  return value?.type === 'value' && typeof value.content === 'string' ? value.content : null;
}

/** Each native home is released before Access preparation or any foreign home. */
async function snapshot<T>(
  deps: CopyWorkDisclosureDependencies,
  home: number,
  work: (client: AccessClient, position: bigint, epoch: number) => Promise<T>,
): Promise<{ value: T; cut: PartitionCut }> {
  return within(deps.deadline, () =>
    withConnection(deps.pool, async (connection) => {
      const client = deadlineClient(connection, deps.deadline);
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const partition = await readPartition(client, home);
        if (!partition || partition.writeState !== 'active') throw new AccessUnavailableError('contention');
        const value = await work(client, partition.position, partition.epoch);
        requireAccessDeadline(deps.deadline);
        await client.query('COMMIT');
        return { value, cut: { partition: home, epoch: partition.epoch, position: partition.position } };
      } catch (error) {
        try {
          await connection.query('ROLLBACK');
        } catch (rollbackError) {
          discardConnection(connection, rollbackError as Error);
        }
        throw error;
      }
    }),
  );
}

async function mapIdentities(deps: CopyWorkDisclosureDependencies, ids: readonly string[]) {
  const result = new Map<string, Awaited<ReturnType<typeof readIdentityMappings>>[number]>();
  for (let offset = 0; offset < ids.length; offset += 100) {
    const batch = ids.slice(offset, offset + 100);
    const mappings = await readIdentityMappings(deps.pool, batch);
    batch.forEach((id, index) => result.set(id, mappings[index]!));
  }
  return result;
}

async function prepareChecks(deps: CopyWorkDisclosureDependencies, ids: readonly string[]) {
  const checks = new Map<string, AccessCheck>();
  for (const id of ids) {
    if (checks.has(id)) continue;
    const route = routeOf(id);
    if (route === null) continue;
    checks.set(
      id,
      await accessCheck(
        deps.access,
        deps.actor,
        'subject:read',
        { route, id, eligibility: subjectReadEligibility({ route, id }) },
        { pool: deps.pool, deadline: deps.deadline },
      ),
    );
  }
  return checks;
}

async function observeHome(
  deps: CopyWorkDisclosureDependencies,
  release: Release,
  home: number,
  ids: readonly string[],
  checks: ReadonlyMap<string, AccessCheck>,
): Promise<{
  found: Map<string, SourceObservation>;
  tuples: SourceFenceTuple[];
  owners: string[];
  cut: PartitionCut;
}> {
  const observed = await snapshot(deps, home, async (client, _position, epoch) => {
    const headers = new Map(
      (await client.query<Header>(subjectsSQL.sql, [ids.map((id) => routeOf(id)!), ids])).rows.map(
        (row) => [row.id, row] as const,
      ),
    );
    const found = new Map<string, SourceObservation>();
    const visible: string[] = [];
    for (const id of ids) {
      const header = headers.get(id);
      if (!header) continue;
      const check = checks.get(id);
      const allowed = check ? await check(client) : false;
      found.set(id, { header, allowed, membership: null });
      if (header.visibility !== 'visible' || !allowed) continue;
      // A redirect on the observed terminal is unpublished mapping, not hidden membership.
      if (header.redirect) continue;
      if (admittedCopyWork(release, header.type) !== 'admitted') continue;
      if (header.revision === null || header.release === null) throw new AccessUnavailableError('contention');
      visible.push(id);
    }
    if (!visible.length) return { found, tuples: [] as SourceFenceTuple[], owners: [] as string[] };
    const checkpoint = (
      await client.query<{ epoch: number; position: string }>(
        'SELECT epoch, position::text FROM core.consumer_checkpoint WHERE partition_no=$1 AND consumer=$2',
        [home, 'semantic_links'],
      )
    ).rows[0];
    if (!checkpoint || checkpoint.epoch !== epoch) throw new AccessUnavailableError('contention');
    for (const id of visible) {
      const header = found.get(id)!.header;
      if (
        header.source_epoch === null ||
        header.source_position === null ||
        header.source_epoch !== epoch ||
        BigInt(checkpoint.position) < BigInt(header.source_position)
      )
        throw new AccessUnavailableError('contention');
    }
    const locators = (
      await client.query<Locator>(readCopyWorkLocators.sql, [
        json(visible.map((id) => ({ route: routeOf(id)!, id, property: COPY_WORK_PROPERTY }))),
        COPY_WORK_DISCLOSURE_LOOKAHEAD,
      ])
    ).rows;
    for (const locator of locators) {
      const header = found.get(locator.id)!.header;
      if (locator.source_revision !== header.revision || locator.source_security_revision !== header.security)
        throw new AccessUnavailableError('contention');
    }
    const bySource = new Map<string, Locator[]>();
    for (const locator of locators) {
      const list = bySource.get(locator.id) ?? [];
      list.push(locator);
      bySource.set(locator.id, list);
    }
    const candidates: CurrentRelationCandidate[] = [];
    for (const id of visible) {
      const group = bySource.get(id) ?? [];
      if (group.length >= COPY_WORK_DISCLOSURE_LOOKAHEAD) {
        found.get(id)!.membership = { kind: 'overflow' };
        continue;
      }
      if (!group.length) {
        found.get(id)!.membership = { kind: 'works', ids: [] };
        continue;
      }
      for (const locator of group)
        candidates.push({
          subject: id,
          property: COPY_WORK_PROPERTY,
          candidate: locator.candidate,
          target: null,
          value: 'value',
          slot: locator.slot,
          requireRelation: true,
        });
    }
    const facts = candidates.length
      ? await currentRelationFacts(client, deps.routeKey, candidates, { sourceFences: 'caller' })
      : new Map();
    const provenance: { route: number; subject_id: string; candidate_id: string; slot_id?: string }[] = [];
    for (const id of visible) {
      if (found.get(id)!.membership) continue;
      const group = bySource.get(id) ?? [];
      const works: string[] = [];
      let concealed = false;
      for (const locator of group) {
        const fact = facts.get(
          currentRelationKey({ subject: id, property: COPY_WORK_PROPERTY, candidate: locator.candidate }),
        );
        const content = fact ? factContent(fact.body) : null;
        if (!content || routeOf(content) === null) {
          concealed = true;
          continue;
        }
        provenance.push({
          route: routeOf(id)!,
          subject_id: id,
          candidate_id: locator.candidate,
          slot_id: locator.slot,
        });
        if (!works.includes(content)) works.push(content);
      }
      found.get(id)!.membership = concealed ? { kind: 'concealed' } : { kind: 'works', ids: works };
    }
    const recorded = provenance.length ? await candidateSources(client, provenance) : new Map();
    const tuples: SourceFenceTuple[] = [];
    const owners: string[] = [];
    for (const entry of provenance) {
      const source = recorded.get(`${entry.subject_id}\n${entry.candidate_id}`) ?? null;
      if (!source) {
        const row = found.get(entry.subject_id);
        if (row?.membership?.kind === 'works') row.membership = { kind: 'concealed' };
        continue;
      }
      if ('kind' in source) {
        if (source.kind !== 'agent' || routeOf(source.subject) === null) {
          const row = found.get(entry.subject_id);
          if (row?.membership?.kind === 'works') row.membership = { kind: 'concealed' };
        }
        continue;
      }
      try {
        tuples.push(sourceTuple(deps.routeKey, source));
        owners.push(entry.subject_id);
      } catch {
        const row = found.get(entry.subject_id);
        if (row?.membership?.kind === 'works') row.membership = { kind: 'concealed' };
      }
    }
    return { found, tuples, owners };
  });
  return { ...observed.value, cut: observed.cut };
}

async function readSummaries(
  deps: CopyWorkDisclosureDependencies,
  ids: readonly string[],
  options: { languages: readonly string[] },
) {
  const summaries = new Map<string, SubjectSummary | null>();
  const components: SubjectSummaryObservation['components'][number][] = [];
  for (let offset = 0; offset < ids.length; offset += 256) {
    const batch = ids.slice(offset, offset + 256);
    const observed = await readSubjectSummaryObservation(deps, batch, options);
    for (const [id, summary] of observed.summaries) summaries.set(id, summary);
    components.push(...observed.components);
  }
  return { summaries, components };
}

/** One exported native batch: current admitted copy/release-to-work membership, never a guessed primary work. */
export async function readCopyWorkDisclosure(
  deps: CopyWorkDisclosureDependencies,
  request: CopyWorkDisclosureRequest,
): Promise<CopyWorkDisclosureObservation> {
  if (!Array.isArray(request.identities) || request.identities.some((id) => typeof id !== 'string'))
    throw new TypeError('Copy/work disclosure requires string identities');
  if (request.identities.length > COPY_WORK_DISCLOSURE_MAX_RAW)
    throw new RangeError('Copy/work disclosure accepts at most 100 raw identity inputs');
  if (!Number.isFinite(deps.deadline) || !(deps.routeKey instanceof Uint8Array) || deps.routeKey.byteLength < 32)
    throw new TypeError('Copy/work disclosure requires the trusted route key and finite request deadline');
  requireAccessDeadline(deps.deadline);
  const languages = request.languages?.length
    ? (validateHitOptions({ languages: [...request.languages] }).languages ?? [])
    : [];
  const results = new Map<string, CopyWorkDisclosureState>();
  const originals = [...new Set(request.identities)];
  for (const id of originals) if (routeOf(id) === null) results.set(id, missing);
  const routed = originals.filter((id) => routeOf(id) !== null);
  if (!routed.length)
    return {
      results,
      async current() {
        requireAccessDeadline(deps.deadline);
        return true;
      },
    };

  const classified = new Map<string, CopyWorkDisclosureState>();
  const cuts: PartitionCut[] = [];
  let releaseDigest: string | null = null;
  let releaseHead: number | null = null;

  try {
    await within(deps.deadline, async () => {
      const active = (
        await snapshot(deps, 0, async (client) => {
          const release = await activeRelease(client);
          if (!release) throw new AccessUnavailableError('contention');
          return release;
        })
      ).value;
      releaseDigest = active.digest;
      releaseHead = active.head;
      const mappings = await mapIdentities(deps, routed);
      const plans = new Map<string, SourcePlan>();
      for (const id of routed) {
        const mapping = mappings.get(id);
        if (!mapping || mapping.state === 'pending' || mapping.state === 'unavailable') classified.set(id, unavailable);
        else {
          const terminal = mapping.state === 'mapped' ? mapping.terminal : id;
          const route = routeOf(terminal);
          if (route === null) classified.set(id, missing);
          else plans.set(id, { original: id, terminal, home: partitionOf(route) });
        }
      }
      const terminals = [...new Set([...plans.values()].map((plan) => plan.terminal))];
      const checks = await prepareChecks(deps, terminals);
      const observedSources = new Map<string, SourceObservation>();
      const fenceTuples: SourceFenceTuple[] = [];
      const fencedSubjects: string[] = [];
      for (const [home, ids] of groups(terminals)) {
        const observed = await observeHome(deps, active.release, home, ids, checks);
        cuts.push(observed.cut);
        for (const [id, source] of observed.found) observedSources.set(id, source);
        fenceTuples.push(...observed.tuples);
        fencedSubjects.push(...observed.owners);
      }
      const fencesByHome = new Map<number, SourceFenceTuple[]>();
      for (const tuple of fenceTuples) {
        const home = partitionOf(tuple.route);
        const list = fencesByHome.get(home) ?? [];
        list.push(tuple);
        fencesByHome.set(home, list);
      }
      const taken = new Set<string>();
      for (const [home, tuples] of fencesByHome) {
        const unique = [...new Map(tuples.map((tuple) => [fenceKey(tuple), tuple])).values()];
        const rows = (
          await snapshot(deps, home, async (client) => {
            const found = [];
            for (let offset = 0; offset < unique.length; offset += 100)
              found.push(...(await readFences(client, unique.slice(offset, offset + 100))));
            return found;
          })
        ).value;
        for (const row of rows) if (row.takenDown) taken.add(fenceKey(row));
      }
      if (taken.size) {
        for (let index = 0; index < fenceTuples.length; index++) {
          if (!taken.has(fenceKey(fenceTuples[index]!))) continue;
          const owner = observedSources.get(fencedSubjects[index]!);
          if (owner?.membership?.kind === 'works') owner.membership = { kind: 'concealed' };
        }
      }

      const uniqueTargets = [
        ...new Set(
          [...observedSources.values()].flatMap((source) =>
            source.membership?.kind === 'works' ? source.membership.ids.filter((id) => routeOf(id) !== null) : [],
          ),
        ),
      ];
      const mappedTargets = uniqueTargets.length ? await mapIdentities(deps, uniqueTargets) : new Map();
      const terminalTargets = [
        ...new Set(
          uniqueTargets.flatMap((id) => {
            const mapping = mappedTargets.get(id);
            if (!mapping || mapping.state === 'pending' || mapping.state === 'unavailable') return [];
            return mapping.state === 'mapped' ? [mapping.terminal] : [id];
          }),
        ),
      ];
      const summaryObservation =
        terminalTargets.length > 0
          ? await readSummaries(deps, terminalTargets, { languages })
          : {
              summaries: new Map<string, SubjectSummary | null>(),
              components: [] as SubjectSummaryObservation['components'],
            };
      cuts.push(
        ...summaryObservation.components.map((component) => ({
          partition: component.partition,
          epoch: component.epoch,
          position: component.position,
        })),
      );

      for (const [original, plan] of plans) {
        if (classified.has(original)) continue;
        const source = observedSources.get(plan.terminal);
        if (!source) {
          classified.set(original, missing);
          continue;
        }
        if (!source.allowed) {
          classified.set(original, source.header.visibility === 'visible' ? denied : withheld);
          continue;
        }
        if (source.header.visibility !== 'visible') {
          classified.set(original, withheld);
          continue;
        }
        const admission = admittedCopyWork(active.release, source.header.type);
        if (admission === 'scope') {
          classified.set(original, scoped);
          continue;
        }
        if (admission === 'unsupported') {
          classified.set(original, unsupported);
          continue;
        }
        const membership = source.membership;
        if (!membership) {
          classified.set(original, unavailable);
          continue;
        }
        if (membership.kind === 'overflow') {
          classified.set(original, unsupported);
          continue;
        }
        if (membership.kind === 'concealed') {
          classified.set(original, withheld);
          continue;
        }
        const works: CopyWorkReference[] = [];
        let concealed = false;
        let invalid = false;
        for (const content of membership.ids) {
          const mapping = mappedTargets.get(content);
          if (mapping?.state === 'pending' || mapping?.state === 'unavailable') {
            classified.set(original, unavailable);
            invalid = true;
            break;
          }
          const terminal = mapping?.state === 'mapped' ? mapping.terminal : content;
          const summary = summaryObservation.summaries.get(terminal);
          if (!summary) {
            concealed = true;
            continue;
          }
          if (!summary.creativeWork) {
            invalid = true;
            continue;
          }
          if (!works.some((work) => work.id === summary.id))
            works.push({ id: summary.id, labels: selectedLabels(summary) });
        }
        if (classified.get(original)?.state === 'unavailable') continue;
        if (invalid) classified.set(original, unsupported);
        else if (concealed) classified.set(original, withheld);
        else if (works.length > COPY_WORK_DISCLOSURE_MAX_WORKS) classified.set(original, unsupported);
        else classified.set(original, works.length ? { state: 'available', works } : emptyAvailable);
      }
      const remappedSources = await mapIdentities(deps, routed);
      for (const id of routed) {
        if (mappingKey(mappings.get(id)) !== mappingKey(remappedSources.get(id))) classified.set(id, unavailable);
      }
      if (uniqueTargets.length) {
        const remappedTargets = await mapIdentities(deps, uniqueTargets);
        for (const [original, plan] of plans) {
          const source = observedSources.get(plan.terminal);
          if (source?.membership?.kind !== 'works') continue;
          if (
            source.membership.ids.some(
              (id) => mappingKey(mappedTargets.get(id)) !== mappingKey(remappedTargets.get(id)),
            )
          )
            classified.set(original, unavailable);
        }
      }
    });
  } catch (error) {
    if (!(error instanceof AccessUnavailableError) && classifyUnavailability(error) === undefined) throw error;
    for (const id of routed) if (!classified.has(id) && !results.has(id)) classified.set(id, unavailable);
  }

  for (const [id, state] of classified) results.set(id, state);
  for (const id of routed) if (!results.has(id)) results.set(id, unavailable);
  const components = collectCuts(cuts);
  if (components === null) {
    for (const id of routed) results.set(id, unavailable);
    return observation(deps, results, [], releaseDigest, releaseHead);
  }
  const observed = observation(deps, results, components, releaseDigest, releaseHead);
  try {
    const membership = [...results.values()].some(
      (state) => state.state === 'available' || state.state === 'withheld' || state.state === 'unsupported',
    );
    if (membership && !(await observed.current())) {
      for (const [id, state] of results)
        if (state.state === 'available' || state.state === 'withheld' || state.state === 'unsupported')
          results.set(id, unavailable);
      return observation(deps, results, components, releaseDigest, releaseHead);
    }
  } catch (error) {
    if (!(error instanceof AccessUnavailableError) && classifyUnavailability(error) === undefined) throw error;
    for (const id of routed) results.set(id, unavailable);
    return observation(deps, results, components, releaseDigest, releaseHead);
  }
  return observed;
}

function observation(
  deps: CopyWorkDisclosureDependencies,
  results: Map<string, CopyWorkDisclosureState>,
  cuts: readonly PartitionCut[],
  digest: string | null,
  head: number | null,
): CopyWorkDisclosureObservation {
  const components = cuts;
  const disclosed = [...results.entries()].flatMap(([id, state]) => {
    if (state.state === 'available') return [id, ...state.works.map((work) => work.id)];
    return state.state === 'scope' || state.state === 'unsupported' ? [id] : [];
  });
  return {
    results,
    async current() {
      return within(deps.deadline, async () => {
        requireAccessDeadline(deps.deadline);
        const active = (
          await snapshot(deps, 0, async (client) => {
            const release = await activeRelease(client);
            if (!release) return null;
            return release;
          })
        ).value;
        if (!active || active.digest !== digest || active.head !== head) return false;
        const unique = [...new Set(disclosed.filter((id) => routeOf(id) !== null))];
        const checks: AccessCheck[] = [];
        for (const id of unique) {
          const route = routeOf(id)!;
          checks.push(
            await accessCheck(
              deps.access,
              deps.actor,
              'subject:read',
              {
                route,
                id,
                eligibility: relatedReadEligibility({ route, id }, unique),
              },
              { pool: deps.pool, deadline: deps.deadline },
            ),
          );
        }
        return withReadTransaction(
          deps.pool,
          async (client) => {
            if (components.length)
              await partitionReadClients(
                client,
                components.map((cut) => cut.partition),
              );
            const current = new Map(
              (
                await readPartitions(
                  client,
                  components.map((cut) => cut.partition),
                )
              ).map((row) => [row.partitionNo, row]),
            );
            for (const cut of components) {
              const found = current.get(cut.partition);
              if (!found || found.epoch !== cut.epoch || found.position !== cut.position) return false;
            }
            for (const check of checks) if (!(await check(client))) return false;
            return true;
          },
          deps.deadline,
        );
      });
    },
  };
}
