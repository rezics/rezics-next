'use client';

import { Button } from '@rezics/ui/button';
import { AuthOutcome } from '../auth/auth-outcome.tsx';
import { useTranslation } from '../../i18n/client.ts';

/** Consent pages that cannot show a request: a broken or expired link, a
 * visitor whose session ended, or an unreachable Account service. */
export function ConsentProblem({ kind, signIn }: { kind: 'invalid' | 'signed-out' | 'unavailable';
  signIn?: string }) {
  const { t } = useTranslation('consent');
  const common = useTranslation('common').t;
  if (kind === 'signed-out') {
    return <AuthOutcome icon="problem" title={common.signedOutTitle} body={t.signedOutBody}
      action={<Button asChild size="lg"><a href={signIn ?? '/sign-in'}>{common.signIn}</a></Button>} />;
  }
  return kind === 'invalid'
    ? <AuthOutcome icon="problem" title={t.invalidTitle} body={t.invalidBody} />
    : <AuthOutcome icon="problem" title={common.unavailableTitle} body={common.unavailableBody}
      action={<Button variant="outline" size="lg" onClick={() => window.location.reload()}>{common.retry}</Button>} />;
}
