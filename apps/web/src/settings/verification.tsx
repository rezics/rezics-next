import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
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
import { csrfHeaders } from '../threads/composer';
import { useSession } from '../session/query';
import {
  unwrapVerificationRead,
  type AgentVerificationRequest,
  type VerificationFailure,
  type VerificationInput,
} from './verification-core';
import { usePreferenceRetry } from './preference-failure-retry';
import { useSettingsNavigationCurrent, useSettingsNavigationDraft } from './reading-navigation';
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
} from './verification-recovery';
import { readVerificationState, requestVerificationAction, withdrawVerificationAction } from './verification-actions';

function subjectLabel(title: string | null | undefined, subjectId: string | undefined) {
  return title?.trim() && title !== subjectId ? title : m.settings_verification_generic_subject();
}

function CommandDetails({ failure }: { failure: VerificationFailure }) {
  // Only bounded diagnostic identifiers belong here; never render the transported message or command key.
  const code = failure.code && /^[a-z][a-z0-9_]{0,63}$/.test(failure.code) ? failure.code : null;
  const requestId =
    failure.requestId && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/.test(failure.requestId) ? failure.requestId : null;
  return (
    <details>
      <summary>{m.settings_verification_command_details()}</summary>
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
  subjectTitle,
}: {
  verification: AgentVerificationRequest | null;
  subjectTitle: string | null;
}) {
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

function ViewerVerification({ accountId, csrfToken }: { accountId: string; csrfToken: string | null }) {
  const queryClient = useQueryClient();
  const [controller] = useState(
    () =>
      new VerificationRecovery(accountId, {
        read: () =>
          queryClient.fetchQuery({
            ...personalRead,
            queryKey: verificationQueryKey(accountId),
            queryFn: async () =>
              unwrapVerificationRead<VerificationSnapshot>(await readVerificationState({ data: { accountId } })),
            retry: false,
          }),
        request: (_, input) => requestVerificationAction({ data: { ...input, accountId }, headers: csrfHeaders() }),
        withdraw: (_, input) => withdrawVerificationAction({ data: { ...input, accountId }, headers: csrfHeaders() }),
      }),
  );
  useEffect(() => {
    controller.activate();
    void controller.reload();
    return () => controller.deactivate();
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
  const [confirmation, setConfirmation] = useState(false);
  // Capture the genuine label in the action handler, before a send clears current status or the draft changes.
  const [action, setAction] = useState<{ kind: 'request' | 'withdraw'; subject: string } | null>(null);
  const [acknowledged, setAcknowledged] = useState<Omit<VerificationInput, 'idempotencyKey'> | null>(null);
  const isCurrent = useSettingsNavigationCurrent(csrfToken);
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
    const command = action();
    const original = controller.snapshot().attempt;
    await command;
    const current = controller.snapshot();
    if (original?.kind === 'request' && !current.attempt && current.phase === 'review') setAcknowledged(original.input);
  }

  async function submit() {
    if (!csrfToken || !canRequest) return;
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
    if (!csrfToken || !confirmation || !canWithdraw) return;
    setAction({ kind: 'withdraw', subject: subjectLabel(subjectTitle, verification?.catalogueSubjectId) });
    await controller.withdraw(true);
    setConfirmation(false);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{m.settings_verification_heading()}</h2>
        </CardTitle>
        <CardDescription>{m.settings_verification_intro()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
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
            data-response-code={state.failure?.code}
            data-request-id={state.failure?.requestId}
            data-retry-after={state.failure?.retryAfter}
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
                <summary>{m.settings_verification_read_details()}</summary>
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
              <VerificationSubjectChooser selected={selected} onSelect={setSelected} disabled={pending || !csrfToken} />
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
            <Button type="submit" disabled={!csrfToken || !canRequest || pending || !selected}>
              {m.settings_verification_submit()}
            </Button>
          </form>
        ) : null}
        {canWithdraw ? (
          confirmation ? (
            <Alert>
              <AlertTitle>{m.settings_verification_confirm_title()}</AlertTitle>
              <AlertDescription className="space-x-2">
                <Button
                  type="button"
                  variant="destructive"
                  disabled={pending || !csrfToken}
                  onClick={() => void withdraw()}
                >
                  {m.settings_verification_confirm_withdraw()}
                </Button>
                <Button type="button" variant="outline" onClick={() => setConfirmation(false)}>
                  {m.settings_verification_cancel()}
                </Button>
              </AlertDescription>
            </Alert>
          ) : (
            <Button type="button" variant="outline" onClick={() => setConfirmation(true)}>
              {m.settings_verification_withdraw()}
            </Button>
          )
        ) : null}
        {state.attempt && !pending ? (
          <Alert>
            <AlertTitle>
              {state.attempt.receipt
                ? state.attempt.kind === 'request'
                  ? m.settings_verification_request_received()
                  : m.settings_verification_withdraw_received()
                : state.attempt.kind === 'request'
                  ? m.settings_verification_uncertain_request()
                  : m.settings_verification_uncertain_withdraw()}
            </AlertTitle>
            <AlertDescription className="space-y-3">
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
                  <summary>{m.settings_verification_original()}</summary>
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
              ) : null}
              <Button
                type="button"
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
          disabled={pending || waiting}
          onClick={() => void recover(() => controller.reload())}
        >
          {m.settings_verification_read_current()}
        </Button>
      </CardContent>
    </Card>
  );
}
