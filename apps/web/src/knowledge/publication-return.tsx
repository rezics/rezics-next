import { useLayoutEffect, useSyncExternalStore, type ReactNode } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Link, useRouter } from '@tanstack/react-router';
import { readerSessionSource } from '../reader/lifetime';
import { m } from '../paraglide/messages.js';
import type { KnowledgePrivateAddress } from './private-knowledge';
import { knowledgeLink } from './workspace';
import { knowledgeExactHref, knowledgeLiveHref } from './public-read';

type Origin = KnowledgePrivateAddress & { locale: string };

/** A navigation convenience from an admitted editor, never evidence of public or private access. */
class KnowledgePublicationReturn {
  private origin: Origin | null = null;
  private generation = 0;
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = () => this.origin;
  source = () => this.generation;
  serverSnapshot = () => null;
  remember(address: KnowledgePrivateAddress, locale: string, generation: number) {
    // A session/exposure retirement can arrive before React removes an old reading link.
    if (generation !== this.generation) return;
    this.origin = { ...address, locale };
    for (const listener of this.listeners) listener();
  }
  read(documentId: string, locale: string) {
    const origin = this.origin;
    return origin && origin.documentId === documentId && origin.locale === locale ? origin : null;
  }
  leave(pathname: string) {
    const origin = this.origin;
    if (!origin) return;
    const path = pathname.replace(/\/$/, '');
    if (
      path === `/${origin.locale}/knowledge/documents/${origin.documentId}` ||
      path === `/knowledge/documents/${origin.documentId}`
    )
      return;
    if (
      path === `/${origin.locale}/knowledge/notebooks/${origin.notebookId}/documents/${origin.documentId}` ||
      path === `/knowledge/notebooks/${origin.notebookId}/documents/${origin.documentId}`
    )
      return;
    this.clear();
  }
  clear = () => {
    this.generation++;
    this.origin = null;
    for (const listener of this.listeners) listener();
  };
}

const returns = new WeakMap<QueryClient, KnowledgePublicationReturn>();
function publicationReturn(client: QueryClient) {
  let returning = returns.get(client);
  if (!returning) {
    returning = new KnowledgePublicationReturn();
    returns.set(client, returning);
    readerSessionSource(client).subscribe(returning.clear);
    const current = returning;
    client.getQueryCache().subscribe((event) => {
      if (
        event.query.queryKey[0] === 'exposure' &&
        event.query.queryKey[1] === 'viewer' &&
        (event.type === 'removed' || (event.type === 'updated' && event.action.type !== 'fetch'))
      )
        current.clear();
    });
  }
  return returning;
}

function usePublicationReturn(locale: string) {
  const returning = publicationReturn(useQueryClient());
  const router = useRouter();
  useSyncExternalStore(returning.subscribe, returning.source, returning.source);
  useLayoutEffect(() => {
    const origin = returning.snapshot();
    if (origin && origin.locale !== locale) returning.clear();
  }, [returning, locale]);
  useLayoutEffect(
    () => router.subscribe('onBeforeNavigate', ({ toLocation }) => returning.leave(toLocation.pathname)),
    [router, returning],
  );
  return returning;
}

/** Modified clicks open an independent visit and intentionally carry no private return context. */
export function KnowledgePublicationReaderLink({
  address,
  locale,
  revisionId,
  children,
}: {
  address: KnowledgePrivateAddress;
  locale: string;
  revisionId?: string | undefined;
  children: ReactNode;
}) {
  const returning = usePublicationReturn(locale);
  const router = useRouter();
  const generation = returning.source();
  return (
    <a
      href={
        revisionId
          ? knowledgeExactHref(locale, address.documentId, revisionId)
          : knowledgeLiveHref(locale, address.documentId)
      }
      className={knowledgeLink}
      onClick={(event) => {
        if (
          event.defaultPrevented ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey ||
          event.button !== 0
        )
          return;
        event.preventDefault();
        returning.remember(address, locale, generation);
        void router.navigate({
          to: '/knowledge/documents/$id',
          params: { id: address.documentId },
          search: revisionId ? { revisionId } : {},
        });
      }}
    >
      {children}
    </a>
  );
}

export function KnowledgePublicationReturnLink({ documentId, locale }: { documentId: string; locale: string }) {
  const returning = usePublicationReturn(locale);
  const snapshot = useSyncExternalStore(returning.subscribe, returning.snapshot, returning.serverSnapshot);
  const origin = snapshot ? returning.read(documentId, locale) : null;
  if (!origin) return null;
  return (
    <nav
      className="mx-auto flex w-full min-w-0 max-w-3xl flex-wrap gap-x-6 gap-y-2 px-4 pt-5 sm:px-6"
      aria-label={m.knowledge_workspace_documents({}, { locale: locale as never })}
    >
      <Link
        to="/knowledge/notebooks/$notebookId/documents/$documentId"
        params={{ notebookId: origin.notebookId, documentId }}
        preload={false}
        className={knowledgeLink}
      >
        {m.knowledge_workspace_return_editor({}, { locale: locale as never })}
      </Link>
      <Link
        to="/knowledge/notebooks/$notebookId"
        params={{ notebookId: origin.notebookId }}
        preload={false}
        className={knowledgeLink}
      >
        {m.knowledge_navigation_return({}, { locale: locale as never })}
      </Link>
    </nav>
  );
}
