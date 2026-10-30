import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useState, useSyncExternalStore } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@rezics/ui/shadcn/alert';
import { Button } from '@rezics/ui/shadcn/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@rezics/ui/shadcn/card';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { Textarea } from '@rezics/ui/shadcn/textarea';
import { personalRead } from '../kernel/query';
import { useOperation } from '../kernel/exposure';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { subjectHref } from '../subject/subject-href';
import { csrfHeaders } from '../threads/composer';
import { useSession } from '../session/query';
import { type AgentVerificationRequest } from './verification-core';
import { VerificationSubjectChooser } from './verification-subject-chooser';
import {
  VerificationRecovery,
  canRequestVerification,
  canWithdrawVerification,
  verificationQueryKey,
} from './verification-recovery';
import { readVerificationState, requestVerificationAction, withdrawVerificationAction } from './verification-actions';

function VerificationState({
  verification,
  subjectTitle,
}: {
  verification: AgentVerificationRequest | null;
  subjectTitle: string | null;
}) {
  if (!verification) return null;
  if (verification.state === 'pending' || verification.state === 'approving')
    return <p>{m.settings_verification_pending({ subject: subjectTitle ?? verification.catalogueSubjectId })}</p>;
  if (verification.state === 'approved')
    return (
      <p>
        {m.settings_verification_verified()}{' '}
        <a
          className="underline"
          href={
            subjectHref(
              { id: verification.catalogueSubjectId, label: subjectTitle ?? verification.catalogueSubjectId },
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
  const { csrfToken, subject } = useSession();
  const admitted = useOperation('agent_verification.request');
  if (!admitted || !subject) return null;
  return <ViewerVerification key={subject} accountId={subject} csrfToken={csrfToken} />;
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
            queryFn: () => readVerificationState({ data: { accountId } }),
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
  const [links, setLinks] = useState(initialDraft?.links ?? [{ label: '', url: '' }]);
  const [confirmation, setConfirmation] = useState(false);
  const admitted = useOperation('agent_verification.request');
  const pending = state.phase === 'sending' || state.phase === 'reading';
  const verification = state.current?.verificationRequest ?? null;
  const subjectTitle = state.current?.subjectTitle ?? null;
  const canRequest = canRequestVerification(state.current) && !state.attempt && !pending;
  const canWithdraw = canWithdrawVerification(state.current) && !state.attempt && !pending;
  const hasDraft = !!selected || !!statement || links.some((link) => link.label || link.url);

  if (state.failure?.message === 'rezics-platform-closed') return null;

  async function submit() {
    if (!csrfToken || !selected || !canRequest) return;
    await controller.submit({ subject: selected.id, statement, links: links.filter((link) => link.label || link.url) });
  }

  async function withdraw() {
    if (!csrfToken || !confirmation || !canWithdraw) return;
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
        <VerificationState verification={verification} subjectTitle={subjectTitle} />
        {state.phase === 'loading' || state.phase === 'reading' ? <p>{m.settings_verification_loading()}</p> : null}
        {state.phase === 'sending' ? <p role="status">{m.settings_saving()}</p> : null}
        {state.phase === 'unavailable' ? <p role="alert">{m.settings_verification_load_failed()}</p> : null}
        {canRequest || hasDraft || state.attempt?.kind === 'request' ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
            className="space-y-4"
          >
            <FieldGroup>
              <VerificationSubjectChooser selected={selected} onSelect={setSelected} disabled={pending || !csrfToken} />
              <Field>
                <FieldLabel htmlFor={`${id}-statement`}>{m.settings_verification_statement()}</FieldLabel>
                <Textarea
                  id={`${id}-statement`}
                  value={statement}
                  maxLength={2000}
                  onChange={(event) => setStatement(event.target.value)}
                />
                <FieldDescription>{m.settings_verification_characters({ count: statement.length })}</FieldDescription>
              </Field>
              {links.map((link, index) => (
                <div key={index} className="grid gap-2 sm:grid-cols-2">
                  <Field>
                    <FieldLabel htmlFor={`${id}-label-${index}`}>{m.settings_verification_link_label()}</FieldLabel>
                    <Input
                      id={`${id}-label-${index}`}
                      value={link.label}
                      onChange={(event) =>
                        setLinks((rows) =>
                          rows.map((row, i) => (i === index ? { ...row, label: event.target.value } : row)),
                        )
                      }
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor={`${id}-url-${index}`}>{m.settings_verification_link_url()}</FieldLabel>
                    <Input
                      id={`${id}-url-${index}`}
                      type="url"
                      value={link.url}
                      onChange={(event) =>
                        setLinks((rows) =>
                          rows.map((row, i) => (i === index ? { ...row, url: event.target.value } : row)),
                        )
                      }
                    />
                  </Field>
                  {links.length > 1 ? (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setLinks((rows) => rows.filter((_, i) => i !== index))}
                    >
                      {m.settings_verification_remove_link()}
                    </Button>
                  ) : null}
                </div>
              ))}
              {links.length < 5 ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setLinks((rows) => [...rows, { label: '', url: '' }])}
                >
                  {m.settings_verification_add_link()}
                </Button>
              ) : null}
            </FieldGroup>
            <Button
              type="submit"
              disabled={
                !csrfToken ||
                !canRequest ||
                pending ||
                !selected ||
                !statement.trim() ||
                links.some((link) => Boolean(link.label) !== Boolean(link.url))
              }
            >
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
              {state.attempt.kind === 'request'
                ? m.settings_verification_uncertain_request()
                : m.settings_verification_uncertain_withdraw()}
            </AlertTitle>
            <AlertDescription className="space-y-3">
              <details>
                <summary>{m.settings_verification_original()}</summary>
                <p className="break-all">{state.attempt.input.idempotencyKey}</p>
                {'subject' in state.attempt.input ? (
                  <div className="space-y-2 break-words">
                    <p>{state.attempt.input.subject}</p>
                    <p className="whitespace-pre-wrap">{state.attempt.input.statement}</p>
                    <ul>
                      {state.attempt.input.links.map((link, index) => (
                        <li key={index}>
                          {link.label}: {link.url}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <p className="break-all">{state.attempt.requestId}</p>
                )}
              </details>
              <Button type="button" disabled={pending || !csrfToken} onClick={() => void controller.retry()}>
                {m.settings_verification_retry_original()}
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}
        {state.phase === 'review' ? <p role="status">{m.settings_verification_draft_preserved()}</p> : null}
        {state.failure ? (
          <p role="alert">
            {m.settings_verification_command_error({
              status: state.failure.status,
              message: state.failure.message,
            })}
          </p>
        ) : null}
        <Button type="button" variant="outline" disabled={pending} onClick={() => void controller.reload()}>
          {m.settings_verification_read_current()}
        </Button>
      </CardContent>
    </Card>
  );
}
