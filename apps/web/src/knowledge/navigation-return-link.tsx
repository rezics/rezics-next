import { knowledgeControl, knowledgeLink } from './workspace';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useLayoutEffect } from 'react';
import { Link, useRouter } from '@tanstack/react-router';
import { readerSessionSource } from '../reader/lifetime';
import { m } from '../paraglide/messages.js';
import type { KnowledgePrivateAddress } from './private-knowledge';
import { KnowledgeNavigationReturn } from './navigation-return';
import { KnowledgeNavigationFocus } from './navigation-focus';

const returns = new WeakMap<QueryClient, KnowledgeNavigationReturn>();
export function knowledgeNavigationReturn(client: QueryClient) {
  let current = returns.get(client);
  if (!current) {
    current = new KnowledgeNavigationReturn();
    returns.set(client, current);
    const reading = current;
    // These existing observers retire the one slot without a watcher, timer or native read.
    readerSessionSource(client).subscribe(() => reading.clear());
    client.getQueryCache().subscribe((event) => {
      if (
        event.query.queryKey[0] === 'exposure' &&
        event.query.queryKey[1] === 'viewer' &&
        (event.type === 'removed' || (event.type === 'updated' && event.action.type !== 'fetch'))
      )
        reading.clear();
    });
  }
  return current;
}

export function useKnowledgeNavigationReturn() {
  const client = useQueryClient();
  const router = useRouter();
  const returning = knowledgeNavigationReturn(client);
  useLayoutEffect(
    () => router.subscribe('onBeforeNavigate', ({ toLocation }) => returning.leave(toLocation.pathname)),
    [router, returning],
  );
  return returning;
}

export const knowledgeNavigationControl = knowledgeControl;
export const knowledgeNavigationLink = knowledgeLink;

export function KnowledgeNavigationReturnLink({
  address,
  binding,
  locale,
  embedded = false,
}: {
  address: KnowledgePrivateAddress;
  binding: string;
  locale: string;
  embedded?: boolean;
}) {
  const returning = useKnowledgeNavigationReturn();
  returning.retireForAddress(binding, address);
  return (
    <div className={embedded ? 'min-w-0' : 'mx-auto w-full min-w-0 max-w-6xl px-4 pt-4 sm:px-6'}>
      <Link
        to="/knowledge/notebooks/$notebookId"
        params={{ notebookId: address.notebookId }}
        preload={false}
        className={knowledgeNavigationLink}
        onClick={(event) => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          const orientation = new KnowledgeNavigationFocus();
          const keyboard = orientation.request(event.currentTarget, event.detail === 0);
          returning.returnTo(binding, address, keyboard ? orientation : undefined);
        }}
      >
        {m.knowledge_navigation_return({}, { locale: locale as never })}
      </Link>
    </div>
  );
}
