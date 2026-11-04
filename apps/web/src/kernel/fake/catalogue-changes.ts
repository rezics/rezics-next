import { createKernelClient } from '@rezics/client';
import { catalogueSourcesFixture, sourceDefinitions } from './catalogue-sources';
import { readSubjectChange, readSubjectChanges, type ChangesTransport } from '../../features/catalogue/subject-changes';
import type { RevisionDetailPort } from '../../features/catalogue/subject-changes-detail';

export type ChangesScenario =
  | 'ready'
  | 'empty'
  | 'loading'
  | 'denied'
  | 'invalid'
  | 'conflict'
  | 'unavailable'
  | 'detail-retry'
  | 'missing';
export const changesCursor = 'opaque:+/next?=visible';
export const changesLastCursor = 'opaque:/last?=page';

/** Existing subject fixture plus generated-client list and optional native detail responses.
 * Without a supplied response, this fixture deliberately exercises unavailable detail.
 */
export function catalogueChangesFixture(
  scenario: ChangesScenario = 'ready',
  locale = 'en',
  port?: RevisionDetailPort,
  nativeDetail?: (revision: number) => Response | Promise<Response>,
) {
  const { id, read } = catalogueSourcesFixture();
  let outcome = scenario;
  let subjectStatus = 200;
  let actionOutcome: 'available' | 'component-unavailable' | 'unavailable' | 'preparing' = 'available';
  let actionOperations = ['subject.propose', 'subject.terms'];
  const calls: {
    path: string;
    cursor: string | null;
    includeViewerActions: boolean;
    authorization: string | null;
    session: string | null;
    cache: RequestCache;
    redirect: RequestRedirect;
  }[] = [];
  const client = createKernelClient('http://changes.test', {
    fetch: (async (input, init) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(request.url);
      calls.push({
        path: url.pathname,
        cursor: url.searchParams.get('cursor'),
        includeViewerActions: url.searchParams.get('includeViewerActions') === 'true',
        authorization: request.headers.get('authorization'),
        session: request.headers.get('rezics-session-token'),
        cache: request.cache,
        redirect: request.redirect,
      });
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json', 'rezics-session-token': 'changes-session' },
        });
      if (url.pathname === `/v1/subjects/${id}`) {
        if (subjectStatus !== 200) return json({ code: 'not_found' }, subjectStatus);
        if (url.searchParams.get('includeViewerActions') !== 'true') return json(read);
        if (actionOutcome === 'preparing') return json({ code: 'semantic_not_ready' }, 503);
        if (actionOutcome === 'unavailable') return json({ code: 'overloaded' }, 503);
        if (actionOutcome === 'component-unavailable')
          return json({ ...read, viewerActions: { state: 'unavailable' } });
        return json({
          ...read,
          viewerActions: {
            state: 'available',
            actions: [{ action: 'statement:propose', operations: actionOperations }],
          },
        });
      }
      const detailPath = `/v1/subjects/${id}/revisions/`;
      if (url.pathname.startsWith(detailPath))
        return nativeDetail?.(Number(url.pathname.slice(detailPath.length))) ?? json({ code: 'overloaded' }, 503);
      if (url.pathname !== `/v1/subjects/${id}/revisions`) return json({ code: 'not_found' }, 404);
      if (outcome === 'loading') return new Promise<Response>(() => {});
      const status =
        outcome === 'denied'
          ? 403
          : outcome === 'missing'
            ? 404
            : outcome === 'invalid'
              ? 400
              : outcome === 'conflict'
                ? 409
                : outcome === 'unavailable'
                  ? 503
                  : 200;
      if (status !== 200) return json({ code: 'not_available' }, status);
      const cursor = url.searchParams.get('cursor');
      const row = (revision: number, kind: string) => ({ revision, kind, release: read.subject.release, source: null });
      return json(
        outcome === 'empty'
          ? { revisions: [], next: null }
          : cursor === changesCursor
            ? { revisions: [], next: changesLastCursor }
            : cursor === changesLastCursor
              ? { revisions: [row(2, 'terms')], next: null }
              : { revisions: [row(5, 'propose'), row(4, 'accept')], next: changesCursor },
      );
    }) as typeof fetch,
  });
  const transport: ChangesTransport = {
    list: (cursor, session) =>
      readSubjectChanges(client, id, locale, {
        cursor,
        session,
        authorization: 'Bearer story',
        definitions: Promise.resolve(sourceDefinitions),
      }),
    detail: (revision, session) =>
      readSubjectChange(
        client,
        id,
        revision,
        { authorization: 'Bearer story', session },
        outcome === 'detail-retry' ? async () => ({ kind: 'unavailable' }) : port,
      ),
  };
  return {
    id,
    read,
    client,
    calls,
    transport,
    recover: () => {
      outcome = 'ready';
    },
    conceal: () => {
      subjectStatus = 404;
    },
    setActionOutcome: (value: 'available' | 'component-unavailable' | 'unavailable' | 'preparing') => {
      actionOutcome = value;
    },
    setActionOperations: (operations: string[]) => {
      actionOperations = operations;
    },
  };
}
