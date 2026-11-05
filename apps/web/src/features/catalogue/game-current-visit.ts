import { candidateContext } from '../../subject/candidates';
import { subjectHref } from '../../subject/subject-href';
import { subjectVisitReturn } from '../pages/subject-visit-navigation';
import { contextHref } from '../pages/context-navigation';

/** Public navigation intent. This carries neither a reader nor native editing authority. */
export type GameCurrentVisit = {
  context: string;
  realm?: string;
  source?: string;
  type?: string;
  release?: string;
};
export type GameVisitInput = { valid: true; visit: GameCurrentVisit } | { valid: false };
export const gameVisitLimit = 2048;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest = /^sha256:[a-f0-9]{64}$/;
const propertyId = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s\u0000-\u001f\u007f]{1,128}$/u;

/** Only established Subject routes and Realm composition can name the originating reading.
 * A root ?context= selector would invent unsupported public addressing semantics.
 */
function sourceAddress(value: string, id: string, locale: string, realm?: string): string | undefined {
  const accepted = subjectVisitReturn(value, locale);
  if (!accepted) return;
  const url = new URL(accepted, 'https://rezics.invalid');
  const path = url.pathname.split('/');
  // The shared validator supplies #connections for an address without a fragment.
  // It validates the route; the local descriptor retains only its source address.
  if (path[2] !== 'subjects' || path[3] !== id || new URL(value, 'https://rezics.invalid').hash) return;
  const keys = [...url.searchParams.keys()];
  if (keys.some((key) => key !== 'realm') || (url.searchParams.get('realm') ?? undefined) !== realm) return;
  return `${url.pathname}${url.search}`;
}

/** HTTP boundary. For example, realm=A with source ?realm=B is invalid, never a Global visit. */
export function parseGameVisit(search: string, id: string, locale: string): GameVisitInput {
  if (search.length > gameVisitLimit || new TextEncoder().encode(search).byteLength > gameVisitLimit)
    return { valid: false };
  const params = new URLSearchParams(search);
  const keys = ['context', 'realm', 'source', 'type', 'release'];
  for (const key of params.keys())
    if (!keys.includes(key) || params.getAll(key).length !== 1) return { valid: false };
  const context = params.get('context') ?? candidateContext;
  const realm = params.get('realm') ?? undefined;
  const source = params.get('source') ?? undefined;
  const type = params.get('type') ?? undefined;
  const release = params.get('release') ?? undefined;
  if (
    !uuid.test(context) ||
    (realm !== undefined && (!uuid.test(realm) || !params.has('context') || !source)) ||
    (type !== undefined && !propertyId.test(type)) ||
    (release !== undefined && !digest.test(release)) ||
    (source !== undefined && (!params.has('context') || !type || sourceAddress(source, id, locale, realm) !== source)) ||
    (context !== candidateContext && !realm && source !== undefined)
  )
    return { valid: false };
  return {
    valid: true,
    visit: {
      context,
      ...(realm ? { realm } : {}),
      ...(source ? { source } : {}),
      ...(type ? { type } : {}),
      ...(release ? { release } : {}),
    },
  };
}

export function gameVisitSearch(visit: GameCurrentVisit): string {
  const params = new URLSearchParams({ context: visit.context });
  for (const key of ['realm', 'source', 'type', 'release'] as const)
    if (visit[key] !== undefined) params.set(key, visit[key]);
  return `?${params}`;
}

/** Source entries are overviews: no display label or equal Concept is converted to an occurrence. */
export function gameCorrectionHref(input: {
  id: string;
  label: string;
  type: string;
  locale: string;
  context: string;
  realm?: string | undefined;
  release?: string | undefined;
}): string | undefined {
  const root = subjectHref(input, input.locale).href;
  const visit: GameCurrentVisit = {
    context: input.context,
    type: input.type,
    source: contextHref(root, input.realm),
    ...(input.realm ? { realm: input.realm } : {}),
    ...(input.release ? { release: input.release } : {}),
  };
  const search = gameVisitSearch(visit);
  return parseGameVisit(search, input.id, input.locale).valid ? `${root}/game${search}` : undefined;
}
