'use client';

import { createContext, use, useId, useState, useTransition, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@rezics/ui/button';
import { useOptionalShell } from '../shell/shell-provider.tsx';
import { messages } from '../work-page/messages.ts';
import { copyOf } from './messages.ts';
import type { NameSummary } from './types.ts';

const SectionRecovery = createContext(false);

/** A section that already owns a name retry keeps its existing control. */
export function SectionNamesRecovery({ children }: { children: ReactNode }) {
  return <SectionRecovery value>{children}</SectionRecovery>;
}

/** Only name content crosses this client boundary; destination callbacks stay on the server. */
export function NameRecovery({ status, children }: { status: NameSummary['status']; children: ReactNode }) {
  const sectionRecovery = use(SectionRecovery);
  const locale = useOptionalShell()?.locale ?? 'en';
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [retried, setRetried] = useState(false);
  const statusId = useId();
  const t = copyOf(locale), recovery = messages[locale];
  const unavailable = status === 'unavailable-read';
  if (sectionRecovery || (!unavailable && !retried)) return children;
  return <span className="inline-flex max-w-full flex-wrap items-baseline gap-x-2 gap-y-1" aria-busy={pending}>
    {children}
    <Button size="sm" variant="outline" aria-disabled={pending} aria-describedby={statusId} onClick={() => {
      if (pending) return;
      setRetried(true);
      startTransition(() => router.refresh());
    }}>{pending ? recovery.retrying : recovery.retry}</Button>
    <span id={statusId} role="status" className="sr-only">
      {pending ? recovery.retrying : unavailable ? t.namesUnavailable : status === 'unavailable' ? t.nameNotShown : t.namesRestored}
    </span>
  </span>;
}
