'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { useState } from 'react';
import { useAccountClient } from '../api/account-client.tsx';
import { useTranslation } from '../../i18n/client.ts';
import { failureText } from '../account/failure-text.ts';
import type { FailureKind } from '../api/errors.ts';
import { AuthOutcome } from './auth-outcome.tsx';

/** The page behind an unsubscribe email's link: nothing changes until the person confirms, then it says what did. */
export function Unsubscribe({ token, valid }: { token: string; valid: boolean }) {
  const { t } = useTranslation('auth');
  const common = useTranslation('common').t;
  const { api } = useAccountClient();
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'failed' | 'invalid'>(valid ? 'idle' : 'invalid');

  const [failure, setFailure] = useState<FailureKind>();

  async function confirm() {
    setState('busy');
    const result = await api.unsubscribe(token);
    if (!result.ok) setFailure(result.kind);
    setState(result.ok ? 'done' : result.kind === 'invalid-token' ? 'invalid' : 'failed');
  }

  if (state === 'done') return <AuthOutcome icon="done" title={t.unsubscribedTitle} body={t.unsubscribedBody} />;
  if (state === 'invalid') {
    return <AuthOutcome icon="problem" title={t.unsubscribeInvalidTitle} body={t.unsubscribeInvalidBody} />;
  }
  return <AuthOutcome title={t.unsubscribeTitle} body={t.unsubscribeBody} action={<div className="flex flex-col items-end gap-3">
    {state === 'failed' ? <Alert role="alert" variant="destructive"><AlertDescription>{failure && failure !== 'unavailable' ? failureText(failure, common) : t.unsubscribeFailed}</AlertDescription></Alert> : null}
    <Button size="lg" isLoading={state === 'busy'} onClick={() => void confirm()}>
      {state === 'busy' ? t.unsubscribing : t.unsubscribeButton}</Button>
  </div>} />;
}
