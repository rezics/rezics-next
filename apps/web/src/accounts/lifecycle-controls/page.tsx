import { useRef, useState } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { Card, CardContent, CardHeader, CardTitle } from '@rezics/ui/shadcn/card';
import { m } from '../../paraglide/messages.js';
import { PageHeading } from '../../shell/page-heading';
import { parseIntent, type Action, type Intent, type Outcome, type Page } from './data';

type IO = { read(): Promise<Page>; change(intent: Intent): Promise<Outcome> };
const actionLabel = (action: Action) => (action === 'suspend' ? m.lifecycle_suspend() : m.lifecycle_reinstate());
function statusText(status: Page['status'] | Outcome['status']) {
  switch (status) {
    case 'denied':
      return m.lifecycle_denied();
    case 'signed-out':
      return m.lifecycle_signed_out();
    case 'missing':
      return m.lifecycle_missing();
    case 'pending':
      return m.lifecycle_pending();
    case 'conflict':
      return m.lifecycle_conflict();
    case 'refused':
      return m.lifecycle_refused();
    case 'recorded':
      return m.lifecycle_recorded();
    case 'uncertain':
      return m.lifecycle_uncertain();
    default:
      return m.lifecycle_unavailable();
  }
}

export function AccountLifecyclePage({ initial, io }: { initial: Page; io: IO }) {
  const [page, setPage] = useState(initial);
  const [action, setAction] = useState<Action>('suspend');
  const [reason, setReason] = useState('');
  const [confirmation, setConfirmation] = useState<Intent | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [locked, setLocked] = useState(false);
  // Synchronous exclusion prevents two clicks from starting two effects before React re-renders.
  const inFlight = useRef(false);
  const unresolved = useRef<Intent | null>(null);
  const lastRead = useRef(false);
  const ambiguous = useRef(false);
  const offered = page.status === 'ready' ? page.offered : [];
  const selected = offered.includes(action) ? action : offered[0];
  const canChoose = !busy && !locked && selected !== undefined;

  async function read() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      setPage(await io.read());
    } catch {
      setPage({ status: 'unavailable' });
    } finally {
      // Replaying an uncertain command requires a bounded read attempt first, even if unavailable.
      lastRead.current = true;
      inFlight.current = false;
      setBusy(false);
    }
  }
  async function send(intent: Intent) {
    if (inFlight.current || (unresolved.current !== null && unresolved.current !== intent)) return;
    inFlight.current = true;
    unresolved.current = intent;
    lastRead.current = false;
    setLocked(true);
    setBusy(true);
    let result: Outcome;
    try {
      result = await io.change(intent);
    } catch {
      // A BFF response can be lost after the native commit. Preserve exactly this intent.
      result = { status: 'uncertain', current: { status: 'unavailable' } };
    }
    if (['recorded', 'uncertain', 'pending'].includes(result.status)) ambiguous.current = true;
    // A later denial before receipt access cannot settle an earlier lost response.
    if (ambiguous.current && !['recorded', 'uncertain', 'pending'].includes(result.status))
      result = { status: 'uncertain', current: result.current ?? { status: 'unavailable' } };
    setOutcome(result);
    if (result.current) setPage(result.current);
    if (!ambiguous.current) {
      // An explicit native not_applied result or a pre-command refusal permits editing again.
      unresolved.current = null;
      setLocked(false);
      setConfirmation(null);
    }
    inFlight.current = false;
    setBusy(false);
  }

  return (
    <article className="mx-auto w-full max-w-2xl space-y-6 pb-8">
      <header className="space-y-3">
        <PageHeading>{m.lifecycle_title()}</PageHeading>
        <p className="text-muted-foreground">{m.lifecycle_intro()}</p>
      </header>
      {page.status === 'ready' ? (
        <Card>
          <CardHeader>
            <CardTitle>{page.account.displayName || page.account.handle || m.lifecycle_target()}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {page.account.handle && <p>@{page.account.handle}</p>}
            <p className="break-all font-mono text-sm">{page.account.id}</p>
            <p>{m.lifecycle_state_unavailable()}</p>
            {offered.length === 0 && <p>{m.lifecycle_capability_unavailable()}</p>}
          </CardContent>
        </Card>
      ) : (
        <p role="status">{statusText(page.status)}</p>
      )}
      {outcome && (
        <p role="status" aria-live="polite">
          {statusText(outcome.status)}
        </p>
      )}
      <Button variant="outline" disabled={busy} onClick={() => void read()}>
        {m.lifecycle_read_current()}
      </Button>
      {page.status === 'ready' && (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!canChoose || !selected || reason.length > 2000) return;
            setConfirmation(
              parseIntent({
                accountId: page.account.id,
                action: selected,
                key: crypto.randomUUID(),
                ...(reason === '' ? {} : { reason }),
              }),
            );
          }}
        >
          <fieldset disabled={!canChoose || confirmation !== null} className="space-y-4">
            <legend className="mb-3 font-semibold">{m.lifecycle_action()}</legend>
            <label className="block space-y-2">
              <span>{m.lifecycle_action()}</span>
              <select
                className="block min-h-11 w-full rounded-md border bg-background p-2"
                value={selected ?? ''}
                onChange={(event) => setAction(event.target.value as Action)}
              >
                {offered.length === 0 && <option value="">{m.lifecycle_capability_unavailable()}</option>}
                {offered.map((item) => (
                  <option key={item} value={item}>
                    {actionLabel(item)}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-2">
              <span>{m.lifecycle_reason()}</span>
              <textarea
                className="block min-h-28 w-full rounded-md border bg-background p-3"
                maxLength={2000}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                aria-describedby="lifecycle-reason-help"
              />
            </label>
            <p id="lifecycle-reason-help" className="text-sm text-muted-foreground">
              {m.lifecycle_reason_help()}
            </p>
            <Button type="submit">{m.lifecycle_review()}</Button>
          </fieldset>
        </form>
      )}
      {confirmation && (
        <section aria-labelledby="lifecycle-confirm-title" className="space-y-4 rounded-lg border p-5">
          <h2 id="lifecycle-confirm-title" className="text-lg font-semibold">
            {m.lifecycle_confirmation()}
          </h2>
          <dl className="space-y-2">
            <dt className="font-semibold">{m.lifecycle_target()}</dt>
            <dd className="break-all font-mono text-sm">{confirmation.accountId}</dd>
            <dt className="font-semibold">{m.lifecycle_action()}</dt>
            <dd>{actionLabel(confirmation.action)}</dd>
            <dt className="font-semibold">{m.lifecycle_reason()}</dt>
            <dd className="whitespace-pre-wrap break-words">{confirmation.reason ?? m.lifecycle_no_reason()}</dd>
          </dl>
          <p>{confirmation.action === 'suspend' ? m.lifecycle_suspend_effect() : m.lifecycle_reinstate_effect()}</p>
          {!locked && (
            <div className="flex flex-wrap gap-3">
              <Button disabled={busy || !offered.includes(confirmation.action)} onClick={() => void send(confirmation)}>
                {m.lifecycle_confirm()}
              </Button>
              <Button variant="outline" disabled={busy} onClick={() => setConfirmation(null)}>
                {m.lifecycle_cancel()}
              </Button>
            </div>
          )}
          {locked && <p>{m.lifecycle_locked()}</p>}
          {outcome?.status === 'uncertain' && (
            <Button
              variant="outline"
              disabled={busy || !lastRead.current || !offered.includes(confirmation.action)}
              onClick={() => void send(confirmation)}
            >
              {m.lifecycle_retry_same()}
            </Button>
          )}
        </section>
      )}
    </article>
  );
}
