import { subjectPartition, type IndexedSubject, type SubjectSource } from '../source.ts';

/** One OpenSearch hit, including the indexed partition, security revision and matched query names. */
export type Hit = { id: string; partition: number; securityRevision: number; matched: readonly string[] };

/** A filter leaf compiled by the route, keyed by its query name. */
export type FactClause =
  | { facet: 'type'; values: readonly string[] }
  | { facet: 'statement'; property: string; values: readonly string[] };

function holds(subject: IndexedSubject, clause: FactClause): boolean {
  if (clause.facet === 'type') return clause.values.includes(subject.type);
  return subject.statements.some(
    (statement) => statement.property === clause.property && clause.values.includes(statement.value),
  );
}

/** Recheck candidates against current anchor snapshots; any failed read rejects the whole page. */
export async function checkHits(
  source: SubjectSource,
  hits: readonly Hit[],
  clauses: ReadonlyMap<string, FactClause>,
  options?: { concurrency?: number },
): Promise<{ passed: { hit: Hit; subject: IndexedSubject }[]; dropped: number }> {
  const concurrency = options?.concurrency ?? 8;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1)
    throw new RangeError('Concurrency must be a positive safe integer');

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
      for (const { hit, index } of group.candidates) {
        const subject = subjects.get(hit.id);
        if (
          !subject ||
          subject.visibility !== 'visible' ||
          subject.redirect !== null ||
          subject.securityRevision !== hit.securityRevision
        )
          continue;
        if (
          !hit.matched.every((name) => {
            const clause = clauses.get(name);
            return clause === undefined || holds(subject, clause);
          })
        )
          continue;
        checked[index] = { hit, subject };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, groups.size) }, () => worker()));
  const passed = checked.filter((entry) => entry !== undefined);
  return { passed, dropped: hits.length - passed.length };
}
