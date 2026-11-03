import { buttonVariants } from '@rezics/ui/shadcn/button';
import { catalogueEntries } from '../catalogue-entry';

export function ProducerHistoryEntry(address: { id: string; label?: string; locale: string }) {
  const entry = catalogueEntries.producerHistory(address);
  if (!entry) return null;
  return (
    <a className={buttonVariants({ variant: 'outline', size: 'sm' })} href={entry.href}>
      {entry.label}
    </a>
  );
}
