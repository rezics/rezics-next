import { useLayoutEffect, useSyncExternalStore, type ReactNode } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Link, useRouter } from '@tanstack/react-router';
import { readerSessionSource } from '../reader/lifetime';
import { m } from '../paraglide/messages.js';
import type { KnowledgePrivateAddress } from './private-knowledge';
import { knowledgeLink } from './workspace';
import { knowledgeExactHref, knowledgeLiveHref } from './public-read';

type Origin = KnowledgePrivateAddress & { locale: string; expires: number };

/** A navigation convenience from an admitted editor, never evidence of public or private access. */
export class KnowledgePublicationReturn {
  private origin: Origin | null = null;
  private listeners = new Set<() => void>();
  constructor(private now = () => Date.now()) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = () => this.origin;
  serverSnapshot = () => null;
  remember(address: KnowledgePrivateAddress, locale: string) {
    this.origin = { ...address, locale, expires: this.now() + 15 * 60_000 };
    for (const listener of this.listeners) listener();
  }
  read(documentId: string, locale: string) {
    const origin = this.origin;
    return origin && origin.documentId === documentId && origin.locale === locale && origin.expires > this.now()
      ? origin
      : null;
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

function usePublicationReturn() {
  const returning = publicationReturn(useQueryClient());
  const router = useRouter();
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
  const returning = usePublicationReturn();
  const router = useRouter();
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
        returning.remember(address, locale);
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
  const returning = usePublicationReturn();
  useSyncExternalStore(returning.subscribe, returning.snapshot, returning.serverSnapshot);
  const origin = returning.read(documentId, locale);
  if (!origin) return null;
  return (
    <nav
      className="mx-auto w-full min-w-0 max-w-3xl px-4 pt-5 sm:px-6"
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
    </nav>
  );
}
