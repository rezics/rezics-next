import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { Trash2 } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { sessionCsrfToken } from '../session/query';
import { authorErasureAdmissionReads, type AuthorErasureAdmission } from './author-erasure-admission';
import { authorErasureRequest, type ErasureEnqueue, type ErasureIntent } from './author-erasure';

async function sendNative(intent: ErasureIntent): Promise<ErasureEnqueue> {
  const { beginThreadAuthorErasure } = await import('./author-erasure-server');
  return beginThreadAuthorErasure({ data: intent, headers: { 'X-CSRF-Token': sessionCsrfToken() ?? '' } });
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

async function readNative(threadId: string): Promise<AuthorErasureAdmission> {
  const { readThreadAuthorErasureAdmission } = await import('./author-erasure-server');
  return readThreadAuthorErasureAdmission({ data: { threadId } });
}

/** A narrow thread action region: never owns the reading page, composer, target or draft. */
export function AuthorErasureEntry({
  threadId,
  viewerId = null,
  admission: suppliedAdmission,
  readAdmission = readNative,
  send = sendNative,
  onAccepted,
}: {
  threadId: string;
  viewerId?: string | null;
  admission?: AuthorErasureAdmission;
  readAdmission?: (threadId: string) => Promise<AuthorErasureAdmission>;
  send?: (intent: ErasureIntent) => Promise<ErasureEnqueue>;
  onAccepted?: (id: string) => void;
}) {
  const heading = useId();
  const [open, setOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<ErasureEnqueue | null>(null);
  const request = useRef<ReturnType<typeof authorErasureRequest> | null>(null);
  const busy = useRef(false);
  const intentScope = useRef<{ threadId: string; viewerId: string | null } | null>(null);
  const reads = useRef(authorErasureAdmissionReads());
  const [, updated] = useState(0);
  const current = reads.current.bind(threadId, viewerId, open);
  const admission = suppliedAdmission ?? current;
  async function refresh() {
    if (suppliedAdmission || !viewerId) return;
    const pending = reads.current.refresh(viewerId, () => readAdmission(threadId));
    updated((value) => value + 1);
    if (await pending) updated((value) => value + 1);
  }
  function toggle(next: boolean) {
    reads.current.bind(threadId, viewerId, next);
    setOpen(next);
    if (next) void refresh();
  }
  const allowed = admission.kind === 'current' && admission.mayErase;
  const unavailable = admission.kind === 'unavailable';
  const retrying =
    result?.kind === 'uncertain' &&
    !!request.current &&
    intentScope.current?.threadId === threadId &&
    intentScope.current.viewerId === viewerId;
  const accepted = result?.kind === 'accepted';
  const stopped = result && result.kind !== 'uncertain' && result.kind !== 'accepted';

  async function submit() {
    if ((!allowed && !retrying) || !confirmed || busy.current || accepted || stopped) return;
    busy.current = true;
    setPending(true);
    if (!request.current) {
      intentScope.current = { threadId, viewerId };
      request.current = authorErasureRequest({ threadId, idempotencyKey: crypto.randomUUID() }, send);
    }
    let outcome: ErasureEnqueue;
    try {
      outcome = await request.current();
    } catch {
      outcome = { kind: 'uncertain' };
    }
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
      <Button variant="ghost" size="sm" aria-expanded={open} onClick={() => toggle(!open)} disabled={pending}>
        <Trash2 aria-hidden="true" className="size-4" />
        {m.author_erasure_action()}
      </Button>
      {open ? (
        <div className="mt-3 space-y-4 rounded-xl border border-border bg-card p-4 sm:p-5" aria-labelledby={heading}>
          <h2 id={heading} className="font-semibold">
            {m.author_erasure_confirm_title()}
          </h2>
          <p className="max-w-prose leading-relaxed text-muted-foreground">{m.author_erasure_scope()}</p>
          <p className="max-w-prose leading-relaxed">{m.author_erasure_irreversible()}</p>
          {!allowed ? (
            <p role="status" className="text-muted-foreground">
              {unavailable
                ? m.author_erasure_admission_unavailable()
                : admission.kind === 'current'
                  ? m.author_erasure_forbidden()
                  : erasureRefusal(admission.kind)}
            </p>
          ) : null}
          {result && result.kind !== 'accepted' ? <p role="alert">{erasureRefusal(result.kind)}</p> : null}
          {accepted ? (
            <a
              className={buttonVariants({ variant: 'outline' })}
              href={`/${getLocale()}/operations/${encodeURIComponent(result.operationId)}`}
            >
              {m.author_erasure_view_progress()}
            </a>
          ) : (
            <>
              <label className="flex items-start gap-3 leading-relaxed">
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
                  disabled={(!allowed && !retrying) || !confirmed || pending || !!stopped}
                  onClick={submit}
                >
                  {pending
                    ? m.author_erasure_submitting()
                    : result?.kind === 'uncertain'
                      ? m.author_erasure_retry()
                      : m.author_erasure_confirm()}
                </Button>
                {!suppliedAdmission ? (
                  <Button variant="outline" disabled={pending || !viewerId} onClick={() => void refresh()}>
                    {m.author_erasure_check_again()}
                  </Button>
                ) : null}
                <Button variant="outline" disabled={pending} onClick={() => toggle(false)}>
                  {m.author_erasure_close()}
                </Button>
              </div>
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}
