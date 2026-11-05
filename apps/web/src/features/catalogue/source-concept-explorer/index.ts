import type { KernelClient, SubjectRead } from '@rezics/client';
import { pickText } from '@rezics/composition';
import type { Release } from '@rezics/definitions';
import { facetProperties, type FilterRelease } from '@rezics/filter';
import { spoilerLevel } from '../../pages/shared';
import { personEvidenceFits } from '../person-reader/model';
import { candidateFailure, type CandidateFailure } from '../../../subject/candidates';
import { CONCEPT_PAGE_CAP, typeExtends } from '../../pages/graph-browser';
import { conditionMetadata, type ConditionMetadata } from '../../../search/condition-editor-model';

export const conceptContinuationLimit = 4096;
export function validConceptCursor(cursor: string | undefined): boolean {
  return cursor === undefined || new TextEncoder().encode(cursor).byteLength <= conceptContinuationLimit;
}

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
  readable: boolean;
  conceptPage: boolean;
};
export type ConceptHierarchyRow = {
  id: string;
  label: string;
  lang: string | null;
  type: string;
  direction: 'broader' | 'narrower';
  conceptPage: boolean;
};
export type ConceptHierarchyState = 'available' | 'lagging' | 'preparing' | 'unavailable' | 'unsupported';
export type ConceptViewerActions =
  | { state: 'available'; account: { id: string } | null; actions: { action: string; operations: string[] }[] }
  | { state: 'unavailable' };
export type ConceptWorksAdmission =
  | {
      state: 'available';
      types: { id: string; labels: Record<string, string> }[];
      properties: { id: string; labels: Record<string, string>; types: string[] }[];
      metadata: ConditionMetadata;
    }
  | { state: 'unsupported'; types: []; properties: []; metadata: null };
export type ConceptRead =
  | (CandidateFailure & { oversized?: true })
  | {
      ok: true;
      public: SubjectRead;
      admitted: boolean;
      retired: boolean | null;
      requestedRole?: string | undefined;
      aliases: { text: string; lang: string | null }[];
      definition: { text: string; lang: string | null } | null;
      schemes: ConceptSchemeRef[];
      codes: { property: string; label: string; labelLang: string | null; value: string; unknown: boolean }[];
      broader: { rows: ConceptHierarchyRow[]; withheld: number };
      narrower: {
        state: ConceptHierarchyState;
        rows: ConceptHierarchyRow[];
        cursor?: string;
        next: string | null;
        exactEmpty: boolean;
      };
      works?: ConceptWorksAdmission;
      viewerActions: ConceptViewerActions;
      spoiler: boolean;
      session?: string | undefined;
    };

export type ConceptStatement = SubjectRead['subject']['statements'][string][number];
export const conceptEvidenceBounds = { bytes: 1024 * 1024, statements: 4096 };

/** Admit the whole source before expanding aliases, assertions or nested disclosed summaries. */
export function conceptSourceFits(read: SubjectRead): boolean {
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
  let expanded = bytes(read);
  if (expanded > conceptEvidenceBounds.bytes) return false;
  let count = 0;
  const summaries = new Map<string, number>();
  for (const statements of Object.values(read.subject.statements)) {
    count += statements.length;
    if (count > conceptEvidenceBounds.statements) return false;
    for (const statement of statements) {
      if (!personEvidenceFits(statement)) return false;
      for (const part of [statement, ...statement.qualifiers, ...statement.references.flatMap((ref) => ref.parts)]) {
        const content = part.value.type === 'value' ? part.value.content : undefined;
        const targets = [part.property.id];
        if (part.property.data_type === 'wikibase-item' && typeof content === 'string') targets.push(content);
        if (part.property.data_type === 'quantity' && isRecord(content) && typeof content.unit === 'string')
          targets.push(content.unit);
        for (const target of targets) {
          if (!Object.hasOwn(read.related, target)) continue;
          let size = summaries.get(target);
          if (size === undefined) {
            size = bytes(read.related[target]);
            summaries.set(target, size);
          }
          expanded += size;
          if (expanded > conceptEvidenceBounds.bytes) return false;
        }
      }
    }
  }
  return true;
}

type Definitions = Pick<Release, 'types' | 'properties'> & {
  digest?: string;
  filters?: NonNullable<FilterRelease['filters']>;
};

export function conceptWorksAdmission(release: Definitions, current: boolean): ConceptWorksAdmission {
  if (!current) return { state: 'unsupported', types: [], properties: [], metadata: null };
  const types = Object.entries(release.types).filter(([id]) => typeExtends(release, id, 'schema:CreativeWork'));
  const propertyTypes = new Map<string, string[]>();
  for (const [type] of types)
    for (const property of facetProperties(release, [type]))
      if (release.properties[property]?.datatype === 'wikibase-item') {
        const values = propertyTypes.get(property) ?? [];
        values.push(type);
        propertyTypes.set(property, values);
      }
  if (!types.length || !propertyTypes.size) return { state: 'unsupported', types: [], properties: [], metadata: null };

  const typeDefinitions = Object.fromEntries(types);
  const propertyIds = new Set<string>();
  for (const [type] of types)
    for (const property of facetProperties(release, [type])) {
      propertyIds.add(property);
      for (const qualifier of release.properties[property]?.qualifiers ?? []) propertyIds.add(qualifier);
    }
  const propertyDefinitions = Object.fromEntries(
    [...propertyIds].flatMap((property) => {
      const definition = release.properties[property];
      return definition ? [[property, definition]] : [];
    }),
  );
  const metadata = conditionMetadata({
    types: typeDefinitions,
    properties: propertyDefinitions,
    ...(release.filters ? { filters: release.filters } : {}),
  });
  const admission: ConceptWorksAdmission = {
    state: 'available',
    types: types.map(([id, definition]) => ({ id, labels: definition.labels ?? {} })),
    properties: [...propertyTypes].map(([id, typeIds]) => ({
      id,
      labels: release.properties[id]?.labels ?? {},
      types: typeIds,
    })),
    metadata,
  };
  if (new TextEncoder().encode(JSON.stringify(admission)).byteLength > 65_536)
    return { state: 'unsupported', types: [], properties: [], metadata: null };
  return admission;
}

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

function relatedSummary(related: SubjectRead['related'], id: string) {
  const summary = related[id];
  return summary && 'labels' in summary ? summary : undefined;
}

function relatedLabel(related: SubjectRead['related'], id: string, locale: string) {
  const summary = relatedSummary(related, id);
  return summary ? pickText(summary.labels ?? {}, locale) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isViewerAction(value: unknown): value is { action: string; operations: string[] } {
  return (
    isRecord(value) &&
    typeof value.action === 'string' &&
    Array.isArray(value.operations) &&
    value.operations.every((operation) => typeof operation === 'string')
  );
}

export function actionState(current: Pick<SubjectRead, 'account'>): ConceptViewerActions {
  if (!('viewerActions' in current) || !isRecord(current.viewerActions)) return { state: 'unavailable' };
  const state = current.viewerActions;
  if (state.state !== 'available' || !Array.isArray(state.actions) || !state.actions.every(isViewerAction))
    return { state: 'unavailable' };
  return { state: 'available', account: current.account, actions: state.actions };
}

function relationValue(statement: SubjectRead['subject']['statements'][string][number]) {
  return statement.value.type === 'value' && typeof statement.value.content === 'string'
    ? statement.value.content
    : undefined;
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
  },
): Promise<ConceptRead> {
  try {
    if (!validConceptCursor(input.cursor)) return candidateFailure(400);
    const headers = headersOf(authorization, input.session);
    const query = { language: locale, includeViewerActions: true };
    const current = await client.subjects({ id }).get({ query, headers });
    if (current.status !== 200 || !current.data) return candidateFailure(current.status);
    if (current.data.subject.id !== id) return candidateFailure(400);
    if (!conceptSourceFits(current.data)) return { ok: false, reason: 'unavailable', oversized: true };
    const admitted = conceptTypeAdmitted(release, current.data.subject.type);
    let session = tokenOf(current) ?? input.session;
    const viewerActions = actionState(current.data);
    if (!admitted) {
      return {
        ok: true,
        public: current.data,
        admitted: false,
        retired: null,
        aliases: [],
        definition: null,
        schemes: [],
        requestedRole: input.role,
        codes: [],
        broader: { rows: [], withheld: 0 },
        narrower: {
          state: 'unsupported',
          rows: [],
          next: null,
          exactEmpty: false,
          ...(input.cursor ? { cursor: input.cursor } : {}),
        },
        works: { state: 'unsupported', types: [], properties: [], metadata: null },
        viewerActions,
        spoiler: false,
        ...(session ? { session } : {}),
      };
    }

    const retired = release.digest ? current.data.subject.release !== release.digest : null;
    const seenAliases = new Set<string>();
    const aliases = Object.entries(current.data.subject.aliases).flatMap(([lang, values]) =>
      values.flatMap((text) => {
        const key = JSON.stringify([lang, text]);
        if (seenAliases.has(key)) return [];
        seenAliases.add(key);
        return [{ text, lang }];
      }),
    );
    const definition = pickText(current.data.subject.descriptions, locale);
    const schemes: ConceptSchemeRef[] = [];
    const schemeIds = new Set<string>();
    for (const statement of current.data.subject.statements[conceptRequested.inScheme] ?? []) {
      const target = relationValue(statement);
      if (!target || schemeIds.has(target)) continue;
      schemeIds.add(target);
      const summary = relatedSummary(current.data.related, target);
      const label = relatedLabel(current.data.related, target, locale);
      schemes.push({
        id: target,
        label: label?.text ?? '',
        lang: label?.lang ?? null,
        readable: !!summary,
        conceptPage: !!summary?.type && conceptTypeAdmitted(release, summary.type),
      });
    }

    // Codes retain the datatype from the supplied source, including retired/unknown properties.
    // Active vocabulary labels never reinterpret a retired source release.
    const codes = Object.entries(current.data.subject.statements).flatMap(([property, statements]) => {
      const definition = release.properties[property];
      const label =
        retired === false && definition?.datatype === 'external-id'
          ? pickText(definition.labels, locale)
          : relatedLabel(current.data.related, property, locale);
      return statements.flatMap((statement) => {
        if (statement.property.data_type !== 'external-id') return [];
        const value = relationValue(statement);
        if (value === undefined) return [];
        return [
          {
            property,
            label: label?.text || property,
            labelLang: label?.lang ?? null,
            value,
            unknown: !definition || retired !== false,
          },
        ];
      });
    });

    const broaderRows: ConceptHierarchyRow[] = [];
    let broaderWithheld = 0;
    for (const statement of current.data.subject.statements[conceptRequested.broader] ?? []) {
      const target = relationValue(statement);
      if (!target) continue;
      const summary = relatedSummary(current.data.related, target);
      const label = relatedLabel(current.data.related, target, locale);
      if (!summary || !label?.text) {
        broaderWithheld++;
        continue;
      }
      broaderRows.push({
        id: target,
        label: label.text,
        lang: label.lang,
        type: summary.type ?? 'unknown',
        direction: 'broader',
        conceptPage: !!summary.type && conceptTypeAdmitted(release, summary.type),
      });
    }

    let narrower: Extract<ConceptRead, { ok: true }>['narrower'] = {
      state:
        release.properties[conceptRequested.broader]?.relation?.inverse === conceptRequested.narrower
          ? 'unavailable'
          : 'unsupported',
      rows: [],
      ...(input.cursor ? { cursor: input.cursor } : {}),
      next: null,
      exactEmpty: false,
    };
    if (narrower.state !== 'unsupported') {
      try {
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
          if (
            page.data.links.length > CONCEPT_PAGE_CAP ||
            new TextEncoder().encode(JSON.stringify(page.data)).byteLength > conceptEvidenceBounds.bytes
          )
            return { ok: false, reason: 'unavailable', oversized: true };
          session = tokenOf(page) ?? session;
          narrower = {
            state: page.data.freshness.caught_up ? 'available' : 'lagging',
            rows: page.data.links.flatMap((row) => {
              const label = row.summary?.label;
              if (!row.summary.id || row.summary.id !== row.subject || !label?.value) return [];
              return [
                {
                  id: row.summary.id,
                  label: label.value,
                  lang: label.language,
                  type: row.summary.type,
                  direction: 'narrower' as const,
                  conceptPage: conceptTypeAdmitted(release, row.summary.type),
                },
              ];
            }),
            ...(input.cursor ? { cursor: input.cursor } : {}),
            next: page.data.next,
            exactEmpty:
              page.data.freshness.caught_up === true && page.data.count?.exact === true && page.data.count.value === 0,
          };
        } else {
          const code = page.data && 'code' in page.data ? page.data.code : undefined;
          if (page.status === 401 || page.status === 403 || page.status === 404) return candidateFailure(page.status);
          narrower = {
            ...narrower,
            state: page.status === 503 && code === 'semantic_not_ready' ? 'preparing' : 'unavailable',
          };
        }
      } catch {
        narrower = { ...narrower, state: 'unavailable' };
      }
    }
    const spoiler = Object.values(current.data.subject.statements).some((statements) =>
      statements.some((statement) => spoilerLevel(statement) > 0),
    );
    return {
      ok: true,
      public: current.data,
      admitted: true,
      retired,
      requestedRole: input.role,
      aliases,
      definition: definition.text ? definition : null,
      schemes,
      codes,
      broader: { rows: broaderRows, withheld: broaderWithheld },
      narrower,
      works: conceptWorksAdmission(release, retired === false),
      viewerActions,
      spoiler,
      ...(session ? { session } : {}),
    };
  } catch {
    return candidateFailure(503);
  }
}
