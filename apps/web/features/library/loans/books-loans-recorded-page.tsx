import type { UiLocale } from '../../../i18n/define.ts';
import type { LibraryMessages } from '../messages.ts';
import { LoansView } from './loans-view.tsx';
import type { LoansPageRead } from './books-loans-recorded-page.ts';

/** The loans region the library route and the recorded stories both render. */
export function LoansRecordedRegion({ read, cursor, locale, messages }: {
  read: LoansPageRead; cursor: string | null; locale: UiLocale; messages: LibraryMessages;
}) {
  return <LoansView items={read.ok ? read.data.items : []} nextCursor={read.ok ? read.data.nextCursor : null}
    failure={read.ok ? null : 'unavailable'} problem={read.ok ? null : read.problemTitle ?? null}
    cursor={cursor} locale={locale} messages={messages} />;
}
