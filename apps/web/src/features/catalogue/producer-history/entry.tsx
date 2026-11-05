import { buttonVariants } from '@rezics/ui/shadcn/button';
import { subjectHref } from '../../../subject/subject-href';
import { m } from '../../../paraglide/messages.js';
import { catalogueEntries } from '../catalogue-entry';
import { producerHistoryEntryVisit } from './visit';

export function ProducerHistoryEntry(address: {
  id: string;
  label?: string;
  locale: string;
  context: string;
  realm?: string | undefined;
  currentHref?: string | undefined;
}) {
  const entry = catalogueEntries.producerHistory(address);
  const visit = producerHistoryEntryVisit({
    href: entry.href,
    currentHref: address.currentHref,
    fallbackHref: subjectHref({ id: address.id, label: '' }, address.locale).href,
    id: address.id,
    locale: address.locale,
    context: address.context,
    realm: address.realm,
  });
  if (!visit) return null;
  return (
    <>
      <a className={buttonVariants({ variant: 'outline', size: 'sm' })} href={visit.href}>
        {entry.label}
      </a>
      {visit.restarted && <p role="status">{m.producer_history_return_overview()}</p>}
    </>
  );
}
