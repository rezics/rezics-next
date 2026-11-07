import { candidateContext } from '../pages/visit-host-port';
import { subjectHref } from '../../subject/subject-href';
import { subjectVisitReturn } from '../pages/subject-visit-navigation';
import { addonType } from './addon-profile';

/** One public observation, never native advice, a selected assertion or a command operand. */
export type AddonPublicOrigin = {
  subject: string;
  type: typeof addonType;
  context: string;
  definition: string;
  realm?: string;
  returnHref: string;
};
export type AddonPublicVisit =
  | { kind: 'origin'; origin: AddonPublicOrigin }
  | { kind: 'global'; returnHref: string }
  | { kind: 'invalid' };
export const addonPublicIntentLimit = 2048;
const encoder = new TextEncoder();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest = /^sha256:[0-9a-f]{64}$/;

export function addonPublicIntentFits(address: string): boolean {
  return address.length <= addonPublicIntentLimit && encoder.encode(address).byteLength <= addonPublicIntentLimit;
}

/** Use the public validator, then narrow its result to this overview's heading, without its default fragment. */
export function addonPublicReturn(value: unknown, id: string, locale: string, realm?: string): string | undefined {
  if (typeof value !== 'string' || !addonPublicIntentFits(value) || (realm !== undefined && !uuid.test(realm))) return;
  const accepted = subjectVisitReturn(value, locale);
  if (!accepted) return;
  const url = new URL(accepted, 'https://rezics.invalid');
  const original = new URL(value, 'https://rezics.invalid');
  const path = url.pathname.split('/');
  if (
    path.length !== 5 ||
    path[2] !== 'subjects' ||
    path[3] !== id ||
    original.hash ||
    [...url.searchParams.keys()].some((key) => key !== 'realm') ||
    url.searchParams.getAll('realm').length > 1 ||
    (url.searchParams.get('realm') ?? undefined) !== realm
  )
    return;
  return `${url.pathname}${url.search}`;
}

function publicOrigin(value: unknown, id: string, locale: string): AddonPublicOrigin | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const origin = value as Record<string, unknown>;
  if (
    Object.keys(origin).some(
      (key) => !['subject', 'type', 'context', 'definition', 'realm', 'returnHref'].includes(key),
    ) ||
    origin.subject !== id ||
    !uuid.test(id) ||
    origin.type !== addonType ||
    typeof origin.context !== 'string' ||
    !uuid.test(origin.context) ||
    typeof origin.definition !== 'string' ||
    !digest.test(origin.definition) ||
    (origin.realm !== undefined && (typeof origin.realm !== 'string' || !uuid.test(origin.realm)))
  )
    return;
  const realm = origin.realm as string | undefined;
  const returnHref = addonPublicReturn(origin.returnHref, id, locale, realm);
  if (!returnHref) return;
  return {
    subject: id,
    type: addonType,
    context: origin.context,
    definition: origin.definition,
    ...(realm ? { realm } : {}),
    returnHref,
  };
}

/** The complete encoded URL, including its canonical path, pays the outer budget. Never truncate. */
export function addonPublicCorrectionHref(base: string, origin: AddonPublicOrigin): string {
  const href = `${base}?${new URLSearchParams({
    origin: JSON.stringify({
      subject: origin.subject,
      type: origin.type,
      context: origin.context,
      definition: origin.definition,
      ...(origin.realm ? { realm: origin.realm } : {}),
      returnHref: origin.returnHref,
    }),
  })}`;
  const encoded = new URL(href, 'https://rezics.invalid');
  // Missing/oversized observation must reach refusal rather than become an implicit legacy Global visit.
  return addonPublicIntentFits(href) && addonPublicIntentFits(`${encoded.pathname}${encoded.search}${encoded.hash}`)
    ? href
    : `${base}?origin=!`;
}

/** A deliberate Global visit discards the selected correction intent but retains the one public return. */
export function addonGlobalVisitHref(id: string, locale: string, returnHref?: string): string {
  const base = `${subjectHref({ id, label: '' }, locale).href}/addon`;
  return returnHref ? `${base}?${new URLSearchParams({ publicReturn: returnHref })}` : base;
}

/** HTTP search boundary. Legacy work and sealed classification handoffs retain their original validators. */
export function parseAddonPublicVisit(
  search: string,
  id: string,
  locale: string,
  canonicalPath: string,
): AddonPublicVisit | undefined {
  const address = new URL(`${canonicalPath}${search}`, 'https://rezics.invalid');
  if (
    !addonPublicIntentFits(`${canonicalPath}${search}`) ||
    !addonPublicIntentFits(`${address.pathname}${address.search}${address.hash}`)
  )
    return { kind: 'invalid' };
  const params = new URLSearchParams(search);
  const keys = [...params.keys()];
  if (
    new Set(keys).size !== keys.length ||
    keys.some((key) => !['origin', 'publicReturn', 'work', 'classificationHandoff'].includes(key))
  )
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
    const realm = new URLSearchParams(returnHref.split('?')[1]).get('realm') ?? undefined;
    const admitted = addonPublicReturn(returnHref, id, locale, realm);
    return admitted ? { kind: 'global', returnHref: admitted } : { kind: 'invalid' };
  }
}

export function addonUnsupportedVisit(visit: AddonPublicVisit | undefined): boolean {
  return visit?.kind === 'origin' && (visit.origin.context !== candidateContext || !!visit.origin.realm);
}
