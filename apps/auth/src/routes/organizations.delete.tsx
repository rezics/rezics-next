import { createFileRoute, useBlocker, useRouter } from '@tanstack/react-router';
import { useCallback, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { Input } from '@rezics/ui/shadcn/input';
import { Field, FieldError, FieldLabel } from '@rezics/ui/shadcn/field';
import { Alert, AlertDescription } from '@rezics/ui/shadcn/alert';
import { AuthButton as Button } from '../button';
import { ErrorAlert } from '../alert';
import { AuthPage } from '../frame';
import { OrganizationDeletionRecovery, OrganizationDeletionDeparturePrompt } from '../organization-deletion-recovery';
import {
  organizationDeletionAttempt,
  warnOrganizationDeletionAttempt,
  type OrganizationDeletionAttempt,
} from '../organization-deletion-attempt';
import { m } from '../paraglide/messages.js';
import { readPrivacyContact } from '../privacy-contact';
import { forgetOperationKey, operationKeyFor } from '../account-operations';
import {
  clearOrganizationDeleteStepUp,
  isAccountId,
  organizationDeletePendingMatches,
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
  type OrganizationDeletionReview,
} from '../organization-deletion';

// Trusted issuer entry for Web management: /organizations/delete?organization_id=<immutable UUID>.
// The selection supplies no authority and is never accepted as an own-delete target.
export const Route = createFileRoute('/organizations/delete')({
  validateSearch: (search: Record<string, unknown>) => ({
    organization_id:
      search.organization_id === undefined
        ? undefined
        : isAccountId(search.organization_id)
          ? search.organization_id
          : '',
  }),
  loader: () => readPrivacyContact(),
  head: () => ({ meta: [{ title: `${m.auth_organization_delete_heading()} · REZICS` }] }),
  component: OrganizationDeletePage,
});

function OrganizationDeleteDeparture({
  shouldWarn,
  leave,
  focus,
  unknown,
}: {
  shouldWarn: () => boolean;
  leave: () => void;
  focus: () => void;
  unknown: boolean;
}) {
  const blocker = useBlocker({ shouldBlockFn: shouldWarn, enableBeforeUnload: false, withResolver: true });
  useLayoutEffect(() => {
    if (blocker.status === 'blocked' && !shouldWarn()) blocker.proceed();
  });
  const stay = () => {
    if (blocker.status === 'blocked') blocker.reset();
  };
  return (
    <OrganizationDeletionDeparturePrompt
      open={blocker.status === 'blocked'}
      unknown={unknown}
      stay={stay}
      focus={focus}
      leave={() => {
        if (blocker.status !== 'blocked') return;
        leave();
        blocker.proceed();
      }}
    />
  );
}

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
  const submitting = useRef<object | null>(null);
  const attempt = useRef<OrganizationDeletionAttempt | null>(null);
  const recoveryHeading = useRef<HTMLHeadingElement>(null);
  const review = useRef<
    | (OrganizationDeletionReview & {
        selected?: string | undefined;
        operationKey?: string | undefined;
        active: boolean;
        source: string | undefined;
        reader: OrganizationDeletionReader;
      })
    | null
  >(null);
  const selectedId = useRef<string | undefined>(undefined);
  const input = useRef<HTMLInputElement>(null);
  const alert = useRef<HTMLDivElement>(null);
  const router = useRouter({ warn: false });
  const bypassDeparture = useRef(false);
  const departureState = useRef({ confirmation, pending, outcome, loaded, organizationId, read });
  departureState.current = { confirmation, pending, outcome, loaded, organizationId, read };

  const shouldWarn = useCallback(() => {
    const state = departureState.current;
    const current = review.current;
    const continuation = readOrganizationDeleteStepUp();
    const hasAuthority = state.loaded === null || state.loaded.kind === 'ready' || state.loaded.kind === 'unavailable';
    const unfinished =
      Boolean(state.confirmation.trim()) ||
      state.pending ||
      submitting.current !== null ||
      continuation.kind === 'pending';
    return Boolean(
      !bypassDeparture.current &&
      current?.source === state.organizationId &&
      current?.reader === state.read &&
      (warnOrganizationDeletionAttempt(attempt.current, current?.selected) ||
        (current?.active && hasAuthority && unfinished)),
    );
  }, []);

  function resetReview() {
    submitting.current = null;
    setPending(false);
    setLoaded(null);
    setConfirmationError(false);
    setMessage('');
    setConfirmation('');
    setOutcome('form');
  }

  function invalidateReview(current: NonNullable<typeof review.current>) {
    current.active = false;
    if (review.current === current) {
      submitting.current = null;
      setPending(false);
    }
  }

  function leaveReview() {
    bypassDeparture.current = true;
    if (attempt.current) attempt.current.mounted = false;
    if (review.current) review.current.active = false;
    selectedId.current = undefined;
    resetReview();
  }

  async function loadReview(current: NonNullable<typeof review.current>) {
    const result = current.selected
      ? await loadOrganizationDeletion(current.selected, read, current)
      : { kind: 'missing' as const };
    if (!current.isCurrent()) return;
    if (['signed-out', 'denied', 'hidden', 'missing', 'changed'].includes(result.kind)) {
      invalidateReview(current);
      setLoaded(result);
      return;
    }
    const continuation = readOrganizationDeleteStepUp();
    if (
      continuation.kind === 'pending' &&
      continuation.value.organizationId === current.selected &&
      result.kind === 'ready'
    ) {
      if (
        !organizationDeletePendingMatches(
          continuation.value,
          result.target.humanAccountId,
          result.target.organizationId,
          current.operationKey ?? '',
        )
      ) {
        invalidateReview(current);
        setLoaded({ kind: 'changed' });
        return;
      }
      setMessage(m.auth_account_operation_reconfirm());
    }
    setLoaded(result);
  }

  useLayoutEffect(() => {
    if (review.current) review.current.active = false;
    bypassDeparture.current = false;
    resetReview();
    const continuation = readOrganizationDeleteStepUp();
    const saved = continuation.kind === 'pending' ? continuation.value : null;
    const selected = organizationId ?? saved?.organizationId;
    selectedId.current = selected;
    const uncertain = selected ? readOrganizationDeleteUnknown(selected) : { kind: 'absent' as const };
    attempt.current = selected
      ? organizationDeletionAttempt(
          uncertain.kind === 'pending' ? uncertain.value : { organizationId: selected },
          uncertain.kind !== 'absent',
        )
      : null;
    const current = {
      selected,
      operationKey:
        uncertain.kind === 'pending'
          ? uncertain.value.operationKey
          : saved?.organizationId === selected
            ? saved?.operationKey
            : undefined,
      active: true,
      source: organizationId,
      reader: read,
      humanAccountId:
        uncertain.kind === 'pending'
          ? uncertain.value.humanAccountId
          : saved?.organizationId === selected
            ? saved?.humanAccountId
            : undefined,
      isCurrent: (): boolean => review.current === current && current.active,
    };
    review.current = current;
    if (continuation.kind === 'invalid' || (saved && organizationId && saved.organizationId !== organizationId)) {
      if (continuation.kind === 'invalid') clearOrganizationDeleteStepUp();
      setMessage(m.auth_organization_delete_changed());
    }
    if (uncertain.kind !== 'absent') setOutcome('unknown');
    void loadReview(current);
    const retire = () => {
      if (review.current) review.current.active = false;
      resetReview();
      const retained = selected ? readOrganizationDeleteUnknown(selected) : { kind: 'absent' as const };
      if (attempt.current && retained.kind !== 'absent') attempt.current.unresolved = true;
      if (attempt.current?.unresolved) setOutcome('unknown');
      setLoaded({ kind: 'unavailable' });
    };
    const restore = (event: PageTransitionEvent) => {
      if (event.persisted) retire();
    };
    window.addEventListener('pagehide', retire);
    window.addEventListener('pageshow', restore);
    return () => {
      if (attempt.current) attempt.current.mounted = false;
      if (review.current) review.current.active = false;
      window.removeEventListener('pagehide', retire);
      window.removeEventListener('pageshow', restore);
    };
  }, [organizationId, read]);

  useLayoutEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      if (!shouldWarn()) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', unload);
    return () => window.removeEventListener('beforeunload', unload);
  }, [shouldWarn]);

  async function recover() {
    const previous = review.current;
    if (!previous || submitting.current) return;
    previous.active = false;
    const current = {
      ...previous,
      active: true,
      isCurrent: (): boolean => review.current === current && current.active,
    };
    review.current = current;
    resetReview();
    if (current.selected && readOrganizationDeleteUnknown(current.selected).kind !== 'absent') setOutcome('unknown');
    await loadReview(current);
  }

  useLayoutEffect(() => {
    if (confirmationError) input.current?.focus();
    else if (message) alert.current?.focus();
  }, [confirmationError, message]);

  const target = loaded?.kind === 'ready' ? loaded.target : null;
  const phrase = target ? organizationDeleteConfirmation(target, m.auth_organization_delete_phrase()) : '';

  function clearReviewContinuation(current: NonNullable<typeof review.current>) {
    const saved = readOrganizationDeleteStepUp();
    if (
      saved.kind === 'pending' &&
      current.humanAccountId &&
      current.selected &&
      current.operationKey &&
      organizationDeletePendingMatches(saved.value, current.humanAccountId, current.selected, current.operationKey)
    )
      clearOrganizationDeleteStepUp();
  }

  function authenticate(humanAccountId: string, selected: string) {
    const current = review.current;
    if (
      !current?.isCurrent() ||
      current.selected !== selected ||
      current.humanAccountId !== humanAccountId ||
      outcome !== 'form'
    )
      return;
    // Unknown work is never replaced by a new authentication continuation.
    if (readOrganizationDeleteUnknown(selected).kind !== 'absent') {
      setConfirmation('');
      setOutcome('unknown');
      return;
    }
    const key = current.operationKey ?? operationKeyFor({ kind: 'delete', accountId: selected }, humanAccountId);
    current.operationKey = key;
    const continuation = readOrganizationDeleteStepUp();
    if (
      continuation.kind === 'invalid' ||
      (continuation.kind === 'pending' &&
        !organizationDeletePendingMatches(continuation.value, humanAccountId, selected, key))
    ) {
      invalidateReview(current);
      setLoaded({ kind: 'changed' });
      setConfirmation('');
      return;
    }
    if (!storeOrganizationDeleteStepUp({ humanAccountId, organizationId: selected, operationKey: key })) {
      setMessage(m.auth_account_operation_unavailable());
      return;
    }
    setConfirmation('');
    setLoaded(null);
    current.active = false;
    bypassDeparture.current = true;
    window.location.assign(organizationDeleteStepUpUrl);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const current = review.current;
    if (!current?.isCurrent() || !target || !privacyContact || submitting.current || outcome !== 'form') return;
    if (!organizationDeleteConfirmed(confirmation, phrase)) {
      setConfirmationError(true);
      return;
    }
    const operationToken = {};
    submitting.current = operationToken;
    setPending(true);
    setConfirmationError(false);
    setMessage('');
    try {
      const operation = { kind: 'delete' as const, accountId: target.organizationId };
      const key = current.operationKey ?? operationKeyFor(operation, target.humanAccountId);
      current.operationKey = key;
      const continuation = readOrganizationDeleteStepUp();
      if (
        continuation.kind === 'invalid' ||
        (continuation.kind === 'pending' &&
          !organizationDeletePendingMatches(continuation.value, target.humanAccountId, target.organizationId, key))
      ) {
        invalidateReview(current);
        setLoaded({ kind: 'changed' });
        setConfirmation('');
        setMessage(m.auth_organization_delete_changed());
        return;
      }
      attempt.current = organizationDeletionAttempt({
        organizationId: target.organizationId,
        humanAccountId: target.humanAccountId,
        operationKey: key,
      });
      const result = await executeOrganizationDeletion(target, key, read, current);
      // Navigation cannot apply an earlier target's result to the new selection.
      if (!current.isCurrent()) return;
      if (result.ok) {
        forgetOperationKey(operation, target.humanAccountId);
        clearReviewContinuation(current);
        if (attempt.current) attempt.current.unresolved = false;
        setOutcome('accepted');
        setConfirmation('');
        return;
      }
      if (result.reason === 'step-up') {
        authenticate(target.humanAccountId, target.organizationId);
        return;
      }
      setConfirmation('');
      if (result.reason === 'unknown') {
        // No new approval or execution after ambiguity; only current readback
        // follows while the original command identity remains stored.
        clearReviewContinuation(current);
        const retained = readOrganizationDeleteUnknown(target.organizationId);
        if (retained.kind === 'pending') attempt.current = organizationDeletionAttempt(retained.value, true);
        else if (attempt.current) attempt.current.unresolved = true;
        setOutcome('unknown');
        setMessage('');
      } else if (result.reason === 'changed') {
        invalidateReview(current);
        clearReviewContinuation(current);
        setLoaded({ kind: 'unavailable' });
        setMessage(m.auth_organization_delete_changed());
      } else if (result.reason === 'denied') {
        invalidateReview(current);
        setLoaded({ kind: 'denied' });
        setMessage(m.auth_organization_delete_denied());
      } else if (result.reason === 'platform-closed') setMessage(m.auth_organization_not_open());
      else if (result.reason === 'unavailable') setMessage(m.auth_account_operation_unavailable());
      else setMessage(m.auth_account_operation_failure());
    } finally {
      if (current.isCurrent() && submitting.current === operationToken) {
        submitting.current = null;
        setPending(false);
      }
    }
  }

  async function readback(currentOrganizationId: string) {
    const previous = review.current;
    if (
      !previous ||
      previous.selected !== currentOrganizationId ||
      previous.source !== organizationId ||
      previous.reader !== read ||
      !attempt.current?.mounted ||
      !attempt.current.unresolved ||
      submitting.current
    )
      return;
    const current = previous.isCurrent()
      ? previous
      : {
          ...previous,
          active: true,
          isCurrent: (): boolean => review.current === current && current.active,
        };
    review.current = current;
    const operationToken = {};
    submitting.current = operationToken;
    setPending(true);
    try {
      const result = await loadOrganizationDeletion(currentOrganizationId, read, current);
      if (!current.isCurrent()) return;
      if (['signed-out', 'denied', 'hidden', 'missing', 'changed'].includes(result.kind)) invalidateReview(current);
      // A missing/denied read is not proof of deletion; a readable target is not
      // proof that an earlier command failed. Preserve the unknown command state.
      setLoaded(result);
      setMessage('');
    } finally {
      if (current.isCurrent() && submitting.current === operationToken) {
        submitting.current = null;
        setPending(false);
      }
    }
  }

  const [privacyBefore, privacyAfter] = privacyContact
    ? m.auth_account_delete_privacy_contact({ contact: privacyContact }).split(privacyContact)
    : [];
  const departure = router ? (
    <OrganizationDeleteDeparture
      shouldWarn={shouldWarn}
      leave={leaveReview}
      unknown={outcome === 'unknown'}
      focus={() => {
        if (bypassDeparture.current) return;
        if (attempt.current?.unresolved) recoveryHeading.current?.focus();
        else if (review.current?.isCurrent()) input.current?.focus();
      }}
    />
  ) : null;

  return (
    <AuthPage heading={m.auth_organization_delete_heading()} returnToSecurity={outcome !== 'accepted'}>
      {departure}
      <div className="auth-login-form">
        <p>{m.auth_organization_delete_effect()}</p>
        <p>{m.auth_organization_delete_remedies()}</p>
        <p>{m.auth_account_delete_retention_limits()}</p>
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
          <OrganizationDeletionRecovery
            advice={loaded}
            pending={pending || loaded === null}
            headingRef={recoveryHeading}
            readback={selectedId.current ? () => void readback(selectedId.current!) : undefined}
          />
        ) : !loaded ? (
          <p role="status">{m.auth_inventory_loading()}</p>
        ) : loaded.kind === 'signed-out' ? (
          <>
            <p>{m.auth_account_operation_sign_in_required()}</p>
            <a href="/login">{m.auth_security_sign_in()}</a>
          </>
        ) : loaded.kind === 'authentication-required' ? (
          <>
            <p>{m.auth_transfer_acting_as({ account: loaded.humanAccountId })}</p>
            <p className="break-all">{selectedId.current}</p>
            <p>{m.auth_organization_delete_authentication_required()}</p>
            <Button type="button" onClick={() => authenticate(loaded.humanAccountId, selectedId.current!)}>
              {m.auth_organization_delete_authenticate()}
            </Button>
          </>
        ) : !target ? (
          <>
            <ErrorAlert>
              {loaded.kind === 'changed'
                ? m.auth_organization_delete_changed()
                : loaded.kind === 'denied' || loaded.kind === 'hidden' || loaded.kind === 'missing'
                  ? m.auth_organization_delete_read_denied()
                  : m.auth_account_operation_unavailable()}
            </ErrorAlert>
            {loaded.kind === 'unavailable' ? (
              <Button type="button" onClick={() => void recover()}>
                {m.auth_account_delete_retry()}
              </Button>
            ) : null}
          </>
        ) : (
          <form
            method="post"
            action="/account-operations/approve"
            onSubmit={submit}
            noValidate
            className="auth-login-form"
          >
            <p className="break-all">{m.auth_transfer_acting_as({ account: target.humanAccountId })}</p>
            <p>{m.auth_organization_delete_advice()}</p>
            <p className="break-words">
              {target.displayName || (target.handle ? `@${target.handle}` : target.organizationId)}
            </p>
            <p className="break-all">{target.organizationId}</p>
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
