import { buttonVariants } from '@rezics/ui/shadcn/button';
import { cn } from '@rezics/ui/utils';
import { catalogueEntries } from '../catalogue-entry';
import type { Release } from '@rezics/definitions';

export function ReleaseFidelityEntry({
  id,
  type,
  label,
  locale,
  context,
  returnHref,
  release,
}: {
  id: string;
  type: string;
  label: string;
  locale: string;
  context?: string | undefined;
  returnHref?: string | undefined;
  release?: Pick<Release, 'types' | 'properties'> | undefined;
}) {
  const entry = catalogueEntries.releaseFidelity({
    id,
    type,
    label,
    locale,
    ...(context !== undefined ? { context } : {}),
    ...(returnHref !== undefined ? { returnHref } : {}),
    ...(release !== undefined ? { release } : {}),
  });
  if (!entry) return null;
  return (
    <a
      className={cn(
        buttonVariants({ variant: 'outline', size: 'sm' }),
        'h-auto min-h-6 max-w-full justify-start whitespace-normal text-start [overflow-wrap:anywhere]',
      )}
      href={entry.href}
    >
      {entry.label}
    </a>
  );
}
