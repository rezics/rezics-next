import type { Release } from '@rezics/definitions';
import { within } from '../access/authenticate.ts';
import { AccessUnavailableError, classifyUnavailability, requireAccessDeadline } from '../access/unavailable.ts';
import { readFences, type SourceFenceTuple } from '../content/source-fences.ts';
import { partitionReadClients } from '../database/read-snapshot.ts';
import { readPartition, readPartitions } from '../partition/partition.ts';
import { accessCheck, type AccessCheck } from '../request/access.ts';
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
import readCopyWorkHeads from './copy-work-disclosure.sql';
import { activeRelease } from './definitions.ts';
import { relatedReadEligibility, subjectReadEligibility } from './eligibility.ts';
import { candidateSources, fenceKey, sourceTuple } from './fences.ts';
import { readIdentityMappings } from './identity-epoch-read.ts';
import { isRelationProperty, type FactRow } from './item.ts';
import { withReadTransaction } from './read.ts';
import { effectiveGlobalSlotFacts } from './slots.ts';
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

type HeadRow = {
  id: string;
  type: string;
  visibility: string;
  security: string;
  release: string | null;
  revision: number | null;
  source_epoch: number | null;
  source_position: string | null;
  redirect: string | null;
  candidate: string | null;
  slot: string | null;
  target: string | null;
  target_type: string | null;
  order_key: string | null;
  source_revision: number | null;
  source_security_revision: string | null;
  value: string | null;
};

type Membership = { kind: 'works'; ids: string[] } | { kind: 'concealed' } | { kind: 'overflow' } | { kind: 'unready' };
type SourceObservation = {
  header: HeadRow;
  locators: HeadRow[];
  allowed: boolean;
  membership: Membership | null;
};

type PartitionCut = { partition: number; epoch: number; position: bigint };
type SourcePlan = { original: string; terminal: string; home: number };

const withheld: CopyWorkDisclosureState = { state: 'withheld' };
const missing: CopyWorkDisclosureState = { state: 'missing' };
const unavailable: CopyWorkDisclosureState = { state: 'unavailable' };
const denied: CopyWorkDisclosureState = { state: 'denied' };
const scoped: CopyWorkDisclosureState = { state: 'scope' };
const unsupported: CopyWorkDisclosureState = { state: 'unsupported' };
const emptyAvailable: CopyWorkDisclosureState = { state: 'available', works: [] };

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

  const checks = new Map<string, AccessCheck>();
  for (const id of routed) {
    const route = routeOf(id)!;
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

  let releaseDigest: string | null = null;
  let releaseHead: number | null = null;
  const cuts: PartitionCut[] = [];
  const plans = new Map<string, SourcePlan>();
  const classified = new Map<string, CopyWorkDisclosureState>();
  let targets: string[] = [];

  try {
    await within(deps.deadline, async () => {
      const active = await withReadTransaction(deps.pool, (client) => activeRelease(client), deps.deadline);
      if (!active) {
        for (const id of routed) results.set(id, unavailable);
        return;
      }
      releaseDigest = active.digest;
      releaseHead = active.head;
      const mappings = await mapIdentities(deps, routed);
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
      for (const terminal of terminals) {
        if (checks.has(terminal)) continue;
        const route = routeOf(terminal)!;
        checks.set(
          terminal,
          await accessCheck(
            deps.access,
            deps.actor,
            'subject:read',
            { route, id: terminal, eligibility: subjectReadEligibility({ route, id: terminal }) },
            { pool: deps.pool, deadline: deps.deadline },
          ),
        );
      }

      const observedSources = new Map<string, SourceObservation>();
      const fenceTuples: SourceFenceTuple[] = [];
      const fencedSubjects: string[] = [];
      for (const [home, ids] of groups(terminals)) {
        const observed = await withReadTransaction(
          deps.pool,
          async (client) => {
            const partition = await readPartition(client, home);
            if (!partition || partition.writeState !== 'active') throw new AccessUnavailableError('contention');
            cuts.push({ partition: home, epoch: partition.epoch, position: partition.position });
            const values = {
              partition_no: home,
              property: COPY_WORK_PROPERTY,
              page_limit: COPY_WORK_DISCLOSURE_LOOKAHEAD,
              wanted: JSON.stringify(ids.map((id) => ({ route: routeOf(id)!, subject_id: id }))),
            };
            const rows = (
              await client.query<HeadRow>(
                readCopyWorkHeads.sql,
                readCopyWorkHeads.params.map((name) => values[name as keyof typeof values]),
              )
            ).rows;
            const checkpoint = (
              await client.query<{ epoch: number; position: string }>(
                'SELECT epoch, position::text FROM core.consumer_checkpoint WHERE partition_no=$1 AND consumer=$2',
                [home, 'semantic_links'],
              )
            ).rows[0];
            const byId = new Map<string, HeadRow[]>();
            for (const row of rows) {
              const list = byId.get(row.id) ?? [];
              list.push(row);
              byId.set(row.id, list);
            }
            const found = new Map<string, SourceObservation>();
            const provenance: { route: number; subject_id: string; candidate_id: string }[] = [];
            for (const id of ids) {
              const group = byId.get(id);
              if (!group?.length) continue;
              const header = group[0]!;
              const locators = group.filter((row) => row.candidate);
              const check = checks.get(id);
              const allowed = check ? await check(client) : false;
              found.set(id, { header, locators, allowed, membership: null });
              if (header.visibility !== 'visible' || !allowed) continue;
              if (admittedCopyWork(active.release, header.type) !== 'admitted') continue;
              if (!checkpoint || checkpoint.epoch !== partition.epoch) throw new AccessUnavailableError('contention');
              if (
                header.revision === null ||
                header.release === null ||
                header.source_epoch === null ||
                header.source_position === null ||
                header.source_epoch !== partition.epoch ||
                BigInt(checkpoint.position) < BigInt(header.source_position)
              )
                throw new AccessUnavailableError('contention');
              for (const locator of locators) {
                if (locator.source_revision !== header.revision || locator.source_security_revision !== header.security)
                  throw new AccessUnavailableError('contention');
              }
              if (locators.length >= COPY_WORK_DISCLOSURE_LOOKAHEAD) {
                found.get(id)!.membership = { kind: 'overflow' };
                continue;
              }
              const factsByCandidate = new Map<string, FactRow>();
              for (const slot of new Set(
                locators.map((locator) => locator.slot).filter((slot): slot is string => !!slot),
              )) {
                const view = await effectiveGlobalSlotFacts(client, id, COPY_WORK_PROPERTY, slot);
                for (const fact of view.facts) if (fact.statement_id) factsByCandidate.set(fact.statement_id, fact);
              }
              const resolved: string[] = [];
              let concealed = false;
              for (const locator of locators) {
                const fact = locator.candidate ? factsByCandidate.get(locator.candidate) : undefined;
                const body = fact?.body as { value?: { type?: unknown; content?: unknown } } | undefined;
                const content =
                  body?.value?.type === 'value' && typeof body.value.content === 'string' ? body.value.content : null;
                if (!content || routeOf(content) === null) {
                  concealed = true;
                  continue;
                }
                provenance.push({ route: routeOf(id)!, subject_id: id, candidate_id: locator.candidate! });
                if (!resolved.includes(content)) resolved.push(content);
              }
              found.get(id)!.membership = concealed ? { kind: 'concealed' } : { kind: 'works', ids: resolved };
            }
            const recorded = provenance.length ? await candidateSources(client, provenance) : new Map();
            const tuples: SourceFenceTuple[] = [];
            const owners: string[] = [];
            for (const entry of provenance) {
              const source = recorded.get(`${entry.subject_id}\n${entry.candidate_id}`) ?? null;
              if (!source) continue;
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
          },
          deps.deadline,
        );
        for (const [id, source] of observed.found) {
          observedSources.set(id, source);
          if (source.membership?.kind === 'works') targets.push(...source.membership.ids);
        }
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
        const rows = await withReadTransaction(
          deps.pool,
          async (client) => {
            const partition = await readPartition(client, home);
            if (!partition || partition.writeState !== 'active') throw new AccessUnavailableError('contention');
            cuts.push({ partition: home, epoch: partition.epoch, position: partition.position });
            const found = [];
            for (let offset = 0; offset < unique.length; offset += 100)
              found.push(...(await readFences(client, unique.slice(offset, offset + 100))));
            return found;
          },
          deps.deadline,
        );
        for (const row of rows) if (row.takenDown) taken.add(fenceKey(row));
      }
      if (taken.size) {
        for (let index = 0; index < fenceTuples.length; index++) {
          if (!taken.has(fenceKey(fenceTuples[index]!))) continue;
          const owner = observedSources.get(fencedSubjects[index]!);
          if (owner?.membership?.kind === 'works') owner.membership = { kind: 'concealed' };
        }
      }
      targets = [...observedSources.values()].flatMap((source) =>
        source.membership?.kind === 'works' ? source.membership.ids : [],
      );

      const uniqueTargets = [...new Set(targets.filter((id) => routeOf(id) !== null))];
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
        if (!membership || membership.kind === 'unready') {
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
    });
  } catch (error) {
    if (!(error instanceof AccessUnavailableError) && classifyUnavailability(error) === undefined) throw error;
    for (const id of routed) if (!classified.has(id) && !results.has(id)) classified.set(id, unavailable);
  }

  for (const [id, state] of classified) results.set(id, state);
  for (const id of routed) if (!results.has(id)) results.set(id, unavailable);
  return observation(deps, results, cuts, releaseDigest, releaseHead);
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

function observation(
  deps: CopyWorkDisclosureDependencies,
  results: Map<string, CopyWorkDisclosureState>,
  cuts: readonly PartitionCut[],
  digest: string | null,
  head: number | null,
): CopyWorkDisclosureObservation {
  const components = [...new Map(cuts.map((cut) => [cut.partition, cut] as const)).values()];
  const disclosed = [...results.entries()].flatMap(([id, state]) => {
    if (state.state === 'available') return [id, ...state.works.map((work) => work.id)];
    return state.state === 'scope' || state.state === 'unsupported' ? [id] : [];
  });
  return {
    results,
    async current() {
      requireAccessDeadline(deps.deadline);
      const active = await withReadTransaction(deps.pool, (client) => activeRelease(client), deps.deadline);
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
    },
  };
}
