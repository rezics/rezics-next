'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, AlertDescription, AlertTitle } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import type { UiLocale } from '../../i18n/define.ts';
import { messages } from '../work-page/messages.ts';
import { copyOf } from './messages.ts';

/** Keep the retry control mounted when the next RSC snapshot restores the names. */
export function ReleaseNamesRecovery({ unavailable, locale }: { unavailable: boolean; locale: UiLocale }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [retried, setRetried] = useState(false);
  const t = copyOf(locale), recovery = messages[locale];
  if (!unavailable && !retried) return null;
  return <div className="grid justify-items-start gap-3" aria-busy={pending}>
    {unavailable ? <Alert variant="destructive" role="alert">
      <AlertTitle>{t.namesUnavailable}</AlertTitle>
      <AlertDescription>{recovery.regionUnavailable}</AlertDescription>
    </Alert> : null}
    <Button size="sm" variant="outline" disabled={pending} onClick={() => {
      setRetried(true);
      startTransition(() => router.refresh());
    }}>{pending ? recovery.retrying : recovery.retry}</Button>
    <span role="status" className="sr-only">{pending ? recovery.retrying : retried && !unavailable ? t.namesRestored : ''}</span>
  </div>;
}
