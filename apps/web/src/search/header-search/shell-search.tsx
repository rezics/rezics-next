import { useLocation, useNavigate } from '@tanstack/react-router';
import { getLocale } from '../../paraglide/runtime.js';
import { searchFormFields } from '../search-params';
import { HeaderSearch } from './header-search';
import type { SearchScope } from './types';

/** One responsive owner in AppShell. Route filters register their real controls through the provider. */
export function ShellSearch({ scope }: { scope?: SearchScope } = {}) {
  const location = useLocation();
  const navigate = useNavigate();
  const onSearchPage = /(?:^|\/)search\/?$/.test(location.pathname);
  const params = location.search as Record<string, unknown>;
  return (
    <HeaderSearch
      locale={getLocale()}
      scope={scope}
      initialQuery={onSearchPage && typeof params.q === 'string' ? params.q : ''}
      fields={onSearchPage ? searchFormFields(params) : []}
      onNavigate={(href) => {
        void navigate({ href });
      }}
    />
  );
}
