import { catalogueEditor, useEditorLifetime } from './editor-lifetime';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { pickText } from '@rezics/composition';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { Button } from '@rezics/ui/shadcn/button';
import { Checkbox } from '@rezics/ui/shadcn/checkbox';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { CandidateValue } from '../pages/data';
import { subjectHref } from '../../subject/subject-href';
import { m } from '../../paraglide/messages.js';
import { StatementConsentNavigation } from './statement-consent-navigation';
import {
  consentAfterChange,
  consentAssertion,
  type ConsentAddress,
  type ConsentCommand,
  type ConsentFailure,
  type ConsentPublic,
  type ConsentRead,
  type ConsentResult,
  type ConsentTransport,
} from './statement-consent';

export function StatementConsentLink({
  address,
  label,
  locale,
}: {
  address: ConsentAddress;
  label?: string;
  locale: string;
}) {
  const query = new URLSearchParams({ property: address.property, candidate: address.candidate, ...address.slot });
  return (
    <a
      className="inline-flex min-h-11 min-w-11 max-w-full items-center py-2 whitespace-normal underline underline-offset-4 [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      href={`${subjectHref({ id: address.id, label: label ?? '' }, locale).href}/statement-consent?${query}`}
    >
      {m.statement_consent_entry({}, { locale: locale as never })}
    </a>
  );
}
export function ConsentError({ reason, locale }: { reason: ConsentFailure['reason']; locale: string }) {
  const options = { locale: locale as never };
  return (
    <p role="alert">
      {reason === 'denied'
        ? m.statement_consent_denied({}, options)
        : reason === 'missing'
          ? m.statement_consent_missing({}, options)
          : reason === 'conflict'
            ? m.statement_consent_conflict({}, options)
            : reason === 'invalid'
              ? m.candidate_invalid({}, options)
              : m.statement_consent_unavailable({}, options)}
    </p>
  );
}
function PublicResult({ value, locale }: { value: ConsentPublic; locale: string }) {
  const options = { locale: locale as never };
  return (
    <section aria-label={m.candidate_current({}, options)}>
      <ContentItemFrame as="div" data-consent-part="public" className="flex min-w-0 flex-col gap-3 p-4 sm:p-6">
        <ContentItemHeading className="text-lg font-semibold">{m.candidate_current({}, options)}</ContentItemHeading>
        {value.state === 'present' ? (
          <>
            <p>{m.statement_consent_public({}, options)}</p>
            <CandidateValue snak={value.statement} related={value.related} locale={locale} />
          </>
        ) : value.state === 'absent' ? (
          <p>{m.statement_consent_absent({}, options)}</p>
        ) : value.state === 'pending' ? (
          <p>{m.statement_consent_pending({}, options)}</p>
        ) : (
          <p role="status">{m.candidate_public_unconfirmed({}, options)}</p>
        )}
      </ContentItemFrame>
    </section>
  );
}

/** Private, event-owned preparation and commands; no assertion body is placed in a shared query cache. */
export const StatementConsentPage = catalogueEditor(StatementConsentPageLive);

function StatementConsentPageLive({
  address,
  locale,
  transport,
  initial,
}: {
  address: ConsentAddress;
  locale: string;
  transport: ConsentTransport;
  initial?: ConsentRead;
}) {
  const lifetime = useEditorLifetime();
  const options = { locale: locale as never };
  const confirmationId = useId();
  const ownershipId = useId();
  const actionButtons = useRef<Partial<Record<ConsentCommand['operation'], HTMLButtonElement | null>>>({});
  const readFocusTarget = useRef<HTMLElement | null>(null);
  const continuedRead = useRef(false);
  const pendingReadFocus = useRef(false);
  const returnFocus = useRef<ConsentCommand['operation'] | undefined>(undefined);
  const focusConfirmation = useCallback(
    (node: HTMLHeadingElement | null) => {
      if (lifetime.active()) node?.focus();
    },
    [lifetime],
  );
  const [read, setRead] = useState(initial);
  const [result, setResult] = useState<Extract<ConsentResult, { ok: true }>>();
  const [failure, setFailure] = useState<ConsentFailure>();
  const [confirmation, setConfirmation] = useState<ConsentCommand['operation']>();
  const [own, setOwn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(false);
  const request = useRef<ConsentCommand | null>(null);
  const running = useRef(false);
  const page = useRef<{ cursor?: string; session: string | undefined }>({
    session: initial?.ok ? initial.session : undefined,
  });
  const session = useRef<string | undefined>(initial?.ok ? initial.session : undefined);
  const current = read?.ok ? read : undefined;
  const terminal = current?.terminal || result?.kind === 'retracted';
  const publicRead = result?.public ?? current?.public;
  const candidate = current?.candidate;
  const attempt = candidate && current?.disclosure && !candidate.statement.references.length && !terminal;
  const uncertain = !!request.current;
  const assertion = current ? consentAssertion(current, address, locale) : undefined;
  const assertionView = (
    <dl className="grid min-w-0 gap-3 break-words [overflow-wrap:anywhere] sm:grid-cols-3">
      {(
        [
          [m.statement_consent_subject({}, options), assertion?.subject],
          [m.statement_consent_relationship({}, options), assertion?.relationship],
          [m.statement_consent_target({}, options), assertion?.target],
        ] as const
      ).map(([label, value]) => (
        <div key={label} className="min-w-0">
          <dt className="text-sm text-muted-foreground">{label}</dt>
          <dd lang={value?.lang ?? undefined}>
            {value?.text || m.statement_consent_identity_unavailable({}, options)}
          </dd>
        </div>
      ))}
    </dl>
  );
  useEffect(() => {
    if (lifetime.active() && !confirmation && returnFocus.current) {
      actionButtons.current[returnFocus.current]?.focus();
      returnFocus.current = undefined;
    }
  }, [confirmation, lifetime]);
  useEffect(() => {
    if (busy || !pendingReadFocus.current) return;
    const target = readFocusTarget.current;
    if (!target) return;
    pendingReadFocus.current = false;
    if (lifetime.active()) target.focus();
    if (current) continuedRead.current = false;
  }, [busy, current, failure, terminal, lifetime]);
  function openConfirmation(operation: ConsentCommand['operation']) {
    if (!lifetime.active()) return;
    if (running.current || request.current || busy || reload || uncertain || !attempt || !assertion?.identified) return;
    setConfirmation(operation);
  }

  async function load(
    input: { cursor?: string; session: string | undefined } = { session: session.current },
    focusContinuation = false,
  ) {
    if (!lifetime.active()) return;
    if (running.current || request.current || terminal) return;
    continuedRead.current = focusContinuation;
    pendingReadFocus.current = focusContinuation;
    running.current = true;
    setBusy(true);
    setFailure(undefined);
    page.current = input;
    setRead(undefined);
    setResult(undefined);
    setConfirmation(undefined);
    setOwn(false);
    try {
      const next = await transport.read(input.cursor, input.session);
      if (!lifetime.active()) return;
      setRead(next);
      setReload(false);
      if (next.ok) session.current = next.session ?? session.current;
    } catch {
      if (!lifetime.active()) return;
      setFailure({ ok: false, reason: 'unavailable' });
    } finally {
      if (!lifetime.active()) return;
      running.current = false;
      setBusy(false);
    }
  }
  const recoveryLabel = uncertain
    ? m.candidate_retry({}, options)
    : reload
      ? m.candidate_reload({}, options)
      : m.statement_consent_retry_page({}, options);

  async function change() {
    if (!lifetime.active()) return;
    if (
      running.current ||
      !current ||
      (!request.current && (!confirmation || !own || !attempt || !assertion?.identified || reload))
    )
      return;
    request.current ??= {
      ...address,
      operation: confirmation!,
      key: crypto.randomUUID(),
      ...(session.current ? { session: session.current } : {}),
    };
    running.current = true;
    setBusy(true);
    setFailure(undefined);
    try {
      const next = await transport.change(request.current);
      if (!lifetime.active()) return;
      if (!next.ok) {
        setFailure(next);
        if (next.reason !== 'unavailable') {
          request.current = null;
          setConfirmation(undefined);
          setOwn(false);
          setReload(true);
          // A current denial/concealment clears all previously prepared private values.
          if (next.reason === 'denied' || next.reason === 'missing') {
            setRead(undefined);
            setResult(undefined);
          }
        }
        return;
      }
      session.current = next.session ?? session.current;
      setRead(consentAfterChange(current, next));
      setResult(next);
      request.current = null;
      setConfirmation(undefined);
      setOwn(false);
    } catch {
      if (!lifetime.active()) return;
      setFailure({ ok: false, reason: 'unavailable' });
    } finally {
      if (!lifetime.active()) return;
      running.current = false;
      setBusy(false);
    }
  }
  async function refreshPublic() {
    if (!lifetime.active()) return;
    if (running.current || request.current) return;
    running.current = true;
    setBusy(true);
    try {
      const next = await transport.public(session.current, !!terminal);
      if (!lifetime.active()) return;
      setResult((previous) => (previous ? { ...previous, public: next } : previous));
      setRead((previous) => (previous?.ok ? { ...previous, public: next } : previous));
    } catch {
      if (!lifetime.active()) return;
      setResult((previous) => (previous ? { ...previous, public: { state: 'unavailable' } } : previous));
      setRead((previous) => (previous?.ok ? { ...previous, public: { state: 'unavailable' } } : previous));
    } finally {
      if (!lifetime.active()) return;
      running.current = false;
      setBusy(false);
    }
  }
  return (
    <article
      lang={locale}
      className="mx-auto flex min-w-0 w-full max-w-3xl flex-col gap-6 p-4 text-start break-words [overflow-wrap:anywhere] sm:p-6"
    >
      <StatementConsentNavigation active={uncertain && lifetime.active()} locale={locale} />
      <header className="flex min-w-0 flex-col gap-2">
        <h1 className="text-2xl font-semibold">{m.statement_consent_title({}, options)}</h1>
        <p className="text-muted-foreground">{m.statement_consent_intro({}, options)}</p>
        <a
          className="inline-flex min-h-11 min-w-11 max-w-full items-center py-2 whitespace-normal underline underline-offset-4 [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          href={subjectHref({ id: address.id, label: '' }, locale).href}
        >
          {m.sources_back({}, options)}
        </a>
      </header>
      {busy && (
        <ContentItemFrame as="div" data-consent-part="loading" className="p-4 sm:p-6">
          <p role="status">{m.candidate_loading({}, options)}</p>
        </ContentItemFrame>
      )}
      {!read && !failure && !busy && (
        <Button
          className="min-h-11 min-w-11 h-auto max-w-full self-start py-2 whitespace-normal [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          onClick={() => void load()}
        >
          {m.statement_consent_open({}, options)}
        </Button>
      )}
      {(failure || (read && !read.ok)) && (
        <section
          ref={readFocusTarget}
          tabIndex={-1}
          className="focus:outline-2 focus:outline-offset-2 focus:outline-ring"
          aria-label={recoveryLabel}
        >
          <ContentItemFrame as="div" data-consent-part="recovery" className="flex min-w-0 flex-col gap-3 p-4 sm:p-6">
            <ConsentError reason={(failure ?? (read && !read.ok ? read : undefined))!.reason} locale={locale} />
            {uncertain && <p>{m.statement_consent_uncertain({}, options)}</p>}
            <Button
              variant="outline"
              className="min-h-11 min-w-11 h-auto max-w-full self-start py-2 whitespace-normal [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              disabled={busy}
              onClick={() => void (uncertain ? change() : load(page.current, continuedRead.current))}
            >
              {recoveryLabel}
            </Button>
            {!uncertain && !terminal && (
              <Button
                variant="outline"
                className="min-h-11 min-w-11 h-auto max-w-full self-start py-2 whitespace-normal [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                disabled={busy}
                onClick={() => void load()}
              >
                {m.statement_consent_restart({}, options)}
              </Button>
            )}
          </ContentItemFrame>
        </section>
      )}
      {terminal ? (
        <ContentItemFrame as="div" data-consent-part="terminal" className="p-4 sm:p-6">
          <p
            ref={readFocusTarget}
            tabIndex={-1}
            className="focus:outline-2 focus:outline-offset-2 focus:outline-ring"
            role="status"
          >
            {m.statement_consent_terminal({}, options)}
          </p>
        </ContentItemFrame>
      ) : (
        <>
          {current && !candidate && (
            <ContentItemFrame as="div" data-consent-part="empty" className="flex min-w-0 flex-col gap-3 p-4 sm:p-6">
              <p
                ref={readFocusTarget}
                tabIndex={-1}
                className="focus:outline-2 focus:outline-offset-2 focus:outline-ring"
              >
                {current.next ? m.statement_consent_empty_page({}, options) : m.statement_consent_empty({}, options)}
              </p>
              {current.next && (
                <Button
                  variant="outline"
                  className="min-h-11 min-w-11 h-auto max-w-full self-start py-2 whitespace-normal [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  disabled={busy}
                  onClick={() => void load({ cursor: current.next!, session: session.current }, true)}
                >
                  {m.statement_consent_continue({}, options)}
                </Button>
              )}
            </ContentItemFrame>
          )}
          {candidate && current && (
            <section
              ref={readFocusTarget}
              tabIndex={-1}
              className="focus:outline-2 focus:outline-offset-2 focus:outline-ring"
              aria-label={pickText(current.field, locale).text || m.subject_value_unlabelled({}, options)}
            >
              <ContentItemFrame
                as="div"
                data-consent-part="assertion"
                className="flex min-w-0 flex-col gap-4 p-4 sm:p-6"
              >
                <ContentItemHeading className="text-lg font-semibold">
                  {pickText(current.field, locale).text || m.subject_value_unlabelled({}, options)}
                </ContentItemHeading>
                {assertionView}
                {!assertion?.identified && <p>{m.statement_consent_identity_help({}, options)}</p>}
                <p>
                  {candidate.statement.references.length
                    ? m.statement_consent_sourced({}, options)
                    : m.statement_consent_unsourced({}, options)}
                </p>
                {!current.disclosure && <p>{m.statement_consent_not_applicable({}, options)}</p>}
                {attempt && (
                  <>
                    <p className="text-sm text-muted-foreground">{m.statement_consent_authority({}, options)}</p>
                    {!confirmation && !uncertain && (
                      <div className="flex min-w-0 flex-col items-start gap-3">
                        <p>{m.statement_consent_share_help({}, options)}</p>
                        <p>{m.statement_consent_retract_help({}, options)}</p>
                        <div className="flex min-w-0 flex-wrap gap-2">
                          {result?.kind !== 'disclosed' && (
                            <Button
                              className="min-h-11 min-w-11 h-auto max-w-full py-2 whitespace-normal [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                              ref={(node) => {
                                actionButtons.current.disclose = node;
                              }}
                              disabled={busy || reload || !assertion?.identified}
                              onClick={() => openConfirmation('disclose')}
                            >
                              {m.statement_consent_share({}, options)}
                            </Button>
                          )}
                          <Button
                            variant="outline"
                            className="min-h-11 min-w-11 h-auto max-w-full py-2 whitespace-normal [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                            ref={(node) => {
                              actionButtons.current.retract = node;
                            }}
                            disabled={busy || reload || !assertion?.identified}
                            onClick={() => openConfirmation('retract')}
                          >
                            {m.statement_consent_retract({}, options)}
                          </Button>
                        </div>
                      </div>
                    )}
                    {confirmation && (
                      <section aria-labelledby={confirmationId}>
                        <ContentItemFrame
                          as="div"
                          data-consent-part="confirmation"
                          className="flex min-w-0 flex-col gap-4 p-4 sm:p-6"
                        >
                          <h3
                            id={confirmationId}
                            ref={focusConfirmation}
                            tabIndex={-1}
                            className="font-semibold focus:outline-2 focus:outline-offset-2 focus:outline-ring"
                          >
                            {confirmation === 'disclose'
                              ? m.statement_consent_share({}, options)
                              : m.statement_consent_retract({}, options)}
                          </h3>
                          <p>
                            {confirmation === 'disclose'
                              ? m.statement_consent_share_help({}, options)
                              : m.statement_consent_retract_help({}, options)}
                          </p>
                          {assertionView}
                          <Field
                            orientation="horizontal"
                            className="min-w-0 items-start focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring"
                          >
                            <Checkbox
                              className="size-11 after:hidden"
                              id={ownershipId}
                              checked={own}
                              disabled={busy || uncertain}
                              onCheckedChange={(checked) =>
                                lifetime.active() && !running.current && !request.current && setOwn(checked === true)
                              }
                            />
                            <FieldLabel
                              className="min-h-11 min-w-0 max-w-full flex-1 py-2 leading-relaxed whitespace-normal [overflow-wrap:anywhere]"
                              htmlFor={ownershipId}
                            >
                              {m.statement_consent_own({}, options)}
                            </FieldLabel>
                          </Field>
                          {!uncertain && (
                            <div className="flex min-w-0 flex-wrap gap-2">
                              <Button
                                className="min-h-11 min-w-11 h-auto max-w-full py-2 whitespace-normal [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                                disabled={busy || !own || !assertion?.identified}
                                onClick={() => void change()}
                              >
                                {m.statement_consent_confirm({}, options)}
                              </Button>
                              <Button
                                variant="outline"
                                className="min-h-11 min-w-11 h-auto max-w-full py-2 whitespace-normal [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                                disabled={busy}
                                onClick={() => {
                                  if (!lifetime.active() || running.current || request.current) return;
                                  returnFocus.current = confirmation;
                                  setConfirmation(undefined);
                                  setOwn(false);
                                }}
                              >
                                {m.candidate_cancel({}, options)}
                              </Button>
                            </div>
                          )}
                        </ContentItemFrame>
                      </section>
                    )}
                    {(reload || !assertion?.identified) && (
                      <Button
                        variant="outline"
                        className="min-h-11 min-w-11 h-auto max-w-full self-start py-2 whitespace-normal [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                        disabled={busy}
                        onClick={() => void load()}
                      >
                        {m.candidate_reload({}, options)}
                      </Button>
                    )}
                  </>
                )}
              </ContentItemFrame>
            </section>
          )}
        </>
      )}
      {result?.kind === 'disclosed' && (
        <ContentItemFrame as="div" data-consent-part="shared" className="p-4 sm:p-6">
          <p role="status">{m.statement_consent_shared({}, options)}</p>
        </ContentItemFrame>
      )}
      {publicRead && (
        <>
          <PublicResult value={publicRead} locale={locale} />
          <Button
            variant="outline"
            className="min-h-11 min-w-11 h-auto max-w-full self-start py-2 whitespace-normal [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            disabled={busy || uncertain}
            onClick={() => void refreshPublic()}
          >
            {m.statement_consent_refresh_public({}, options)}
          </Button>
        </>
      )}
    </article>
  );
}
