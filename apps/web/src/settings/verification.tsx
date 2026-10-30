import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';
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
import { type AgentVerificationRequest, type VerificationInput } from './verification-core';
import {
  readVerificationState,
  requestVerificationAction,
  searchVerificationSubjects,
  withdrawVerificationAction,
} from './verification-actions';

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
  const { csrfToken } = useSession();
  const admitted = useOperation('agent_verification.request');
  const queryClient = useQueryClient();
  const id = useId();
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [selected, setSelected] = useState<{ id: string; title: string; type: string } | null>(null);
  const [statement, setStatement] = useState('');
  const [links, setLinks] = useState([{ label: '', url: '' }]);
  const [message, setMessage] = useState('');
  const [confirmation, setConfirmation] = useState(false);
  const [pending, setPending] = useState(false);
  const verificationQuery = useQuery({
    ...personalRead,
    enabled: personalRead.enabled && admitted,
    queryKey: ['settings', 'verification'],
    queryFn: readVerificationState,
  });
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [query]);
  const suggestionsQuery = useQuery({
    ...personalRead,
    queryKey: ['settings', 'verification-suggestions', debouncedQuery],
    queryFn: () => searchVerificationSubjects({ data: { query: debouncedQuery } }),
    enabled: admitted && debouncedQuery.length > 0 && !selected,
  });
  const verification = verificationQuery.data?.verificationRequest ?? null;
  const subjectTitle = verificationQuery.data?.subjectTitle ?? null;
  const canRequest =
    verificationQuery.isSuccess && (!verification || ['withdrawn', 'failed', 'rejected'].includes(verification.state));
  const canWithdraw = verification && ['pending', 'approving', 'approved'].includes(verification.state);

  if (!admitted || (verificationQuery.error as Error | null)?.message === 'rezics-platform-closed') return null;

  async function submit() {
    if (!csrfToken || !selected || pending) return;
    setPending(true);
    setMessage('');
    try {
      const result = await requestVerificationAction({
        data: {
          subject: selected.id,
          statement,
          links: links.filter((link) => link.label || link.url),
          idempotencyKey: crypto.randomUUID(),
        },
        headers: csrfHeaders(),
      });
      if (result.ok) {
        queryClient.setQueryData(['settings', 'verification'], {
          verificationRequest: result.verificationRequest,
          subjectTitle: selected.title,
        });
        setStatement('');
        setLinks([{ label: '', url: '' }]);
        setSelected(null);
        setQuery('');
        setMessage(m.settings_verification_sent());
      } else setMessage(result.message);
    } catch {
      setMessage(m.settings_verification_request_failed());
    } finally {
      setPending(false);
    }
  }

  async function withdraw() {
    if (!csrfToken || pending) return;
    setPending(true);
    setMessage('');
    try {
      const result = await withdrawVerificationAction({
        data: { idempotencyKey: crypto.randomUUID() },
        headers: csrfHeaders(),
      });
      if (result.ok) {
        queryClient.setQueryData(['settings', 'verification'], {
          verificationRequest: result.verificationRequest,
          subjectTitle,
        });
        setConfirmation(false);
      } else setMessage(result.message);
    } catch {
      setMessage(m.settings_verification_request_failed());
    } finally {
      setPending(false);
    }
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
        {verificationQuery.isLoading ? <p>{m.settings_verification_loading()}</p> : null}
        {verificationQuery.error ? <p role="alert">{m.settings_verification_load_failed()}</p> : null}
        {canRequest ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
            className="space-y-4"
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor={`${id}-subject`}>{m.settings_verification_subject()}</FieldLabel>
                {selected ? (
                  <div className="flex items-center gap-2">
                    <span>
                      {selected.title} · {selected.type}
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        setSelected(null);
                        setQuery('');
                      }}
                    >
                      {m.settings_verification_change_subject()}
                    </Button>
                  </div>
                ) : (
                  <Input
                    id={`${id}-subject`}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    autoComplete="off"
                  />
                )}
                {!selected && suggestionsQuery.data?.length ? (
                  <ul role="listbox" className="space-y-1">
                    {suggestionsQuery.data.map((subject) => (
                      <li key={subject.id}>
                        <button
                          type="button"
                          role="option"
                          className="w-full rounded border p-2 text-left"
                          onClick={() => {
                            setSelected(subject);
                            setQuery(subject.title);
                          }}
                        >
                          {subject.title} · {subject.type}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </Field>
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
                <Button type="button" variant="destructive" disabled={pending} onClick={() => void withdraw()}>
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
        {message ? (
          <p role="alert" aria-live="polite">
            {message}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
