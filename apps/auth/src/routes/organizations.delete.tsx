import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { Input } from '@rezics/ui/shadcn/input';
import { Field, FieldError, FieldLabel } from '@rezics/ui/shadcn/field';
import { Alert, AlertDescription } from '@rezics/ui/shadcn/alert';
import { AuthButton as Button } from '../button';
import { ErrorAlert } from '../alert';
import { AuthPage } from '../frame';
import { m } from '../paraglide/messages.js';
import { readPrivacyContact } from '../privacy-contact';
import { forgetOperationKey, operationKeyFor } from '../account-operations';
import {
  clearOrganizationDeleteStepUp,
  isAccountId,
  organizationDeletePendingMatches,
  organizationDeleteSessionMatches,
  organizationDeleteStepUpUrl,
  readOrganizationDeleteStepUp,
  storeOrganizationDeleteStepUp,
  readOrganizationDeleteUnknown,
} from '../organization-delete-step-up';
import {
  executeOrganizationDeletion,
  loadOrganizationDeletion,
  organizationDeleteConfirmation,
  organizationDeleteConfirmed,
  readCurrentOrganizationForDeletion,
  type OrganizationDeletionLoad,
  type OrganizationDeletionReader,
} from '../organization-deletion';

// Trusted issuer entry for Web management: /organizations/delete?organization_id=<immutable UUID>.
// The selection supplies no authority and is never accepted as an own-delete target.
export const Route = createFileRoute('/organizations/delete')({
  validateSearch: (search: Record<string, unknown>) => ({
    organization_id: isAccountId(search.organization_id) ? search.organization_id : undefined,
  }),
  loader: () => readPrivacyContact(),
  head: () => ({ meta: [{ title: `${m.auth_organization_delete_heading()} · REZICS` }] }),
  component: OrganizationDeletePage,
});

function OrganizationDeletePage() {
  return (
    <OrganizationDeleteContent
      privacyContact={Route.useLoaderData()}
      organizationId={Route.useSearch().organization_id}
    />
  );
}

export function OrganizationDeleteContent({
  privacyContact,
  organizationId,
  read = readCurrentOrganizationForDeletion,
}: {
  privacyContact: string | null;
  organizationId?: string | undefined;
  read?: OrganizationDeletionReader;
}) {
  const [loaded, setLoaded] = useState<OrganizationDeletionLoad | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [confirmationError, setConfirmationError] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [outcome, setOutcome] = useState<'form' | 'accepted' | 'unknown'>('form');
  const submitting = useRef(false);
  const selectedId = useRef<string | undefined>(undefined);
  const input = useRef<HTMLInputElement>(null);
  const alert = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    setLoaded(null);
    setMessage('');
    setConfirmation('');
    setOutcome('form');
    const continuation = readOrganizationDeleteStepUp();
    const saved = continuation.kind === 'pending' ? continuation.value : null;
    const selected = organizationId ?? saved?.organizationId;
    selectedId.current = selected;
    if (continuation.kind === 'invalid' || (saved && organizationId && saved.organizationId !== organizationId)) {
      clearOrganizationDeleteStepUp();
      setMessage(m.auth_organization_delete_changed());
    }
    if (!selected) {
      setLoaded({ kind: 'missing' });
      return;
    }
    void loadOrganizationDeletion(selected, read).then((result) => {
      if (!active) return;
      if (
        saved &&
        saved.organizationId === selected &&
        result.kind === 'ready' &&
        !organizationDeleteSessionMatches(result.target.session, saved)
      ) {
        clearOrganizationDeleteStepUp();
        setLoaded({ kind: 'denied' });
        return;
      }
      if (saved && saved.organizationId === selected) setMessage(m.auth_account_operation_reconfirm());
      const uncertain = readOrganizationDeleteUnknown(selected);
      if (uncertain.kind !== 'absent') {
        setOutcome('unknown');
        setMessage(m.auth_organization_delete_unknown());
      }
      setLoaded(result);
    });
    return () => {
      active = false;
    };
  }, [organizationId, read]);

  useLayoutEffect(() => {
    if (confirmationError) input.current?.focus();
    else if (message) alert.current?.focus();
  }, [confirmationError, message]);

  const target = loaded?.kind === 'ready' ? loaded.target : null;
  const phrase = target ? organizationDeleteConfirmation(target, m.auth_organization_delete_phrase()) : '';

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!target || !privacyContact || submitting.current || outcome !== 'form') return;
    if (!organizationDeleteConfirmed(confirmation, phrase)) {
      setConfirmationError(true);
      return;
    }
    submitting.current = true;
    setPending(true);
    setConfirmationError(false);
    setMessage('');
    try {
      const operation = { kind: 'delete' as const, accountId: target.organizationId };
      const key = operationKeyFor(operation, target.humanAccountId);
      const continuation = readOrganizationDeleteStepUp();
      if (
        continuation.kind === 'invalid' ||
        (continuation.kind === 'pending' &&
          !organizationDeletePendingMatches(continuation.value, target.humanAccountId, target.organizationId, key))
      ) {
        clearOrganizationDeleteStepUp();
        setConfirmation('');
        setMessage(m.auth_organization_delete_changed());
        return;
      }
      const result = await executeOrganizationDeletion(target, key, read);
      if (result.ok) {
        forgetOperationKey(operation, target.humanAccountId);
        clearOrganizationDeleteStepUp();
        setOutcome('accepted');
        setConfirmation('');
        return;
      }
      if (result.reason === 'step-up') {
        if (
          storeOrganizationDeleteStepUp({
            humanAccountId: target.humanAccountId,
            organizationId: target.organizationId,
            operationKey: key,
          })
        ) {
          window.location.assign(organizationDeleteStepUpUrl);
          return;
        }
        setMessage(m.auth_account_operation_failure());
        return;
      }
      setConfirmation('');
      if (result.reason === 'unknown') {
        // No new approval or execution after ambiguity. The original helper has
        // already retried the same reference/body/key; only current readback follows.
        clearOrganizationDeleteStepUp();
        setOutcome('unknown');
        setMessage(m.auth_organization_delete_unknown());
      } else if (result.reason === 'changed') {
        clearOrganizationDeleteStepUp();
        setLoaded({ kind: 'unavailable' });
        setMessage(m.auth_organization_delete_changed());
      } else if (result.reason === 'denied') setMessage(m.auth_organization_delete_denied());
      else if (result.reason === 'platform-closed') setMessage(m.auth_organization_not_open());
      else if (result.reason === 'unavailable') setMessage(m.auth_account_operation_unavailable());
      else setMessage(m.auth_account_operation_failure());
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  async function readback(currentOrganizationId: string) {
    if (submitting.current) return;
    submitting.current = true;
    setPending(true);
    try {
      const result = await loadOrganizationDeletion(currentOrganizationId, read);
      // A missing/denied read is not proof of deletion; a readable target is not
      // proof that an earlier command failed. Preserve the unknown command state.
      setLoaded(result);
      setMessage(
        result.kind === 'ready'
          ? m.auth_organization_delete_still_readable()
          : result.kind === 'denied' || result.kind === 'missing'
            ? m.auth_organization_delete_read_denied()
            : m.auth_account_operation_unavailable(),
      );
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  const [privacyBefore, privacyAfter] = privacyContact
    ? m.auth_account_delete_privacy_contact({ contact: privacyContact }).split(privacyContact)
    : [];

  return (
    <AuthPage heading={m.auth_organization_delete_heading()}>
      <div className="auth-login-form">
        <p>{m.auth_organization_delete_effect()}</p>
        <p>{m.auth_organization_delete_remedies()}</p>
        {privacyContact ? (
          <p>
            {privacyBefore}
            <a href={privacyContact}>{privacyContact}</a>
            {privacyAfter}
          </p>
        ) : (
          <ErrorAlert>{m.auth_account_delete_unavailable()}</ErrorAlert>
        )}
        {message ? (
          <ErrorAlert tabIndex={-1} ref={alert}>
            {message}
          </ErrorAlert>
        ) : null}
        {outcome === 'accepted' ? (
          <Alert role="status">
            <AlertDescription>{m.auth_organization_delete_accepted()}</AlertDescription>
          </Alert>
        ) : outcome === 'unknown' ? (
          <>
            <p>{m.auth_organization_delete_unknown()}</p>
            {selectedId.current ? (
              <Button
                type="button"
                disabled={pending}
                aria-busy={pending}
                onClick={() => void readback(selectedId.current!)}
              >
                {m.auth_organization_delete_readback()}
              </Button>
            ) : (
              <p>{m.auth_account_operation_unavailable()}</p>
            )}
          </>
        ) : !loaded ? (
          <p role="status">{m.auth_inventory_loading()}</p>
        ) : loaded.kind === 'signed-out' ? (
          <>
            <p>{m.auth_account_operation_sign_in_required()}</p>
            <a href="/login">{m.auth_security_sign_in()}</a>
          </>
        ) : !target ? (
          <ErrorAlert>
            {loaded.kind === 'denied' || loaded.kind === 'missing'
              ? m.auth_organization_delete_read_denied()
              : m.auth_account_operation_unavailable()}
          </ErrorAlert>
        ) : (
          <form
            method="post"
            action="/account-operations/approve"
            onSubmit={submit}
            noValidate
            className="auth-login-form"
          >
            <p>{target.displayName || (target.handle ? `@${target.handle}` : target.organizationId)}</p>
            <p>{target.organizationId}</p>
            <Field data-invalid={confirmationError}>
              <FieldLabel htmlFor="organization-delete-confirmation">
                {m.auth_account_delete_confirmation_prompt({ phrase })}
              </FieldLabel>
              <Input
                id="organization-delete-confirmation"
                ref={input}
                value={confirmation}
                autoComplete="off"
                required
                readOnly={pending}
                onChange={(event) => {
                  setConfirmation(event.target.value);
                  setConfirmationError(false);
                }}
                aria-invalid={confirmationError || undefined}
                aria-describedby={confirmationError ? 'organization-delete-confirmation-error' : undefined}
              />
              {confirmationError ? (
                <FieldError id="organization-delete-confirmation-error">
                  {m.auth_account_delete_confirmation_error()}
                </FieldError>
              ) : null}
            </Field>
            <Button type="submit" variant="destructive" disabled={pending || !privacyContact} aria-busy={pending}>
              {m.auth_organization_delete_heading()}
            </Button>
          </form>
        )}
      </div>
    </AuthPage>
  );
}
