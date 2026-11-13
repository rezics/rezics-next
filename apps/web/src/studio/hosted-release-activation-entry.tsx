import { useEffect, useState } from 'react';
import type { Locale } from '../paraglide/runtime.js';
import type { HistoricalReaderSource } from '../threads/historical-reader-provenance';
import type { HostedOwnedBook } from './hosted-contract';
import type { ReleaseProgress } from './hosted-release-preparation-contract';
import type { HostedReleaseActivationTransport } from './hosted-release-activation-contract';
import { HostedReleaseActivationVisit, preparedActivationReview } from './hosted-release-activation';
import { HostedReleaseActivationView } from './hosted-release-activation-view';
import { activationCopy } from './hosted-release-activation-copy';

export type HostedReleaseActivationBinding = {
  source: HistoricalReaderSource;
  csrfToken: string;
  native: HostedReleaseActivationTransport;
};
type Props = HostedReleaseActivationBinding & {
  owner: HostedOwnedBook;
  prepared: ReleaseProgress;
  locale: Locale;
};

/** Every private operand replacement hides the old visit synchronously, before effect cleanup fences late replies. */
export function HostedReleaseActivationEntry(props: Props) {
  const { owner, prepared, locale, source, csrfToken, native } = props;
  const [mounted, setMounted] = useState<{ props: Props; visit: HostedReleaseActivationVisit } | null>(null);
  useEffect(() => {
    const review = preparedActivationReview(owner, prepared);
    if (!review) return;
    const visit = new HostedReleaseActivationVisit({ owner, review, locale, source, csrfToken, native });
    setMounted({ props, visit });
    return visit.dispose;
  }, [owner, prepared, locale, source, csrfToken, native]);
  if (
    mounted &&
    mounted.props.owner === owner &&
    mounted.props.prepared === prepared &&
    mounted.props.locale === locale &&
    mounted.props.source === source &&
    mounted.props.csrfToken === csrfToken &&
    mounted.props.native === native
  )
    return <HostedReleaseActivationView visit={mounted.visit} locale={locale} />;
  return <p role="status">{activationCopy[locale].review}</p>;
}
