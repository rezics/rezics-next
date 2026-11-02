import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@rezics/ui/shadcn/alert';
import { Button } from '@rezics/ui/shadcn/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@rezics/ui/shadcn/card';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@rezics/ui/shadcn/field';
import { Textarea } from '@rezics/ui/shadcn/textarea';
import { personalRead } from '../kernel/query';
import { useOperation } from '../kernel/exposure';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { subjectHref } from '../subject/subject-href';
import { useSession } from '../session/query';
import {
  unwrapVerificationRead,
  type AgentVerificationRequest,
  type VerificationFailure,
  type VerificationInput,
} from './verification-core';
import { usePreferenceRetry } from './preference-failure-retry';
import { useSettingsNavigationDraft } from './reading-navigation';
import { verificationNeedsNavigationDecision } from './settings-draft-state';
import { VerificationSubjectChooser } from './verification-subject-chooser';
import { VerificationLinks, verificationIssueMessage, type VerificationLinkRow } from './verification-links';
import {
  validateVerificationDraft,
  verificationCharacterCount,
  type VerificationIssue,
} from './verification-validation';
import {
  VerificationRecovery,
  canRequestVerification,
  canWithdrawVerification,
  verificationQueryKey,
  type VerificationSnapshot,
  type VerificationRecoveryIO,
} from './verification-recovery';
import {
  readVerificationState,
  readVerificationSubjectTitle,
  requestVerificationAction,
  withdrawVerificationAction,
} from './verification-actions';
import { withVerificationDeadline } from './verification-request-deadline';

import {
  SettingsSessionOwner,
  useSettingsSessionOwner,
  useSettingsReadCurrent,
  useSettingsLiveness,
  useSettingsDisposal,
} from './settings-session-owner';

const verificationActionClassName =
  'h-auto min-h-11 min-w-11 w-full max-w-full py-2 whitespace-normal [overflow-wrap:anywhere] sm:w-auto';
const verificationSummaryClassName =
  'min-h-11 min-w-11 max-w-full cursor-pointer py-3 whitespace-normal [overflow-wrap:anywhere]';

function subjectLabel(title: string | null | undefined, subjectId: string | undefined) {
  return title?.trim() && title !== subjectId ? title : m.settings_verification_generic_subject();
}

function boundedDiagnosticId(value: string | null | undefined) {
  return value && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/.test(value) ? value : null;
}

function diagnosticCode(value: string | undefined) {
  return value && /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : undefined;
}

function diagnosticRetryAfter(value: string | undefined) {
  if (!value) return undefined;
  // DOM attributes are disclosed too. Keep only the two standard header forms.
  return /^\d{1,10}$/.test(value) ||
    /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(
      value,
    )
    ? value
    : undefined;
}

function CommandDetails({ failure }: { failure: VerificationFailure }) {
  // Only bounded diagnostic identifiers belong here; never render the transported message or command key.
  const code = diagnosticCode(failure.code);
  const requestId = boundedDiagnosticId(failure.requestId);
  return (
    <details>
      <summary className={verificationSummaryClassName}>{m.settings_verification_command_details()}</summary>
      <div className="space-y-2 break-words">
        <p>{m.settings_verification_read_error({ status: failure.status })}</p>
        {code ? <p>{m.settings_verification_diagnostic_code({ code })}</p> : null}
        {requestId ? <p>{m.settings_verification_diagnostic_request({ requestId })}</p> : null}
      </div>
    </details>
  );
}

function VerificationState({
  verification,
  subjectTitle: suppliedTitle,
}: {
  verification: AgentVerificationRequest | null;
  subjectTitle: string | null;
}) {
  const accountId = verification?.accountId;
  const subjectId = verification?.catalogueSubjectId;
  const locale = getLocale();
  const titleKey = JSON.stringify([accountId, subjectId, locale]);
  const [hydrated, setHydrated] = useState<{ key: string; title: string | null } | null>(null);
  useEffect(() => {
    if (!accountId || !subjectId || suppliedTitle) return;
    const request = new AbortController();
    void withVerificationDeadline(
      (signal) =>
        readVerificationSubjectTitle({
          data: { accountId, subjectId },
          signal,
        }),
      request.signal,
    )
      .then((title) => {
        if (!request.signal.aborted) setHydrated({ key: titleKey, title });
      })
      .catch(() => {});
    return () => request.abort();
  }, [accountId, subjectId, locale, suppliedTitle, titleKey]);
  const subjectTitle = suppliedTitle ?? (hydrated?.key === titleKey ? hydrated.title : null);
  if (!verification) return null;
  if (verification.state === 'pending' || verification.state === 'approving')
    return (
      <p>{m.settings_verification_pending({ subject: subjectLabel(subjectTitle, verification.catalogueSubjectId) })}</p>
    );
  if (verification.state === 'approved')
    return (
      <p>
        {m.settings_verification_verified()}{' '}
        <a
          className="underline"
          href={
            subjectHref(
              {
                id: verification.catalogueSubjectId,
                label: subjectLabel(subjectTitle, verification.catalogueSubjectId),
              },
              getLocale(),
            ).href
          }
        >
          {m.settings_verification_view_agent()}
        </a>
      </p>
    );
  if (verification.state === 'rejected')
    return <p>{m.settings_verification_rejected({ reason: verification.reason ?? '' })}</p>;
  if (verification.state === 'withdrawn') return <p>{m.settings_verification_withdrawn()}</p>;
  if (verification.state === 'failed') return <p>{m.settings_verification_failed()}</p>;
  return null;
}

export function VerificationSection() {
  const { state, csrfToken, subject } = useSession();
  const admitted = useOperation('agent_verification.request');
  if (!admitted || state !== 'signed-in' || !subject) return null;
  return <ViewerVerification key={JSON.stringify([subject, csrfToken])} accountId={subject} csrfToken={csrfToken} />;
}

/** Original credentials and a guarded query producer prevent late reads from entering another owner's cache. */
export function verificationRecoveryIO(
  owner: SettingsSessionOwner,
  client: QueryClient,
  transport = {
    read: (accountId: string, signal?: AbortSignal) =>
      readVerificationState({ data: { accountId }, ...(signal ? { signal } : {}) }).then((result) =>
        unwrapVerificationRead<VerificationSnapshot>(result),
      ),
    request: (accountId: string, input: VerificationInput, token: string, signal?: AbortSignal) =>
      requestVerificationAction({
        data: { ...input, accountId },
        ...(signal ? { signal } : {}),
        headers: { 'X-CSRF-Token': token },
      }),
    withdraw: (accountId: string, input: { idempotencyKey: string }, token: string, signal?: AbortSignal) =>
      withdrawVerificationAction({
        data: { ...input, accountId },
        ...(signal ? { signal } : {}),
        headers: { 'X-CSRF-Token': token },
      }),
  },
  isCurrent: () => boolean = owner.readCurrent,
): VerificationRecoveryIO {
  const guard = async <T,>(dispatch: (token: string) => Promise<T>): Promise<T> => {
    if (!isCurrent()) throw new Error('Settings viewer unavailable');
    const result = await owner.guard(dispatch);
    if (!isCurrent()) throw new Error('Settings viewer changed');
    return result;
  };
  const readGuard = async <T,>(dispatch: () => Promise<T>): Promise<T> => {
    if (!isCurrent()) throw new Error('Settings viewer unavailable');
    const result = await owner.guardRead(dispatch);
    if (!isCurrent()) throw new Error('Settings viewer changed');
    return result;
  };
  const key = verificationQueryKey(owner.subject);
  const lifetime = new AbortController();
  const scope = (signal?: AbortSignal) => (signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal);
  // This subscription owns only the original query, and runs synchronously on retirement.
  const release = owner.subscribe(() => {
    if (owner.readCurrent()) return;
    release();
    lifetime.abort();
    void client.cancelQueries({ queryKey: key, exact: true });
    client.removeQueries({ queryKey: key, exact: true });
  });
  return {
    read: (accountId, caller) =>
      readGuard(async () => {
        if (accountId !== owner.subject) throw new Error('Verification account changed');
        // A status read begun before this action cannot serve as its authoritative readback.
        await client.cancelQueries({ queryKey: key, exact: true });
        if (!isCurrent()) throw new Error('Settings viewer changed');
        return client.fetchQuery({
          ...personalRead,
          queryKey: key,
          queryFn: ({ signal }) =>
            readGuard(async () => {
              const result = await withVerificationDeadline(
                (child) => transport.read(accountId, child),
                AbortSignal.any([signal, scope(caller)]),
              );
              if (
                result.accountId !== owner.subject ||
                (result.verificationRequest && result.verificationRequest.accountId !== owner.subject)
              )
                throw new Error('Verification account changed');
              return result;
            }),
          staleTime: 0,
          retry: false,
        });
      }),
    request: (accountId, input, caller) =>
      guard((token) => {
        if (accountId !== owner.subject) throw new Error('Verification account changed');
        return withVerificationDeadline((signal) => transport.request(accountId, input, token, signal), scope(caller));
      }),
    withdraw: (accountId, input, caller) =>
      guard((token) => {
        if (accountId !== owner.subject) throw new Error('Verification account changed');
        return withVerificationDeadline((signal) => transport.withdraw(accountId, input, token, signal), scope(caller));
      }),
  };
}

function ViewerVerification({ accountId, csrfToken }: { accountId: string; csrfToken: string | null }) {
  const queryClient = useQueryClient();
  const owner = useSettingsSessionOwner(csrfToken, accountId)!;
  const isCurrent = useSettingsLiveness(owner.readCurrent);
  const [controller] = useState(
    () =>
      new VerificationRecovery(
        accountId,
        verificationRecoveryIO(owner, queryClient, undefined, isCurrent),
        isCurrent,
        () => isCurrent() && owner.isCurrent(),
      ),
  );
  const dispose = useCallback(() => controller.deactivate(), [controller]);
  useSettingsDisposal(dispose);
  useEffect(() => {
    void controller.reload();
  }, [controller]);
  return <VerificationCard controller={controller} csrfToken={csrfToken} />;
}

type VerificationDraft = {
  selected: { id: string; title: string; type: string } | null;
  statement: string;
  links: { label: string; url: string }[];
};

/** The production card and recovery stories use the same controller and controls. */
export function VerificationCard({
  controller,
  csrfToken,
  initialDraft,
}: {
  controller: VerificationRecovery;
  csrfToken: string | null;
  initialDraft?: VerificationDraft | undefined;
}) {
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
  const id = useId();
  const [selected, setSelected] = useState<VerificationDraft['selected']>(initialDraft?.selected ?? null);
  const [statement, setStatement] = useState(initialDraft?.statement ?? '');
  const [links, setLinks] = useState<VerificationLinkRow[]>(() =>
    (initialDraft?.links ?? [{ label: '', url: '' }]).map((link, key) => ({ ...link, key })),
  );
  const form = useRef<HTMLFormElement>(null);
  const [showValidation, setShowValidation] = useState(false);
  // Confirmation belongs to the observed request; a new read or subject choice requires a fresh decision.
  const [confirmation, setConfirmation] = useState<VerificationSnapshot | null>(null);
  // Capture the genuine label in the action handler, before a send clears current status or the draft changes.
  const [action, setAction] = useState<{ kind: 'request' | 'withdraw'; subject: string } | null>(null);
  const [acknowledged, setAcknowledged] = useState<Omit<VerificationInput, 'idempotencyKey'> | null>(null);
  const isCurrent = useSettingsReadCurrent(csrfToken, true);
  const pending = state.phase === 'sending' || state.phase === 'reading';
  const waiting = usePreferenceRetry(state.failure, state.retryAt);
  const verification = state.current?.verificationRequest ?? null;
  const subjectTitle = state.current?.subjectTitle ?? null;
  const canRequest = canRequestVerification(state.current) && !state.attempt && !pending;
  const canWithdraw = canWithdrawVerification(state.current) && !state.attempt && !pending;
  const hasDraft = !!selected || !!statement || links.some((link) => link.label || link.url);

  // Wholly empty optional rows remain editable placeholders, as before. Every populated byte stays in order.
  const populated = links.filter((link) => link.label || link.url);
  const draft = {
    subject: selected?.id ?? '',
    statement,
    links: populated.map(({ label, url }) => ({ label, url })),
  };
  useSettingsNavigationDraft(
    'verification',
    isCurrent() && verificationNeedsNavigationDecision(state, draft, acknowledged),
    () => isCurrent() && verificationNeedsNavigationDecision(controller.snapshot(), draft, acknowledged),
    controller,
  );
  const issues = showValidation ? validateVerificationDraft(draft) : [];
  function fieldId(issue: VerificationIssue) {
    if (issue.field === 'label' || issue.field === 'url') return `${id}-${issue.field}-${populated[issue.index!]!.key}`;
    return issue.field === 'links' ? `${id}-add-link` : `${id}-${issue.field}`;
  }
  const errors = new Map(issues.map((issue) => [fieldId(issue), verificationIssueMessage(issue)]));
  function focusField(target: string) {
    if (target === `${id}-subject`) form.current?.querySelector<HTMLInputElement>('[role="combobox"]')?.focus();
    else form.current?.ownerDocument.getElementById(target)?.focus();
  }

  async function recover(action: () => Promise<void>) {
    if (!isCurrent()) return;
    const command = action();
    const original = controller.snapshot().attempt;
    await command;
    if (!isCurrent()) return;
    const current = controller.snapshot();
    if (original?.kind === 'request' && !current.attempt && current.phase === 'review') setAcknowledged(original.input);
  }

  async function submit() {
    if (!isCurrent() || !csrfToken || !canRequest) return;
    const invalid = validateVerificationDraft(draft);
    setShowValidation(true);
    if (invalid.length) {
      focusField(fieldId(invalid[0]!));
      return;
    }
    setAction({ kind: 'request', subject: subjectLabel(selected?.title, selected?.id) });
    await recover(() => controller.submit(draft));
  }

  async function withdraw() {
    if (!isCurrent() || !csrfToken || confirmation !== state.current || !canWithdraw) return;
    setAction({ kind: 'withdraw', subject: subjectLabel(subjectTitle, verification?.catalogueSubjectId) });
    await controller.withdraw(true);
    if (isCurrent()) setConfirmation(null);
  }

  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>
          <h2>{m.settings_verification_heading()}</h2>
        </CardTitle>
        <CardDescription>{m.settings_verification_intro()}</CardDescription>
      </CardHeader>
      <CardContent className="min-w-0 space-y-4">
        <div role="status" aria-live="polite" aria-atomic="true">
          {state.phase === 'loading' || state.readStatus === 'reading' ? (
            <p>{m.settings_verification_loading()}</p>
          ) : state.readStatus === 'success' && !verification ? (
            <p>{m.settings_verification_read_empty()}</p>
          ) : (
            <VerificationState verification={verification} subjectTitle={subjectTitle} />
          )}
        </div>
        {state.phase === 'sending' ? <p role="status">{m.settings_saving()}</p> : null}
        {state.readStatus === 'error' ? (
          <div
            role="alert"
            data-response-status={state.failure?.status}
            data-response-code={diagnosticCode(state.failure?.code)}
            data-request-id={boundedDiagnosticId(state.failure?.requestId)}
            data-retry-after={diagnosticRetryAfter(state.failure?.retryAfter)}
          >
            <p>
              {m.settings_verification_load_failed()}{' '}
              {state.failure?.code === 'platform_closed' || state.failure?.message === 'rezics-platform-closed'
                ? m.settings_verification_read_closed()
                : state.failure?.status === 401 || state.failure?.status === 403
                  ? m.settings_verification_read_denied()
                  : m.settings_verification_read_unavailable()}
            </p>
            {state.failure ? (
              <details>
                <summary className={verificationSummaryClassName}>{m.settings_verification_read_details()}</summary>
                <p>{m.settings_verification_read_error({ status: state.failure.status })}</p>
              </details>
            ) : null}
          </div>
        ) : null}
        {canRequest || hasDraft || state.attempt?.kind === 'request' ? (
          <form
            ref={form}
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
            className="space-y-4"
          >
            {issues.length ? (
              <Alert role="alert">
                <AlertTitle>{m.settings_verification_fix_fields()}</AlertTitle>
                <AlertDescription>
                  <ul>
                    {issues.map((issue) => (
                      <li key={fieldId(issue)}>
                        <a
                          className="flex min-h-11 items-center underline"
                          href={`#${fieldId(issue)}`}
                          onClick={(event) => {
                            event.preventDefault();
                            focusField(fieldId(issue));
                          }}
                        >
                          {issue.index === undefined
                            ? verificationIssueMessage(issue)
                            : m.settings_verification_link_issue({
                                number: links.indexOf(populated[issue.index]!) + 1,
                                message: verificationIssueMessage(issue),
                              })}
                        </a>
                      </li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            ) : null}
            <FieldGroup>
              <VerificationSubjectChooser
                selected={selected}
                onSelect={(subject) => {
                  setSelected(subject);
                  setConfirmation(null);
                }}
                disabled={pending || !csrfToken}
              />
              <Field data-invalid={errors.has(`${id}-statement`)}>
                <FieldLabel htmlFor={`${id}-statement`}>{m.settings_verification_statement()}</FieldLabel>
                <Textarea
                  id={`${id}-statement`}
                  value={statement}
                  aria-invalid={errors.has(`${id}-statement`)}
                  aria-describedby={`${id}-statement-count${errors.has(`${id}-statement`) ? ` ${id}-statement-error` : ''}`}
                  onChange={(event) => setStatement(event.target.value)}
                />
                <FieldDescription id={`${id}-statement-count`}>
                  {m.settings_verification_characters({ count: verificationCharacterCount(statement) })}
                </FieldDescription>
                {errors.has(`${id}-statement`) ? (
                  <FieldDescription id={`${id}-statement-error`} className="text-destructive">
                    {errors.get(`${id}-statement`)}
                  </FieldDescription>
                ) : null}
              </Field>
              <VerificationLinks id={id} rows={links} onChange={setLinks} errors={errors} />
            </FieldGroup>
            <Button
              type="submit"
              className={verificationActionClassName}
              disabled={!csrfToken || !canRequest || pending || !selected}
            >
              {m.settings_verification_submit()}
            </Button>
          </form>
        ) : null}
        {canWithdraw ? (
          confirmation === state.current ? (
            <Alert>
              <AlertTitle>{m.settings_verification_confirm_title()}</AlertTitle>
              <AlertDescription className="flex min-w-0 max-w-full flex-wrap gap-2">
                <Button
                  type="button"
                  variant="destructive"
                  className={verificationActionClassName}
                  disabled={pending || !csrfToken}
                  onClick={() => void withdraw()}
                >
                  {m.settings_verification_confirm_withdraw()}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className={verificationActionClassName}
                  onClick={() => setConfirmation(null)}
                >
                  {m.settings_verification_cancel()}
                </Button>
              </AlertDescription>
            </Alert>
          ) : (
            <Button
              type="button"
              variant="outline"
              className={verificationActionClassName}
              onClick={() => setConfirmation(state.current)}
            >
              {m.settings_verification_withdraw()}
            </Button>
          )
        ) : null}
        {state.attempt && !pending ? (
          <Alert>
            <AlertTitle>
              {state.attempt.kind === 'request'
                ? m.settings_verification_uncertain_request()
                : m.settings_verification_uncertain_withdraw()}
            </AlertTitle>
            <AlertDescription className="min-w-0 space-y-3">
              <p>
                {state.attempt.receipt
                  ? state.attempt.kind === 'request'
                    ? m.settings_verification_request_received()
                    : m.settings_verification_withdraw_received()
                  : state.attempt.kind === 'request'
                    ? m.settings_verification_request_unconfirmed()
                    : m.settings_verification_withdraw_unconfirmed()}
              </p>
              <p>
                {state.attempt.kind === 'request'
                  ? m.settings_verification_request_action({
                      subject: action?.subject ?? m.settings_verification_generic_subject(),
                    })
                  : m.settings_verification_withdraw_action({
                      subject: action?.subject ?? m.settings_verification_generic_subject(),
                    })}
              </p>
              <p>{m.settings_verification_check_guidance()}</p>
              <p>
                {state.attempt.kind === 'request'
                  ? m.settings_verification_retry_request_guidance()
                  : m.settings_verification_retry_withdraw_guidance()}
              </p>
              {state.attempt.kind === 'request' ? (
                <details>
                  <summary className={verificationSummaryClassName}>{m.settings_verification_original()}</summary>
                  <div className="space-y-2 break-words">
                    <p className="whitespace-pre-wrap">{state.attempt.input.statement}</p>
                    <ul>
                      {state.attempt.input.links.map((link, index) => (
                        <li key={index}>
                          {link.label}: {link.url}
                        </li>
                      ))}
                    </ul>
                  </div>
                </details>
              ) : boundedDiagnosticId(state.attempt.requestId) ? (
                <details>
                  <summary className={verificationSummaryClassName}>
                    {m.settings_verification_withdraw_details()}
                  </summary>
                  <p className="break-all">{state.attempt.requestId}</p>
                </details>
              ) : null}
              <Button
                type="button"
                className={verificationActionClassName}
                disabled={pending || waiting || !csrfToken}
                onClick={() => void recover(() => controller.retry())}
              >
                {state.attempt.kind === 'request'
                  ? m.settings_verification_retry_original()
                  : m.settings_verification_retry_withdraw()}
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}
        {state.phase === 'refused' ? (
          <Alert>
            <AlertTitle>
              {action?.kind === 'withdraw'
                ? m.settings_verification_withdraw_refused()
                : m.settings_verification_request_refused()}
            </AlertTitle>
            <AlertDescription>
              <p>
                {action?.kind === 'withdraw'
                  ? m.settings_verification_withdraw_action({ subject: action.subject })
                  : m.settings_verification_request_action({
                      subject: action?.subject ?? m.settings_verification_generic_subject(),
                    })}
              </p>
              <p>{m.settings_verification_check_guidance()}</p>
            </AlertDescription>
          </Alert>
        ) : null}
        {state.phase === 'review' ? <p role="status">{m.settings_verification_draft_preserved()}</p> : null}
        {state.failure && state.readStatus !== 'error' ? <CommandDetails failure={state.failure} /> : null}
        {waiting ? <p role="status">{m.settings_retry_wait()}</p> : null}
        <Button
          type="button"
          variant="outline"
          className={verificationActionClassName}
          disabled={pending || waiting}
          onClick={() => void recover(() => controller.reload())}
        >
          {m.settings_verification_read_current()}
        </Button>
      </CardContent>
    </Card>
  );
}
