'use client';

import { Button } from '@rezics/ui/button';
import { RotateCwIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';

/** Reads the page's Server Components again; regions that recovered replace their failure. */
export function RetryButton({ label, pendingLabel }: { label: string; pendingLabel: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return <Button size="sm" variant="outline" disabled={pending} onClick={() => startTransition(() => router.refresh())}>
    <RotateCwIcon aria-hidden="true" className={pending ? 'motion-safe:animate-spin' : undefined} />
    {pending ? pendingLabel : label}
  </Button>;
}
