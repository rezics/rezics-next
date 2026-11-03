import { FilterError, parseFilter, type FilterQualifier, type FilterRelease } from '@rezics/filter';
import { validateRequestSourceSnapshot } from './request-source-snapshot.ts';
import {
  MAX_RELATION_FACET_PROBES,
  subjectPartition,
  type RelationFacetMatch,
  type RelationFacetProbe,
  type SubjectSource,
} from './source.ts';

/** An inverse edge from a selected work to the candidate Character or Person. */
export type InverseRelationFacetProbe = {
  subject: string;
  source: string;
  property: string;
  qualifiers?: readonly FilterQualifier[];
};

export type CurrentRelationRelease = { digest: string; head: number; release: FilterRelease };

/** No release permission survives foreign disclosure I/O. Missing/replaced releases withhold the window. */
export async function withCurrentRelationRelease<T>(
  observe: () => Promise<CurrentRelationRelease | null>,
  work: (release: FilterRelease) => Promise<T>,
  unavailable: T,
): Promise<T> {
  const before = await observe();
  if (!before) return unavailable;
  const result = await work(before.release);
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
        Object.keys(probe).some((key) => !['subject', 'source', 'property', 'qualifiers'].includes(key)) ||
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
