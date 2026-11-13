import { useEffect, useState } from 'react';
import type { Locale } from '../paraglide/runtime.js';
import type { HistoricalReaderSource } from '../threads/historical-reader-provenance';
import type { HostedOwnedBook } from './hosted-contract';
import { HostedLegacyBaselineVisit } from './hosted-legacy-baseline';
import { hostedBaselineTransport } from './hosted-legacy-baseline-actions';
import { baselineCopy } from './hosted-legacy-baseline-copy';
import { HostedLegacyBaselineView } from './hosted-legacy-baseline-view';

type Props = {
  owner: HostedOwnedBook;
  source: HistoricalReaderSource | null;
  accountId: string | null | undefined;
  csrfToken: string | null;
  locale: Locale;
};

/** Replacement hides the old visit synchronously, then cleans up its request and source subscription. */
export function HostedLegacyBaselineEntry(props: Props) {
  const { owner, source, accountId, csrfToken, locale } = props;
  const [mounted, setMounted] = useState<{ props: Props; visit: HostedLegacyBaselineVisit } | null>(null);
  useEffect(() => {
    if (!source || !accountId || !csrfToken || owner.viewer.accountId !== accountId) return;
    const visit = new HostedLegacyBaselineVisit({ owner, source, csrfToken, locale, native: hostedBaselineTransport });
    setMounted({ props, visit });
    return visit.dispose;
  }, [owner, source, accountId, csrfToken, locale]);
  if (
    mounted &&
    mounted.props.owner === owner &&
    mounted.props.source === source &&
    mounted.props.accountId === accountId &&
    mounted.props.csrfToken === csrfToken &&
    mounted.props.locale === locale
  )
    return <HostedLegacyBaselineView visit={mounted.visit} locale={locale} />;
  return <p role="status">{baselineCopy[locale].review}</p>;
}
