import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { workTypeKeys } from '../discover/state.ts';
import { isUuid } from '../discover/scope.ts';

/** Preserve query values, including malformed selections that Discover must refuse. */
export function discoverSearchUrl(source: URL, locale: UiLocale): URL {
  const destination = new URL(source);
  destination.pathname = localizedPath('/discover', locale);
  const query = destination.searchParams;
  const type = query.get('type');
  if (query.has('include') || query.has('exclude') || (type && workTypeKeys.some(key => key === type))) {
    query.set('tab', 'works');
    if (type && query.getAll('type').length === 1 && query.getAll('include').length <= 1
      && workTypeKeys.some(key => key === type)) {
      query.set('include', [type, ...(query.get('include')?.split(',') ?? [])].join(','));
      query.delete('type');
    }
  }
  if (isUuid(query.get('term')) && query.getAll('term').length === 1 && query.getAll('ci').length <= 1) {
    query.set('ci', [query.get('term'), ...(query.get('ci')?.split(',') ?? [])].join(','));
    query.delete('term');
  }
  return destination;
}
