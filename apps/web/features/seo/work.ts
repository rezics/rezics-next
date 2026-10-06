import type { Metadata } from 'next';
import type { UiLocale } from '../../i18n/define.ts';
import { BFF_PREFIX } from '../api/browser.ts';
import type { WorkResolution } from '../work-page/read.ts';
import { chapterHref, idOf, iriOf, parseContentsQuery, parseHistoryQuery, parseReaderLanguage, parseScope,
  parseVersionQuery, textHref, type WorkTab, workHref } from '../work-page/route.ts';
import { localeAlternates, pageUrl } from './address.ts';
import { mainApiWithToken } from '../api/main.ts';
import { addressPath } from '../address/path.ts';

type SearchParams = Record<string, string | string[] | undefined>;

/** A page of a Work: one of its tabs, a chapter in the reader, or the one text a Work without chapters is read as. */
export type WorkView = { tab: WorkTab } | { tab: 'read'; chapter: string } | { tab: 'text' };

const basePath = (id: string, view: WorkView) =>
  view.tab === 'read' ? chapterHref(id, view.chapter) : view.tab === 'text' ? textHref(id) : workHref(id, view.tab);

/**
 * The address a Work view is known by. It names the Work by its native ID: a
 * slug is an alias that renames, merges and retirement move, and Main's
 * sitemap lists native references. It keeps the selection the page shows, so
 * a Realm's view never claims the Everyone view as its body, and it drops
 * what the page ignores. A personal view (Mine) and a cursor, an expiring
 * position rather than a page, are not indexed; nor is a selection the page
 * will say it cannot show.
 */
export function workViewAddress(id: string, view: WorkView, query: SearchParams): { path: string; indexable: boolean } {
  const paged = query.cursor !== undefined;
  const address = (() => {
    switch (view.tab) {
      case 'overview': case 'discussion': {
        const scope = parseScope(query);
        if (!scope) return null;
        const context = view.tab === 'overview' && typeof query.context === 'string' && idOf(iriOf(query.context))
          ? query.context : undefined;
        return { path: workHref(id, view.tab, scope, { context }), indexable: scope.kind !== 'mine' && !paged };
      }
      case 'contents': {
        const selection = parseContentsQuery(query);
        return selection && { path: workHref(id, 'contents', null,
          { parent: selection.parent, language: selection.language }), indexable: !paged };
      }
      case 'versions': {
        const selection = parseVersionQuery(query);
        return selection && { path: workHref(id, 'versions', null,
          { kind: selection.kind, language: selection.language }), indexable: !paged };
      }
      case 'history': {
        const selection = parseHistoryQuery(query);
        return selection && { path: workHref(id, 'history', null, { kind: selection.kind }), indexable: !paged };
      }
      case 'read': {
        const language = parseReaderLanguage(query);
        return language === null ? null : { path: chapterHref(id, view.chapter, language), indexable: true };
      }
      case 'text': {
        const language = parseReaderLanguage(query);
        return language === null ? null : { path: textHref(id, language), indexable: true };
      }
    }
  })();
  const result = address ?? { path: basePath(id, view), indexable: false };
  const language = parseReaderLanguage(query);
  if (language === null) return { ...result, indexable: false };
  if (!language) return result;
  const path = new URL(result.path, 'https://rezics.invalid');
  path.searchParams.set('language', language);
  return { ...result, path: path.pathname + path.search };
}

/**
 * Search and link-preview metadata for a Work view, projected from the same
 * Work read the page shows. Only a public Work is indexed or gives a
 * description and preview image; a restricted Work a signed-in reader may see
 * keeps its title for their tab and nothing more. A missing Work is left to
 * the not-found view, which is never indexed, and a renamed slug redirects
 * before anything renders. `origin` is null when the request's is unknown.
 */
export function workMetadata(work: WorkResolution, view: WorkView, query: SearchParams, locale: UiLocale,
  origin: string | null): Metadata {
  if (work.kind === 'unavailable') return { robots: { index: false } };
  if (work.kind !== 'work') return {};
  const { header } = work;
  const address = workViewAddress(work.id, view, query);
  const alternates = origin ? localeAlternates(origin, address.path, locale) : null;
  if (header.disclosure !== 'public') return { robots: { index: false }, ...(alternates ? { alternates } : {}) };
  const description = (header.description ?? header.tagline)?.value;
  const cover = header.cover.kind === 'image' && header.cover.url.startsWith('/v1/media/') && origin
    ? { url: new URL(`${BFF_PREFIX}${header.cover.url}`, origin).toString(), width: header.cover.width,
      height: header.cover.height, alt: header.title.value } : null;
  return { description, ...(address.indexable ? {} : { robots: { index: false } }),
    ...(alternates ? { alternates } : {}),
    openGraph: { siteName: 'REZICS', title: header.title.value, description,
      ...(alternates ? { url: alternates.canonical } : {}), ...(cover ? { images: [cover] } : {}) } };
}

/**
 * `workMetadata` at the current request's origin, for a page's `generateMetadata`. Metadata is an anonymous
 * delivery even when the page has a signed-in reader: it describes the Work as Main shows it to anyone, never
 * the personalized read the page itself renders.
 */
export async function workPageMetadata(work: WorkResolution, view: WorkView, query: SearchParams,
  locale: UiLocale): Promise<Metadata> {
  const undisclosed: Metadata = { title: { absolute: 'REZICS' }, description: null,
    openGraph: null, twitter: null, robots: { index: false } };
  let shown = work;
  if (work.kind === 'work') {
    try {
      const anonymous = mainApiWithToken(undefined);
      const [preview, header] = await Promise.all([
        anonymous.v1['public-previews']({ resource: work.id }).get(),
        anonymous.v1.works({ id: work.id }).get({ query: {} }),
      ]);
      if (preview.error || !preview.data || header.error || !header.data) return undisclosed;
      shown = { kind: 'work', id: work.id, header: header.data };
    } catch { return undisclosed; }
  }
  const page = await pageUrl();
  const metadata = workMetadata(shown, view, query, locale, page?.origin ?? null);
  const path = page && addressPath(page.pathname);
  if (page && path?.lookup.scope === 'work') {
    const address = workViewAddress(path.lookup.key, view, query);
    const canonical = new URL(`/${locale}${address.path}`, page.origin).toString();
    metadata.alternates = { canonical };
    if (metadata.openGraph) metadata.openGraph = { ...metadata.openGraph, url: canonical };
  }
  return metadata;
}
