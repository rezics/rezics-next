import type { FilterDocument, FilterQualifier, FilterRange } from '@rezics/filter';
import {
  MAX_RELATION_FACET_PROBES,
  subjectPartition,
  type IndexedSubject,
  type RelationFacetProbe,
  type SubjectSource,
} from '../source.ts';

/** One OpenSearch hit, including the indexed partition, security revision and matched query names. */
export type Hit = { id: string; partition: number; securityRevision: number; matched: readonly string[] };

/** A filter leaf compiled by the route, keyed by its query name. */
export type FactClause =
  | { facet: 'type'; values: readonly string[] }
  | ({ facet: 'statement'; property: string; qualifiers?: readonly FilterQualifier[] } & (
      | { values: readonly string[] }
      | { range: FilterRange }
    ));

function holds(subject: IndexedSubject, clause: FactClause): boolean {
  if (clause.facet === 'type') return clause.values.includes(subject.type);
  return subject.statements.some((statement) => {
    if (statement.property !== clause.property) return false;
    if ('values' in clause) {
      if (!clause.values.includes(statement.value)) return false;
    } else {
      const { gte, lte, unit } = clause.range;
      const facet = statement.facet;
      let value: number;
      if (unit === undefined) {
        if (facet?.kind !== 'time') return false;
        value = facet.year;
      } else {
        if (facet?.kind !== 'quantity' || facet.unit !== unit) return false;
        value = facet.amount;
      }
      if (!Number.isFinite(value) || (gte !== undefined && value < gte) || (lte !== undefined && value > lte))
        return false;
    }
    return (clause.qualifiers ?? []).every((qualifier) =>
      statement.qualifiers?.some(
        (value) => value.property === qualifier.property && qualifier.in.includes(value.value),
      ),
    );
  });
}

const sortedValues = (values: readonly string[]) => [...new Set(values)].sort();

function normalizedQualifiers(qualifiers: readonly FilterQualifier[] = []): FilterQualifier[] {
  const clauses = new Map<string, FilterQualifier>();
  for (const { property, in: values } of qualifiers) {
    const clause = { property, in: sortedValues(values) };
    clauses.set(JSON.stringify(clause), clause);
  }
  return [...clauses.keys()].sort().map((key) => clauses.get(key)!);
}

/** Semantic keys let named index clauses prioritize the same leaves in the complete filter. */
function clauseKey(clause: FactClause): string {
  if (clause.facet === 'type') return JSON.stringify(['type', sortedValues(clause.values)]);
  return JSON.stringify([
    'statement',
    clause.property,
    'values' in clause
      ? ['values', sortedValues(clause.values)]
      : ['range', clause.range.gte, clause.range.lte, clause.range.unit],
    normalizedQualifiers(clause.qualifiers),
  ]);
}

function filterPlan(filter: FilterDocument) {
  const leaves: FactClause[] = [];
  const indices = new Map<string, number>();
  const positive = new Set<number>();
  type Evaluate = (values: readonly boolean[]) => boolean;
  function visit(node: FilterDocument, negated = false): Evaluate {
    if ('and' in node) {
      const children = node.and.map((child) => visit(child, negated));
      return (values) => children.every((child) => child(values));
    }
    if ('or' in node) {
      const children = node.or.map((child) => visit(child, negated));
      return (values) => children.some((child) => child(values));
    }
    if ('not' in node) {
      const child = visit(node.not, !negated);
      return (values) => !child(values);
    }
    if ('saved' in node) throw new Error('Disclose only admitted, expanded filters');
    const clause: FactClause =
      'type' in node
        ? { facet: 'type', values: node.type.in }
        : {
            facet: 'statement',
            property: node.statement.property,
            ...(node.statement.qualifiers ? { qualifiers: node.statement.qualifiers } : {}),
            ...('in' in node.statement ? { values: node.statement.in } : { range: node.statement.range }),
          };
    const key = clauseKey(clause);
    let index = indices.get(key);
    if (index === undefined) {
      index = leaves.length;
      indices.set(key, index);
      leaves.push(clause);
    }
    if (!negated) positive.add(index);
    const leaf = index;
    return (values) => values[leaf]!;
  }
  const evaluate = visit(filter);
  return { leaves, indices, positive, evaluate };
}

/** Recheck candidates against current anchor snapshots; any failed read rejects the whole page. */
export async function checkHits(
  source: SubjectSource,
  hits: readonly Hit[],
  clauses: ReadonlyMap<string, FactClause>,
  options?: { concurrency?: number; filter?: FilterDocument; relationProperties?: readonly string[] },
): Promise<{ passed: { hit: Hit; subject: IndexedSubject }[]; dropped: number; relationRejected?: true }> {
  const concurrency = options?.concurrency ?? 8;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1)
    throw new RangeError('Concurrency must be a positive safe integer');

  const plan = options?.filter === undefined ? undefined : filterPlan(options.filter);
  const relationProperties = new Set(options?.relationProperties);
  let relationRejected = false;
  const hints = new Map<string, number>();
  if (plan) {
    for (const [name, clause] of clauses) {
      const index = plan.indices.get(clauseKey(clause));
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
  const partitions = groups.entries();
  async function worker(): Promise<void> {
    for (const [partition, group] of partitions) {
      const snapshot = await source.read(partition, [...group.ids]);
      const subjects = new Map(snapshot.subjects.map((subject) => [subject.id, subject]));
      type Point = { probe: RelationFacetProbe; result?: boolean };
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
              clause.facet === 'statement' && relationProperties.has(clause.property) && plan.positive.has(leaf);
            if (clause.facet === 'statement' && (overflow || live) && clause.qualifiers !== undefined)
              throw new Error('Qualified relation overflow cannot be checked by unqualified probes');
            if (clause.facet !== 'statement' || !('values' in clause) || !(overflow || live)) {
              values[leaf] = holds(subject, clause);
              continue;
            }
            values[leaf] = sortedValues(clause.values).map((value) => {
              const probe: RelationFacetProbe = {
                subject: subject.id,
                property: clause.property,
                value,
              };
              const key = JSON.stringify(probe);
              let point = points.get(key);
              if (!point) {
                point = { probe };
                points.set(key, point);
              }
              return point;
            });
          }
          evaluations.set(subject.id, () => {
            const resolved = values.map((value) =>
              typeof value === 'boolean' ? value : value.some((point) => point.result === true),
            );
            const passed = plan.evaluate(resolved);
            return {
              passed,
              // Rejection after live positive-leaf evaluation invalidates the candidate total.
              // A shared leaf's true proof can also reject its negative occurrence.
              relationRejected:
                !passed && values.some((value, leaf) => Array.isArray(value) && plan.positive.has(leaf)),
            };
          });
          continue;
        }
        if (
          !hit.matched.every((name) => {
            const clause = clauses.get(name);
            return clause === undefined || holds(subject, clause);
          })
        )
          continue;
        checked[index] = { hit, subject };
      }
      const pending = [...points.values()];
      for (let offset = 0; offset < pending.length; offset += MAX_RELATION_FACET_PROBES) {
        if (!source.matchRelationFacets) throw new Error('Relation disclosure requires relation facet probes');
        const batch = pending.slice(offset, offset + MAX_RELATION_FACET_PROBES);
        const results = await source.matchRelationFacets(
          partition,
          batch.map((point) => point.probe),
        );
        if (!Array.isArray(results) || results.length !== batch.length)
          throw new Error('Malformed relation facet probe results');
        for (const [index, point] of batch.entries()) {
          const result = results[index];
          if (typeof result !== 'boolean') throw new Error('Malformed relation facet probe results');
          point.result = result;
        }
      }
      for (const { hit, subject, index } of eligible) {
        const result = evaluations.get(subject.id)!();
        if (result.passed) checked[index] = { hit, subject };
        relationRejected ||= result.relationRejected;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, groups.size) }, () => worker()));
  const passed = checked.filter((entry) => entry !== undefined);
  return { passed, dropped: hits.length - passed.length, ...(relationRejected ? { relationRejected: true } : {}) };
}
