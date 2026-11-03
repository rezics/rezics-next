import type { KernelClient, SubjectRead } from '@rezics/client';
import { pickText } from '@rezics/composition';
import type { Release } from '@rezics/definitions';
import { candidateFailure, type CandidateFailure } from '../../../subject/candidates';
import { CONCEPT_PAGE_CAP, typeExtends } from '../../pages/graph-browser';

export const conceptRequested = {
  type: 'skos:Concept',
  scheme: 'skos:ConceptScheme',
  inScheme: 'skos:inScheme',
  broader: 'skos:broader',
  narrower: 'skos:narrower',
} as const;

export type ConceptSchemeRef = {
  id: string;
  label: string;
  lang: string | null;
  source?: string;
};
export type ConceptHierarchyRow = { id: string; label: string; lang: string | null; direction: 'broader' | 'narrower' };
export type ConceptRead =
  | CandidateFailure
  | {
      ok: true;
      public: SubjectRead;
      admitted: boolean;
      retired: boolean;
      aliases: { text: string; lang: string | null }[];
      definition: { text: string; lang: string | null } | null;
      schemes: ConceptSchemeRef[];
      codes: { property: string; label: string; value: string; unknown: boolean }[];
      hierarchy: ConceptHierarchyRow[];
      next: string | null;
      spoiler: boolean;
      session?: string | undefined;
    };

type Definitions = Pick<Release, 'types' | 'properties'> & { digest?: string };

function headersOf(authorization?: string, session?: string) {
  return {
    ...(authorization ? { authorization } : {}),
    ...(session ? { 'rezics-session-token': session } : {}),
  };
}

function tokenOf(result: { headers?: HeadersInit | undefined }) {
  return new Headers(result.headers ?? {}).get('rezics-session-token') || undefined;
}

export function conceptTypeAdmitted(release: Definitions, type: string) {
  return typeExtends(release, type, conceptRequested.type) || typeExtends(release, type, conceptRequested.scheme);
}

function relatedLabel(related: SubjectRead['related'], id: string, locale: string) {
  const summary = related[id];
  if (!summary || !('labels' in summary)) return;
  return pickText(summary.labels ?? {}, locale);
}

export async function readSourceConcept(
  client: KernelClient,
  authorization: string | undefined,
  release: Definitions,
  id: string,
  locale: string,
  input: {
    cursor?: string | undefined;
    session?: string | undefined;
    role?: string | undefined;
    pin?: string | undefined;
  },
): Promise<ConceptRead> {
  try {
    const headers = headersOf(authorization, input.session);
    const current = await client.subjects({ id }).get({ headers });
    if (current.status !== 200 || !current.data) return candidateFailure(current.status);
    if (current.data.subject.id !== id) return candidateFailure(400);
    const admitted = conceptTypeAdmitted(release, current.data.subject.type);
    if (!admitted) {
      return {
        ok: true,
        public: current.data,
        admitted: false,
        retired: false,
        aliases: [],
        definition: null,
        schemes: [],
        codes: input.role ? [{ property: 'role', label: input.role, value: input.role, unknown: true }] : [],
        hierarchy: [],
        next: null,
        spoiler: false,
      };
    }
    const retired = !!input.pin && input.pin !== (release.digest ?? current.data.subject.release);
    const aliases = Object.entries(current.data.subject.aliases)
      .flatMap(([lang, values]) => values.map((text) => ({ text, lang })))
      .filter((alias, index, list) => list.findIndex((entry) => entry.text === alias.text) === index);
    const definition = pickText(current.data.subject.descriptions, locale);
    const schemes: ConceptSchemeRef[] = (current.data.subject.statements[conceptRequested.inScheme] ?? []).flatMap(
      (statement) => {
        const target = statement.value.type === 'value' ? statement.value.content : undefined;
        if (typeof target !== 'string') return [];
        const label = relatedLabel(current.data.related, target, locale);
        if (!label) return [{ id: target, label: '', lang: null }];
        return [{ id: target, label: label.text, lang: label.lang }];
      },
    );
    const codes = Object.entries(current.data.subject.statements).flatMap(([property, statements]) => {
      const definition = release.properties[property];
      if (!definition || (definition.datatype !== 'external-id' && property !== 'schema:sameAs')) return [];
      return statements.flatMap((statement) => {
        if (statement.value.type !== 'value' || typeof statement.value.content !== 'string') return [];
        return [
          {
            property,
            label: pickText(definition.labels, locale).text,
            value: statement.value.content,
            unknown: false,
          },
        ];
      });
    });
    if (input.role && !codes.some((code) => code.value === input.role)) {
      codes.push({ property: 'role', label: input.role, value: input.role, unknown: true });
    }
    const broader = current.data.subject.statements[conceptRequested.broader] ?? [];
    const hierarchy: ConceptHierarchyRow[] = broader.flatMap((statement) => {
      const target = statement.value.type === 'value' ? statement.value.content : undefined;
      if (typeof target !== 'string') return [];
      const label = relatedLabel(current.data.related, target, locale);
      return [{ id: target, label: label?.text ?? '', lang: label?.lang ?? null, direction: 'broader' as const }];
    });
    let next: string | null = null;
    let session = tokenOf(current) ?? input.session;
    if (release.properties[conceptRequested.broader]?.relation?.inverse === conceptRequested.narrower) {
      const page = await client.subjects({ id }).links.get({
        query: {
          property: conceptRequested.broader,
          language: locale,
          limit: CONCEPT_PAGE_CAP,
          ...(input.cursor ? { cursor: input.cursor } : {}),
        },
        headers: headersOf(authorization, session),
      });
      if (page.status === 200 && page.data && 'links' in page.data) {
        session = tokenOf(page) ?? session;
        next = page.data.next;
        for (const row of page.data.links) {
          hierarchy.push({
            id: row.subject,
            label: row.summary?.label?.value ?? '',
            lang: row.summary?.label?.language ?? null,
            direction: 'narrower',
          });
        }
      }
    }
    const spoiler = Object.values(current.data.subject.statements).some((statements) =>
      statements.some((statement) =>
        statement.qualifiers.some(
          (part) => part.property.id === 'rezics:spoiler' && part.value.type === 'value' && part.value.content === true,
        ),
      ),
    );
    return {
      ok: true,
      public: current.data,
      admitted: true,
      retired,
      aliases,
      definition: definition.text ? definition : null,
      schemes,
      codes,
      hierarchy,
      next,
      spoiler,
      ...(session ? { session } : {}),
    };
  } catch {
    return candidateFailure(503);
  }
}
