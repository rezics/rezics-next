import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { QueryClientContext } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, useId } from 'react';
import { m } from '../paraglide/messages.js';
import { authorErasureAdmissionReads, type AuthorErasureAdmission } from './author-erasure-admission';
import { authorErasureRequest, type ErasureEnqueue, type ErasureIntent } from './author-erasure';
import {
  dispatchAuthorErasure,
  useAuthorErasureBrowserVisit,
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
  send?: (intent: ErasureIntent, csrfToken: string, isCurrent: () => boolean) => Promise<ErasureEnqueue>;
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
  send = sendNative,
  onAccepted,
  source,
  revision,
}: {
  threadId: string;
  viewerId: string | null;
  admission?: AuthorErasureAdmission;
  readAdmission?: (threadId: string, isCurrent?: () => boolean) => Promise<AuthorErasureAdmission>;
  send?: (intent: ErasureIntent, csrfToken: string, isCurrent: () => boolean) => Promise<ErasureEnqueue>;
  onAccepted?: (id: string) => void;
  source: AuthorErasureSessionSource;
  revision: number;
}) {
  const heading = useId();
  const review = useId();
  const action = useId();
  const [open, setOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [pendingState, setPending] = useState(false);
  const [resultState, setResult] = useState<ErasureEnqueue | null>(null);
  const [, updateAdmission] = useState(0);
  const browser = useAuthorErasureBrowserVisit();
  const request = useRef<{
    intent: ErasureIntent;
    actor: string;
    credential: string;
    source: AuthorErasureSessionSource;
  } | null>(null);
  const lifetimeRef = useRef<{
    source: AuthorErasureSessionSource;
    revision: number;
    admission: typeof suppliedAdmission;
    read: typeof readAdmission;
    send: typeof send;
    accepted: typeof onAccepted;
    epoch: number;
  } | null>(null);
  const previous = lifetimeRef.current;
  if (
    !previous ||
    previous.source !== source ||
    previous.revision !== revision ||
    previous.admission !== suppliedAdmission ||
    previous.read !== readAdmission ||
    previous.send !== send ||
    previous.accepted !== onAccepted
  ) {
    lifetimeRef.current = {
      source,
      revision,
      admission: suppliedAdmission,
      read: readAdmission,
      send,
      accepted: onAccepted,
      epoch: previous ? previous.epoch + 1 : 0,
    };
  }
  const lifetime = lifetimeRef.current!;
  const resultLifetime = useRef(lifetime);
  const pendingLifetime = useRef(lifetime);
  const busy = useRef(false);

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

  const isCurrent = (ticket = connection.current) =>
    mounted.current &&
    ticket === connection.current &&
    lifetimeRef.current === lifetime &&
    browser.current() &&
    source.snapshot() === revision &&
    authorErasureSessionIsReady(source.read(), viewerId);
  const admissionNow = reads.current.bind(threadId, viewerId, open, lifetime.epoch);
  // Loader advice is a seed only; replacement needs an actual current authenticated read.
  const seeded = lifetime.epoch === 0 && suppliedAdmission !== undefined;
  const sessionReady =
    browser.current() && authorErasureSessionIsReady(source.read(), viewerId) && source.snapshot() === revision;
  const admission = sessionReady ? (seeded ? suppliedAdmission : admissionNow) : { kind: 'unavailable' as const };
  const result =
    resultLifetime.current === lifetime && browser.current()
      ? resultState
      : request.current
        ? { kind: 'uncertain' as const }
        : null;
  const pending = pendingState && pendingLifetime.current === lifetime && browser.current();

  useEffect(() => {
    if (pendingLifetime.current === lifetime && browser.current()) return;
    busy.current = false;
    setPending(false);
  }, [lifetime, browser, pending]);

  async function refresh(nextOpen = open) {
    if (seeded || !viewerId || !isCurrent()) return;
    reads.current.bind(threadId, viewerId, nextOpen, lifetime.epoch);
    const ticket = connection.current;
    const current = () => isCurrent(ticket);
    const pendingRead = reads.current.refresh(viewerId, () => readAdmission(threadId, current), current);
    setOpen(nextOpen);
    updateAdmission((value) => value + 1);
    if ((await pendingRead) && current()) updateAdmission((value) => value + 1);
  }

  function toggle(next: boolean) {
    reads.current.bind(threadId, viewerId, next, lifetime.epoch);
    setOpen(next);
    if (next) void refresh(true);
  }

  const allowed = admission.kind === 'current' && admission.mayErase;
  const unavailable = admission.kind === 'unavailable';
  const retrying = result?.kind === 'uncertain' && !!request.current;
  const recovery = request.current;
  const canRecover = !recovery || (recovery.source === source && recovery.actor === viewerId);
  const canSubmit = sessionReady && canRecover && (allowed || retrying);
  const accepted = result?.kind === 'accepted';
  const stopped = result && result.kind !== 'uncertain' && result.kind !== 'accepted';

  async function submit() {
    if (!canSubmit || !confirmed || busy.current || accepted || stopped) return;
    const sessionAtIntent = source.read();
    if (!authorErasureSessionIsReady(sessionAtIntent, viewerId) || !isCurrent()) return;
    const ticket = connection.current;
    const current = () => isCurrent(ticket);
    busy.current = true;
    pendingLifetime.current = lifetime;
    setPending(true);
    if (!request.current)
      request.current = Object.freeze({
        intent: Object.freeze({ threadId, idempotencyKey: crypto.randomUUID() }),
        actor: sessionAtIntent.subject,
        credential: sessionAtIntent.csrfToken,
        source,
      });
    const command = request.current;
    let outcome: ErasureEnqueue;
    try {
      outcome = await authorErasureRequest(command.intent, (intent) => {
        if (!current()) return Promise.resolve({ kind: 'uncertain' });
        return send(intent, command.credential, current);
      })();
    } catch {
      outcome = { kind: 'uncertain' };
    }
    if (!current()) return;
    resultLifetime.current = lifetime;
    setResult(outcome);
    busy.current = false;
    setPending(false);
    if (outcome.kind === 'accepted') {
      if (onAccepted) onAccepted(outcome.operationId);
      else window.location.assign(`/${browser.locale}/operations/${encodeURIComponent(outcome.operationId)}`);
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
              href={`/${browser.locale}/operations/${encodeURIComponent(result.operationId)}`}
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
