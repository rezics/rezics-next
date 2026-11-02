import { useCallback, useEffect } from 'react';
import { useLocation, useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { getLocale } from '../../paraglide/runtime.js';
import { searchFormFields } from '../search-params';
import { useSession } from '../../session/query';
import { recentBucket } from '../recent-history';
import { useRecentHistory } from '../recent-history-hook';
import { HeaderSearch } from './header-search';
import type { SearchScope } from './types';
import { currentHeaderSearchSession } from './session-key';

/** One responsive owner in AppShell. Route filters register their real controls through the provider. */
export function ShellSearch({ scope }: { scope?: SearchScope } = {}) {
  const location = useLocation();
  const navigate = useNavigate();
  const session = useSession();
  const client = useQueryClient();
  const readSession = useCallback(() => currentHeaderSearchSession(client), [client]);
  const bucket = recentBucket(session.state, session.subject);
  const history = useRecentHistory(bucket);
  useEffect(() => {
    if (scope) history.remember('', scope);
  }, [scope, bucket]);
  const onSearchPage = /(?:^|\/)search\/?$/.test(location.pathname);
  const params = location.search as Record<string, unknown>;
  return (
    <HeaderSearch
      keyboardShortcut
      locale={getLocale()}
      history={history}
      session={session}
      readSession={readSession}
      scope={scope}
      initialQuery={onSearchPage && typeof params.q === 'string' ? params.q : ''}
      fields={onSearchPage ? searchFormFields(params) : []}
      onNavigate={(href) => {
        void navigate({ href });
      }}
    />
  );
}
