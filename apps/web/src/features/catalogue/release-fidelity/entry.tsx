import { buttonVariants } from '@rezics/ui/shadcn/button';
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
    <a className={buttonVariants({ variant: 'outline', size: 'sm' })} href={entry.href}>
      {entry.label}
    </a>
  );
}
