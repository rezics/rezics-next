import { useEffect, useState } from 'react';
import type { Locale } from '../paraglide/runtime.js';
import type { HistoricalReaderSource } from '../threads/historical-reader-provenance';
import type { HostedOwnedBook } from './hosted-contract';
import { HostedReleasePreparationVisit } from './hosted-release-preparation';
import { hostedOutlineWindowNative } from './hosted-actions';
import { hostedReleaseTransport } from './hosted-release-preparation-actions';
import { releaseCopy } from './hosted-release-preparation-copy';
import { HostedReleasePreparationView } from './hosted-release-preparation-view';

type Props = {
  owner: HostedOwnedBook;
  source: HistoricalReaderSource | null;
  accountId: string | null | undefined;
  csrfToken: string | null;
  locale: Locale;
  stageId: string | null;
};

/** Synchronously hide a replaced identity before effect cleanup can abort and discard its late replies. */
export function HostedReleasePreparationEntry(props: Props) {
  const { owner, source, accountId, csrfToken, locale, stageId } = props;
  const [mounted, setMounted] = useState<{ props: Props; visit: HostedReleasePreparationVisit } | null>(null);
  useEffect(() => {
    if (!source || !accountId || !csrfToken || owner.viewer.accountId !== accountId) return;
    const visit = new HostedReleasePreparationVisit({
      owner,
      source,
      csrfToken,
      locale,
      native: hostedReleaseTransport,
      selectionNative: hostedOutlineWindowNative,
      stageId,
      locate: (next) => {
        const url = new URL(window.location.href);
        if (next) url.searchParams.set('stageId', next);
        else url.searchParams.delete('stageId');
        // Only an opaque locator goes into the existing private Studio URL, never command bodies or credentials.
        window.history.replaceState(window.history.state, '', url);
      },
    });
    setMounted({ props, visit });
    if (stageId) void visit.readProgress();
    return visit.dispose;
  }, [owner, source, accountId, csrfToken, locale, stageId]);
  if (
    mounted &&
    mounted.props.owner === owner &&
    mounted.props.source === source &&
    mounted.props.accountId === accountId &&
    mounted.props.csrfToken === csrfToken &&
    mounted.props.locale === locale &&
    mounted.props.stageId === stageId
  )
    return <HostedReleasePreparationView visit={mounted.visit} locale={locale} />;
  return <p role="status">{releaseCopy[locale].review}</p>;
}
