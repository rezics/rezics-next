'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { type FormEvent, useActionState, useState } from 'react';
import { useAccountClient } from '../api/account-client.tsx';
import { useTranslation } from '../../i18n/client.ts';
import { AuthHeading } from '../shell/auth-frame.tsx';
import { AuthOutcome } from './auth-outcome.tsx';
import { failureText } from '../account/failure-text.ts';
import type { FailureKind } from '../api/errors.ts';
import { PolicyLinks } from './policy-links.tsx';
import { acceptances, type PolicyVersion } from './policies.ts';
import { unchangedForm, type AuthFormAction } from './form-state.ts';
import { useFormResponse } from './form-response.ts';

/** Asks a signed-in person to accept policies that changed since they last did, then resumes `next`. */
export function AcceptPolicies({
  policies,
  aboutOrigin,
  next,
  signIn = '/sign-in?policy_declined=1',
  action,
}: {
  policies: PolicyVersion[];
  aboutOrigin: string;
  next: string;
  signIn?: string;
  action?: AuthFormAction;
}) {
  const { t } = useTranslation('auth');
  const common = useTranslation('common').t;
  const { api, navigate } = useAccountClient();
  const [busy, setBusy] = useState<'accept' | 'decline'>();
  const [native, submitNative] = useActionState(action ?? unchangedForm, {});
  const [failed, setFailed] = useState<FailureKind | undefined>(
    native.failure === 'challenge-unavailable' ? undefined : native.failure,
  );
  useFormResponse(native, (state) =>
    setFailed(state.failure === 'challenge-unavailable' ? undefined : state.failure),
  );

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const button = (event.nativeEvent as SubmitEvent).submitter;
    if (button instanceof HTMLButtonElement && button.value === 'decline') void decline();
    else void accept();
  }

  async function accept() {
    setBusy('accept');
    setFailed(undefined);
    const result = await api.acceptPolicies(acceptances(policies));
    if (result.ok) return navigate(next);
    setBusy(undefined);
    setFailed(result.kind);
  }

  async function decline() {
    setBusy('decline');
    setFailed(undefined);
    const result = await api.signOut();
    if (result.ok || result.kind === 'unauthenticated') return navigate(signIn);
    setBusy(undefined);
    setFailed(result.kind);
  }

  return (
    <>
      <AuthHeading title={t.acceptTitle} subtitle={t.acceptBody} />
      {failed ? (
        <Alert role="alert" variant="destructive" className="mb-6">
          <AlertDescription>{failureText(failed, common)}</AlertDescription>
        </Alert>
      ) : null}
      <p className="mb-6 text-base">
        <PolicyLinks policies={policies} aboutOrigin={aboutOrigin} />
      </p>
      <form
        action={action ? submitNative : undefined}
        onSubmit={submit}
        className="flex flex-col gap-3"
      >
        <Button
          type="submit"
          name="operation"
          value="accept"
          size="lg"
          disabled={!!busy}
          isLoading={busy === 'accept'}
        >
          {busy === 'accept' ? t.accepting : t.acceptButton}
        </Button>
        <Button
          type="submit"
          name="operation"
          value="decline"
          variant="outline"
          size="lg"
          disabled={!!busy}
          isLoading={busy === 'decline'}
        >
          {common.declinePolicies}
        </Button>
      </form>
    </>
  );
}

/** The current versions could not be read, so nothing is shown that could be accepted. */
export function PoliciesUnavailable({ retryHref = '/accept-policies' }: { retryHref?: string }) {
  const { t } = useTranslation('auth');
  const common = useTranslation('common').t;
  const { refresh } = useAccountClient();
  return (
    <AuthOutcome
      icon="problem"
      title={t.acceptTitle}
      body={common.policyReviewUnavailable}
      action={
        <Button asChild variant="outline">
          <a
            href={retryHref}
            onClick={(event) => {
              event.preventDefault();
              refresh();
            }}
          >
            {common.retry}
          </a>
        </Button>
      }
    />
  );
}
