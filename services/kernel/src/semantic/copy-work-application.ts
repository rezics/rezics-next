import { partitionOf, routeOf } from '../route/route.ts';
import {
  admittedCopyWork,
  COPY_WORK_DISCLOSURE_MAX_RAW,
  COPY_WORK_DISCLOSURE_MAX_WORKS,
  type CopyWorkDisclosureObservation,
  type CopyWorkDisclosureRequest,
  type CopyWorkDisclosureState,
  type CopyWorkReference,
} from './copy-work-disclosure-contract.ts';
import type {
  CopyWorkDisclosureDependencies,
  CopyWorkPartitionCut,
  CopyWorkReaderPort,
  CopyWorkSummaryBatch,
  CopyWorkSourceObservation,
  CopyWorkListPresentationOptions,
} from './copy-work-reader-port.ts';
import type { IdentityMapping } from './identity-epoch-contract.ts';

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

function sameCut(left: CopyWorkPartitionCut, right: CopyWorkPartitionCut) {
  return left.epoch === right.epoch && left.position === right.position;
}

/** Distinct homes only. Two positions for one home is a mixed old/new assembly. */
function collectCuts(cuts: readonly CopyWorkPartitionCut[]): CopyWorkPartitionCut[] | null {
  const byHome = new Map<number, CopyWorkPartitionCut>();
  for (const cut of cuts) {
    const previous = byHome.get(cut.partition);
    if (previous && !sameCut(previous, cut)) return null;
    byHome.set(cut.partition, cut);
  }
  return [...byHome.values()];
}

function mappingKey(mapping: unknown) {
  return json(mapping ?? null);
}

function selectedLabels(summary: { label?: { language: string; value: string } | null }): Record<string, string> {
  return summary.label ? { [summary.label.language]: summary.label.value } : {};
}

/** Copy-work disclosure orchestration; all current native reads remain explicit producer ports. */
export async function readCopyWorkDisclosureWith(
  port: CopyWorkReaderPort,
  deps: CopyWorkDisclosureDependencies,
  request: CopyWorkDisclosureRequest,
): Promise<CopyWorkDisclosureObservation> {
  const reader = port.copyWorkDisclosure;
  if (!Array.isArray(request.identities) || request.identities.some((id) => typeof id !== 'string'))
    throw new TypeError('Copy/work disclosure requires string identities');
  if (request.identities.length > COPY_WORK_DISCLOSURE_MAX_RAW)
    throw new RangeError('Copy/work disclosure accepts at most 100 raw identity inputs');
  if (!Number.isFinite(deps.deadline) || !(deps.routeKey instanceof Uint8Array) || deps.routeKey.byteLength < 32)
    throw new TypeError('Copy/work disclosure requires the trusted route key and finite request deadline');
  reader.requireDeadline(deps.deadline);
  const languages = request.languages?.length
    ? (port.searchEvidence.validateHitOptions({ languages: [...request.languages] }).languages ?? [])
    : [];
  const results = new Map<string, CopyWorkDisclosureState>();
  const originals = [...new Set(request.identities)];
  for (const id of originals) if (routeOf(id) === null) results.set(id, missing);
  const routed = originals.filter((id) => routeOf(id) !== null);
  if (!routed.length)
    return {
      results,
      async current() {
        reader.requireDeadline(deps.deadline);
        return true;
      },
    };

  const classified = new Map<string, CopyWorkDisclosureState>();
  const cuts: CopyWorkPartitionCut[] = [];
  let releaseDigest: string | null = null;
  let releaseHead: number | null = null;

  try {
    await reader.withinDeadline(deps.deadline, async () => {
      const active = await reader.readActiveRelease(deps);
      releaseDigest = active.digest;
      releaseHead = active.head;
      const mappings = await reader.readIdentityMappings(deps, routed);
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
      const checks = await reader.prepareChecks(deps, terminals);
      const observedSources = new Map<string, CopyWorkSourceObservation>();
      const fenceTuples = [] as Awaited<ReturnType<typeof reader.observeHome>>['tuples'];
      const fencedSubjects: string[] = [];
      for (const [home, ids] of groups(terminals)) {
        const observed = await reader.observeHome(deps, active.release, home, ids, checks);
        cuts.push(observed.cut);
        for (const [id, source] of observed.found) observedSources.set(id, source);
        fenceTuples.push(...observed.tuples);
        fencedSubjects.push(...observed.owners);
      }
      const taken = await reader.readTakenFenceKeys(deps, fenceTuples);
      if (taken.size) {
        for (let index = 0; index < fenceTuples.length; index++) {
          if (!taken.has(reader.fenceKey(fenceTuples[index]!))) continue;
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
      const mappedTargets = uniqueTargets.length
        ? await reader.readIdentityMappings(deps, uniqueTargets)
        : new Map<string, IdentityMapping | undefined>();
      const terminalTargets = [
        ...new Set(
          uniqueTargets.flatMap((id) => {
            const mapping = mappedTargets.get(id);
            if (!mapping || mapping.state === 'pending' || mapping.state === 'unavailable') return [];
            return mapping.state === 'mapped' ? [mapping.terminal] : [id];
          }),
        ),
      ];
      const summaryObservation: CopyWorkSummaryBatch = terminalTargets.length
        ? await reader.readSummaries(deps, terminalTargets, { languages })
        : { summaries: new Map(), components: [] };
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
        const admission = admittedCopyWork(active.release, source.header.type, reader.isRelationProperty);
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
      const remappedSources = await reader.readIdentityMappings(deps, routed);
      for (const id of routed) {
        if (mappingKey(mappings.get(id)) !== mappingKey(remappedSources.get(id))) classified.set(id, unavailable);
      }
      if (uniqueTargets.length) {
        const remappedTargets = await reader.readIdentityMappings(deps, uniqueTargets);
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
    if (!reader.isUnavailable(error)) throw error;
    for (const id of routed) if (!classified.has(id) && !results.has(id)) classified.set(id, unavailable);
  }

  for (const [id, state] of classified) results.set(id, state);
  for (const id of routed) if (!results.has(id)) results.set(id, unavailable);
  const components = collectCuts(cuts);
  if (components === null) {
    for (const id of routed) results.set(id, unavailable);
    return reader.observation(deps, results, [], releaseDigest, releaseHead);
  }
  return reader.observation(deps, results, components, releaseDigest, releaseHead);
}

export function createSemanticCopyWorkApplication(port: CopyWorkReaderPort) {
  return Object.freeze({
    searchEvidence: port.searchEvidence,
    readCopyWorkDisclosure: (deps: CopyWorkDisclosureDependencies, request: CopyWorkDisclosureRequest) =>
      readCopyWorkDisclosureWith(port, deps, request),
    readWorkReleaseCards: (input: Parameters<CopyWorkReaderPort['readWorkReleaseCards']>[0]) =>
      port.readWorkReleaseCards(input),
    createFacetPopulationSource: (config: Parameters<CopyWorkReaderPort['createFacetPopulationSource']>[0]) =>
      port.createFacetPopulationSource(config),
    readListPresentationFacts: (
      deps: CopyWorkDisclosureDependencies,
      originals: readonly string[],
      options: CopyWorkListPresentationOptions = {},
    ) => port.readListPresentationFacts(deps, originals, options, port.searchEvidence),
  });
}

export type SemanticCopyWorkApplication = ReturnType<typeof createSemanticCopyWorkApplication>;

let installed: SemanticCopyWorkApplication | undefined;

/** Runtime composition installs the concrete native readers and Search evidence exactly once per process boot. */
export function bindSemanticCopyWorkApplication(application: SemanticCopyWorkApplication): void {
  installed = application;
}

export function semanticCopyWorkApplication(): SemanticCopyWorkApplication {
  if (!installed) throw new TypeError('Semantic copy-work reading application is not installed');
  return installed;
}

export const readCopyWorkDisclosure = (deps: CopyWorkDisclosureDependencies, request: CopyWorkDisclosureRequest) =>
  semanticCopyWorkApplication().readCopyWorkDisclosure(deps, request);

export const readWorkReleaseCards = (...args: Parameters<SemanticCopyWorkApplication['readWorkReleaseCards']>) =>
  semanticCopyWorkApplication().readWorkReleaseCards(...args);

export const createFacetPopulationSource = (
  ...args: Parameters<SemanticCopyWorkApplication['createFacetPopulationSource']>
) => semanticCopyWorkApplication().createFacetPopulationSource(...args);

export const readListPresentationFacts = (
  ...args: Parameters<SemanticCopyWorkApplication['readListPresentationFacts']>
) => semanticCopyWorkApplication().readListPresentationFacts(...args);

export type { CopyWorkSearchEvidencePort, CopyWorkReaderPort } from './copy-work-reader-port.ts';
