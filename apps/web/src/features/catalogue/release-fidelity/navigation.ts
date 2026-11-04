import { subjectHref } from '../../../subject/subject-href';
import { candidateContext } from '../../../subject/candidates';
import { validatePageRealm } from '../../pages/view-cursor';
import type { ReleaseOccurrence } from './reading/state';

export const RELEASE_RETURN_BYTES = 8192;
const prefix = '#release-reading?';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const token = (value: unknown, limit: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\u0000-\u001f\u007f]/u.test(value);
const bytes = (value: string) => new TextEncoder().encode(value).length;

/** A locator only: no evidence, native session, command, URL or recursive return chain. */
export type ReleaseVisit = {
  id: string;
  context: string;
  digest: string;
  revision: number;
  stream?: string;
  cursor?: string;
  occurrence?: ReleaseOccurrence & { revision: number };
  focus: 'work' | 'related' | 'sources' | 'inspection';
};

export function releaseVisit(value: unknown): ReleaseVisit | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const v = value as ReleaseVisit;
  if (
    Object.keys(v).some(
      (key) => !['id', 'context', 'digest', 'revision', 'stream', 'cursor', 'occurrence', 'focus'].includes(key),
    ) ||
    !uuid.test(v.id) ||
    !uuid.test(v.context) ||
    !token(v.digest, 128) ||
    !Number.isSafeInteger(v.revision) ||
    v.revision < 0 ||
    !['work', 'related', 'sources', 'inspection'].includes(v.focus) ||
    (v.stream !== undefined && !token(v.stream, 256)) ||
    (v.cursor !== undefined && (!v.stream || !token(v.cursor, 4096)))
  )
    return;
  if (v.occurrence !== undefined) {
    const o = v.occurrence;
    if (
      !o ||
      typeof o !== 'object' ||
      Array.isArray(o) ||
      Object.keys(o).some(
        (key) =>
          !['key', 'stream', 'relation', 'direction', 'holder', 'statementId', 'target', 'revision'].includes(key),
      ) ||
      !uuid.test(o.holder) ||
      !uuid.test(o.statementId) ||
      !uuid.test(o.target) ||
      !token(o.relation, 256) ||
      o.stream !== v.stream ||
      !['forward', 'inverse'].includes(o.direction) ||
      !Number.isSafeInteger(o.revision) ||
      o.revision < 0 ||
      o.key !== JSON.stringify([o.stream, o.relation, o.direction, o.holder, o.statementId, o.target])
    )
      return;
  }
  if (v.focus === 'inspection' && !v.occurrence) return;
  if (bytes(`${prefix}${new URLSearchParams({ visit: JSON.stringify(v) })}`) > RELEASE_RETURN_BYTES) return;
  return v;
}

export function releaseVisitFragment(value: ReleaseVisit): string | undefined {
  return releaseVisit(value) ? `${prefix}${new URLSearchParams({ visit: JSON.stringify(value) })}` : undefined;
}

export function releaseVisitFromHash(hash: string): ReleaseVisit | undefined {
  if (!hash.startsWith(prefix) || bytes(hash) > RELEASE_RETURN_BYTES) return;
  const params = new URLSearchParams(hash.slice(prefix.length));
  if ([...params.keys()].length !== 1 || !params.has('visit')) return;
  try {
    return releaseVisit(JSON.parse(params.get('visit')!));
  } catch {
    return;
  }
}

/** This companion's closed address is consumed by the existing Subject visit return validator. */
export function releaseVisitReturn(value: unknown, locale?: string): string | undefined {
  if (typeof value !== 'string' || !value.startsWith('/') || bytes(value) > RELEASE_RETURN_BYTES) return;
  try {
    const url = new URL(value, 'https://rezics.invalid');
    const match = /^\/(en|zh-Hant|zh-Hans|ja|ko|fr|de|es)\/subjects\/([0-9a-f-]{36})\/([^/?#]+)\/release$/i.exec(
      url.pathname,
    );
    if (
      url.origin !== 'https://rezics.invalid' ||
      !match ||
      (locale !== undefined && match[1] !== locale) ||
      /%(?:2f|5c|25|0[0-9a-f]|1[0-9a-f]|7f)/i.test(url.pathname)
    )
      return;
    const keys = [...url.searchParams.keys()];
    if (keys.length !== 1 || keys[0] !== 'context') return;
    const visit = releaseVisitFromHash(url.hash);
    if (!visit || visit.id !== match[2] || visit.context !== url.searchParams.get('context')) return;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return;
  }
}

export function releaseReturnHref(label: string, locale: string, visit: ReleaseVisit): string | undefined {
  const fragment = releaseVisitFragment(visit);
  if (!fragment) return;
  const href = `${subjectHref({ id: visit.id, label }, locale).href}/release?${new URLSearchParams({ context: visit.context })}${fragment}`;
  return releaseVisitReturn(href, locale);
}

/** Use the public UUID selector validation; malformed or unsupported intent never falls back to Global. */
export function releaseSearch(input: Record<string, unknown>) {
  const allowed = ['context', 'realm', 'reviewProperty', 'candidate', 'via'];
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw new Error('Unsupported release address');
  const context = validatePageRealm(input.context) ?? candidateContext;
  const realm = validatePageRealm(input.realm);
  if (input.reviewProperty !== undefined && !token(input.reviewProperty, 256))
    throw new Error('Invalid release review');
  if (input.candidate !== undefined && (typeof input.candidate !== 'string' || !uuid.test(input.candidate)))
    throw new Error('Invalid release candidate');
  return {
    context,
    realm,
    reviewProperty: input.reviewProperty as string | undefined,
    candidate: input.candidate as string | undefined,
  };
}
