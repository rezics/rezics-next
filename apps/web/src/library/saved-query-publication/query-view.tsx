import { useEffect, useRef, useState } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { publicationReadWithin } from '../collection-publication';
import { isRecord } from '../collection-records';
import {
  queryPublicationAddress,
  queryPublicationInput,
  type QueryPublicationInput,
  type QueryPublicationResult,
  type QueryPublicationStatus,
} from './query';

type Address = { collectionId: string; id: string };
type Transport = {
  begin(input: QueryPublicationInput): Promise<QueryPublicationResult>;
  read(input: Address): Promise<QueryPublicationResult>;
};
type Attempt = { input: QueryPublicationInput; id: string | null; transport: Transport };

/** Recovery stores the request and accepted locator, never facts, a population or a credential. */
export function QueryPublicationView({
  subject,
  collectionId,
  revision,
  visibility,
  capture,
  isCurrent,
  canBegin,
}: {
  subject: string;
  collectionId: string;
  revision: number;
  visibility?: 'private' | 'public' | 'unlisted' | null | undefined;
  capture(): Transport | null;
  isCurrent(): boolean;
  canBegin(): boolean;
}) {
  const storageKey = JSON.stringify(['collection-query-publication', subject, collectionId]);
  const collectionHref = `/${getLocale()}/collections/${encodeURIComponent(collectionId)}`;
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [status, setStatus] = useState<QueryPublicationStatus | null>(null);
  const [failure, setFailure] = useState<Extract<QueryPublicationResult, { ok: false }>['reason'] | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [target, setTarget] = useState<'public' | 'unlisted'>(visibility === 'public' ? 'public' : 'unlisted');
  const live = useRef(true);
  const running = useRef(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    live.current = true;
    const saved = sessionStorage.getItem(storageKey);
    if (saved) {
      // Retained browser bytes are an external file boundary. Invalid bytes must not create a new request.
      const data: unknown = JSON.parse(saved);
      if (!isRecord(data)) throw new Error('Invalid retained publication request');
      const { id: retainedId, ...request } = data;
      const input = queryPublicationInput(request);
      const id =
        retainedId === null ? null : queryPublicationAddress({ collectionId: input.collectionId, id: retainedId }).id;
      const transport = capture();
      if (input.collectionId === collectionId && transport) setAttempt({ input, id, transport });
    }
    setLoaded(true);
    return () => {
      live.current = false;
    };
  }, [storageKey]);

  function retain(current: Attempt) {
    // A lost begin acknowledgement is recoverable with precisely the original key/body as well.
    sessionStorage.setItem(storageKey, JSON.stringify({ ...current.input, id: current.id }));
    setAttempt(current);
  }

  async function run(current: Attempt) {
    if (running.current || !isCurrent()) return;
    running.current = true;
    setBusy(true);
    setFailure(null);
    try {
      const response = current.id
        ? current.transport.read({ collectionId, id: current.id })
        : current.transport.begin(current.input);
      const result = await publicationReadWithin<QueryPublicationResult>(response, 25_000, {
        ok: false,
        reason: 'unknown',
      });
      if (!live.current || !isCurrent()) return;
      if (!result.ok) {
        setFailure(result.reason);
        return;
      }
      retain({ ...current, id: result.status.id });
      setStatus(result.status);
      if (result.status.phase === 'complete' || result.status.phase === 'refused')
        sessionStorage.removeItem(storageKey);
    } catch (error) {
      // A failed fetch cannot tell whether a dispatched command committed. Keep the original request.
      if (!(error instanceof TypeError)) throw error;
      if (live.current && isCurrent()) setFailure('unknown');
    } finally {
      running.current = false;
      if (live.current && isCurrent()) setBusy(false);
    }
  }

  function begin() {
    if (running.current || !loaded || !confirmed || !canBegin() || attempt) return;
    const transport = capture();
    if (!transport) return;
    const current: Attempt = {
      input: { collectionId, revision, visibility: target, idempotencyKey: crypto.randomUUID() },
      id: null,
      transport,
    };
    retain(current);
    void run(current);
  }

  const complete = status?.phase === 'complete';
  const refused = status?.phase === 'refused';
  return (
    <section className="space-y-4 rounded-xl border border-border p-5" aria-labelledby="query-publication-heading">
      <h1 id="query-publication-heading" className="text-xl font-semibold">
        {m.library_query_publication_heading()}
      </h1>
      <p className="text-muted-foreground">{m.library_query_publication_description()}</p>
      <p>{m.library_publication_privacy()}</p>
      {!attempt ? (
        <>
          <label className="flex flex-wrap items-center gap-3">
            {m.library_query_publication_visibility()}
            <select
              value={target}
              onChange={(event) => setTarget(event.target.value as 'public' | 'unlisted')}
              className="min-h-11 rounded-md border border-border bg-background px-3"
              disabled={busy}
            >
              <option value="unlisted">{m.library_visibility_unlisted()}</option>
              <option value="public">{m.library_visibility_public()}</option>
            </select>
          </label>
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
              className="mt-1 size-5 shrink-0"
              disabled={busy}
            />
            <span>{m.library_query_publication_confirm()}</span>
          </label>
          <Button disabled={!loaded || !confirmed || busy || !canBegin()} onClick={begin}>
            {m.library_query_publication_publish()}
          </Button>
        </>
      ) : (
        <>
          <p>{m.library_query_publication_recovery()}</p>
          {status && !complete && !refused ? <p role="status">{m.library_publication_pending()}</p> : null}
          {refused ? <p role="alert">{m.library_publication_denied()}</p> : null}
          {complete ? (
            <div role="status" className="space-y-2">
              <p>{m.library_query_publication_complete()}</p>
              <p className="break-all">
                {m.library_publication_published_generation({ generation: status.publication.generation })}
              </p>
              <a className="inline-flex min-h-11 items-center text-primary underline" href={collectionHref}>
                {m.library_publication_view()}
              </a>
            </div>
          ) : (
            <Button disabled={busy || !isCurrent() || refused} onClick={() => void run(attempt)}>
              {attempt.id ? m.library_query_publication_status() : m.library_publication_retry()}
            </Button>
          )}
        </>
      )}
      {busy ? <p role="status">{m.library_query_publication_loading()}</p> : null}
      {failure ? (
        <p role="alert">
          {failure === 'denied'
            ? m.library_publication_denied()
            : failure === 'stale'
              ? m.library_publication_stale()
              : failure === 'closed'
                ? m.platform_closed_heading()
                : m.library_query_publication_unknown()}
        </p>
      ) : null}
      <a className="inline-flex min-h-11 items-center text-primary underline" href={collectionHref}>
        {m.library_publication_back()}
      </a>
    </section>
  );
}
