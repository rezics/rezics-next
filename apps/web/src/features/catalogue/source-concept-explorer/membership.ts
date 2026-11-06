import type { KernelClient, SubjectRead } from '@rezics/client';
import type { Release } from '@rezics/definitions';
import { CONCEPT_PAGE_CAP, typeExtends } from '../../pages/graph-browser';

export type ConceptHierarchyState = 'available' | 'lagging' | 'preparing' | 'unavailable' | 'unsupported';
const membershipEvidenceBytes = 1024 * 1024;

export const membershipProperties = ['schema:genre', 'schema:keywords'] as const;
export type MembershipProperty = (typeof membershipProperties)[number];

export type ConceptMembershipRow = {
  id: string;
  label: string;
  lang: string | null;
  type: string;
  property: MembershipProperty;
  workPage: boolean;
  citations: { url: string }[];
};

export type ConceptMembership = {
  state: ConceptHierarchyState;
  rows: ConceptMembershipRow[];
  next: string | null;
  exactEmpty: boolean;
  withheld: number;
};

type Definitions = Pick<Release, 'types' | 'properties'> & { digest?: string };
type LinkPage = {
  links: {
    subject: string;
    property?: string;
    statement?: string;
    assertion?: SubjectRead['subject']['statements'][string][number];
    summary?: {
      id?: string;
      type?: string;
      label?: { value?: string; language?: string | null } | null;
    };
    related?: SubjectRead['related'];
  }[];
  next: string | null;
  freshness: { caught_up?: boolean };
  count?: { value: number; exact?: boolean };
};

function headersOf(authorization?: string, session?: string) {
  return {
    ...(authorization ? { authorization } : {}),
    ...(session ? { 'rezics-session-token': session } : {}),
  };
}

function tokenOf(result: { headers?: HeadersInit | undefined }) {
  return new Headers(result.headers ?? {}).get('rezics-session-token') || undefined;
}

function workTypeAdmitted(release: Definitions, type: string) {
  return typeExtends(release, type, 'schema:CreativeWork');
}

function citationUrls(assertion: SubjectRead['subject']['statements'][string][number] | undefined): { url: string }[] {
  if (!assertion) return [];
  const seen = new Set<string>();
  const urls: { url: string }[] = [];
  for (const reference of assertion.references) {
    for (const part of reference.parts) {
      if (part.property.id !== 'schema:url' || part.value.type !== 'value' || typeof part.value.content !== 'string')
        continue;
      if (seen.has(part.value.content)) continue;
      seen.add(part.value.content);
      urls.push({ url: part.value.content });
    }
  }
  return urls;
}

function membershipInverse(release: Definitions, property: MembershipProperty): boolean {
  const inverse = release.properties[property]?.relation?.inverse;
  return inverse === 'rezics:workInGenre' || inverse === 'rezics:taggedSubject';
}

export function emptyMembership(state: ConceptHierarchyState = 'unsupported'): ConceptMembership {
  return { state, rows: [], next: null, exactEmpty: false, withheld: 0 };
}

/** Inverse genre/keyword pages of currently adopted work membership. Hierarchy continuation stays separate. */
export async function readConceptMembership(
  client: KernelClient,
  authorization: string | undefined,
  release: Definitions,
  id: string,
  locale: string,
  input: { session?: string | undefined },
): Promise<{ membership: ConceptMembership; session?: string; oversized?: true; failure?: number }> {
  const admitted = membershipProperties.filter((property) => membershipInverse(release, property));
  if (!admitted.length) return { membership: emptyMembership('unsupported'), ...(input.session ? { session: input.session } : {}) };

  let session = input.session;
  const rows: ConceptMembershipRow[] = [];
  let withheld = 0;
  let next: string | null = null;
  let exactEmpty = true;
  let caughtUp = true;
  let preparing = false;
  let unavailable = false;

  for (const property of admitted) {
    try {
      const page = await client.subjects({ id }).links.get({
        query: { property, language: locale, limit: CONCEPT_PAGE_CAP },
        headers: headersOf(authorization, session),
      });
      if (page.status === 401 || page.status === 403 || page.status === 404)
        return { membership: emptyMembership('unavailable'), failure: page.status, ...(session ? { session } : {}) };
      if (page.status !== 200 || !page.data || !('links' in page.data)) {
        const code = page.data && 'code' in page.data ? page.data.code : undefined;
        if (page.status === 503 && code === 'semantic_not_ready') preparing = true;
        else unavailable = true;
        exactEmpty = false;
        continue;
      }
      const data = page.data as LinkPage;
      if (
        data.links.length > CONCEPT_PAGE_CAP ||
        new TextEncoder().encode(JSON.stringify(data)).byteLength > membershipEvidenceBytes
      )
        return { membership: emptyMembership('unavailable'), oversized: true, ...(session ? { session } : {}) };
      session = tokenOf(page) ?? session;
      if (!data.freshness.caught_up) caughtUp = false;
      if (data.next) next = data.next;
      if (!(data.freshness.caught_up === true && data.count?.exact === true && data.count.value === 0))
        exactEmpty = exactEmpty && data.links.length === 0 && !data.next;
      if (data.links.length) exactEmpty = false;
      for (const row of data.links) {
        const summary = row.summary;
        const label = summary?.label;
        if (!summary?.id || summary.id !== row.subject || !label?.value) {
          withheld += 1;
          continue;
        }
        if (!summary.type || !workTypeAdmitted(release, summary.type)) {
          withheld += 1;
          continue;
        }
        rows.push({
          id: summary.id,
          label: label.value,
          lang: label.language ?? null,
          type: summary.type,
          property,
          workPage: true,
          citations: citationUrls(row.assertion),
        });
      }
    } catch {
      unavailable = true;
      exactEmpty = false;
    }
  }

  const state: ConceptHierarchyState = preparing
    ? 'preparing'
    : unavailable
      ? 'unavailable'
      : caughtUp
        ? 'available'
        : 'lagging';
  return {
    membership: { state, rows, next, exactEmpty: state === 'available' && exactEmpty && !rows.length && !next, withheld },
    ...(session ? { session } : {}),
  };
}
