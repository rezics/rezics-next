import type { KernelClient, SubjectLinksResponse } from '@rezics/client';
import type { Release } from '@rezics/definitions';

export const membershipPageCap = 20;
export const membershipEvidenceBytes = 1024 * 1024;
export const membershipContinuationLimit = 4096;
export const membershipProperties = ['schema:genre', 'schema:keywords'] as const;
export type MembershipProperty = (typeof membershipProperties)[number];
export type ConceptHierarchyState = 'available' | 'lagging' | 'preparing' | 'unavailable' | 'unsupported';

export type ConceptMembershipRow = {
  id: string;
  label: string;
  lang: string | null;
  type: string;
  property: MembershipProperty;
  workPage: boolean;
  citations: { url: string }[];
};

export type ConceptMembershipStream = {
  property: MembershipProperty;
  state: ConceptHierarchyState;
  rows: ConceptMembershipRow[];
  cursor?: string;
  next: string | null;
  exactEmpty: boolean;
  unknownTotal: boolean;
  withheld: number;
};

export type ConceptMembership = {
  state: ConceptHierarchyState;
  rows: ConceptMembershipRow[];
  next: string | null;
  exactEmpty: boolean;
  withheld: number;
  streams: Record<MembershipProperty, ConceptMembershipStream>;
};

export type ConceptMembershipCursors = Partial<Record<MembershipProperty, string>>;

type Definitions = Pick<Release, 'types' | 'properties'> & { digest?: string };
type LinkAssertion = NonNullable<SubjectLinksResponse['links'][number]['assertion']>;

export function typeExtends(release: Definitions, type: string, target: string, seen = new Set<string>()): boolean {
  if (type === target) return true;
  if (seen.has(type)) return false;
  seen.add(type);
  return (release.types[type]?.bases ?? []).some((base) => typeExtends(release, base, target, seen));
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

function workTypeAdmitted(release: Definitions, type: string) {
  return typeExtends(release, type, 'schema:CreativeWork');
}

function citationUrls(assertion: LinkAssertion | undefined): { url: string }[] {
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

export function validMembershipCursor(cursor: string | undefined): boolean {
  return cursor === undefined || new TextEncoder().encode(cursor).byteLength <= membershipContinuationLimit;
}

export function emptyMembershipStream(
  property: MembershipProperty,
  state: ConceptHierarchyState = 'unsupported',
  cursor?: string,
): ConceptMembershipStream {
  return {
    property,
    state,
    rows: [],
    ...(cursor ? { cursor } : {}),
    next: null,
    exactEmpty: false,
    unknownTotal: false,
    withheld: 0,
  };
}

function streamsOf(
  state: ConceptHierarchyState,
  cursor?: ConceptMembershipCursors,
): Record<MembershipProperty, ConceptMembershipStream> {
  return {
    'schema:genre': emptyMembershipStream('schema:genre', state, cursor?.['schema:genre']),
    'schema:keywords': emptyMembershipStream('schema:keywords', state, cursor?.['schema:keywords']),
  };
}

export function emptyMembership(
  state: ConceptHierarchyState = 'unsupported',
  cursor?: ConceptMembershipCursors,
): ConceptMembership {
  const streams = streamsOf(state, cursor);
  return { state, rows: [], next: null, exactEmpty: false, withheld: 0, streams };
}

function combineMembership(streams: Record<MembershipProperty, ConceptMembershipStream>): ConceptMembership {
  const admitted = membershipProperties.map((property) => streams[property]);
  const rows = admitted.flatMap((stream) => stream.rows);
  const withheld = admitted.reduce((sum, stream) => sum + stream.withheld, 0);
  const next = admitted.find((stream) => stream.next)?.next ?? null;
  const preparing = admitted.some((stream) => stream.state === 'preparing');
  const unavailable = admitted.some((stream) => stream.state === 'unavailable');
  const lagging = admitted.some((stream) => stream.state === 'lagging');
  const unsupported = admitted.every((stream) => stream.state === 'unsupported');
  const state: ConceptHierarchyState = unsupported
    ? 'unsupported'
    : preparing
      ? 'preparing'
      : unavailable
        ? 'unavailable'
        : lagging
          ? 'lagging'
          : 'available';
  const exactEmpty =
    state === 'available' && admitted.every((stream) => stream.state === 'unsupported' || stream.exactEmpty);
  return { state, rows, next, exactEmpty, withheld, streams };
}

/** Inverse genre/keyword pages of currently adopted work membership. Hierarchy continuation stays separate. */
export async function readConceptMembership(
  client: KernelClient,
  authorization: string | undefined,
  release: Definitions,
  id: string,
  locale: string,
  input: { session?: string | undefined; cursors?: ConceptMembershipCursors | undefined },
): Promise<{ membership: ConceptMembership; session?: string; oversized?: true; failure?: number }> {
  const admitted = membershipProperties.filter((property) => membershipInverse(release, property));
  if (!admitted.length)
    return {
      membership: emptyMembership('unsupported', input.cursors),
      ...(input.session ? { session: input.session } : {}),
    };

  for (const property of membershipProperties) {
    if (!validMembershipCursor(input.cursors?.[property]))
      return { membership: emptyMembership('unavailable', input.cursors), failure: 400 };
  }

  let session = input.session;
  const streams = streamsOf('unsupported', input.cursors);
  for (const property of membershipProperties) {
    if (!admitted.includes(property)) {
      streams[property] = emptyMembershipStream(property, 'unsupported', input.cursors?.[property]);
      continue;
    }
    const cursor = input.cursors?.[property];
    try {
      const page = await client.subjects({ id }).links.get({
        query: {
          property,
          language: locale,
          limit: membershipPageCap,
          ...(cursor ? { cursor } : {}),
        },
        headers: headersOf(authorization, session),
      });
      if (page.status === 401 || page.status === 403 || page.status === 404)
        return {
          membership: emptyMembership('unavailable', input.cursors),
          failure: page.status,
          ...(session ? { session } : {}),
        };
      if (page.status !== 200 || !page.data || !('links' in page.data)) {
        const code = page.data && 'code' in page.data ? page.data.code : undefined;
        streams[property] = {
          ...emptyMembershipStream(
            property,
            page.status === 503 && code === 'semantic_not_ready' ? 'preparing' : 'unavailable',
            cursor,
          ),
        };
        continue;
      }
      const data = page.data;
      if (
        data.links.length > membershipPageCap ||
        new TextEncoder().encode(JSON.stringify(data)).byteLength > membershipEvidenceBytes
      )
        return {
          membership: emptyMembership('unavailable', input.cursors),
          oversized: true,
          ...(session ? { session } : {}),
        };
      session = tokenOf(page) ?? session;
      const rows: ConceptMembershipRow[] = [];
      let withheld = 0;
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
      const caughtUp = data.freshness.caught_up === true;
      const exactZero = caughtUp && data.count?.exact === true && data.count.value === 0;
      const terminalEmpty = rows.length === 0 && !data.next;
      streams[property] = {
        property,
        state: caughtUp ? 'available' : 'lagging',
        rows,
        ...(cursor ? { cursor } : {}),
        next: data.next,
        exactEmpty: exactZero,
        unknownTotal: terminalEmpty && !exactZero,
        withheld,
      };
    } catch {
      streams[property] = emptyMembershipStream(property, 'unavailable', cursor);
    }
  }

  return {
    membership: combineMembership(streams),
    ...(session ? { session } : {}),
  };
}
