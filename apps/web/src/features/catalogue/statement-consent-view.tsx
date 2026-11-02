import { catalogueEditor, useEditorLifetime } from './editor-lifetime';
import { useCallback, useId, useRef, useState, type MouseEvent } from 'react';
import { pickText } from '@rezics/composition';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { Button } from '@rezics/ui/shadcn/button';
import { Checkbox } from '@rezics/ui/shadcn/checkbox';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { CandidateValue } from '../pages/data';
import { subjectHref } from '../../subject/subject-href';
import { m } from '../../paraglide/messages.js';
import { StatementConsentNavigation } from './statement-consent-navigation';
import { useConsentFocus } from './statement-consent-focus';
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
type ConsentConfirmation = {
  operation: ConsentCommand['operation'];
  observation: number;
  epoch: number;
};
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
  const recoveryFocusTarget = useRef<HTMLElement | null>(null);
  const setReadFocusTarget = useCallback((node: HTMLElement | null) => {
    readFocusTarget.current = node;
  }, []);
  const focus = useConsentFocus();
  const confirmationHeading = useRef<HTMLHeadingElement | null>(null);
  const confirmationOrigin = useRef<{ operation: ConsentCommand['operation']; observation: number } | null>(null);
  const transition = useRef<object | null>(null);
  function orient(
    event: MouseEvent<HTMLButtonElement> | undefined,
    target: () => HTMLElement | null | undefined,
    meaningful = () => true,
  ) {
    const token = {};
    transition.current = token;
    focus.begin(
      event,
      () => lifetime.active() && transition.current === token && meaningful(),
      target,
      () => !running.current,
    );
  }
  const [read, setRead] = useState(initial);
  const [result, setResult] = useState<Extract<ConsentResult, { ok: true }>>();
  const [failure, setFailure] = useState<ConsentFailure>();
  const [confirmation, setConfirmation] = useState<ConsentConfirmation>();
  const [own, setOwn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(false);
  const request = useRef<ConsentCommand | null>(null);
  const running = useRef(false);
  const observation = useRef(0);
  const actionEpoch = useRef(0);
  const confirmationRef = useRef<ConsentConfirmation | undefined>(undefined);
  const ownRef = useRef(false);
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
  const observedAtRender = observation.current;
  const actionEpochAtRender = actionEpoch.current;
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
  function revokeConfirmation() {
    actionEpoch.current += 1;
    confirmationRef.current = undefined;
    ownRef.current = false;
    setConfirmation(undefined);
    setOwn(false);
  }
  function renewAction() {
    const epoch = ++actionEpoch.current;
    const active = confirmationRef.current;
    if (active) {
      const renewed = { ...active, epoch };
      confirmationRef.current = renewed;
      setConfirmation(renewed);
    }
    return epoch;
  }
  function isCurrentConfirmation(action: ConsentConfirmation | undefined, expectedEpoch: number) {
    return (
      !!action &&
      confirmationRef.current === action &&
      action.observation === observation.current &&
      action.epoch === expectedEpoch &&
      expectedEpoch === actionEpoch.current
    );
  }
  function openConfirmation(
    operation: ConsentCommand['operation'],
    event: MouseEvent<HTMLButtonElement>,
    expectedObservation: number,
    expectedEpoch: number,
  ) {
    if (!lifetime.active()) return;
    if (
      expectedObservation !== observation.current ||
      expectedEpoch !== actionEpoch.current ||
      confirmationRef.current ||
      running.current ||
      request.current ||
      busy ||
      reload ||
      uncertain ||
      !attempt ||
      !assertion?.identified
    )
      return;
    const action = { operation, observation: expectedObservation, epoch: ++actionEpoch.current };
    confirmationRef.current = action;
    ownRef.current = false;
    confirmationOrigin.current = { operation, observation: expectedObservation };
    orient(event, () => confirmationHeading.current);
    setConfirmation(action);
    setOwn(false);
  }
  function acknowledgeOwnership(
    action: ConsentConfirmation | undefined,
    expectedEpoch: number,
    checked: boolean,
  ) {
    if (
      !lifetime.active() ||
      !isCurrentConfirmation(action, expectedEpoch) ||
      running.current ||
      request.current ||
      busy
    )
      return;
    const renewed = { ...action!, epoch: ++actionEpoch.current };
    confirmationRef.current = renewed;
    ownRef.current = checked;
    setConfirmation(renewed);
    setOwn(checked);
  }
  function cancelConfirmation(
    action: ConsentConfirmation | undefined,
    expectedEpoch: number,
    event: MouseEvent<HTMLButtonElement>,
  ) {
    if (
      !lifetime.active() ||
      !isCurrentConfirmation(action, expectedEpoch) ||
      running.current ||
      request.current
    )
      return;
    const origin = confirmationOrigin.current;
    orient(
      event,
      () => origin && actionButtons.current[origin.operation],
      () => !!origin && origin.observation === observation.current && !reload && !!attempt && !!assertion?.identified,
    );
    confirmationOrigin.current = null;
    revokeConfirmation();
  }

  async function load(
    input: { cursor?: string; session: string | undefined } = { session: session.current },
    event?: MouseEvent<HTMLButtonElement>,
    expectedObservation = observation.current,
    expectedEpoch = actionEpoch.current,
  ) {
    if (!lifetime.active()) return;
    if (
      expectedObservation !== observation.current ||
      expectedEpoch !== actionEpoch.current ||
      running.current ||
      request.current ||
      terminal
    )
      return;
    observation.current += 1;
    revokeConfirmation();
    running.current = true;
    setBusy(true);
    setFailure(undefined);
    page.current = input;
    orient(
      event,
      () => recoveryFocusTarget.current ?? readFocusTarget.current,
      () => page.current === input,
    );
    confirmationOrigin.current = null;
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

  async function change(
    event: MouseEvent<HTMLButtonElement> | undefined,
    action: ConsentConfirmation | undefined,
    expectedEpoch: number,
  ) {
    if (!lifetime.active()) return;
    if (running.current || !current) return;
    if (
      !request.current &&
      (!isCurrentConfirmation(action, expectedEpoch) ||
        !ownRef.current ||
        !attempt ||
        !assertion?.identified ||
        reload)
    )
      return;
    if (isCurrentConfirmation(action, expectedEpoch)) {
      orient(event, () => recoveryFocusTarget.current ?? readFocusTarget.current);
      confirmationOrigin.current = null;
    }
    request.current ??= {
      ...address,
      operation: action!.operation,
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
          revokeConfirmation();
          setReload(true);
          // A current denial/concealment clears all previously prepared private values.
          if (next.reason === 'denied' || next.reason === 'missing') {
            observation.current += 1;
            setRead(undefined);
            setResult(undefined);
          }
        }
        return;
      }
      session.current = next.session ?? session.current;
      setRead(consentAfterChange(current, next));
      setResult(next);
      observation.current += 1;
      request.current = null;
      revokeConfirmation();
    } catch {
      if (!lifetime.active()) return;
      setFailure({ ok: false, reason: 'unavailable' });
    } finally {
      if (!lifetime.active()) return;
      running.current = false;
      setBusy(false);
    }
  }
  async function refreshPublic(expectedObservation: number, expectedEpoch: number) {
    if (!lifetime.active()) return;
    if (
      expectedObservation !== observation.current ||
      expectedEpoch !== actionEpoch.current ||
      running.current ||
      request.current ||
      !current
    )
      return;
    renewAction();
    focus.cancel();
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
      renewAction();
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
          onClick={(event) => void load(undefined, event, observedAtRender, actionEpochAtRender)}
        >
          {m.statement_consent_open({}, options)}
        </Button>
      )}
      {(failure || (read && !read.ok)) && (
        <section
          ref={recoveryFocusTarget}
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
              onClick={(event) =>
                void (uncertain
                  ? change(event, confirmation, actionEpochAtRender)
                  : load(page.current, event, observedAtRender, actionEpochAtRender))
              }
            >
              {recoveryLabel}
            </Button>
            {!uncertain && !terminal && (
              <Button
                variant="outline"
                className="min-h-11 min-w-11 h-auto max-w-full self-start py-2 whitespace-normal [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                disabled={busy}
                onClick={(event) => void load(undefined, event, observedAtRender, actionEpochAtRender)}
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
            ref={setReadFocusTarget}
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
                ref={setReadFocusTarget}
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
                  onClick={(event) =>
                    void load(
                      { cursor: current.next!, session: session.current },
                      event,
                      observedAtRender,
                      actionEpochAtRender,
                    )
                  }
                >
                  {m.statement_consent_continue({}, options)}
                </Button>
              )}
            </ContentItemFrame>
          )}
          {candidate && current && (
            <section
              ref={setReadFocusTarget}
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
                              onClick={(event) =>
                                openConfirmation('disclose', event, observedAtRender, actionEpochAtRender)
                              }
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
                            onClick={(event) =>
                              openConfirmation('retract', event, observedAtRender, actionEpochAtRender)
                            }
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
                            ref={confirmationHeading}
                            tabIndex={-1}
                            className="font-semibold focus:outline-2 focus:outline-offset-2 focus:outline-ring"
                          >
                            {confirmation.operation === 'disclose'
                              ? m.statement_consent_share({}, options)
                              : m.statement_consent_retract({}, options)}
                          </h3>
                          <p>
                            {confirmation.operation === 'disclose'
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
                                acknowledgeOwnership(confirmation, actionEpochAtRender, checked === true)
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
                                onClick={(event) => void change(event, confirmation, actionEpochAtRender)}
                              >
                                {m.statement_consent_confirm({}, options)}
                              </Button>
                              <Button
                                variant="outline"
                                className="min-h-11 min-w-11 h-auto max-w-full py-2 whitespace-normal [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                                disabled={busy}
                                onClick={(event) =>
                                  cancelConfirmation(confirmation, actionEpochAtRender, event)
                                }
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
                        onClick={(event) => void load(undefined, event, observedAtRender, actionEpochAtRender)}
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
            onClick={() => void refreshPublic(observedAtRender, actionEpochAtRender)}
          >
            {m.statement_consent_refresh_public({}, options)}
          </Button>
        </>
      )}
    </article>
  );
}
