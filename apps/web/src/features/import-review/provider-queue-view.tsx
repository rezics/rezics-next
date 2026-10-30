import { useId, useRef, useState } from 'react';
import type { ProviderQueueRead } from './provider-queue';
import {
  ProviderReviewActions,
  providerOutcomeText,
  type ProviderReviewTransport,
} from './provider-review-actions-view';
import { Button } from '@rezics/ui/shadcn/button';
import { Card, CardContent, CardHeader, CardTitle } from '@rezics/ui/shadcn/card';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { CandidateValue, pageText } from '../pages/data';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { subjectHref } from '../../subject/subject-href';
import {
  globalReviewContext,
  validQueueScope,
  type QueueDecision,
  type QueueScope,
  type QueueState,
  type QueueTransport,
} from './provider-queue';

/** Private event-owned reads keep authenticated rows out of SSR and shared query caches. */
export function ProviderQueue({
  transport,
  initial = { state: 'idle' },
  initialScope,
  canWrite = true,
}: {
  transport: QueueTransport;
  initial?: QueueState;
  initialScope?: QueueScope;
  canWrite?: boolean;
}) {
  const id = useId();
  const locale = getLocale();
  const [source, setSource] = useState(initialScope?.source ?? '');
  const [context, setContext] = useState(
    initialScope?.context === globalReviewContext ? '' : (initialScope?.context ?? ''),
  );
  const [status, setStatus] = useState<QueueScope['status']>(initialScope?.status ?? 'pending');
  const [scope, setScope] = useState<QueueScope>(
    initialScope ?? { source: '', context: globalReviewContext, status: 'pending' },
  );
  const [page, setPage] = useState<QueueState>(initial);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<'accepted' | 'rejected' | 'stale' | 'invalid' | 'unavailable' | 'denied'>();
  const [draft, setDraft] = useState<QueueDecision>();
  const attempt = useRef<QueueDecision | undefined>(undefined);
  const running = useRef(false);
  const session = useRef<string | undefined>(initial.state === 'ready' ? initial.session : undefined);
  const locked = busy || !!attempt.current || !!draft;
  async function read(nextScope = scope, cursor?: string) {
    if (running.current || attempt.current) return;
    running.current = true;
    setBusy(true);
    setPage({ state: 'loading' });
    setFeedback(undefined);
    try {
      const result = await transport.read(nextScope, cursor, session.current);
      setScope(nextScope);
      setPage(result);
      if (result.state === 'ready') session.current = result.session;
    } catch {
      setPage({ state: 'unavailable' });
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  async function prepare() {
    if (running.current || attempt.current) return;
    running.current = true;
    setBusy(true);
    try {
      setPage(await transport.prepare(scope));
    } catch {
      setPage({ state: 'unavailable' });
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  async function confirm() {
    const command = attempt.current ?? draft;
    if (!command || running.current) return;
    attempt.current = command;
    running.current = true;
    setBusy(true);
    try {
      const result = await transport.decide(command);
      if (!result.ok) {
        setFeedback(result.reason);
        if (result.reason !== 'unavailable') {
          attempt.current = undefined;
          setDraft(undefined);
        }
        if (result.reason === 'denied') setPage({ state: 'denied' });
        return;
      }
      session.current = result.session;
      attempt.current = undefined;
      setDraft(undefined);
      setFeedback(command.operation === 'accept' ? 'accepted' : 'rejected');
      // A committed decision is not adoption. Reread only on the reviewer's next explicit refresh.
      setPage({ state: 'idle' });
    } catch {
      setFeedback('unavailable');
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  const names =
    page.state === 'ready'
      ? Object.fromEntries(Object.entries(page.names).map(([key, labels]) => [key, { labels }]))
      : {};
  const messages = {
    idle: m.prq_start,
    loading: m.prq_loading,
    preparing: m.prq_preparing,
    denied: m.prq_denied,
    invalid: m.prq_invalid,
    unavailable: m.prq_unavailable,
  };
  return (
    <section className="mx-auto w-full max-w-4xl space-y-6 px-4 py-8 sm:px-6" aria-busy={busy}>
      <h1 className="text-3xl font-semibold tracking-tight text-balance">{m.prq_title()}</h1>
      <p className="max-w-prose text-muted-foreground">{m.prq_help()}</p>
      <form
        className="grid gap-4 sm:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault();
          const value = { source: source.trim(), context: context.trim() || globalReviewContext, status };
          if (!validQueueScope(value)) {
            setPage({ state: 'invalid' });
            return;
          }
          session.current = undefined;
          void read(value);
        }}
      >
        <Field>
          <FieldLabel htmlFor={`${id}-source`}>{m.prq_source()}</FieldLabel>
          <Input
            id={`${id}-source`}
            value={source}
            onChange={(event) => setSource(event.target.value)}
            disabled={locked}
            required
            maxLength={32}
            autoComplete="off"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-context`}>{m.prq_context()}</FieldLabel>
          <Input
            id={`${id}-context`}
            value={context}
            onChange={(event) => setContext(event.target.value)}
            disabled={locked}
            placeholder={m.prq_global()}
            autoComplete="off"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-status`}>{m.prq_status()}</FieldLabel>
          <NativeSelect
            id={`${id}-status`}
            value={status}
            disabled={locked}
            onChange={(event) => setStatus(event.target.value as QueueScope['status'])}
          >
            <NativeSelectOption value="pending">{m.prq_pending()}</NativeSelectOption>
            <NativeSelectOption value="accepted_unselected">{m.prq_accepted()}</NativeSelectOption>
          </NativeSelect>
        </Field>
        <div className="flex items-end">
          <Button type="submit" disabled={locked}>
            {m.prq_load()}
          </Button>
        </div>
      </form>
      <p className="text-sm text-muted-foreground">{m.prq_context_help()}</p>
      {feedback && (
        <p role="status">
          {{
            accepted: m.prq_decided,
            rejected: m.prq_decided,
            stale: m.prq_stale,
            invalid: m.prq_invalid,
            unavailable: m.prq_uncertain,
            denied: m.prq_denied,
          }[feedback]()}
        </p>
      )}
      {draft && (
        <div className="space-y-3 rounded-xl border border-border p-5" role="group" aria-label={m.prq_confirm()}>
          <p>{draft.operation === 'accept' ? m.candidate_accept() : m.candidate_reject()}</p>
          <p className="text-sm text-muted-foreground">{m.prq_selection_help()}</p>
          <div className="flex flex-wrap gap-3">
            <Button type="button" disabled={busy || !canWrite} onClick={() => void confirm()}>
              {attempt.current ? m.prq_retry() : m.prq_confirm()}
            </Button>
            {!attempt.current && (
              <Button type="button" variant="outline" disabled={busy} onClick={() => setDraft(undefined)}>
                {m.prq_cancel()}
              </Button>
            )}
          </div>
        </div>
      )}
      {page.state !== 'ready' ? (
        <div className="space-y-3 rounded-xl border border-border p-5">
          <p role={page.state === 'invalid' || page.state === 'unavailable' ? 'alert' : 'status'}>
            {messages[page.state]()}
          </p>
          {page.state === 'unavailable' && (
            <Button type="button" disabled={locked || !canWrite} onClick={() => void prepare()}>
              {m.prq_prepare()}
            </Button>
          )}
          {page.state !== 'loading' && page.state !== 'idle' && page.state !== 'denied' && (
            <Button
              type="button"
              variant="outline"
              disabled={locked}
              onClick={() => void read(scope, page.state === 'preparing' ? page.next : undefined)}
            >
              {page.state === 'preparing' && page.next ? m.prq_continue() : m.prq_retry()}
            </Button>
          )}
          {page.state === 'idle' && scope.source && (
            <Button type="button" variant="outline" disabled={locked} onClick={() => void read()}>
              {m.prq_refresh()}
            </Button>
          )}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" variant="outline" disabled={locked} onClick={() => void read()}>
              {m.prq_refresh()}
            </Button>
            {!page.page.freshness.caught_up && (
              <p role="status" className="text-sm text-muted-foreground">
                {m.prq_lagging()}
              </p>
            )}
          </div>
          {page.page.candidates.length === 0 && (
            <p role="status" className="rounded-xl border border-border p-5">
              {m.prq_empty()}
            </p>
          )}
          {page.page.candidates.map(({ subject, candidate }) => {
            const field = pageText(page.names[candidate.statement.property.id], locale);
            return (
              <Card key={`${subject}:${candidate.id}`}>
                <CardHeader>
                  <CardTitle>
                    <h2 lang={field.lang}>{field.text || m.candidate_field()}</h2>
                  </CardTitle>
                  <a
                    className="text-primary underline underline-offset-4"
                    href={subjectHref({ id: subject, label: '' }, locale).href}
                  >
                    {m.prq_subject()}
                  </a>
                </CardHeader>
                <CardContent className="space-y-4">
                  <CandidateValue snak={candidate.statement} related={names} locale={locale} />
                  <p className="text-sm text-muted-foreground">
                    {candidate.decision === 'accepted' ? m.prq_accepted() : m.prq_pending()}
                  </p>
                  {candidate.statement.qualifiers.map((snak, index) => (
                    <div key={index}>
                      <span className="font-medium">
                        {pageText(page.names[snak.property.id], locale).text || m.candidate_field()}:{' '}
                      </span>
                      <CandidateValue snak={snak} related={names} locale={locale} />
                    </div>
                  ))}
                  <details>
                    <summary className="cursor-pointer py-2 text-primary">{m.candidate_provenance()}</summary>
                    <div className="space-y-3 py-3">
                      {candidate.statement.references.map((reference, index) => (
                        <div key={index} className="space-y-2">
                          {reference.parts.map((snak, part) => (
                            <div key={part}>
                              <CandidateValue snak={snak} related={names} locale={locale} />
                            </div>
                          ))}
                        </div>
                      ))}
                      {candidate.source && 'source' in candidate.source && (
                        <dl className="grid gap-2 text-sm">
                          <dt>{m.prq_source()}</dt>
                          <dd>{candidate.source.source}</dd>
                          <dt>{m.prq_record()}</dt>
                          <dd className="break-words">{candidate.source.external_id}</dd>
                          <dt>{m.prq_revision()}</dt>
                          <dd>{candidate.source.record_revision}</dd>
                          <dt>{m.prq_converter()}</dt>
                          <dd>{candidate.source.converter_revision}</dd>
                        </dl>
                      )}
                    </div>
                  </details>
                  <div className="flex flex-wrap gap-3">
                    {(['accept', 'reject'] as const).map((operation) => (
                      <Button
                        key={operation}
                        type="button"
                        variant={operation === 'accept' ? 'default' : 'outline'}
                        disabled={locked || !canWrite || (operation === 'accept' && candidate.decision === 'accepted')}
                        onClick={() =>
                          setDraft({
                            ...scope,
                            subject,
                            candidate: candidate.id,
                            head: candidate.head,
                            key: crypto.randomUUID(),
                            operation,
                            ...(session.current ? { session: session.current } : {}),
                          })
                        }
                      >
                        {operation === 'accept' ? m.candidate_accept() : m.candidate_reject()}
                      </Button>
                    ))}
                  </div>
                  <p className="text-sm text-muted-foreground">{m.prq_selection_help()}</p>
                </CardContent>
              </Card>
            );
          })}
          {page.page.next && (
            <Button type="button" variant="outline" disabled={locked} onClick={() => void read(scope, page.page.next!)}>
              {m.prq_continue()}
            </Button>
          )}
        </>
      )}
    </section>
  );
}

/** Thin queue insertion seam; producer reads and native decision drafts have separate lifetimes. */
export function ProviderQueueView({
  result,
  locale,
  transport,
  onRetry,
  onRead,
}: {
  result: ProviderQueueRead | { ok: false; reason: 'loading' };
  locale: string;
  transport: ProviderReviewTransport;
  onRetry: () => Promise<ProviderQueueRead>;
  onRead: (read: ProviderQueueRead) => void;
}) {
  const o = { locale: locale as never };
  const current = result;
  const [busy, setBusy] = useState(false);
  async function retry() {
    if (busy) return;
    setBusy(true);
    try {
      onRead(await onRetry());
    } catch {
      onRead({ ok: false, reason: 'unavailable' });
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 p-4 sm:p-8">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold sm:text-3xl">{m.provider_title({}, o)}</h1>
        <p className="text-muted-foreground">{m.provider_intro({}, o)}</p>
      </header>
      {current.ok ? (
        <>
          <p>
            {current.page.sourceLabel} · {current.page.contextLabel} · {current.page.statusLabel}
          </p>
          {!current.page.rows.length && <p role="status">{m.provider_empty({}, o)}</p>}
        </>
      ) : current.reason === 'loading' ? (
        <p role="status">{m.candidate_loading({}, o)}</p>
      ) : (
        <div role="alert" className="space-y-3 rounded-xl border border-border p-4">
          <p>{providerOutcomeText(current, locale)}</p>
          <Button variant="outline" className="min-h-11" disabled={busy} onClick={() => void retry()}>
            {m.provider_refresh({}, o)}
          </Button>
        </div>
      )}
      <ProviderReviewActions
        page={current.ok ? current.page : undefined}
        locale={locale}
        transport={transport}
        onRefresh={onRead}
        concealRows={!current.ok && (current.reason === 'denied' || current.reason === 'missing')}
      />
    </main>
  );
}
