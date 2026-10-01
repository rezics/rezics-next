'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { useState } from 'react';
import { useAccountClient } from '../api/account-client.tsx';
import { useTranslation } from '../../i18n/client.ts';
import { AuthOutcome } from './auth-outcome.tsx';

/** The page behind an unsubscribe email's link: nothing changes until the person confirms, then it says what did. */
export function Unsubscribe({ token, valid }: { token: string; valid: boolean }) {
  const { t } = useTranslation('auth');
  const { api } = useAccountClient();
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'failed' | 'invalid'>(valid ? 'idle' : 'invalid');

  async function confirm() {
    setState('busy');
    const result = await api.unsubscribe(token);
    setState(result.ok ? 'done' : result.kind === 'invalid-token' ? 'invalid' : 'failed');
  }

  if (state === 'done') return <AuthOutcome icon="done" title={t.unsubscribedTitle} body={t.unsubscribedBody} />;
  if (state === 'invalid') {
    return <AuthOutcome icon="problem" title={t.unsubscribeInvalidTitle} body={t.unsubscribeInvalidBody} />;
  }
  return <AuthOutcome title={t.unsubscribeTitle} body={t.unsubscribeBody} action={<div className="flex flex-col items-end gap-3">
    {state === 'failed' ? <Alert role="alert" variant="destructive"><AlertDescription>{t.unsubscribeFailed}</AlertDescription></Alert> : null}
    <Button size="lg" isLoading={state === 'busy'} onClick={() => void confirm()}>
      {state === 'busy' ? t.unsubscribing : t.unsubscribeButton}</Button>
  </div>} />;
}
