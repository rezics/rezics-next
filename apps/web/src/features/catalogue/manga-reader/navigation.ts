import type { PageContinuation } from '@rezics/composition';
import { subjectViewHref } from '../../../subject/subject-href';

/** The return address names the exact current localized subject, view, Realm and opaque page window. */
export function mangaReaderAddress({
  id,
  label,
  locale,
  view,
  realm,
  continuation,
}: {
  id: string;
  label: string;
  locale: string;
  view: string;
  realm?: string | undefined;
  continuation?: PageContinuation | undefined;
}): string {
  const base = subjectViewHref({ id, label }, locale, view);
  const url = new URL(base, 'https://rezics.invalid');
  if (realm) url.searchParams.set('realm', realm);
  if (continuation) {
    url.searchParams.set('node', continuation.node);
    url.searchParams.set('cursor', continuation.cursor);
  }
  return `${url.pathname}${url.search}#manga-reader`;
}
