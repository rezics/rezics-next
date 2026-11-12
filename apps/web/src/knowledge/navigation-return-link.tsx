import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useLayoutEffect } from 'react';
import { Link, useRouter } from '@tanstack/react-router';
import { readerSessionSource } from '../reader/lifetime';
import { m } from '../paraglide/messages.js';
import type { KnowledgePrivateAddress } from './private-knowledge';
import { KnowledgeNavigationReturn } from './navigation-return';

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

export const knowledgeNavigationControl =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal break-words px-4 py-2 text-start leading-snug [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
export const knowledgeNavigationLink =
  'inline-flex min-h-11 min-w-11 max-w-full items-center rounded-sm py-2 text-primary underline underline-offset-4 [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

export function KnowledgeNavigationReturnLink({
  address,
  binding,
  locale,
}: {
  address: KnowledgePrivateAddress;
  binding: string;
  locale: string;
}) {
  const returning = useKnowledgeNavigationReturn();
  returning.retireForAddress(binding, address);
  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl px-4 pt-4 sm:px-6">
      <Link
        to="/knowledge/notebooks/$notebookId"
        params={{ notebookId: address.notebookId }}
        preload={false}
        className={knowledgeNavigationLink}
        onClick={(event) => {
          if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey)
            returning.returnTo(binding, address);
        }}
      >
        {m.knowledge_navigation_return({}, { locale: locale as never })}
      </Link>
    </div>
  );
}
