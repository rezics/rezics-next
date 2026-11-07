import { type DiscoveryFilterDocument, type FilterQualifier, type SpoilerThreshold } from '@rezics/filter';
import { validateRequestSourceSnapshot } from './request-source-snapshot.ts';
import { MAX_RELATION_FACET_PROBES, subjectPartition, type IndexedSubject, type SubjectSource } from './source.ts';
import { publicAliases } from './document-names.ts';
import { chooseTexts } from './disclosure/admission.ts';
import {
  matchInverseRelationFacets,
  withCurrentRelationRelease,
  type CurrentRelationRelease,
  type InverseRelationFacetProbe,
} from './disclosure/check.ts';
export {
  matchInverseRelationFacets,
  withCurrentRelationRelease,
  type CurrentRelationRelease,
  type InverseRelationFacetProbe,
} from './disclosure/check.ts';
import type { CharacterPersonDiscoveryContexts, DiscoveryContextSubject } from './discovery.ts';
import { createReleasedRelationDirectionResolver } from '@rezics/definitions';

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

function projectContextSubject(
  subject: IndexedSubject,
  languages: readonly string[] | undefined,
): DiscoveryContextSubject {
  const aliases = publicAliases(subject);
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
    sources.map((source): InverseRelationFacetProbe => ({
      subject: subject.id,
      source,
      property,
      ...(qualifiers === undefined ? {} : { qualifiers }),
      ...(options.spoilerThreshold === undefined ? {} : { spoilerThreshold: options.spoilerThreshold }),
    })),
  );
  const unique = [...new Map(probes.map((probe) => [JSON.stringify(probe), probe])).values()];
  const empty = { items: [], next: false };
  if (!unique.length) return { credits: empty, appearances: empty };
  const result = await withCurrentRelationRelease(
    options.observeRelationRelease,
    async (_release, pin) => {
      if (subject.type === 'schema:Person' && pin.definitions) {
        const resolver = createReleasedRelationDirectionResolver(pin.definitions, pin.digest);
        const admission = resolver.resolve(subject.type, 'wdt:P725', 'inverse');
        if (admission.state !== 'admitted') return null;
        const admittedQualifiers = new Set(admission.qualifiers.map(({ id }) => id));
        if (unique.some((probe) => probe.qualifiers?.some(({ property }) => !admittedQualifiers.has(property))))
          return null;
      }
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
