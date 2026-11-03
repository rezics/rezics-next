import {
  FilterError,
  parseFilter,
  type DiscoveryFilterDocument,
  type FilterQualifier,
  type FilterRelease,
  type SpoilerThreshold,
} from '@rezics/filter';
import { validateRequestSourceSnapshot } from './request-source-snapshot.ts';
import {
  MAX_RELATION_FACET_PROBES,
  subjectPartition,
  type IndexedSubject,
  type RelationFacetMatch,
  type RelationFacetProbe,
  type SubjectSource,
} from './source.ts';
import { chooseTexts } from './hits.ts';
import type { CharacterPersonDiscoveryContexts, DiscoveryContextSubject } from './discovery.ts';

/** An inverse edge from a selected work to the candidate Character or Person. */
export type InverseRelationFacetProbe = {
  subject: string;
  source: string;
  property: string;
  qualifiers?: readonly FilterQualifier[];
  spoilerThreshold?: SpoilerThreshold;
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

type InverseContextClause = {
  property: string;
  sources: readonly string[];
  qualifiers?: readonly FilterQualifier[];
};

function inverseContextClauses(filter: DiscoveryFilterDocument | undefined): InverseContextClause[] {
  const found: InverseContextClause[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    const value = node as Record<string, unknown>;
    if (Array.isArray(value.and)) value.and.forEach(visit);
    else if (Array.isArray(value.or)) value.or.forEach(visit);
    else if (value.not) visit(value.not);
    else if (value.statement && typeof value.statement === 'object' && !Array.isArray(value.statement)) {
      const statement = value.statement as Record<string, unknown>;
      if (
        statement.inverse === true &&
        typeof statement.property === 'string' &&
        Array.isArray(statement.in) &&
        statement.in.every((source) => typeof source === 'string')
      )
        found.push({
          property: statement.property,
          sources: statement.in as string[],
          ...(Array.isArray(statement.qualifiers) ? { qualifiers: statement.qualifiers as FilterQualifier[] } : {}),
        });
    }
  };
  if (filter) visit(filter);
  return found;
}

function originalLanguage(subject: IndexedSubject): string | undefined {
  return subject.statements.find(({ property }) => property === 'schema:inLanguage')?.value;
}

function projectAliases(subject: IndexedSubject, languages: readonly string[] | undefined): Record<string, string[]> {
  const values = new Map<string, Set<string>>();
  for (const { language, value } of subject.aliases) {
    const selected = values.get(language) ?? new Set<string>();
    selected.add(value);
    values.set(language, selected);
  }
  const selectedLanguages = languages?.length ? languages : [...values.keys()].sort();
  return Object.fromEntries(
    selectedLanguages.flatMap((language) => {
      const aliases = values.get(language);
      return aliases?.size ? [[language, [...aliases].sort()]] : [];
    }),
  );
}

function projectContextSubject(subject: IndexedSubject, languages: readonly string[] | undefined): DiscoveryContextSubject {
  const aliases = projectAliases(subject, languages);
  return {
    id: subject.id,
    labels: chooseTexts(subject.labels, languages, originalLanguage(subject)),
    ...(Object.keys(aliases).length ? { aliases } : {}),
  };
}

/**
 * Project only source works named by admitted inverse leaves. The inverse matcher is the same
 * current statement and release-fenced path used for membership; a context link is never inferred
 * from an index sample or from a different credit.
 */
export async function projectCharacterPersonContexts(
  source: SubjectSource,
  subject: Pick<IndexedSubject, 'id' | 'type'>,
  filter: DiscoveryFilterDocument | undefined,
  options: {
    languages?: readonly string[];
    spoilerThreshold?: SpoilerThreshold;
    observeRelationRelease: () => Promise<CurrentRelationRelease | null>;
  },
): Promise<CharacterPersonDiscoveryContexts | null> {
  if (subject.type !== 'schema:Person' && subject.type !== 'schema:Character') return null;
  const relevantProperty = subject.type === 'schema:Person' ? 'wdt:P725' : 'wdt:P453';
  const clauses = inverseContextClauses(filter).filter(({ property }) => property === relevantProperty);
  const probes = clauses.flatMap(({ property, sources, qualifiers }) =>
    sources.map(
      (source): InverseRelationFacetProbe => ({
        subject: subject.id,
        source,
        property,
        ...(qualifiers === undefined ? {} : { qualifiers }),
        ...(options.spoilerThreshold === undefined ? {} : { spoilerThreshold: options.spoilerThreshold }),
      }),
    ),
  );
  const unique = [...new Map(probes.map((probe) => [JSON.stringify(probe), probe])).values()];
  const empty = { items: [], next: false };
  if (!unique.length) return { credits: empty, appearances: empty };
  const result = await withCurrentRelationRelease(
    options.observeRelationRelease,
    async () => {
      const admitted = new Set<string>();
      for (let offset = 0; offset < unique.length; offset += MAX_RELATION_FACET_PROBES) {
        const batch = unique.slice(offset, offset + MAX_RELATION_FACET_PROBES);
        const states = await matchInverseRelationFacets(
          source,
          subjectPartition(subject.id),
          batch,
          options.observeRelationRelease,
        );
        for (const [index, state] of states.entries()) if (state === true) admitted.add(batch[index]!.source);
      }

      const ordered = [...admitted].sort();
      const visible: DiscoveryContextSubject[] = [];
      const termIdsByPartition = new Map<number, Set<string>>();
      const termPositions = new Map<number, bigint>();
      for (let offset = 0; offset < ordered.length && visible.length <= CHARACTER_PERSON_CONTEXT_LIMIT; offset += 256) {
        const group = ordered.slice(offset, offset + 256);
        const byPartition = new Map<number, string[]>();
        for (const id of group) {
          const partition = subjectPartition(id);
          const values = byPartition.get(partition) ?? [];
          values.push(id);
          byPartition.set(partition, values);
        }
        const current = new Map<string, IndexedSubject>();
        for (const [partition, ids] of byPartition) {
          const snapshot = await source.read(partition, ids);
          const position = termPositions.get(partition);
          if (position !== undefined && snapshot.position !== position) return null;
          termPositions.set(partition, snapshot.position);
          const termIds = termIdsByPartition.get(partition) ?? new Set<string>();
          ids.forEach((id) => termIds.add(id));
          termIdsByPartition.set(partition, termIds);
          for (const [id, value] of validateRequestSourceSnapshot(snapshot, partition, ids))
            if (value.visibility === 'visible' && value.redirect === null) current.set(id, value);
        }
        // Recheck after term disclosure. A replaced or hidden source cannot retain its old link.
        const candidates = group.filter((id) => current.has(id));
        const candidateProbes = unique.filter((probe) => candidates.includes(probe.source));
        const stillCurrent = new Set<string>();
        for (let inner = 0; inner < candidateProbes.length; inner += MAX_RELATION_FACET_PROBES) {
          const page = candidateProbes.slice(inner, inner + MAX_RELATION_FACET_PROBES);
          const rechecked = await matchInverseRelationFacets(
            source,
            subjectPartition(subject.id),
            page,
            options.observeRelationRelease,
          );
          for (const [index, state] of rechecked.entries()) if (state === true) stillCurrent.add(page[index]!.source);
        }
        for (const id of candidates) {
          const row = current.get(id);
          if (row && stillCurrent.has(id)) visible.push(projectContextSubject(row, options.languages));
          if (visible.length > CHARACTER_PERSON_CONTEXT_LIMIT) break;
        }
      }
      // A work's label or visibility may change while its relation witness is being checked.
      // Keep the whole list only when every touched partition still has the observed position.
      for (const [partition, ids] of termIdsByPartition) {
        const orderedIds = [...ids];
        for (let offset = 0; offset < orderedIds.length; offset += 256) {
          const group = orderedIds.slice(offset, offset + 256);
          const snapshot = await source.read(partition, group);
          if (snapshot.position !== termPositions.get(partition)) return null;
          validateRequestSourceSnapshot(snapshot, partition, group);
        }
      }
      const makeList = (items: readonly DiscoveryContextSubject[]): CharacterPersonDiscoveryContexts['credits'] => ({
        items: items.slice(0, CHARACTER_PERSON_CONTEXT_LIMIT),
        next: items.length > CHARACTER_PERSON_CONTEXT_LIMIT,
      });
      return subject.type === 'schema:Person'
        ? { credits: makeList(visible), appearances: empty }
        : { credits: empty, appearances: makeList(visible) };
    },
    null,
  );
  return result;
}

export const CHARACTER_PERSON_CONTEXT_LIMIT = 3;
