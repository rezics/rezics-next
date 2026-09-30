// Work-level page addresses and their URL state: `/w/{ref}/connections`,
// `/w/{ref}/editions`, `/releases/{id}` and `/isbn/{isbn}`. Pure functions
// shared by the routes, the components and their tests.

import { idOf } from '../work-page/route.ts';

type SearchParams = Record<string, string | string[] | undefined>;
const single = (value: string | string[] | undefined) => (Array.isArray(value) ? undefined : value || undefined);

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Stable anchors of the sections, kept across pages so a link or a "Show more" lands where it was. */
export const anchors = { parts: 'parts', wholes: 'wholes', franchises: 'franchises', relations: 'relations',
  realizations: 'realizations', releases: 'releases' } as const;

/** Whether a franchise lists its series (one per Work it places) or their parts (volumes, seasons). */
export const grains = ['series', 'parts'] as const;
export type Grain = (typeof grains)[number];

/** The Connections page's state; every field is optional and a malformed one refuses the whole query. */
export interface ConnectionsQuery {
  grain: Grain;
  /** A group occurrence whose parts the Parts list shows, instead of the top level. */
  parent?: string;
  partsAfter?: string;
  relationsAfter?: string;
  /** The franchise Collection whose members continue at `membersAfter`. */
  franchise?: string;
  membersAfter?: string;
}

const cursorOk = (value: string | undefined) => value === undefined || value.length <= 2048;

export function parseConnectionsQuery(params: SearchParams): ConnectionsQuery | null {
  const keys = ['grain', 'parent', 'partsAfter', 'relationsAfter', 'franchise', 'membersAfter'] as const;
  if (keys.some(key => Array.isArray(params[key]))) return null;
  const grain = single(params.grain) ?? 'series';
  const parent = single(params.parent);
  const franchise = single(params.franchise);
  const cursors = [single(params.partsAfter), single(params.relationsAfter), single(params.membersAfter)];
  if (!(grains as readonly string[]).includes(grain)) return null;
  if ((parent !== undefined && !uuid.test(parent)) || (franchise !== undefined && !uuid.test(franchise))) return null;
  if (!cursors.every(cursorOk)) return null;
  return { grain: grain as Grain, parent, partsAfter: cursors[0], relationsAfter: cursors[1], franchise,
    membersAfter: cursors[2] };
}

/** The Editions page's pages: realizations and releases continue independently. */
export interface EditionsQuery { realizationsAfter?: string; releasesAfter?: string }

export function parseEditionsQuery(params: SearchParams): EditionsQuery | null {
  if (Array.isArray(params.realizationsAfter) || Array.isArray(params.releasesAfter)) return null;
  const query = { realizationsAfter: single(params.realizationsAfter), releasesAfter: single(params.releasesAfter) };
  return cursorOk(query.realizationsAfter) && cursorOk(query.releasesAfter) ? query : null;
}

function withQuery(path: string, query: Record<string, string | undefined>, anchor?: string): string {
  const entries = Object.entries(query).filter((entry): entry is [string, string] => Boolean(entry[1]));
  return `${entries.length ? `${path}?${new URLSearchParams(entries)}` : path}${anchor ? `#${anchor}` : ''}`;
}

export const connectionsHref = (ref: string, query: Partial<ConnectionsQuery> = {}, anchor?: string) =>
  withQuery(`/w/${encodeURIComponent(ref)}/connections`, { ...query,
    grain: query.grain === 'parts' ? 'parts' : undefined }, anchor);

export const editionsHref = (ref: string, query: EditionsQuery = {}, anchor?: string) =>
  withQuery(`/w/${encodeURIComponent(ref)}/editions`, { ...query }, anchor);

/** A Work anywhere on the site, by the ID Main names it with. */
export const workLinkHref = (iri: string) => {
  const id = idOf(iri);
  return id ? `/w/${id}` : null;
};

/** A release's own page; `release` is its IRI or UUID. */
export const releaseHref = (release: string) => `/releases/${idOf(release) ?? release}`;

/** A release segment from `/releases/{id}`: the UUID Main minted, in any letter case. */
export function parseReleaseId(segment: string): string | null {
  const id = segment.toLowerCase();
  return uuid.test(id) ? id : null;
}

/** The ISBN-13 check digit of the first twelve digits. */
function checkDigit(body: string): number {
  let sum = 0;
  for (let index = 0; index < 12; index += 1) sum += Number(body[index]) * (index % 2 ? 3 : 1);
  return (10 - (sum % 10)) % 10;
}

/**
 * The ISBN-13 an `/isbn/{isbn}` segment names. Hyphens and spaces are
 * punctuation; an ISBN-10 is the same book's older spelling and gains the 978
 * prefix, as the standard defines. Anything else, including a wrong check
 * digit, is no ISBN and Main is not asked.
 */
export function parseIsbn(segment: string): string | null {
  let digits: string;
  try { digits = decodeURIComponent(segment).replace(/[\s-]/g, '').toUpperCase(); } catch { return null; }
  if (/^97[89][0-9]{10}$/.test(digits)) return checkDigit(digits) === Number(digits[12]) ? digits : null;
  if (!/^[0-9]{9}[0-9X]$/.test(digits)) return null;
  const weighted = [...digits].reduce((sum, char, index) => sum + (char === 'X' ? 10 : Number(char)) * (10 - index), 0);
  if (weighted % 11 !== 0) return null;
  const body = `978${digits.slice(0, 9)}`;
  return `${body}${checkDigit(body)}`;
}
