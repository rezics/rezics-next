import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { QueryClientContext } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, useId } from 'react';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { authorErasureAdmissionReads, type AuthorErasureAdmission } from './author-erasure-admission';
import { authorErasureRequest, type ErasureEnqueue, type ErasureIntent } from './author-erasure';
import {
  dispatchAuthorErasure,
  authorErasureSessionIsReady,
  authorErasureSessionSource,
  type AuthorErasureSessionSource,
} from './author-erasure-lifetime';

async function sendNative(intent: ErasureIntent, csrfToken: string, isCurrent: () => boolean): Promise<ErasureEnqueue> {
  // The token belongs to this caller; never look up a fresh token after an asynchronous boundary.
  return (await dispatchAuthorErasure(intent, csrfToken, isCurrent)) ?? { kind: 'uncertain' };
}

export function erasureRefusal(kind: Exclude<ErasureEnqueue['kind'], 'accepted'>): string {
  switch (kind) {
    case 'uncertain':
      return m.author_erasure_uncertain();
    case 'forbidden':
      return m.author_erasure_forbidden();
    case 'not-found':
      return m.author_erasure_not_found();
    case 'signed-out':
      return m.author_erasure_sign_in();
    case 'conflict':
      return m.author_erasure_conflict();
    case 'unavailable':
      return m.author_erasure_unavailable();
  }
}

export function authorErasureEntryScope(
  threadId: string,
  viewerId: string | null,
  session: ReturnType<AuthorErasureSessionSource['read']>,
  previousViewerId: string | null,
) {
  const sessionViewerId = session?.state === 'signed-in' ? session.subject : undefined;
  const stableViewerId = viewerId ?? sessionViewerId ?? previousViewerId;
  return { viewerId: stableViewerId, key: JSON.stringify([threadId, stableViewerId]) };
}

async function readNative(threadId: string, isCurrent: () => boolean = () => true): Promise<AuthorErasureAdmission> {
  if (!isCurrent()) return { kind: 'unavailable' };
  const { readThreadAuthorErasureAdmission } = await import('./author-erasure-server');
  if (!isCurrent()) return { kind: 'unavailable' };
  return readThreadAuthorErasureAdmission({ data: { threadId } });
}

/** Session revisions retire responses; the thread and actor retain the confirmed command intent. */
export function AuthorErasureEntry(props: {
  threadId: string;
  viewerId?: string | null;
  admission?: AuthorErasureAdmission;
  readAdmission?: (threadId: string, isCurrent?: () => boolean) => Promise<AuthorErasureAdmission>;
  send?: (intent: ErasureIntent) => Promise<ErasureEnqueue>;
  onAccepted?: (id: string) => void;
}) {
  const client = useContext(QueryClientContext);
  const source = authorErasureSessionSource(client);
  const revision = useSyncExternalStore(source.subscribe, source.snapshot, source.serverSnapshot);
  const viewerId = props.viewerId ?? null;
  const lastViewerId = useRef<string | null>(viewerId);
  const scope = authorErasureEntryScope(props.threadId, viewerId, source.read(), lastViewerId.current);
  if (scope.viewerId) lastViewerId.current = scope.viewerId;
  return <AuthorErasureEntryVisit key={scope.key} {...props} viewerId={viewerId} source={source} revision={revision} />;
}

function AuthorErasureEntryVisit({
  threadId,
  viewerId,
  admission: suppliedAdmission,
  readAdmission = readNative,
  send,
  onAccepted,
  source,
  revision,
}: {
  threadId: string;
  viewerId: string | null;
  admission?: AuthorErasureAdmission;
  readAdmission?: (threadId: string, isCurrent?: () => boolean) => Promise<AuthorErasureAdmission>;
  send?: (intent: ErasureIntent) => Promise<ErasureEnqueue>;
  onAccepted?: (id: string) => void;
  source: AuthorErasureSessionSource;
  revision: number;
}) {
  const heading = useId();
  const review = useId();
  const action = useId();
  const [open, setOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<ErasureEnqueue | null>(null);
  const [, updateAdmission] = useState(0);
  const request = useRef<ErasureIntent | null>(null);
  const busy = useRef(false);
  const observedRevision = useRef(revision);
  const reads = useRef(authorErasureAdmissionReads());
  const mounted = useRef(false);
  const connection = useRef(0);

  useLayoutEffect(() => {
    mounted.current = true;
    connection.current += 1;
    return () => {
      mounted.current = false;
      connection.current += 1;
      reads.current.retire();
    };
  }, []);

  useLayoutEffect(() => {
    if (open) document.getElementById(heading)?.focus();
  }, [heading, open]);

  useEffect(() => {
    if (observedRevision.current === revision) return;
    observedRevision.current = revision;
    if (!busy.current) return;
    busy.current = false;
    setPending(false);
    setResult({ kind: 'uncertain' });
  }, [revision]);

  const isCurrent = (ticket = connection.current) =>
    mounted.current &&
    ticket === connection.current &&
    source.snapshot() === revision &&
    authorErasureSessionIsReady(source.read(), viewerId);
  const admissionNow = reads.current.bind(threadId, viewerId, open, revision);
  const admission = suppliedAdmission ?? admissionNow;

  async function refresh(nextOpen = open) {
    if (suppliedAdmission || !viewerId) return;
    reads.current.bind(threadId, viewerId, nextOpen, revision);
    const ticket = connection.current;
    const current = () => isCurrent(ticket);
    const pendingRead = reads.current.refresh(viewerId, () => readAdmission(threadId, current), current);
    setOpen(nextOpen);
    updateAdmission((value) => value + 1);
    if ((await pendingRead) && current()) updateAdmission((value) => value + 1);
  }

  function toggle(next: boolean) {
    reads.current.bind(threadId, viewerId, next, revision);
    setOpen(next);
    if (next) void refresh(true);
  }

  const session = source.read();
  const sessionReady = authorErasureSessionIsReady(session, viewerId) && source.snapshot() === revision;
  const allowed = admission.kind === 'current' && admission.mayErase;
  const unavailable = admission.kind === 'unavailable';
  const retrying = result?.kind === 'uncertain' && !!request.current;
  const canSubmit = sessionReady && (allowed || retrying);
  const accepted = result?.kind === 'accepted';
  const stopped = result && result.kind !== 'uncertain' && result.kind !== 'accepted';

  async function submit() {
    if (!canSubmit || !confirmed || busy.current || accepted || stopped) return;
    const sessionAtIntent = source.read();
    if (!authorErasureSessionIsReady(sessionAtIntent, viewerId) || source.snapshot() !== revision) return;
    const ticket = connection.current;
    const current = () => isCurrent(ticket);
    busy.current = true;
    setPending(true);
    if (!request.current) request.current = Object.freeze({ threadId, idempotencyKey: crypto.randomUUID() });
    let outcome: ErasureEnqueue;
    try {
      outcome = await authorErasureRequest(request.current, (intent) => {
        if (!current()) return Promise.resolve({ kind: 'uncertain' });
        return send ? send(intent) : sendNative(intent, sessionAtIntent.csrfToken, current);
      })();
    } catch {
      outcome = { kind: 'uncertain' };
    }
    if (!current()) return;
    setResult(outcome);
    busy.current = false;
    setPending(false);
    if (outcome.kind === 'accepted') {
      if (onAccepted) onAccepted(outcome.operationId);
      else window.location.assign(`/${getLocale()}/operations/${encodeURIComponent(outcome.operationId)}`);
    }
  }

  return (
    <section aria-label={m.author_erasure_action()} className="min-w-0 text-sm">
      <Button
        variant="ghost"
        size="sm"
        id={action}
        className="h-auto min-h-11 max-w-full whitespace-normal text-left"
        aria-expanded={open}
        aria-controls={open ? review : undefined}
        onClick={() => toggle(!open)}
        disabled={pending}
      >
        <Trash2 aria-hidden="true" className="size-4" />
        {m.author_erasure_action()}
      </Button>
      {open ? (
        <ContentItemFrame
          as="div"
          id={review}
          data-slot="content-item-frame"
          className="mt-3 min-w-0 space-y-4 p-4 sm:p-5"
          aria-labelledby={heading}
        >
          <ContentItemHeading id={heading} tabIndex={-1} level={2} className="font-semibold">
            {m.author_erasure_confirm_title()}
          </ContentItemHeading>
          <p className="max-w-prose break-words leading-relaxed text-muted-foreground">{m.author_erasure_scope()}</p>
          <p className="max-w-prose break-words leading-relaxed">{m.author_erasure_irreversible()}</p>
          {!allowed ? (
            <p role="status" className="max-w-prose break-words leading-relaxed text-muted-foreground">
              {unavailable
                ? m.author_erasure_admission_unavailable()
                : admission.kind === 'current'
                  ? m.author_erasure_forbidden()
                  : erasureRefusal(admission.kind)}
            </p>
          ) : null}
          {result && result.kind !== 'accepted' ? (
            <p role="alert" className="max-w-prose break-words leading-relaxed">
              {erasureRefusal(result.kind)}
            </p>
          ) : null}
          {accepted ? (
            <a
              className={buttonVariants({
                variant: 'outline',
                className: 'h-auto min-h-11 max-w-full whitespace-normal text-left',
              })}
              href={`/${getLocale()}/operations/${encodeURIComponent(result.operationId)}`}
            >
              {m.author_erasure_view_progress()}
            </a>
          ) : (
            <>
              <label className="relative z-10 flex min-w-0 items-start gap-3 break-words leading-relaxed">
                <input
                  type="checkbox"
                  className="mt-1 size-4 shrink-0 accent-primary"
                  checked={confirmed}
                  disabled={!allowed || pending || !!request.current}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                {m.author_erasure_confirmation()}
              </label>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="destructive"
                  className="h-auto min-h-11 max-w-full whitespace-normal text-left"
                  disabled={!canSubmit || !confirmed || pending || !!stopped}
                  onClick={submit}
                >
                  {pending
                    ? m.author_erasure_submitting()
                    : result?.kind === 'uncertain'
                      ? m.author_erasure_retry()
                      : m.author_erasure_confirm()}
                </Button>
                {!suppliedAdmission ? (
                  <Button
                    variant="outline"
                    className="h-auto min-h-11 max-w-full whitespace-normal text-left"
                    disabled={pending || !viewerId}
                    onClick={() => void refresh()}
                  >
                    {m.author_erasure_check_again()}
                  </Button>
                ) : null}
                <Button
                  variant="outline"
                  className="h-auto min-h-11 max-w-full whitespace-normal text-left"
                  disabled={pending}
                  onClick={() => {
                    document.getElementById(action)?.focus();
                    toggle(false);
                  }}
                >
                  {m.author_erasure_close()}
                </Button>
              </div>
            </>
          )}
        </ContentItemFrame>
      ) : null}
    </section>
  );
}
