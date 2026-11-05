import { subjectHref } from '../../../subject/subject-href';
import { fileUuid } from '../catalogue-file-profile/model';

export const CATALOGUE_FILE_SOURCE_PARAM = 'fileSource';
export const CATALOGUE_FILE_READER_ANCHOR = 'catalogue-file-reader';

export type FileEvidenceReturn = {
  source: string;
  slug: string;
  realm?: string;
  context: string;
  definition: string;
  kind: 'assertion' | 'association';
  group: string;
  key: string;
  part: string;
};
const groups = new Set(['identifiers', 'technical', 'language', 'group', 'credits', 'facts', 'associations']);
const fragmentPrefix = `#${CATALOGUE_FILE_READER_ANCHOR}?evidence=`;
const token = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);

/** Only address and selection keys. Neither a body nor an arbitrary return URL can enter this receipt. */
export function fileEvidenceReturn(hash: string): FileEvidenceReturn | undefined {
  if (!hash.startsWith(fragmentPrefix) || hash.length > 4096 || new TextEncoder().encode(hash).length > 4096) return;
  try {
    const value: unknown = JSON.parse(decodeURIComponent(hash.slice(fragmentPrefix.length)));
    if (!Array.isArray(value) || value.length !== 10 || value[0] !== 1) return;
    const [, source, realm, context, definition, kind, group, key, slug, part] = value;
    if (
      !catalogueFileSourceId(source) ||
      (realm !== null && !catalogueFileSourceId(realm)) ||
      !catalogueFileSourceId(context) ||
      !token(definition, 128) ||
      (kind !== 'assertion' && kind !== 'association') ||
      !groups.has(group) ||
      !token(key, 1024) ||
      (kind === 'association') !== (group === 'associations') ||
      !token(slug, 768) ||
      !/^[A-Za-z0-9_%~-]+$/.test(slug) ||
      typeof part !== 'string' ||
      !/^(?:value|q:(?:0|[1-9]\d{0,3})|r:(?:0|[1-9]\d{0,3}):(?:0|[1-9]\d{0,3}))$/.test(part)
    )
      return;
    return { source, slug, part, ...(realm ? { realm } : {}), context, definition, kind, group, key };
  } catch {
    return;
  }
}

export function fileEvidenceFragment(value: FileEvidenceReturn): string | undefined {
  const hash =
    fragmentPrefix +
    encodeURIComponent(
      JSON.stringify([
        1,
        value.source,
        value.realm ?? null,
        value.context,
        value.definition,
        value.kind,
        value.group,
        value.key,
        value.slug,
        value.part,
      ]),
    );
  return fileEvidenceReturn(hash) ? hash : undefined;
}

export function fileReaderSlug(href: string | undefined, source: string, locale: string): string | undefined {
  const url = subjectUrl(href ?? '', locale);
  return url?.pathname.split('/')[3] === source ? url.pathname.split('/')[4] : undefined;
}

/** Public Context selection is the existing realm address; the resolved Context is only a comparison key. */
export function fileReaderRealm(href: string | undefined, source: string, locale: string): string | undefined {
  const url = subjectUrl(href ?? '', locale);
  if (!url || url.pathname.split('/')[3] !== source || url.searchParams.getAll('realm').length !== 1) return;
  return catalogueFileSourceId(url.searchParams.get('realm'));
}

function subjectUrl(href: string, locale: string): URL | undefined {
  if (!href.startsWith(`/${locale}/subjects/`) || href.length > 8192) return;
  try {
    const url = new URL(href, 'https://rezics.invalid');
    const parts = url.pathname.split('/');
    if (url.origin !== 'https://rezics.invalid' || parts.length !== 5 || !catalogueFileSourceId(parts[3]) || !parts[4])
      return;
    return url;
  } catch {
    return;
  }
}

export function fileEvidenceAt(href: string | undefined, locale: string): FileEvidenceReturn | undefined {
  const url = subjectUrl(href ?? '', locale);
  return url ? fileEvidenceReturn(url.hash) : undefined;
}

/** A single source UUID, never an arbitrary path or nested history. */
export function catalogueFileSourceId(value: unknown): string | undefined {
  return typeof value === 'string' && fileUuid.test(value) ? value : undefined;
}

export function catalogueFileSourceReturnHref(
  id: string,
  locale: string,
  label = '',
  receipt?: FileEvidenceReturn,
): string | undefined {
  if (!fileUuid.test(id)) return;
  let href = subjectHref({ id, label }, locale).href;
  if (!href.startsWith(`/${locale}/subjects/`)) return;
  const hash = receipt?.source === id ? fileEvidenceFragment(receipt) : undefined;
  if (hash && receipt) href = `/${locale}/subjects/${id}/${receipt.slug}`;
  const realm = hash && receipt?.realm ? `?realm=${receipt.realm}` : '';
  return `${href}${realm}${hash ?? `#${CATALOGUE_FILE_READER_ANCHOR}`}`;
}

/** Add a single same-locale source ID to an ordinary Subject destination. */
export function catalogueFileDestinationHref(
  href: string,
  sourceId: string,
  locale: string,
  receipt?: FileEvidenceReturn,
): string | undefined {
  if (!fileUuid.test(sourceId)) return;
  const url = subjectUrl(href, locale);
  if (!url) return;
  // A target can carry this one source only, never another journey's return chain.
  url.search = '';
  url.searchParams.set(CATALOGUE_FILE_SOURCE_PARAM, sourceId);
  const hash = receipt?.source === sourceId ? fileEvidenceFragment(receipt) : undefined;
  if (hash && receipt?.realm) url.searchParams.set('realm', receipt.realm);
  url.hash = hash ?? CATALOGUE_FILE_READER_ANCHOR;
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Preserve one validated source subject when opening its existing correction profile. */
export function catalogueFileCorrectionHref(href: string, sourceId: string, locale: string): string | undefined {
  if (!fileUuid.test(sourceId) || !href.startsWith(`/${locale}/subjects/`)) return;
  const url = new URL(href, 'https://rezics.invalid');
  if (url.origin !== 'https://rezics.invalid' || !url.pathname.startsWith(`/${locale}/subjects/`)) return;
  url.searchParams.set(CATALOGUE_FILE_SOURCE_PARAM, sourceId);
  return `${url.pathname}${url.search}${url.hash}`;
}
