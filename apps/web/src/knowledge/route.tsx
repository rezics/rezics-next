import { useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import { useQueryClient } from '@tanstack/react-query';
import { notFound, useLoaderData, useParams, useRouter, useRouterState, useSearch } from '@tanstack/react-router';
import { readerSessionSource } from '../reader/lifetime';
import { getLocale } from '../paraglide/runtime.js';
import { KnowledgeDocumentPage } from './page';
import {
  knowledgeId,
  knowledgeRevisionQuery,
  readKnowledgeDocument,
  sameKnowledgeRequest,
  type KnowledgeReadRequest,
  type KnowledgeReadState,
} from './public-read';

export { readKnowledgeDocument } from './public-read';
export { KnowledgeDocumentPage } from './page';
export { parseKnowledgePrivateAddress, parseKnowledgePrivateSubjectSearch } from './private-knowledge';
export { KnowledgePrivateAccessEntry, KnowledgePrivatePage } from './private-page';

export type KnowledgeDocumentVisit = {
  request: KnowledgeReadRequest;
  sessionRevision: number;
  page: KnowledgeReadState;
};

const retiredVisits = new WeakSet<KnowledgeDocumentVisit>();

function retireVisit(visit: KnowledgeDocumentVisit) {
  retiredVisits.add(visit);
  visit.page = { state: 'preparing' };
}

export function knowledgeDocumentSearch(search: Record<string, unknown>): { revisionId?: string } {
  if (!('revisionId' in search) || search.revisionId === undefined || search.revisionId === '') return {};
  const revisionId = knowledgeRevisionQuery(search.revisionId);
  if (!revisionId) throw notFound();
  return { revisionId };
}

export function knowledgeDocumentRequest(
  documentId: string,
  revisionId: string | undefined,
  locale: string,
): KnowledgeReadRequest | null {
  const id = knowledgeId(documentId);
  if (!id) return null;
  if (revisionId === undefined) return { documentId: id, revisionId: null, locale };
  const exact = knowledgeId(revisionId);
  return exact ? { documentId: id, revisionId: exact, locale } : null;
}

export async function openKnowledgeDocumentVisit(
  sessionRevision: number,
  request: KnowledgeReadRequest,
  read: (request: KnowledgeReadRequest) => Promise<KnowledgeReadState>,
): Promise<KnowledgeDocumentVisit> {
  return { request: { ...request }, sessionRevision, page: await read(request) };
}

export async function loadKnowledgeDocumentVisit(
  queryClient: QueryClient,
  request: KnowledgeReadRequest,
): Promise<KnowledgeDocumentVisit> {
  return openKnowledgeDocumentVisit(readerSessionSource(queryClient).snapshot(), request, (current) =>
    readKnowledgeDocument({ data: current }),
  );
}

function displayedPage(
  visit: KnowledgeDocumentVisit,
  request: KnowledgeReadRequest,
  sessionRevision: number,
  loading: boolean,
): KnowledgeReadState {
  if (loading || retiredVisits.has(visit) || visit.sessionRevision !== sessionRevision) return { state: 'preparing' };
  if (!sameKnowledgeRequest(visit.request, request)) return { state: 'preparing' };
  return visit.page;
}

export function KnowledgeDocumentRoute() {
  const documentId = useParams({ from: '/knowledge/documents/$id' }).id;
  const search = useSearch({ from: '/knowledge/documents/$id' });
  const visit = useLoaderData({ from: '/knowledge/documents/$id' });
  const router = useRouter();
  const loading = useRouterState({ select: (state) => state.isLoading });
  const locale = getLocale();
  const request = knowledgeDocumentRequest(documentId, search.revisionId, locale) ?? visit.request;
  return (
    <KnowledgeDocumentCaller
      visit={visit}
      request={request}
      loading={loading}
      onRetry={() => {
        void router.invalidate();
      }}
    />
  );
}

export function KnowledgeDocumentPending() {
  const documentId = useParams({ from: '/knowledge/documents/$id' }).id;
  const search = useSearch({ from: '/knowledge/documents/$id' });
  const locale = getLocale();
  const request = knowledgeDocumentRequest(documentId, search.revisionId, locale) ?? {
    documentId,
    revisionId: search.revisionId ?? null,
    locale,
  };
  return <KnowledgeDocumentPage request={request} page={{ state: 'preparing' }} />;
}

export function KnowledgeDocumentCaller({
  visit,
  request,
  loading,
  onRetry,
}: {
  visit: KnowledgeDocumentVisit;
  request: KnowledgeReadRequest;
  loading: boolean;
  onRetry: () => void;
}) {
  const queryClient = useQueryClient();
  const source = readerSessionSource(queryClient);
  const sessionRevision = useSyncExternalStore(source.subscribe, source.snapshot, source.serverSnapshot);
  const owner = useRef<object | null>(null);
  owner.current ??= {};
  const active = useRef<{ visit: KnowledgeDocumentVisit; request: KnowledgeReadRequest } | null>(null);
  const previous = active.current;
  if (previous && (previous.visit !== visit || !sameKnowledgeRequest(previous.request, request))) {
    retireVisit(previous.visit);
  }
  active.current = { visit, request };
  if (!sameKnowledgeRequest(visit.request, request) && !retiredVisits.has(visit)) retireVisit(visit);
  if (visit.sessionRevision !== sessionRevision && !retiredVisits.has(visit)) retireVisit(visit);

  const connection = useRef(0);
  useLayoutEffect(() => {
    const current = ++connection.current;
    const stop = source.subscribe(() => {
      if (source.snapshot() !== visit.sessionRevision) retireVisit(visit);
    });
    return () => {
      stop();
      queueMicrotask(() => {
        if (connection.current !== current) return;
        if (active.current?.visit === visit) return;
        retireVisit(visit);
      });
    };
  }, [visit, source]);

  const page = displayedPage(visit, request, sessionRevision, loading);
  const retry = () => {
    const current = active.current;
    if (
      current?.visit !== visit ||
      !sameKnowledgeRequest(current.request, request) ||
      loading ||
      !sameKnowledgeRequest(visit.request, request)
    )
      return;
    retireVisit(visit);
    onRetry();
  };

  return <KnowledgeDocumentPage request={request} page={page} onRetry={retry} />;
}
