import { subjectHref } from '../../../subject/subject-href';
import { fileUuid } from '../catalogue-file-profile/model';

export const CATALOGUE_FILE_SOURCE_PARAM = 'fileSource';
export const CATALOGUE_FILE_READER_ANCHOR = 'catalogue-file-reader';

/** One validated source identity is the complete return state; arbitrary paths and nested history are not accepted. */
export function catalogueFileSourceId(value: unknown): string | undefined {
  return typeof value === 'string' && fileUuid.test(value) ? value : undefined;
}

export function catalogueFileSourceReturnHref(id: string, locale: string, label = ''): string | undefined {
  if (!fileUuid.test(id)) return;
  const href = subjectHref({ id, label }, locale).href;
  if (!href.startsWith(`/${locale}/subjects/`)) return;
  return `${href}#${CATALOGUE_FILE_READER_ANCHOR}`;
}

/** Add a single same-locale source ID to an ordinary Subject destination. */
export function catalogueFileDestinationHref(
  href: string,
  sourceId: string,
  locale: string,
): string | undefined {
  if (!fileUuid.test(sourceId) || !href.startsWith(`/${locale}/subjects/`)) return;
  const url = new URL(href, 'https://rezics.invalid');
  if (url.origin !== 'https://rezics.invalid' || !url.pathname.startsWith(`/${locale}/subjects/`)) return;
  url.searchParams.set(CATALOGUE_FILE_SOURCE_PARAM, sourceId);
  url.hash = CATALOGUE_FILE_READER_ANCHOR;
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Preserve one validated source subject when opening its existing correction profile. */
export function catalogueFileCorrectionHref(
  href: string,
  sourceId: string,
  locale: string,
): string | undefined {
  if (!fileUuid.test(sourceId) || !href.startsWith(`/${locale}/subjects/`)) return;
  const url = new URL(href, 'https://rezics.invalid');
  if (url.origin !== 'https://rezics.invalid' || !url.pathname.startsWith(`/${locale}/subjects/`)) return;
  url.searchParams.set(CATALOGUE_FILE_SOURCE_PARAM, sourceId);
  return `${url.pathname}${url.search}${url.hash}`;
}
