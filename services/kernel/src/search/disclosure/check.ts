import {
  FilterError,
  parseFilter,
  type FilterDocument,
  type FilterQualifier,
  type SpoilerThreshold,
  type FilterRelease,
} from '@rezics/filter';
import type { Release } from '@rezics/definitions';
import { anyCurrentMatch, compileCurrentFilter, currentClauseKey } from '../current-filter-plan.ts';
import {
  CONCEPT_STATEMENT_PREFIX_LIMITS,
  matchNativeConceptFilter,
  type ConceptFilterExecution,
} from '../concept-browse-statements.ts';
import { holdsCurrentStatements, holdsCurrentType } from '../current-leaf.ts';
import { RequestSourceLifetime } from '../request-source-lifetime.ts';
import { REQUEST_SOURCE_KEYS, validateRequestSourceSnapshot } from '../request-source-snapshot.ts';
import {
  MAX_RELATION_FACET_PROBES,
  subjectPartition,
  type IndexedSubject,
  type RelationFacetMatch,
  type RelationFacetProbe,
  type SubjectSource,
  type RetainedRelationFacetPage,
} from '../source.ts';
import { SearchOperationError } from '../operation-outcomes.ts';
import type { Hit, FactClause } from './admission.ts';
export type { Hit, FactClause } from './admission.ts';

const sortedValues = (values: readonly string[]) => [...new Set(values)].sort();

/** An inverse edge from a selected work to the candidate Character or Person. */
export type InverseRelationFacetProbe = {
  subject: string;
  source: string;
  property: string;
  qualifiers?: readonly FilterQualifier[];
  spoilerThreshold?: SpoilerThreshold;
};

export type CurrentRelationRelease = {
  digest: string;
  head: number;
  release: FilterRelease;
  definitions?: Release;
};

/** No release permission survives foreign disclosure I/O. Missing/replaced releases withhold the window. */
export async function withCurrentRelationRelease<T>(
  observe: () => Promise<CurrentRelationRelease | null>,
  work: (release: FilterRelease, pin: CurrentRelationRelease) => Promise<T>,
  unavailable: T,
): Promise<T> {
  const before = await observe();
  if (!before) return unavailable;
  const result = await work(before.release, before);
  const after = await observe();
  return after?.digest === before.digest && after.head === before.head ? result : unavailable;
}

/**
 * Execute inverse membership through the existing selected-value seek and same-statement matcher.
 * The selected source ids bound work independently of actor degree. No inbound sample, pooled
 * qualifiers, or second Boolean interpreter is introduced. This step is a witness search;
 * an undisclosed or exhausted forward window cannot certify an inverse negative.
 */
export async function matchInverseRelationFacets(
  source: SubjectSource,
  partition: number,
  probes: readonly InverseRelationFacetProbe[],
  observe: () => Promise<CurrentRelationRelease | null>,
): Promise<RelationFacetMatch[]> {
  if (
    !Number.isInteger(partition) ||
    partition < 0 ||
    partition >= 4096 ||
    !Array.isArray(probes) ||
    probes.length > MAX_RELATION_FACET_PROBES
  )
    throw new TypeError('Invalid inverse relation probe page');
  for (const probe of probes) {
    try {
      if (
        !probe ||
        Object.keys(probe).some(
          (key) => !['subject', 'source', 'property', 'qualifiers', 'spoilerThreshold'].includes(key),
        ) ||
        (probe.spoilerThreshold !== undefined && ![0, 1, 2].includes(probe.spoilerThreshold)) ||
        subjectPartition(probe.subject) !== partition
      )
        throw new TypeError('Invalid inverse relation probe');
      subjectPartition(probe.source);
      parseFilter({
        statement: {
          property: probe.property,
          in: [probe.subject],
          ...(probe.qualifiers === undefined ? {} : { qualifiers: probe.qualifiers }),
        },
      });
    } catch (error) {
      if (error instanceof FilterError || error instanceof TypeError)
        throw new TypeError('Invalid inverse relation probe');
      throw error;
    }
  }
  if (!probes.length) return [];
  return withCurrentRelationRelease(
    observe,
    () => matchInverseWindow(source, partition, probes),
    probes.map(() => 'not_proven' as const),
  );
}

async function matchInverseWindow(
  source: SubjectSource,
  partition: number,
  probes: readonly InverseRelationFacetProbe[],
): Promise<RelationFacetMatch[]> {
  if (!source.matchRelationFacets) return probes.map(() => 'not_proven');
  const ids = [...new Set(probes.map((probe) => probe.subject))];
  const before = await source.read(partition, ids);
  const subjects = validateRequestSourceSnapshot(before, partition, ids);
  const allowed = new Set(
    [...subjects.values()]
      .filter((subject) => subject.visibility === 'visible' && subject.redirect === null)
      .map((subject) => subject.id),
  );
  const results: RelationFacetMatch[] = probes.map(() => 'not_proven');
  const groups = new Map<number, Map<string, { probe: RelationFacetProbe; indices: number[] }>>();
  for (const [index, probe] of probes.entries()) {
    if (!allowed.has(probe.subject)) continue;
    const home = subjectPartition(probe.source);
    const group = groups.get(home) ?? new Map();
    const forward: RelationFacetProbe = {
      subject: probe.source,
      property: probe.property,
      value: probe.subject,
      ...(probe.qualifiers === undefined ? {} : { qualifiers: probe.qualifiers }),
      ...(probe.spoilerThreshold === undefined ? {} : { spoilerThreshold: probe.spoilerThreshold }),
    };
    const key = JSON.stringify(forward);
    const point = group.get(key) ?? { probe: forward, indices: [] };
    point.indices.push(index);
    group.set(key, point);
    groups.set(home, group);
  }
  for (const [home, group] of groups) {
    const points = [...group.values()];
    const matches = await source.matchRelationFacets(
      home,
      points.map((point) => point.probe),
    );
    if (!Array.isArray(matches) || matches.length !== points.length)
      throw new Error('Malformed relation facet probe results');
    for (const [index, point] of points.entries()) {
      const match = matches[index];
      if (!Object.hasOwn(matches, index) || (match !== true && match !== false && match !== 'not_proven'))
        throw new Error('Malformed relation facet probe results');
      for (const position of point.indices) results[position] = match === true ? true : 'not_proven';
    }
  }
  // Foreign source/tuple checks can race a reduction on the result anchor. Reanchor the whole
  // window; even a partition change unrelated to these ids conservatively retires this step.
  if (results.includes(true)) {
    const after = await source.read(partition, ids);
    const current = validateRequestSourceSnapshot(after, partition, ids);
    for (const [index, probe] of probes.entries()) {
      if (results[index] !== true) continue;
      const previous = subjects.get(probe.subject)!;
      const subject = current.get(probe.subject);
      if (
        before.position !== after.position ||
        !subject ||
        subject.visibility !== 'visible' ||
        subject.redirect !== null ||
        subject.type !== previous.type ||
        subject.securityRevision !== previous.securityRevision
      )
        results[index] = 'not_proven';
    }
  }
  return results;
}

/** Recheck candidates against current anchor snapshots; any failed read rejects the whole page. */
export async function checkHits<NativeHit extends Hit>(
  source: SubjectSource,
  hits: readonly NativeHit[],
  clauses: ReadonlyMap<string, FactClause>,
  options?: {
    concurrency?: number;
    filter?: FilterDocument;
    relationProperties?: readonly string[];
    spoilerThreshold?: SpoilerThreshold;
    observeRelationRelease?: () => Promise<CurrentRelationRelease | null>;
    conceptFilter?: ConceptFilterExecution;
    /** Re-evaluate a stale indexed text hint against the current native Subject projection. */
    currentText?: (subject: IndexedSubject) => Promise<RelationFacetMatch>;
  },
): Promise<{
  passed: { hit: NativeHit; subject: IndexedSubject }[];
  dropped: number;
  relationRejected?: true;
  /** An eligible candidate has undecidable text; it cannot certify counts or a consumed continuation. */
  textRejected?: true;
}> {
  const requestedConcurrency = options?.concurrency ?? 8;
  if (!Number.isSafeInteger(requestedConcurrency) || requestedConcurrency < 1)
    throw new RangeError('Concurrency must be a positive safe integer');
  const concurrency = Math.min(requestedConcurrency, 8);

  const plan = options?.filter === undefined ? undefined : compileCurrentFilter(options.filter);
  const hasInverse = [...(plan?.leaves ?? clauses.values())].some(
    (clause) => clause.facet === 'statement' && 'values' in clause && clause.inverse,
  );
  if (hasInverse && (!plan || !options?.observeRelationRelease))
    throw new Error('Inverse disclosure requires the current filter plan and runtime release observer');
  const observeRelease = options?.observeRelationRelease;
  const releaseBefore = observeRelease ? await observeRelease() : undefined;
  if (observeRelease && !releaseBefore) return { passed: [], dropped: hits.length, relationRejected: true };
  const relationProperties = new Set(options?.relationProperties);
  let relationRejected = false;
  let sourceChanged = false;
  let textRejected = false;
  const currentTextMatches = async (subject: IndexedSubject): Promise<boolean> => {
    const match = options?.currentText ? await options.currentText(subject) : true;
    textRejected ||= match === 'not_proven';
    return match === true;
  };
  const hints = new Map<string, number>();
  if (plan) {
    for (const [name, clause] of clauses) {
      const index = plan.indices.get(currentClauseKey(clause));
      if (index !== undefined) hints.set(name, index);
    }
  }

  const groups = new Map<number, { ids: Set<string>; candidates: { hit: NativeHit; index: number }[] }>();
  for (const [index, hit] of hits.entries()) {
    let partition: number;
    try {
      partition = subjectPartition(hit.id);
    } catch {
      // An untrusted index id without an anchor cannot be disclosed.
      continue;
    }
    if (hit.partition !== partition) continue;
    let group = groups.get(partition);
    if (!group) {
      group = { ids: new Set(), candidates: [] };
      groups.set(partition, group);
    }
    group.ids.add(hit.id);
    group.candidates.push({ hit, index });
  }

  const checked: ({ hit: NativeHit; subject: IndexedSubject } | undefined)[] = new Array(hits.length);
  const partitions = [...groups];
  const lifetime = new RequestSourceLifetime();
  type Point = { probe: RelationFacetProbe; inverse?: true; result?: RelationFacetMatch };
  const pagePoints: Point[] = [];
  const dispatches: (() => Promise<void>)[] = [];
  let dispatchSource = source;
  let next = 0;
  async function worker(): Promise<void> {
    while (!lifetime.stopped) {
      const entry = partitions[next++];
      if (!entry) return;
      const [partition, group] = entry;
      const ids = [...group.ids];
      const subjects = new Map<string, IndexedSubject>();
      const positions = new Map<string, bigint>();
      for (let offset = 0; offset < ids.length; offset += REQUEST_SOURCE_KEYS) {
        if (lifetime.stopped) return;
        const chunk = ids.slice(offset, offset + REQUEST_SOURCE_KEYS);
        const read = await lifetime.start(async () => {
          const snapshot = await source.read(partition, chunk);
          return { position: snapshot.position, subjects: validateRequestSourceSnapshot(snapshot, partition, chunk) };
        });
        if (!read.ok) return;
        for (const id of chunk) positions.set(id, read.value.position);
        for (const [id, subject] of read.value.subjects) subjects.set(id, subject);
      }
      const points = new Map<string, Point>();
      const evaluations = new Map<string, () => Promise<{ passed: boolean; relationRejected: boolean }>>();
      const eligible: { hit: NativeHit; subject: IndexedSubject; index: number }[] = [];
      for (const { hit, index } of group.candidates) {
        const subject = subjects.get(hit.id);
        if (
          !subject ||
          subject.visibility !== 'visible' ||
          subject.redirect !== null ||
          subject.securityRevision !== hit.securityRevision
        )
          continue;
        if (plan) {
          eligible.push({ hit, subject, index });
          if (evaluations.has(subject.id)) continue;
          // Hints determine work order only. Every leaf, including unreported negative leaves,
          // is resolved from current facts before evaluating the original boolean expression.
          const order = new Set<number>();
          for (const name of hit.matched) {
            const leaf = hints.get(name);
            if (leaf !== undefined) order.add(leaf);
          }
          for (const leaf of plan.leaves.keys()) order.add(leaf);
          const values: (RelationFacetMatch | Point[])[] = new Array(plan.leaves.length);
          for (const leaf of order) {
            const clause = plan.leaves[leaf]!;
            if (clause.facet === 'statement' && 'values' in clause && clause.concept) {
              values[leaf] = 'not_proven';
              continue;
            }
            const overflow = clause.facet === 'statement' && subject.relationFacetOverflow?.includes(clause.property);
            const live =
              clause.facet === 'statement' &&
              relationProperties.has(clause.property) &&
              (plan.positive.has(leaf) || !!clause.qualifiers?.length || options?.spoilerThreshold !== undefined);
            const inverse = clause.facet === 'statement' && 'values' in clause && clause.inverse;
            if (clause.facet !== 'statement' || !('values' in clause) || !(overflow || live || inverse)) {
              values[leaf] =
                clause.facet === 'type'
                  ? holdsCurrentType(subject.type, clause)
                  : holdsCurrentStatements(subject.statements, clause);
              continue;
            }
            values[leaf] = sortedValues(clause.values).map((value) => {
              const probe: RelationFacetProbe = {
                subject: subject.id,
                property: clause.property,
                value,
                ...(clause.qualifiers ? { qualifiers: clause.qualifiers } : {}),
                ...(options?.spoilerThreshold === undefined ? {} : { spoilerThreshold: options.spoilerThreshold }),
              };
              const key = JSON.stringify([inverse === true, probe]);
              let point = points.get(key);
              if (!point) {
                point = { probe, ...(inverse ? { inverse: true } : {}) };
                points.set(key, point);
              }
              return point;
            });
          }
          evaluations.set(subject.id, async () => {
            const resolved = values.map((value) =>
              Array.isArray(value) ? anyCurrentMatch(value.map((point) => point.result!)) : value,
            );
            const conceptLeaves = plan.leaves.some(
              (clause) => clause.facet === 'statement' && 'values' in clause && clause.concept,
            );
            if (conceptLeaves) {
              if (!options?.conceptFilter) return { passed: false, relationRejected: true };
              const current = await matchNativeConceptFilter(
                options.conceptFilter.reader,
                partition,
                {
                  subject: subject.id,
                  filter: options.filter!,
                  ...(options.spoilerThreshold === undefined ? {} : { spoilerThreshold: options.spoilerThreshold }),
                },
                options.conceptFilter.resolveCut,
                CONCEPT_STATEMENT_PREFIX_LIMITS,
                ({ leaf }) => {
                  if (leaf.kind !== 'catalogue') return null;
                  const index = plan.indices.get(currentClauseKey(leaf.clause));
                  if (index === undefined) return null;
                  const value = values[index];
                  if (value === undefined) return null;
                  const match = Array.isArray(value)
                    ? anyCurrentMatch(
                        value.map((point) => {
                          if (point.result === undefined) throw new TypeError('Relation evidence was not resolved');
                          return point.result;
                        }),
                      )
                    : value;
                  return {
                    read: async () => ({
                      status: 'current' as const,
                      match,
                      revalidate: async () => 'current' as const,
                    }),
                  };
                },
              );
              if (current.status === 'restart') throw new SearchOperationError('search_restart_required');
              if (current.status !== 'current' || current.match === 'not_proven')
                return { passed: false, relationRejected: true };
              return { passed: current.match === true, relationRejected: false };
            }
            // Bounded uncertainty remains unknown through negation and cannot disclose a hit.
            const passed = plan.evaluate(resolved) === true;
            return {
              passed,
              // Live rejection invalidates the indexed candidate total. Qualified negatives
              // also need this: bounded uncertainty cannot certify final exhaustion.
              relationRejected:
                !passed &&
                values.some((value, leaf) => {
                  const clause = plan.leaves[leaf]!;
                  if (value === 'not_proven') return true;
                  const sensitive =
                    plan.positive.has(leaf) ||
                    (clause.facet === 'statement' &&
                      (!!clause.qualifiers?.length ||
                        options?.spoilerThreshold !== undefined ||
                        ('values' in clause && clause.inverse === true)));
                  return Array.isArray(value) && sensitive;
                }),
            };
          });
          continue;
        }
        if (
          !hit.matched.every((name) => {
            const clause = clauses.get(name);
            return (
              clause === undefined ||
              (clause.facet === 'type'
                ? holdsCurrentType(subject.type, clause)
                : holdsCurrentStatements(subject.statements, clause) === true)
            );
          })
        )
          continue;
        if (await currentTextMatches(subject)) checked[index] = { hit, subject };
      }
      const pending = [...points.values()];
      pagePoints.push(...pending);
      dispatches.push(async () => {
        for (const inverse of [false, true]) {
          const selected = pending.filter((point) => !!point.inverse === inverse);
          for (let offset = 0; offset < selected.length; offset += MAX_RELATION_FACET_PROBES) {
            if (lifetime.stopped) return;
            const batch = selected.slice(offset, offset + MAX_RELATION_FACET_PROBES);
            const probe = await lifetime.start(() => {
              if (inverse) {
                if (!options?.observeRelationRelease)
                  throw new Error('Inverse disclosure requires a runtime release observer');
                return matchInverseRelationFacets(
                  dispatchSource,
                  partition,
                  batch.map(({ probe }) => ({
                    subject: probe.subject,
                    source: probe.value,
                    property: probe.property,
                    ...(probe.qualifiers ? { qualifiers: probe.qualifiers } : {}),
                    ...(probe.spoilerThreshold === undefined ? {} : { spoilerThreshold: probe.spoilerThreshold }),
                  })),
                  options.observeRelationRelease,
                );
              }
              if (!dispatchSource.matchRelationFacets)
                throw new Error('Relation disclosure requires relation facet probes');
              return dispatchSource.matchRelationFacets(
                partition,
                batch.map((point) => point.probe),
              );
            });
            if (!probe.ok) return;
            const results = probe.value;
            if (!Array.isArray(results) || results.length !== batch.length)
              throw new Error('Malformed relation facet probe results');
            for (const [index, point] of batch.entries()) {
              const result = results[index];
              if (!Object.hasOwn(results, index) || (result !== true && result !== false && result !== 'not_proven'))
                throw new Error('Malformed relation facet probe results');
              point.result = result;
            }
          }
        }
        const outcomes = new Map<string, { passed: boolean; relationRejected: boolean }>();
        for (const { hit, subject, index } of eligible) {
          outcomes.set(subject.id, await evaluations.get(subject.id)!());
        }
        // Reanchor identity, disclosure and facts after retained concept membership work.
        const retired = new Set<string>();
        if (pagePoints.length || options?.conceptFilter) {
          for (let offset = 0; offset < ids.length; offset += REQUEST_SOURCE_KEYS) {
            const chunk = ids.slice(offset, offset + REQUEST_SOURCE_KEYS);
            const read = await lifetime.start(async () => {
              const snapshot = await source.read(partition, chunk);
              return {
                position: snapshot.position,
                subjects: validateRequestSourceSnapshot(snapshot, partition, chunk),
              };
            });
            if (!read.ok) return;
            for (const id of chunk) {
              const before = subjects.get(id);
              const after = read.value.subjects.get(id);
              if (
                positions.get(id) !== read.value.position ||
                after?.visibility !== before?.visibility ||
                after?.redirect !== before?.redirect ||
                after?.type !== before?.type ||
                after?.securityRevision !== before?.securityRevision ||
                (options?.conceptFilter && JSON.stringify(after?.statements) !== JSON.stringify(before?.statements))
              )
                retired.add(id);
            }
          }
        }
        sourceChanged ||= retired.size > 0;
        for (const { hit, subject, index } of eligible) {
          const result = outcomes.get(subject.id)!;
          if (retired.has(subject.id)) {
            relationRejected = true;
            continue;
          }
          if (result.passed && (await currentTextMatches(subject))) checked[index] = { hit, subject };
          relationRejected ||= result.relationRejected;
        }
      });
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, groups.size) }, async () => {
      try {
        await worker();
      } catch (error) {
        lifetime.fail(error);
      }
    }),
  );
  lifetime.throwIfFailed();
  let retained: RetainedRelationFacetPage | undefined;
  if (source.prepareRelationFacets && pagePoints.length) {
    const forward = pagePoints.map(({ probe, inverse }) =>
      inverse ? { ...probe, subject: probe.value, value: probe.subject } : probe,
    );
    retained = await source.prepareRelationFacets(forward);
    const values = await retained.match();
    if (
      !Array.isArray(values) ||
      values.length !== forward.length ||
      forward.some((_, index) => !Object.hasOwn(values, index)) ||
      values.some((value) => value !== true && value !== false && value !== 'not_proven')
    )
      throw new Error('Malformed relation facet probe results');
    const evidence = new Map(forward.map((probe, index) => [JSON.stringify(probe), values[index]!]));
    dispatchSource = {
      read: source.read.bind(source),
      count: source.count.bind(source),
      async matchRelationFacets(_, probes) {
        return probes.map((probe) => evidence.get(JSON.stringify(probe)) ?? 'not_proven');
      },
    };
  }
  for (const dispatch of dispatches) await dispatch();
  lifetime.throwIfFailed();
  if (sourceChanged || (retained && !(await retained.revalidate())))
    return { passed: [], dropped: hits.length, relationRejected: true };
  if (observeRelease) {
    const releaseAfter = await observeRelease();
    if (releaseAfter?.digest !== releaseBefore!.digest || releaseAfter?.head !== releaseBefore!.head)
      return { passed: [], dropped: hits.length, relationRejected: true };
  }
  const passed = checked.filter((entry) => entry !== undefined);
  return {
    passed,
    dropped: hits.length - passed.length,
    ...(relationRejected ? { relationRejected: true } : {}),
    ...(textRejected ? { textRejected: true } : {}),
  };
}
