import { candidateContext } from '../../subject/candidates';
import { subjectVisitReturn } from '../pages/subject-visit-navigation';
import { isLiteraryType, type LiteraryType } from './literary-profile';

/** Address intent only. Native admission remains the source of disclosure and permission. */
export type LiteraryCurrentVisit = {
  context: string;
  realm?: string;
  type: LiteraryType;
  source: string;
};
export type LiteraryVisitInput =
  | { kind: 'direct' }
  | { kind: 'invalid' }
  | { kind: 'visit'; visit: LiteraryCurrentVisit };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fields = ['context', 'realm', 'type', 'source'];
export const literaryVisitLimit = 2048;

/** HTTP boundary: contradictory Realm/source pairs must never become a Global correction. */
export function parseLiteraryCurrentVisit(search: string, id: string, locale: string): LiteraryVisitInput {
  if (search.length > literaryVisitLimit || new TextEncoder().encode(search).byteLength > literaryVisitLimit)
    return { kind: 'invalid' };
  const params = new URLSearchParams(search);
  if (!params.size) return { kind: 'direct' };
  for (const key of params.keys())
    if (!fields.includes(key) || params.getAll(key).length !== 1) return { kind: 'invalid' };
  const context = params.get('context');
  const realm = params.get('realm') ?? undefined;
  const type = params.get('type');
  const source = params.get('source');
  if (!context || !uuid.test(context) || !type || !isLiteraryType(type) || !source ||
    (realm !== undefined && (!uuid.test(realm) || context === candidateContext))) return { kind: 'invalid' };
  const accepted = subjectVisitReturn(source, locale);
  if (!accepted) return { kind: 'invalid' };
  const url = new URL(source, 'https://rezics.invalid');
  const path = url.pathname.split('/');
  if (path[2] !== 'subjects' || path[3] !== id ||
    (path[5] !== undefined && !['contents', 'editions'].includes(path[5])) ||
    (url.searchParams.get('realm') ?? undefined) !== realm ||
    (url.searchParams.has('context') && url.searchParams.get('context') !== context) ||
    (context !== candidateContext && !realm) ||
    [...url.searchParams.keys()].some(key => !['realm', 'context', 'node', 'cursor', 'streamProperty', 'streamDirection', 'focus'].includes(key)))
    return { kind: 'invalid' };
  return { kind: 'visit', visit: { context, type, source, ...(realm ? { realm } : {}) } };
}

/** The encoded enclosing query, including expansion of the public source, shares the same cap. */
export function literaryCurrentVisitSearch(visit: LiteraryCurrentVisit): string {
  return `?${new URLSearchParams({ context: visit.context, type: visit.type, source: visit.source,
    ...(visit.realm ? { realm: visit.realm } : {}) })}`;
}
