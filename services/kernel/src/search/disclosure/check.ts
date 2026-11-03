import { matchInverseRelationFacets, type CurrentRelationRelease } from '../character-person.ts';
import type { ConceptSelection, FilterDocument, FilterQualifier, FilterRange, SpoilerThreshold } from '@rezics/filter';
import { anyCurrentMatch, compileCurrentFilter, currentClauseKey } from '../current-filter-plan.ts';
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
} from '../source.ts';

/** One OpenSearch hit, including the indexed partition, security revision and matched query names. */
export type Hit = { id: string; partition: number; securityRevision: number; matched: readonly string[] };

/** A filter leaf compiled by the route, keyed by its query name. */
export type FactClause =
  | { facet: 'type'; values: readonly string[] }
  | {
      facet: 'statement';
      property: string;
      qualifiers?: readonly FilterQualifier[];
      values: readonly string[];
      concept?: ConceptSelection;
      inverse?: true;
    }
  | { facet: 'statement'; property: string; qualifiers?: readonly FilterQualifier[]; range: FilterRange };

const sortedValues = (values: readonly string[]) => [...new Set(values)].sort();

/** Recheck candidates against current anchor snapshots; any failed read rejects the whole page. */
export async function checkHits(
  source: SubjectSource,
  hits: readonly Hit[],
  clauses: ReadonlyMap<string, FactClause>,
  options?: {
    concurrency?: number;
    filter?: FilterDocument;
    relationProperties?: readonly string[];
    spoilerThreshold?: SpoilerThreshold;
    observeRelationRelease?: () => Promise<CurrentRelationRelease | null>;
  },
): Promise<{ passed: { hit: Hit; subject: IndexedSubject }[]; dropped: number; relationRejected?: true }> {
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
  const releaseBefore = hasInverse ? await options!.observeRelationRelease!() : undefined;
  if (hasInverse && !releaseBefore) return { passed: [], dropped: hits.length, relationRejected: true };
  const relationProperties = new Set(options?.relationProperties);
  let relationRejected = false;
  const hints = new Map<string, number>();
  if (plan) {
    for (const [name, clause] of clauses) {
      const index = plan.indices.get(currentClauseKey(clause));
      if (index !== undefined) hints.set(name, index);
    }
  }

  const groups = new Map<number, { ids: Set<string>; candidates: { hit: Hit; index: number }[] }>();
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

  const checked: ({ hit: Hit; subject: IndexedSubject } | undefined)[] = new Array(hits.length);
  const partitions = [...groups];
  const lifetime = new RequestSourceLifetime();
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
        for (const [id, subject] of read.value.subjects) {
          subjects.set(id, subject);
          positions.set(id, read.value.position);
        }
      }
      type Point = { probe: RelationFacetProbe; inverse?: true; result?: RelationFacetMatch };
      const points = new Map<string, Point>();
      const evaluations = new Map<string, () => { passed: boolean; relationRejected: boolean }>();
      const eligible: { hit: Hit; subject: IndexedSubject; index: number }[] = [];
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
          const values: (boolean | Point[])[] = new Array(plan.leaves.length);
          for (const leaf of order) {
            const clause = plan.leaves[leaf]!;
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
          evaluations.set(subject.id, () => {
            const resolved = values.map((value) =>
              typeof value === 'boolean' ? value : anyCurrentMatch(value.map((point) => point.result!)),
            );
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
                  return (
                    Array.isArray(value) &&
                    (plan.positive.has(leaf) ||
                      (clause.facet === 'statement' &&
                        (!!clause.qualifiers?.length ||
                          options?.spoilerThreshold !== undefined ||
                          ('values' in clause && clause.inverse === true))))
                  );
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
                : holdsCurrentStatements(subject.statements, clause))
            );
          })
        )
          continue;
        checked[index] = { hit, subject };
      }
      const pending = [...points.values()];
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
                source,
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
            if (!source.matchRelationFacets) throw new Error('Relation disclosure requires relation facet probes');
            return source.matchRelationFacets(
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
      // Reanchor the complete inverse window, including changes between separate native batches
      // and the gap between the original candidate read and the seam's first read.
      const retired = new Set<string>();
      if (pending.some((point) => point.inverse)) {
        for (let offset = 0; offset < ids.length; offset += REQUEST_SOURCE_KEYS) {
          const chunk = ids.slice(offset, offset + REQUEST_SOURCE_KEYS);
          const read = await lifetime.start(async () => {
            const snapshot = await source.read(partition, chunk);
            return { position: snapshot.position, subjects: validateRequestSourceSnapshot(snapshot, partition, chunk) };
          });
          if (!read.ok) return;
          for (const id of chunk) {
            const before = subjects.get(id);
            const after = read.value.subjects.get(id);
            if (
              !before ||
              !after ||
              positions.get(id) !== read.value.position ||
              after.visibility !== 'visible' ||
              after.redirect !== null ||
              after.type !== before.type ||
              after.securityRevision !== before.securityRevision
            )
              retired.add(id);
          }
        }
      }
      for (const { hit, subject, index } of eligible) {
        const result = evaluations.get(subject.id)!();
        if (retired.has(subject.id)) {
          relationRejected = true;
          continue;
        }
        if (result.passed) checked[index] = { hit, subject };
        relationRejected ||= result.relationRejected;
      }
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
  if (hasInverse) {
    const releaseAfter = await options!.observeRelationRelease!();
    if (releaseAfter?.digest !== releaseBefore!.digest || releaseAfter?.head !== releaseBefore!.head)
      return { passed: [], dropped: hits.length, relationRejected: true };
  }
  const passed = checked.filter((entry) => entry !== undefined);
  return { passed, dropped: hits.length - passed.length, ...(relationRejected ? { relationRejected: true } : {}) };
}
