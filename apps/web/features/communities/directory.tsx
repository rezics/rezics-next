import { redirect } from 'next/navigation';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { browseHref, changeBrowse, emptyBrowse } from '../discover/browse-state.ts';
import { idOf } from '../discover/scope.ts';

type Search = Record<string, string | string[] | undefined>;
/** Existing /r links enter the Communities tab; route ownership stays with /r. */
export async function CommunityDirectory({ locale, search }: { locale: UiLocale; search: Search }) {
  const q = typeof search.q === 'string' ? search.q : '';
  const topic = typeof search.topic === 'string' ? idOf(search.topic) : null;
  redirect(
    localizedPath(
      browseHref(
        changeBrowse(emptyBrowse, {
          tab: 'communities',
          q,
          conditions: { include: topic ? [topic] : [], exclude: [], match: 'all' },
        }),
      ),
      locale,
    ),
  );
}
/** Compatibility for existing URL consumers; the new browse owns ordering and continuation. */
export function directoryQuery(search: Search) {
  return {
    q: typeof search.q === 'string' ? search.q.trim().slice(0, 80) : '',
    sort: ['members', 'newest', 'growing'].includes(String(search.sort)) ? search.sort : 'activity',
    cursor:
      typeof search.cursor === 'string' && search.cursor.length <= 2048 ? search.cursor : undefined,
    topic: typeof search.topic === 'string' && idOf(search.topic) ? search.topic : undefined,
  };
}
