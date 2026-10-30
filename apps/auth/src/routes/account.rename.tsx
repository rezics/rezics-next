import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { Field, FieldError, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { Alert, AlertDescription } from '@rezics/ui/shadcn/alert';
import { AuthButton as Button } from '../button';
import { AuthPage } from '../frame';
import { ErrorAlert } from '../alert';
import { m } from '../paraglide/messages.js';
import { normalizeSignupHandle } from '../signup';
import {
  clearRenameContinuation,
  createRenameAttempt,
  nativeRenameSource,
  readRenameContinuation,
  saveRenameContinuation,
  type RenameAttempt,
  type RenameRead,
  type RenameSource,
} from '../account-rename';

export const Route = createFileRoute('/account/rename')({
  head: () => ({ meta: [{ title: `${m.auth_rename_heading()} · REZICS` }] }),
  component: RenameAccountPage,
});

export function RenameAccountPage({ source = nativeRenameSource }: { source?: RenameSource } = {}) {
  const [current, setCurrent] = useState<RenameRead | null>(null);
  const [handle, setHandle] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [returned, setReturned] = useState(false);
  const [pending, setPending] = useState(false);
  const [locked, setLocked] = useState(false);
  const [message, setMessage] = useState('');
  const [inputError, setInputError] = useState('');
  const [renamed, setRenamed] = useState('');
  const attempt = useRef<RenameAttempt | null>(null);
  const busy = useRef(false);
  const alert = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    void source
      .readCurrent()
      .catch((): RenameRead => ({ kind: 'unavailable' }))
      .then((result) => {
        if (!active) return;
        const saved = readRenameContinuation();
        if (saved && result.kind === 'ready') {
          if (saved.accountId !== result.target.accountId) {
            clearRenameContinuation();
            setMessage(m.auth_rename_denied());
          } else if (saved.submitted || saved.operation.expectedHandle === result.target.handle) {
            attempt.current = saved;
            setHandle(saved.operation.handle);
            setLocked(saved.submitted);
            setReturned(true);
          } else {
            clearRenameContinuation();
            setMessage(m.auth_rename_conflict());
          }
        }
        setCurrent(result);
      });
    return () => {
      active = false;
    };
  }, [source]);
  useLayoutEffect(() => {
    if (inputError) input.current?.focus();
    else if (message) alert.current?.focus();
  }, [inputError, message]);

  async function reload() {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    try {
      setCurrent(await source.readCurrent());
    } catch {
      setCurrent({ kind: 'unavailable' });
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current || current?.kind !== 'ready' || !confirmed) return;
    const normalized = normalizeSignupHandle(handle);
    if (!normalized || (normalized === current.target.handle && !attempt.current?.submitted)) {
      setInputError(m.auth_rename_invalid());
      return;
    }
    const selected = attempt.current ?? createRenameAttempt(current.target, handle);
    if (!selected) return;
    attempt.current = selected;
    busy.current = true;
    setPending(true);
    setMessage('');
    setInputError('');
    try {
      const result = await source.run(selected);
      setLocked(selected.submitted);
      if (result.kind === 'renamed') {
        clearRenameContinuation();
        setRenamed(result.target.handle ?? '');
      } else if (result.kind === 'step-up') {
        saveRenameContinuation(selected);
        setConfirmed(false);
        if (!(await source.stepUp(selected))) setMessage(m.auth_rename_unavailable());
      } else if (result.kind === 'conflict') {
        clearRenameContinuation();
        attempt.current = null;
        setLocked(false);
        setConfirmed(false);
        setCurrent(result.current);
        setMessage(m.auth_rename_conflict());
      } else {
        setMessage(
          result.kind === 'unknown'
            ? m.auth_rename_unknown()
            : result.kind === 'denied'
              ? m.auth_rename_denied()
              : m.auth_rename_unavailable(),
        );
      }
    } catch {
      setLocked(selected.submitted);
      setMessage(selected.submitted ? m.auth_rename_unknown() : m.auth_rename_unavailable());
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  if (renamed)
    return (
      <AuthPage heading={m.auth_rename_heading()}>
        <Alert role="status">
          <AlertDescription>{m.auth_rename_success({ handle: renamed })}</AlertDescription>
        </Alert>
      </AuthPage>
    );
  return (
    <AuthPage heading={m.auth_rename_heading()}>
      <div className="auth-account-operation-copy">
        <p>{m.auth_rename_description()}</p>
        <p>{m.auth_rename_forwarding()}</p>
      </div>
      {!current ? (
        <p role="status">{m.auth_inventory_loading()}</p>
      ) : current.kind === 'signed-out' ? (
        <p>
          {m.auth_rename_signed_out()}{' '}
          <a href="/login" className="underline">
            {m.auth_security_sign_in()}
          </a>
        </p>
      ) : current.kind !== 'ready' ? (
        <>
          <ErrorAlert>{m.auth_rename_unavailable()}</ErrorAlert>
          <Button type="button" disabled={pending} aria-busy={pending} onClick={() => void reload()}>
            {m.auth_rename_reload()}
          </Button>
        </>
      ) : (
        <form
          className="auth-login-form"
          method="post"
          action="/account-operations/approve"
          noValidate
          onSubmit={submit}
        >
          <p>{m.auth_rename_current({ handle: current.target.handle ?? m.auth_rename_no_handle() })}</p>
          {returned ? (
            <Alert role="status">
              <AlertDescription>{m.auth_rename_reconfirm()}</AlertDescription>
            </Alert>
          ) : null}
          <Field data-invalid={Boolean(inputError)}>
            <FieldLabel htmlFor="rename-handle">{m.auth_rename_handle()}</FieldLabel>
            <Input
              ref={input}
              id="rename-handle"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              value={handle}
              disabled={pending || locked}
              aria-invalid={Boolean(inputError)}
              aria-describedby={inputError ? 'rename-handle-error' : 'rename-handle-help'}
              onChange={(event) => {
                setHandle(event.target.value);
                setConfirmed(false);
                setReturned(false);
                setInputError('');
                attempt.current = null;
                clearRenameContinuation();
              }}
            />
            <p id="rename-handle-help">{m.auth_organization_handle_invalid()}</p>
            {inputError ? <FieldError id="rename-handle-error">{inputError}</FieldError> : null}
          </Field>
          <Field>
            <label className="flex items-start gap-3" htmlFor="rename-confirm">
              <input
                id="rename-confirm"
                type="checkbox"
                checked={confirmed}
                disabled={pending}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              {m.auth_rename_confirm({ handle: normalizeSignupHandle(handle) ?? handle })}
            </label>
          </Field>
          {message ? (
            <ErrorAlert tabIndex={-1} ref={alert}>
              {message}
            </ErrorAlert>
          ) : null}
          <Button type="submit" className="w-full" disabled={pending || !confirmed} aria-busy={pending}>
            {locked ? m.auth_rename_retry() : m.auth_rename_submit()}
          </Button>
        </form>
      )}
    </AuthPage>
  );
}
