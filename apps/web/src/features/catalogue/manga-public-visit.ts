import { candidateContext } from '../pages/visit-host-port';
import { subjectHref } from '../../subject/subject-href';
import { subjectVisitReturn } from '../pages/subject-visit-navigation';
import type { MangaType } from './manga-profile';
import { mangaCurrentAddress, mangaReaderAddress, mangaOccurrenceFromFragment } from './manga-reader/navigation';

/** One public observation, never native advice, a selected assertion or a command operand. */
export type MangaPublicOrigin = {
  subject: string;
  type: MangaType;
  context: string;
  definition?: string;
  realm?: string;
  returnHref?: string;
};
export type MangaPublicVisit =
  | { kind: 'origin'; origin: MangaPublicOrigin }
  | { kind: 'global'; returnHref: string }
  | { kind: 'invalid' };
export const mangaPublicIntentLimit = 2048;
const encoder = new TextEncoder();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest = /^sha256:[0-9a-f]{64}$/;

export function mangaPublicIntentFits(address: string): boolean {
  return address.length <= mangaPublicIntentLimit && encoder.encode(address).byteLength <= mangaPublicIntentLimit;
}

/** Reuse public admission and the original reader address. No nested opener or invented Context route. */
export function mangaPublicReturn(value: unknown, id: string, locale: string, realm?: string): string | undefined {
  if (typeof value !== 'string' || !mangaPublicIntentFits(value)) return;
  const accepted = subjectVisitReturn(value, locale);
  if (!accepted) return;
  const url = new URL(accepted, 'https://rezics.invalid');
  const path = url.pathname.split('/');
  const keys = [...url.searchParams.keys()];
  if (
    path[3] !== id ||
    path[2] !== 'subjects' ||
    path.length > 6 ||
    (path[5] && !['contents', 'editions'].includes(path[5])) ||
    keys.some((key) => !['realm', 'node', 'cursor'].includes(key)) ||
    new Set(keys).size !== keys.length ||
    (url.searchParams.get('realm') ?? undefined) !== realm ||
    (url.hash !== '#connections' && url.hash !== '#manga-reader' && !mangaOccurrenceFromFragment(url.hash))
  )
    return;
  if (url.hash === '#connections') return `${url.pathname}${url.search}`;
  const fallback = mangaReaderAddress({
    id,
    label: decodeURIComponent(path[4]!),
    locale,
    view: path[5] ?? 'overview',
    realm,
    ...(url.searchParams.has('node')
      ? { continuation: { node: url.searchParams.get('node')!, cursor: url.searchParams.get('cursor') ?? '' } }
      : {}),
  });
  const current = mangaCurrentAddress(accepted, fallback);
  return current === accepted ? current : undefined;
}

function publicOrigin(value: unknown, id: string, locale: string): MangaPublicOrigin | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const origin = value as Record<string, unknown>;
  if (
    Object.keys(origin).some(
      (key) => !['subject', 'type', 'context', 'definition', 'realm', 'returnHref'].includes(key),
    ) ||
    origin.subject !== id ||
    !uuid.test(id) ||
    !['schema:ComicSeries', 'schema:PublicationVolume'].includes(origin.type as string) ||
    typeof origin.context !== 'string' ||
    !uuid.test(origin.context) ||
    (origin.definition !== undefined && (typeof origin.definition !== 'string' || !digest.test(origin.definition))) ||
    (origin.realm !== undefined && (typeof origin.realm !== 'string' || !uuid.test(origin.realm)))
  )
    return;
  const realm = origin.realm as string | undefined;
  const returnHref = mangaPublicReturn(origin.returnHref, id, locale, realm);
  if (origin.returnHref !== undefined && (!returnHref || (origin.context !== candidateContext && !realm))) return;
  return {
    subject: id,
    type: origin.type as MangaType,
    context: origin.context,
    ...(origin.definition ? { definition: origin.definition as string } : {}),
    ...(realm ? { realm } : {}),
    ...(returnHref ? { returnHref } : {}),
  };
}

/** The complete encoded URL, including its canonical path, pays the outer budget. Never truncate. */
export function mangaPublicCorrectionHref(base: string, origin: MangaPublicOrigin): string {
  const href = `${base}?${new URLSearchParams({
    origin: JSON.stringify({
      subject: origin.subject,
      type: origin.type,
      context: origin.context,
      ...(origin.definition ? { definition: origin.definition as string } : {}),
      ...(origin.realm ? { realm: origin.realm } : {}),
      returnHref: origin.returnHref,
    }),
  })}`;
  const encoded = new URL(href, 'https://rezics.invalid');
  // Missing/oversized observation must reach refusal rather than become an implicit legacy Global visit.
  return mangaPublicIntentFits(href) && mangaPublicIntentFits(`${encoded.pathname}${encoded.search}${encoded.hash}`)
    ? href
    : `${base}?origin=!`;
}

/** A deliberate Global visit discards the selected correction intent but retains the one public return. */
export function mangaGlobalVisitHref(id: string, locale: string, returnHref?: string): string {
  const base = `${subjectHref({ id, label: '' }, locale).href}/manga`;
  const href = returnHref ? `${base}?${new URLSearchParams({ publicReturn: returnHref })}` : base;
  return mangaPublicIntentFits(href) ? href : `${base}?origin=!`;
}

/** HTTP search boundary: only one closed origin or one deliberate Global return is admitted. */
export function parseMangaPublicVisit(
  search: string,
  id: string,
  locale: string,
  canonicalPath: string,
): MangaPublicVisit | undefined {
  const address = new URL(`${canonicalPath}${search}`, 'https://rezics.invalid');
  if (
    !mangaPublicIntentFits(`${canonicalPath}${search}`) ||
    !mangaPublicIntentFits(`${address.pathname}${address.search}${address.hash}`)
  )
    return { kind: 'invalid' };
  if (address.hash || /%(?![0-9a-f]{2})/i.test(search)) return { kind: 'invalid' };
  const params = new URLSearchParams(search);
  const keys = [...params.keys()];
  if (new Set(keys).size !== keys.length || keys.some((key) => !['origin', 'publicReturn'].includes(key)))
    return { kind: 'invalid' };
  const raw = params.get('origin');
  const returnHref = params.get('publicReturn');
  if (raw !== null) {
    if (returnHref !== null) return { kind: 'invalid' };
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return { kind: 'invalid' };
    }
    const origin = publicOrigin(value, id, locale);
    // A single canonical JSON shape also rejects duplicate object members and hidden extra intent.
    return origin && JSON.stringify(origin) === raw ? { kind: 'origin', origin } : { kind: 'invalid' };
  }
  if (returnHref !== null) {
    const realm = new URL(returnHref, 'https://rezics.invalid').searchParams.get('realm') ?? undefined;
    const admitted = mangaPublicReturn(returnHref, id, locale, realm);
    return admitted ? { kind: 'global', returnHref: admitted } : { kind: 'invalid' };
  }
}

export function mangaUnsupportedVisit(visit: MangaPublicVisit | undefined): boolean {
  return visit?.kind === 'origin' && (visit.origin.context !== candidateContext || !!visit.origin.realm);
}

/** Public callers already own the observed read. This descriptor performs no producer read. */
export function mangaObservedOrigin(origin: MangaPublicOrigin): MangaPublicOrigin {
  const { returnHref, ...observed } = origin;
  if (!returnHref || (origin.context !== candidateContext && !origin.realm)) return observed;
  const address = new URL(returnHref, 'https://rezics.invalid');
  return { ...observed, returnHref: `${address.pathname}${address.search}${address.hash}` };
}
