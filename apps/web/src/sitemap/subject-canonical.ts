import type { Kernel } from '@rezics/client';
import { isView, VIEWS } from '@rezics/composition';
import { subjectDisplayLabel } from '../features/pages/subject.tsx';
import { locales } from '../paraglide/runtime.js';
import type { PagePaths } from '../shell/head.ts';
import { subjectHref, subjectViewPaths } from '../subject/subject-href.ts';
import { canonicalProjectionUnavailable, type CanonicalSitemapItem, type CanonicalSitemapPage } from './canonical.ts';
import { sitemapFamilyFromPagePaths, sitemapPagePaths } from './url.ts';
import { utcLastmod } from './xml.ts';

export type SubjectSitemapPage = Kernel['~Routes']['v1']['subject-pages']['get']['response'][200];

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const viewOrder: readonly string[] = VIEWS;

function unavailable(missing: string): never {
  return canonicalProjectionUnavailable('subjects', missing);
}

/** Validate an owner-supplied destination without deriving or looking up a handle. */
function accountPath(path: string): boolean {
  if (typeof path !== 'string' || !path.startsWith('/@') || path.length <= 2) return false;
  try {
    const handle = decodeURIComponent(path.slice(2));
    return !/[/\\?#\s]/u.test(handle) && path === `/@${encodeURIComponent(handle)}`;
  } catch {
    return false;
  }
}

/** One native raw window; no Web disclosure, identity or view discovery. */
export function subjectCanonicalPage(page: SubjectSitemapPage): CanonicalSitemapPage {
  if (
    !Array.isArray(page.subjectPages) ||
    page.subjectPages.length > 1_000 ||
    !(page.next === null || (typeof page.next === 'string' && page.next.length > 0))
  )
    return unavailable('a bounded native subject page and opaque continuation');
  const items: CanonicalSitemapItem[] = [];
  let previous: string | undefined;
  for (const item of page.subjectPages) {
    if (!item || typeof item.id !== 'string' || !uuid.test(item.id))
      return unavailable('the original native subject id');
    // The native source seeks by (route, subject_id), across successive partition-local windows.
    const sourceKey = `${item.id.slice(24, 28)}${item.id}`;
    if (previous !== undefined && sourceKey <= previous) return unavailable('strict native subject source order');
    previous = sourceKey;
    const target = item.target;
    if (
      !target ||
      !(
        (target.family === 'subject' && target.subjectId === item.id) ||
        (target.family === 'account' && uuid.test(target.accountId) && accountPath(target.canonicalPath))
      )
    )
      return unavailable('a current native Subject or Account canonical target');
    const views = item.views;
    if (
      !Array.isArray(views) ||
      !views.every(
        (view, index) =>
          isView(view) &&
          // The native Account batch admits only these names; this validates its wire contract.
          (target.family !== 'account' ||
            view === 'overview' ||
            view === 'posts' ||
            view === 'reviews' ||
            view === 'collections') &&
          (index === 0 || viewOrder.indexOf(views[index - 1]!) < viewOrder.indexOf(view)),
      )
    )
      return unavailable('current native offered views in canonical constructor order');
    if (
      !Array.isArray(item.labels) ||
      !item.labels.every((label) => label && typeof label.language === 'string' && typeof label.value === 'string') ||
      !(item.originalLanguage === undefined || typeof item.originalLanguage === 'string')
    )
      return unavailable('native public labels and optional original language');
    if (views.length === 0) {
      // A known-empty native intersection still advances the original source identity and cursor.
      items.push({ id: item.id, key: `${sourceKey}:empty`, family: null });
      continue;
    }
    const labels = Object.fromEntries(item.labels.map(({ language, value }) => [language, value]));
    const paths =
      target.family === 'account'
        ? (Object.fromEntries(locales.map((locale) => [locale, target.canonicalPath])) as PagePaths)
        : sitemapPagePaths(
            Object.fromEntries(
              locales.map((locale) => [
                locale,
                subjectHref(
                  { id: target.subjectId, label: subjectDisplayLabel(labels, locale, item.originalLanguage) },
                  locale,
                ).href,
              ]),
            ) as PagePaths,
          );
    const lastModified =
      typeof item.lastModified === 'string' && utcLastmod(item.lastModified) !== undefined
        ? item.lastModified
        : undefined;
    for (const view of views) {
      items.push({
        id: item.id,
        key: `${sourceKey}:${String(viewOrder.indexOf(view)).padStart(2, '0')}`,
        // Native Account views already intersect template availability with current owner admission.
        family: sitemapFamilyFromPagePaths(subjectViewPaths(paths, view), lastModified),
      });
    }
  }
  return { items, next: page.next };
}
