import { useSyncExternalStore } from 'react';
import { HostedBookReaderLink } from '../books/reader/link';
import { m } from '../paraglide/messages.js';
import { getLocale, type Locale } from '../paraglide/runtime.js';
import type { HostedReleaseReaderBinding } from './hosted-release-reader-link';

/** The destination always performs ordinary reader admission; this action conveys only exact coordinates. */
export function HostedReleaseReaderLink({
  binding,
  locale = getLocale(),
}: {
  binding: HostedReleaseReaderBinding;
  locale?: Locale;
}) {
  const address = useSyncExternalStore(binding.subscribe, binding.snapshot, binding.snapshot);
  if (!address) return null;
  return (
    <div className="studio-action-row">
      <HostedBookReaderLink {...address} locale={locale} target="_blank">
        {m.studio_hosted_view_published_book({}, { locale })}
        <span className="sr-only"> — {m.books_catalogue_new_tab({}, { locale })}</span>
      </HostedBookReaderLink>
    </div>
  );
}
